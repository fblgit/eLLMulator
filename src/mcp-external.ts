/**
 * External MCP tool handlers — trace, inspect, status, list_agents, consolidate.
 *
 * SPEC FileStructure: 'mcp-external.ts' — external MCP tool handlers
 * Consolidates FR-010 (trace), FR-011 (inspect/status/list_agents), FR-012 (consolidate).
 *
 * All handlers follow the project's factory pattern: createXxxHandler(deps) returns
 * a handler function. Dependencies are injected, never global.
 */

import { randomUUID } from 'node:crypto';
import type { Registry, RegistryEntry, Declarations } from './registry.js';
import type { SessionManager, AgentSession } from './session-manager.js';
import type { TraceLog } from './trace-log.js';
import type { SyntheticState } from './handlers.js';
import type { OtelExporter } from './otel-export.js';
import type {
  InvokeEnvelope,
  ResponseEnvelope,
  TraceEntry,
  TraceRequest,
  TraceResult,
  ConsolidateResult,
} from './types.js';
import { analyzeTrace, summarizeTraceAsync, detectEntryPoint } from './analyzer.js';
import { createStarmap } from './starmap.js';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { createLogger } from './logger.js';

const log = createLogger('trace');

// Re-export types so consumers can import from this module
export type {
  Finding,
  FindingType,
  TraceRequest,
  TraceResult,
  ConsolidateResult,
} from './types.js';

// Unified consolidation: flow handler IS the consolidation handler.
// Re-export with both names for backward compatibility.
export { createConsolidateFlowHandler } from './consolidate-flow.js';
export { createConsolidateFlowHandler as createConsolidateHandler } from './consolidate-flow.js';
export type { ConsolidateFlowDeps } from './consolidate-flow.js';
export type { ConsolidateFlowDeps as ConsolidateDeps } from './consolidate-flow.js';

// ---------------------------------------------------------------------------
// Deps types
// ---------------------------------------------------------------------------

/** Matches the deps shape of invoke() from invoke.ts without importing it. */
type InvokeDepsShape = {
  registry: Registry;
  sessionManager: SessionManager;
  traceLog: TraceLog | ((entry: TraceEntry) => void);
  rateLimitTracker: any;
  selfLoopTracker: any;
  readFile: (filePath: string) => Promise<string>;
  projectDir: string;
};

export type TraceDeps = {
  registry: Registry;
  sessionManager: SessionManager;
  traceLog: TraceLog;
  syntheticState: SyntheticState;
  rateLimitTracker: any;
  selfLoopTracker: any;
  readFile: (filePath: string) => Promise<string>;
  projectDir: string;
  invoke: (envelope: InvokeEnvelope, deps: InvokeDepsShape) => Promise<unknown>;
  /** Verbose logging callback — receives structured trace events for --verbose mode */
  onVerbose?: (event: { type: string; [key: string]: unknown }) => void;
  /** Internal MCP server port — threads through to invoke deps for agent tool access */
  intPort?: number;
  /** Optional OTEL exporter — when provided, triggers fire-and-forget export after trace */
  otelExporter?: OtelExporter;
};

export type QueryDeps = {
  registry: Registry;
  sessionManager: SessionManager;
  traceLog: TraceLog;
};

// ConsolidateDeps is now re-exported from consolidate-flow.ts as an alias for ConsolidateFlowDeps

// ---------------------------------------------------------------------------
// Result types (internal to handler responses)
// ---------------------------------------------------------------------------

type InspectResult = {
  entry: RegistryEntry;
  session: AgentSession | null;
  declarations: Declarations | null;
};

type StatusResult = {
  total_files: number;
  by_status: Record<string, number>;
  active_traces: number;
  agent_pool_size: number;
};

type AgentInfo = {
  file_path: string;
  status: string;
  has_session: boolean;
  declaration_count: number;
};

// ---------------------------------------------------------------------------
// Entry point + function detection via LLM exploration
// ---------------------------------------------------------------------------

type ExplorationResult = {
  entry_point: string;
  function: string;
  reasoning?: string;
};

/**
 * Use an LLM to identify the best entry point file AND function for a trace scenario.
 *
 * Replaces the old keyword-matching heuristic. Builds a registry summary and asks
 * the LLM to reason about which file/function best matches the scenario.
 * Falls back to detectEntryPoint + first-declaration if the LLM call fails.
 *
 * Uses SDK query() directly (like summarizeTraceAsync) — no MCP session needed.
 */
