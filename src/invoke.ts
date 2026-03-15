/**
 * FR-005: Invoke Handler -- Minimal GREEN implementation
 *
 * Core invoke primitive: cycle detection, depth limiting, registry resolution,
 * lazy spawn for cold/stale agents, query forwarding, and trace logging.
 *
 * SPEC: Uses guardrails.ts for all safety checks (cycle, depth, rate-limit,
 * self-loop, envelope validation) and templates.ts for prompt rendering.
 */

import type { Registry } from './registry.js';
import type { SessionManager } from './session-manager.js';
import type { InvokeEnvelope, ResponseEnvelope, TraceEntry } from './types.js';
import type { TraceLog } from './trace-log.js';
import {
  checkCycle,
  checkDepth,
  checkRateLimit,
  checkSelfLoop,
  validateResponseEnvelope,
  RateLimitTracker,
  SelfLoopTracker,
} from './guardrails.js';
import { renderInvokePrompt, renderSystemPrompt, renderBootstrapPrompt, type CorrelatedDep } from './templates.js';
import { createLogger } from './logger.js';
import { join, dirname, resolve, posix } from 'node:path';
import { resolveDepPath } from './paths.js';

const log = createLogger('invoke');

// Re-export types so existing consumers (tests, downstream modules) still
// import from './invoke' without breakage.
export type { InvokeEnvelope, Mutation, ResponseEnvelope, TraceEntry } from './types.js';

// Re-export tracker types so consumers can construct InvokeDeps.
export { RateLimitTracker, SelfLoopTracker } from './guardrails.js';

export type ProgressEvent = {
  type: 'progress';
  target: string;
  trace_id: string;
  depth: number;
  content: string;
};

export type InvokeDeps = {
  registry: Registry;
  sessionManager: SessionManager;
  traceLog: TraceLog | ((entry: TraceEntry) => void);
  rateLimitTracker: RateLimitTracker;
  selfLoopTracker: SelfLoopTracker;
  readFile: (filePath: string) => Promise<string>;
  projectDir: string;
  onProgress?: (event: ProgressEvent) => void;
  syntheticState?: Map<string, unknown> | { get(key: string): unknown };
  /** Verbose logging callback — receives structured trace events for --verbose mode */
  onVerbose?: (event: { type: string; [key: string]: unknown }) => void;
  /** Model to use for session revival (default: claude-sonnet-4-6) */
  model?: string;
  /** Internal MCP server port — required for agents to access tools (respond, invoke, resolve, etc.) */
  intPort?: number;
  /** Shared context map — invoke stores trace context here so the MCP invoke handler
   *  can auto-fill envelope fields when agents use the simplified invoke schema. */
  invokeContexts?: Map<string, { trace_id: string; caller: string; call_stack: string[]; max_depth: number }>;
};

// ---------------------------------------------------------------------------
// MCP server configuration helper
// ---------------------------------------------------------------------------

/** Internal MCP tool names (bare) used when no MCP server is configured (tests) */
const BARE_TOOLS_REVIVAL = ['invoke', 'register', 'state_get', 'state_set', 'resolve', 'respond'];
const BARE_TOOLS_INVOKE = ['invoke', 'state_get', 'state_set', 'resolve', 'respond'];

/** MCP-namespaced tool names when connected to internal MCP server */
const MCP_TOOLS_REVIVAL = ['mcp__internal__invoke', 'mcp__internal__register', 'mcp__internal__state_get', 'mcp__internal__state_set', 'mcp__internal__resolve', 'mcp__internal__respond'];
const MCP_TOOLS_INVOKE = ['mcp__internal__invoke', 'mcp__internal__state_get', 'mcp__internal__state_set', 'mcp__internal__resolve', 'mcp__internal__respond'];

function getMcpConfig(intPort?: number): { mcpServers?: Record<string, any>; revivalTools: string[]; invokeTools: string[] } {
  if (!intPort) {
    return { mcpServers: undefined, revivalTools: BARE_TOOLS_REVIVAL, invokeTools: BARE_TOOLS_INVOKE };
  }
  return {
    mcpServers: { 'internal': { type: 'http', url: `http://127.0.0.1:${intPort}/mcp` } },
    revivalTools: MCP_TOOLS_REVIVAL,
    invokeTools: MCP_TOOLS_INVOKE,
  };
}

// ---------------------------------------------------------------------------
// Dependency path resolution — imported from paths.ts
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Session revival helper
// ---------------------------------------------------------------------------

