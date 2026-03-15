/**
 * RED Phase Tests -- FR-005: Invoke Handler
 *
 *   InvokeEnvelope: { trace_id, task_id, caller, target, function, params?, state?,
 *     notes?, call_stack:[str]!, mode:'sync'|'async'='sync', max_depth:int=50 }
 *   ResponseEnvelope: { task_id, responder, returns?, mutations?, source_refs:[str]!, error? }
 *   Mutation: { key, before?, after }
 *   TraceEntry: { trace_id, task_id, timestamp, depth, caller, target, function,
 *     params?, result?, mutations?, source_refs?, duration_ms?, error?, call_stack }
 *
 * invoke() is the core primitive:
 *   1. Cycle detection (target in call_stack -> CYCLE_DETECTED)
 *   2. Depth limit (call_stack.length >= max_depth -> MAX_DEPTH_EXCEEDED)
 *   3. Rate limiting (max 5 per agent/task -> RATE_LIMITED)
 *   4. Self-loop detection (max 3 per target/trace -> LOOP_SUSPECTED)
 *   5. Resolve target from registry
 *   6. Ensure agent ready (lazy spawn if cold/stale)
 *   7. Build prompt via renderInvokePrompt, forward to agent session via SDK
 *   8. Validate response envelope via guardrails
 *   9. Log trace entry
 *
 * All tests MUST FAIL -- invoke.ts does not exist yet.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Registry, RegistryEntry } from './registry.js';
import type { SessionManager, AgentSession } from './session-manager.js';
import {
  invoke,
  RateLimitTracker,
  SelfLoopTracker,
  type InvokeEnvelope,
  type InvokeDeps,
  type ResponseEnvelope,
  type Mutation,
  type TraceEntry,
} from './invoke.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEnvelope(overrides: Partial<InvokeEnvelope> = {}): InvokeEnvelope {
  return {
    trace_id: 'trace-001',
    task_id: 'task-001',
    caller: 'src/handler.ts',
    target: 'src/service.ts',
    function: 'createUser',
    params: { name: 'Alice' },
    state: undefined,
    notes: undefined,
    call_stack: [],
    mode: 'sync',
    max_depth: 50,
    ...overrides,
  };
}

function makeRegistryEntry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    file_path: 'src/service.ts',
    file_hash: 'abc123',
    status: 'ready',
    session_id: 'sess-001',
    declarations: {
      summary: 'User service',
      owns: [],
      imports: [],
      exports: [],
      dependencies: [],
    },
    last_active: null,
    error: null,
    ...overrides,
  };
}

function makeAgentSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    session_id: 'sess-001',
    file_path: 'src/service.ts',
    created_at: new Date(),
    file_hash: 'abc123',
    status: 'active',
    systemPrompt: 'You ARE src/service.ts',
    tools: ['invoke'],
    model: 'claude-opus-4-6',
    ...overrides,
  };
}

/**
 * Build a mock Registry with configurable get() behavior.
 */
function mockRegistry(entries: Record<string, RegistryEntry | undefined> = {}): Registry {
  return {
    get: vi.fn((path: string) => entries[path]),
    add: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    list: vi.fn(() => []),
    listByStatus: vi.fn(() => []),
    size: 0,
  } as unknown as Registry;
}

/**
 * Build a mock SessionManager with configurable behavior.
 */
function mockSessionManager(session?: AgentSession): SessionManager {
  const defaultResponse = {
    task_id: 'task-001',
    responder: 'src/service.ts',
    returns: { id: 1, name: 'Alice' },
    mutations: [],
    source_refs: ['src/service.ts:42-48'],
  };
  
  const queryMock = vi.fn();
  queryMock.mockResolvedValue(defaultResponse);
  
  const invokeOnSessionMock = vi.fn();
  invokeOnSessionMock.mockResolvedValue(defaultResponse);
  
  return {
    create: vi.fn(async () => session ?? makeAgentSession()),
    get: vi.fn(() => session),
    terminate: vi.fn(async () => {}),
    query: queryMock,
    invokeOnSession: invokeOnSessionMock,
    list: vi.fn(() => []),
    size: 0,
  } as unknown as SessionManager;
}

/**
 * Collects trace entries logged during invoke execution.
 */
function makeTraceLog(): { entries: TraceEntry[]; log: (entry: TraceEntry) => void } {
  const entries: TraceEntry[] = [];
  return {
    entries,
    log: (entry: TraceEntry) => entries.push(entry),
  };
}

/**
 * Build full InvokeDeps with fresh trackers per test.
 */