async function detectEntryPointAndFunction(
  scenario: string,
  registry: Registry,
  model?: string,
): Promise<ExplorationResult> {
  const readyEntries = registry.listByStatus('ready');
  log.info('detecting entry point', { readyFiles: readyEntries.length, model: model || 'default' });

  if (readyEntries.length === 0) {
    log.error('no ready agents in registry');
    throw new Error('CANNOT_DETECT_ENTRY_POINT: no ready agents in registry');
  }

  // Single file — skip LLM
  if (readyEntries.length === 1) {
    const entry = readyEntries[0];
    const runtimeDecls = (entry.declarations?.owns ?? []).filter(
      d => !NON_RUNTIME_KINDS.has(d.kind),
    );
    const bestDecl = runtimeDecls[0] || entry.declarations?.owns?.[0];
    const result = {
      entry_point: entry.file_path,
      function: bestDecl?.name || entry.file_path.split('/').pop()?.replace(/\.\w+$/, '') || 'main',
    };
    log.info('single file, skipping LLM', result);
    return result;
  }

  // Build registry summary for the LLM
  const registrySummary = readyEntries.map(entry => {
    const decls = entry.declarations;
    const owns = (decls?.owns ?? []).map(d =>
      `    - ${d.name} (${d.kind}): ${d.intent || 'no description'}`,
    ).join('\n');
    const deps = (decls?.dependencies ?? []).join(', ') || 'none';
    return `### ${entry.file_path}\nSummary: ${decls?.summary || 'no summary'}\nDependencies: ${deps}\nDeclarations:\n${owns}`;
  }).join('\n\n');

  const prompt = `# Task: Identify Entry Point for Trace

## Scenario
"${scenario}"

## Project Registry
${registrySummary}

## Instructions
Based on the scenario, select the BEST entry point file and the BEST runtime function to begin tracing.

**Important:**
- Pick a RUNTIME function (function, class, method, const) — NOT a type, interface, or type alias. Types cannot be traced.
- Consider the dependency graph: entry points typically have many dependencies and few dependents.
- Match the scenario intent to function intents and names.
- The function must exist in the file's declarations list above.

## Required Response Format
Respond with ONLY this JSON, nothing else:
\`\`\`json
{
  "entry_point": "src/some-file.ts",
  "function": "someFunction",
  "reasoning": "brief explanation"
}
\`\`\``;

  log.info('querying LLM for entry point detection', { candidates: readyEntries.length });
  try {
    let llmResponse = '';
    for await (const message of query({
      prompt,
      options: {
        model: model || 'claude-sonnet-4-6',
        systemPrompt: 'You are a codebase architecture analyzer. You select optimal entry points for distributed trace analysis. Respond ONLY with the requested JSON.',
        maxTurns: 1,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      },
    })) {
      if (message.type === 'assistant') {
        const assistantMsg = message as any;
        const content = assistantMsg.message?.content || assistantMsg.content;
        if (typeof content === 'string') {
          llmResponse += content;
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if ('text' in block) llmResponse += block.text;
          }
        }
      }
      if (message.type === 'result') {
        break;
      }
    }

    // Parse JSON from response (handle markdown code blocks)
    const jsonMatch = llmResponse.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]) as ExplorationResult;

      // Validate the entry_point exists in registry
      const entryExists = registry.get(parsed.entry_point);
      if (entryExists) {
        // Validate the function exists in declarations (and prefer runtime kinds)
        const declExists = entryExists.declarations?.owns?.find(d => d.name === parsed.function);
        if (declExists) {
          log.info('LLM entry point accepted', { entryPoint: parsed.entry_point, function: parsed.function, reasoning: parsed.reasoning });
          return parsed;
        }
        // Function not found — use LLM's entry_point but pick best runtime function
        const runtimeDecls = (entryExists.declarations?.owns ?? []).filter(
          d => !NON_RUNTIME_KINDS.has(d.kind),
        );
        const adjusted = {
          entry_point: parsed.entry_point,
          function: runtimeDecls[0]?.name || entryExists.declarations?.owns?.[0]?.name || parsed.function,
          reasoning: parsed.reasoning,
        };
        log.info('LLM entry point accepted (function adjusted)', adjusted);
        return adjusted;
      }
      log.warn('LLM entry point not in registry, falling back', { suggested: parsed.entry_point });
    }
  } catch (llmErr) {
    // LLM call failed — fall through to heuristic fallback
    log.warn('LLM entry point detection failed, using heuristic', { error: llmErr instanceof Error ? llmErr.message : String(llmErr) });
  }

  // Fallback: use existing detectEntryPoint + first runtime declaration
  const starmap = createStarmap(registry);
  const fallbackEntry = await detectEntryPoint(scenario, registry, starmap);
  const fallbackReg = registry.get(fallbackEntry);
  const runtimeDecls = (fallbackReg?.declarations?.owns ?? []).filter(
    d => !NON_RUNTIME_KINDS.has(d.kind),
  );
  const fallbackFn = runtimeDecls[0]?.name
    || fallbackReg?.declarations?.owns?.[0]?.name
    || fallbackEntry.split('/').pop()?.replace(/\.\w+$/, '') || 'main';

  return { entry_point: fallbackEntry, function: fallbackFn };
}

