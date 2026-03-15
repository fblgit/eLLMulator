/**
 * Phase 5E RED Tests: Synthetic State Pre-population (Task 5.5)
 * 
 * Tests state injection from TraceRequest and agent awareness of available state.
 * These features are NOT fully implemented yet — tests MUST FAIL.
 * 
 * Features:
 *   - TraceRequest.state pre-populates SyntheticState
 *   - state_get returns values from TraceRequest.state
 *   - Invoke prompt informs agent of available state keys
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createTraceHandler } from '../mcp-external.js';
import { createStateHandlers } from '../handlers.js';
import { invoke, RateLimitTracker, SelfLoopTracker } from '../invoke.js';
import { renderInvokePrompt } from '../templates.js';
import { Registry } from '../registry.js';
import { SessionManager } from '../session-manager.js';
import { TraceLog } from '../trace-log.js';
import type { TraceRequest, InvokeEnvelope } from '../types.js';

describe('Phase 5E: Synthetic State Pre-population', () => {
  let registry: Registry;
  let sessionManager: SessionManager;
  let traceLog: TraceLog;
  let syntheticState: Map<string, unknown>;
  let stateHandlers: ReturnType<typeof createStateHandlers>;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new Registry();
    sessionManager = new SessionManager();
    traceLog = new TraceLog();
    syntheticState = new Map();
    
    stateHandlers = createStateHandlers(syntheticState);

    // Register test file
    registry.add({
      file_path: 'src/api.ts',
      file_hash: 'hash-api',
      status: 'ready',
      session_id: 'session-api',
      declarations: {
        summary: 'API handler',
        owns: [
          { name: 'handleRequest', kind: 'function', intent: 'Process API request', file_path: 'src/api.ts', start_line: 10, end_line: 40 },
        ],
        imports: [],
        exports: [],
        dependencies: [],
      },
    });
  });

  it('[MUST-PASS-AT-PHASE-5] should pre-populate state_get from TraceRequest state', async () => {
    // SPEC: Phase 5 task 5.5 — state values from request available via state_get
    // TraceRequest.state: { user_id: 123, permissions: ['read'] }
    // Agent calls state_get('user_id') → returns 123
    
    const mockInvoke = vi.fn(async () => ({
      task_id: 'task-001',
      responder: 'src/api.ts',
      returns: { authorized: true },
      source_refs: ['src/api.ts:10-40'],
    }));

    const traceHandler = createTraceHandler({
      registry,
      sessionManager,
      traceLog,
      syntheticState: { 
        get: (k: string) => syntheticState.get(k), 
        set: (k: string, v: unknown) => syntheticState.set(k, v) 
      },
      invoke: mockInvoke,
    });

    const request: TraceRequest = {
      scenario: 'API request with auth context',
      entry_point: 'src/api.ts',
      state: {
        user_id: 123,
        permissions: ['read', 'write'],
        session_token: 'abc-def-ghi',
      },
      max_depth: 5,
    };

    await traceHandler(request);

    // Phase 5: TraceRequest.state should be injected into syntheticState
    // This will FAIL if createTraceHandler doesn't pre-populate state
    expect(syntheticState.get('user_id')).toBe(123);
    expect(syntheticState.get('permissions')).toEqual(['read', 'write']);
    expect(syntheticState.get('session_token')).toBe('abc-def-ghi');
  });

  it('[MUST-PASS-AT-PHASE-5] should inform agent of available state keys in invoke prompt', async () => {
    // SPEC: System prompt or invoke prompt mentions available state
    // Agent knows: "Available state: user_id, permissions, session_token"
    
    let capturedPrompt: string | undefined;
    
    sessionManager.query = vi.fn(async (opts: any) => {
      capturedPrompt = opts.prompt;
      return {
        task_id: 'task-001',
        responder: 'src/api.ts',
        returns: {},
        source_refs: ['src/api.ts:1'],
      };
    });

    // Pre-populate state
    syntheticState.set('user_id', 123);
    syntheticState.set('permissions', ['read']);
    syntheticState.set('config', { debug: true });

    const envelope: InvokeEnvelope = {
      trace_id: 'trace-001',
      task_id: 'task-001',
      caller: 'src/main.ts',
      target: 'src/api.ts',
      function: 'handleRequest',
      call_stack: [],
      mode: 'sync',
      max_depth: 10,
      // Phase 5: envelope carries state metadata OR it's in context
    };

    await invoke(envelope, {
      registry,
      sessionManager,
      traceLog: vi.fn(),
      rateLimitTracker: new RateLimitTracker(),
      selfLoopTracker: new SelfLoopTracker(),
      readFile: vi.fn().mockResolvedValue('// source'),
      projectDir: '/test',
      syntheticState, // ← Phase 5: pass state to invoke
    } as any);

    expect(capturedPrompt).toBeDefined();
    
    // Phase 5: Prompt should mention available state keys
    // This will FAIL because renderInvokePrompt doesn't include state context yet
    expect(capturedPrompt).toContain('Available Synthetic State');
    expect(capturedPrompt).toContain('user_id');
    expect(capturedPrompt).toContain('permissions');
    expect(capturedPrompt).toContain('config');
  });

  it('[MUST-PASS-AT-PHASE-5] should allow agents to read pre-populated state', async () => {
    // SPEC: Agent calls state_get('user_id') and receives the value
    
    syntheticState.set('user_id', 42);
    syntheticState.set('role', 'admin');

    const { state_get } = stateHandlers;

    // Agent calls state_get
    const userId = state_get('user_id');
    const role = state_get('role');
    const missing = state_get('nonexistent');

    expect(userId).toBe(42);
    expect(role).toBe('admin');
    expect(missing).toBeUndefined();
  });

  it('[MUST-PASS-AT-PHASE-5] should allow agents to write state during trace', async () => {
    // SPEC: Agent calls state_set to update/add state values
    // These updates persist for the duration of the trace
    
    const { state_get, state_set } = stateHandlers;

    // Initially empty
    expect(syntheticState.size).toBe(0);

    // Agent writes state
    const result1 = state_set('request_count', 1);
    expect(result1).toEqual({ success: true });
    expect(state_get('request_count')).toBe(1);

    // Agent updates state
    const result2 = state_set('request_count', 2);
    expect(result2).toEqual({ success: true });
    expect(state_get('request_count')).toBe(2);

    // Multiple state values
    state_set('last_user', 'alice');
    state_set('status', 'active');

    expect(syntheticState.size).toBe(3);
    expect(state_get('last_user')).toBe('alice');
    expect(state_get('status')).toBe('active');
  });

  it('[MUST-PASS-AT-PHASE-5] should include state mutations in trace entries', async () => {
    // SPEC: When an agent mutates state, TraceEntry.mutations captures it
    
    const traceLogFn = vi.fn();
    
    sessionManager.query = vi.fn(async () => ({
      task_id: 'task-001',
      responder: 'src/api.ts',
      returns: { ok: true },
      mutations: [
        { key: 'user_id', before: 123, after: 456 },
        { key: 'status', after: 'processed' },
      ],
      source_refs: ['src/api.ts:1'],
    }));

    const envelope: InvokeEnvelope = {
      trace_id: 'trace-001',
      task_id: 'task-001',
      caller: 'src/main.ts',
      target: 'src/api.ts',
      function: 'handleRequest',
      call_stack: [],
      mode: 'sync',
      max_depth: 10,
    };

    await invoke(envelope, {
      registry,
      sessionManager,
      traceLog: traceLogFn,
      rateLimitTracker: new RateLimitTracker(),
      selfLoopTracker: new SelfLoopTracker(),
      readFile: vi.fn().mockResolvedValue('// source'),
      projectDir: '/test',
    });

    // Verify trace entry includes mutations
    expect(traceLogFn).toHaveBeenCalled();
    const loggedEntry = traceLogFn.mock.calls[0][0];
    
    expect(loggedEntry.mutations).toBeDefined();
    expect(loggedEntry.mutations).toHaveLength(2);
    expect(loggedEntry.mutations[0]).toEqual({
      key: 'user_id',
      before: 123,
      after: 456,
    });
  });

  it('[MUST-PASS-AT-PHASE-5] should pass state through nested invokes', async () => {
    // SPEC: Nested agents inherit state from parent trace
    // Parent sets state → child reads the same state
    
    const mockInvoke = vi.fn(async (envelope: InvokeEnvelope) => {
      // Simulate nested invoke reading state
      const userId = syntheticState.get('user_id');
      
      return {
        task_id: envelope.task_id,
        responder: envelope.target,
        returns: { user_id: userId },
        source_refs: [`${envelope.target}:1`],
      };
    });

    const traceHandler = createTraceHandler({
      registry,
      sessionManager,
      traceLog,
      syntheticState: { 
        get: (k: string) => syntheticState.get(k), 
        set: (k: string, v: unknown) => syntheticState.set(k, v) 
      },
      invoke: mockInvoke,
    });

    const request: TraceRequest = {
      scenario: 'Nested state access',
      entry_point: 'src/api.ts',
      state: { user_id: 999 },
    };

    const result = await traceHandler(request);

    // Verify nested invoke saw the state
    expect(mockInvoke).toHaveBeenCalled();
    const envelope = mockInvoke.mock.calls[0][0];
    
    // Phase 5: State should be accessible in nested contexts
    expect(syntheticState.get('user_id')).toBe(999);
  });

  it('[MUST-PASS-AT-PHASE-5] should list all state keys in invoke prompt context', async () => {
    // SPEC: Prompt should enumerate state keys so agent knows what's available
    // Format: "State available: user_id (number), permissions (array), config (object)"
    
    let capturedPrompt: string | undefined;
    
    sessionManager.query = vi.fn(async (opts: any) => {
      capturedPrompt = opts.prompt;
      return {
        task_id: 'task-001',
        responder: 'src/api.ts',
        returns: {},
        source_refs: ['src/api.ts:1'],
      };
    });

    // Populate diverse state types
    syntheticState.set('count', 42);
    syntheticState.set('name', 'Alice');
    syntheticState.set('flags', { debug: true, verbose: false });
    syntheticState.set('items', [1, 2, 3]);

    const envelope: InvokeEnvelope = {
      trace_id: 'trace-001',
      task_id: 'task-001',
      caller: 'src/main.ts',
      target: 'src/api.ts',
      function: 'process',
      call_stack: [],
      mode: 'sync',
      max_depth: 10,
    };

    await invoke(envelope, {
      registry,
      sessionManager,
      traceLog: vi.fn(),
      rateLimitTracker: new RateLimitTracker(),
      selfLoopTracker: new SelfLoopTracker(),
      readFile: vi.fn().mockResolvedValue('// source'),
      projectDir: '/test',
      syntheticState,
    } as any);

    // Phase 5: Prompt should enumerate available state
    // This will FAIL because renderInvokePrompt doesn't list state yet
    expect(capturedPrompt).toBeDefined();
    expect(capturedPrompt).toMatch(/state/i);
    expect(capturedPrompt).toContain('count');
    expect(capturedPrompt).toContain('name');
    expect(capturedPrompt).toContain('flags');
    expect(capturedPrompt).toContain('items');
  });

  it('[MUST-PASS-AT-PHASE-5] should support complex nested state values', async () => {
    // SPEC: State can hold any JSON-serializable value
    
    const complexState = {
      user: {
        id: 123,
        profile: {
          name: 'Alice',
          roles: ['admin', 'editor'],
        },
      },
      config: {
        features: {
          experimental: true,
          beta: ['feature-a', 'feature-b'],
        },
      },
    };

    syntheticState.set('app_context', complexState);

    const { state_get } = stateHandlers;
    const retrieved = state_get('app_context');

    expect(retrieved).toEqual(complexState);
    expect((retrieved as any).user.profile.name).toBe('Alice');
    expect((retrieved as any).config.features.experimental).toBe(true);
  });
});
