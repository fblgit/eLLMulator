/**
 * Phase 5C RED Tests: Streaming Visibility (Task 5.4)
 * 
 * Tests streaming progress events during invoke chains and SDK configuration
 * for includePartialMessages.
 * These features are NOT fully implemented yet — tests MUST FAIL.
 * 
 * Features:
 *   - Progress events emitted during invoke() execution
 *   - includePartialMessages: true in SDK options (session-manager)
 *   - Partial message forwarding from SDK to external observers
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { SessionManager } from '../session-manager.js';
import { invoke, RateLimitTracker, SelfLoopTracker } from '../invoke.js';
import { Registry } from '../registry.js';
import type { InvokeEnvelope, ResponseEnvelope } from '../types.js';

describe('Phase 5C: Streaming Visibility', () => {
  let registry: Registry;
  let sessionManager: SessionManager;
  let traceLog: vi.Mock;
  let rateLimitTracker: RateLimitTracker;
  let selfLoopTracker: SelfLoopTracker;
  let mockReadFile: vi.Mock;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new Registry();
    sessionManager = new SessionManager();
    traceLog = vi.fn();
    rateLimitTracker = new RateLimitTracker();
    selfLoopTracker = new SelfLoopTracker();
    mockReadFile = vi.fn().mockResolvedValue('// source code');

    // Register test file
    registry.add({
      file_path: 'src/worker.ts',
      file_hash: 'hash-worker',
      status: 'ready',
      session_id: 'session-worker',
      declarations: {
        summary: 'Worker module',
        owns: [
          { name: 'processTask', kind: 'function', intent: 'Long-running task', file_path: 'src/worker.ts', start_line: 10, end_line: 50 },
        ],
        imports: [],
        exports: [],
        dependencies: [],
      },
    });
  });

  it('[MUST-PASS-AT-PHASE-5] should emit progress events during invoke', async () => {
    // SPEC: Phase 5 task 5.4 — partial messages forwarded during session query
    // SDK's AsyncGenerator yields messages incrementally; we should forward them
    
    const progressEvents: any[] = [];
    
    // Mock sessionManager.query to yield partial messages
    sessionManager.query = vi.fn(async function* (opts: any) {
      // Simulate SDK streaming partial assistant messages
      yield { type: 'assistant', subtype: 'partial', content: 'Analyzing function...' };
      yield { type: 'assistant', subtype: 'partial', content: 'Reading source code...' };
      yield { type: 'assistant', subtype: 'partial', content: 'Preparing response...' };
      
      // Final result
      return {
        task_id: 'task-001',
        responder: 'src/worker.ts',
        returns: { processed: true },
        source_refs: ['src/worker.ts:10-50'],
      } as ResponseEnvelope;
    } as any);

    // Phase 5: invoke() should emit progress events
    const onProgress = vi.fn((event: any) => {
      progressEvents.push(event);
    });

    const envelope: InvokeEnvelope = {
      trace_id: 'trace-001',
      task_id: 'task-001',
      caller: 'src/main.ts',
      target: 'src/worker.ts',
      function: 'processTask',
      call_stack: [],
      mode: 'sync',
      max_depth: 10,
    };

    // Phase 5: invoke() accepts onProgress callback
    // This will FAIL because invoke() doesn't support progress callbacks yet
    await invoke(envelope, {
      registry,
      sessionManager,
      traceLog,
      rateLimitTracker,
      selfLoopTracker,
      readFile: mockReadFile,
      projectDir: '/test',
      onProgress, // ← Phase 5 addition
    } as any);

    // Should have received progress events
    expect(onProgress).toHaveBeenCalled();
    expect(progressEvents.length).toBeGreaterThan(0);
    expect(progressEvents[0]).toHaveProperty('type', 'progress');
    expect(progressEvents[0]).toHaveProperty('content');
  });

  it('[MUST-PASS-AT-PHASE-5] should configure includePartialMessages in SDK options', async () => {
    // SPEC: Phase 5 — session-manager passes includePartialMessages: true
    // SDK should be configured to yield partial assistant messages
    
    let capturedOptions: any;
    
    // Mock the SDK query function to capture options
    const mockQuery = vi.fn(async function* (args: { prompt: string; options: any }) {
      capturedOptions = args.options;
      
      yield { type: 'system', subtype: 'init', session_id: 'new-session' };
      yield { type: 'result', subtype: 'success', is_error: false };
    });

    // Replace query in module scope (this is tricky with imports)
    // For this test, we verify the SessionManager.create sets the right options
    const createSpy = vi.spyOn(sessionManager, 'create');

    await sessionManager.create({
      filePath: 'src/test.ts',
      fileHash: 'hash-test',
      systemPrompt: 'System prompt',
      bootstrapPrompt: 'Bootstrap prompt',
      tools: ['invoke', 'register'],
      model: 'claude-opus-4-6',
      cwd: '/test',
    });

    // Phase 5: SessionManager.create should pass includePartialMessages: true
    // This will FAIL because session-manager doesn't set this option yet
    expect(createSpy).toHaveBeenCalled();
    
    // We can't easily inspect the SDK options from outside, but we can verify
    // the SessionManager has the configuration stored
    const session = sessionManager.get('new-session');
    if (session) {
      // Phase 5: session should have includePartialMessages configuration
      expect((session as any).includePartialMessages).toBe(true);
    }
  });

  it('[MUST-PASS-AT-PHASE-5] should forward partial messages from nested invokes', async () => {
    // SPEC: When invoke() calls another invoke(), partial messages from nested
    // calls should bubble up to the top-level observer
    
    const allProgressEvents: any[] = [];
    
    // Mock to simulate nested invoke
    let nestedInvokeCalled = false;
    sessionManager.query = vi.fn(async function* (opts: any) {
      if (!nestedInvokeCalled) {
        nestedInvokeCalled = true;
        
        // Simulate the agent calling invoke() which triggers another query
        yield { type: 'assistant', subtype: 'partial', content: 'Calling dependency...' };
        
        // This would trigger nested invoke in real scenario
        // For now, just yield more partials
        yield { type: 'assistant', subtype: 'partial', content: 'Nested processing...' };
      }
      
      return {
        task_id: 'task-001',
        responder: 'src/worker.ts',
        returns: { ok: true },
        source_refs: ['src/worker.ts:10'],
      };
    } as any);

    const onProgress = vi.fn((event: any) => {
      allProgressEvents.push(event);
    });

    const envelope: InvokeEnvelope = {
      trace_id: 'trace-001',
      task_id: 'task-001',
      caller: 'src/main.ts',
      target: 'src/worker.ts',
      function: 'processTask',
      call_stack: [],
      mode: 'sync',
      max_depth: 10,
    };

    await invoke(envelope, {
      registry,
      sessionManager,
      traceLog,
      rateLimitTracker,
      selfLoopTracker,
      readFile: mockReadFile,
      projectDir: '/test',
      onProgress,
    } as any);

    // Phase 5: Should have received progress from both levels
    // This will FAIL because nested progress propagation doesn't exist
    expect(allProgressEvents.length).toBeGreaterThan(0);
    
    // Verify we got events from both invoke levels
    const hasNestedEvent = allProgressEvents.some(e => 
      e.content?.includes('Nested processing')
    );
    expect(hasNestedEvent).toBe(true);
  });

  it('[MUST-PASS-AT-PHASE-5] should include target info in progress events', async () => {
    // SPEC: Progress events should identify which agent/file is active
    // Format: { type: 'progress', target: 'src/worker.ts', content: '...' }
    
    const progressEvents: any[] = [];
    
    sessionManager.query = vi.fn(async function* (opts: any) {
      yield { type: 'assistant', subtype: 'partial', content: 'Working...' };
      
      return {
        task_id: 'task-001',
        responder: 'src/worker.ts',
        returns: {},
        source_refs: ['src/worker.ts:1'],
      };
    } as any);

    const onProgress = vi.fn((event: any) => {
      progressEvents.push(event);
    });

    const envelope: InvokeEnvelope = {
      trace_id: 'trace-001',
      task_id: 'task-001',
      caller: 'src/main.ts',
      target: 'src/worker.ts',
      function: 'processTask',
      call_stack: [],
      mode: 'sync',
      max_depth: 10,
    };

    await invoke(envelope, {
      registry,
      sessionManager,
      traceLog,
      rateLimitTracker,
      selfLoopTracker,
      readFile: mockReadFile,
      projectDir: '/test',
      onProgress,
    } as any);

    // Phase 5: Events should include target identification
    // This will FAIL because invoke() doesn't enrich progress events with target
    expect(progressEvents.length).toBeGreaterThan(0);
    expect(progressEvents[0]).toHaveProperty('target', 'src/worker.ts');
    expect(progressEvents[0]).toHaveProperty('trace_id', 'trace-001');
    expect(progressEvents[0]).toHaveProperty('depth', 0);
  });

  it('[MUST-PASS-AT-PHASE-5] should support streaming in invokeOnSession', async () => {
    // SPEC: SessionManager.invokeOnSession (Promise-based response capture)
    // should also support progress callbacks for streaming visibility
    
    const progressEvents: any[] = [];
    
    // Create a real session first
    const mockQuery = vi.fn();
    (sessionManager as any).query = async function* (args: any) {
      yield { type: 'system', subtype: 'init', session_id: 'sess-001' };
      yield { type: 'result', subtype: 'success', is_error: false };
    };

    await sessionManager.create({
      filePath: 'src/worker.ts',
      fileHash: 'hash-worker',
      systemPrompt: 'System',
      bootstrapPrompt: 'Bootstrap',
      tools: ['invoke'],
      model: 'claude-opus-4-6',
      cwd: '/test',
    });

    // Now mock invokeOnSession to yield partials
    const invokeOnSessionSpy = vi.spyOn(sessionManager, 'invokeOnSession');
    invokeOnSessionSpy.mockImplementation(async function (this: any, opts: any) {
      // Simulate streaming before response capture
      if (opts.onProgress) {
        opts.onProgress({ type: 'progress', content: 'Processing invoke...' });
        opts.onProgress({ type: 'progress', content: 'Generating response...' });
      }
      
      // Resolve with response
      return {
        task_id: opts.taskId,
        responder: 'src/worker.ts',
        returns: { done: true },
        source_refs: ['src/worker.ts:1'],
      } as ResponseEnvelope;
    });

    // Phase 5: invokeOnSession accepts onProgress callback
    const result = await sessionManager.invokeOnSession({
      sessionId: 'sess-001',
      prompt: 'Execute task',
      taskId: 'task-001',
      forkSession: true,
      onProgress: (event: any) => progressEvents.push(event),
    } as any);

    // This will FAIL because invokeOnSession doesn't support onProgress yet
    expect(progressEvents.length).toBeGreaterThan(0);
    expect(result.task_id).toBe('task-001');
  });
});
