/**
 * FR-018: Dead Spot + Unexpected Call Detection
 *
 *   dead_spot: entries with error set, EXCLUDING 'CYCLE_DETECTED' and 'MAX_DEPTH_EXCEEDED'
 *     -> Finding{ type:'dead_spot', severity:'medium', caller, target, source_refs, description }
 *
 *   unexpected_call: caller declares dependencies but target NOT in those dependencies
 *     -> Finding{ type:'unexpected_call', severity:'low', caller, target, description }
 *
 * Functions under test:
 *   analyzeDeadSpots(entries: TraceEntry[]) -> Finding[]
 *   analyzeUnexpectedCalls(entries: TraceEntry[], registry: Registry) -> Finding[]
 */

import { describe, it, expect } from 'vitest';
import type { TraceEntry, Finding } from './types.js';
import { Registry } from './registry.js';
import type { Declarations, RegistryEntry, RegistryStatus } from './registry.js';
import { analyzeDeadSpots, analyzeUnexpectedCalls } from './analyzer.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTraceEntry(overrides: Partial<TraceEntry> = {}): TraceEntry {
  return {
    trace_id: 'trace-018',
    task_id: 'task-018',
    timestamp: new Date('2026-03-05T10:00:00Z'),
    depth: 1,
    caller: 'src/caller.ts',
    target: 'src/target.ts',
    function: 'doSomething',
    call_stack: ['src/caller.ts'],
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

function makeRegistryEntry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    file_path: 'src/caller.ts',
    file_hash: 'hash-001',
    status: 'ready' as RegistryStatus,
    session_id: 'session-001',
    declarations: null,
    last_active: new Date(),
    error: null,
    ...overrides,
  };
}

function buildRegistry(entries: RegistryEntry[]): Registry {
  const registry = new Registry();
  for (const entry of entries) {
    registry.add(entry);
  }
  return registry;
}

// ===========================================================================
// FR-018: analyzeDeadSpots
// ===========================================================================

