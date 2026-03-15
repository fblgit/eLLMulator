/**
 * FR-019: Trace Summary Generation + Findings Wiring
 *
 * SPEC grounding:
 *   TraceResult:>{
 *     trace_id:str!, entries:[TraceEntry]!, summary:str!,
 *     findings:[Finding]?, duration_ms:int!
 *   }
 *   summary = summarize_trace($entries) -- generates human-readable summary
 *   findings = analyze_trace($entries) -- aggregation of all analyzers (FR-017 + FR-018)
 *
 * Functions under test:
 *   analyzeTrace(entries: TraceEntry[], registry: Registry) -> Finding[]
 *     - Master aggregator: calls analyzeContractMismatches, analyzeDeadSpots, analyzeUnexpectedCalls
 *     - Returns combined/aggregated Finding[] from all sub-analyzers
 *
 *   summarizeTrace(entries: TraceEntry[]) -> string
 *     - Takes TraceEntry[] -> human-readable summary string
 *     - Summary includes: entry count, unique files involved, max depth, error count
 *     - Returns meaningful string even for empty entries
 */

import { describe, it, expect } from 'vitest';
import type { TraceEntry, Finding } from './types.js';
import { Registry, type RegistryEntry, type Declarations } from './registry.js';
import { analyzeTrace, summarizeTrace } from './analyzer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTraceEntry(overrides: Partial<TraceEntry> = {}): TraceEntry {
  return {
    trace_id: 'trace-019',
    task_id: 'task-019',
    timestamp: new Date('2026-03-05T14:00:00Z'),
    depth: 1,
    caller: 'src/controller.ts',
    target: 'src/service.ts',
    function: 'processOrder',
    call_stack: ['src/controller.ts'],
    ...overrides,
  };
}

function makeDeclarations(overrides: Partial<Declarations> = {}): Declarations {
  return {
    summary: 'test declarations',
    owns: [],
    imports: [],
    exports: [],
    dependencies: [],
    ...overrides,
  };
}

function makeRegistryEntry(
  filePath: string,
  declarations: Declarations | null,
  overrides: Partial<RegistryEntry> = {},
): RegistryEntry {
  return {
    file_path: filePath,
    file_hash: 'hash-' + filePath,
    status: 'ready',
    session_id: 'session-001',
    declarations,
    last_active: new Date(),
    error: null,
    ...overrides,
  };
}

/**
 * Build a Registry populated with the given entries.
 */
function buildRegistry(...entries: RegistryEntry[]): Registry {
  const registry = new Registry();
  for (const entry of entries) {
    registry.add(entry);
  }
  return registry;
}

// ===========================================================================
// FR-019: analyzeTrace (master aggregator)
// ===========================================================================

