/**
 * RED Phase Tests -- FR-013: TraceLog
 *
 * SPEC grounding:
 *   Architecture.trace_log:⊳{ entries:[TraceEntry]!, format:∈['json','jsonl']='jsonl' }
 *   TraceEntry defined in types.ts
 *
 * TraceLog class: add(), getByTraceId(), toJSONL(), list(), size, clear()
 *
 * Implementation: ./trace-log.ts
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { TraceEntry } from './types.js';
import { TraceLog } from './trace-log.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTraceEntry(overrides: Partial<TraceEntry> = {}): TraceEntry {
  return {
    trace_id: 'trace-001',
    task_id: 'task-001',
    timestamp: new Date('2026-03-04T12:00:00Z'),
    depth: 0,
    caller: 'src/handler.ts',
    target: 'src/service.ts',
    function: 'doWork',
    call_stack: [],
    ...overrides,
  };
}

// ===========================================================================
// FR-013: TraceLog
// ===========================================================================

describe('FR-013: TraceLog', () => {
  let traceLog: TraceLog;

  beforeEach(() => {
    traceLog = new TraceLog();
  });

  // -------------------------------------------------------
  // Test 1: Empty log has size 0
  // -------------------------------------------------------
  it('has size 0 when empty', () => {
    expect(traceLog.size).toBe(0);
  });

  // -------------------------------------------------------
  // Test 2: Empty log list() returns empty array
  // -------------------------------------------------------
  it('list() returns empty array when empty', () => {
    expect(traceLog.list()).toEqual([]);
  });

  // -------------------------------------------------------
  // Test 3: add() stores an entry and increments size
  // -------------------------------------------------------
  it('add() stores an entry and increments size', () => {
    const entry = makeTraceEntry();
    traceLog.add(entry);

    expect(traceLog.size).toBe(1);
  });

  // -------------------------------------------------------
  // Test 4: add() multiple entries preserves insertion order
  // -------------------------------------------------------
  it('add() multiple entries preserves insertion order', () => {
    const e1 = makeTraceEntry({ task_id: 'task-001' });
    const e2 = makeTraceEntry({ task_id: 'task-002' });
    const e3 = makeTraceEntry({ task_id: 'task-003' });

    traceLog.add(e1);
    traceLog.add(e2);
    traceLog.add(e3);

    const entries = traceLog.list();
    expect(entries).toHaveLength(3);
    expect(entries[0].task_id).toBe('task-001');
    expect(entries[1].task_id).toBe('task-002');
    expect(entries[2].task_id).toBe('task-003');
  });

  // -------------------------------------------------------
  // Test 5: list() returns all stored entries
  // -------------------------------------------------------
  it('list() returns all stored entries', () => {
    traceLog.add(makeTraceEntry({ task_id: 'a' }));
    traceLog.add(makeTraceEntry({ task_id: 'b' }));

    expect(traceLog.list()).toHaveLength(2);
  });

  // -------------------------------------------------------
  // Test 6: getByTraceId() filters entries matching trace_id
  // -------------------------------------------------------
  it('getByTraceId() returns entries matching trace_id', () => {
    traceLog.add(makeTraceEntry({ trace_id: 'trace-AAA', task_id: 'a1' }));
    traceLog.add(makeTraceEntry({ trace_id: 'trace-BBB', task_id: 'b1' }));
    traceLog.add(makeTraceEntry({ trace_id: 'trace-AAA', task_id: 'a2' }));

    const result = traceLog.getByTraceId('trace-AAA');
    expect(result).toHaveLength(2);
    expect(result[0].task_id).toBe('a1');
    expect(result[1].task_id).toBe('a2');
  });

  // -------------------------------------------------------
  // Test 7: getByTraceId() returns empty array on no match
  // -------------------------------------------------------
  it('getByTraceId() returns empty array when no entries match', () => {
    traceLog.add(makeTraceEntry({ trace_id: 'trace-AAA' }));

    expect(traceLog.getByTraceId('trace-ZZZ')).toEqual([]);
  });

  // -------------------------------------------------------
  // Test 8: getByTraceId() on empty log returns empty array
  // -------------------------------------------------------
  it('getByTraceId() returns empty array on empty log', () => {
    expect(traceLog.getByTraceId('trace-001')).toEqual([]);
  });

  // -------------------------------------------------------
  // Test 9: toJSONL() returns empty string for empty log
  // -------------------------------------------------------
  it('toJSONL() returns empty string for empty log', () => {
    expect(traceLog.toJSONL()).toBe('');
  });

  // -------------------------------------------------------
  // Test 10: toJSONL() single entry = one JSON line
  // -------------------------------------------------------
  it('toJSONL() returns one line for single entry', () => {
    traceLog.add(makeTraceEntry({ task_id: 'only-one' }));

    const jsonl = traceLog.toJSONL();
    const lines = jsonl.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]);
    expect(parsed.task_id).toBe('only-one');
  });

  // -------------------------------------------------------
  // Test 11: toJSONL() multiple entries = one JSON per line
  // -------------------------------------------------------
  it('toJSONL() returns one JSON object per line for multiple entries', () => {
    traceLog.add(makeTraceEntry({ task_id: 'first' }));
    traceLog.add(makeTraceEntry({ task_id: 'second' }));
    traceLog.add(makeTraceEntry({ task_id: 'third' }));

    const jsonl = traceLog.toJSONL();
    const lines = jsonl.split('\n').filter((l) => l.length > 0);
    expect(lines).toHaveLength(3);

    expect(JSON.parse(lines[0]).task_id).toBe('first');
    expect(JSON.parse(lines[1]).task_id).toBe('second');
    expect(JSON.parse(lines[2]).task_id).toBe('third');
  });

  // -------------------------------------------------------
  // Test 12: toJSONL() lines contain no embedded newlines
  // -------------------------------------------------------
  it('toJSONL() individual lines contain no embedded newlines', () => {
    traceLog.add(makeTraceEntry());

    const jsonl = traceLog.toJSONL();
    const lines = jsonl.split('\n').filter((l) => l.length > 0);

    for (const line of lines) {
      expect(line).not.toContain('\n');
      // Verify it's valid JSON
      expect(() => JSON.parse(line)).not.toThrow();
    }
  });

  // -------------------------------------------------------
  // Test 13: clear() removes all entries
  // -------------------------------------------------------
  it('clear() removes all entries', () => {
    traceLog.add(makeTraceEntry());
    traceLog.add(makeTraceEntry());

    traceLog.clear();

    expect(traceLog.size).toBe(0);
    expect(traceLog.list()).toEqual([]);
  });

  // -------------------------------------------------------
  // Test 14: clear() resets getByTraceId
  // -------------------------------------------------------
  it('clear() resets getByTraceId results', () => {
    traceLog.add(makeTraceEntry({ trace_id: 'trace-AAA' }));
    traceLog.clear();

    expect(traceLog.getByTraceId('trace-AAA')).toEqual([]);
  });

  // -------------------------------------------------------
  // Test 15: clear() resets toJSONL
  // -------------------------------------------------------
  it('clear() resets toJSONL to empty string', () => {
    traceLog.add(makeTraceEntry());
    traceLog.clear();

    expect(traceLog.toJSONL()).toBe('');
  });

  // -------------------------------------------------------
  // Test 16: Log is reusable after clear
  // -------------------------------------------------------
  it('log is reusable after clear()', () => {
    traceLog.add(makeTraceEntry({ task_id: 'before-clear' }));
    traceLog.clear();
    traceLog.add(makeTraceEntry({ task_id: 'after-clear' }));

    expect(traceLog.size).toBe(1);
    expect(traceLog.list()[0].task_id).toBe('after-clear');
  });

  // -------------------------------------------------------
  // Test 17: Handles entries with all optional fields populated
  // -------------------------------------------------------
  it('handles entries with all optional fields populated', () => {
    const fullEntry = makeTraceEntry({
      params: { userId: 42 },
      result: { status: 'ok' },
      mutations: [{ key: 'users', before: null, after: [{ id: 42 }] }],
      source_refs: ['src/service.ts:10-20'],
      duration_ms: 150,
    });

    traceLog.add(fullEntry);

    const retrieved = traceLog.list()[0];
    expect(retrieved.params).toEqual({ userId: 42 });
    expect(retrieved.result).toEqual({ status: 'ok' });
    expect(retrieved.mutations).toHaveLength(1);
    expect(retrieved.source_refs).toEqual(['src/service.ts:10-20']);
    expect(retrieved.duration_ms).toBe(150);
  });

  // -------------------------------------------------------
  // Test 18: Handles entries with error field
  // -------------------------------------------------------
  it('handles entries with error field', () => {
    const errorEntry = makeTraceEntry({
      error: 'CYCLE_DETECTED',
      duration_ms: 5,
    });

    traceLog.add(errorEntry);

    const retrieved = traceLog.list()[0];
    expect(retrieved.error).toBe('CYCLE_DETECTED');
  });

  // -------------------------------------------------------
  // Test 19: toJSONL() serializes Date as ISO string
  // -------------------------------------------------------
  it('toJSONL() serializes timestamp as ISO string', () => {
    const timestamp = new Date('2026-03-04T12:00:00Z');
    traceLog.add(makeTraceEntry({ timestamp }));

    const jsonl = traceLog.toJSONL();
    const parsed = JSON.parse(jsonl.trim());
    expect(parsed.timestamp).toBe('2026-03-04T12:00:00.000Z');
  });
});
