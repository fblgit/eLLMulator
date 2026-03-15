/**
 * FR-017: Contract Mismatch Detection
 *
 * SPEC grounding:
 *   analyze_trace:lambda(entries:[TraceEntry]) -> [Finding]
 *   Contract mismatches: caller params vs target expectations
 *   For each entry where caller and target have declarations,
 *   if target's declarations.owns does not include the called function,
 *   emit Finding { type: 'contract_mismatch', severity: 'high' }
 *
 * Function under test:
 *   analyzeContractMismatches(entries: TraceEntry[], registry: Registry) -> Finding[]
 */

import { describe, it, expect } from 'vitest';
import type { TraceEntry, Finding } from './types.js';
import { Registry, type RegistryEntry, type Declarations } from './registry.js';
import { analyzeContractMismatches } from './analyzer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTraceEntry(overrides: Partial<TraceEntry> = {}): TraceEntry {
  return {
    trace_id: 'trace-017',
    task_id: 'task-017',
    timestamp: new Date('2026-03-05T10:00:00Z'),
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
// FR-017: Contract Mismatch Detection
// ===========================================================================

describe('FR-017: analyzeContractMismatches', () => {
  // -------------------------------------------------------
  // Test 1: analyzeContractMismatches is importable and callable
  // -------------------------------------------------------
  it('is importable and callable', () => {
    expect(typeof analyzeContractMismatches).toBe('function');
  });

  // -------------------------------------------------------
  // Test 2: Returns empty array when entries is empty
  // -------------------------------------------------------
  it('returns empty array when entries is empty', () => {
    const registry = buildRegistry(
      makeRegistryEntry('src/controller.ts', makeDeclarations()),
    );

    const findings = analyzeContractMismatches([], registry);

    expect(findings).toEqual([]);
  });

  // -------------------------------------------------------
  // Test 3: Returns empty array when all calls match declarations
  // -------------------------------------------------------
  it('returns empty array when all calls match target declarations', () => {
    const targetDecls = makeDeclarations({
      owns: [{ name: 'processOrder' }, { name: 'cancelOrder' }],
    });
    const callerDecls = makeDeclarations({
      owns: [{ name: 'handleRequest' }],
    });
    const registry = buildRegistry(
      makeRegistryEntry('src/controller.ts', callerDecls),
      makeRegistryEntry('src/service.ts', targetDecls),
    );

    const entry = makeTraceEntry({
      caller: 'src/controller.ts',
      target: 'src/service.ts',
      function: 'processOrder',
    });

    const findings = analyzeContractMismatches([entry], registry);

    expect(findings).toEqual([]);
  });

  // -------------------------------------------------------
  // Test 4: Returns Finding when target does not declare called function
  // -------------------------------------------------------
  it('returns contract_mismatch Finding when target does not declare called function', () => {
    const targetDecls = makeDeclarations({
      owns: [{ name: 'cancelOrder' }],
    });
    const callerDecls = makeDeclarations({
      owns: [{ name: 'handleRequest' }],
    });
    const registry = buildRegistry(
      makeRegistryEntry('src/controller.ts', callerDecls),
      makeRegistryEntry('src/service.ts', targetDecls),
    );

    const entry = makeTraceEntry({
      caller: 'src/controller.ts',
      target: 'src/service.ts',
      function: 'processOrder', // NOT in target's owns
    });

    const findings = analyzeContractMismatches([entry], registry);

    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe('contract_mismatch');
  });

  // -------------------------------------------------------
  // Test 5: Finding has correct fields: type, description, caller, target, source_refs, severity
  // -------------------------------------------------------
  it('produces Finding with all required fields and severity high', () => {
    const targetDecls = makeDeclarations({
      owns: [{ name: 'unrelatedFn' }],
    });
    const callerDecls = makeDeclarations({
      owns: [{ name: 'doSomething' }],
    });
    const registry = buildRegistry(
      makeRegistryEntry('src/caller.ts', callerDecls),
      makeRegistryEntry('src/target.ts', targetDecls),
    );

    const entry = makeTraceEntry({
      caller: 'src/caller.ts',
      target: 'src/target.ts',
      function: 'missingFn',
      source_refs: ['src/caller.ts:42-50'],
    });

    const findings = analyzeContractMismatches([entry], registry);

    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.type).toBe('contract_mismatch');
    expect(f.severity).toBe('high');
    expect(f.caller).toBe('src/caller.ts');
    expect(f.target).toBe('src/target.ts');
    expect(f.source_refs).toEqual(['src/caller.ts:42-50']);
    expect(f.description).toContain('src/caller.ts');
    expect(f.description).toContain('missingFn');
    expect(f.description).toContain('src/target.ts');
  });

  // -------------------------------------------------------
  // Test 6: Skips entries where target has no declarations (null)
  // -------------------------------------------------------
  it('skips entries where target has no declarations', () => {
    const callerDecls = makeDeclarations({
      owns: [{ name: 'handleRequest' }],
    });
    const registry = buildRegistry(
      makeRegistryEntry('src/controller.ts', callerDecls),
      makeRegistryEntry('src/service.ts', null), // target has null declarations
    );

    const entry = makeTraceEntry({
      caller: 'src/controller.ts',
      target: 'src/service.ts',
      function: 'processOrder',
    });

    const findings = analyzeContractMismatches([entry], registry);

    expect(findings).toEqual([]);
  });

  // -------------------------------------------------------
  // Test 7: Skips entries where caller has no declarations (null)
  // -------------------------------------------------------
  it('skips entries where caller has no declarations', () => {
    const targetDecls = makeDeclarations({
      owns: [{ name: 'processOrder' }],
    });
    const registry = buildRegistry(
      makeRegistryEntry('src/controller.ts', null), // caller has null declarations
      makeRegistryEntry('src/service.ts', targetDecls),
    );

    const entry = makeTraceEntry({
      caller: 'src/controller.ts',
      target: 'src/service.ts',
      function: 'processOrder',
    });

    const findings = analyzeContractMismatches([entry], registry);

    expect(findings).toEqual([]);
  });

  // -------------------------------------------------------
  // Test 8: Skips entries where caller is '__trace_initiator__'
  // -------------------------------------------------------
  it('skips entries where caller is __trace_initiator__', () => {
    const targetDecls = makeDeclarations({
      owns: [], // empty owns -- would trigger mismatch for normal caller
    });
    const registry = buildRegistry(
      makeRegistryEntry('src/service.ts', targetDecls),
    );

    const entry = makeTraceEntry({
      caller: '__trace_initiator__',
      target: 'src/service.ts',
      function: 'processOrder',
    });

    const findings = analyzeContractMismatches([entry], registry);

    expect(findings).toEqual([]);
  });

  // -------------------------------------------------------
  // Test 9: Handles multiple entries with mix of matches and mismatches
  // -------------------------------------------------------
  it('handles multiple entries with mix of matches and mismatches', () => {
    const serviceDecls = makeDeclarations({
      owns: [{ name: 'processOrder' }, { name: 'getStatus' }],
    });
    const repoDecls = makeDeclarations({
      owns: [{ name: 'save' }],
    });
    const callerDecls = makeDeclarations({
      owns: [{ name: 'handleRequest' }],
    });
    const registry = buildRegistry(
      makeRegistryEntry('src/controller.ts', callerDecls),
      makeRegistryEntry('src/service.ts', serviceDecls),
      makeRegistryEntry('src/repo.ts', repoDecls),
    );

    const entries: TraceEntry[] = [
      // Match: service owns processOrder
      makeTraceEntry({
        caller: 'src/controller.ts',
        target: 'src/service.ts',
        function: 'processOrder',
        task_id: 'task-a',
      }),
      // Mismatch: service does NOT own deleteOrder
      makeTraceEntry({
        caller: 'src/controller.ts',
        target: 'src/service.ts',
        function: 'deleteOrder',
        task_id: 'task-b',
      }),
      // Mismatch: repo does NOT own findAll
      makeTraceEntry({
        caller: 'src/service.ts',
        target: 'src/repo.ts',
        function: 'findAll',
        task_id: 'task-c',
      }),
      // Match: repo owns save
      makeTraceEntry({
        caller: 'src/service.ts',
        target: 'src/repo.ts',
        function: 'save',
        task_id: 'task-d',
      }),
    ];

    const findings = analyzeContractMismatches(entries, registry);

    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.type === 'contract_mismatch')).toBe(true);
    expect(findings.every((f) => f.severity === 'high')).toBe(true);

    // Verify specific mismatches detected
    const descriptions = findings.map((f) => f.description);
    expect(descriptions.some((d) => d.includes('deleteOrder'))).toBe(true);
    expect(descriptions.some((d) => d.includes('findAll'))).toBe(true);
  });

  // -------------------------------------------------------
  // Test 10: Uses source_refs from TraceEntry or empty array if undefined
  // -------------------------------------------------------
  it('uses source_refs from TraceEntry in Finding, defaults to empty array', () => {
    const targetDecls = makeDeclarations({
      owns: [], // no owns -> mismatch
    });
    const callerDecls = makeDeclarations({
      owns: [{ name: 'x' }],
    });
    const registry = buildRegistry(
      makeRegistryEntry('src/a.ts', callerDecls),
      makeRegistryEntry('src/b.ts', targetDecls),
    );

    // Entry WITH source_refs
    const entryWithRefs = makeTraceEntry({
      caller: 'src/a.ts',
      target: 'src/b.ts',
      function: 'doStuff',
      source_refs: ['src/a.ts:10', 'src/a.ts:20'],
      task_id: 'task-with-refs',
    });
    // Entry WITHOUT source_refs (undefined)
    const entryWithoutRefs = makeTraceEntry({
      caller: 'src/a.ts',
      target: 'src/b.ts',
      function: 'doOtherStuff',
      task_id: 'task-no-refs',
    });
    // Ensure source_refs is truly undefined
    delete (entryWithoutRefs as any).source_refs;

    const findings = analyzeContractMismatches(
      [entryWithRefs, entryWithoutRefs],
      registry,
    );

    expect(findings).toHaveLength(2);

    const withRefs = findings.find((f) => f.description.includes('doStuff'));
    const withoutRefs = findings.find((f) =>
      f.description.includes('doOtherStuff'),
    );

    expect(withRefs).toBeDefined();
    expect(withRefs!.source_refs).toEqual(['src/a.ts:10', 'src/a.ts:20']);

    expect(withoutRefs).toBeDefined();
    expect(withoutRefs!.source_refs).toEqual([]);
  });

  // -------------------------------------------------------
  // Test 11: Skips entries where target is not in registry
  // -------------------------------------------------------
  it('skips entries where target is not in registry', () => {
    const callerDecls = makeDeclarations({
      owns: [{ name: 'handleRequest' }],
    });
    const registry = buildRegistry(
      makeRegistryEntry('src/controller.ts', callerDecls),
      // No entry for 'src/unknown.ts'
    );

    const entry = makeTraceEntry({
      caller: 'src/controller.ts',
      target: 'src/unknown.ts',
      function: 'missingTarget',
    });

    const findings = analyzeContractMismatches([entry], registry);

    expect(findings).toEqual([]);
  });

  // -------------------------------------------------------
  // Test 12: Target with empty owns array triggers mismatch for any function call
  // -------------------------------------------------------
  it('detects mismatch when target owns is empty array', () => {
    const targetDecls = makeDeclarations({
      owns: [], // declares nothing
    });
    const callerDecls = makeDeclarations({
      owns: [{ name: 'callSomething' }],
    });
    const registry = buildRegistry(
      makeRegistryEntry('src/caller.ts', callerDecls),
      makeRegistryEntry('src/target.ts', targetDecls),
    );

    const entry = makeTraceEntry({
      caller: 'src/caller.ts',
      target: 'src/target.ts',
      function: 'anyFunction',
    });

    const findings = analyzeContractMismatches([entry], registry);

    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe('contract_mismatch');
    expect(findings[0].severity).toBe('high');
  });
});