describe('FR-018: analyzeDeadSpots', () => {
  // -------------------------------------------------------
  // Test 1: Importable and callable
  // -------------------------------------------------------
  it('is importable and callable', () => {
    expect(typeof analyzeDeadSpots).toBe('function');
  });

  // -------------------------------------------------------
  // Test 2: Returns empty array when no entries have errors
  // -------------------------------------------------------
  it('returns empty array when no entries have errors', () => {
    const entries: TraceEntry[] = [
      makeTraceEntry(),
      makeTraceEntry({ target: 'src/other.ts', function: 'otherFn' }),
    ];

    const findings = analyzeDeadSpots(entries);

    expect(findings).toEqual([]);
  });

  // -------------------------------------------------------
  // Test 3: Returns Finding for entry with error
  // -------------------------------------------------------
  it('returns Finding for entry with a non-excluded error', () => {
    const entries: TraceEntry[] = [
      makeTraceEntry({
        error: 'FILE_NOT_REGISTERED',
        source_refs: ['src/target.ts:42'],
      }),
    ];

    const findings = analyzeDeadSpots(entries);

    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe('dead_spot');
  });

  // -------------------------------------------------------
  // Test 4: Finding has correct shape and field values
  // -------------------------------------------------------
  it('produces Finding with type=dead_spot, severity=medium, correct caller/target/description', () => {
    const entries: TraceEntry[] = [
      makeTraceEntry({
        caller: 'src/orchestrator.ts',
        target: 'src/missing-service.ts',
        function: 'handleRequest',
        error: 'FILE_NOT_REGISTERED',
        source_refs: ['src/missing-service.ts:10'],
      }),
    ];

    const findings = analyzeDeadSpots(entries);

    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.type).toBe('dead_spot');
    expect(f.severity).toBe('medium');
    expect(f.caller).toBe('src/orchestrator.ts');
    expect(f.target).toBe('src/missing-service.ts');
    expect(f.description).toContain('src/missing-service.ts');
    expect(f.description).toContain('handleRequest');
    expect(f.description).toContain('FILE_NOT_REGISTERED');
    expect(f.source_refs).toEqual(['src/missing-service.ts:10']);
  });

  // -------------------------------------------------------
  // Test 5: EXCLUDES entries with error='CYCLE_DETECTED'
  // -------------------------------------------------------
  it('excludes entries with error=CYCLE_DETECTED', () => {
    const entries: TraceEntry[] = [
      makeTraceEntry({ error: 'CYCLE_DETECTED' }),
    ];

    const findings = analyzeDeadSpots(entries);

    expect(findings).toEqual([]);
  });

  // -------------------------------------------------------
  // Test 6: EXCLUDES entries with error='MAX_DEPTH_EXCEEDED'
  // -------------------------------------------------------
  it('excludes entries with error=MAX_DEPTH_EXCEEDED', () => {
    const entries: TraceEntry[] = [
      makeTraceEntry({ error: 'MAX_DEPTH_EXCEEDED' }),
    ];

    const findings = analyzeDeadSpots(entries);

    expect(findings).toEqual([]);
  });

  // -------------------------------------------------------
  // Test 7: Includes entries with other error strings
  // -------------------------------------------------------
  it('includes entries with AGENT_ERROR or any other non-excluded error string', () => {
    const entries: TraceEntry[] = [
      makeTraceEntry({ error: 'AGENT_ERROR: model timeout' }),
      makeTraceEntry({
        target: 'src/broken.ts',
        function: 'failHard',
        error: 'UNKNOWN_FUNCTION',
      }),
    ];

    const findings = analyzeDeadSpots(entries);

    expect(findings).toHaveLength(2);
    expect(findings.every((f: Finding) => f.type === 'dead_spot')).toBe(true);
    expect(findings.every((f: Finding) => f.severity === 'medium')).toBe(true);
  });

  // -------------------------------------------------------
  // Test 8: Uses source_refs from entry, defaults to []
  // -------------------------------------------------------
  it('uses source_refs from entry when present, empty array when undefined', () => {
    const entries: TraceEntry[] = [
      makeTraceEntry({
        error: 'PARSE_FAILURE',
        source_refs: ['src/target.ts:1', 'src/target.ts:55'],
      }),
      makeTraceEntry({
        target: 'src/other.ts',
        error: 'TIMEOUT',
        // source_refs intentionally omitted
      }),
    ];

    const findings = analyzeDeadSpots(entries);

    expect(findings).toHaveLength(2);

    const withRefs = findings.find(
      (f: Finding) => f.description.includes('PARSE_FAILURE'),
    )!;
    expect(withRefs.source_refs).toEqual(['src/target.ts:1', 'src/target.ts:55']);

    const withoutRefs = findings.find(
      (f: Finding) => f.description.includes('TIMEOUT'),
    )!;
    expect(withoutRefs.source_refs).toEqual([]);
  });
});

// ===========================================================================
// FR-018: analyzeUnexpectedCalls
// ===========================================================================

