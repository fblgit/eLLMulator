/**
 * RED-5: Trace Reporting — No Dead Spot Speculation
 *
 * Xavier's points #5 and #6: Non-traced files are NOT dead spots.
 * Traces report ONLY what was traced — like Zipkin, Datadog, Dynatrace.
 * No warnings about what didn't happen. Spans for what DID happen.
 *
 * The ONLY dead_spot findings should come from analyzeDeadSpots() —
 * actual trace entries with errors (excluding CYCLE_DETECTED/MAX_DEPTH_EXCEEDED).
 *
 * These tests document the CORRECT behavior. They MUST be RED against
 * current code (analyzer.ts orphan detection block, lines ~380-415).
 */

import { describe, it, expect, vi } from 'vitest';

// Mock SDK before any imports that use it
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

import { Registry } from '../registry.js';
import { analyzeTrace, analyzeDeadSpots } from '../analyzer.js';
import type { TraceEntry, Declarations } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeclarations(overrides: Partial<Declarations> = {}): Declarations {
  return {
    summary: 'Test file',
    owns: [{ name: 'main', kind: 'function', intent: 'entry point', file_path: 'test.ts', start_line: 1, end_line: 10 }],
    imports: [],
    exports: [],
    dependencies: [],
    ...overrides,
  };
}

