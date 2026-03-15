import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock SDK for SessionManager
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

import { createServer } from '../server.js';
import { Registry } from '../registry.js';
import { SessionManager } from '../session-manager.js';
import { createBootstrapHandler } from '../bootstrap.js';
import { createRegisterHandler, SyntheticState, createStateHandlers, createResolveHandler } from '../handlers.js';
import { invoke, RateLimitTracker, SelfLoopTracker } from '../invoke.js';
import { renderSystemPrompt, renderBootstrapPrompt, renderInvokePrompt } from '../templates.js';
import { InvokeEnvelopeSchema, ResponseEnvelopeSchema, TraceEntrySchema } from '../schemas.js';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { ResponseEnvelope, InvokeEnvelope, RegistryEntry } from '../types.js';

describe('Cross-Phase Integration Tests', () => {
  let registry: Registry;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new Registry();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Contract 1: Bootstrap→Register→Ready Flow', () => {
    it('should register all scanned files as cold in registry', async () => {
      // SPEC: Bootstrap must add all discovered files to registry with status=cold
      const mockScanner = {
        scanProjectFiles: vi.fn().mockResolvedValue([
          { path: '/test/file1.ts', content: 'export const a = 1;', hash: 'hash1' },
          { path: '/test/file2.ts', content: 'export const b = 2;', hash: 'hash2' },
          { path: '/test/file3.ts', content: 'export const c = 3;', hash: 'hash3' },
        ])
      };

      const mockSessionManager = {
        create: vi.fn().mockResolvedValue({ session_id: 'test-session', file_path: '/test/file1.ts', created_at: new Date(), file_hash: 'hash1', status: 'idle', systemPrompt: '', tools: [], model: 'test' }),
      } as any;

      const bootstrap = createBootstrapHandler({
        registry,
        sessionManager: mockSessionManager,
        scanner: mockScanner,
      });

      await bootstrap('/test', { threads: 1, extensions: [], skip_dirs: [], skip_patterns: [] });

      // Verify all 3 files are in registry
      const entry1 = registry.get('/test/file1.ts');
      const entry2 = registry.get('/test/file2.ts');
      const entry3 = registry.get('/test/file3.ts');

      expect(entry1).toBeDefined();
      expect(entry2).toBeDefined();
      expect(entry3).toBeDefined();
      // After bootstrap, files transition cold → bootstrapping (awaiting register)
      expect(entry1?.status).toBe('bootstrapping');
      expect(entry2?.status).toBe('bootstrapping');
      expect(entry3?.status).toBe('bootstrapping');
    });

    it('should call sessionManager.create for each file', async () => {
      // SPEC: Bootstrap spawns SDK session for each discovered file
      const mockScanner = {
        scanProjectFiles: vi.fn().mockResolvedValue([
          { path: '/test/file1.ts', content: 'export const a = 1;', hash: 'hash1' },
          { path: '/test/file2.ts', content: 'export const b = 2;', hash: 'hash2' },
          { path: '/test/file3.ts', content: 'export const c = 3;', hash: 'hash3' },
        ])
      };

      const mockSessionManager = {
        create: vi.fn().mockResolvedValue({ session_id: 'test-session', file_path: '/test/file1.ts', created_at: new Date(), file_hash: 'hash1', status: 'idle', systemPrompt: '', tools: [], model: 'test' }),
      } as any;

      const bootstrap = createBootstrapHandler({
        registry,
        sessionManager: mockSessionManager,
        scanner: mockScanner,
      });

      await bootstrap('/test', { threads: 1, extensions: [], skip_dirs: [], skip_patterns: [] });

      expect(mockSessionManager.create).toHaveBeenCalledTimes(3);
    });

    it('should return correct totals for bootstrapped files', async () => {
      // SPEC: Bootstrap returns total and ready counts
      const mockScanner = {
        scanProjectFiles: vi.fn().mockResolvedValue([
          { path: '/test/file1.ts', content: 'export const a = 1;', hash: 'hash1' },
          { path: '/test/file2.ts', content: 'export const b = 2;', hash: 'hash2' },
        ])
      };

      const mockSessionManager = {
        create: vi.fn().mockResolvedValue({ session_id: 'test-session', file_path: '/test/file1.ts', created_at: new Date(), file_hash: 'hash1', status: 'idle', systemPrompt: '', tools: [], model: 'test' }),
      } as any;

      const bootstrap = createBootstrapHandler({
        registry,
        sessionManager: mockSessionManager,
        scanner: mockScanner,
      });

      const result = await bootstrap('/test', { threads: 1, extensions: [], skip_dirs: [], skip_patterns: [] });

      expect(result.total).toBe(2);
      expect(result.ready).toBeGreaterThanOrEqual(0);
    });

    it('should handle partial session creation failures gracefully', async () => {
      // SPEC: Bootstrap continues even if some sessions fail to spawn
      const mockScanner = {
        scanProjectFiles: vi.fn().mockResolvedValue([
          { path: '/test/file1.ts', content: 'export const a = 1;', hash: 'hash1' },
          { path: '/test/file2.ts', content: 'export const b = 2;', hash: 'hash2' },
          { path: '/test/file3.ts', content: 'export const c = 3;', hash: 'hash3' },
        ])
      };

      const mockSessionManager = {
        create: vi.fn()
          .mockResolvedValueOnce({ session_id: 'session-1', file_path: '/test/file1.ts', created_at: new Date(), file_hash: 'hash1', status: 'idle', systemPrompt: '', tools: [], model: 'test' })
          .mockRejectedValueOnce(new Error('Session creation failed'))
          .mockResolvedValueOnce({ session_id: 'session-3', file_path: '/test/file3.ts', created_at: new Date(), file_hash: 'hash3', status: 'idle', systemPrompt: '', tools: [], model: 'test' }),
      } as any;

      const bootstrap = createBootstrapHandler({
        registry,
        sessionManager: mockSessionManager,
        scanner: mockScanner,
      });

      const result = await bootstrap('/test', { threads: 1, extensions: [], skip_dirs: [], skip_patterns: [] });

      expect(result.total).toBe(3);
      // At least some files should still be registered even with failures
      expect(registry.get('/test/file1.ts')).toBeDefined();
      expect(registry.get('/test/file3.ts')).toBeDefined();
    });
  });

  describe('Contract 2: Register Handler Updates Registry', () => {
    it('should transition status from bootstrapping to ready', async () => {
      // SPEC: Register handler transitions file status to ready and stores declarations
      registry.add({ file_path: '/test/file.ts', file_hash: 'hash1', status: 'cold', session_id: null, declarations: null, last_active: null, error: null });
      registry.update('/test/file.ts', { status: 'bootstrapping' });

      const registerHandler = createRegisterHandler(registry);

      const result = registerHandler('/test/file.ts', {
        summary: 'Test file',
        owns: [],
        imports: [],
        exports: [],
        dependencies: [],
      });

      expect(result).toEqual({ success: true });
      const entry = registry.get('/test/file.ts');
      expect(entry?.status).toBe('ready');
      expect(entry?.declarations).toBeDefined();
    });

    it('should set last_active timestamp on registration', async () => {
      // SPEC: Register handler updates last_active to current time
      registry.add({ file_path: '/test/file.ts', file_hash: 'hash1', status: 'cold', session_id: null, declarations: null, last_active: null, error: null });
      registry.update('/test/file.ts', { status: 'bootstrapping' });

      const registerHandler = createRegisterHandler(registry);

      const beforeTime = new Date();
      registerHandler('/test/file.ts', {
        summary: 'Test file',
        owns: [],
        imports: [],
        exports: [],
        dependencies: [],
      });
      const afterTime = new Date();

      const entry = registry.get('/test/file.ts');
      expect(entry?.last_active).toBeDefined();
      expect(entry!.last_active!.getTime()).toBeGreaterThanOrEqual(beforeTime.getTime());
      expect(entry!.last_active!.getTime()).toBeLessThanOrEqual(afterTime.getTime());
    });

    it('should store declarations in registry entry', async () => {
      // SPEC: Register handler persists function and export declarations
      registry.add({ file_path: '/test/file.ts', file_hash: 'hash1', status: 'cold', session_id: null, declarations: null, last_active: null, error: null });
      registry.update('/test/file.ts', { status: 'bootstrapping' });

      const registerHandler = createRegisterHandler(registry);

      const declarations = {
        summary: 'Math utilities',
        owns: [
          { name: 'add', kind: 'function' as const, intent: 'Add two numbers', file_path: '/test/file.ts', start_line: 1, end_line: 3 },
          { name: 'multiply', kind: 'function' as const, intent: 'Multiply two numbers', file_path: '/test/file.ts', start_line: 5, end_line: 7 },
        ],
        imports: [],
        exports: [],
        dependencies: [],
      };

      registerHandler('/test/file.ts', declarations);

      const entry = registry.get('/test/file.ts');
      expect(entry?.declarations).toEqual(declarations);
    });
  });

  describe('Contract 3: Invoke Handler Guardrails', () => {
    it('should detect and reject cycles in call_stack', async () => {
      // SPEC: Invoke handler enforces cycle detection guardrail
      registry.add({ file_path: '/test/file.ts', file_hash: 'hash1', status: 'ready', session_id: 'session-1', declarations: { summary: '', owns: [], imports: [], exports: [], dependencies: [] }, last_active: null, error: null });

      const mockSessionManager = {} as any;
      const mockTraceLog = vi.fn();
      const mockReadFile = vi.fn().mockResolvedValue('export const x = 1;');

      const envelope: InvokeEnvelope = {
        trace_id: 'trace-1',
        task_id: 'task-1',
        caller: '/test/other.ts',
        target: '/test/file.ts',
        function: 'testFunc',
        params: {},
        call_stack: ['/test/other.ts', '/test/file.ts'], // Cycle detected!
        max_depth: 10,
      };

      await expect(invoke(envelope, {
        registry,
        sessionManager: mockSessionManager,
        traceLog: mockTraceLog,
        rateLimitTracker: new RateLimitTracker(),
        selfLoopTracker: new SelfLoopTracker(),
        readFile: mockReadFile,
        projectDir: '/test',
      })).rejects.toThrow(/CYCLE_DETECTED/i);
    });

    it('should reject invocations exceeding max_depth', async () => {
      // SPEC: Invoke handler enforces max depth guardrail
      registry.add({ file_path: '/test/file.ts', file_hash: 'hash1', status: 'ready', session_id: 'session-1', declarations: { summary: '', owns: [], imports: [], exports: [], dependencies: [] }, last_active: null, error: null });

      const mockSessionManager = {} as any;
      const mockTraceLog = vi.fn();
      const mockReadFile = vi.fn().mockResolvedValue('export const x = 1;');

      const envelope: InvokeEnvelope = {
        trace_id: 'trace-1',
        task_id: 'task-1',
        caller: '/test/other.ts',
        target: '/test/file.ts',
        function: 'testFunc',
        params: {},
        call_stack: ['/test/a.ts', '/test/b.ts', '/test/c.ts', '/test/d.ts', '/test/e.ts', '/test/f.ts'],
        max_depth: 5,
      };

      await expect(invoke(envelope, {
        registry,
        sessionManager: mockSessionManager,
        traceLog: mockTraceLog,
        rateLimitTracker: new RateLimitTracker(),
        selfLoopTracker: new SelfLoopTracker(),
        readFile: mockReadFile,
        projectDir: '/test',
      })).rejects.toThrow(/MAX_DEPTH_EXCEEDED/i);
    });

    it('should reject invocations for unregistered files', async () => {
      // SPEC: Invoke handler checks file is registered before dispatch
      const mockSessionManager = {} as any;
      const mockTraceLog = vi.fn();
      const mockReadFile = vi.fn().mockResolvedValue('export const x = 1;');

      const envelope: InvokeEnvelope = {
        trace_id: 'trace-1',
        task_id: 'task-1',
        caller: '/test/other.ts',
        target: '/test/nonexistent.ts',
        function: 'testFunc',
        params: {},
        call_stack: [],
        max_depth: 10,
      };

      await expect(invoke(envelope, {
        registry,
        sessionManager: mockSessionManager,
        traceLog: mockTraceLog,
        rateLimitTracker: new RateLimitTracker(),
        selfLoopTracker: new SelfLoopTracker(),
        readFile: mockReadFile,
        projectDir: '/test',
      })).rejects.toThrow(/FILE_NOT_REGISTERED/i);
    });

    it('should reject invocations for files not in ready status', async () => {
      // SPEC: Invoke handler ensures target file is ready before dispatch
      // Test with status='error' which immediately rejects (cold/stale trigger spawn, not rejection)
      registry.add({ 
        file_path: '/test/file.ts', 
        file_hash: 'hash1', 
        status: 'error', 
        session_id: null, 
        declarations: null, 
        last_active: null, 
        error: 'Agent failed to bootstrap' 
      });

      const mockSessionManager = {} as any;
      const mockTraceLog = vi.fn();
      const mockReadFile = vi.fn().mockResolvedValue('export const x = 1;');

      const envelope: InvokeEnvelope = {
        trace_id: 'trace-1',
        task_id: 'task-1',
        caller: '/test/other.ts',
        target: '/test/file.ts',
        function: 'testFunc',
        params: {},
        call_stack: [],
        max_depth: 10,
      };

      await expect(invoke(envelope, {
        registry,
        sessionManager: mockSessionManager,
        traceLog: mockTraceLog,
        rateLimitTracker: new RateLimitTracker(),
        selfLoopTracker: new SelfLoopTracker(),
        readFile: mockReadFile,
        projectDir: '/test',
      })).rejects.toThrow(/AGENT_ERROR/i);
    });
  });

  describe('Contract 4: Full Invoke→Respond Flow', () => {
    // These tests verify the invoke HANDLER (invoke.ts) uses invokeOnSession
    // (Promise-based response capture) instead of legacy query(). Currently
    // invoke.ts calls sessionManager.query() — these are RED until Phase 5
    // wires invokeOnSession into the invoke handler.
    //
    // IMPORTANT: Tests go through invoke(), NOT SessionManager directly.
    // SessionManager.invokeOnSession works in isolation — the gap is that
    // invoke.ts doesn't USE it. That's what these tests prove.

    function makeContract4Entry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
      return {
        file_path: 'target.ts',
        file_hash: 'hash-target',
        status: 'ready',
        session_id: 'sess-target-001',
        declarations: {
          summary: 'target module',
          owns: [],
          imports: [],
          exports: [],
          dependencies: [],
        },
        last_active: new Date(),
        ...overrides,
      };
    }

    function makeContract4Envelope(overrides: Partial<InvokeEnvelope> = {}): InvokeEnvelope {
      return {
        trace_id: 'tr-c4',
        task_id: 'task-c4-001',
        caller: 'caller.ts',
        target: 'target.ts',
        function: 'handleRequest',
        call_stack: [],
        mode: 'sync',
        max_depth: 5,
        ...overrides,
      };
    }

    function makeContract4Deps(overrides: Partial<InvokeDeps> = {}): InvokeDeps {
      const targetEntry = makeContract4Entry();
      const callerEntry = makeContract4Entry({ file_path: 'caller.ts', session_id: 'sess-caller' });

      return {
        registry: {
          get: vi.fn((path: string) => {
            if (path === 'target.ts') return targetEntry;
            if (path === 'caller.ts') return callerEntry;
            return undefined;
          }),
          add: vi.fn(),
          update: vi.fn(),
          remove: vi.fn(),
          list: vi.fn(() => [targetEntry, callerEntry]),
          listByStatus: vi.fn(() => []),
          size: 2,
        } as unknown as Registry,
        sessionManager: {
          create: vi.fn(),
          get: vi.fn(() => ({ session_id: 'sess-target-001' })),
          terminate: vi.fn(),
          // Legacy query — this is what invoke.ts currently calls
          query: vi.fn(async () => ({
            task_id: 'task-c4-001',
            responder: 'target.ts',
            returns: { result: 'from-query' },
            mutations: [],
            source_refs: ['target.ts:1-10'],
          })),
          // invokeOnSession — this is what invoke.ts SHOULD call (Phase 5)
          invokeOnSession: vi.fn(async () => ({
            task_id: 'task-c4-001',
            responder: 'target.ts',
            returns: { result: 'from-invokeOnSession' },
            mutations: [],
            source_refs: ['target.ts:1-10'],
          })),
          list: vi.fn(() => []),
          size: 0,
          getPendingResponses: vi.fn(() => new Map()),
        } as unknown as SessionManager,
        traceLog: vi.fn(),
        rateLimitTracker: new RateLimitTracker(),
        selfLoopTracker: new SelfLoopTracker(),
        readFile: vi.fn().mockResolvedValue('// target source code'),
        projectDir: '/tmp/test',
      };
    }

    it('[MUST-PASS-AT-PHASE-5] should use invokeOnSession with respond capture for ready agents', async () => {
      // SPEC: invoke handler should use invokeOnSession (Promise-based capture)
      // instead of legacy query() for ready agents.
      // Currently invoke.ts calls sessionManager.query() → this test FAILS.
      const deps = makeContract4Deps();
      const envelope = makeContract4Envelope();

      await invoke(envelope, deps);

      // The invoke handler SHOULD use invokeOnSession, NOT query
      expect(deps.sessionManager.invokeOnSession).toHaveBeenCalled();
      expect(deps.sessionManager.query).not.toHaveBeenCalled();
    });

    it('[MUST-PASS-AT-PHASE-5] should pass forkSession:true through invokeOnSession', async () => {
      // SPEC: frozen oracle pattern — invoke uses forkSession:true to keep
      // base session pristine. This must go through invokeOnSession.
      const deps = makeContract4Deps();
      const envelope = makeContract4Envelope();

      await invoke(envelope, deps);

      // Assert invokeOnSession was called with forkSession: true
      expect(deps.sessionManager.invokeOnSession).toHaveBeenCalled();
      const call = (deps.sessionManager.invokeOnSession as ReturnType<typeof vi.fn>).mock.calls[0][0];
      expect(call.forkSession).toBe(true);
      expect(call.sessionId).toBe('sess-target-001');
    });

    it('[MUST-PASS-AT-PHASE-5] should resolve concurrent invocations via respond capture', async () => {
      // SPEC: Multiple concurrent invokes via invokeOnSession should each get
      // their own pending promise keyed by task_id — no cross-contamination.
      const deps = makeContract4Deps();

      // Track which taskIds are passed to invokeOnSession
      const capturedTaskIds: string[] = [];
      (deps.sessionManager.invokeOnSession as ReturnType<typeof vi.fn>).mockImplementation(
        async (opts: any) => {
          capturedTaskIds.push(opts.taskId);
          return {
            task_id: opts.taskId,
            responder: 'target.ts',
            returns: { fromTask: opts.taskId },
            source_refs: ['target.ts:1'],
          };
        }
      );

      const envelopeA = makeContract4Envelope({ task_id: 'task-A' });
      const envelopeB = makeContract4Envelope({ task_id: 'task-B' });

      // Fire 2 concurrent invocations through invoke()
      const [resultA, resultB] = await Promise.all([
        invoke(envelopeA, deps),
        invoke(envelopeB, deps),
      ]);

      // invokeOnSession should have been called for both, with distinct taskIds
      expect(deps.sessionManager.invokeOnSession).toHaveBeenCalledTimes(2);
      expect(capturedTaskIds).toContain('task-A');
      expect(capturedTaskIds).toContain('task-B');

      // Each response should be correctly routed
      expect(resultA.task_id).toBe('task-A');
      expect(resultB.task_id).toBe('task-B');
    });
  });

  describe('Contract 5: Template Prompt Generation', () => {
    it('should render system prompt with all required elements', () => {
      // Protocol V2: lean system prompt — identity + source + minimal contract
      // Guardrails and detailed constraints live in tool descriptions + invoke prompt
      const prompt = renderSystemPrompt({
        filePath: '/test/math.ts',
        sourceCode: 'export function add(a: number, b: number) { return a + b; }',
      });

      expect(prompt).toContain('/test/math.ts');
      expect(prompt).toContain('<source_code>');
      expect(prompt).toContain('export function add');
      expect(prompt).toMatch(/MCP/i);
      expect(prompt).toContain('Do NOT modify');
    });

    it('should render bootstrap prompt with registration instruction', () => {
      // SPEC: Bootstrap prompt instructs agent to call mcp__internal__register
      const prompt = renderBootstrapPrompt({
        filePath: '/test/file.ts',
      });

      expect(prompt).toContain('/test/file.ts');
      expect(prompt).toMatch(/register/i);
      expect(prompt).toMatch(/declarations/i);
    });

    it('should render invoke prompt with function details and call stack', () => {
      // SPEC: Invoke prompt includes function_name, params, call_stack
      const prompt = renderInvokePrompt({
        envelope: {
          function: 'calculateTotal',
          params: { items: [1, 2, 3], tax: 0.08 },
          call_stack: ['/test/main.ts', '/test/utils.ts'],
          caller: '/test/caller.ts',
        },
        callerDeclarations: undefined,
      });

      expect(prompt).toContain('calculateTotal');
      expect(prompt).toContain('items');
      expect(prompt).toContain('/test/main.ts');
      expect(prompt).toContain('/test/utils.ts');
      expect(prompt).toMatch(/source_refs/i);
    });
  });

  describe('Contract 6: Registry Status Transition Enforcement', () => {
    it('should allow valid status transitions', () => {
      // SPEC: Registry enforces valid state machine transitions
      registry.add({ file_path: '/test/file.ts', file_hash: 'hash1', status: 'cold', session_id: null, declarations: null, last_active: null, error: null });
      
      // cold → bootstrapping ✅
      expect(registry.get('/test/file.ts')?.status).toBe('cold');
      registry.update('/test/file.ts', { status: 'bootstrapping' });
      expect(registry.get('/test/file.ts')?.status).toBe('bootstrapping');

      // bootstrapping → ready ✅
      registry.update('/test/file.ts', { status: 'ready' });
      expect(registry.get('/test/file.ts')?.status).toBe('ready');

      // ready → stale ✅
      registry.update('/test/file.ts', { status: 'stale' });
      expect(registry.get('/test/file.ts')?.status).toBe('stale');

      // stale → bootstrapping ✅
      registry.update('/test/file.ts', { status: 'bootstrapping' });
      expect(registry.get('/test/file.ts')?.status).toBe('bootstrapping');
    });

    it('should reject invalid status transitions', () => {
      // SPEC: Registry prevents invalid state transitions
      registry.add({ file_path: '/test/file.ts', file_hash: 'hash1', status: 'cold', session_id: null, declarations: null, last_active: null, error: null });
      
      // cold → ready ✗ (should skip or throw)
      const initialStatus = registry.get('/test/file.ts')?.status;
      expect(() => {
        registry.update('/test/file.ts', { status: 'ready' });
      }).toThrow();
      // Status should remain unchanged
      expect(registry.get('/test/file.ts')?.status).toBe(initialStatus);
    });

    it('should reject backward transitions from ready to cold', () => {
      // SPEC: Registry prevents regression from ready to cold
      registry.add({ file_path: '/test/file.ts', file_hash: 'hash1', status: 'cold', session_id: null, declarations: null, last_active: null, error: null });
      registry.update('/test/file.ts', { status: 'bootstrapping' });
      registry.update('/test/file.ts', { status: 'ready' });

      // ready → cold ✗
      expect(() => {
        registry.update('/test/file.ts', { status: 'cold' });
      }).toThrow();
      expect(registry.get('/test/file.ts')?.status).toBe('ready');
    });

    it('should enforce status transitions match SPEC state machine', () => {
      // SPEC: All transitions must follow defined state machine
      const validTransitions = [
        { from: 'cold', to: 'bootstrapping' },
        { from: 'bootstrapping', to: 'ready' },
        { from: 'ready', to: 'stale' },
        { from: 'stale', to: 'bootstrapping' },
      ];

      for (const { from, to } of validTransitions) {
        const path = `/test/${from}-${to}.ts`;
        registry.add({ file_path: path, file_hash: 'hash', status: 'cold', session_id: null, declarations: null, last_active: null, error: null });
        
        if (from !== 'cold') {
          // Navigate to the 'from' state
          if (from === 'bootstrapping') {
            registry.update(path, { status: 'bootstrapping' });
          } else if (from === 'ready') {
            registry.update(path, { status: 'bootstrapping' });
            registry.update(path, { status: 'ready' });
          } else if (from === 'stale') {
            registry.update(path, { status: 'bootstrapping' });
            registry.update(path, { status: 'ready' });
            registry.update(path, { status: 'stale' });
          }
        }
        
        // Should not throw
        expect(() => {
          registry.update(path, { status: to as any });
        }).not.toThrow();
      }
    });
  });

  describe('Contract 7: Server Creation and MCP Surfaces', () => {
    it('[MUST-PASS-AT-PHASE-3] should create server with both internal and external MCP surfaces', () => {
      // SPEC: createServer returns object with start/stop/getConfig/getRegistry/getHandlers/getTraceLog
      const server = createServer({ projectDir: '/tmp/test-project' });

      expect(server).toBeDefined();
      expect(typeof server.start).toBe('function');
      expect(typeof server.stop).toBe('function');
      expect(typeof server.getConfig).toBe('function');
      expect(typeof server.getRegistry).toBe('function');
      expect(typeof server.getSessionManager).toBe('function');
      expect(typeof server.getHandlers).toBe('function');
      expect(typeof server.getTraceLog).toBe('function');

      // Verify default config
      const config = server.getConfig();
      expect(config.extPort).toBe(3100);
      expect(config.intPort).toBe(3101);
      expect(config.projectDir).toBe('/tmp/test-project');
    });

    it('[MUST-PASS-AT-PHASE-3] should register all required handlers on both surfaces', () => {
      // SPEC: Internal MCP has 6 tools (invoke, register, state_get, state_set, resolve, respond)
      // SPEC: External MCP has 5+ tools (trace, inspect, status, listAgents, consolidate)
      const server = createServer({ projectDir: '/tmp/test-project' });
      const handlers = server.getHandlers();

      // Internal handlers
      expect(typeof handlers.invoke).toBe('function');
      expect(typeof handlers.register).toBe('function');
      expect(typeof handlers.state_get).toBe('function');
      expect(typeof handlers.state_set).toBe('function');
      expect(typeof handlers.resolve).toBe('function');
      expect(typeof handlers.respond).toBe('function');

      // External handlers
      expect(typeof handlers.trace).toBe('function');
      expect(typeof handlers.inspect).toBe('function');
      expect(typeof handlers.status).toBe('function');
      expect(typeof handlers.listAgents).toBe('function');
      expect(typeof handlers.consolidate).toBe('function');

      // Total: 11 handlers (6 internal + 5 external)
      const handlerKeys = Object.keys(handlers);
      expect(handlerKeys.length).toBe(11);
    });
  });

  describe('Contract 8: Zod Schema Validation', () => {
    it('[MUST-PASS-AT-PHASE-3] should accept valid InvokeEnvelope', () => {
      // SPEC: InvokeEnvelope has trace_id, task_id, caller, target, function, call_stack, mode, max_depth
      const valid = {
        trace_id: 'tr-001',
        task_id: 'tk-001',
        caller: 'src/main.ts',
        target: 'src/utils.ts',
        function: 'handleRequest',
        call_stack: ['src/main.ts'],
        mode: 'sync',
        max_depth: 5,
      };
      const result = InvokeEnvelopeSchema.parse(valid);
      expect(result.trace_id).toBe('tr-001');
      expect(result.target).toBe('src/utils.ts');
      expect(result.mode).toBe('sync');
    });

    it('[MUST-PASS-AT-PHASE-3] should reject InvokeEnvelope with missing required fields', () => {
      // SPEC: All required fields must be present
      // Empty object — missing everything
      expect(() => InvokeEnvelopeSchema.parse({})).toThrow();

      // Missing target and function
      expect(() => InvokeEnvelopeSchema.parse({
        trace_id: 'tr-001',
        task_id: 'tk-001',
        caller: 'a.ts',
      })).toThrow();

      // Invalid mode value
      expect(() => InvokeEnvelopeSchema.parse({
        trace_id: 'tr-001',
        task_id: 'tk-001',
        caller: 'a.ts',
        target: 'b.ts',
        function: 'foo',
        call_stack: [],
        mode: 'invalid_mode',
        max_depth: 5,
      })).toThrow();
    });

    it('[MUST-PASS-AT-PHASE-3] should accept valid ResponseEnvelope', () => {
      // SPEC: ResponseEnvelope has task_id, responder, source_refs (min 1)
      const valid = {
        task_id: 'tk-001',
        responder: 'src/utils.ts',
        source_refs: ['src/utils.ts:10-20'],
        returns: { value: 42 },
      };
      const result = ResponseEnvelopeSchema.parse(valid);
      expect(result.task_id).toBe('tk-001');
      expect(result.responder).toBe('src/utils.ts');
      expect(result.source_refs).toHaveLength(1);
    });

    it('[MUST-PASS-AT-PHASE-3] should reject ResponseEnvelope with invalid structure', () => {
      // SPEC: ResponseEnvelope requires task_id, responder, source_refs
      // Empty object
      expect(() => ResponseEnvelopeSchema.parse({})).toThrow();

      // Missing responder and source_refs
      expect(() => ResponseEnvelopeSchema.parse({ task_id: 'tk-001' })).toThrow();

      // SPEC: source_refs must be non-empty (.min(1))
      expect(() => ResponseEnvelopeSchema.parse({
        task_id: 'tk-001',
        responder: 'b.ts',
        source_refs: [],  // Empty array violates min(1)
      })).toThrow();
    });

    it('[MUST-PASS-AT-PHASE-3] should validate nested trace entries in ResponseEnvelope', () => {
      // SPEC: TraceEntrySchema validates trace log entries with required fields
      const validTrace = TraceEntrySchema.parse({
        trace_id: 'tr-001',
        task_id: 'tk-001',
        timestamp: new Date(),
        depth: 0,
        caller: 'src/main.ts',
        target: 'src/utils.ts',
        function: 'handleRequest',
        call_stack: ['src/main.ts'],
      });
      expect(validTrace).toBeDefined();
      expect(validTrace.trace_id).toBe('tr-001');
      expect(validTrace.depth).toBe(0);
      expect(validTrace.caller).toBe('src/main.ts');

      // Invalid: missing required fields
      expect(() => TraceEntrySchema.parse({
        trace_id: 'tr-001',
        // missing task_id, timestamp, depth, caller, target, function, call_stack
      })).toThrow();

      // Invalid: wrong types
      expect(() => TraceEntrySchema.parse({
        trace_id: 'tr-001',
        task_id: 'tk-001',
        timestamp: 'not-a-date',  // Should be Date
        depth: -1,  // Nonnegative required... actually -1 would fail
        caller: 'a.ts',
        target: 'b.ts',
        function: 'foo',
        call_stack: [],
      })).toThrow();
    });
  });
});
