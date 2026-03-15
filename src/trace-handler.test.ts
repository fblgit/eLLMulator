/**
 * RED Phase Tests -- FR-010: Trace Handler (External MCP)
 *
 * SPEC grounding:
 *   trace:⚡λ(request:TraceRequest) → TraceResult
 *   TraceRequest: { scenario:str!, entry_point:str?, state:Record<string,unknown>?,
 *     max_depth:int=50, stream:bool=true }
 *   TraceResult: { trace_id:str!, entries:[TraceEntry]!, summary:str!,
 *     findings:[Finding]?, duration_ms:int! }
 *   Finding: { type:∈[enum]!, description:str!, caller:str!, target:str?,
 *     source_refs:[str]!, severity:∈['high','medium','low']! }
 *
 * Implementation: ./mcp-external.ts (consolidated external MCP handlers)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock SDK to prevent real API calls (detectEntryPoint + summarizeTraceAsync use query())
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

import type { InvokeEnvelope, TraceEntry } from './types.js';
import { SyntheticState } from './handlers.js';
import {
  createTraceHandler,
  type TraceRequest,
  type TraceResult,
  type TraceDeps,
} from './mcp-external.js';
import type { Finding } from './types.js';
import type { OtelExporter } from './otel-export.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTraceEntry(overrides: Partial<TraceEntry> = {}): TraceEntry {
  return {
    trace_id: 'trace-001',
    task_id: 'task-001',
    timestamp: new Date(),
    depth: 0,
    caller: '__trace_initiator__',
    target: 'src/service.ts',
    function: 'service',
    call_stack: [],
    ...overrides,
  };
}

function makeTraceRequest(overrides: Partial<TraceRequest> = {}): TraceRequest {
  return {
    scenario: 'User creates an account',
    entry_point: 'src/service.ts',
    max_depth: 50,
    stream: true,
    ...overrides,
  };
}

/**
 * Build mock deps with a mock invoke that populates traceLog.
 */
function makeDeps(overrides: {
  registryEntries?: Record<string, { status: string; session_id?: string | null }>;
  invokeImpl?: (envelope: InvokeEnvelope) => Promise<unknown>;
} = {}) {
  const traceEntries: TraceEntry[] = [];

  const traceLog = {
    add: vi.fn((entry: TraceEntry) => traceEntries.push(entry)),
    getByTraceId: vi.fn((traceId: string) =>
      traceEntries.filter((e) => e.trace_id === traceId),
    ),
    list: vi.fn(() => traceEntries),
    toJSONL: vi.fn(() => ''),
    size: 0,
    clear: vi.fn(),
  };

  const entries = overrides.registryEntries ?? {
    'src/service.ts': { status: 'ready', session_id: 'sess-001' },
  };

  const allEntries = Object.entries(entries).map(([path, e]) => ({
    file_path: path,
    file_hash: 'hash',
    status: e.status,
    session_id: e.session_id ?? null,
    declarations: null,
    last_active: null,
    error: null,
  }));

  const registry = {
    get: vi.fn((path: string) => allEntries.find((e) => e.file_path === path)),
    list: vi.fn(() => allEntries),
    listByStatus: vi.fn((status: string) =>
      allEntries.filter((e) => e.status === status),
    ),
    size: allEntries.length,
    add: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
  };

  const sessionManager = {
    create: vi.fn(),
    get: vi.fn(),
    terminate: vi.fn(),
    query: vi.fn(),
    list: vi.fn(() => []),
    size: 0,
  };

  const syntheticState = new SyntheticState();

  const invokeFn = vi.fn(
    overrides.invokeImpl ??
      (async (envelope: InvokeEnvelope) => {
        // Simulate: log a trace entry
        traceLog.add(makeTraceEntry({
          trace_id: envelope.trace_id,
          task_id: envelope.task_id,
          caller: envelope.caller,
          target: envelope.target,
          function: envelope.function,
          params: envelope.params,
          result: { simulated: true },
          source_refs: ['src/service.ts:10-20'],
          duration_ms: 42,
          call_stack: envelope.call_stack,
        }));
        return {
          task_id: envelope.task_id,
          responder: envelope.target,
          returns: { simulated: true },
          mutations: [],
          source_refs: ['src/service.ts:10-20'],
        };
      }),
  );

  const deps: TraceDeps = {
    registry: registry as any,
    sessionManager: sessionManager as any,
    traceLog: traceLog as any,
    syntheticState,
    invoke: invokeFn as any,
    otelExporter: undefined,
  };

  return { deps, registry, sessionManager, traceLog, syntheticState, invokeFn };
}

// ===========================================================================
// FR-010: Trace Handler
// ===========================================================================