describe('FR-018: analyzeUnexpectedCalls', () => {
  // -------------------------------------------------------
  // Test 1: Importable and callable
  // -------------------------------------------------------
  it('is importable and callable', () => {
    expect(typeof analyzeUnexpectedCalls).toBe('function');
  });

  // -------------------------------------------------------
  // Test 2: Returns empty array when all calls match dependencies
  // -------------------------------------------------------
  it('returns empty array when all calls are in caller dependencies', () => {
    const registry = buildRegistry([
      makeRegistryEntry({
        file_path: 'src/caller.ts',
        declarations: makeDeclarations({
          dependencies: ['src/target.ts'],
        }),
      }),
      makeRegistryEntry({
        file_path: 'src/target.ts',
        file_hash: 'hash-002',
      }),
    ]);

    const entries: TraceEntry[] = [
      makeTraceEntry({
        caller: 'src/caller.ts',
        target: 'src/target.ts',
      }),
    ];

    const findings = analyzeUnexpectedCalls(entries, registry);

    expect(findings).toEqual([]);
  });

  // -------------------------------------------------------
  // Test 3: Returns Finding when target NOT in caller deps
  // -------------------------------------------------------
  it('returns Finding when target is not in caller declarations.dependencies', () => {
    const registry = buildRegistry([
      makeRegistryEntry({
        file_path: 'src/caller.ts',
        declarations: makeDeclarations({
          dependencies: ['src/allowed.ts'],
        }),
      }),
      makeRegistryEntry({
        file_path: 'src/unexpected.ts',
        file_hash: 'hash-003',
      }),
    ]);

    const entries: TraceEntry[] = [
      makeTraceEntry({
        caller: 'src/caller.ts',
        target: 'src/unexpected.ts',
        function: 'sneakyCall',
      }),
    ];

    const findings = analyzeUnexpectedCalls(entries, registry);

    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe('unexpected_call');
  });

  // -------------------------------------------------------
  // Test 4: Finding has correct shape
  // -------------------------------------------------------
  it('produces Finding with type=unexpected_call, severity=low', () => {
    const registry = buildRegistry([
      makeRegistryEntry({
        file_path: 'src/caller.ts',
        declarations: makeDeclarations({
          dependencies: ['src/legit.ts'],
        }),
      }),
    ]);

    const entries: TraceEntry[] = [
      makeTraceEntry({
        caller: 'src/caller.ts',
        target: 'src/rogue.ts',
        function: 'rogueCall',
      }),
    ];

    const findings = analyzeUnexpectedCalls(entries, registry);

    expect(findings).toHaveLength(1);
    const f = findings[0];
    expect(f.type).toBe('unexpected_call');
    expect(f.severity).toBe('low');
    expect(f.caller).toBe('src/caller.ts');
    expect(f.target).toBe('src/rogue.ts');
    expect(f.description).toBeTruthy();
  });

  // -------------------------------------------------------
  // Test 5: Skips entries where caller has no declarations
  // -------------------------------------------------------
  it('skips entries where caller has no declarations (null)', () => {
    const registry = buildRegistry([
      makeRegistryEntry({
        file_path: 'src/caller.ts',
        declarations: null, // no declarations
      }),
    ]);

    const entries: TraceEntry[] = [
      makeTraceEntry({
        caller: 'src/caller.ts',
        target: 'src/anything.ts',
      }),
    ];

    const findings = analyzeUnexpectedCalls(entries, registry);

    expect(findings).toEqual([]);
  });

  // -------------------------------------------------------
  // Test 6: Skips entries where caller is __trace_initiator__
  // -------------------------------------------------------
  it('skips entries where caller is __trace_initiator__', () => {
    const registry = buildRegistry([
      makeRegistryEntry({
        file_path: 'src/target.ts',
        file_hash: 'hash-004',
      }),
    ]);

    const entries: TraceEntry[] = [
      makeTraceEntry({
        caller: '__trace_initiator__',
        target: 'src/target.ts',
      }),
    ];

    const findings = analyzeUnexpectedCalls(entries, registry);

    expect(findings).toEqual([]);
  });

  // -------------------------------------------------------
  // Test 7: Handles mixed expected/unexpected entries
  // -------------------------------------------------------
  it('handles multiple entries with mixed expected and unexpected calls', () => {
    const registry = buildRegistry([
      makeRegistryEntry({
        file_path: 'src/caller.ts',
        declarations: makeDeclarations({
          dependencies: ['src/allowed-a.ts', 'src/allowed-b.ts'],
        }),
      }),
      makeRegistryEntry({
        file_path: 'src/allowed-a.ts',
        file_hash: 'hash-a',
      }),
      makeRegistryEntry({
        file_path: 'src/allowed-b.ts',
        file_hash: 'hash-b',
      }),
      makeRegistryEntry({
        file_path: 'src/forbidden.ts',
        file_hash: 'hash-f',
      }),
    ]);

    const entries: TraceEntry[] = [
      makeTraceEntry({
        caller: 'src/caller.ts',
        target: 'src/allowed-a.ts',
        function: 'okCall',
      }),
      makeTraceEntry({
        caller: 'src/caller.ts',
        target: 'src/forbidden.ts',
        function: 'badCall',
      }),
      makeTraceEntry({
        caller: 'src/caller.ts',
        target: 'src/allowed-b.ts',
        function: 'anotherOkCall',
      }),
    ];

    const findings = analyzeUnexpectedCalls(entries, registry);

    expect(findings).toHaveLength(1);
    expect(findings[0].type).toBe('unexpected_call');
    expect(findings[0].target).toBe('src/forbidden.ts');
  });
});
