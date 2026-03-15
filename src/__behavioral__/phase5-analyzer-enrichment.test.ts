/**
 * Phase 5F RED Tests: Analyzer Enrichment (Tasks 5.6 + 5.7)
 * 
 * Tests LLM-based trace summary and smart entry point detection.
 * These features are NOT implemented yet — tests MUST FAIL.
 * 
 * Features:
 *   - LLM-generated trace summary using SDK query() instead of template
 *   - Smart entry point detection from starmap and declarations
 *   - Natural language analysis of trace behavior
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { summarizeTraceAsync, analyzeTrace, detectEntryPoint, analyzeTraceWithObservations } from '../analyzer.js';
import { Registry } from '../registry.js';
import { createStarmap } from '../starmap.js';
import type { TraceEntry } from '../types.js';
import { query } from '@anthropic-ai/claude-agent-sdk';

// Mock the SDK query function
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

describe('Phase 5F: Analyzer Enrichment', () => {
  let registry: Registry;

  beforeEach(() => {
    vi.clearAllMocks();
    registry = new Registry();
  });

  it('[MUST-PASS-AT-PHASE-5] should generate LLM-based trace summary', async () => {
    // SPEC: Phase 5 task 5.6 — analyzer uses SDK query() for natural language summary
    // Instead of template string, call LLM to analyze trace entries
    
    const entries: TraceEntry[] = [
      {
        trace_id: 'trace-001',
        task_id: 'task-001',
        timestamp: new Date(),
        depth: 0,
        caller: '__trace_initiator__',
        target: 'src/api.ts',
        function: 'handleRequest',
        params: { method: 'POST', path: '/users' },
        result: { status: 'processing' },
        call_stack: [],
      },
      {
        trace_id: 'trace-001',
        task_id: 'task-002',
        timestamp: new Date(),
        depth: 1,
        caller: 'src/api.ts',
        target: 'src/db.ts',
        function: 'insertUser',
        params: { name: 'Alice' },
        result: { id: 123 },
        call_stack: ['src/api.ts'],
      },
    ];

    // Mock SDK query to return an LLM-generated summary
    const mockQueryGenerator = async function* () {
      yield { type: 'assistant', subtype: 'message', content: 'This trace shows a POST request to create a user. The API handler calls the database layer to insert the user record.' };
      yield { type: 'result', subtype: 'success', is_error: false };
    };
    (query as any).mockReturnValue(mockQueryGenerator());

    // Phase 5: summarizeTrace should use SDK query instead of template
    const summary = await summarizeTraceAsync(entries);

    // This will FAIL because current summarizeTrace uses a template, not SDK
    expect(query).toHaveBeenCalled();
    
    // Verify the prompt sent to SDK includes trace entries
    const queryCall = (query as any).mock.calls[0][0];
    expect(queryCall.prompt).toContain('trace');
    expect(queryCall.prompt).toContain('POST');
    expect(queryCall.prompt).toContain('users');
    
    // Summary should be natural language, not template
    expect(summary).toContain('POST request');
    expect(summary).toContain('create a user');
  });

  it('[MUST-PASS-AT-PHASE-5] should detect entry point from starmap and declarations', async () => {
    // SPEC: Phase 5 task 5.7 — smart entry matching using bootstrapped agent data
    // Instead of just taking first ready file, analyze scenario against declarations
    
    // Register multiple candidates
    registry.add({
      file_path: 'src/api.ts',
      file_hash: 'hash-api',
      status: 'ready',
      session_id: 'session-api',
      declarations: {
        summary: 'HTTP API handlers for user and product endpoints',
        owns: [
          { name: 'handleUserRequest', kind: 'function', intent: 'Handle user CRUD operations', file_path: 'src/api.ts', start_line: 10, end_line: 40 },
          { name: 'handleProductRequest', kind: 'function', intent: 'Handle product operations', file_path: 'src/api.ts', start_line: 42, end_line: 70 },
        ],
        imports: [],
        exports: [],
        dependencies: ['src/db.ts'],
      },
    });

    registry.add({
      file_path: 'src/auth.ts',
      file_hash: 'hash-auth',
      status: 'ready',
      session_id: 'session-auth',
      declarations: {
        summary: 'Authentication and authorization middleware',
        owns: [
          { name: 'authenticate', kind: 'function', intent: 'Verify user credentials', file_path: 'src/auth.ts', start_line: 5, end_line: 25 },
          { name: 'authorize', kind: 'function', intent: 'Check user permissions', file_path: 'src/auth.ts', start_line: 27, end_line: 45 },
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
        owns: [],
        imports: [],
        exports: [],
        dependencies: [],
      },
    });

    // Create starmap
    const starmap = createStarmap(registry);

    // Mock SDK to analyze scenario against declarations
    const mockQueryGenerator = async function* () {
      yield { 
        type: 'assistant', 
        subtype: 'message', 
        content: 'Best entry point: src/api.ts - Handles user requests which matches the scenario.' 
      };
      yield { type: 'result', subtype: 'success', is_error: false };
    };
    (query as any).mockReturnValue(mockQueryGenerator());

    // Phase 5: detectEntryPoint uses LLM + starmap + declarations
    const scenario = 'What happens when a user creates a new account?';
    const entryPoint = await detectEntryPoint(scenario, registry, starmap);

    // This will FAIL because detectEntryPoint doesn't exist yet
    expect(query).toHaveBeenCalled();
    expect(entryPoint).toBe('src/api.ts');
    
    // Verify LLM received scenario + declarations context
    const queryCall = (query as any).mock.calls[0][0];
    expect(queryCall.prompt).toContain(scenario);
    expect(queryCall.prompt).toContain('user');
    expect(queryCall.prompt).toContain('HTTP API handlers');
  });

  it('[MUST-PASS-AT-PHASE-5] should prefer entry points at graph boundaries', async () => {
    // SPEC: Entry detection should favor files with no incoming dependencies
    // (Root nodes in the dependency DAG — likely entry points)
    
    registry.add({
      file_path: 'src/main.ts',
      file_hash: 'hash-main',
      status: 'ready',
      declarations: {
        summary: 'Application entry point',
        owns: [],
        imports: [],
        exports: [],
        dependencies: ['src/api.ts', 'src/config.ts'],
      },
    });

    registry.add({
      file_path: 'src/api.ts',
      file_hash: 'hash-api',
      status: 'ready',
      declarations: {
        summary: 'API routes',
        owns: [],
        imports: [],
        exports: [],
        dependencies: ['src/db.ts'],
      },
    });

    registry.add({
      file_path: 'src/db.ts',
      file_hash: 'hash-db',
      status: 'ready',
      declarations: {
        summary: 'Database layer',
        owns: [],
        imports: [],
        exports: [],
        dependencies: [],
      },
    });

    const starmap = createStarmap(registry);

    // src/main.ts has no dependents → root node
    // src/api.ts has src/main.ts → not a root
    // src/db.ts has src/api.ts → leaf node
    
    const roots = starmap.getClusters().filter(cluster => {
      return cluster.every(file => starmap.getDependents(file).length === 0);
    });

    // Phase 5: detectEntryPoint should prioritize root nodes
    // This will FAIL because smart detection doesn't exist yet
    const mockQueryGenerator = async function* () {
      yield { type: 'assistant', subtype: 'message', content: 'src/main.ts' };
      yield { type: 'result', subtype: 'success', is_error: false };
    };
    (query as any).mockReturnValue(mockQueryGenerator());

    const scenario = 'Application startup';
    const entryPoint = await detectEntryPoint(scenario, registry, starmap);

    expect(entryPoint).toBe('src/main.ts');
  });

  it('[MUST-PASS-AT-PHASE-5] should include observations in trace summary', async () => {
    // SPEC: POC pattern P5 — freeform observations alongside typed findings
    // LLM analyzes trace for architectural insights beyond typed findings
    
    const entries: TraceEntry[] = [
      {
        trace_id: 'trace-001',
        task_id: 'task-001',
        timestamp: new Date(),
        depth: 0,
        caller: '__trace_initiator__',
        target: 'src/api.ts',
        function: 'handleRequest',
        call_stack: [],
      },
      {
        trace_id: 'trace-001',
        task_id: 'task-002',
        timestamp: new Date(),
        depth: 1,
        caller: 'src/api.ts',
        target: 'src/db.ts',
        function: 'query',
        call_stack: ['src/api.ts'],
      },
      {
        trace_id: 'trace-001',
        task_id: 'task-003',
        timestamp: new Date(),
        depth: 1,
        caller: 'src/api.ts',
        target: 'src/cache.ts',
        function: 'get',
        call_stack: ['src/api.ts'],
      },
    ];

    // Mock LLM to generate architectural observation
    const mockQueryGenerator = async function* () {
      yield { 
        type: 'assistant', 
        subtype: 'message', 
        content: JSON.stringify({
          summary: 'API layer queries both database and cache in parallel',
          observations: [
            'The API makes concurrent calls to db and cache — potential race condition if cache writes lag db updates',
            'No error handling visible for cache failures — may cause silent data inconsistency',
          ],
        })
      };
      yield { type: 'result', subtype: 'success', is_error: false };
    };
    (query as any).mockReturnValue(mockQueryGenerator());

    // Phase 5: analyzeTrace returns TraceResult with observations[]
    const result = await analyzeTraceWithObservations(entries, registry);

    // This will FAIL because observations feature doesn't exist yet
    expect(result.observations).toBeDefined();
    expect(result.observations).toHaveLength(2);
    expect(result.observations[0]).toContain('race condition');
    expect(result.observations[1]).toContain('error handling');
  });

  it('[MUST-PASS-AT-PHASE-5] should use concise prompt for LLM summary', async () => {
    // SPEC: LLM prompt for summary should be token-efficient
    // Don't send full trace entries — send structured summary data
    
    const entries: TraceEntry[] = Array.from({ length: 50 }, (_, i) => ({
      trace_id: 'trace-001',
      task_id: `task-${i}`,
      timestamp: new Date(),
      depth: i % 3,
      caller: `src/file${i % 5}.ts`,
      target: `src/file${(i + 1) % 5}.ts`,
      function: `func${i % 10}`,
      call_stack: [],
    }));

    const mockQueryGenerator = async function* () {
      yield { type: 'assistant', subtype: 'message', content: 'Summary generated' };
      yield { type: 'result', subtype: 'success', is_error: false };
    };
    (query as any).mockReturnValue(mockQueryGenerator());

    await summarizeTraceAsync(entries);

    // Phase 5: Prompt should be concise, not full JSON dump
    const queryCall = (query as any).mock.calls[0][0];
    const promptLength = queryCall.prompt.length;
    
    // With 50 entries, prompt should be <5KB (not 50KB)
    expect(promptLength).toBeLessThan(5000);
    
    // Should contain summary data, not full entries
    expect(queryCall.prompt).toContain('50 entries');
    expect(queryCall.prompt).toContain('max depth');
  });

  it('[MUST-PASS-AT-PHASE-5] should handle LLM failure gracefully in summary', async () => {
    // SPEC: If SDK query fails, fall back to template-based summary
    
    const entries: TraceEntry[] = [
      {
        trace_id: 'trace-001',
        task_id: 'task-001',
        timestamp: new Date(),
        depth: 0,
        caller: '__trace_initiator__',
        target: 'src/main.ts',
        function: 'run',
        call_stack: [],
      },
    ];

    // Mock SDK to fail
    const mockQueryGenerator = async function* () {
      yield { type: 'result', subtype: 'error', is_error: true, errors: ['API error'] };
    };
    (query as any).mockReturnValue(mockQueryGenerator());

    // Phase 5: Should fall back to template summary
    const summary = await summarizeTraceAsync(entries);

    // Should still return a valid summary (not throw)
    expect(summary).toBeDefined();
    expect(summary).toContain('1 entries'); // Template fallback
  });

  it('[MUST-PASS-AT-PHASE-5] should match scenario keywords to declaration intents', async () => {
    // SPEC: Entry detection matches scenario keywords against declaration.intent fields
    
    registry.add({
      file_path: 'src/payment.ts',
      file_hash: 'hash-payment',
      status: 'ready',
      declarations: {
        summary: 'Payment processing',
        owns: [
          { name: 'processPayment', kind: 'function', intent: 'Process credit card payment via Stripe API', file_path: 'src/payment.ts', start_line: 10, end_line: 50 },
          { name: 'refundPayment', kind: 'function', intent: 'Initiate payment refund', file_path: 'src/payment.ts', start_line: 52, end_line: 80 },
        ],
        imports: [],
        exports: [],
        dependencies: [],
      },
    });

    registry.add({
      file_path: 'src/email.ts',
      file_hash: 'hash-email',
      status: 'ready',
      declarations: {
        summary: 'Email notifications',
        owns: [
          { name: 'sendEmail', kind: 'function', intent: 'Send transactional email', file_path: 'src/email.ts', start_line: 5, end_line: 30 },
        ],
        imports: [],
        exports: [],
        dependencies: [],
      },
    });

    const starmap = createStarmap(registry);

    const mockQueryGenerator = async function* () {
      yield { type: 'assistant', subtype: 'message', content: 'src/payment.ts' };
      yield { type: 'result', subtype: 'success', is_error: false };
    };
    (query as any).mockReturnValue(mockQueryGenerator());

    // Scenario mentions "refund" — should match src/payment.ts
    const scenario = 'What happens when a customer requests a refund?';
    const entryPoint = await detectEntryPoint(scenario, registry, starmap);

    // Phase 5: Should match "refund" keyword to refundPayment.intent
    expect(entryPoint).toBe('src/payment.ts');
    
    // Keyword matching found the answer — LLM should NOT have been called.
    // Before the keyword matcher fix, the LLM was always invoked.
    // Now "refund" in the scenario matches payment.ts's declaration intents.
    expect((query as any).mock.calls.length).toBe(0);
  });
});

// detectEntryPoint and analyzeTraceWithObservations imported from ../analyzer.js