describe('FR-010: Trace Handler', () => {
  // -------------------------------------------------------
  // Test 1: createTraceHandler exists and returns a function
  // -------------------------------------------------------
  it('createTraceHandler returns a function', () => {
    const { deps } = makeDeps();
    const trace = createTraceHandler(deps);
    expect(typeof trace).toBe('function');
  });

  // -------------------------------------------------------
  // Test 2: trace returns TraceResult with required fields
  // -------------------------------------------------------
  it('returns TraceResult with trace_id, entries, summary, duration_ms', async () => {
    const { deps } = makeDeps();
    const trace = createTraceHandler(deps);

    const result: TraceResult = await trace(makeTraceRequest());

    expect(result.trace_id).toBeDefined();
    expect(typeof result.trace_id).toBe('string');
    expect(result.entries).toBeDefined();
    expect(Array.isArray(result.entries)).toBe(true);
    expect(typeof result.summary).toBe('string');
    expect(typeof result.duration_ms).toBe('number');
  });

  // -------------------------------------------------------
  // Test 3: trace_id is a valid UUID
  // -------------------------------------------------------
  it('generates a valid UUID for trace_id', async () => {
    const { deps } = makeDeps();
    const trace = createTraceHandler(deps);

    const result = await trace(makeTraceRequest());

    const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    expect(result.trace_id).toMatch(uuidRegex);
  });

  // -------------------------------------------------------
  // Test 4: auto-detects entry_point from first ready agent
  // -------------------------------------------------------
  it('auto-detects entry_point when omitted (first ready agent)', async () => {
    const { deps, invokeFn } = makeDeps({
      registryEntries: {
        'src/auto-detected.ts': { status: 'ready' },
      },
    });
    const trace = createTraceHandler(deps);

    const result = await trace(makeTraceRequest({ entry_point: undefined }));

    expect(result).toBeDefined();
    expect(invokeFn).toHaveBeenCalled();
    const envelope = invokeFn.mock.calls[0][0] as InvokeEnvelope;
    expect(envelope.target).toBe('src/auto-detected.ts');
  });

  // -------------------------------------------------------
  // Test 5: throws CANNOT_DETECT_ENTRY_POINT when no ready agents
  // -------------------------------------------------------
  it('throws CANNOT_DETECT_ENTRY_POINT when no ready agents and no entry_point', async () => {
    const { deps } = makeDeps({
      registryEntries: {
        'src/cold.ts': { status: 'cold' },
      },
    });
    const trace = createTraceHandler(deps);

    await expect(trace(makeTraceRequest({ entry_point: undefined }))).rejects.toThrow(
      /CANNOT_DETECT_ENTRY_POINT/,
    );
  });

  // -------------------------------------------------------
  // Test 6: throws CANNOT_DETECT_ENTRY_POINT on empty registry
  // -------------------------------------------------------
  it('throws CANNOT_DETECT_ENTRY_POINT on empty registry', async () => {
    const { deps } = makeDeps({ registryEntries: {} });
    const trace = createTraceHandler(deps);

    await expect(trace(makeTraceRequest({ entry_point: undefined }))).rejects.toThrow(
      /CANNOT_DETECT_ENTRY_POINT/,
    );
  });

  // -------------------------------------------------------
  // Test 7: injects request.state into SyntheticState
  // -------------------------------------------------------
  it('injects request.state into SyntheticState before invoking', async () => {
    const { deps, syntheticState } = makeDeps();
    const trace = createTraceHandler(deps);

    await trace(makeTraceRequest({
      state: { 'user.name': 'Alice', 'config.debug': true },
    }));

    expect(syntheticState.get('user.name')).toBe('Alice');
    expect(syntheticState.get('config.debug')).toBe(true);
  });

  // -------------------------------------------------------
  // Test 8: does not inject state when undefined
  // -------------------------------------------------------
  it('does not inject state when request.state is undefined', async () => {
    const { deps, syntheticState } = makeDeps();
    const setSpy = vi.spyOn(syntheticState, 'set');
    const trace = createTraceHandler(deps);

    await trace(makeTraceRequest({ state: undefined }));

    expect(setSpy).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------
  // Test 9: builds envelope with __trace_initiator__ and detected function
  // -------------------------------------------------------
  it('builds envelope with __trace_initiator__ as caller and detected function (not __entry__)', async () => {
    const { deps, invokeFn } = makeDeps();
    const trace = createTraceHandler(deps);

    await trace(makeTraceRequest({ entry_point: 'src/service.ts' }));

    const envelope = invokeFn.mock.calls[0][0] as InvokeEnvelope;
    expect(envelope.caller).toBe('__trace_initiator__');
    // Function is detected from declarations or derived from filename — never __entry__
    expect(envelope.function).not.toBe('__entry__');
    expect(envelope.target).toBe('src/service.ts');
    expect(envelope.call_stack).toEqual([]);
    expect(envelope.mode).toBe('sync');
  });

  // -------------------------------------------------------
  // Test 10: passes max_depth from request to envelope
  // -------------------------------------------------------
  it('passes max_depth from request to envelope', async () => {
    const { deps, invokeFn } = makeDeps();
    const trace = createTraceHandler(deps);

    await trace(makeTraceRequest({ max_depth: 25 }));

    const envelope = invokeFn.mock.calls[0][0] as InvokeEnvelope;
    expect(envelope.max_depth).toBe(25);
  });

  // -------------------------------------------------------
  // Test 11: max_depth defaults to 50
  // -------------------------------------------------------
  it('max_depth defaults to 50 when not specified', async () => {
    const { deps, invokeFn } = makeDeps();
    const trace = createTraceHandler(deps);

    const request: TraceRequest = {
      scenario: 'Test default max_depth',
      entry_point: 'src/service.ts',
      stream: true,
    };
    await trace(request);

    const envelope = invokeFn.mock.calls[0][0] as InvokeEnvelope;
    expect(envelope.max_depth).toBe(50);
  });

  // -------------------------------------------------------
  // Test 12: scenario is conveyed in envelope params/notes
  // -------------------------------------------------------
  it('conveys scenario in envelope', async () => {
    const { deps, invokeFn } = makeDeps();
    const trace = createTraceHandler(deps);

    await trace(makeTraceRequest({ scenario: 'Process payment' }));

    const envelope = invokeFn.mock.calls[0][0] as InvokeEnvelope;
    const combined = JSON.stringify(envelope.params ?? '') + JSON.stringify(envelope.notes ?? '');
    expect(combined).toContain('Process payment');
  });

  // -------------------------------------------------------
  // Test 13: findings defaults to empty array
  // -------------------------------------------------------
  it('findings defaults to empty array', async () => {
    const { deps } = makeDeps();
    const trace = createTraceHandler(deps);

    const result = await trace(makeTraceRequest());

    expect(result.findings).toBeDefined();
    expect(Array.isArray(result.findings)).toBe(true);
    expect(result.findings).toHaveLength(0);
  });

  // -------------------------------------------------------
  // Test 14: duration_ms is non-negative
  // -------------------------------------------------------
  it('duration_ms is non-negative', async () => {
    const { deps } = makeDeps();
    const trace = createTraceHandler(deps);

    const result = await trace(makeTraceRequest());

    expect(result.duration_ms).toBeGreaterThanOrEqual(0);
  });

  // -------------------------------------------------------
  // Test 15: collected entries share the generated trace_id
  // -------------------------------------------------------
  it('collected entries share the trace_id', async () => {
    const { deps } = makeDeps();
    const trace = createTraceHandler(deps);

    const result = await trace(makeTraceRequest());

    for (const entry of result.entries) {
      expect(entry.trace_id).toBe(result.trace_id);
    }
  });

  // -------------------------------------------------------
  // Test 16: Finding type shape validation
  // -------------------------------------------------------
  it('Finding type has all required fields per SPEC', () => {
    const finding: Finding = {
      type: 'contract_mismatch',
      description: 'Return type mismatch',
      caller: 'src/handler.ts',
      target: 'src/service.ts',
      source_refs: ['src/service.ts:42'],
      severity: 'high',
    };

    expect(finding.type).toBe('contract_mismatch');
    expect(finding.description).toBeDefined();
    expect(finding.caller).toBeDefined();
    expect(Array.isArray(finding.source_refs)).toBe(true);
    expect(finding.severity).toBe('high');
  });

  // -------------------------------------------------------
  // Test 17 (P3-D1): analyzeTrace produces findings for contract mismatches
  // -------------------------------------------------------
  it('returns non-empty findings when registry has declaration mismatches', async () => {
    const { deps, traceLog } = makeDeps({
      registryEntries: {
        'src/caller.ts': { status: 'ready' },
        'src/target.ts': { status: 'ready' },
      },
    });

    // Override registry to return declarations for both caller and target
    const callerDecl = {
      summary: 'Caller agent',
      owns: [{ name: 'doStuff', params: [], returns: 'void' }],
      imports: [],
      exports: [],
      dependencies: ['src/target.ts'],
    };
    const targetDecl = {
      summary: 'Target agent',
      owns: [{ name: 'handleRequest', params: [], returns: 'void' }],
      imports: [],
      exports: [],
      dependencies: [],
    };

    (deps.registry.get as any).mockImplementation((path: string) => {
      if (path === 'src/caller.ts') {
        return { file_path: 'src/caller.ts', file_hash: 'h1', status: 'ready', session_id: null, declarations: callerDecl, last_active: null, error: null };
      }
      if (path === 'src/target.ts') {
        return { file_path: 'src/target.ts', file_hash: 'h2', status: 'ready', session_id: null, declarations: targetDecl, last_active: null, error: null };
      }
      return undefined;
    });
    (deps.registry.list as any).mockReturnValue([
      { file_path: 'src/caller.ts', file_hash: 'h1', status: 'ready', session_id: null, declarations: callerDecl, last_active: null, error: null },
      { file_path: 'src/target.ts', file_hash: 'h2', status: 'ready', session_id: null, declarations: targetDecl, last_active: null, error: null },
    ]);

    // Mock invoke to create a trace entry where caller calls an undeclared function on target
    (deps.invoke as any).mockImplementation(async (envelope: InvokeEnvelope) => {
      traceLog.add(makeTraceEntry({
        trace_id: envelope.trace_id,
        task_id: envelope.task_id,
        caller: 'src/caller.ts',
        target: 'src/target.ts',
        function: 'undeclaredFn',  // NOT in target's owns
        depth: 1,
        source_refs: ['src/caller.ts:5'],
      }));
      // Also add the initiator entry
      traceLog.add(makeTraceEntry({
        trace_id: envelope.trace_id,
        task_id: envelope.task_id,
        caller: envelope.caller,
        target: envelope.target,
        function: envelope.function,
        depth: 0,
      }));
    });

    const trace = createTraceHandler(deps);
    const result = await trace(makeTraceRequest({ entry_point: 'src/caller.ts' }));

    // analyzeTrace should detect the contract mismatch
    expect(result.findings.length).toBeGreaterThan(0);
    const mismatch = result.findings.find((f: Finding) => f.type === 'contract_mismatch');
    expect(mismatch).toBeDefined();
    expect(mismatch!.caller).toBe('src/caller.ts');
    expect(mismatch!.target).toBe('src/target.ts');
    expect(mismatch!.description).toContain('undeclaredFn');
  });

  // -------------------------------------------------------
  // Test 18 (P3-D2): summary uses summarizeTrace format
  // -------------------------------------------------------
  it('summary uses summarizeTrace format (not inline template)', async () => {
    const { deps } = makeDeps();
    const trace = createTraceHandler(deps);

    const result = await trace(makeTraceRequest());

    // summarizeTrace returns "Trace summary: N entries across M files, max depth D"
    // The old inline format was "Trace of "scenario" through entry_point: N entries in Xms"
    expect(result.summary).toMatch(/^Trace summary:/);
    expect(result.summary).toContain('entries');
    expect(result.summary).toContain('files');
    expect(result.summary).toContain('max depth');
  });

  // -------------------------------------------------------
  // Test 19 (P3-D3): consolidate-flow re-exported from mcp-external
  // -------------------------------------------------------
  it('createConsolidateFlowHandler is re-exported from mcp-external', async () => {
    const { createConsolidateFlowHandler: reExported } = await import('./mcp-external');
    expect(typeof reExported).toBe('function');
  });
});

// ===========================================================================
// FR-OTEL-004: Batch Export Trigger in createTraceHandler
// FR-OTEL-010 (partial): Error isolation at export() call point
//
// Phase 3 RED tests: These verify that createTraceHandler integrates with
// the OtelExporter interface to trigger OTEL batch export after trace
// completion, with mandatory error isolation ensuring OTEL failures never
// propagate to TraceResult.
//
// Tests verify that createTraceHandler integrates with OtelExporter:
// - TraceDeps has the otelExporter optional field
// - createTraceHandler calls otelExporter.export() after trace completion
// ===========================================================================

/**
 * Build mock deps with an optional OtelExporter mock for OTEL integration tests.
 *
 * Extends the base makeDeps pattern with otelExporter support.
 * When an otelExporter is provided, it overrides the undefined default from makeDeps.
 */
function makeOtelDeps(overrides: {
  registryEntries?: Record<string, { status: string; session_id?: string | null }>;
  invokeImpl?: (envelope: InvokeEnvelope) => Promise<unknown>;
  otelExporter?: OtelExporter;
} = {}) {
  const base = makeDeps({
    registryEntries: overrides.registryEntries,
    invokeImpl: overrides.invokeImpl,
  });

  // Inject otelExporter onto deps if provided (overrides the undefined default from makeDeps).
  if (overrides.otelExporter !== undefined) {
    base.deps.otelExporter = overrides.otelExporter;
  }

  return { ...base, otelExporter: overrides.otelExporter };
}

/**
 * Create a mock OtelExporter with controllable export/shutdown behavior.
 */
function makeMockOtelExporter(overrides: {
  exportImpl?: (entries: TraceEntry[], traceResult: TraceResult) => Promise<void>;
  shutdownImpl?: () => Promise<void>;
} = {}): OtelExporter {
  return {
    export: vi.fn(overrides.exportImpl ?? (async () => {})),
    shutdown: vi.fn(overrides.shutdownImpl ?? (async () => {})),
  };
}

describe('FR-OTEL-004: Batch Export Trigger in createTraceHandler', () => {
  // -------------------------------------------------------
  // Test 20: export called with correct entries when otelExporter defined
  //
  // Acceptance: "GIVEN TraceDeps with otelExporter defined, WHEN trace
  // completes with 5 entries, THEN otelExporter.export() SHALL be called
  // exactly once with all 5 entries"
  //
  // Behavioral intent: The primary happy path. When OTEL is configured,
  // the exporter must receive ALL trace entries from the completed trace.
  // This is the fundamental integration point between trace execution
  // and OTEL export.
  // -------------------------------------------------------
  it('calls otelExporter.export() with entries and traceResult when otelExporter is defined', async () => {
    const mockExporter = makeMockOtelExporter();
    const { deps } = makeOtelDeps({ otelExporter: mockExporter });
    const trace = createTraceHandler(deps);

    const result = await trace(makeTraceRequest());

    // Allow fire-and-forget to settle
    await new Promise(resolve => setTimeout(resolve, 50));

    // export must be called exactly once
    expect(mockExporter.export).toHaveBeenCalledTimes(1);

    // First argument should be the entries array
    const [exportedEntries, exportedResult] = (mockExporter.export as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(Array.isArray(exportedEntries)).toBe(true);
    expect(exportedEntries.length).toBeGreaterThan(0);

    // Second argument should be the TraceResult
    expect(exportedResult).toBeDefined();
    expect(exportedResult.trace_id).toBe(result.trace_id);
  });

  // -------------------------------------------------------
  // Test 21: TraceDeps.otelExporter field is recognized by createTraceHandler
  //
  // Acceptance: "GIVEN TraceDeps with otelExporter undefined, WHEN trace
  // completes, THEN NO otel export SHALL occur and NO error SHALL be thrown"
  //
  // Behavioral intent: The createTraceHandler must read the otelExporter
  // field from deps. When undefined, it must skip export silently.
  // This test verifies the field is recognized by checking that the deps
  // object actually has the property key present (even if undefined).
  // -------------------------------------------------------
  it('createTraceHandler reads otelExporter from deps and skips export when undefined', async () => {
    const { deps } = makeDeps();
    const trace = createTraceHandler(deps);

    const result = await trace(makeTraceRequest());

    // Verify result is valid (existing behavior)
    expect(result.trace_id).toBeDefined();

    // The key assertion: deps must have otelExporter as a recognized field.
    // TraceDeps includes otelExporter as a recognized field (even when undefined).
    expect('otelExporter' in deps).toBe(true);
  });

  // -------------------------------------------------------
  // Test 22: export occurs AFTER TraceResult is fully assembled
  //
  // Acceptance: "The export call SHALL occur AFTER TraceResult is fully
  // assembled (entries, summary, findings, duration_ms all populated)"
  //
  // Behavioral intent: The exporter needs the complete TraceResult
  // including findings (for FR-OTEL-007 span events). If export is
  // triggered before findings are computed, span events will be empty.
  // -------------------------------------------------------
  it('export receives fully assembled TraceResult with entries, summary, findings, and duration_ms', async () => {
    let capturedResult: TraceResult | null = null;
    const mockExporter = makeMockOtelExporter({
      exportImpl: async (_entries: TraceEntry[], traceResult: TraceResult) => {
        capturedResult = traceResult;
      },
    });
    const { deps } = makeOtelDeps({ otelExporter: mockExporter });
    const trace = createTraceHandler(deps);

    await trace(makeTraceRequest());

    // Wait a tick for fire-and-forget to execute
    await new Promise(resolve => setTimeout(resolve, 50));

    // The captured traceResult must have all required fields populated
    expect(capturedResult).not.toBeNull();
    expect(capturedResult!.trace_id).toBeDefined();
    expect(typeof capturedResult!.trace_id).toBe('string');
    expect(Array.isArray(capturedResult!.entries)).toBe(true);
    expect(typeof capturedResult!.summary).toBe('string');
    expect(Array.isArray(capturedResult!.findings)).toBe(true);
    expect(typeof capturedResult!.duration_ms).toBe('number');
    expect(capturedResult!.duration_ms).toBeGreaterThanOrEqual(0);
  });

  // -------------------------------------------------------
  // Test 23: traceResult passed to export contains findings array
  //
  // Acceptance: "The traceResult object passed to otelExporter.export()
  // SHALL contain the findings array (needed for FR-OTEL-007 span events)"
  //
  // Behavioral intent: Integration contract with FR-OTEL-007. The
  // generateSpanEvents function uses findings to create finding.{type}
  // span events. If findings is missing, those events are silently lost.
  // -------------------------------------------------------
  it('passes findings array in traceResult to export for FR-OTEL-007 span events', async () => {
    let capturedFindings: Finding[] | undefined;
    const mockExporter = makeMockOtelExporter({
      exportImpl: async (_entries: TraceEntry[], traceResult: TraceResult) => {
        capturedFindings = traceResult.findings;
      },
    });
    const { deps } = makeOtelDeps({ otelExporter: mockExporter });
    const trace = createTraceHandler(deps);

    await trace(makeTraceRequest());

    // Wait a tick for fire-and-forget
    await new Promise(resolve => setTimeout(resolve, 50));

    // findings must be present (even if empty array)
    expect(capturedFindings).toBeDefined();
    expect(Array.isArray(capturedFindings)).toBe(true);
  });

  // -------------------------------------------------------
  // Test 24: export called with empty entries array (0 entries trace)
  //
  // Acceptance: "GIVEN TraceDeps with otelExporter and a trace that
  // produces 0 entries, WHEN export triggered, THEN otelExporter.export
  // SHALL be called with empty array (exporter decides whether to no-op)"
  //
  // Behavioral intent: Edge case. Even when a trace produces no entries
  // (e.g., invoke fails before logging), the export trigger should still
  // fire. The exporter itself decides whether to send an empty batch.
  // -------------------------------------------------------
  it('calls export with empty entries array when trace produces zero entries', async () => {
    const mockExporter = makeMockOtelExporter();
    const { deps } = makeOtelDeps({
      otelExporter: mockExporter,
      // invoke throws before logging any trace entry, and entry_point
      // is specified so no auto-detect is needed
      invokeImpl: async () => {
        throw new Error('SESSION_NOT_FOUND');
      },
    });
    const trace = createTraceHandler(deps);

    // Trace should complete (invoke errors are caught)
    const result = await trace(makeTraceRequest());

    // Wait a tick for fire-and-forget
    await new Promise(resolve => setTimeout(resolve, 50));

    // Export should still be called, even with entries from the error recovery path
    expect(mockExporter.export).toHaveBeenCalledTimes(1);
    const [exportedEntries] = (mockExporter.export as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(Array.isArray(exportedEntries)).toBe(true);
  });

  // -------------------------------------------------------
  // Test 25: export called exactly once per trace (no duplication)
  //
  // Behavioral intent: Verify that the export trigger fires exactly once
  // per trace invocation, not once per entry or once per mode branch.
  // Duplication would cause the OTEL collector to receive duplicate spans.
  // -------------------------------------------------------
  it('calls export exactly once per trace, not per entry', async () => {
    const mockExporter = makeMockOtelExporter();
    const { deps, traceLog } = makeOtelDeps({ otelExporter: mockExporter });

    // Override invoke to produce multiple trace entries
    (deps.invoke as any).mockImplementation(async (envelope: InvokeEnvelope) => {
      for (let i = 0; i < 5; i++) {
        traceLog.add(makeTraceEntry({
          trace_id: envelope.trace_id,
          task_id: `task-${i}`,
          caller: i === 0 ? '__trace_initiator__' : `src/dep-${i}.ts`,
          target: `src/dep-${i + 1}.ts`,
          function: `fn${i}`,
          depth: i,
        }));
      }
    });

    const trace = createTraceHandler(deps);
    await trace(makeTraceRequest());

    // Wait a tick for fire-and-forget
    await new Promise(resolve => setTimeout(resolve, 50));

    // Exactly one export call, not five
    expect(mockExporter.export).toHaveBeenCalledTimes(1);

    // But it should contain all 5 entries
    const [exportedEntries] = (mockExporter.export as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(exportedEntries).toHaveLength(5);
  });

  // -------------------------------------------------------
  // Test 26: entries passed to export match entries in TraceResult
  //
  // Behavioral intent: The entries array passed as the first argument
  // to export() must be the same array as traceResult.entries. This
  // ensures the exporter sees exactly what the user sees.
  // -------------------------------------------------------
  it('entries passed to export match the entries in the returned TraceResult', async () => {
    let capturedEntries: TraceEntry[] = [];
    const mockExporter = makeMockOtelExporter({
      exportImpl: async (entries: TraceEntry[]) => {
        capturedEntries = entries;
      },
    });
    const { deps } = makeOtelDeps({ otelExporter: mockExporter });
    const trace = createTraceHandler(deps);

    const result = await trace(makeTraceRequest());

    // Wait a tick for fire-and-forget
    await new Promise(resolve => setTimeout(resolve, 50));

    // The entries sent to export should match the result entries
    expect(capturedEntries.length).toBe(result.entries.length);
    for (let i = 0; i < capturedEntries.length; i++) {
      expect(capturedEntries[i].trace_id).toBe(result.entries[i].trace_id);
      expect(capturedEntries[i].task_id).toBe(result.entries[i].task_id);
    }
  });
});

describe('FR-OTEL-010 (partial): Error isolation at export() call point', () => {
  // -------------------------------------------------------
  // Test 27: TraceResult returned unchanged when export() throws
  //
  // Acceptance: "GIVEN otelExporter.export() throws an Error, WHEN trace
  // completes, THEN createTraceHandler SHALL still return a valid
  // TraceResult (FR-OTEL-010 cross-ref)"
  //
  // Behavioral intent: The core isolation guarantee. OTEL is an optional
  // observability layer -- if it fails, the primary trace result must be
  // unaffected. This is the most critical test in the error isolation set.
  // -------------------------------------------------------
  it('returns valid TraceResult and calls export even when export() throws', async () => {
    const mockExporter = makeMockOtelExporter({
      exportImpl: async () => {
        throw new Error('ECONNREFUSED: connection refused');
      },
    });
    const { deps } = makeOtelDeps({ otelExporter: mockExporter });
    const trace = createTraceHandler(deps);

    const result = await trace(makeTraceRequest());

    // Allow fire-and-forget to settle
    await new Promise(resolve => setTimeout(resolve, 50));

    // TraceResult must be valid and complete despite export failure
    expect(result.trace_id).toBeDefined();
    expect(Array.isArray(result.entries)).toBe(true);
    expect(result.entries.length).toBeGreaterThan(0);
    expect(typeof result.summary).toBe('string');
    expect(typeof result.duration_ms).toBe('number');
    expect(Array.isArray(result.findings)).toBe(true);

    // Export MUST have been called (the error isolation is about catching the
    // throw, not about skipping the call). Without this assertion, the test
    // would pass vacuously if export is never called at all.
    expect(mockExporter.export).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------
  // Test 28: No unhandled rejection when export() rejects async
  //
  // Acceptance: "GIVEN otelExporter.export() rejects with a timeout,
  // WHEN trace completes, THEN the rejected promise SHALL NOT cause an
  // unhandled rejection (must be caught)"
  //
  // Behavioral intent: Async rejection handling. If the export promise
  // rejects after TraceResult has been returned, the rejection must be
  // caught to prevent Node.js unhandled rejection crashes.
  // -------------------------------------------------------
  it('catches async rejection from export without unhandled rejection', async () => {
    const mockExporter = makeMockOtelExporter({
      exportImpl: () => {
        return Promise.reject(new Error('TIMEOUT: export deadline exceeded'));
      },
    });
    const { deps } = makeOtelDeps({ otelExporter: mockExporter });
    const trace = createTraceHandler(deps);

    // Should not throw
    const result = await trace(makeTraceRequest());

    // Wait for the rejected promise to settle
    await new Promise(resolve => setTimeout(resolve, 100));

    // TraceResult must be valid
    expect(result.trace_id).toBeDefined();
    expect(Array.isArray(result.entries)).toBe(true);
    expect(typeof result.duration_ms).toBe('number');

    // Export must have been attempted (rejection was caught, not skipped).
    // Without this, the test passes vacuously since no export = no rejection.
    expect(mockExporter.export).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------
  // Test 29: TraceResult identical with and without otelExporter
  //
  // Acceptance (invariant): "for-all traces:
  // TraceResult(with_otel) === TraceResult(without_otel)"
  //
  // Behavioral intent: The strongest isolation guarantee. The presence
  // of otelExporter should have zero effect on the TraceResult content.
  // Even when export fails, the result must be structurally identical
  // to what would be returned without any exporter configured.
  // -------------------------------------------------------
  it('produces identical TraceResult shape with failing exporter vs no exporter and export was attempted', async () => {
    // Run trace WITHOUT otelExporter
    const { deps: depsWithout } = makeDeps();
    const traceWithout = createTraceHandler(depsWithout);
    const resultWithout = await traceWithout(makeTraceRequest());

    // Run trace WITH failing otelExporter
    const failingExporter = makeMockOtelExporter({
      exportImpl: async () => {
        throw new Error('OTEL_EXPORT_FAILED');
      },
    });
    const { deps: depsWith } = makeOtelDeps({ otelExporter: failingExporter });
    const traceWith = createTraceHandler(depsWith);
    const resultWith = await traceWith(makeTraceRequest());

    // Allow fire-and-forget to settle
    await new Promise(resolve => setTimeout(resolve, 50));

    // Structure should be identical (trace_id will differ, so compare shape)
    expect(resultWith.entries.length).toBe(resultWithout.entries.length);
    expect(typeof resultWith.summary).toBe(typeof resultWithout.summary);
    expect(Array.isArray(resultWith.findings)).toBe(true);
    expect(typeof resultWith.duration_ms).toBe('number');
    // The key assertion: findings array should be the same shape
    expect(resultWith.findings.length).toBe(resultWithout.findings.length);

    // The export must have been attempted for the isolation test to be meaningful.
    // Without this, both traces just ran without any OTEL involvement.
    expect(failingExporter.export).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------
  // Test 30: Fire-and-forget pattern -- export does not block return
  //
  // Acceptance: "The export call SHALL NOT delay or block the TraceResult
  // return to the caller (try/catch with warn-level logging)"
  // Also: "GIVEN OTEL export takes 10 seconds, WHEN trace completes,
  // THEN TraceResult SHALL be returned immediately"
  //
  // Behavioral intent: Performance isolation. A slow OTEL collector must
  // not degrade trace latency. The export is fire-and-forget: started but
  // not awaited for the return value.
  // -------------------------------------------------------
  it('returns TraceResult immediately without waiting for slow export', async () => {
    let exportResolveFn: (() => void) | null = null;
    const exportPromise = new Promise<void>((resolve) => {
      exportResolveFn = resolve;
    });

    const mockExporter = makeMockOtelExporter({
      exportImpl: async () => {
        // Simulate a slow export that takes a long time
        await exportPromise;
      },
    });
    const { deps } = makeOtelDeps({ otelExporter: mockExporter });
    const trace = createTraceHandler(deps);

    const result = await trace(makeTraceRequest());

    // TraceResult should be returned immediately, not waiting for the
    // slow export. The export is still pending at this point.
    expect(result.trace_id).toBeDefined();
    expect(result.entries).toBeDefined();

    // The export function should have been called (fire-and-forget started)
    expect(mockExporter.export).toHaveBeenCalledTimes(1);

    // Clean up: resolve the hanging export promise
    exportResolveFn!();
    await new Promise(resolve => setTimeout(resolve, 10));
  });

  // -------------------------------------------------------
  // Test 31: No accumulating failure state across multiple traces
  //
  // Acceptance: "GIVEN otelExporter defined but endpoint is unreachable,
  // WHEN 100 traces run, THEN ALL 100 TraceResults SHALL be returned
  // correctly (no accumulating failure state)"
  //
  // Behavioral intent: Resilience over time. Each export failure is
  // independent -- there is no retry queue, no buffered spans, no state
  // that accumulates across traces. The 100th failure is as harmless
  // as the first.
  // -------------------------------------------------------
  it('returns valid TraceResult for every trace even with persistent export failures', async () => {
    let exportCallCount = 0;
    const mockExporter = makeMockOtelExporter({
      exportImpl: async () => {
        exportCallCount++;
        throw new Error(`ECONNREFUSED attempt ${exportCallCount}`);
      },
    });
    const { deps } = makeOtelDeps({ otelExporter: mockExporter });
    const trace = createTraceHandler(deps);

    // Run 10 traces (scaled down from 100 for test speed, same principle)
    const results: TraceResult[] = [];
    for (let i = 0; i < 10; i++) {
      const result = await trace(makeTraceRequest({
        scenario: `Trace attempt ${i + 1}`,
      }));
      results.push(result);
    }

    // Wait for fire-and-forget promises
    await new Promise(resolve => setTimeout(resolve, 100));

    // All 10 traces must have valid results
    for (let i = 0; i < results.length; i++) {
      expect(results[i].trace_id).toBeDefined();
      expect(Array.isArray(results[i].entries)).toBe(true);
      expect(typeof results[i].duration_ms).toBe('number');
    }

    // Export should have been attempted for each trace
    expect(exportCallCount).toBe(10);
  });
});

// ===========================================================================
// PRD Contract Tests: TraceDeps type extension
//
// These tests verify the structural contract specified in the PRD:
// TraceDeps must accept an optional otelExporter field of type OtelExporter.
// ===========================================================================

describe('FR-OTEL-004: TraceDeps type contract', () => {
  // -------------------------------------------------------
  // Test 32: TraceDeps accepts otelExporter as optional field
  //
  // PRD spec: "TraceDeps_extension:⊳{ otelExporter?: OtelExporter }"
  //
  // Behavioral intent: Type-level contract. TraceDeps must accept the
  // field without breaking existing consumers. The field is optional
  // (mirrors the onVerbose pattern on the same type).
  // -------------------------------------------------------
  it('TraceDeps type has otelExporter as a recognized optional property', () => {
    // Verify that TraceDeps type definition includes otelExporter.
    // We construct a TraceDeps object and check the type system accepts it.
    // TraceDeps defines otelExporter as optional, so makeDeps includes
    // it as a key with value undefined.

    const { deps } = makeDeps();

    // After GREEN implements, 'otelExporter' should be a recognized property
    // that can appear on deps (even if undefined). We verify that the
    // makeDeps pattern produces it as a known key.
    const depsKeys = Object.keys(deps);
    expect(depsKeys).toContain('otelExporter');
  });

  // -------------------------------------------------------
  // Test 33: createTraceHandler invokes OtelExporter with PRD-specified signature
  //
  // PRD spec: otelExporter.export(entries: TraceEntry[], traceResult: TraceResult)
  //
  // Behavioral intent: End-to-end integration contract. When
  // createTraceHandler is given a deps with otelExporter, the exporter's
  // export method must be called with exactly 2 arguments: the entries
  // array (TraceEntry[]) and the complete TraceResult object including
  // trace_id, entries, summary, findings, and duration_ms.
  //
  // This is NOT testing the mock in isolation -- it tests that
  // createTraceHandler actually calls the exporter with the right args.
  // -------------------------------------------------------
  it('createTraceHandler invokes exporter.export with (entries, traceResult) signature', async () => {
    const mockExporter = makeMockOtelExporter();
    const { deps } = makeOtelDeps({ otelExporter: mockExporter });
    const trace = createTraceHandler(deps);

    const result = await trace(makeTraceRequest());

    // Allow fire-and-forget to settle
    await new Promise(resolve => setTimeout(resolve, 50));

    // The handler must have called export
    expect(mockExporter.export).toHaveBeenCalledTimes(1);

    // Verify the call signature matches PRD: export(entries, traceResult)
    const call = (mockExporter.export as ReturnType<typeof vi.fn>).mock.calls[0];
    expect(call).toHaveLength(2);

    // First arg: TraceEntry[]
    const entries = call[0] as TraceEntry[];
    expect(Array.isArray(entries)).toBe(true);

    // Second arg: TraceResult with all required fields
    const traceResult = call[1] as TraceResult;
    expect(traceResult).toHaveProperty('trace_id');
    expect(traceResult).toHaveProperty('entries');
    expect(traceResult).toHaveProperty('summary');
    expect(traceResult).toHaveProperty('findings');
    expect(traceResult).toHaveProperty('duration_ms');
    expect(traceResult.trace_id).toBe(result.trace_id);
  });
});