/** Kinds that are not runtime-traceable (type aliases, interfaces, etc.) */
const NON_RUNTIME_KINDS = new Set(['type', 'interface', 'type_alias', 'schema']);

// ---------------------------------------------------------------------------
// FR-010: trace
// ---------------------------------------------------------------------------

export function createTraceHandler(
  deps: TraceDeps,
): (request: TraceRequest) => Promise<TraceResult> {
  // Shared invoke deps — avoids repeating the same object in 4 call sites
  const invokeDeps = {
    registry: deps.registry,
    sessionManager: deps.sessionManager,
    traceLog: deps.traceLog,
    rateLimitTracker: deps.rateLimitTracker,
    selfLoopTracker: deps.selfLoopTracker,
    readFile: deps.readFile,
    projectDir: deps.projectDir,
    ...(deps.onVerbose && { onVerbose: deps.onVerbose }),
    ...(deps.intPort && { intPort: deps.intPort }),
  };

  return async (request: TraceRequest): Promise<TraceResult> => {
    const start = Date.now();
    const trace_id = randomUUID();
    const max_depth = request.max_depth ?? 50;
    const traceMode = request.mode ?? 'full';

    // Detect entry point + function via LLM exploration agent.
    // If entry_point is explicitly provided, still use LLM to pick the best function.
    let entry_point = request.entry_point;
    let detectedFunction: string;

    log.info('trace handler invoked', { scenario: request.scenario.slice(0, 120), maxDepth: max_depth, mode: traceMode });

    if (entry_point) {
      // Entry point specified — just detect function within it
      const entryReg = deps.registry.get(entry_point);
      const runtimeDecls = (entryReg?.declarations?.owns ?? []).filter(
        d => !NON_RUNTIME_KINDS.has(d.kind),
      );
      detectedFunction = runtimeDecls[0]?.name
        || entryReg?.declarations?.owns?.[0]?.name
        || entry_point.split('/').pop()?.replace(/\.\w+$/, '') || 'main';
      log.info('entry point (explicit)', { entryPoint: entry_point, function: detectedFunction });
    } else {
      // Full LLM detection: entry point + function in one shot
      log.info('detecting entry point via LLM exploration');
      const exploration = await detectEntryPointAndFunction(
        request.scenario,
        deps.registry,
      );
      entry_point = exploration.entry_point;
      detectedFunction = exploration.function;
      log.info('entry point (LLM)', { entryPoint: entry_point, function: detectedFunction, reasoning: exploration.reasoning?.slice(0, 100) });

      if (deps.onVerbose) {
        deps.onVerbose({
          type: 'exploration_result',
          entry_point,
          function: detectedFunction,
          reasoning: exploration.reasoning,
        });
      }
    }

    // Inject state if provided
    if (request.state) {
      const stateKeys = Object.keys(request.state);
      log.info('injecting synthetic state', { keys: stateKeys });
      for (const [key, value] of Object.entries(request.state)) {
        deps.syntheticState.set(key, value);
      }
    }

    // Build initial envelope — scenario lives in notes, not params
    const envelope: InvokeEnvelope = {
      trace_id,
      task_id: randomUUID(),
      caller: '__trace_initiator__',
      target: entry_point,
      function: detectedFunction,
      state: request.state,
      notes: request.scenario,
      call_stack: [],
      mode: 'sync',
      max_depth,
      traceMode,  // Phase 5.1: pass trace mode through envelope
    };

    // Phase 5.1: Handle mode-specific behavior
    log.info('executing trace', { mode: traceMode, entryPoint: entry_point, function: detectedFunction, traceId: trace_id });

    if (traceMode === 'lens') {
      log.info('lens mode: invoking entry point, stubbing dependencies');
      await handleLensMode(envelope, deps, trace_id, invokeDeps);
    } else if (traceMode === 'targeted') {
      log.info('targeted mode: invoking entry point and selected dependencies');
      await handleTargetedMode(envelope, deps, trace_id, invokeDeps, request.targetPath, request.scenario);
    } else {
      // Full mode: standard invoke
      log.info('full mode: invoking entry point');
      try {
        await deps.invoke(envelope, invokeDeps);
      } catch (err) {
        // Trace continues even if invoke throws.
        // If invoke logged its own trace entry, it's already in traceLog.
        // If invoke was mocked or threw before logging (e.g. session not found),
        // we add a fallback trace entry so the trace result isn't empty.
        const existingEntries = deps.traceLog.getByTraceId(trace_id);
        if (existingEntries.length === 0) {
          const errorMessage = err instanceof Error ? err.message : String(err);
          // Provide a structured error. If the raw error is a session-not-found,
          // rewrite it as a clear session availability issue rather than propagating
          // the opaque SessionManager error.
          const isSessionError = /Session not found/i.test(errorMessage);
          const structuredError = isSessionError
            ? `SESSION_NOT_AVAILABLE: ${entry_point} agent session is not running. Re-bootstrap or use 'start --bootstrap' before tracing.`
            : `INVOKE_FAILED: ${entry_point} — ${errorMessage}`;
          deps.traceLog.add({
            trace_id,
            task_id: envelope.task_id,
            timestamp: new Date(),
            depth: 0,
            caller: '__trace_initiator__',
            target: entry_point,
            function: detectedFunction,
            params: envelope.params ?? {},
            duration_ms: Date.now() - start,
            error: structuredError,
            call_stack: [],
          });
        }
      }
    }

    // Collect entries
    const entries = deps.traceLog.getByTraceId(trace_id);

    const duration_ms = Date.now() - start;
    const errorCount = entries.filter(e => e.error).length;
    log.info('trace execution complete', { entries: entries.length, errors: errorCount, elapsed: `${(duration_ms / 1000).toFixed(1)}s`, traceId: trace_id });

    // Phase 5.6: LLM-enriched summary via async path
    log.info('generating trace summary and analysis');
    const traceResult: TraceResult = {
      trace_id,
      entries,
      summary: await summarizeTraceAsync(entries),
      findings: analyzeTrace(entries, deps.registry),
      duration_ms,
    };

    // FR-OTEL-004: Fire-and-forget OTEL export after trace completion
    if (deps.otelExporter) {
      deps.otelExporter.export(entries, traceResult).catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        log.warn('OTEL export failed', { error: message });
      });
    }

    return traceResult;
  };
}