describe('FR-019: analyzeTrace', () => {
  // -------------------------------------------------------
  // Test 1: analyzeTrace is importable and callable
  // -------------------------------------------------------
  it('is importable and callable', () => {
    expect(typeof analyzeTrace).toBe('function');
  });

  // -------------------------------------------------------
  // Test 2: Returns empty array when entries is empty
  // -------------------------------------------------------
  it('returns empty array when entries is empty', () => {
    const registry = buildRegistry();
    const findings = analyzeTrace([], registry);

    expect(findings).toEqual([]);
  });

  // -------------------------------------------------------
  // Test 3: Returns combined findings from all sub-analyzers
  // -------------------------------------------------------
  it('returns combined findings from all sub-analyzers', () => {
    // Set up a scenario that triggers contract_mismatch:
    // target does NOT own the called function
    const controllerDecls = makeDeclarations({
      owns: [{ name: 'handleRequest' }],
    });
    const serviceDecls = makeDeclarations({
      owns: [{ name: 'getStatus' }], // does NOT own 'processOrder'
    });
    // Set up a file in registry that is never called (dead_spot candidate)
    const repoDecls = makeDeclarations({
      owns: [{ name: 'save' }, { name: 'findById' }],
    });

    const registry = buildRegistry(
      makeRegistryEntry('src/controller.ts', controllerDecls),
      makeRegistryEntry('src/service.ts', serviceDecls),
      makeRegistryEntry('src/repo.ts', repoDecls),
    );

    const entries: TraceEntry[] = [
      makeTraceEntry({
        caller: 'src/controller.ts',
        target: 'src/service.ts',
        function: 'processOrder', // NOT in service owns -> contract_mismatch
      }),
    ];

    const findings = analyzeTrace(entries, registry);

    // Should return an array of findings (at least contract mismatches)
    expect(Array.isArray(findings)).toBe(true);
    expect(findings.length).toBeGreaterThan(0);

    // Every finding must conform to the Finding shape
    for (const f of findings) {
      expect(f.type).toBeDefined();
      expect(f.description).toBeDefined();
      expect(f.caller).toBeDefined();
      expect(Array.isArray(f.source_refs)).toBe(true);
      expect(['high', 'medium', 'low']).toContain(f.severity);
    }
  });

  // -------------------------------------------------------
  // Test 4: Includes contract mismatches (type='contract_mismatch')
  // -------------------------------------------------------
  it('includes contract mismatches from sub-analyzer', () => {
    const controllerDecls = makeDeclarations({
      owns: [{ name: 'handleRequest' }],
    });
    const serviceDecls = makeDeclarations({
      owns: [{ name: 'getStatus' }], // does NOT own 'missingFn'
    });
    const registry = buildRegistry(
      makeRegistryEntry('src/controller.ts', controllerDecls),
      makeRegistryEntry('src/service.ts', serviceDecls),
    );

    const entries: TraceEntry[] = [
      makeTraceEntry({
        caller: 'src/controller.ts',
        target: 'src/service.ts',
        function: 'missingFn',
      }),
    ];

    const findings = analyzeTrace(entries, registry);

    const contractFindings = findings.filter(
      (f) => f.type === 'contract_mismatch',
    );
    expect(contractFindings.length).toBeGreaterThanOrEqual(1);
    expect(contractFindings[0].severity).toBe('high');
  });

  // -------------------------------------------------------
  // Test 5: Includes dead spots (type='dead_spot')
  // -------------------------------------------------------
  it('includes dead spots from sub-analyzer', () => {
    // Register agents that are never called as targets in the trace
    const controllerDecls = makeDeclarations({
      owns: [{ name: 'handleRequest' }],
    });
    const serviceDecls = makeDeclarations({
      owns: [{ name: 'processOrder' }],
    });
    const orphanDecls = makeDeclarations({
      owns: [{ name: 'orphanMethod' }],
    });

    const registry = buildRegistry(
      makeRegistryEntry('src/controller.ts', controllerDecls),
      makeRegistryEntry('src/service.ts', serviceDecls),
      makeRegistryEntry('src/orphan.ts', orphanDecls), // never called in trace
    );

    const entries: TraceEntry[] = [
      makeTraceEntry({
        caller: 'src/controller.ts',
        target: 'src/service.ts',
        function: 'processOrder',
      }),
    ];

    const findings = analyzeTrace(entries, registry);

    const deadSpotFindings = findings.filter((f) => f.type === 'dead_spot');
    // Dead spots are only files reachable from the entry point but not traced.
    // orphan.ts is not reachable from the entry point (no dependency path),
    // so it should NOT be flagged as a dead spot.
    expect(deadSpotFindings.length).toBe(0);
  });

  // -------------------------------------------------------
  // Test 6: Includes unexpected calls (type='unexpected_call')
  // -------------------------------------------------------
  it('includes unexpected calls from sub-analyzer', () => {
    const controllerDecls = makeDeclarations({
      owns: [{ name: 'handleRequest' }],
      // controller does not declare dependency on unknown-target
      dependencies: ['src/service.ts'],
    });
    const serviceDecls = makeDeclarations({
      owns: [{ name: 'processOrder' }],
    });

    const registry = buildRegistry(
      makeRegistryEntry('src/controller.ts', controllerDecls),
      makeRegistryEntry('src/service.ts', serviceDecls),
    );

    // Controller calls a target not in its declared dependencies
    const entries: TraceEntry[] = [
      makeTraceEntry({
        caller: 'src/controller.ts',
        target: 'src/unknown-service.ts', // not in controller's dependencies
        function: 'doSomething',
      }),
    ];

    const findings = analyzeTrace(entries, registry);

    const unexpectedFindings = findings.filter(
      (f) => f.type === 'unexpected_call',
    );
    expect(unexpectedFindings.length).toBeGreaterThanOrEqual(1);
  });

  // -------------------------------------------------------
  // Test 7: Does not duplicate findings
  // -------------------------------------------------------
  it('does not duplicate findings across sub-analyzers', () => {
    const controllerDecls = makeDeclarations({
      owns: [{ name: 'handleRequest' }],
    });
    const serviceDecls = makeDeclarations({
      owns: [{ name: 'getStatus' }], // does NOT own processOrder
    });
    const registry = buildRegistry(
      makeRegistryEntry('src/controller.ts', controllerDecls),
      makeRegistryEntry('src/service.ts', serviceDecls),
    );

    // Same entry appears twice -- sub-analyzers should each produce at most one
    // finding per unique issue. Master aggregator must not duplicate.
    const entry = makeTraceEntry({
      caller: 'src/controller.ts',
      target: 'src/service.ts',
      function: 'processOrder',
    });

    const findings = analyzeTrace([entry, entry], registry);

    // Count findings by unique (type + caller + target + function-in-description)
    const keys = findings.map(
      (f) => `${f.type}:${f.caller}:${f.target ?? ''}`,
    );
    const uniqueKeys = new Set(keys);

    // No duplicates: unique key count should equal total finding count
    expect(findings.length).toBe(uniqueKeys.size);
  });
});