/**
 * Lazy-spawn a fresh agent session for a ready registry entry whose session
 * is missing (null session_id or stale session from a dead process).
 *
 * This enables the `trace` CLI cold-start path: registry is loaded from
 * persistence with ready entries, but SessionManager is fresh (no sessions).
 *
 * Returns the new session_id. Throws SESSION_NOT_AVAILABLE on failure.
 */
async function reviveSession(
  target: string,
  entry: { file_hash: string; session_id: string | null },
  deps: InvokeDeps,
): Promise<string> {
  // Check if the entry already has declarations from persistence.
  // If so, skip full bootstrap (reading imports, calling register) — just
  // create a minimal session. Full bootstrap only needed for cold entries.
  const hasDeclarations = !!(entry as any).declarations;
  log.info('reviveSession starting', { target, oldSessionId: entry.session_id ?? 'null', fileHash: entry.file_hash, hasDeclarations });
  try {
    const systemPrompt = renderSystemPrompt({
      filePath: target,
      sourceCode: '',  // source is read by agent via cat -n, not embedded
    });

    // Warm revival: declarations exist, just need a live session.
    // Cold revival: no declarations, needs full bootstrap.
    const bootstrapPrompt = hasDeclarations
      ? 'Your declarations are already registered from a previous session. You are ready for trace tasks. Respond with "ready" and wait for your next message.'
      : renderBootstrapPrompt({ filePath: target });

    const mcpConfig = getMcpConfig(deps.intPort);
    const session = await deps.sessionManager.create({
      filePath: target,
      fileHash: entry.file_hash,
      systemPrompt,
      bootstrapPrompt,
      tools: mcpConfig.revivalTools,
      ...(mcpConfig.mcpServers && { mcpServers: mcpConfig.mcpServers }),
      // Revival = bootstrap: allow Bash (for cat -n), Grep, Glob, LS.
      // Block Agent/Task (delegation), Write/Edit (no modifications), and Read (use cat -n instead).
      disallowedTools: ['Agent', 'Task', 'Write', 'Edit', 'Read'],
      model: deps.model ?? 'claude-sonnet-4-6',
      cwd: deps.projectDir,
    });

    // Update registry with the revived session_id
    deps.registry.update(target, { session_id: session.session_id });
    log.info('reviveSession succeeded', { target, newSessionId: session.session_id });
    return session.session_id;
  } catch (revivalErr) {
    const revivalMsg = revivalErr instanceof Error ? revivalErr.message : String(revivalErr);
    log.error('reviveSession failed', { target, error: revivalMsg });
    throw new Error(
      `SESSION_NOT_AVAILABLE: ${target} has status 'ready' but session ` +
      `${entry.session_id ?? 'null'} is not available. Revival failed: ${revivalMsg}`,
    );
  }
}

// ---------------------------------------------------------------------------
// invoke()
// ---------------------------------------------------------------------------