/**
 * Phase 5.1: Handle lens mode - invoke entry point, stub dependencies
 */
async function handleLensMode(
  envelope: InvokeEnvelope,
  deps: TraceDeps,
  trace_id: string,
  invokeDeps: Record<string, unknown>,
): Promise<void> {
  // Invoke the entry point
  try {
    await deps.invoke(envelope, invokeDeps as any);
  } catch {
    // Continue even if invoke fails
  }

  // Get entry point's declared dependencies and create stub entries
  const entryPointEntry = deps.registry.get(envelope.target);
  if (entryPointEntry?.declarations?.dependencies) {
    for (const depPath of entryPointEntry.declarations.dependencies) {
      const stubEntry: TraceEntry = {
        trace_id,
        task_id: randomUUID(),
        timestamp: new Date(),
        depth: 1,
        caller: envelope.target,
        target: depPath,
        function: '__stubbed__',
        params: {},
        result: { stubbed: true, message: `Stubbed dependency in lens mode` },
        source_refs: [`${depPath}:0-0 (stubbed)`],
        duration_ms: 0,
        call_stack: [envelope.target],
        stubbed: true,
      };
      deps.traceLog.add(stubEntry);
    }
  }
}

/**
 * Phase 5.1: Handle targeted mode - invoke entry point and select dependencies
 * 
 * Uses targetPath if provided, otherwise parses scenario for hints about which files to skip.
 */