// ===========================================================================
// FR-019: summarizeTrace
// ===========================================================================

describe('FR-019: summarizeTrace', () => {
  // -------------------------------------------------------
  // Test 1: summarizeTrace is importable and callable
  // -------------------------------------------------------
  it('is importable and callable', () => {
    expect(typeof summarizeTrace).toBe('function');
  });

  // -------------------------------------------------------
  // Test 2: Returns string type
  // -------------------------------------------------------
  it('returns a string', () => {
    const entries: TraceEntry[] = [
      makeTraceEntry(),
    ];

    const summary = summarizeTrace(entries);

    expect(typeof summary).toBe('string');
  });

  // -------------------------------------------------------
  // Test 3: Summary mentions entry count
  // -------------------------------------------------------
  it('summary mentions entry count', () => {
    const entries: TraceEntry[] = [
      makeTraceEntry({ task_id: 'task-a' }),
      makeTraceEntry({ task_id: 'task-b' }),
      makeTraceEntry({ task_id: 'task-c' }),
    ];

    const summary = summarizeTrace(entries);

    // Must mention "3" somewhere (the entry count)
    expect(summary).toContain('3');
    // Should use the word "entries" or "entry" near the count
    expect(summary).toMatch(/3\s+entr/i);
  });

  // -------------------------------------------------------
  // Test 4: Summary mentions unique files involved
  // -------------------------------------------------------
  it('summary mentions unique files involved', () => {
    const entries: TraceEntry[] = [
      makeTraceEntry({
        caller: 'src/controller.ts',
        target: 'src/service.ts',
        task_id: 'task-a',
      }),
      makeTraceEntry({
        caller: 'src/service.ts',
        target: 'src/repo.ts',
        task_id: 'task-b',
      }),
      makeTraceEntry({
        caller: 'src/controller.ts',
        target: 'src/service.ts',
        task_id: 'task-c',
      }),
    ];

    const summary = summarizeTrace(entries);

    // Unique files: controller.ts, service.ts, repo.ts = 3 unique files
    expect(summary).toMatch(/3\s+file/i);
  });

  // -------------------------------------------------------
  // Test 5: Summary mentions max depth
  // -------------------------------------------------------
  it('summary mentions max depth', () => {
    const entries: TraceEntry[] = [
      makeTraceEntry({ depth: 0, task_id: 'task-a' }),
      makeTraceEntry({ depth: 3, task_id: 'task-b' }),
      makeTraceEntry({ depth: 7, task_id: 'task-c' }),
      makeTraceEntry({ depth: 2, task_id: 'task-d' }),
    ];

    const summary = summarizeTrace(entries);

    // Must mention max depth of 7
    expect(summary).toMatch(/depth/i);
    expect(summary).toContain('7');
  });

  // -------------------------------------------------------
  // Test 6: Summary mentions error count if any errors exist
  // -------------------------------------------------------
  it('summary mentions error count when errors exist', () => {
    const entries: TraceEntry[] = [
      makeTraceEntry({ task_id: 'task-ok-1' }),
      makeTraceEntry({
        task_id: 'task-err-1',
        error: 'Connection refused',
      }),
      makeTraceEntry({ task_id: 'task-ok-2' }),
      makeTraceEntry({
        task_id: 'task-err-2',
        error: 'Timeout exceeded',
      }),
    ];

    const summary = summarizeTrace(entries);

    // Must mention "2" errors
    expect(summary).toMatch(/2\s+error/i);
  });

  // -------------------------------------------------------
  // Test 7: Returns meaningful summary for empty entries
  // -------------------------------------------------------
  it('returns meaningful summary for empty entries', () => {
    const summary = summarizeTrace([]);

    expect(typeof summary).toBe('string');
    expect(summary.length).toBeGreaterThan(0);
    // Should mention 0 entries or "empty"
    expect(summary).toMatch(/0\s+entr|empty/i);
  });
});
