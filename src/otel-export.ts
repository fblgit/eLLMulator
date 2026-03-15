/**
 * OTEL Export — TraceEntry/TraceResult to OTEL ReadableSpan conversion and export.
 *
 * Pure conversion layer: transforms eLLMulator TraceEntry/TraceResult data into
 * OTEL-compliant ReadableSpan objects with parent-child hierarchy, attributes,
 * status mapping, and span events.
 *
 * Factory layer: wires the OTEL SDK pipeline (OTLPTraceExporter, SimpleSpanProcessor,
 * BasicTracerProvider) with Resource identity and error isolation.
 *
 * FR-OTEL-001: TraceEntry to ReadableSpan conversion
 * FR-OTEL-002: Parent-child span hierarchy derivation
 * FR-OTEL-003: Exporter factory (OTLPTraceExporter + SimpleSpanProcessor + BasicTracerProvider)
 * FR-OTEL-005: Span attribute mapping with conditional fields
 * FR-OTEL-006: Span status mapping (error to ERROR, else UNSET)
 * FR-OTEL-007: Span events (params, result, mutations, findings)
 * FR-OTEL-008: Resource configuration with semantic conventions
 * FR-OTEL-010: Error isolation at factory init
 */

import {
  SpanKind,
  SpanStatusCode,
  TraceFlags,
} from '@opentelemetry/api';
import type {
  HrTime,
  SpanContext,
  SpanStatus,
  Attributes,
} from '@opentelemetry/api';
import type { ReadableSpan, TimedEvent } from '@opentelemetry/sdk-trace-base';
import { BasicTracerProvider, SimpleSpanProcessor } from '@opentelemetry/sdk-trace-base';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { Resource } from '@opentelemetry/resources';
import type { IResource } from '@opentelemetry/resources';
import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import type { TraceEntry, TraceResult, Finding } from './types.js';

// ---------------------------------------------------------------------------
// OtelExportConfig type — shared by convertToSpans and createOtelExporter
// ---------------------------------------------------------------------------

export type OtelExportConfig = {
  endpoint: string;
  protocol: 'http/protobuf' | 'http/json';
  serviceName: string;
  serviceVersion: string;
  headers?: Record<string, string>;
  compression?: 'gzip' | 'none';
};

// ---------------------------------------------------------------------------
// OtelExporter interface — export/shutdown contract for OTEL pipeline
// ---------------------------------------------------------------------------

