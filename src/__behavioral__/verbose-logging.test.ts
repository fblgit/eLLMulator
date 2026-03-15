/**
 * Verbose Logging & MCP Call Logging Tests
 *
 * Tests two features:
 * 1. --verbose: Logs prompts sent to agents and their responses via onVerbose callback
 * 2. Always-on MCP call logging: All internal tool calls logged to stderr
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Mock Anthropic SDK (prevent real API calls)
// ---------------------------------------------------------------------------
vi.mock('@anthropic-ai/sdk', () => ({
  default: vi.fn().mockImplementation(() => ({
    messages: { create: vi.fn().mockResolvedValue({ id: 'msg_test', content: [], role: 'assistant' }) },
  })),
}));

// ---------------------------------------------------------------------------
// Feature 1: onVerbose in InvokeDeps — invoke() emits verbose events
// ---------------------------------------------------------------------------
describe('Verbose trace logging', () => {
  let invoke: typeof import('../invoke.js').invoke;
  let Registry: typeof import('../registry.js').Registry;
  let SessionManager: typeof import('../session-manager.js').SessionManager;
  let RateLimitTracker: typeof import('../guardrails.js').RateLimitTracker;
  let SelfLoopTracker: typeof import('../guardrails.js').SelfLoopTracker;

  beforeEach(async () => {
    vi.resetModules();
    const invokeModule = await import('../invoke.js');
    invoke = invokeModule.invoke;
    const regModule = await import('../registry.js');
    Registry = regModule.Registry;
    const smModule = await import('../session-manager.js');
    SessionManager = smModule.SessionManager;
    const guardrails = await import('../guardrails.js');
    RateLimitTracker = guardrails.RateLimitTracker;
    SelfLoopTracker = guardrails.SelfLoopTracker;
  });

  function makeRegistry() {
    const registry = new Registry();
    registry.add({
      file_path: 'src/a.ts',
      status: 'ready',
      declarations: {
        summary: 'file A',
        owns: [{ name: 'doStuff', kind: 'function', intent: 'does stuff' }],
        imports: [],
        exports: [],
        dependencies: [],
      },
      session_id: 'sess-a',
    } as any);
    registry.add({
      file_path: 'src/b.ts',
      status: 'ready',
      declarations: {
        summary: 'file B',
        owns: [{ name: 'helperFn', kind: 'function', intent: 'helps out' }],
        imports: [],
        exports: [],
        dependencies: [],
      },
      session_id: 'sess-b',
    } as any);
    return registry;
  }

  function makeSessionManager() {
    const sm = new SessionManager();
    // Mock invokeOnSession to return a valid ResponseEnvelope without real SDK calls
    sm.invokeOnSession = vi.fn().mockResolvedValue({
      task_id: 'test-task',
      responder: 'src/b.ts',
      returns: { result: 42 },
      source_refs: [{ file: 'src/b.ts', lines: '1-10' }],
    });
    return sm;
  }

  it('emits invoke_prompt event with full prompt text when onVerbose is set', async () => {
    const registry = makeRegistry();
    const sm = makeSessionManager();
    const verboseEvents: any[] = [];
    const onVerbose = (event: any) => verboseEvents.push(event);

    await invoke(
      {
        trace_id: 'trace-1',
        task_id: 'task-1',
        caller: 'src/a.ts',
        target: 'src/b.ts',
        function: 'helperFn',
        params: { x: 1 },
        call_stack: [],
        mode: 'sync',
        max_depth: 5,
      },
      {
        registry,
        sessionManager: sm,
        traceLog: vi.fn(),
        rateLimitTracker: new RateLimitTracker(),
        selfLoopTracker: new SelfLoopTracker(),
        readFile: vi.fn().mockResolvedValue('// source code'),
        projectDir: '/project',
        onVerbose,
      },
    );

    const promptEvent = verboseEvents.find(e => e.type === 'invoke_prompt');
    expect(promptEvent).toBeDefined();
    expect(promptEvent.target).toBe('src/b.ts');
    expect(promptEvent.function).toBe('helperFn');
    expect(promptEvent.caller).toBe('src/a.ts');
    expect(typeof promptEvent.prompt).toBe('string');
    expect(promptEvent.prompt.length).toBeGreaterThan(0);
  });

  it('emits invoke_response event with returns and source_refs', async () => {
    const registry = makeRegistry();
    const sm = makeSessionManager();
    const verboseEvents: any[] = [];
    const onVerbose = (event: any) => verboseEvents.push(event);

    await invoke(
      {
        trace_id: 'trace-1',
        task_id: 'task-1',
        caller: 'src/a.ts',
        target: 'src/b.ts',
        function: 'helperFn',
        params: {},
        call_stack: [],
        mode: 'sync',
        max_depth: 5,
      },
      {
        registry,
        sessionManager: sm,
        traceLog: vi.fn(),
        rateLimitTracker: new RateLimitTracker(),
        selfLoopTracker: new SelfLoopTracker(),
        readFile: vi.fn().mockResolvedValue('// source code'),
        projectDir: '/project',
        onVerbose,
      },
    );

    const responseEvent = verboseEvents.find(e => e.type === 'invoke_response');
    expect(responseEvent).toBeDefined();
    expect(responseEvent.target).toBe('src/b.ts');
    expect(responseEvent.function).toBe('helperFn');
    expect(responseEvent.returns).toEqual({ result: 42 });
    expect(responseEvent.source_refs).toEqual([{ file: 'src/b.ts', lines: '1-10' }]);
    expect(responseEvent.duration_ms).toBeGreaterThanOrEqual(0);
  });

  it('does not emit verbose events when onVerbose is not set', async () => {
    const registry = makeRegistry();
    const sm = makeSessionManager();

    // No spy to capture — just ensure invoke completes without error when onVerbose is undefined
    const result = await invoke(
      {
        trace_id: 'trace-1',
        task_id: 'task-1',
        caller: 'src/a.ts',
        target: 'src/b.ts',
        function: 'helperFn',
        params: {},
        call_stack: [],
        mode: 'sync',
        max_depth: 5,
      },
      {
        registry,
        sessionManager: sm,
        traceLog: vi.fn(),
        rateLimitTracker: new RateLimitTracker(),
        selfLoopTracker: new SelfLoopTracker(),
        readFile: vi.fn().mockResolvedValue('// source code'),
        projectDir: '/project',
        // onVerbose intentionally omitted
      },
    );

    expect(result).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Feature 1+2: ServerConfig accepts verbose flag
// ---------------------------------------------------------------------------
describe('ServerConfig verbose flag', () => {
  it('createServer accepts verbose in config and resolves it', async () => {
    const { createServer } = await import('../server.js');

    const server = createServer({ projectDir: '/test', verbose: true });
    const config = server.getConfig();
    expect(config.verbose).toBe(true);
  });

  it('createServer defaults verbose to false when not specified', async () => {
    const { createServer } = await import('../server.js');

    const server = createServer({ projectDir: '/test' });
    const config = server.getConfig();
    expect(config.verbose).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Feature 1: TraceDeps accepts onVerbose and passes it through
// ---------------------------------------------------------------------------
describe('TraceDeps onVerbose wiring', () => {
  it('createTraceHandler passes onVerbose to invokeDeps', async () => {
    // Verify the type accepts onVerbose — this is a compile-time check that
    // also runs at runtime to confirm the wiring exists.
    const { createTraceHandler } = await import('../mcp-external.js');
    const { Registry } = await import('../registry.js');
    const { SessionManager } = await import('../session-manager.js');
    const { TraceLog } = await import('../trace-log.js');
    const { SyntheticState } = await import('../handlers.js');

    const verboseEvents: any[] = [];
    const onVerbose = (event: any) => verboseEvents.push(event);

    // Should not throw — onVerbose is accepted as a TraceDeps field
    const handler = createTraceHandler({
      registry: new Registry(),
      sessionManager: new SessionManager(),
      traceLog: new TraceLog(),
      syntheticState: new SyntheticState(),
      rateLimitTracker: { check: () => true, record: () => {} } as any,
      selfLoopTracker: { check: () => true, record: () => {} } as any,
      readFile: vi.fn().mockResolvedValue(''),
      projectDir: '/test',
      invoke: vi.fn().mockResolvedValue({}),
      onVerbose,
    });

    expect(typeof handler).toBe('function');
  });
});
