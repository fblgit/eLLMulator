/**
 * Phase 5A RED Tests: Trace Mode Routing (Task 5.1)
 * 
 * Tests the three trace modes: full (default), targeted, lens.
 * These features are NOT implemented yet — tests MUST FAIL.
 * 
 * Feature: TraceRequest.mode parameter controls how invoke() flows:
 *   - full: trace everything (current behavior, default)
 *   - targeted: follow specific path, skip irrelevant branches
 *   - lens: deep-dive single function, stub outbound calls
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock SDK to prevent real API calls (summarizeTraceAsync + detectEntryPoint use query())
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

import { createTraceHandler } from '../mcp-external.js';
import { Registry } from '../registry.js';
import { SessionManager } from '../session-manager.js';
import { TraceLog } from '../trace-log.js';
import { invoke } from '../invoke.js';
import type { InvokeEnvelope, ResponseEnvelope, TraceRequest } from '../types.js';

describe('Phase 5A: Trace Mode Routing', () => {
  let registry: Registry;
  let sessionManager: SessionManager;
  let traceLog: TraceLog;
  let syntheticState: Map<string, unknown>;
  let mockInvoke: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new Registry();
    sessionManager = new SessionManager();
    traceLog = new TraceLog();
    syntheticState = new Map();

    // Mock invoke for controlled responses
    mockInvoke = vi.fn(async (envelope: InvokeEnvelope) => {
      const response: ResponseEnvelope = {
        task_id: envelope.task_id,
        responder: envelope.target,
        returns: { result: `executed ${envelope.function}` },
        source_refs: [`${envelope.target}:1-10`],
      };
      return response;
    });

    // Register test files
    registry.add({
      file_path: 'src/main.ts',
      file_hash: 'hash-main',
      status: 'ready',
      session_id: 'session-main',
      declarations: {
        summary: 'Main entry point',
        owns: [
          { name: 'handleRequest', kind: 'function', intent: 'Handle HTTP request', file_path: 'src/main.ts', start_line: 10, end_line: 30 },
        ],
        imports: [],
        exports: [],
        dependencies: ['src/auth.ts', 'src/db.ts'],
      },
    });

    registry.add({
      file_path: 'src/auth.ts',
      file_hash: 'hash-auth',
      status: 'ready',
      session_id: 'session-auth',
      declarations: {
        summary: 'Authentication',
        owns: [
          { name: 'authenticate', kind: 'function', intent: 'Verify credentials', file_path: 'src/auth.ts', start_line: 5, end_line: 20 },
        ],
        imports: [],
        exports: [],
        dependencies: [],
      },
    });

    registry.add({
      file_path: 'src/db.ts',
      file_hash: 'hash-db',
      status: 'ready',
      session_id: 'session-db',
      declarations: {
        summary: 'Database operations',
        owns: [
          { name: 'query', kind: 'function', intent: 'Execute SQL query', file_path: 'src/db.ts', start_line: 8, end_line: 25 },
        ],
        imports: [],
        exports: [],
        dependencies: [],
      },
    });
  });

  it('[MUST-PASS-AT-PHASE-5] should accept mode parameter in trace request', async () => {
    // SPEC: TraceRequest.mode is optional, defaults to 'full'
    // Phase 5 adds support for 'targeted' and 'lens' modes
    
    const traceHandler = createTraceHandler({
      registry,
      sessionManager,
      traceLog,
      syntheticState: { get: (k) => syntheticState.get(k), set: (k, v) => syntheticState.set(k, v) },
      invoke: mockInvoke,
    });

    const request: TraceRequest = {
      scenario: 'Test targeted mode',
      entry_point: 'src/main.ts',
      mode: 'targeted', // ← This should be accepted and flow through
      max_depth: 5,
    };

    const result = await traceHandler(request);

    // The mode should be captured in the trace result or entries
    // Currently mode is NOT passed through to invoke envelope — test will FAIL
    expect(result).toBeDefined();
    
    // Verify mode was passed through to the invoke envelope
    expect(mockInvoke).toHaveBeenCalled();
    const firstCallEnvelope = mockInvoke.mock.calls[0][0] as InvokeEnvelope;
    expect(firstCallEnvelope.mode).toBe('sync'); // Current code only supports 'sync'
    
    // Phase 5: mode should be 'targeted' when implemented
    // This assertion will FAIL until Phase 5 implements mode routing
    expect(firstCallEnvelope).toHaveProperty('traceMode'); // New field added in Phase 5
    expect((firstCallEnvelope as any).traceMode).toBe('targeted');
  });

  it('[MUST-PASS-AT-PHASE-5] should skip irrelevant branches in targeted mode', async () => {
    // SPEC: In targeted mode, invoke() should only follow the specified path
    // Irrelevant branches (like auth when targeting db) should be skipped
    
    // Set up invoke to track which targets are called
    const calledTargets: string[] = [];
    mockInvoke.mockImplementation(async (envelope: InvokeEnvelope) => {
      calledTargets.push(envelope.target);
      
      // Simulate main.ts calling both auth and db
      if (envelope.target === 'src/main.ts') {
        // In targeted mode with target path 'main→db', auth should be skipped
        // But current implementation doesn't support this
        return {
          task_id: envelope.task_id,
          responder: envelope.target,
          returns: { authCalled: true, dbCalled: true },
          source_refs: [`${envelope.target}:10-30`],
        };
      }
      
      return {
        task_id: envelope.task_id,
        responder: envelope.target,
        returns: { result: 'ok' },
        source_refs: [`${envelope.target}:1-10`],
      };
    });

    const traceHandler = createTraceHandler({
      registry,
      sessionManager,
      traceLog,
      syntheticState: { get: (k) => syntheticState.get(k), set: (k, v) => syntheticState.set(k, v) },
      invoke: mockInvoke,
    });

    const request: TraceRequest = {
      scenario: 'Test path from main to db, skip auth',
      entry_point: 'src/main.ts',
      mode: 'targeted',
      // Phase 5 adds: targetPath: ['src/main.ts', 'src/db.ts']
      max_depth: 5,
    };

    await traceHandler(request);

    // In targeted mode, only the specified path should be invoked
    // Phase 5: src/auth.ts should NOT appear in calledTargets
    // This assertion will FAIL because current code doesn't implement targeted mode
    expect(calledTargets).not.toContain('src/auth.ts');
    expect(calledTargets).toContain('src/main.ts');
    expect(calledTargets).toContain('src/db.ts');
  });

  it('[MUST-PASS-AT-PHASE-5] should stub outbound calls in lens mode', async () => {
    // SPEC: Lens mode deep-dives one function, stubs all outbound calls
    // Outbound calls return stub responses, not actual invocations
    
    const actualInvokeCalls: string[] = [];
    mockInvoke.mockImplementation(async (envelope: InvokeEnvelope) => {
      actualInvokeCalls.push(envelope.target);
      
      // Simulate src/main.ts calling auth and db
      return {
        task_id: envelope.task_id,
        responder: envelope.target,
        returns: { result: 'executed' },
        source_refs: [`${envelope.target}:1-10`],
      };
    });

    const traceHandler = createTraceHandler({
      registry,
      sessionManager,
      traceLog,
      syntheticState: { get: (k) => syntheticState.get(k), set: (k, v) => syntheticState.set(k, v) },
      invoke: mockInvoke,
    });

    const request: TraceRequest = {
      scenario: 'Deep-dive main.ts, stub dependencies',
      entry_point: 'src/main.ts',
      mode: 'lens',
      // Phase 5 adds: lensFocus: 'src/main.ts'
      max_depth: 5,
    };

    await traceHandler(request);

    // In lens mode, only the focus file should be actually invoked
    // Dependencies (auth, db) should be stubbed — NO real invoke
    // Phase 5: only src/main.ts should appear in actualInvokeCalls
    // This assertion will FAIL because current code doesn't implement lens mode
    expect(actualInvokeCalls).toHaveLength(1);
    expect(actualInvokeCalls[0]).toBe('src/main.ts');
    
    // Verify that stub responses were generated for dependencies
    const entries = traceLog.list();
    const authEntry = entries.find(e => e.target === 'src/auth.ts');
    const dbEntry = entries.find(e => e.target === 'src/db.ts');
    
    // Phase 5: these entries should exist with stubbed=true marker
    expect(authEntry).toBeDefined();
    expect(dbEntry).toBeDefined();
    expect((authEntry as any).stubbed).toBe(true);
    expect((dbEntry as any).stubbed).toBe(true);
  });

  it('[MUST-PASS-AT-PHASE-5] should pass mode through invoke chain recursively', async () => {
    // SPEC: When invoke() calls another invoke(), mode should propagate
    // Nested invokes in targeted mode should also skip irrelevant branches
    
    let nestedInvokeCount = 0;
    mockInvoke.mockImplementation(async (envelope: InvokeEnvelope) => {
      nestedInvokeCount++;
      
      // Verify mode is present in envelope at all levels
      // Phase 5: envelope should have traceMode field
      expect(envelope).toHaveProperty('mode');
      
      // This will FAIL because Phase 5 hasn't added traceMode propagation
      expect((envelope as any).traceMode).toBeDefined();
      expect((envelope as any).traceMode).toBe('targeted');
      
      return {
        task_id: envelope.task_id,
        responder: envelope.target,
        returns: { nested: true },
        source_refs: [`${envelope.target}:1-5`],
      };
    });

    const traceHandler = createTraceHandler({
      registry,
      sessionManager,
      traceLog,
      syntheticState: { get: (k) => syntheticState.get(k), set: (k, v) => syntheticState.set(k, v) },
      invoke: mockInvoke,
    });

    const request: TraceRequest = {
      scenario: 'Nested invoke with mode propagation',
      entry_point: 'src/main.ts',
      mode: 'targeted',
      max_depth: 5,
    };

    await traceHandler(request);

    // All invoke calls should have received the mode
    expect(nestedInvokeCount).toBeGreaterThan(0);
  });
});