export interface OtelExporter {
  export(entries: TraceEntry[], traceResult: TraceResult): Promise<void>;
  shutdown(): Promise<void>;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert a Date to OTEL HrTime [seconds, nanoseconds].
 */
function dateToHrTime(date: Date): HrTime {
  const ms = date.getTime();
  const seconds = Math.trunc(ms / 1000);
  const nanoseconds = (ms % 1000) * 1_000_000;
  return [seconds, nanoseconds] as HrTime;
}

/**
 * Strip hyphens from a UUID string.
 */
function stripHyphens(uuid: string): string {
  return uuid.replace(/-/g, '');
}

/**
 * Derive a 32-char hex traceId from a UUID trace_id.
 * Strip hyphens, then padStart to 32 chars with '0'.
 */
function toTraceId(traceId: string): string {
  return stripHyphens(traceId).padStart(32, '0');
}

/**
 * Derive a 16-char hex spanId from a UUID task_id.
 * Strip hyphens, then take first 16 hex chars.
 */
function toSpanId(taskId: string): string {
  return stripHyphens(taskId).slice(0, 16);
}

/**
 * Add milliseconds to an HrTime, returning a new HrTime.
 */
function addMsToHrTime(hrTime: HrTime, ms: number): HrTime {
  const totalMs = hrTime[0] * 1000 + hrTime[1] / 1_000_000 + ms;
  const seconds = Math.trunc(totalMs / 1000);
  const nanoseconds = (totalMs % 1000) * 1_000_000;
  return [seconds, nanoseconds] as HrTime;
}

// ---------------------------------------------------------------------------
// FR-OTEL-006: deriveSpanStatus
// ---------------------------------------------------------------------------

/**
 * Map TraceEntry.error to OTEL SpanStatus.
 *
 * - error defined and non-empty string → SpanStatusCode.ERROR with message
 * - error undefined or empty string → SpanStatusCode.UNSET
 * - SpanStatusCode.OK is never used
 */
export function deriveSpanStatus(entry: TraceEntry): SpanStatus {
  if (entry.error !== undefined && entry.error !== '') {
    return {
      code: SpanStatusCode.ERROR,
      message: entry.error,
    };
  }
  return {
    code: SpanStatusCode.UNSET,
  };
}

// ---------------------------------------------------------------------------
// FR-OTEL-005: spanAttributes
// ---------------------------------------------------------------------------

/**
 * Build OTEL span attributes from a TraceEntry.
 *
 * Required (always present):
 *   - ellmulator.caller, ellmulator.target, ellmulator.depth
 *   - ellmulator.call_stack, ellmulator.stubbed (defaults to false)
 *
 * Conditional (only when defined on entry):
 *   - ellmulator.expected_output
 *   - ellmulator.duration_ms
 *   - code.source_refs
 */
export function spanAttributes(entry: TraceEntry): Attributes {
  const attrs: Attributes = {
    'ellmulator.caller': entry.caller,
    'ellmulator.target': entry.target,
    'ellmulator.depth': entry.depth,
    'ellmulator.call_stack': entry.call_stack,
    'ellmulator.stubbed': entry.stubbed ?? false,
  };

  if (entry.expected_output !== undefined) {
    attrs['ellmulator.expected_output'] = entry.expected_output;
  }

  if (entry.duration_ms !== undefined) {
    attrs['ellmulator.duration_ms'] = entry.duration_ms;
  }

  if (entry.source_refs !== undefined) {
    attrs['code.source_refs'] = entry.source_refs;
  }

  return attrs;
}

// ---------------------------------------------------------------------------
// FR-OTEL-002: deriveParentSpanIds
// ---------------------------------------------------------------------------

/**
 * Build a Map from spanId → parentSpanId (or undefined for roots).
 *
 * Root entries: depth === 0 OR caller === '__trace_initiator__' → undefined
 * Child entries: look up entry whose target === this.caller → that entry's spanId
 * Orphan callers (no matching target entry) → undefined
 */
export function deriveParentSpanIds(
  entries: TraceEntry[]
): Map<string, string | undefined> {
  // Build lookup: target → spanId (first entry with that target wins)
  const targetToSpanId = new Map<string, string>();
  for (const entry of entries) {
    const spanId = toSpanId(entry.task_id);
    if (!targetToSpanId.has(entry.target)) {
      targetToSpanId.set(entry.target, spanId);
    }
  }

  const parentMap = new Map<string, string | undefined>();

  for (const entry of entries) {
    const spanId = toSpanId(entry.task_id);

    if (entry.depth === 0 || entry.caller === '__trace_initiator__') {
      // Root entry — no parent
      parentMap.set(spanId, undefined);
    } else {
      // Child entry — resolve parent from caller matching a target
      const parentSpanId = targetToSpanId.get(entry.caller);
      parentMap.set(spanId, parentSpanId);
    }
  }

  return parentMap;
}

// ---------------------------------------------------------------------------
// FR-OTEL-007: generateSpanEvents
// ---------------------------------------------------------------------------

/**
 * Span event shape for OTEL event conversion.
 * Holds event name, HrTime timestamp, and optional OTEL attributes.
 * Internal to this module; cast to TimedEvent[] for ReadableSpan construction.
 */
type SpanEvent = {
  name: string;
  time?: HrTime;
  attributes?: Attributes;
};

/**
 * Generate span events from a TraceEntry and related findings.
 *
 * Events generated:
 * - invoke.params: when entry.params is defined
 * - invoke.result: when entry.result is defined
 * - mutation.{key}: one per mutation in entry.mutations
 * - finding.{type}: for findings where f.caller === entry.target OR f.target === entry.target
 *
 * All events use entry.timestamp for their time field.
 * Complex values are JSON.stringify serialized.
 */
export function generateSpanEvents(
  entry: TraceEntry,
  findings: Finding[]
): SpanEvent[] {
  const events: SpanEvent[] = [];
  const eventTime = dateToHrTime(entry.timestamp);

  // invoke.params event
  if (entry.params !== undefined) {
    events.push({
      name: 'invoke.params',
      time: eventTime,
      attributes: {
        'invoke.params': JSON.stringify(entry.params),
      },
    });
  }

  // invoke.result event
  if (entry.result !== undefined) {
    events.push({
      name: 'invoke.result',
      time: eventTime,
      attributes: {
        'invoke.result': JSON.stringify(entry.result),
      },
    });
  }

  // mutation.{key} events
  if (entry.mutations) {
    for (const mutation of entry.mutations) {
      events.push({
        name: `mutation.${mutation.key}`,
        time: eventTime,
        attributes: {
          'mutation.key': mutation.key,
          'mutation.before': JSON.stringify(mutation.before ?? null),
          'mutation.after': JSON.stringify(mutation.after),
        },
      });
    }
  }

  // finding.{type} events — match by caller OR target
  for (const finding of findings) {
    if (finding.caller === entry.target || finding.target === entry.target) {
      const findingAttrs: Attributes = {
        'finding.type': finding.type,
        'finding.description': finding.description,
        'finding.severity': finding.severity,
        'finding.caller': finding.caller,
        'finding.source_refs': finding.source_refs,
      };

      events.push({
        name: `finding.${finding.type}`,
        time: eventTime,
        attributes: findingAttrs,
      });
    }
  }

  return events;
}

// ---------------------------------------------------------------------------
// FR-OTEL-001: convertToSpans
// ---------------------------------------------------------------------------

/**
 * Convert TraceEntry[] to ReadableSpan[].
 *
 * Each TraceEntry becomes exactly one ReadableSpan with:
 * - traceId: stripped hyphens from trace_id, padStart(32, '0')
 * - spanId: stripped hyphens from task_id, slice(0, 16)
 * - name: `${target}.${function}`
 * - kind: SpanKind.INTERNAL
 * - startTime/endTime: HrTime from timestamp + duration_ms
 * - parentSpanId: from deriveParentSpanIds
 * - attributes: from spanAttributes
 * - status: from deriveSpanStatus
 * - events: from generateSpanEvents
 */
export function convertToSpans(
  entries: TraceEntry[],
  traceResult: TraceResult,
  config: OtelExportConfig
): ReadableSpan[] {
  const parentMap = deriveParentSpanIds(entries);
  const resource = new Resource({
    'service.name': config.serviceName,
    'service.version': config.serviceVersion,
  });

  return entries.map((entry) => {
    const traceId = toTraceId(entry.trace_id);
    const spanId = toSpanId(entry.task_id);
    const startTime = dateToHrTime(entry.timestamp);
    const endTime =
      entry.duration_ms !== undefined
        ? addMsToHrTime(startTime, entry.duration_ms)
        : startTime;

    const parentSpanId = parentMap.get(spanId);
    const attrs = spanAttributes(entry);
    const status = deriveSpanStatus(entry);
    const events = generateSpanEvents(entry, traceResult.findings);

    // Compute duration as HrTime
    const durationMs = entry.duration_ms ?? 0;
    const durationSec = Math.trunc(durationMs / 1000);
    const durationNano = (durationMs % 1000) * 1_000_000;
    const duration: HrTime = [durationSec, durationNano];

    const spanContext: SpanContext = {
      traceId,
      spanId,
      traceFlags: TraceFlags.SAMPLED,
    };

    const readableSpan: ReadableSpan = {
      name: `${entry.target}.${entry.function}`,
      kind: SpanKind.INTERNAL,
      spanContext: () => spanContext,
      parentSpanId,
      startTime,
      endTime,
      status,
      attributes: attrs,
      links: [],
      events: events as TimedEvent[],
      duration,
      ended: true,
      resource,
      instrumentationLibrary: {
        name: config.serviceName,
        version: config.serviceVersion,
      },
      droppedAttributesCount: 0,
      droppedEventsCount: 0,
      droppedLinksCount: 0,
    };

    return readableSpan;
  });
}

// ---------------------------------------------------------------------------
// FR-OTEL-008: createResource — Service identity via semantic conventions
// ---------------------------------------------------------------------------

/**
 * Create an OTEL Resource with service identity from config.
 *
 * Merges Resource.default() (which includes telemetry.sdk.* attributes)
 * with service-specific attributes using semantic convention constants.
 *
 * - config.serviceName defaults to "ellmulator" when undefined
 * - config.serviceVersion defaults to "0.1.0" when undefined
 * - Uses ATTR_SERVICE_NAME and ATTR_SERVICE_VERSION from @opentelemetry/semantic-conventions
 */
export function createResource(config: OtelExportConfig): IResource {
  const serviceName = config.serviceName ?? 'ellmulator';
  const serviceVersion = config.serviceVersion ?? '0.1.0';

  return Resource.default().merge(
    new Resource({
      [ATTR_SERVICE_NAME]: serviceName,
      [ATTR_SERVICE_VERSION]: serviceVersion,
    })
  );
}

// ---------------------------------------------------------------------------
// FR-OTEL-003 + FR-OTEL-010: createOtelExporter — OTLP exporter factory
// ---------------------------------------------------------------------------

/**
 * Create an OtelExporter wired with OTEL SDK pipeline.
 *
 * Pipeline: OTLPTraceExporter → SimpleSpanProcessor → BasicTracerProvider
 *
 * The entire factory body is wrapped in try/catch for error isolation
 * (FR-OTEL-010 Point 1). On any internal error, logs a warning and
 * returns undefined — never throws to the caller.
 *
 * - Uses SimpleSpanProcessor per design Decision C (not BatchSpanProcessor)
 * - Configures OTLPTraceExporter with endpoint URL, headers, and compression
 * - Creates BasicTracerProvider with Resource from createResource()
 * - export() converts entries to spans and forwards each via processor.onEnd()
 * - shutdown() delegates to provider.shutdown()
 */
export function createOtelExporter(config: OtelExportConfig): OtelExporter | undefined {
  try {
    const resource = createResource(config);

    const otlpExporter = new OTLPTraceExporter({
      url: config.endpoint,
      headers: config.headers ?? {},
      compression: config.compression as any,
    });

    const processor = new SimpleSpanProcessor(otlpExporter);

    const provider = new BasicTracerProvider({ resource });
    provider.addSpanProcessor(processor);

    return {
      async export(entries: TraceEntry[], traceResult: TraceResult): Promise<void> {
        const spans = convertToSpans(entries, traceResult, config);
        for (const span of spans) {
          processor.onEnd(span);
        }
      },

      async shutdown(): Promise<void> {
        await provider.shutdown();
      },
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`OTEL exporter initialization failed: ${message}`);
    return undefined;
  }
}