function registerFile(registry: Registry, path: string, deps: string[] = []): void {
  registry.add({
    file_path: path,
    file_hash: `hash-${path}`,
    status: 'ready',
    session_id: `session-${path}`,
    declarations: makeDeclarations({ dependencies: deps }),
    last_active: new Date(),
    error: null,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RED-5: Trace Reporting — No Dead Spot Speculation', () => {

  // =========================================================================
  // TEST 1: Reachable-but-untraced files are NOT dead spots
  // =========================================================================
  describe('[MUST-PASS-AT-TRACE-V2] analyzeTrace must not flag reachable-but-untraced files', () => {

    it('10 registered files, trace touches 3, 2 reachable-but-untraced → ZERO orphan dead_spots', () => {
      // Setup: 10 files in registry.
      // Dependency graph: entry→dep1, entry→traced-other, dep1→dep2, dep1→dep3
      // Trace touches: entry, dep1, traced-other (3 files)
      // Reachable but untraced: dep2, dep3 (2 files)
      // Isolated (unreachable): isolated1-5 (5 files)
      //
      // CORRECT behavior: ZERO dead_spot findings from orphan detection.
      // Traces report what they traced. Period.
      //
      // CURRENT (broken) behavior: 2 dead_spot findings for dep2 and dep3.

      const registry = new Registry();

      // Traced files
      registerFile(registry, 'src/entry.ts', ['src/dep1.ts', 'src/traced-other.ts']);
      registerFile(registry, 'src/dep1.ts', ['src/dep2.ts', 'src/dep3.ts']);
      registerFile(registry, 'src/traced-other.ts');

      // Reachable but untraced
      registerFile(registry, 'src/dep2.ts');
      registerFile(registry, 'src/dep3.ts');

      // Isolated (unreachable from entry)
      registerFile(registry, 'src/isolated1.ts');
      registerFile(registry, 'src/isolated2.ts');
      registerFile(registry, 'src/isolated3.ts');
      registerFile(registry, 'src/isolated4.ts');
      registerFile(registry, 'src/isolated5.ts');

      const traceEntries: TraceEntry[] = [
        {
          trace_id: 'trace-report',
          task_id: 'task-1',
          timestamp: new Date(),
          depth: 0,
          caller: '__trace_initiator__',
          target: 'src/entry.ts',
          function: 'handleRequest',
          result: { ok: true },
          source_refs: ['src/entry.ts:1-10'],
          duration_ms: 100,
          call_stack: [],
        },
        {
          trace_id: 'trace-report',
          task_id: 'task-2',
          timestamp: new Date(),
          depth: 1,
          caller: 'src/entry.ts',
          target: 'src/dep1.ts',
          function: 'process',
          result: { ok: true },
          source_refs: ['src/dep1.ts:1-10'],
          duration_ms: 50,
          call_stack: ['src/entry.ts'],
        },
        {
          trace_id: 'trace-report',
          task_id: 'task-3',
          timestamp: new Date(),
          depth: 1,
          caller: 'src/entry.ts',
          target: 'src/traced-other.ts',
          function: 'helper',
          result: { ok: true },
          source_refs: ['src/traced-other.ts:1-5'],
          duration_ms: 30,
          call_stack: ['src/entry.ts'],
        },
      ];

      const findings = analyzeTrace(traceEntries, registry);
      const deadSpots = findings.filter(f => f.type === 'dead_spot');

      // CORRECT: No dead spots. Trace reports what it traced.
      // The fact that dep2 and dep3 exist and are reachable is irrelevant —
      // the trace didn't visit them, so there's nothing to report.
      expect(deadSpots).toHaveLength(0);
    });

    it('single entry point, no sub-calls, many registered files → ZERO dead_spots', () => {
      // Simplest case: trace only touches the entry point.
      // All other registered files are ignored (not dead spots).

      const registry = new Registry();
      registerFile(registry, 'src/main.ts', ['src/utils.ts', 'src/db.ts']);
      registerFile(registry, 'src/utils.ts');
      registerFile(registry, 'src/db.ts', ['src/models.ts']);
      registerFile(registry, 'src/models.ts');

      const traceEntries: TraceEntry[] = [
        {
          trace_id: 'trace-single',
          task_id: 'task-1',
          timestamp: new Date(),
          depth: 0,
          caller: '__trace_initiator__',
          target: 'src/main.ts',
          function: 'start',
          result: { ok: true },
          source_refs: ['src/main.ts:1-20'],
          duration_ms: 100,
          call_stack: [],
        },
      ];

      const findings = analyzeTrace(traceEntries, registry);
      const deadSpots = findings.filter(f => f.type === 'dead_spot');

      // utils.ts, db.ts, models.ts are all reachable from main.ts
      // but the trace only touched main.ts. That's fine — not dead spots.
      expect(deadSpots).toHaveLength(0);
    });

    it('deep dependency chain, trace only hits first two → ZERO orphan dead_spots', () => {
      // Chain: a→b→c→d→e, trace hits a and b only.
      // c, d, e are reachable but not traced. NOT dead spots.

      const registry = new Registry();
      registerFile(registry, 'src/a.ts', ['src/b.ts']);
      registerFile(registry, 'src/b.ts', ['src/c.ts']);
      registerFile(registry, 'src/c.ts', ['src/d.ts']);
      registerFile(registry, 'src/d.ts', ['src/e.ts']);
      registerFile(registry, 'src/e.ts');

      const traceEntries: TraceEntry[] = [
        {
          trace_id: 'trace-chain',
          task_id: 'task-1',
          timestamp: new Date(),
          depth: 0,
          caller: '__trace_initiator__',
          target: 'src/a.ts',
          function: 'start',
          result: { ok: true },
          source_refs: ['src/a.ts:1-10'],
          duration_ms: 100,
          call_stack: [],
        },
        {
          trace_id: 'trace-chain',
          task_id: 'task-2',
          timestamp: new Date(),
          depth: 1,
          caller: 'src/a.ts',
          target: 'src/b.ts',
          function: 'process',
          result: { ok: true },
          source_refs: ['src/b.ts:1-10'],
          duration_ms: 50,
          call_stack: ['src/a.ts'],
        },
      ];

      const findings = analyzeTrace(traceEntries, registry);
      const deadSpots = findings.filter(f => f.type === 'dead_spot');

      // c, d, e are reachable but not traced. The trace stopped at b.
      // That's the trace's scope — not a problem to report.
      expect(deadSpots).toHaveLength(0);
    });
  });

  // =========================================================================
  // TEST 2: dead_spot findings ONLY from actual trace errors
  // =========================================================================
  describe('[MUST-PASS-AT-TRACE-V2] dead_spot findings only from trace entry errors', () => {

    it('analyzeDeadSpots produces dead_spot only for errored entries (not cycle/depth)', () => {
      // analyzeDeadSpots (the function, not orphan detection) correctly
      // flags trace entries with errors. This is the ONLY source of dead_spot findings.
      // This test verifies the function itself works correctly (should be GREEN).

      const entries: TraceEntry[] = [
        {
          trace_id: 'trace-errors',
          task_id: 'task-1',
          timestamp: new Date(),
          depth: 1,
          caller: 'src/a.ts',
          target: 'src/b.ts',
          function: 'process',
          error: 'AGENT_BOOTSTRAP_FAILED: some error',
          call_stack: ['src/a.ts'],
        },
        {
          trace_id: 'trace-errors',
          task_id: 'task-2',
          timestamp: new Date(),
          depth: 2,
          caller: 'src/b.ts',
          target: 'src/c.ts',
          function: 'query',
          error: 'CYCLE_DETECTED',  // excluded
          call_stack: ['src/a.ts', 'src/b.ts'],
        },
        {
          trace_id: 'trace-errors',
          task_id: 'task-3',
          timestamp: new Date(),
          depth: 3,
          caller: 'src/c.ts',
          target: 'src/d.ts',
          function: 'fetch',
          error: 'MAX_DEPTH_EXCEEDED',  // excluded
          call_stack: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
        },
        {
          trace_id: 'trace-errors',
          task_id: 'task-4',
          timestamp: new Date(),
          depth: 1,
          caller: 'src/a.ts',
          target: 'src/e.ts',
          function: 'validate',
          result: { ok: true },
          source_refs: ['src/e.ts:1-5'],
          duration_ms: 50,
          call_stack: ['src/a.ts'],
        },
      ];

      const deadSpots = analyzeDeadSpots(entries);

      // Only entry with non-excluded error: task-1 (AGENT_BOOTSTRAP_FAILED)
      expect(deadSpots).toHaveLength(1);
      expect(deadSpots[0].target).toBe('src/b.ts');
      expect(deadSpots[0].description).toContain('AGENT_BOOTSTRAP_FAILED');
    });

    it('analyzeTrace dead_spot count must equal analyzeDeadSpots count — no orphan inflation', () => {
      // The master analyzeTrace() must produce the SAME dead_spot findings
      // as analyzeDeadSpots() alone. No additional orphan dead_spots.
      //
      // CURRENT (broken): analyzeTrace adds orphan findings on top of analyzeDeadSpots.
      // CORRECT: analyzeTrace dead_spots === analyzeDeadSpots dead_spots.

      const registry = new Registry();
      registerFile(registry, 'src/entry.ts', ['src/dep1.ts']);
      registerFile(registry, 'src/dep1.ts', ['src/dep2.ts']);
      registerFile(registry, 'src/dep2.ts');
      registerFile(registry, 'src/unrelated.ts');

      // Trace touches entry, dep1 has an error. dep2 is reachable but not traced.
      const entries: TraceEntry[] = [
        {
          trace_id: 'trace-compare',
          task_id: 'task-1',
          timestamp: new Date(),
          depth: 0,
          caller: '__trace_initiator__',
          target: 'src/entry.ts',
          function: 'main',
          result: { ok: true },
          source_refs: ['src/entry.ts:1-10'],
          duration_ms: 100,
          call_stack: [],
        },
        {
          trace_id: 'trace-compare',
          task_id: 'task-2',
          timestamp: new Date(),
          depth: 1,
          caller: 'src/entry.ts',
          target: 'src/dep1.ts',
          function: 'process',
          error: 'CONNECTION_TIMEOUT',
          call_stack: ['src/entry.ts'],
        },
      ];

      const standaloneDeadSpots = analyzeDeadSpots(entries);
      const masterFindings = analyzeTrace(entries, registry);
      const masterDeadSpots = masterFindings.filter(f => f.type === 'dead_spot');

      // analyzeDeadSpots: 1 finding (dep1 has CONNECTION_TIMEOUT error)
      expect(standaloneDeadSpots).toHaveLength(1);

      // analyzeTrace MUST produce the SAME dead_spot count — no orphan inflation.
      // CURRENT (broken): adds 1 orphan (dep2 reachable but untraced) → 2 total
      // CORRECT: 1 dead_spot (only the error entry)
      expect(masterDeadSpots).toHaveLength(standaloneDeadSpots.length);
    });
  });

  // =========================================================================
  // TEST 3: Trace reports what it observed, nothing more
  // =========================================================================
  describe('[MUST-PASS-AT-TRACE-V2] Trace reports only observed behavior', () => {

    it('no orphan-type dead_spot descriptions in findings ("reachable from the entry point but was never traced")', () => {
      // The specific description string from the orphan detection block
      // should NEVER appear in findings. If it does, orphan detection is active.

      const registry = new Registry();
      registerFile(registry, 'src/server.ts', ['src/handler.ts', 'src/middleware.ts']);
      registerFile(registry, 'src/handler.ts', ['src/db.ts']);
      registerFile(registry, 'src/middleware.ts');
      registerFile(registry, 'src/db.ts');

      // Trace only hits server and handler
      const entries: TraceEntry[] = [
        {
          trace_id: 'trace-observed',
          task_id: 'task-1',
          timestamp: new Date(),
          depth: 0,
          caller: '__trace_initiator__',
          target: 'src/server.ts',
          function: 'listen',
          result: { ok: true },
          source_refs: ['src/server.ts:1-20'],
          duration_ms: 200,
          call_stack: [],
        },
        {
          trace_id: 'trace-observed',
          task_id: 'task-2',
          timestamp: new Date(),
          depth: 1,
          caller: 'src/server.ts',
          target: 'src/handler.ts',
          function: 'handle',
          result: { ok: true },
          source_refs: ['src/handler.ts:1-15'],
          duration_ms: 100,
          call_stack: ['src/server.ts'],
        },
      ];

      const findings = analyzeTrace(entries, registry);

      // No finding should mention "reachable from the entry point but was never traced"
      // That's the orphan detection fingerprint.
      const orphanDescriptions = findings.filter(f =>
        f.description.includes('reachable from the entry point but was never traced')
      );
      expect(orphanDescriptions).toHaveLength(0);
    });

    it('findings types for clean trace should contain ZERO dead_spots', () => {
      // A trace where every entry succeeded — no errors, no mismatches.
      // There should be absolutely no dead_spot findings.

      const registry = new Registry();
      registerFile(registry, 'src/app.ts', ['src/service.ts']);
      registerFile(registry, 'src/service.ts', ['src/repo.ts']);
      registerFile(registry, 'src/repo.ts');
      // Extra registered files that aren't in the trace path
      registerFile(registry, 'src/utils.ts');
      registerFile(registry, 'src/config.ts');

      const entries: TraceEntry[] = [
        {
          trace_id: 'trace-clean',
          task_id: 'task-1',
          timestamp: new Date(),
          depth: 0,
          caller: '__trace_initiator__',
          target: 'src/app.ts',
          function: 'run',
          result: { started: true },
          source_refs: ['src/app.ts:1-30'],
          duration_ms: 150,
          call_stack: [],
        },
        {
          trace_id: 'trace-clean',
          task_id: 'task-2',
          timestamp: new Date(),
          depth: 1,
          caller: 'src/app.ts',
          target: 'src/service.ts',
          function: 'execute',
          result: { processed: true },
          source_refs: ['src/service.ts:1-20'],
          duration_ms: 80,
          call_stack: ['src/app.ts'],
        },
        {
          trace_id: 'trace-clean',
          task_id: 'task-3',
          timestamp: new Date(),
          depth: 2,
          caller: 'src/service.ts',
          target: 'src/repo.ts',
          function: 'fetch',
          result: { rows: 5 },
          source_refs: ['src/repo.ts:1-15'],
          duration_ms: 40,
          call_stack: ['src/app.ts', 'src/service.ts'],
        },
      ];

      const findings = analyzeTrace(entries, registry);
      const deadSpots = findings.filter(f => f.type === 'dead_spot');

      // Clean trace, all entries succeeded. No dead spots anywhere.
      // utils.ts and config.ts exist in registry but weren't traced — that's fine.
      expect(deadSpots).toHaveLength(0);
    });

    it('empty trace produces zero findings', () => {
      // Edge case: no trace entries at all. analyzeTrace should return empty findings.

      const registry = new Registry();
      registerFile(registry, 'src/app.ts');
      registerFile(registry, 'src/service.ts');

      const findings = analyzeTrace([], registry);

      expect(findings).toHaveLength(0);
    });
  });
});