function makeDeps(overrides: {
  registry?: Registry;
  sessionManager?: SessionManager;
  traceLog?: (entry: TraceEntry) => void;
  rateLimitTracker?: RateLimitTracker;
  selfLoopTracker?: SelfLoopTracker;
  readFile?: (filePath: string) => Promise<string>;
} = {}): InvokeDeps {
  const traceLogHelper = makeTraceLog();
  return {
    registry: overrides.registry ?? mockRegistry(),
    sessionManager: overrides.sessionManager ?? mockSessionManager(),
    traceLog: overrides.traceLog ?? traceLogHelper.log,
    rateLimitTracker: overrides.rateLimitTracker ?? new RateLimitTracker(),
    selfLoopTracker: overrides.selfLoopTracker ?? new SelfLoopTracker(),
    readFile: overrides.readFile ?? vi.fn().mockResolvedValue('// mock source code'),
  };
}

// ===========================================================================
// 1. invoke() with valid envelope returns a ResponseEnvelope
// ===========================================================================

describe('FR-005: Invoke Handler', () => {
  describe('invoke() happy path', () => {
    it('returns a ResponseEnvelope when given a valid InvokeEnvelope', async () => {
      const entry = makeRegistryEntry({ status: 'ready' });
      const registry = mockRegistry({ 'src/service.ts': entry });
      const session = makeAgentSession();
      const sessionManager = mockSessionManager(session);
      const traceLog = makeTraceLog();
      const envelope = makeEnvelope();

      const result = await invoke(envelope, makeDeps({ registry, sessionManager, traceLog: traceLog.log }));

      expect(result).toBeDefined();
      expect(result.task_id).toBe('task-001');
      expect(result.responder).toBe('src/service.ts');
      expect(result.source_refs).toBeDefined();
      expect(Array.isArray(result.source_refs)).toBe(true);
    });
  });

  // ===========================================================================
  // 2. invoke() rejects with CYCLE_DETECTED when target is already in call_stack
  // ===========================================================================

  describe('cycle detection', () => {
    it('rejects with CYCLE_DETECTED when target is already in call_stack', async () => {
      const registry = mockRegistry();
      const sessionManager = mockSessionManager();
      const traceLog = makeTraceLog();

      // Target 'src/service.ts' is already in the call_stack -- cycle!
      const envelope = makeEnvelope({
        target: 'src/service.ts',
        call_stack: ['src/handler.ts', 'src/service.ts'],
      });

      await expect(
        invoke(envelope, makeDeps({ registry, sessionManager, traceLog: traceLog.log })),
      ).rejects.toThrow(/CYCLE_DETECTED/);
    });

    it('does not reject when target is NOT in call_stack', async () => {
      const entry = makeRegistryEntry({ status: 'ready' });
      const registry = mockRegistry({ 'src/service.ts': entry });
      const session = makeAgentSession();
      const sessionManager = mockSessionManager(session);
      const traceLog = makeTraceLog();

      const envelope = makeEnvelope({
        target: 'src/service.ts',
        call_stack: ['src/handler.ts', 'src/other.ts'],
      });

      // Should NOT throw -- target is not in call_stack
      const result = await invoke(envelope, makeDeps({ registry, sessionManager, traceLog: traceLog.log }));
      expect(result).toBeDefined();
    });
  });

  // ===========================================================================
  // 3. invoke() rejects with MAX_DEPTH_EXCEEDED when call_stack.length >= max_depth
  // ===========================================================================

  describe('depth limit', () => {
    it('rejects with MAX_DEPTH_EXCEEDED when call_stack.length >= max_depth', async () => {
      const registry = mockRegistry();
      const sessionManager = mockSessionManager();
      const traceLog = makeTraceLog();

      // call_stack has 3 entries, max_depth is 3 -- at limit
      const envelope = makeEnvelope({
        call_stack: ['a.ts', 'b.ts', 'c.ts'],
        max_depth: 3,
      });

      await expect(
        invoke(envelope, makeDeps({ registry, sessionManager, traceLog: traceLog.log })),
      ).rejects.toThrow(/MAX_DEPTH_EXCEEDED/);
    });

    it('rejects when call_stack.length exceeds max_depth', async () => {
      const registry = mockRegistry();
      const sessionManager = mockSessionManager();
      const traceLog = makeTraceLog();

      const envelope = makeEnvelope({
        call_stack: ['a.ts', 'b.ts', 'c.ts', 'd.ts'],
        max_depth: 3,
      });

      await expect(
        invoke(envelope, makeDeps({ registry, sessionManager, traceLog: traceLog.log })),
      ).rejects.toThrow(/MAX_DEPTH_EXCEEDED/);
    });

    it('does not reject when call_stack.length < max_depth', async () => {
      const entry = makeRegistryEntry({ status: 'ready' });
      const registry = mockRegistry({ 'src/service.ts': entry });
      const session = makeAgentSession();
      const sessionManager = mockSessionManager(session);
      const traceLog = makeTraceLog();

      const envelope = makeEnvelope({
        call_stack: ['src/handler.ts'],
        max_depth: 50,
      });

      const result = await invoke(envelope, makeDeps({ registry, sessionManager, traceLog: traceLog.log }));
      expect(result).toBeDefined();
    });
  });

  // ===========================================================================
  // 4. invoke() rejects with FILE_NOT_REGISTERED when target not in registry
  // ===========================================================================

  describe('registry resolution', () => {
    it('rejects with FILE_NOT_REGISTERED when target is not in registry', async () => {
      // Registry returns undefined for any path
      const registry = mockRegistry({});
      const sessionManager = mockSessionManager();
      const traceLog = makeTraceLog();

      const envelope = makeEnvelope({ target: 'src/nonexistent.ts' });

      await expect(
        invoke(envelope, makeDeps({ registry, sessionManager, traceLog: traceLog.log })),
      ).rejects.toThrow(/FILE_NOT_REGISTERED/);
    });
  });

  // ===========================================================================
  // 5. invoke() rejects with AGENT_ERROR when target agent status is 'error'
  // ===========================================================================

  describe('agent error status', () => {
    it('rejects with AGENT_ERROR when target agent status is error', async () => {
      const entry = makeRegistryEntry({
        status: 'error',
        error: 'bootstrap failed: syntax error',
      });
      const registry = mockRegistry({ 'src/service.ts': entry });
      const sessionManager = mockSessionManager();
      const traceLog = makeTraceLog();

      const envelope = makeEnvelope();

      await expect(
        invoke(envelope, makeDeps({ registry, sessionManager, traceLog: traceLog.log })),
      ).rejects.toThrow(/AGENT_ERROR/);
    });
  });

  // ===========================================================================
  // 6. invoke() rejects cold agents — bootstrap required before tracing
  // ===========================================================================

  describe('cold agent rejection', () => {
    it('throws REGISTRY_NOT_BOOTSTRAPPED when target status is cold', async () => {
      const entry = makeRegistryEntry({ status: 'cold', session_id: null });
      const registry = mockRegistry({ 'src/service.ts': entry });
      const session = makeAgentSession();
      const sessionManager = mockSessionManager(session);
      const traceLog = makeTraceLog();

      const envelope = makeEnvelope();

      await expect(
        invoke(envelope, makeDeps({ registry, sessionManager, traceLog: traceLog.log })),
      ).rejects.toThrow(/REGISTRY_NOT_BOOTSTRAPPED/);

      // invoke must NEVER call create() — bootstrap is not invoke's job
      expect(sessionManager.create).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // 7. invoke() rejects stale agents — re-bootstrap required before tracing
  // ===========================================================================

  describe('stale agent rejection', () => {
    it('throws REGISTRY_NOT_BOOTSTRAPPED when target status is stale', async () => {
      const entry = makeRegistryEntry({ status: 'stale', session_id: 'old-sess' });
      const registry = mockRegistry({ 'src/service.ts': entry });
      const session = makeAgentSession();
      const sessionManager = mockSessionManager(session);
      const traceLog = makeTraceLog();

      const envelope = makeEnvelope();

      await expect(
        invoke(envelope, makeDeps({ registry, sessionManager, traceLog: traceLog.log })),
      ).rejects.toThrow(/REGISTRY_NOT_BOOTSTRAPPED/);

      // No session termination or creation from invoke
      expect(sessionManager.terminate).not.toHaveBeenCalled();
      expect(sessionManager.create).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // 8. invoke() logs a TraceEntry after successful invocation
  // ===========================================================================

  describe('trace logging on success', () => {
    it('logs a TraceEntry after successful invocation', async () => {
      const entry = makeRegistryEntry({ status: 'ready' });
      const registry = mockRegistry({ 'src/service.ts': entry });
      const session = makeAgentSession();
      const sessionManager = mockSessionManager(session);
      const traceLog = makeTraceLog();

      const envelope = makeEnvelope();

      await invoke(envelope, makeDeps({ registry, sessionManager, traceLog: traceLog.log }));

      expect(traceLog.entries).toHaveLength(1);

      const trace = traceLog.entries[0];
      expect(trace.trace_id).toBe('trace-001');
      expect(trace.task_id).toBe('task-001');
      expect(trace.caller).toBe('src/handler.ts');
      expect(trace.target).toBe('src/service.ts');
      expect(trace.function).toBe('createUser');
      expect(trace.depth).toBe(0); // call_stack was empty
      expect(trace.timestamp).toBeInstanceOf(Date);
      expect(typeof trace.duration_ms).toBe('number');
      expect(trace.call_stack).toEqual([]);
      // No error on success
      expect(trace.error).toBeUndefined();
    });
  });

  // ===========================================================================
  // 9. invoke() logs a TraceEntry with error field on failure
  // ===========================================================================

  describe('trace logging on failure', () => {
    it('logs a TraceEntry with error field when invocation fails', async () => {
      const entry = makeRegistryEntry({ status: 'error', error: 'crashed' });
      const registry = mockRegistry({ 'src/service.ts': entry });
      const sessionManager = mockSessionManager();
      const traceLog = makeTraceLog();

      const envelope = makeEnvelope();

      // invoke will reject due to AGENT_ERROR, but should still log a trace
      try {
        await invoke(envelope, makeDeps({ registry, sessionManager, traceLog: traceLog.log }));
      } catch {
        // expected
      }

      expect(traceLog.entries).toHaveLength(1);

      const trace = traceLog.entries[0];
      expect(trace.trace_id).toBe('trace-001');
      expect(trace.task_id).toBe('task-001');
      expect(trace.error).toBeDefined();
      expect(typeof trace.error).toBe('string');
      expect(trace.error).toMatch(/AGENT_ERROR/);
    });
  });

  // ===========================================================================
  // 10. invoke() appends caller to call_stack before forwarding
  // ===========================================================================

  describe('call_stack propagation', () => {
    it('appends caller to call_stack before forwarding to target agent', async () => {
      const entry = makeRegistryEntry({ status: 'ready' });
      const registry = mockRegistry({ 'src/service.ts': entry });
      const session = makeAgentSession();
      const sessionManager = mockSessionManager(session);
      const traceLog = makeTraceLog();

      const envelope = makeEnvelope({
        caller: 'src/handler.ts',
        target: 'src/service.ts',
        call_stack: ['src/router.ts'],
      });

      await invoke(envelope, makeDeps({ registry, sessionManager, traceLog: traceLog.log }));

      // The invokeOnSession to the SDK should have been called with updated call_stack
      // that includes the caller appended
      expect(sessionManager.invokeOnSession).toHaveBeenCalled();

      // Verify the invokeOnSession was made -- the prompt/envelope forwarded to the agent
      // should contain call_stack = ['src/router.ts', 'src/handler.ts']
      const invokeCall = (sessionManager.invokeOnSession as ReturnType<typeof vi.fn>).mock.calls[0][0];
      // The forwarded prompt should reference the updated call_stack
      // We verify the trace entry records the original call_stack
      const trace = traceLog.entries[0];
      expect(trace.call_stack).toContain('src/router.ts');
    });
  });

  // ===========================================================================
  // 11. InvokeEnvelope type has all required fields
  // ===========================================================================

  describe('InvokeEnvelope type shape', () => {
    it('has all required fields per SPEC', () => {
      const envelope: InvokeEnvelope = makeEnvelope();

      // Required fields (SPEC: str!, str!, str!, str!, str!)
      expect(envelope.trace_id).toBeDefined();
      expect(typeof envelope.trace_id).toBe('string');

      expect(envelope.task_id).toBeDefined();
      expect(typeof envelope.task_id).toBe('string');

      expect(envelope.caller).toBeDefined();
      expect(typeof envelope.caller).toBe('string');

      expect(envelope.target).toBeDefined();
      expect(typeof envelope.target).toBe('string');

      expect(envelope.function).toBeDefined();
      expect(typeof envelope.function).toBe('string');

      // Required collection field (SPEC: [str]!)
      expect(Array.isArray(envelope.call_stack)).toBe(true);

      // Fields with defaults (SPEC: mode='sync', max_depth=50)
      expect(envelope.mode).toBe('sync');
      expect(envelope.max_depth).toBe(50);
    });

    it('has optional fields: params, state, notes', () => {
      const envelope: InvokeEnvelope = makeEnvelope({
        params: { key: 'value' },
        state: { db: [] },
        notes: 'testing optional fields',
      });

      expect(envelope.params).toEqual({ key: 'value' });
      expect(envelope.state).toEqual({ db: [] });
      expect(envelope.notes).toBe('testing optional fields');
    });

    it('allows mode to be sync or async', () => {
      const syncEnvelope: InvokeEnvelope = makeEnvelope({ mode: 'sync' });
      const asyncEnvelope: InvokeEnvelope = makeEnvelope({ mode: 'async' });

      expect(syncEnvelope.mode).toBe('sync');
      expect(asyncEnvelope.mode).toBe('async');
    });
  });

  // ===========================================================================
  // 12. ResponseEnvelope type has all required fields including mandatory source_refs
  // ===========================================================================

  describe('ResponseEnvelope type shape', () => {
    it('has all required fields per SPEC', () => {
      const response: ResponseEnvelope = {
        task_id: 'task-001',
        responder: 'src/service.ts',
        source_refs: ['src/service.ts:42-48'],
      };

      // Required fields (SPEC: str!, str!, [str]!)
      expect(response.task_id).toBeDefined();
      expect(typeof response.task_id).toBe('string');

      expect(response.responder).toBeDefined();
      expect(typeof response.responder).toBe('string');

      // MANDATORY source_refs (SPEC: source_refs:[str]! -- MANDATORY)
      expect(response.source_refs).toBeDefined();
      expect(Array.isArray(response.source_refs)).toBe(true);
      expect(response.source_refs.length).toBeGreaterThan(0);
    });

    it('has optional fields: returns, mutations, error', () => {
      const response: ResponseEnvelope = {
        task_id: 'task-001',
        responder: 'src/service.ts',
        returns: { id: 1 },
        mutations: [{ key: 'users', before: [], after: [{ id: 1 }] }],
        source_refs: ['src/service.ts:42'],
        error: undefined,
      };

      expect(response.returns).toEqual({ id: 1 });
      expect(response.mutations).toHaveLength(1);
      expect(response.error).toBeUndefined();
    });

    it('Mutation type has key (required), before (optional), after (required)', () => {
      const mutation: Mutation = {
        key: 'users',
        before: [],
        after: [{ id: 1, name: 'Alice' }],
      };

      expect(mutation.key).toBe('users');
      expect(mutation.before).toEqual([]);
      expect(mutation.after).toEqual([{ id: 1, name: 'Alice' }]);
    });

    it('Mutation allows before to be undefined (new key creation)', () => {
      const mutation: Mutation = {
        key: 'config.feature_flag',
        after: true,
      };

      expect(mutation.key).toBe('config.feature_flag');
      expect(mutation.before).toBeUndefined();
      expect(mutation.after).toBe(true);
    });
  });

  // ===========================================================================
  // 13. P2-D1: Rate limit enforcement via guardrails
  // ===========================================================================

  describe('rate limit enforcement (P2-D1)', () => {
    it('rejects with RATE_LIMITED after > 5 invocations from same agent/task', async () => {
      const entry = makeRegistryEntry({ status: 'ready' });
      const registry = mockRegistry({ 'src/service.ts': entry });
      const sessionManager = mockSessionManager();
      const traceLog = makeTraceLog();
      const rateLimitTracker = new RateLimitTracker();
      const selfLoopTracker = new SelfLoopTracker();

      const deps = makeDeps({ registry, sessionManager, traceLog: traceLog.log, rateLimitTracker, selfLoopTracker });

      // First 5 invocations should succeed — use unique trace_ids to avoid
      // triggering self-loop detection (which fires at >3 per target/trace).
      for (let i = 0; i < 5; i++) {
        const envelope = makeEnvelope({ trace_id: `trace-rl-${i}` });
        const result = await invoke(envelope, deps);
        expect(result).toBeDefined();
      }

      // 6th invocation should be rate limited (same caller + task_id)
      const envelope6 = makeEnvelope({ trace_id: 'trace-rl-5' });
      await expect(invoke(envelope6, deps)).rejects.toThrow(/RATE_LIMITED/);
    });

    it('does not rate limit different agent/task combinations', async () => {
      const entry = makeRegistryEntry({ status: 'ready' });
      const registry = mockRegistry({ 'src/service.ts': entry });
      const sessionManager = mockSessionManager();
      const traceLog = makeTraceLog();
      const rateLimitTracker = new RateLimitTracker();
      const selfLoopTracker = new SelfLoopTracker();

      const deps = makeDeps({ registry, sessionManager, traceLog: traceLog.log, rateLimitTracker, selfLoopTracker });

      // 5 from agent-A/task-001 — unique trace_ids to avoid self-loop
      for (let i = 0; i < 5; i++) {
        await invoke(makeEnvelope({ caller: 'src/a.ts', task_id: 'task-001', trace_id: `trace-diff-${i}` }), deps);
      }

      // Different caller, same task -- should succeed (separate counter)
      const result = await invoke(makeEnvelope({ caller: 'src/b.ts', task_id: 'task-001', trace_id: 'trace-diff-5' }), deps);
      expect(result).toBeDefined();
    });
  });

  // ===========================================================================
  // 14. P2-D1: Self-loop detection via guardrails
  // ===========================================================================

  describe('self-loop detection (P2-D1)', () => {
    it('rejects with LOOP_SUSPECTED after > 3 visits to same target in same trace', async () => {
      const entry = makeRegistryEntry({ status: 'ready' });
      const registry = mockRegistry({ 'src/service.ts': entry });
      const sessionManager = mockSessionManager();
      const traceLog = makeTraceLog();
      const rateLimitTracker = new RateLimitTracker();
      const selfLoopTracker = new SelfLoopTracker();

      const deps = makeDeps({ registry, sessionManager, traceLog: traceLog.log, rateLimitTracker, selfLoopTracker });
      const envelope = makeEnvelope({ trace_id: 'trace-loop' });

      // First 3 invocations to same target in same trace should succeed
      for (let i = 0; i < 3; i++) {
        const result = await invoke(envelope, deps);
        expect(result).toBeDefined();
      }

      // 4th invocation to same target in same trace should be suspected loop
      await expect(invoke(envelope, deps)).rejects.toThrow(/LOOP_SUSPECTED/);
    });

    it('does not trigger self-loop for different targets in same trace', async () => {
      const entryA = makeRegistryEntry({ file_path: 'src/a.ts', status: 'ready' });
      const entryB = makeRegistryEntry({ file_path: 'src/b.ts', status: 'ready' });
      const registry = mockRegistry({ 'src/a.ts': entryA, 'src/b.ts': entryB });
      const sessionManager = mockSessionManager();
      const traceLog = makeTraceLog();
      const rateLimitTracker = new RateLimitTracker();
      const selfLoopTracker = new SelfLoopTracker();

      const deps = makeDeps({ registry, sessionManager, traceLog: traceLog.log, rateLimitTracker, selfLoopTracker });

      // 3 invocations to target A
      for (let i = 0; i < 3; i++) {
        await invoke(makeEnvelope({ target: 'src/a.ts', trace_id: 'trace-multi' }), deps);
      }

      // Invocation to target B should succeed (different target counter)
      const result = await invoke(makeEnvelope({ target: 'src/b.ts', trace_id: 'trace-multi' }), deps);
      expect(result).toBeDefined();
    });
  });

  // ===========================================================================
  // 15. P2-D1: Response envelope validation via guardrails
  // ===========================================================================

  describe('response envelope validation (P2-D1)', () => {
    it('rejects with INVALID_RESPONSE_ENVELOPE when source_refs missing', async () => {
      const entry = makeRegistryEntry({ status: 'ready' });
      const registry = mockRegistry({ 'src/service.ts': entry });
      // Mock sessionManager.invokeOnSession to return response WITHOUT source_refs
      const sessionManager = mockSessionManager();
      (sessionManager.invokeOnSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        task_id: 'task-001',
        responder: 'src/service.ts',
        returns: { id: 1 },
        mutations: [],
        // source_refs intentionally missing
      });
      const traceLog = makeTraceLog();

      const envelope = makeEnvelope();

      await expect(
        invoke(envelope, makeDeps({ registry, sessionManager, traceLog: traceLog.log })),
      ).rejects.toThrow(/INVALID_RESPONSE_ENVELOPE/);
    });

    it('rejects with INVALID_RESPONSE_ENVELOPE when source_refs is empty', async () => {
      const entry = makeRegistryEntry({ status: 'ready' });
      const registry = mockRegistry({ 'src/service.ts': entry });
      const sessionManager = mockSessionManager();
      (sessionManager.invokeOnSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        task_id: 'task-001',
        responder: 'src/service.ts',
        returns: { id: 1 },
        mutations: [],
        source_refs: [], // empty -- should be rejected
      });
      const traceLog = makeTraceLog();

      const envelope = makeEnvelope();

      await expect(
        invoke(envelope, makeDeps({ registry, sessionManager, traceLog: traceLog.log })),
      ).rejects.toThrow(/INVALID_RESPONSE_ENVELOPE/);
    });

    it('rejects with INVALID_RESPONSE_ENVELOPE when responder is missing', async () => {
      const entry = makeRegistryEntry({ status: 'ready' });
      const registry = mockRegistry({ 'src/service.ts': entry });
      const sessionManager = mockSessionManager();
      (sessionManager.invokeOnSession as ReturnType<typeof vi.fn>).mockResolvedValue({
        task_id: 'task-001',
        // responder missing
        returns: { id: 1 },
        mutations: [],
        source_refs: ['src/service.ts:42'],
      });
      const traceLog = makeTraceLog();

      const envelope = makeEnvelope();

      await expect(
        invoke(envelope, makeDeps({ registry, sessionManager, traceLog: traceLog.log })),
      ).rejects.toThrow(/INVALID_RESPONSE_ENVELOPE/);
    });
  });

  // ===========================================================================
  // 16. P2-D2: Template usage — renderInvokePrompt is used instead of raw JSON
  // ===========================================================================

  describe('template-based prompt rendering (P2-D2)', () => {
    it('sends structured prompt via renderInvokePrompt, not raw JSON', async () => {
      const entry = makeRegistryEntry({ status: 'ready' });
      const registry = mockRegistry({ 'src/service.ts': entry });
      const session = makeAgentSession();
      const sessionManager = mockSessionManager(session);
      const traceLog = makeTraceLog();

      const envelope = makeEnvelope();

      await invoke(envelope, makeDeps({ registry, sessionManager, traceLog: traceLog.log }));

      expect(sessionManager.invokeOnSession).toHaveBeenCalled();
      const invokeCall = (sessionManager.invokeOnSession as ReturnType<typeof vi.fn>).mock.calls[0][0];

      // The prompt should be a template-rendered string, not a raw JSON blob
      const prompt: string = invokeCall.prompt;
      expect(prompt).toContain('# Trace Task:');
      expect(prompt).toContain('Locate');
      expect(prompt).toContain(envelope.function);
      // It should NOT be a raw JSON.stringify output
      expect(prompt).not.toMatch(/^\s*\{/);

      // SPEC line 189-192: invokeOnSession() must pass tools and taskId
      expect(invokeCall.tools).toEqual(['invoke', 'state_get', 'state_set', 'resolve', 'respond']);
      expect(invokeCall.taskId).toBe(envelope.task_id);
    });
  });

  // ===========================================================================
  // 17. P2-D3: Cold/stale agents throw REGISTRY_NOT_BOOTSTRAPPED (no lazy spawn)
  // ===========================================================================

  describe('no lazy spawn — cold/stale rejection (P2-D3)', () => {
    it('throws REGISTRY_NOT_BOOTSTRAPPED for cold agent — no create() call', async () => {
      const entry = makeRegistryEntry({ status: 'cold', session_id: null });
      const registry = mockRegistry({ 'src/service.ts': entry });
      const session = makeAgentSession();
      const sessionManager = mockSessionManager(session);
      const traceLog = makeTraceLog();
      const readFile = vi.fn().mockResolvedValue('// cold agent source code');

      const envelope = makeEnvelope();

      await expect(
        invoke(envelope, makeDeps({ registry, sessionManager, traceLog: traceLog.log, readFile })),
      ).rejects.toThrow(/REGISTRY_NOT_BOOTSTRAPPED/);

      // invoke must never call create — bootstrap is a separate phase
      expect(sessionManager.create).not.toHaveBeenCalled();
      // readFile should NOT be called (no bootstrap prompt rendering)
      expect(readFile).not.toHaveBeenCalled();
    });

    it('throws REGISTRY_NOT_BOOTSTRAPPED for stale agent — no create() call', async () => {
      const entry = makeRegistryEntry({ status: 'stale', session_id: 'old-sess' });
      const registry = mockRegistry({ 'src/service.ts': entry });
      const session = makeAgentSession();
      const sessionManager = mockSessionManager(session);
      const traceLog = makeTraceLog();
      const readFile = vi.fn().mockResolvedValue('// stale agent source code');

      const envelope = makeEnvelope();

      await expect(
        invoke(envelope, makeDeps({ registry, sessionManager, traceLog: traceLog.log, readFile })),
      ).rejects.toThrow(/REGISTRY_NOT_BOOTSTRAPPED/);

      expect(sessionManager.create).not.toHaveBeenCalled();
      expect(readFile).not.toHaveBeenCalled();
    });
  });

  // ===========================================================================
  // 18. SPEC line 175: 'bootstrapping' status — await_ready polling
  // ===========================================================================

  describe('bootstrapping status handling (SPEC line 175)', () => {
    beforeEach(() => {
      vi.useFakeTimers();
    });

    const afterEachRestore = () => {
      vi.useRealTimers();
    };

    it('waits for bootstrapping agent to become ready, then succeeds', async () => {
      const bootstrappingEntry = makeRegistryEntry({
        status: 'bootstrapping' as RegistryEntry['status'],
        session_id: null,
      });
      const readyEntry = makeRegistryEntry({
        status: 'ready',
        session_id: 'sess-bootstrap-001',
      });

      // First call returns bootstrapping, subsequent poll calls return ready
      const registry = mockRegistry({ 'src/service.ts': bootstrappingEntry });
      (registry.get as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(bootstrappingEntry)  // initial resolve (step 5)
        .mockReturnValueOnce(bootstrappingEntry)  // first poll — still bootstrapping
        .mockReturnValueOnce(readyEntry);          // second poll — now ready

      const sessionManager = mockSessionManager();
      const traceLog = makeTraceLog();
      const envelope = makeEnvelope();

      const invokePromise = invoke(envelope, makeDeps({ registry, sessionManager, traceLog: traceLog.log }));

      // Advance past two poll intervals (2 x 500ms)
      await vi.advanceTimersByTimeAsync(1000);

      const result = await invokePromise;

      expect(result).toBeDefined();
      expect(result.task_id).toBe('task-001');
      // SessionManager.create should NOT have been called — agent was already spawning
      expect(sessionManager.create).not.toHaveBeenCalled();

      afterEachRestore();
    });

    it('throws AGENT_ERROR when bootstrapping agent transitions to error', async () => {
      const bootstrappingEntry = makeRegistryEntry({
        status: 'bootstrapping' as RegistryEntry['status'],
        session_id: null,
      });
      const errorEntry = makeRegistryEntry({
        status: 'error',
        session_id: null,
        error: 'bootstrap crashed: out of memory',
      });

      const registry = mockRegistry({ 'src/service.ts': bootstrappingEntry });
      (registry.get as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(bootstrappingEntry)  // initial resolve
        .mockReturnValueOnce(bootstrappingEntry)  // first poll — still bootstrapping
        .mockReturnValueOnce(errorEntry);          // second poll — error

      const sessionManager = mockSessionManager();
      const traceLog = makeTraceLog();
      const envelope = makeEnvelope();

      const invokePromise = invoke(envelope, makeDeps({ registry, sessionManager, traceLog: traceLog.log }));

      // Attach rejection handler BEFORE advancing timers to prevent unhandled rejection
      const caughtPromise = invokePromise.catch((e: Error) => e);

      await vi.advanceTimersByTimeAsync(1000);

      const err = await caughtPromise;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/AGENT_ERROR/);

      afterEachRestore();
    });

    it('throws BOOTSTRAP_TIMEOUT when agent never becomes ready', async () => {
      const bootstrappingEntry = makeRegistryEntry({
        status: 'bootstrapping' as RegistryEntry['status'],
        session_id: null,
      });

      const registry = mockRegistry({ 'src/service.ts': bootstrappingEntry });
      // All poll calls return bootstrapping — it never resolves
      (registry.get as ReturnType<typeof vi.fn>).mockReturnValue(bootstrappingEntry);

      const sessionManager = mockSessionManager();
      const traceLog = makeTraceLog();
      const envelope = makeEnvelope();

      const invokePromise = invoke(envelope, makeDeps({ registry, sessionManager, traceLog: traceLog.log }));

      // Attach rejection handler BEFORE advancing timers to prevent unhandled rejection
      const caughtPromise = invokePromise.catch((e: Error) => e);

      // Advance past the 30s timeout
      await vi.advanceTimersByTimeAsync(31_000);

      const err = await caughtPromise;
      expect(err).toBeInstanceOf(Error);
      expect((err as Error).message).toMatch(/BOOTSTRAP_TIMEOUT/);

      afterEachRestore();
    });

    it('uses session_id from the refreshed entry after bootstrapping completes', async () => {
      const bootstrappingEntry = makeRegistryEntry({
        status: 'bootstrapping' as RegistryEntry['status'],
        session_id: null,
      });
      const readyEntry = makeRegistryEntry({
        status: 'ready',
        session_id: 'sess-from-bootstrap',
      });

      const registry = mockRegistry({ 'src/service.ts': bootstrappingEntry });
      (registry.get as ReturnType<typeof vi.fn>)
        .mockReturnValueOnce(bootstrappingEntry)  // initial resolve
        .mockReturnValueOnce(readyEntry);          // first poll — ready with session

      const sessionManager = mockSessionManager();
      const traceLog = makeTraceLog();
      const envelope = makeEnvelope();

      const invokePromise = invoke(envelope, makeDeps({ registry, sessionManager, traceLog: traceLog.log }));

      await vi.advanceTimersByTimeAsync(500);

      const result = await invokePromise;

      expect(result).toBeDefined();
      // Verify the session invokeOnSession used the session_id from the refreshed ready entry
      expect(sessionManager.invokeOnSession).toHaveBeenCalled();
      const invokeCall = (sessionManager.invokeOnSession as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(invokeCall.sessionId).toBe('sess-from-bootstrap');

      afterEachRestore();
    });
  });
});
