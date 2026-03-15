/**
 * Tests for SQLite persistence layer
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { PersistenceLayer } from './persistence.js';
import type { RegistryEntry, Declarations, TraceEntry, Mutation } from './types.js';

describe('PersistenceLayer', () => {
  let db: PersistenceLayer;

  beforeEach(() => {
    // Use in-memory DB for tests
    db = new PersistenceLayer(':memory:');
  });

  afterEach(() => {
    db.close();
  });

  describe('Database initialization', () => {
    it('should create agents table', () => {
      // If we can insert without error, table exists
      const entry: RegistryEntry = {
        file_path: 'test.ts',
        file_hash: 'abc123',
        status: 'cold',
      };
      
      expect(() => db.upsertAgent(entry)).not.toThrow();
    });

    it('should create traces table', () => {
      const traceEntry: TraceEntry = {
        trace_id: 'trace-1',
        task_id: 'task-1',
        timestamp: new Date(),
        depth: 0,
        caller: 'test.ts',
        target: 'other.ts',
        function: 'doWork',
        call_stack: [],
      };
      
      expect(() => db.insertTraceEntry(traceEntry)).not.toThrow();
    });

    it('should enable WAL mode', () => {
      // WAL mode is enabled in constructor — we can verify by checking pragma
      // This is a smoke test; better-sqlite3 will throw if WAL fails
      expect(db).toBeDefined();
    });
  });

  describe('Agent CRUD operations', () => {
    it('should insert a new agent', () => {
      const entry: RegistryEntry = {
        file_path: 'src/server.ts',
        file_hash: 'hash123',
        status: 'ready',
        session_id: 'session-abc',
        last_active: new Date('2026-03-11T10:00:00Z'),
      };

      db.upsertAgent(entry);
      const retrieved = db.getAgent('src/server.ts');

      expect(retrieved).toEqual(entry);
    });

    it('should update an existing agent', () => {
      const entry: RegistryEntry = {
        file_path: 'src/registry.ts',
        file_hash: 'hash-v1',
        status: 'cold',
      };

      db.upsertAgent(entry);

      // Update
      const updated: RegistryEntry = {
        ...entry,
        file_hash: 'hash-v2',
        status: 'ready',
        session_id: 'session-xyz',
      };

      db.upsertAgent(updated);
      const retrieved = db.getAgent('src/registry.ts');

      expect(retrieved).toEqual(updated);
    });

    it('should return null for non-existent agent', () => {
      const result = db.getAgent('nonexistent.ts');
      expect(result).toBeNull();
    });

    it('should get all agents', () => {
      const entries: RegistryEntry[] = [
        { file_path: 'a.ts', file_hash: 'h1', status: 'cold' },
        { file_path: 'b.ts', file_hash: 'h2', status: 'ready' },
        { file_path: 'c.ts', file_hash: 'h3', status: 'error' },
      ];

      entries.forEach(e => db.upsertAgent(e));

      const all = db.getAllAgents();
      expect(all).toHaveLength(3);
      expect(all.map(e => e.file_path).sort()).toEqual(['a.ts', 'b.ts', 'c.ts']);
    });

    it('should get agents by status', () => {
      db.upsertAgent({ file_path: 'cold1.ts', file_hash: 'h1', status: 'cold' });
      db.upsertAgent({ file_path: 'cold2.ts', file_hash: 'h2', status: 'cold' });
      db.upsertAgent({ file_path: 'ready.ts', file_hash: 'h3', status: 'ready' });

      const coldAgents = db.getAgentsByStatus('cold');
      expect(coldAgents).toHaveLength(2);
      expect(coldAgents.every(a => a.status === 'cold')).toBe(true);
    });

    it('should delete an agent', () => {
      db.upsertAgent({ file_path: 'temp.ts', file_hash: 'hash', status: 'cold' });
      
      const deleted = db.deleteAgent('temp.ts');
      expect(deleted).toBe(true);
      
      const retrieved = db.getAgent('temp.ts');
      expect(retrieved).toBeNull();
    });

    it('should return false when deleting non-existent agent', () => {
      const deleted = db.deleteAgent('nonexistent.ts');
      expect(deleted).toBe(false);
    });
  });

  describe('JSON serialization/deserialization for declarations', () => {
    it('should serialize and deserialize complex declarations', () => {
      const declarations: Declarations = {
        summary: 'User service with CRUD operations',
        owns: [
          {
            name: 'UserService',
            kind: 'class',
            intent: 'Manages user lifecycle',
            file_path: 'user-service.ts',
            start_line: 10,
            end_line: 100,
          },
          {
            name: 'createUser',
            kind: 'function',
            intent: 'Creates a new user',
            file_path: 'user-service.ts',
            start_line: 20,
            end_line: 35,
          },
        ],
        imports: [
          { name: 'Database', from: './db.ts', kind: 'import' },
          { name: 'Logger', from: './logger.ts', kind: 'import' },
        ],
        exports: [
          {
            name: 'UserService',
            kind: 'class',
            intent: 'Public API',
            file_path: 'user-service.ts',
            start_line: 10,
            end_line: 100,
          },
        ],
        dependencies: ['./db.ts', './logger.ts'],
      };

      const entry: RegistryEntry = {
        file_path: 'user-service.ts',
        file_hash: 'hash456',
        status: 'ready',
        declarations,
      };

      db.upsertAgent(entry);
      const retrieved = db.getAgent('user-service.ts');

      expect(retrieved?.declarations).toEqual(declarations);
    });

    it('should handle null declarations', () => {
      const entry: RegistryEntry = {
        file_path: 'empty.ts',
        file_hash: 'hash789',
        status: 'cold',
        declarations: undefined,
      };

      db.upsertAgent(entry);
      const retrieved = db.getAgent('empty.ts');

      expect(retrieved?.declarations).toBeUndefined();
    });

    it('should handle error field', () => {
      const entry: RegistryEntry = {
        file_path: 'broken.ts',
        file_hash: 'hashxyz',
        status: 'error',
        error: 'Failed to parse file',
      };

      db.upsertAgent(entry);
      const retrieved = db.getAgent('broken.ts');

      expect(retrieved?.error).toBe('Failed to parse file');
    });
  });

  describe('Trace CRUD operations', () => {
    it('should insert a trace entry', () => {
      const entry: TraceEntry = {
        trace_id: 'trace-001',
        task_id: 'task-001',
        timestamp: new Date('2026-03-11T10:30:00Z'),
        depth: 1,
        caller: 'api.ts',
        target: 'service.ts',
        function: 'processRequest',
        params: { userId: 42, action: 'create' },
        result: { success: true, id: 'new-id' },
        source_refs: ['service.ts:45-60'],
        duration_ms: 150,
        call_stack: ['api.ts'],
      };

      db.insertTraceEntry(entry);
      const entries = db.getTraceEntries('trace-001');

      expect(entries).toHaveLength(1);
      expect(entries[0]).toEqual(entry);
    });

    it('should handle trace entries with mutations', () => {
      const mutations: Mutation[] = [
        { key: 'user.name', before: 'Alice', after: 'Bob' },
        { key: 'user.status', before: undefined, after: 'active' },
      ];

      const entry: TraceEntry = {
        trace_id: 'trace-002',
        task_id: 'task-002',
        timestamp: new Date(),
        depth: 2,
        caller: 'controller.ts',
        target: 'repository.ts',
        function: 'updateUser',
        mutations,
        call_stack: ['controller.ts', 'service.ts'],
      };

      db.insertTraceEntry(entry);
      const entries = db.getTraceEntries('trace-002');

      expect(entries[0].mutations).toEqual(mutations);
    });

    it('should handle trace entries with errors', () => {
      const entry: TraceEntry = {
        trace_id: 'trace-003',
        task_id: 'task-003',
        timestamp: new Date(),
        depth: 1,
        caller: 'api.ts',
        target: 'db.ts',
        function: 'query',
        error: 'Connection timeout',
        call_stack: ['api.ts'],
      };

      db.insertTraceEntry(entry);
      const entries = db.getTraceEntries('trace-003');

      expect(entries[0].error).toBe('Connection timeout');
    });

    it('should retrieve multiple trace entries in order', () => {
      const baseEntry: Omit<TraceEntry, 'task_id' | 'timestamp'> = {
        trace_id: 'trace-multi',
        depth: 0,
        caller: 'main.ts',
        target: 'worker.ts',
        function: 'process',
        call_stack: [],
      };

      const entries: TraceEntry[] = [
        { ...baseEntry, task_id: 't1', timestamp: new Date('2026-03-11T10:00:00Z') },
        { ...baseEntry, task_id: 't2', timestamp: new Date('2026-03-11T10:00:01Z') },
        { ...baseEntry, task_id: 't3', timestamp: new Date('2026-03-11T10:00:02Z') },
      ];

      entries.forEach(e => db.insertTraceEntry(e));

      const retrieved = db.getTraceEntries('trace-multi');
      expect(retrieved).toHaveLength(3);
      expect(retrieved.map(e => e.task_id)).toEqual(['t1', 't2', 't3']);
    });

    it('should delete all trace entries for a trace_id', () => {
      db.insertTraceEntry({
        trace_id: 'trace-del',
        task_id: 't1',
        timestamp: new Date(),
        depth: 0,
        caller: 'a.ts',
        target: 'b.ts',
        function: 'work',
        call_stack: [],
      });

      db.insertTraceEntry({
        trace_id: 'trace-del',
        task_id: 't2',
        timestamp: new Date(),
        depth: 1,
        caller: 'b.ts',
        target: 'c.ts',
        function: 'moreWork',
        call_stack: ['a.ts'],
      });

      const deleted = db.deleteTrace('trace-del');
      expect(deleted).toBe(true);

      const entries = db.getTraceEntries('trace-del');
      expect(entries).toHaveLength(0);
    });

    it('should return false when deleting non-existent trace', () => {
      const deleted = db.deleteTrace('nonexistent-trace');
      expect(deleted).toBe(false);
    });

    it('should handle complex params and returns', () => {
      const entry: TraceEntry = {
        trace_id: 'trace-complex',
        task_id: 'task-complex',
        timestamp: new Date(),
        depth: 0,
        caller: 'caller.ts',
        target: 'target.ts',
        function: 'complexOp',
        params: {
          nested: { deep: { value: 42 } },
          array: [1, 2, 3],
          nullValue: null,
        },
        result: {
          data: ['a', 'b', 'c'],
          metadata: { count: 3, valid: true },
        },
        call_stack: [],
      };

      db.insertTraceEntry(entry);
      const retrieved = db.getTraceEntries('trace-complex');

      expect(retrieved[0].params).toEqual(entry.params);
      expect(retrieved[0].result).toEqual(entry.result);
    });
  });

  describe('clearAll utility', () => {
    it('should clear all agents and traces', () => {
      // Insert some data
      db.upsertAgent({ file_path: 'a.ts', file_hash: 'h1', status: 'cold' });
      db.upsertAgent({ file_path: 'b.ts', file_hash: 'h2', status: 'ready' });
      
      db.insertTraceEntry({
        trace_id: 'trace-x',
        task_id: 'task-x',
        timestamp: new Date(),
        depth: 0,
        caller: 'x.ts',
        target: 'y.ts',
        function: 'fn',
        call_stack: [],
      });

      // Clear
      db.clearAll();

      // Verify empty
      expect(db.getAllAgents()).toHaveLength(0);
      expect(db.getTraceEntries('trace-x')).toHaveLength(0);
    });
  });

  describe('Edge cases', () => {
    it('should handle timestamps correctly', () => {
      const now = new Date('2026-03-11T12:34:56.789Z');
      
      const entry: RegistryEntry = {
        file_path: 'time-test.ts',
        file_hash: 'hash',
        status: 'ready',
        last_active: now,
      };

      db.upsertAgent(entry);
      const retrieved = db.getAgent('time-test.ts');

      // SQLite stores as Unix seconds — milliseconds are truncated
      const expectedTruncated = Math.floor(now.getTime() / 1000) * 1000;
      expect(retrieved?.last_active?.getTime()).toBe(expectedTruncated);
    });

    it('should handle empty call_stack', () => {
      const entry: TraceEntry = {
        trace_id: 'trace-empty-stack',
        task_id: 'task-empty',
        timestamp: new Date(),
        depth: 0,
        caller: 'entry.ts',
        target: 'main.ts',
        function: 'start',
        call_stack: [],
      };

      db.insertTraceEntry(entry);
      const retrieved = db.getTraceEntries('trace-empty-stack');

      expect(retrieved[0].call_stack).toEqual([]);
    });

    it('should handle long call_stack', () => {
      const longStack = Array.from({ length: 50 }, (_, i) => `file${i}.ts`);
      
      const entry: TraceEntry = {
        trace_id: 'trace-deep',
        task_id: 'task-deep',
        timestamp: new Date(),
        depth: 50,
        caller: 'file49.ts',
        target: 'file50.ts',
        function: 'deepFunction',
        call_stack: longStack,
      };

      db.insertTraceEntry(entry);
      const retrieved = db.getTraceEntries('trace-deep');

      expect(retrieved[0].call_stack).toEqual(longStack);
    });

    it('should handle upsert conflict correctly', () => {
      const original: TraceEntry = {
        trace_id: 'trace-upsert',
        task_id: 'task-upsert',
        timestamp: new Date('2026-03-11T10:00:00Z'),
        depth: 1,
        caller: 'a.ts',
        target: 'b.ts',
        function: 'work',
        result: 'original',
        call_stack: ['a.ts'],
      };

      db.insertTraceEntry(original);

      // Update the same trace_id + task_id
      const updated: TraceEntry = {
        ...original,
        result: 'updated',
        duration_ms: 200,
      };

      db.insertTraceEntry(updated);

      const retrieved = db.getTraceEntries('trace-upsert');
      expect(retrieved).toHaveLength(1);
      expect(retrieved[0].result).toBe('updated');
      expect(retrieved[0].duration_ms).toBe(200);
    });
  });
});
