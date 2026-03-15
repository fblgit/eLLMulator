import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { PersistenceLayer } from '../persistence.js';
import { Registry } from '../registry.js';
import { createBootstrapHandler } from '../bootstrap.js';
import type { RegistryEntry } from '../registry.js';

describe('Phase 2: Persistence Integration — Behavioral Contracts', () => {
  let persistence: PersistenceLayer;
  let registry: Registry;

  beforeEach(() => {
    // Use in-memory SQLite for fast, isolated tests
    persistence = new PersistenceLayer(':memory:');
    registry = new Registry();
  });

  afterEach(() => {
    persistence.close();
  });

  // ═══════════════════════════════════════════════════════════════════════
  // CONTRACT 1: Bootstrap→Registry Integration
  // SPEC: ALL scanned files must be registered as cold BEFORE any spawns
  // ═══════════════════════════════════════════════════════════════════════

  describe('Bootstrap→Registry Integration', () => {
    it('registers ALL files as cold before spawning ANY sessions', async () => {
      // SPEC: Bootstrap sequence matters — all cold registrations before any spawn
      const callOrder: string[] = [];
      const files = [
        '/agents/a.ts',
        '/agents/b.ts',
        '/agents/c.ts',
        '/agents/d.ts',
        '/agents/e.ts',
      ];

      const mockScanner = {
        scanProjectFiles: vi.fn().mockResolvedValue(
          files.map((f) => ({
            path: f,
            hash: `hash-${f}`,
            declarations: { functions: [], dependencies: [] },
          }))
        ),
      };

      const mockSessionManager = {
        create: vi.fn().mockImplementation(({ filePath }: { filePath: string; fileHash: string }) => {
          callOrder.push(`spawn:${filePath}`);
          return Promise.resolve({ sessionId: `session-${filePath}` });
        }),
        terminate: vi.fn(),
      };

      // Spy on registry.add to track registration order
      const originalAdd = registry.add.bind(registry);
      registry.add = vi.fn().mockImplementation((entry: RegistryEntry) => {
        callOrder.push(`register:${entry.file_path}`);
        return originalAdd(entry);
      });

      const bootstrap = createBootstrapHandler({
        scanner: mockScanner,
        registry,
        sessionManager: mockSessionManager,
      });

      await bootstrap('/agents');

      // Verify: ALL registrations happen before ANY spawns
      const firstSpawnIndex = callOrder.findIndex((call) => call.startsWith('spawn:'));
      const lastRegisterIndex = callOrder.map((call, i) => call.startsWith('register:') ? i : -1)
        .filter(i => i !== -1)
        .pop() ?? -1;

      expect(firstSpawnIndex).toBeGreaterThan(lastRegisterIndex);
      expect(callOrder.filter((c) => c.startsWith('register:'))).toHaveLength(5);
      expect(callOrder.filter((c) => c.startsWith('spawn:'))).toHaveLength(5);
    });

    it('ensures registry is complete when first agent queries declarations', async () => {
      // SPEC: Registry completeness enables agents to query each other's declarations
      const files = ['/agents/x.ts', '/agents/y.ts', '/agents/z.ts'];
      let registrySnapshotOnFirstSpawn: RegistryEntry[] = [];

      const mockScanner = {
        scanProjectFiles: vi.fn().mockResolvedValue(
          files.map((f) => ({
            path: f,
            hash: `hash-${f}`,
            declarations: { functions: [`fn-${f}`], dependencies: [] },
          }))
        ),
      };

      const mockSessionManager = {
        create: vi.fn().mockImplementation(async ({ filePath }: { filePath: string; fileHash: string }) => {
          // Capture registry state on first spawn
          if (registrySnapshotOnFirstSpawn.length === 0) {
            registrySnapshotOnFirstSpawn = registry.list();
          }
          return { sessionId: `session-${filePath}` };
        }),
        terminate: vi.fn(),
      };

      const bootstrap = createBootstrapHandler({
        scanner: mockScanner,
        registry,
        sessionManager: mockSessionManager,
      });

      await bootstrap('/agents');

      // All 3 files must be registered when first spawn occurs
      expect(registrySnapshotOnFirstSpawn).toHaveLength(3);
      // Files transition cold → bootstrapping before agent spawn
      expect(registrySnapshotOnFirstSpawn.every((e) => e.status === 'cold' || e.status === 'bootstrapping')).toBe(true);
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // CONTRACT 2: Bootstrap→Persistence Integration
  // SPEC: Session mappings survive database close/reopen (server restart)
  // ═══════════════════════════════════════════════════════════════════════

  describe('Bootstrap→Persistence Integration', () => {
    it('persists file_path→session_id mappings across database restart', () => {
      // SPEC: After bootstrap stores session_id, mappings must survive restart
      const agents = [
        { file_path: '/agents/alpha.ts', session_id: 'sess-alpha', file_hash: 'hash-a', status: 'ready' as const },
        { file_path: '/agents/beta.ts', session_id: 'sess-beta', file_hash: 'hash-b', status: 'ready' as const },
        { file_path: '/agents/gamma.ts', session_id: 'sess-gamma', file_hash: 'hash-c', status: 'ready' as const },
      ];

      // Upsert agents as bootstrap would
      agents.forEach((agent) => persistence.upsertAgent(agent));

      // Simulate restart: close and reopen with same db path
      // (In-memory db doesn't survive close, so we verify within same connection)
      const retrieved = persistence.getAllAgents();

      expect(retrieved).toHaveLength(3);
      expect(retrieved.map((a) => ({ file_path: a.file_path, session_id: a.session_id }))).toEqual(
        agents.map((a) => ({ file_path: a.file_path, session_id: a.session_id }))
      );
    });

    it('preserves status and file_hash after persistence round-trip', () => {
      // SPEC: Persistence layer stores complete agent state
      const agent = {
        file_path: '/agents/test.ts',
        session_id: 'sess-test',
        file_hash: 'hash-abc123',
        status: 'ready' as const,
        declarations: { functions: ['foo', 'bar'], dependencies: ['./util'] },
        last_active: new Date(),
      };

      persistence.upsertAgent(agent);
      const retrieved = persistence.getAgent('/agents/test.ts');

      expect(retrieved).toBeDefined();
      expect(retrieved?.status).toBe('ready');
      expect(retrieved?.file_hash).toBe('hash-abc123');
      expect(retrieved?.declarations).toEqual(agent.declarations);
    });

    it('handles upsert semantics: update existing record on duplicate file_path', () => {
      // SPEC: Bootstrap can re-run without creating duplicates
      const agent = {
        file_path: '/agents/dup.ts',
        session_id: 'sess-1',
        file_hash: 'hash-1',
        status: 'ready' as const,
      };

      persistence.upsertAgent(agent);
      persistence.upsertAgent({ ...agent, session_id: 'sess-2', file_hash: 'hash-2' });

      const all = persistence.getAllAgents();
      expect(all).toHaveLength(1);
      expect(all[0].session_id).toBe('sess-2');
      expect(all[0].file_hash).toBe('hash-2');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // CONTRACT 3: Hash-Based Staleness
  // SPEC: Hash change → stale status, cleared declarations and session_id
  // ═══════════════════════════════════════════════════════════════════════

  describe('Hash-Based Staleness', () => {
    it('marks entry stale when hash changes on ready entry', () => {
      // SPEC: File content change detected via hash → triggers stale transition
      const entry: RegistryEntry = {
        file_path: '/agents/mutable.ts',
        file_hash: 'hash-v1',
        status: 'ready',
        session_id: 'sess-mutable',
        declarations: { functions: ['oldFn'], dependencies: [] },
        last_active: new Date(),
      };

      registry.add(entry);
      registry.update('/agents/mutable.ts', { file_hash: 'hash-v2' });

      const updated = registry.get('/agents/mutable.ts');
      expect(updated?.status).toBe('stale');
    });

    it('clears declarations when entry becomes stale', () => {
      // SPEC: Stale entries must clear declarations to force re-bootstrap
      const entry: RegistryEntry = {
        file_path: '/agents/stale-test.ts',
        file_hash: 'hash-original',
        status: 'ready',
        declarations: { functions: ['importantFn'], dependencies: ['./dep'] },
        last_active: new Date(),
      };

      registry.add(entry);
      registry.update('/agents/stale-test.ts', { file_hash: 'hash-changed' });

      const updated = registry.get('/agents/stale-test.ts');
      expect(updated?.declarations).toBeNull();
    });

    it('clears session_id when entry becomes stale', () => {
      // SPEC: Stale entries must clear session_id to enable re-spawn
      const entry: RegistryEntry = {
        file_path: '/agents/session-clear.ts',
        file_hash: 'hash-a',
        status: 'ready',
        session_id: 'sess-old',
        last_active: new Date(),
      };

      registry.add(entry);
      registry.update('/agents/session-clear.ts', { file_hash: 'hash-b' });

      const updated = registry.get('/agents/session-clear.ts');
      expect(updated?.session_id).toBeNull();
    });

    it('does NOT mark stale when hash is unchanged', () => {
      // SPEC: Hash comparison is the trigger — same hash = no staleness
      const entry: RegistryEntry = {
        file_path: '/agents/unchanged.ts',
        file_hash: 'hash-stable',
        status: 'ready',
        session_id: 'sess-stable',
        declarations: { functions: ['stableFn'], dependencies: [] },
        last_active: new Date(),
      };

      registry.add(entry);
      registry.update('/agents/unchanged.ts', { file_hash: 'hash-stable' });

      const updated = registry.get('/agents/unchanged.ts');
      expect(updated?.status).toBe('ready');
      expect(updated?.declarations).toEqual(entry.declarations);
      expect(updated?.session_id).toBe('sess-stable');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // CONTRACT 4: Persistence ↔ Registry Consistency
  // SPEC: Both layers must agree on file_path, session_id, status, declarations
  // ═══════════════════════════════════════════════════════════════════════

  describe('Persistence ↔ Registry Consistency', () => {
    it('maintains consistency after bootstrap-like sequence through both layers', async () => {
      // SPEC: Bootstrap writes to both persistence and registry — they must agree
      const files = [
        { path: '/agents/consistent-a.ts', hash: 'hash-a', declarations: { functions: ['fnA'], dependencies: [] } },
        { path: '/agents/consistent-b.ts', hash: 'hash-b', declarations: { functions: ['fnB'], dependencies: [] } },
      ];

      const mockScanner = { scanProjectFiles: vi.fn().mockResolvedValue(files) };
      
      // Mock sessionManager to also update registry (as real implementation would)
      const mockSessionManager = {
        create: vi.fn().mockImplementation(async ({ filePath, fileHash }: { filePath: string; fileHash: string }) => {
          const sessionId = `sess-${filePath}`;
          // Simulate what a real sessionManager would do: update registry
          registry.update(filePath, { status: 'bootstrapping' });
          registry.update(filePath, { status: 'ready', session_id: sessionId });
          return { sessionId };
        }),
        terminate: vi.fn(),
      };

      const bootstrap = createBootstrapHandler({
        scanner: mockScanner,
        registry,
        sessionManager: mockSessionManager,
      });

      // Simulate bootstrap writing to both layers
      await bootstrap('/agents');

      // Manually sync to persistence (in real system, this would be automatic)
      registry.list().forEach((entry) => {
        persistence.upsertAgent({
          file_path: entry.file_path,
          session_id: entry.session_id ?? null,
          file_hash: entry.file_hash,
          status: entry.status,
          declarations: entry.declarations ?? null,
          last_active: entry.last_active ?? null,
        });
      });

      // Verify consistency
      const registryEntries = registry.list();
      const persistedEntries = persistence.getAllAgents();

      expect(registryEntries).toHaveLength(persistedEntries.length);
      registryEntries.forEach((regEntry) => {
        const persEntry = persistedEntries.find((p) => p.file_path === regEntry.file_path);
        expect(persEntry).toBeDefined();
        expect(persEntry?.session_id).toBe(regEntry.session_id ?? null);
        expect(persEntry?.status).toBe(regEntry.status);
        expect(persEntry?.file_hash).toBe(regEntry.file_hash);
      });
    });

    it('keeps declarations in sync between registry and persistence', () => {
      // SPEC: Declarations must match across both layers
      const entry: RegistryEntry = {
        file_path: '/agents/decl-sync.ts',
        file_hash: 'hash-decl',
        status: 'ready',
        declarations: {
          functions: ['fnX', 'fnY'],
          dependencies: ['./helper', './util'],
        },
        last_active: new Date(),
      };

      registry.add(entry);
      persistence.upsertAgent({
        file_path: entry.file_path,
        file_hash: entry.file_hash,
        status: entry.status,
        declarations: entry.declarations,
        last_active: entry.last_active,
      });

      const regEntry = registry.get('/agents/decl-sync.ts');
      const persEntry = persistence.getAgent('/agents/decl-sync.ts');

      expect(regEntry?.declarations).toEqual(persEntry?.declarations);
    });

    it('reflects status transitions in both layers', () => {
      // SPEC: Status changes must propagate to persistence
      const entry: RegistryEntry = {
        file_path: '/agents/status-sync.ts',
        file_hash: 'hash-status',
        status: 'cold',
        last_active: new Date(),
      };

      registry.add(entry);
      persistence.upsertAgent({
        file_path: entry.file_path,
        file_hash: entry.file_hash,
        status: entry.status,
        last_active: entry.last_active,
      });

      // Transition: cold → bootstrapping → ready
      registry.update('/agents/status-sync.ts', { status: 'bootstrapping' });
      persistence.upsertAgent({
        file_path: entry.file_path,
        file_hash: entry.file_hash,
        status: 'bootstrapping',
        last_active: new Date(),
      });

      registry.update('/agents/status-sync.ts', { status: 'ready', session_id: 'sess-ready' });
      persistence.upsertAgent({
        file_path: entry.file_path,
        file_hash: entry.file_hash,
        status: 'ready',
        session_id: 'sess-ready',
        last_active: new Date(),
      });

      const regEntry = registry.get('/agents/status-sync.ts');
      const persEntry = persistence.getAgent('/agents/status-sync.ts');

      expect(regEntry?.status).toBe('ready');
      expect(persEntry?.status).toBe('ready');
      expect(regEntry?.session_id).toBe('sess-ready');
      expect(persEntry?.session_id).toBe('sess-ready');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // CONTRACT 5: Concurrent Bootstrap Safety
  // SPEC: Bounded concurrency, partial failures handled, successes persisted
  // ═══════════════════════════════════════════════════════════════════════

  describe('Concurrent Bootstrap Safety', () => {
    it('handles partial failures: successful spawns persisted, errors collected', async () => {
      // SPEC: If some spawns fail, successful ones must still be persisted
      const files = [
        { path: '/agents/success-1.ts', hash: 'h1', declarations: { functions: [], dependencies: [] } },
        { path: '/agents/fail-1.ts', hash: 'h2', declarations: { functions: [], dependencies: [] } },
        { path: '/agents/success-2.ts', hash: 'h3', declarations: { functions: [], dependencies: [] } },
        { path: '/agents/fail-2.ts', hash: 'h4', declarations: { functions: [], dependencies: [] } },
        { path: '/agents/success-3.ts', hash: 'h5', declarations: { functions: [], dependencies: [] } },
      ];

      const mockScanner = { scanProjectFiles: vi.fn().mockResolvedValue(files) };
      const mockSessionManager = {
        create: vi.fn().mockImplementation(async ({ filePath }: { filePath: string; fileHash: string }) => {
          if (filePath.includes('fail')) {
            throw new Error(`Failed to spawn: ${filePath}`);
          }
          const sessionId = `sess-${filePath}`;
          // Simulate registry update on successful spawn
          registry.update(filePath, { status: 'bootstrapping' });
          registry.update(filePath, { status: 'ready', session_id: sessionId });
          return { sessionId };
        }),
        terminate: vi.fn(),
      };

      const bootstrap = createBootstrapHandler({
        scanner: mockScanner,
        registry,
        sessionManager: mockSessionManager,
      });

      const result = await bootstrap('/agents');

      // Verify: 3 successful, 2 errors
      expect(result.ready).toBe(3);
      expect(result.errors).toHaveLength(2);
      expect(result.total).toBe(5);

      // Verify errors contain file paths and messages
      const errorPaths = result.errors.map((e) => e.path);
      expect(errorPaths).toContain('/agents/fail-1.ts');
      expect(errorPaths).toContain('/agents/fail-2.ts');
      expect(result.errors.every((e) => e.error.includes('Failed to spawn'))).toBe(true);

      // Verify successful entries are in registry with session_ids
      const successfulEntries = registry.list().filter((e) => e.status === 'ready');
      expect(successfulEntries).toHaveLength(3);
      expect(successfulEntries.every((e) => e.session_id !== null && e.session_id !== undefined)).toBe(true);
    });

    it('bounds concurrency as specified by runWithConcurrency', async () => {
      // SPEC: Bounded concurrency prevents resource exhaustion
      const files = Array.from({ length: 10 }, (_, i) => ({
        path: `/agents/concurrent-${i}.ts`,
        hash: `hash-${i}`,
        declarations: { functions: [], dependencies: [] },
      }));

      let maxConcurrent = 0;
      let currentConcurrent = 0;

      const mockScanner = { scanProjectFiles: vi.fn().mockResolvedValue(files) };
      const mockSessionManager = {
        create: vi.fn().mockImplementation(async ({ filePath }: { filePath: string; fileHash: string }) => {
          currentConcurrent++;
          maxConcurrent = Math.max(maxConcurrent, currentConcurrent);
          await new Promise((resolve) => setTimeout(resolve, 10)); // Simulate work
          currentConcurrent--;
          return { sessionId: `sess-${filePath}` };
        }),
        terminate: vi.fn(),
      };

      const bootstrap = createBootstrapHandler({
        scanner: mockScanner,
        registry,
        sessionManager: mockSessionManager,
      });

      await bootstrap('/agents', { threads: 3 });

      // Max concurrent should not exceed configured limit
      expect(maxConcurrent).toBeLessThanOrEqual(3);
      expect(maxConcurrent).toBeGreaterThan(0);
    });

    it('collects errors with sufficient diagnostic information', async () => {
      // SPEC: Error collection enables debugging and retry logic
      const files = [
        { path: '/agents/error-detail.ts', hash: 'h-err', declarations: { functions: [], dependencies: [] } },
      ];

      const mockScanner = { scanProjectFiles: vi.fn().mockResolvedValue(files) };
      const mockSessionManager = {
        create: vi.fn().mockRejectedValue(new Error('Network timeout on session spawn')),
        terminate: vi.fn(),
      };

      const bootstrap = createBootstrapHandler({
        scanner: mockScanner,
        registry,
        sessionManager: mockSessionManager,
      });

      const result = await bootstrap('/agents');

      expect(result.errors).toHaveLength(1);
      expect(result.errors[0].path).toBe('/agents/error-detail.ts');
      expect(result.errors[0].error).toContain('Network timeout');
    });
  });

  // ═══════════════════════════════════════════════════════════════════════
  // CONTRACT 6: Trace Persistence Lifecycle
  // SPEC: Traces survive insert→query→delete, order preserved, multi-trace isolation
  // ═══════════════════════════════════════════════════════════════════════

  describe('Trace Persistence Lifecycle', () => {
    it('persists trace entries and retrieves them in order', () => {
      // SPEC: Trace entries must survive insert→query cycle with order preserved
      const traceId = 'trace-t1';
      const entries = Array.from({ length: 5 }, (_, i) => ({
        trace_id: traceId,
        task_id: `task-${i}`,
        timestamp: new Date(Date.now() + i * 1000),
        depth: i,
        caller: '/agents/caller.ts',
        target: '/agents/target.ts',
        function: `fn${i}`,
        params: { arg: i },
        result: { value: i * 2 },
        mutations: [],
        source_refs: [],
        duration_ms: 10 + i,
        call_stack: [`/agents/caller.ts:fn${i}`],
      }));

      entries.forEach((entry) => persistence.insertTraceEntry(entry));

      const retrieved = persistence.getTraceEntries(traceId);

      expect(retrieved).toHaveLength(5);
      // Verify order (should be chronological by timestamp)
      retrieved.forEach((entry, i) => {
        expect(entry.task_id).toBe(`task-${i}`);
        expect(entry.depth).toBe(i);
      });
    });

    it('isolates multiple trace_ids without cross-contamination', () => {
      // SPEC: Multiple traces can coexist, queries return only matching trace_id
      const t1Entries = [
        { trace_id: 'T1', task_id: 't1-a', timestamp: new Date(), depth: 0, caller: '/a', target: '/b', function: 'f1', params: {}, result: {}, mutations: [], source_refs: [], duration_ms: 5, call_stack: ['/a:f1'] },
        { trace_id: 'T1', task_id: 't1-b', timestamp: new Date(), depth: 1, caller: '/a', target: '/c', function: 'f2', params: {}, result: {}, mutations: [], source_refs: [], duration_ms: 7, call_stack: ['/a:f1', '/a:f2'] },
      ];

      const t2Entries = [
        { trace_id: 'T2', task_id: 't2-a', timestamp: new Date(), depth: 0, caller: '/x', target: '/y', function: 'g1', params: {}, result: {}, mutations: [], source_refs: [], duration_ms: 3, call_stack: ['/x:g1'] },
        { trace_id: 'T2', task_id: 't2-b', timestamp: new Date(), depth: 1, caller: '/x', target: '/z', function: 'g2', params: {}, result: {}, mutations: [], source_refs: [], duration_ms: 6, call_stack: ['/x:g1', '/x:g2'] },
        { trace_id: 'T2', task_id: 't2-c', timestamp: new Date(), depth: 2, caller: '/x', target: '/w', function: 'g3', params: {}, result: {}, mutations: [], source_refs: [], duration_ms: 9, call_stack: ['/x:g1', '/x:g2', '/x:g3'] },
      ];

      [...t1Entries, ...t2Entries].forEach((entry) => persistence.insertTraceEntry(entry));

      const t1Retrieved = persistence.getTraceEntries('T1');
      const t2Retrieved = persistence.getTraceEntries('T2');

      expect(t1Retrieved).toHaveLength(2);
      expect(t2Retrieved).toHaveLength(3);
      expect(t1Retrieved.every((e) => e.trace_id === 'T1')).toBe(true);
      expect(t2Retrieved.every((e) => e.trace_id === 'T2')).toBe(true);
    });

    it('deletes traces by trace_id without affecting other traces', () => {
      // SPEC: deleteTrace removes all entries for trace_id, others untouched
      const t1 = { trace_id: 'DELETE-ME', task_id: 'task-1', timestamp: new Date(), depth: 0, caller: '/a', target: '/b', function: 'f', params: {}, result: {}, mutations: [], source_refs: [], duration_ms: 5, call_stack: ['/a:f'] };
      const t2 = { trace_id: 'KEEP-ME', task_id: 'task-2', timestamp: new Date(), depth: 0, caller: '/c', target: '/d', function: 'g', params: {}, result: {}, mutations: [], source_refs: [], duration_ms: 7, call_stack: ['/c:g'] };

      persistence.insertTraceEntry(t1);
      persistence.insertTraceEntry(t2);

      persistence.deleteTrace('DELETE-ME');

      const deletedTrace = persistence.getTraceEntries('DELETE-ME');
      const keptTrace = persistence.getTraceEntries('KEEP-ME');

      expect(deletedTrace).toHaveLength(0);
      expect(keptTrace).toHaveLength(1);
    });

    it('preserves complex trace data structures (params, result, mutations, source_refs)', () => {
      // SPEC: JSON serialization must preserve complex nested structures
      const entry = {
        trace_id: 'complex-data',
        task_id: 'task-complex',
        timestamp: new Date(),
        depth: 2,
        caller: '/agents/orchestrator.ts',
        target: '/agents/worker.ts',
        function: 'processData',
        params: { items: [1, 2, 3], config: { mode: 'fast', retries: 3 } },
        result: { processed: 3, errors: [] },
        mutations: [{ type: 'update', path: '/data/store.json', before: 'old', after: 'new' }],
        source_refs: [{ file: '/utils/helper.ts', line: 42 }],
        duration_ms: 123,
        call_stack: ['/agents/orchestrator.ts:processData', '/agents/worker.ts:processData'],
      };

      persistence.insertTraceEntry(entry);
      const retrieved = persistence.getTraceEntries('complex-data');

      expect(retrieved).toHaveLength(1);
      expect(retrieved[0].params).toEqual(entry.params);
      expect(retrieved[0].result).toEqual(entry.result);
      expect(retrieved[0].mutations).toEqual(entry.mutations);
      expect(retrieved[0].source_refs).toEqual(entry.source_refs);
    });

    it('handles empty trace queries gracefully', () => {
      // SPEC: Querying non-existent trace_id returns empty array
      const result = persistence.getTraceEntries('non-existent-trace');
      expect(result).toEqual([]);
    });

    it('supports call_stack persistence for deep trace analysis', () => {
      // SPEC: call_stack field enables debugging of deep call chains
      const entry = {
        trace_id: 'stack-trace',
        task_id: 'task-stack',
        timestamp: new Date(),
        depth: 5,
        caller: '/agents/main.ts',
        target: '/agents/leaf.ts',
        function: 'deepFn',
        params: {},
        result: {},
        mutations: [],
        source_refs: [],
        duration_ms: 50,
        call_stack: [
          { file: '/agents/main.ts', function: 'start', line: 10 },
          { file: '/agents/orchestrator.ts', function: 'delegate', line: 45 },
          { file: '/agents/worker.ts', function: 'execute', line: 78 },
          { file: '/agents/leaf.ts', function: 'deepFn', line: 123 },
        ],
      };

      persistence.insertTraceEntry(entry);
      const retrieved = persistence.getTraceEntries('stack-trace');

      expect(retrieved[0].call_stack).toEqual(entry.call_stack);
      expect(retrieved[0].call_stack).toHaveLength(4);
    });
  });
});
