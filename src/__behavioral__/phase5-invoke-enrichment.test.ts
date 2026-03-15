/**
 * Phase 5B RED Tests: Invoke Chain Enrichment (Tasks 5.2 + 5.3)
 * 
 * Tests enriched invoke prompts with prior span summaries, expected_output,
 * and retry logic for schema violations.
 * These features are NOT implemented yet — tests MUST FAIL.
 * 
 * Features:
 *   - Prior span summaries (caller/callee/input/output) in invoke prompt
 *   - Retry on respond() schema violation (max 2 retries)
 *   - expected_output context in invoke prompt
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { invoke, RateLimitTracker, SelfLoopTracker } from '../invoke.js';
import { Registry } from '../registry.js';
import { SessionManager } from '../session-manager.js';
import { renderInvokePrompt } from '../templates.js';
import type { InvokeEnvelope, ResponseEnvelope, TraceEntry } from '../types.js';

describe('Phase 5B: Invoke Chain Enrichment', () => {
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

    // Register files
    registry.add({
      file_path: 'src/caller.ts',
      file_hash: 'hash-caller',
      status: 'ready',
      session_id: 'session-caller',
      declarations: {
        summary: 'Caller module',
        owns: [
          { name: 'processBatch', kind: 'function', intent: 'Process items in batch', file_path: 'src/caller.ts', start_line: 10, end_line: 40 },
        ],
        imports: [],
        exports: [],
        dependencies: ['src/target.ts'],
      },
    });

    registry.add({
      file_path: 'src/target.ts',
      file_hash: 'hash-target',
      status: 'ready',
      session_id: 'session-target',
      declarations: {
        summary: 'Target module',
        owns: [
          { name: 'processItem', kind: 'function', intent: 'Process single item', file_path: 'src/target.ts', start_line: 5, end_line: 20 },
        ],
        imports: [],
        exports: [],
        dependencies: [],
      },
    });

    registry.add({
      file_path: 'src/main.ts',
      file_hash: 'hash-main',
      status: 'ready',
      session_id: 'session-main',
      declarations: {
        summary: 'Main entry point',
        owns: [
          { name: 'handleRequest', kind: 'function', intent: 'Handle incoming requests', file_path: 'src/main.ts', start_line: 1, end_line: 30 },
        ],
        imports: [],
        exports: [],
        dependencies: ['src/caller.ts'],
      },
    });
  });

  it('[MUST-PASS-AT-PHASE-5] should include prior span summaries in invoke prompt', async () => {
    // SPEC: Phase 5 task 5.2 — pass summarized span data in invoke context
    // Prior spans = caller/callee/input/output from earlier in the call chain
    
    let capturedPrompt: string | undefined;
    
    // Mock sessionManager.query to capture the prompt
    sessionManager.query = vi.fn(async (opts: any) => {
      capturedPrompt = opts.prompt;
      return {
        task_id: 'task-001',
        responder: 'src/target.ts',
        returns: { processed: true },
        source_refs: ['src/target.ts:5-20'],
      } as ResponseEnvelope;
    });

    const envelope: InvokeEnvelope = {
      trace_id: 'trace-001',
      task_id: 'task-001',
      caller: 'src/caller.ts',
      target: 'src/target.ts',
      function: 'processItem',
      params: { item: { id: 1, name: 'test' } },
      call_stack: ['src/main.ts', 'src/caller.ts'], // Prior spans exist
      mode: 'sync',
      max_depth: 10,
    };

    // Simulate prior trace entries (spans)
    const priorSpans: TraceEntry[] = [
      {
        trace_id: 'trace-001',
        task_id: 'task-000',
        timestamp: new Date(),
        depth: 0,
        caller: '__trace_initiator__',
        target: 'src/main.ts',
        function: 'handleRequest',
        params: { request: 'GET /api/items' },
        result: { status: 'processing' },
        call_stack: [],
      },
      {
        trace_id: 'trace-001',
        task_id: 'task-001',
        timestamp: new Date(),
        depth: 1,
        caller: 'src/main.ts',
        target: 'src/caller.ts',
        function: 'processBatch',
        params: { items: [{ id: 1 }] },
        result: { batchStarted: true },
        call_stack: ['src/main.ts'],
      },
    ];

    // Phase 5: invoke() should read prior spans and include summaries in prompt
    await invoke(envelope, {
      registry,
      sessionManager,
      traceLog,
      rateLimitTracker,
      selfLoopTracker,
      readFile: mockReadFile,
      projectDir: '/test',
    });

    expect(capturedPrompt).toBeDefined();
    
    // Phase 5: prompt should contain prior span information
    // This will FAIL because current renderInvokePrompt doesn't include prior spans
    expect(capturedPrompt).toContain('Prior Trace Spans');
    expect(capturedPrompt).toContain('src/main.ts');
    expect(capturedPrompt).toContain('handleRequest');
    expect(capturedPrompt).toContain('processBatch');
  });

  it('[MUST-PASS-AT-PHASE-5] should retry on respond schema violation', async () => {
    // SPEC: Phase 5 task 5.3 — if respond() fails zod validation, re-prompt (max 2 retries)
    
    let queryCallCount = 0;
    const invalidResponse = {
      task_id: 'task-001',
      responder: 'src/target.ts',
      // Missing source_refs — schema violation!
      returns: { result: 'ok' },
    };
    
    const validResponse = {
      task_id: 'task-001',
      responder: 'src/target.ts',
      returns: { result: 'ok' },
      source_refs: ['src/target.ts:5-20'], // Now valid
    };

    sessionManager.query = vi.fn(async (opts: any) => {
      queryCallCount++;
      
      // First call: return invalid response (missing source_refs)
      if (queryCallCount === 1) {
        return invalidResponse;
      }
      
      // Second call (retry): return valid response
      return validResponse;
    });

    const envelope: InvokeEnvelope = {
      trace_id: 'trace-001',
      task_id: 'task-001',
      caller: 'src/caller.ts',
      target: 'src/target.ts',
      function: 'processItem',
      params: { item: 'test' },
      call_stack: [],
      mode: 'sync',
      max_depth: 10,
    };

    // Phase 5: invoke() should retry on schema validation failure
    const result = await invoke(envelope, {
      registry,
      sessionManager,
      traceLog,
      rateLimitTracker,
      selfLoopTracker,
      readFile: mockReadFile,
      projectDir: '/test',
    });

    // Phase 5: Should have called query twice (initial + 1 retry)
    // This will FAIL because current invoke() doesn't validate or retry
    expect(queryCallCount).toBe(2);
    expect(result.source_refs).toEqual(['src/target.ts:5-20']);
  });

  it('[MUST-PASS-AT-PHASE-5] should include expected_output context in invoke prompt', async () => {
    // SPEC: Phase 5 task 5.3 — expected_output enriches invoke prompt
    // POC pattern P2: caller tells target what return shape/semantics it expects
    
    let capturedPrompt: string | undefined;
    
    sessionManager.query = vi.fn(async (opts: any) => {
      capturedPrompt = opts.prompt;
      return {
        task_id: 'task-001',
        responder: 'src/target.ts',
        returns: { id: 1, status: 'processed' },
        source_refs: ['src/target.ts:5-20'],
      };
    });

    const envelope: InvokeEnvelope = {
      trace_id: 'trace-001',
      task_id: 'task-001',
      caller: 'src/caller.ts',
      target: 'src/target.ts',
      function: 'processItem',
      params: { item: { id: 1 } },
      expected_output: 'Return object with id and status fields', // ← Phase 5 field
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
    });

    expect(capturedPrompt).toBeDefined();
    
    // Phase 5: prompt should contain expected_output guidance
    // This will FAIL because renderInvokePrompt doesn't use expected_output yet
    expect(capturedPrompt).toContain('Expected Output');
    expect(capturedPrompt).toContain('Return object with id and status fields');
  });

  it('[MUST-PASS-AT-PHASE-5] should stop retrying after max retries and throw', async () => {
    // SPEC: Max 2 retries on schema violation, then throw
    
    let queryCallCount = 0;
    const invalidResponse = {
      task_id: 'task-001',
      responder: 'src/target.ts',
      returns: { result: 'ok' },
      // Always missing source_refs
    };

    sessionManager.query = vi.fn(async (opts: any) => {
      queryCallCount++;
      return invalidResponse; // Always invalid
    });

    const envelope: InvokeEnvelope = {
      trace_id: 'trace-001',
      task_id: 'task-001',
      caller: 'src/caller.ts',
      target: 'src/target.ts',
      function: 'processItem',
      params: { item: 'test' },
      call_stack: [],
      mode: 'sync',
      max_depth: 10,
    };

    // Phase 5: Should throw after exhausting retries
    // This will FAIL because current code doesn't retry or validate
    await expect(invoke(envelope, {
      registry,
      sessionManager,
      traceLog,
      rateLimitTracker,
      selfLoopTracker,
      readFile: mockReadFile,
      projectDir: '/test',
    })).rejects.toThrow(/INVALID_RESPONSE_ENVELOPE/);

    // Should have attempted: initial + 2 retries = 3 calls
    expect(queryCallCount).toBe(3);
  });

  it('[MUST-PASS-AT-PHASE-5] should format prior spans as concise summaries', async () => {
    // SPEC: Prior spans should be summarized (not full entries) to save tokens
    // Format: "depth N: caller → target.function(params) → result"
    
    let capturedPrompt: string | undefined;
    
    sessionManager.query = vi.fn(async (opts: any) => {
      capturedPrompt = opts.prompt;
      return {
        task_id: 'task-001',
        responder: 'src/target.ts',
        returns: { ok: true },
        source_refs: ['src/target.ts:1'],
      };
    });

    const envelope: InvokeEnvelope = {
      trace_id: 'trace-001',
      task_id: 'task-003',
      caller: 'src/caller.ts',
      target: 'src/target.ts',
      function: 'processItem',
      params: { id: 3 },
      call_stack: ['src/main.ts', 'src/caller.ts'], // 2 prior hops
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
    });

    // Phase 5: Prior spans should be formatted concisely
    // This will FAIL because current code doesn't include prior spans at all
    expect(capturedPrompt).toBeDefined();
    expect(capturedPrompt).toMatch(/depth \d+:/); // Contains depth indicator
    expect(capturedPrompt).toMatch(/→/); // Contains flow arrows
  });

  it('[MUST-PASS-AT-PHASE-5] should pass validation error details to retry prompt', async () => {
    // SPEC: When retrying, include what was wrong with previous response
    
    let promptHistory: string[] = [];
    let queryCallCount = 0;

    const responses = [
      { task_id: 'task-001', responder: 'src/target.ts', returns: {} }, // Missing source_refs
      { task_id: 'task-001', responder: 'src/target.ts', returns: {}, source_refs: ['src/target.ts:1'] }, // Valid
    ];

    sessionManager.query = vi.fn(async (opts: any) => {
      promptHistory.push(opts.prompt);
      return responses[queryCallCount++];
    });

    const envelope: InvokeEnvelope = {
      trace_id: 'trace-001',
      task_id: 'task-001',
      caller: 'src/caller.ts',
      target: 'src/target.ts',
      function: 'processItem',
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
    });

    // Phase 5: Retry prompt should mention the validation error
    // This will FAIL because retry mechanism doesn't exist yet
    expect(promptHistory).toHaveLength(2);
    expect(promptHistory[1]).toContain('source_refs'); // Mentions missing field
    expect(promptHistory[1]).toContain('MANDATORY'); // Mentions requirement
  });
});