async function handleTargetedMode(
  envelope: InvokeEnvelope,
  deps: TraceDeps,
  trace_id: string,
  invokeDeps: Record<string, unknown>,
  targetPath?: string[],
  scenario?: string,
): Promise<void> {
  // Invoke the entry point
  try {
    await deps.invoke(envelope, invokeDeps as any);
  } catch {
    // Continue even if invoke fails
  }

  // Get dependencies to invoke
  const entryPointEntry = deps.registry.get(envelope.target);
  if (!entryPointEntry?.declarations?.dependencies) {
    return;
  }

  let dependenciesToInvoke = entryPointEntry.declarations.dependencies;

  // If targetPath is explicitly provided, filter to only those in the path
  if (targetPath && targetPath.length > 0) {
    dependenciesToInvoke = dependenciesToInvoke.filter(dep => targetPath.includes(dep));
  } else if (scenario) {
    // Parse scenario for skip hints (e.g., "skip auth" means don't invoke auth)
    // This is a heuristic fallback when targetPath isn't specified
    const lowerScenario = scenario.toLowerCase();
    dependenciesToInvoke = dependenciesToInvoke.filter(dep => {
      const fileName = dep.split('/').pop()?.replace(/\.(ts|js|py|go)$/, '') || '';
      const skipPattern = new RegExp(`skip\\s+${fileName}`, 'i');
      return !skipPattern.test(lowerScenario);
    });
  }

  // Invoke filtered dependencies
  for (const depPath of dependenciesToInvoke) {
    const depEnvelope: InvokeEnvelope = {
      trace_id,
      task_id: randomUUID(),
      caller: envelope.target,
      target: depPath,
      function: '__dependency__',
      params: {},
      call_stack: [envelope.target],
      mode: 'sync',
      max_depth: envelope.max_depth,
      traceMode: 'targeted',
    };

    try {
      await deps.invoke(depEnvelope, invokeDeps as any);
    } catch {
      // Continue even if dependency invoke fails
    }
  }
}

// ---------------------------------------------------------------------------
// FR-011: inspect
// ---------------------------------------------------------------------------

export function createInspectHandler(deps: QueryDeps) {
  const inspectLog = createLogger('inspect');
  return (file_path: string): InspectResult => {
    inspectLog.info('inspecting', { file: file_path });
    const entry = deps.registry.get(file_path);
    if (!entry) {
      inspectLog.warn('file not registered', { file: file_path });
      throw new Error('FILE_NOT_REGISTERED');
    }

    const session = entry.session_id
      ? deps.sessionManager.get(entry.session_id) ?? null
      : null;

    return {
      entry,
      session,
      declarations: entry.declarations,
    };
  };
}

// ---------------------------------------------------------------------------
// FR-011: status
// ---------------------------------------------------------------------------

export function createStatusHandler(deps: QueryDeps) {
  const statusLog = createLogger('status');
  return (): StatusResult => {
    statusLog.debug('querying status');
    const entries = deps.registry.list();

    const by_status: Record<string, number> = {
      cold: 0,
      bootstrapping: 0,
      ready: 0,
      stale: 0,
      error: 0,
    };

    for (const entry of entries) {
      by_status[entry.status] = (by_status[entry.status] ?? 0) + 1;
    }

    // Active traces: entries without duration_ms
    const allTraces = deps.traceLog.list();
    const active_traces = allTraces.filter((t) => t.duration_ms === undefined).length;

    // Agent pool size: active sessions
    const agent_pool_size = deps.sessionManager.list().length;

    return {
      total_files: entries.length,
      by_status,
      active_traces,
      agent_pool_size,
    };
  };
}

// ---------------------------------------------------------------------------
// FR-011: list_agents
// ---------------------------------------------------------------------------

export function createListAgentsHandler(deps: QueryDeps) {
  const listLog = createLogger('listAgents');
  return (filter_status?: string): AgentInfo[] => {
    listLog.debug('listing agents', { filter: filter_status || 'all' });
    let entries = deps.registry.list();

    if (filter_status) {
      entries = entries.filter((e) => e.status === filter_status);
    }

    return entries.map((e) => ({
      file_path: e.file_path,
      status: e.status,
      has_session: e.session_id !== null,
      declaration_count: e.declarations?.owns?.length ?? 0,
    }));
  };
}

// FR-012: consolidate — unified via createConsolidateFlowHandler (re-exported above)