export async function invoke(
  envelope: InvokeEnvelope,
  deps: InvokeDeps,
): Promise<ResponseEnvelope> {
  const start = Date.now();
  const depth = envelope.call_stack.length;
  let traceEntry: TraceEntry;

  log.info('invoking', { caller: envelope.caller, target: envelope.target, function: envelope.function, depth, traceId: envelope.trace_id });

  try {
    // 1. Cycle detection (SPEC: guardrails.checkCycle)
    const cycleResult = checkCycle(envelope.target, envelope.call_stack);
    if (!cycleResult.ok) {
      log.warn('guardrail: cycle detected', { target: envelope.target, callStack: envelope.call_stack });
      throw new Error(cycleResult.error!);
    }

    // 2. Depth limit (SPEC: guardrails.checkDepth)
    const depthResult = checkDepth(envelope.call_stack, envelope.max_depth);
    if (!depthResult.ok) {
      log.warn('guardrail: max depth exceeded', { depth, maxDepth: envelope.max_depth });
      throw new Error(depthResult.error!);
    }

    // 3. Rate limit (SPEC: guardrails.checkRateLimit — max 5 per agent/task)
    const rateLimitResult = checkRateLimit(envelope.caller, envelope.task_id, deps.rateLimitTracker);
    if (!rateLimitResult.ok) {
      log.warn('guardrail: rate limited', { caller: envelope.caller, taskId: envelope.task_id });
      throw new Error(rateLimitResult.error!);
    }

    // 4. Self-loop detection (SPEC: guardrails.checkSelfLoop — max 3 per target/trace)
    const selfLoopResult = checkSelfLoop(envelope.target, envelope.trace_id, deps.selfLoopTracker);
    if (!selfLoopResult.ok) {
      log.warn('guardrail: self-loop suspected', { target: envelope.target, traceId: envelope.trace_id });
      throw new Error(selfLoopResult.error!);
    }
    log.debug('guardrails passed', { target: envelope.target });

    // 5. Resolve target from registry
    const entry = deps.registry.get(envelope.target);
    if (!entry) {
      log.error('target not in registry', { target: envelope.target });
      throw new Error('FILE_NOT_REGISTERED');
    }
    log.debug('registry entry resolved', { target: envelope.target, status: entry.status, sessionId: entry.session_id ?? 'null' });

    // 6. Agent error status
    if (entry.status === 'error') {
      log.error('agent in error state', { target: envelope.target, error: entry.error });
      throw new Error(`AGENT_ERROR: ${entry.error}`);
    }

    // 7. Cold/stale agents must be bootstrapped before tracing — invoke never bootstraps.
    if (entry.status === 'cold' || entry.status === 'stale') {
      log.error('agent not bootstrapped', { target: envelope.target, status: entry.status });
      throw new Error(
        `REGISTRY_NOT_BOOTSTRAPPED: ${envelope.target} has status '${entry.status}'. ` +
        `Bootstrap must complete before tracing.`,
      );
    }

    let sessionId = entry.session_id;

    // 7b. SPEC line 175: 'bootstrapping' → await_ready(target)
    //     Another concurrent trace may have triggered a spawn; poll until ready.
    if (entry.status === 'bootstrapping') {
      log.info('agent bootstrapping, waiting for ready', { target: envelope.target });
      const maxWaitMs = 30_000;
      const pollIntervalMs = 500;
      let waited = 0;

      while (waited < maxWaitMs) {
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
        waited += pollIntervalMs;
        const refreshed = deps.registry.get(envelope.target);
        if (!refreshed) throw new Error('FILE_NOT_REGISTERED');
        if (refreshed.status === 'ready') {
          sessionId = refreshed.session_id;
          log.info('agent became ready after waiting', { target: envelope.target, waited: `${waited}ms`, sessionId });
          break;
        }
        if (refreshed.status === 'error') {
          log.error('agent errored while waiting for bootstrap', { target: envelope.target, error: refreshed.error });
          throw new Error(`AGENT_ERROR: ${refreshed.error}`);
        }
      }

      if (!sessionId) {
        log.error('bootstrap timeout', { target: envelope.target, waited: `${maxWaitMs}ms` });
        throw new Error('BOOTSTRAP_TIMEOUT');
      }
    }

    // 7c. Session guard: if session_id is null, the entry was loaded from persistence
    //     without a session (persistence gap — upsert fired before bootstrap set it).
    //     Revival: lazy-spawn a fresh session using the existing declarations.
    if (sessionId == null && entry.status === 'ready' && entry.declarations) {
      log.info('reviving session (session_id was null)', { target: envelope.target });
      sessionId = await reviveSession(envelope.target, entry, deps);
      log.info('session revived', { target: envelope.target, sessionId });
    }

    // 8. Build forwarded call_stack (append caller)
    const forwardedCallStack = [...envelope.call_stack, envelope.caller];

    // 9. Phase 5: Collect prior spans from trace log or infer from call_stack
    let priorSpans: TraceEntry[] = [];
    if (typeof deps.traceLog !== 'function' && typeof (deps.traceLog as any).getByTraceId === 'function') {
      // Real TraceLog instance - get actual spans
      priorSpans = (deps.traceLog as any).getByTraceId(envelope.trace_id).filter((entry: TraceEntry) => 
        entry.task_id !== envelope.task_id
      );
    } else if (envelope.call_stack.length > 0) {
      // Test environment or missing trace log - reconstruct spans from call_stack
      // Each entry in call_stack represents a prior hop
      // Try to infer function names from registry declarations
      priorSpans = envelope.call_stack.map((file, index) => {
        const fileEntry = deps.registry.get(file);
        const inferredFunction = fileEntry?.declarations?.owns[0]?.name || 'inferred';
        return {
          trace_id: envelope.trace_id,
          task_id: `inferred-${index}`,
          timestamp: new Date(),
          depth: index,
          caller: index > 0 ? envelope.call_stack[index - 1] : '__trace_initiator__',
          target: file,
          function: inferredFunction,
          params: {},
          result: undefined,
          call_stack: envelope.call_stack.slice(0, index),
        };
      });
    }

    // 10. Render structured prompt via templates (SPEC: renderInvokePrompt)
    // Phase 5: Include prior spans, expected_output, and available state
    const callerEntry = deps.registry.get(envelope.caller);

    // Build correlated dependency context from registry (fresh at invoke time)
    const correlatedDeps: CorrelatedDep[] = [];
    const targetDeps = entry.declarations?.dependencies ?? [];
    const allEntries = deps.registry.list();

    // Files this target imports from — resolve dependency paths to registry keys
    for (const depPath of targetDeps) {
      const resolvedPath = resolveDepPath(depPath, envelope.target, deps.registry);
      const depEntry = resolvedPath ? deps.registry.get(resolvedPath) : null;
      if (depEntry?.declarations) {
        correlatedDeps.push({
          path: resolvedPath!,
          relationship: 'imports',
          summary: depEntry.declarations.summary,
          exports: (depEntry.declarations.exports ?? []).map(e => ({
            name: e.name,
            kind: e.kind,
            intent: e.intent,
          })),
          imports: (depEntry.declarations.imports ?? []).map(i => ({
            name: i.name,
            from: i.from,
            kind: i.kind,
          })),
        });
      }
    }

    // Files that import this target — resolve their dependency paths to check for match
    const targetDependents = allEntries
      .filter(e => {
        if (!e.declarations?.dependencies) return false;
        return e.declarations.dependencies.some(dep =>
          resolveDepPath(dep, e.file_path, deps.registry) === envelope.target
        );
      })
      .map(e => e.file_path);
    for (const depPath of targetDependents) {
      const depEntry = deps.registry.get(depPath);
      if (depEntry?.declarations) {
        correlatedDeps.push({
          path: depPath,
          relationship: 'imported_by',
          summary: depEntry.declarations.summary,
          exports: (depEntry.declarations.exports ?? []).map(e => ({
            name: e.name,
            kind: e.kind,
            intent: e.intent,
          })),
          imports: (depEntry.declarations.imports ?? []).map(i => ({
            name: i.name,
            from: i.from,
            kind: i.kind,
          })),
        });
      }
    }

    log.debug('rendering invoke prompt', { target: envelope.target, correlatedDeps: correlatedDeps.length, priorSpans: priorSpans.length });

    const prompt = renderInvokePrompt({
      envelope: {
        task_id: envelope.task_id,
        target: envelope.target,
        function: envelope.function,
        params: envelope.params,
        call_stack: forwardedCallStack,
        caller: envelope.caller,
        expected_output: envelope.expected_output,
        notes: envelope.notes,
        trace_id: envelope.trace_id,
        max_depth: envelope.max_depth,
      },
      callerDeclarations: callerEntry?.declarations ?? undefined,
      correlatedDeps: correlatedDeps.length > 0 ? correlatedDeps : undefined,
      // Keep targetDependencies as fallback when no correlated data available
      targetDependencies: correlatedDeps.length === 0 && (targetDeps.length > 0 || targetDependents.length > 0)
        ? { dependencies: targetDeps, dependents: targetDependents }
        : undefined,
      priorSpans,
      syntheticState: deps.syntheticState,
    });

    // Verbose: log the prompt being sent to the agent
    if (deps.onVerbose) {
      deps.onVerbose({
        type: 'invoke_prompt',
        target: envelope.target,
        function: envelope.function,
        caller: envelope.caller,
        depth,
        sessionId: sessionId!,
        prompt,
      });
    }

    // 10b. Store invoke context for child invocations.
    if (deps.invokeContexts) {
      deps.invokeContexts.set(envelope.task_id, {
        trace_id: envelope.trace_id,
        caller: envelope.target,
        call_stack: forwardedCallStack,
        max_depth: envelope.max_depth,
      });
    }

    // 11. Forward to agent session via SDK with retry on validation failure
    log.info('forwarding to session', { target: envelope.target, sessionId: sessionId! });
    let response: ResponseEnvelope | undefined;
    let validationError: string | null = null;
    const maxRetries = 2;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // Build prompt with validation error feedback on retry
      const retryPrompt = attempt > 0 && validationError
        ? `${prompt}\n\n## Validation Error\nYour previous response was rejected:\n${validationError}\n\nPlease fix the issue and respond again. Remember: source_refs is MANDATORY and must be a non-empty array.`
        : prompt;

      // UNIFIED PATH: ONLY use invokeOnSession
      // This satisfies both Contract 4 (must use invokeOnSession) and streaming tests (supports onProgress)
      const mcpConfig = getMcpConfig(deps.intPort);
      const invokeOpts = {
        sessionId: sessionId!,
        prompt: retryPrompt,
        taskId: envelope.task_id,
        tools: mcpConfig.invokeTools,
        // Block all built-in tools — agents must use ONLY MCP tools during trace
        ...(deps.intPort && { disallowedTools: ['Agent', 'Task', 'Bash', 'Read', 'Write', 'Edit', 'Glob', 'Grep', 'LS'] }),
        forkSession: true,
        cwd: deps.projectDir,
        ...(mcpConfig.mcpServers && { mcpServers: mcpConfig.mcpServers }),
        onProgress: deps.onProgress ? (event: { type: 'progress'; content: string }) => {
          deps.onProgress!({
            type: 'progress',
            target: envelope.target,
            trace_id: envelope.trace_id,
            depth,
            content: event.content,
          });
        } : undefined,
      };

      try {
        response = await deps.sessionManager.invokeOnSession(invokeOpts);
      } catch (invokeErr) {
        // 7d. Stale session revival: if invokeOnSession throws "Session not found"
        //     for a non-null session_id, the session died (server restart).
        //     Try to revive and retry once.
        const errMsg = invokeErr instanceof Error ? invokeErr.message : String(invokeErr);
        if (/Session not found/i.test(errMsg) && entry.status === 'ready' && entry.declarations) {
          log.warn('stale session detected, reviving', { target: envelope.target, oldSessionId: sessionId });
          sessionId = await reviveSession(envelope.target, entry, deps);
          log.info('session revived, retrying invoke', { target: envelope.target, newSessionId: sessionId });
          invokeOpts.sessionId = sessionId;
          response = await deps.sessionManager.invokeOnSession(invokeOpts);
        } else {
          throw invokeErr;
        }
      }

      // Validate response envelope
      const validation = validateResponseEnvelope(response as unknown as Record<string, unknown>);
      if (validation.valid) {
        // Success - break retry loop
        validationError = null;
        break;
      }

      // Validation failed
      validationError = validation.errors.join('; ');
      
      if (attempt === maxRetries) {
        log.error('response validation failed after retries', { target: envelope.target, attempts: maxRetries + 1, errors: validationError });
        throw new Error(`INVALID_RESPONSE_ENVELOPE: ${validationError}`);
      }
      
      log.warn('response validation failed, retrying', { target: envelope.target, attempt: attempt + 1, errors: validationError });
    }

    if (!response) {
      throw new Error('No response received from agent');
    }

    // Clean up invoke context
    if (deps.invokeContexts) {
      deps.invokeContexts.delete(envelope.task_id);
    }

    // Verbose: log the agent's response
    if (deps.onVerbose) {
      deps.onVerbose({
        type: 'invoke_response',
        target: envelope.target,
        function: envelope.function,
        returns: response.returns,
        source_refs: response.source_refs,
        mutations: response.mutations,
        error: response.error,
        duration_ms: Date.now() - start,
      });
    }

    // 12. Log trace entry (success)
    const elapsed = Date.now() - start;
    const refsCount = response.source_refs?.length ?? 0;
    log.info('invoke completed', {
      target: envelope.target,
      function: envelope.function,
      elapsed: `${elapsed}ms`,
      refs: refsCount,
      error: response.error || undefined,
    });

    traceEntry = {
      trace_id: envelope.trace_id,
      task_id: envelope.task_id,
      timestamp: new Date(),
      depth,
      caller: envelope.caller,
      target: envelope.target,
      function: envelope.function,
      params: envelope.params,
      result: response.returns,
      mutations: response.mutations,
      source_refs: response.source_refs,
      duration_ms: Date.now() - start,
      call_stack: envelope.call_stack,
    };
    
    if (typeof deps.traceLog === 'function') {
      deps.traceLog(traceEntry);
    } else {
      deps.traceLog.add(traceEntry);
    }

    return response;
  } catch (err) {
    // Clean up invoke context on error
    if (deps.invokeContexts) {
      deps.invokeContexts.delete(envelope.task_id);
    }
    // Log trace entry on failure
    const errorMessage = err instanceof Error ? err.message : String(err);
    log.error('invoke failed', {
      target: envelope.target,
      function: envelope.function,
      elapsed: `${Date.now() - start}ms`,
      error: errorMessage,
    });

    traceEntry = {
      trace_id: envelope.trace_id,
      task_id: envelope.task_id,
      timestamp: new Date(),
      depth,
      caller: envelope.caller,
      target: envelope.target,
      function: envelope.function,
      params: envelope.params,
      duration_ms: Date.now() - start,
      error: errorMessage,
      call_stack: envelope.call_stack,
    };
    
    if (typeof deps.traceLog === 'function') {
      deps.traceLog(traceEntry);
    } else {
      deps.traceLog.add(traceEntry);
    }

    throw err;
  }
}
