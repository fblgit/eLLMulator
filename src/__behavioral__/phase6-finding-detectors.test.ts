/**
 * Phase 6B RED Tests: Finding Detectors (Tasks 6.2 + 6.3 + 6.4)
 *
 * 6.2: missing_error_path — invocations that returned errors where caller
 *      has no error handling
 * 6.3: assumption_bug — expected_output vs actual returns mismatch
 * 6.4: freeform observations — LLM-generated architectural observations
 *
 * These tests MUST FAIL until 6B GREEN implements the features.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  analyzeMissingErrorPaths,
  analyzeAssumptionBugs,
  analyzeTrace,
} from '../analyzer.js';
import { Registry } from '../registry.js';
import type { TraceEntry, Finding } from '../types.js';

describe('Phase 6B: Finding Detectors', () => {
  let registry: Registry;

  beforeEach(() => {
    registry = new Registry();

    registry.add({
      file_path: 'src/api.ts',
      file_hash: 'hash-api',
      status: 'ready',
      session_id: 'session-api',
      declarations: {
        summary: 'API handler',
        owns: [
          { name: 'handleRequest', kind: 'function', intent: 'Handle HTTP requests', file_path: 'src/api.ts', start_line: 1, end_line: 30 },
        ],
        imports: [],
        exports: [],
        dependencies: ['src/db.ts'],
      },
    });

    registry.add({
      file_path: 'src/db.ts',
      file_hash: 'hash-db',
      status: 'ready',
      session_id: 'session-db',
      declarations: {
        summary: 'Database layer',
        owns: [
          { name: 'queryUser', kind: 'function', intent: 'Query user from database', file_path: 'src/db.ts', start_line: 1, end_line: 20 },
        ],
        imports: [],
        exports: [],
        dependencies: [],
      },
    });
  });

  // -------------------------------------------------------------------
  // 6.2: missing_error_path
  // -------------------------------------------------------------------

  describe('[MUST-PASS-AT-PHASE-6] missing_error_path detection', () => {
    it('should detect when caller ignores error from target', () => {
      const entries: TraceEntry[] = [
        {
          trace_id: 'trace-1',
          task_id: 'task-1',
          timestamp: new Date(),
          depth: 0,
          caller: 'src/api.ts',
          target: 'src/db.ts',
          function: 'queryUser',
          params: { id: 1 },
          error: 'CONNECTION_REFUSED',
          call_stack: [],
        },
      ];

      const findings = analyzeMissingErrorPaths(entries, registry);

      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0].type).toBe('missing_error_path');
      expect(findings[0].caller).toBe('src/api.ts');
      expect(findings[0].target).toBe('src/db.ts');
      expect(findings[0].severity).toBe('high');
    });

    it('should not flag errors when caller has error handling in subsequent entries', () => {
      // If the caller makes a follow-up call that suggests error handling
      // (e.g., logging, fallback, retry), don't flag it
      const entries: TraceEntry[] = [
        {
          trace_id: 'trace-1',
          task_id: 'task-1',
          timestamp: new Date(),
          depth: 0,
          caller: 'src/api.ts',
          target: 'src/db.ts',
          function: 'queryUser',
          params: { id: 1 },
          error: 'CONNECTION_REFUSED',
          call_stack: [],
        },
        {
          trace_id: 'trace-1',
          task_id: 'task-2',
          timestamp: new Date(),
          depth: 0,
          caller: 'src/api.ts',
          target: 'src/db.ts',
          function: 'queryUser',
          params: { id: 1 },
          result: { user: 'Alice' },
          call_stack: [],
        },
      ];

      const findings = analyzeMissingErrorPaths(entries, registry);
      // Retry pattern suggests error handling — should not flag
      expect(findings.length).toBe(0);
    });

    it('should return empty array when no errors in trace', () => {
      const entries: TraceEntry[] = [
        {
          trace_id: 'trace-1',
          task_id: 'task-1',
          timestamp: new Date(),
          depth: 0,
          caller: 'src/api.ts',
          target: 'src/db.ts',
          function: 'queryUser',
          result: { user: 'Alice' },
          call_stack: [],
        },
      ];

      const findings = analyzeMissingErrorPaths(entries, registry);
      expect(findings).toEqual([]);
    });
  });

  // -------------------------------------------------------------------
  // 6.3: assumption_bug
  // -------------------------------------------------------------------

  describe('[MUST-PASS-AT-PHASE-6] assumption_bug detection', () => {
    it('should detect mismatch between expected_output and actual returns', () => {
      const entries: TraceEntry[] = [
        {
          trace_id: 'trace-1',
          task_id: 'task-1',
          timestamp: new Date(),
          depth: 0,
          caller: 'src/api.ts',
          target: 'src/db.ts',
          function: 'queryUser',
          params: { id: 1 },
          expected_output: 'Returns a User object with id, name, email fields',
          result: { status: 'not_found' },
          call_stack: [],
        },
      ];

      const findings = analyzeAssumptionBugs(entries);

      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0].type).toBe('assumption_bug');
      expect(findings[0].caller).toBe('src/api.ts');
      expect(findings[0].target).toBe('src/db.ts');
    });

    it('should not flag entries without expected_output', () => {
      const entries: TraceEntry[] = [
        {
          trace_id: 'trace-1',
          task_id: 'task-1',
          timestamp: new Date(),
          depth: 0,
          caller: 'src/api.ts',
          target: 'src/db.ts',
          function: 'queryUser',
          result: { status: 'not_found' },
          call_stack: [],
        },
      ];

      const findings = analyzeAssumptionBugs(entries);
      expect(findings).toEqual([]);
    });

    it('should not flag when result matches expected_output semantically', () => {
      const entries: TraceEntry[] = [
        {
          trace_id: 'trace-1',
          task_id: 'task-1',
          timestamp: new Date(),
          depth: 0,
          caller: 'src/api.ts',
          target: 'src/db.ts',
          function: 'queryUser',
          params: { id: 1 },
          expected_output: 'Returns a User object with id and name',
          result: { id: 1, name: 'Alice' },
          call_stack: [],
        },
      ];

      const findings = analyzeAssumptionBugs(entries);
      expect(findings).toEqual([]);
    });

    it('should flag entries with errors when success was expected', () => {
      const entries: TraceEntry[] = [
        {
          trace_id: 'trace-1',
          task_id: 'task-1',
          timestamp: new Date(),
          depth: 0,
          caller: 'src/api.ts',
          target: 'src/db.ts',
          function: 'queryUser',
          params: { id: 1 },
          expected_output: 'Returns a User object',
          error: 'TIMEOUT',
          call_stack: [],
        },
      ];

      const findings = analyzeAssumptionBugs(entries);
      expect(findings.length).toBeGreaterThan(0);
      expect(findings[0].type).toBe('assumption_bug');
    });
  });

  // -------------------------------------------------------------------
  // 6.2 + 6.3 integrated into analyzeTrace
  // -------------------------------------------------------------------

  describe('[MUST-PASS-AT-PHASE-6] analyzeTrace includes new finding types', () => {
    it('should include missing_error_path findings in aggregate', () => {
      const entries: TraceEntry[] = [
        {
          trace_id: 'trace-1',
          task_id: 'task-1',
          timestamp: new Date(),
          depth: 0,
          caller: 'src/api.ts',
          target: 'src/db.ts',
          function: 'queryUser',
          error: 'CONNECTION_REFUSED',
          call_stack: [],
        },
      ];

      const findings = analyzeTrace(entries, registry);
      const errorPathFindings = findings.filter(f => f.type === 'missing_error_path');
      expect(errorPathFindings.length).toBeGreaterThan(0);
    });

    it('should include assumption_bug findings in aggregate', () => {
      const entries: TraceEntry[] = [
        {
          trace_id: 'trace-1',
          task_id: 'task-1',
          timestamp: new Date(),
          depth: 0,
          caller: 'src/api.ts',
          target: 'src/db.ts',
          function: 'queryUser',
          expected_output: 'Returns User object',
          result: { error: 'not_found' },
          call_stack: [],
        },
      ];

      const findings = analyzeTrace(entries, registry);
      const assumptionFindings = findings.filter(f => f.type === 'assumption_bug');
      expect(assumptionFindings.length).toBeGreaterThan(0);
    });
  });
});
