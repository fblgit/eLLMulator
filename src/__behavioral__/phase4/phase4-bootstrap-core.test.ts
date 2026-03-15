/**
 * RED-4C: Bootstrap Core Behavioral Tests
 *
 * Tests the core bootstrap flow:
 * - Real SDK session creation → session_id capture → registry update
 * - register() handler: bootstrapping → ready transition
 * - awaitReady polling behavior and timeouts
 * - Concurrent bootstrap bounded by --threads
 * - SQLite persistence of session mappings
 * - Frozen oracle pattern (forkSession:true on invoke)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Registry } from '../../registry.js';
import type { RegistryEntry, RegistryStatus } from '../../registry.js';
import { createBootstrapHandler } from '../../bootstrap.js';
import type { BootstrapDeps, BootstrapResult } from '../../bootstrap.js';
import { createRegisterHandler } from '../../handlers.js';
import { SessionManager } from '../../session-manager.js';
import { PersistenceLayer } from '../../persistence.js';
import type { Declarations, InvokeEnvelope, ResponseEnvelope } from '../../types.js';
import { invoke, RateLimitTracker, SelfLoopTracker } from '../../invoke.js';
import type { InvokeDeps } from '../../invoke.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeclarations(summary = 'test file'): Declarations {
  return {
    summary,
    owns: [
      {
        name: 'testFunc',
        kind: 'function',
        intent: 'a test function',
        file_path: 'test.ts',
        start_line: 1,
        end_line: 10,
      },
    ],
    imports: [],
    exports: [],
    dependencies: [],
  };
}

function makeScannedFile(filePath: string, hash?: string) {
  return {
    path: filePath,
    hash: hash ?? `hash-${filePath}`,
    content: `// ${filePath} content`,
  };
}

// ============================================================================
// §4.1: Real bootstrap via SDK
// ============================================================================

describe('SPEC §4.1: Real bootstrap via SDK', () => {
  let registry: Registry;

  beforeEach(() => {
    registry = new Registry();
  });

  it('SPEC: spawn creates SDK session — registry transitions cold → bootstrapping', async () => {
    let bootstrapStatusCapture: RegistryStatus | undefined;

    const deps: BootstrapDeps = {
      scanner: {
        scanProjectFiles: vi.fn().mockResolvedValue([makeScannedFile('app.ts')]),
      },
      registry: {
        add: (entry: RegistryEntry) => {
          registry.add(entry);
        },
        get: (fp: string) => registry.get(fp),
        list: () => registry.list(),
        listByStatus: (s: RegistryStatus) => registry.listByStatus(s),
        update: (fp: string, updates: Partial<Omit<RegistryEntry, 'file_path'>>) => registry.update(fp, updates),
      },
      sessionManager: {
        create: vi.fn().mockImplementation(async (opts) => {
          // At the point create is called, status should be transitioning to bootstrapping
          const entry = registry.get(opts.filePath);
          bootstrapStatusCapture = entry?.status;

          return {
            session_id: 'sdk-session-1',
            file_path: opts.filePath,
            created_at: new Date(),
            file_hash: opts.fileHash,
            status: 'active',
          };
        }),
        terminate: vi.fn(),
      },
    };

    const bootstrap = createBootstrapHandler(deps);
    const result = await bootstrap('/project');

    // Session manager was called
    expect(deps.sessionManager.create).toHaveBeenCalledWith(
      expect.objectContaining({ filePath: 'app.ts' }),
    );

    // Result is correct
    expect(result.total).toBe(1);
    expect(result.ready).toBe(1);
    expect(result.errors).toHaveLength(0);
  });

  it('SPEC: bootstrap prompt sent as first query — renderBootstrapPrompt called with file_path', async () => {
    // This test validates that the bootstrap flow sends renderBootstrapPrompt
    // as the initial prompt to the SDK session.
    //
    // The current implementation passes bootstrapPrompt via sessionManager.create()
    // but Phase 4 must ensure it uses renderBootstrapPrompt({ file_path }).

    const capturedPrompts: string[] = [];

    const deps: BootstrapDeps = {
      scanner: {
        scanProjectFiles: vi.fn().mockResolvedValue([makeScannedFile('handler.ts')]),
      },
      registry: {
        add: (entry: RegistryEntry) => registry.add(entry),
        get: (fp: string) => registry.get(fp),
        list: () => registry.list(),
        listByStatus: (s: RegistryStatus) => registry.listByStatus(s),
        update: (fp: string, updates: Partial<Omit<RegistryEntry, 'file_path'>>) => registry.update(fp, updates),
      },
      sessionManager: {
        create: vi.fn().mockImplementation(async (opts) => {
          // Capture whatever prompt is sent
          if (opts.bootstrapPrompt) {
            capturedPrompts.push(opts.bootstrapPrompt);
          }
          return {
            session_id: 'sdk-session-2',
            file_path: opts.filePath,
            created_at: new Date(),
            file_hash: opts.fileHash,
            status: 'active',
          };
        }),
        terminate: vi.fn(),
      },
    };

    const bootstrap = createBootstrapHandler(deps);
    await bootstrap('/project');

    // A bootstrap prompt was sent
    expect(capturedPrompts).toHaveLength(1);

    // The prompt should reference the file path (from renderBootstrapPrompt)
    expect(capturedPrompts[0]).toContain('handler.ts');

    // The prompt should contain bootstrap instructions (register via MCP)
    expect(capturedPrompts[0]).toContain('register');
  });

  it('SPEC: session_id stored in registry after successful bootstrap', async () => {
    // After bootstrap, registry.get(filePath).session_id should be non-null
    // This is a Phase 4 requirement: the bootstrap flow must update the registry
    // with the SDK-provided session_id.
    //
    // Current bootstrap.ts creates sessions but doesn't update registry.session_id.
    // Phase 4 GREEN must wire this.

    const deps: BootstrapDeps = {
      scanner: {
        scanProjectFiles: vi.fn().mockResolvedValue([makeScannedFile('model.ts')]),
      },
      registry: {
        add: (entry: RegistryEntry) => registry.add(entry),
        get: (fp: string) => registry.get(fp),
        list: () => registry.list(),
        listByStatus: (s: RegistryStatus) => registry.listByStatus(s),
        update: (fp: string, updates: Partial<Omit<RegistryEntry, 'file_path'>>) => registry.update(fp, updates),
      },
      sessionManager: {
        create: vi.fn().mockResolvedValue({
          session_id: 'sdk-session-model',
          file_path: 'model.ts',
          created_at: new Date(),
          file_hash: 'hash-model.ts',
          status: 'active',
        }),
        terminate: vi.fn(),
      },
    };

    const bootstrap = createBootstrapHandler(deps);
    await bootstrap('/project');

    // After bootstrap, registry should have the session_id
    const entry = registry.get('model.ts');
    expect(entry).toBeDefined();
    expect(entry!.session_id).toBe('sdk-session-model');
  });
});

// ============================================================================
// §4.2: Register → Ready verification
// ============================================================================

describe('SPEC §4.2: register() → ready', () => {
  let registry: Registry;

  beforeEach(() => {
    registry = new Registry();
  });

  it('SPEC: register() transitions bootstrapping → ready', () => {
    registry.add({
      file_path: 'service.ts',
      file_hash: 'hash-1',
      status: 'cold',
      session_id: null,
      declarations: null,
      last_active: null,
      error: null,
    });
    // Transition to bootstrapping first
    registry.update('service.ts', { status: 'bootstrapping' });

    const register = createRegisterHandler(registry);
    const result = register('service.ts', makeDeclarations('Service module'));

    expect(result).toEqual({ success: true });

    const entry = registry.get('service.ts');
    expect(entry!.status).toBe('ready');
  });

  it('SPEC: register() rejects unknown file', () => {
    const register = createRegisterHandler(registry);
    const result = register('nonexistent.ts', makeDeclarations());

    expect(result).toEqual({ error: 'FILE_NOT_IN_REGISTRY' });
  });

  it('SPEC: register() stores declarations with all fields', () => {
    registry.add({
      file_path: 'controller.ts',
      file_hash: 'hash-2',
      status: 'cold',
      session_id: null,
      declarations: null,
      last_active: null,
      error: null,
    });
    registry.update('controller.ts', { status: 'bootstrapping' });

    const decls: Declarations = {
      summary: 'HTTP controller for user routes',
      owns: [
        {
          name: 'UserController.getById',
          kind: 'method',
          intent: 'Fetches a user by ID from the database',
          file_path: 'controller.ts',
          start_line: 10,
          end_line: 25,
        },
      ],
      imports: [
        { name: 'UserService', from: 'service.ts', kind: 'import' },
      ],
      exports: [
        {
          name: 'UserController',
          kind: 'class',
          intent: 'HTTP controller for /users endpoints',
          file_path: 'controller.ts',
          start_line: 5,
          end_line: 100,
        },
      ],
      dependencies: ['service.ts', 'types.ts'],
    };

    const register = createRegisterHandler(registry);
    register('controller.ts', decls);

    const entry = registry.get('controller.ts');
    expect(entry!.declarations).toBeDefined();
    expect(entry!.declarations!.summary).toBe('HTTP controller for user routes');
    expect(entry!.declarations!.owns).toHaveLength(1);
    expect(entry!.declarations!.imports).toHaveLength(1);
    expect(entry!.declarations!.exports).toHaveLength(1);
    expect(entry!.declarations!.dependencies).toEqual(['service.ts', 'types.ts']);
  });

  it('SPEC: register() updates last_active to recent timestamp', () => {
    const before = new Date();

    registry.add({
      file_path: 'repo.ts',
      file_hash: 'hash-3',
      status: 'cold',
      session_id: null,
      declarations: null,
      last_active: null,
      error: null,
    });
    registry.update('repo.ts', { status: 'bootstrapping' });

    const register = createRegisterHandler(registry);
    register('repo.ts', makeDeclarations());

    const entry = registry.get('repo.ts');
    expect(entry!.last_active).toBeDefined();
    expect(entry!.last_active!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(entry!.last_active!.getTime()).toBeLessThanOrEqual(Date.now());
  });
});

// ============================================================================
// §4.3: awaitReady polling
// ============================================================================

describe.skip('SPEC §4.3: awaitReady polling', () => {
  let registry: Registry;

  beforeEach(() => {
    registry = new Registry();
  });

  it('SPEC: awaitReady resolves when status becomes ready', async () => {
    registry.add({
      file_path: 'slow-agent.ts',
      file_hash: 'hash-slow',
      status: 'cold',
      session_id: null,
      declarations: null,
      last_active: null,
      error: null,
    });
    registry.update('slow-agent.ts', { status: 'bootstrapping' });

    // Simulate the agent becoming ready after 1 second
    setTimeout(() => {
      registry.update('slow-agent.ts', {
        status: 'ready',
        session_id: 'sess-slow',
        declarations: makeDeclarations(),
      });
    }, 1000);

    // awaitReady is in invoke.ts — it polls the registry until status=ready
    // We test via invoke() with a bootstrapping entry
    const mockSessionManager = {
      create: vi.fn(),
      terminate: vi.fn(),
      query: vi.fn().mockResolvedValue({
        task_id: 'task-await',
        responder: 'slow-agent.ts',
        returns: { ok: true },
        source_refs: ['slow-agent.ts:1'],
      }),
      invokeOnSession: vi.fn().mockResolvedValue({
        task_id: 'task-await',
        responder: 'slow-agent.ts',
        returns: { ok: true },
        source_refs: ['slow-agent.ts:1'],
      }),
    };

    const deps: InvokeDeps = {
      registry,
      sessionManager: mockSessionManager as any,
      traceLog: vi.fn(),
      rateLimitTracker: new RateLimitTracker(),
      selfLoopTracker: new SelfLoopTracker(),
      readFile: vi.fn().mockResolvedValue('// source'),
      projectDir: '/project',
    };

    // Add a caller entry
    registry.add({
      file_path: 'caller.ts',
      file_hash: 'hash-caller',
      status: 'ready',
      session_id: 'sess-caller',
      declarations: makeDeclarations(),
      last_active: new Date(),
      error: null,
    });

    const envelope: InvokeEnvelope = {
      trace_id: 'trace-await',
      task_id: 'task-await',
      caller: 'caller.ts',
      target: 'slow-agent.ts',
      function: 'process',
      call_stack: [],
      mode: 'sync',
      max_depth: 50,
    };

    // invoke() should poll and eventually succeed when status → ready
    const result = await invoke(envelope, deps);
    expect(result).toBeDefined();
  }, 10000); // 10s timeout for the polling

  it('SPEC: awaitReady times out after 30s', async () => {
    registry.add({
      file_path: 'stuck-agent.ts',
      file_hash: 'hash-stuck',
      status: 'cold',
      session_id: null,
      declarations: null,
      last_active: null,
      error: null,
    });
    registry.update('stuck-agent.ts', { status: 'bootstrapping' });

    // Never transition to ready — stuck forever

    registry.add({
      file_path: 'caller.ts',
      file_hash: 'hash-caller',
      status: 'ready',
      session_id: 'sess-caller',
      declarations: makeDeclarations(),
      last_active: new Date(),
      error: null,
    });

    const deps: InvokeDeps = {
      registry,
      sessionManager: { create: vi.fn(), terminate: vi.fn(), query: vi.fn() } as any,
      traceLog: vi.fn(),
      rateLimitTracker: new RateLimitTracker(),
      selfLoopTracker: new SelfLoopTracker(),
      readFile: vi.fn().mockResolvedValue('// source'),
      projectDir: '/project',
    };

    const envelope: InvokeEnvelope = {
      trace_id: 'trace-timeout',
      task_id: 'task-timeout',
      caller: 'caller.ts',
      target: 'stuck-agent.ts',
      function: 'process',
      call_stack: [],
      mode: 'sync',
      max_depth: 50,
    };

    // Should throw with BOOTSTRAP_TIMEOUT
    await expect(invoke(envelope, deps)).rejects.toThrow('BOOTSTRAP_TIMEOUT');
  }, 35000); // 35s test timeout (30s polling + buffer)
});

// ============================================================================
// §4.5: Concurrent bootstrap
// ============================================================================

describe('SPEC §4.5: Concurrent bootstrap', () => {
  let registry: Registry;

  beforeEach(() => {
    registry = new Registry();
  });

  it('SPEC: concurrent bounded by --threads — at most N agents spawn at once', async () => {
    const concurrencyLog: number[] = []; // tracks active concurrent count
    let currentActive = 0;

    const deps: BootstrapDeps = {
      scanner: {
        scanProjectFiles: vi.fn().mockResolvedValue([
          makeScannedFile('a.ts'),
          makeScannedFile('b.ts'),
          makeScannedFile('c.ts'),
          makeScannedFile('d.ts'),
          makeScannedFile('e.ts'),
          makeScannedFile('f.ts'),
        ]),
      },
      registry: {
        add: (entry: RegistryEntry) => registry.add(entry),
        get: (fp: string) => registry.get(fp),
        list: () => registry.list(),
        listByStatus: (s: RegistryStatus) => registry.listByStatus(s),
        update: (fp: string, updates: Partial<Omit<RegistryEntry, 'file_path'>>) => registry.update(fp, updates),
      },
      sessionManager: {
        create: vi.fn().mockImplementation(async (opts) => {
          currentActive++;
          concurrencyLog.push(currentActive);

          // Simulate some work
          await new Promise((resolve) => setTimeout(resolve, 50));

          currentActive--;
          return {
            session_id: `sess-${opts.filePath}`,
            file_path: opts.filePath,
            created_at: new Date(),
            file_hash: opts.fileHash,
            status: 'active',
          };
        }),
        terminate: vi.fn(),
      },
    };

    const bootstrap = createBootstrapHandler(deps);
    const result = await bootstrap('/project', { threads: 3 });

    // All 6 completed
    expect(result.total).toBe(6);
    expect(result.ready).toBe(6);

    // Concurrency never exceeded 3
    const maxConcurrency = Math.max(...concurrencyLog);
    expect(maxConcurrency).toBeLessThanOrEqual(3);
  });

  it('SPEC: BootstrapResult has correct counts', async () => {
    const deps: BootstrapDeps = {
      scanner: {
        scanProjectFiles: vi.fn().mockResolvedValue([
          makeScannedFile('ok1.ts'),
          makeScannedFile('ok2.ts'),
          makeScannedFile('fail.ts'),
        ]),
      },
      registry: {
        add: (entry: RegistryEntry) => registry.add(entry),
        get: (fp: string) => registry.get(fp),
        list: () => registry.list(),
        listByStatus: (s: RegistryStatus) => registry.listByStatus(s),
        update: (fp: string, updates: Partial<Omit<RegistryEntry, 'file_path'>>) => registry.update(fp, updates),
      },
      sessionManager: {
        create: vi.fn().mockImplementation(async (opts) => {
          if (opts.filePath === 'fail.ts') {
            throw new Error('SDK connection failed');
          }
          return {
            session_id: `sess-${opts.filePath}`,
            file_path: opts.filePath,
            created_at: new Date(),
            file_hash: opts.fileHash,
            status: 'active',
          };
        }),
        terminate: vi.fn(),
      },
    };

    const bootstrap = createBootstrapHandler(deps);
    const result = await bootstrap('/project');

    expect(result.total).toBe(3);
    expect(result.ready).toBe(2);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].path).toBe('fail.ts');
    expect(result.errors[0].error).toContain('SDK connection failed');
  });

  it('SPEC: Bootstrap error isolation — failed agents dont prevent others', async () => {
    const createdSessions: string[] = [];

    const deps: BootstrapDeps = {
      scanner: {
        scanProjectFiles: vi.fn().mockResolvedValue([
          makeScannedFile('a.ts'),
          makeScannedFile('b.ts'), // will fail
          makeScannedFile('c.ts'),
          makeScannedFile('d.ts'), // will fail
          makeScannedFile('e.ts'),
        ]),
      },
      registry: {
        add: (entry: RegistryEntry) => registry.add(entry),
        get: (fp: string) => registry.get(fp),
        list: () => registry.list(),
        listByStatus: (s: RegistryStatus) => registry.listByStatus(s),
        update: (fp: string, updates: Partial<Omit<RegistryEntry, 'file_path'>>) => registry.update(fp, updates),
      },
      sessionManager: {
        create: vi.fn().mockImplementation(async (opts) => {
          if (opts.filePath === 'b.ts' || opts.filePath === 'd.ts') {
            throw new Error(`Failed: ${opts.filePath}`);
          }
          createdSessions.push(opts.filePath);
          return {
            session_id: `sess-${opts.filePath}`,
            file_path: opts.filePath,
            created_at: new Date(),
            file_hash: opts.fileHash,
            status: 'active',
          };
        }),
        terminate: vi.fn(),
      },
    };

    const bootstrap = createBootstrapHandler(deps);
    const result = await bootstrap('/project');

    // 3 succeeded, 2 failed
    expect(result.ready).toBe(3);
    expect(result.errors).toHaveLength(2);

    // Successful ones were all created
    expect(createdSessions).toContain('a.ts');
    expect(createdSessions).toContain('c.ts');
    expect(createdSessions).toContain('e.ts');
  });
});

// ============================================================================
// §4.7: SQLite session persistence
// ============================================================================

describe('SPEC §4.7: SQLite session persistence', () => {
  let dbPath: string;
  let persistence: PersistenceLayer;

  beforeEach(() => {
    const tmpDir = os.tmpdir();
    dbPath = path.join(tmpDir, `ellm-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
    persistence = new PersistenceLayer(dbPath);
  });

  afterEach(() => {
    try {
      persistence.close();
    } catch { /* already closed */ }
    try {
      fs.unlinkSync(dbPath);
      fs.unlinkSync(dbPath + '-wal');
      fs.unlinkSync(dbPath + '-shm');
    } catch { /* may not exist */ }
  });

  it('SPEC: bootstrap writes file_path → session_id to SQLite', () => {
    // After bootstrap, persistence should have the agent record
    const entry: RegistryEntry = {
      file_path: 'app.ts',
      file_hash: 'abc123',
      status: 'ready',
      session_id: 'sdk-session-app',
      declarations: makeDeclarations('App entry point'),
      last_active: new Date(),
    };

    persistence.upsertAgent(entry);

    const retrieved = persistence.getAgent('app.ts');
    expect(retrieved).not.toBeNull();
    expect(retrieved!.session_id).toBe('sdk-session-app');
    expect(retrieved!.file_hash).toBe('abc123');
    expect(retrieved!.status).toBe('ready');
  });

  it('SPEC: restart loads existing sessions — unchanged hash skips re-bootstrap', () => {
    // Simulate first run: store agent with session_id
    persistence.upsertAgent({
      file_path: 'cached.ts',
      file_hash: 'same-hash',
      status: 'ready',
      session_id: 'session-from-last-run',
      declarations: makeDeclarations(),
      last_active: new Date(),
    });

    // Close and reopen (simulates restart)
    persistence.close();
    const persistence2 = new PersistenceLayer(dbPath);

    // Load existing agent
    const agent = persistence2.getAgent('cached.ts');
    expect(agent).not.toBeNull();
    expect(agent!.session_id).toBe('session-from-last-run');
    expect(agent!.file_hash).toBe('same-hash');

    // If hash matches, this agent should NOT be re-bootstrapped
    // (This tests the persistence data availability — the bootstrap logic
    //  that checks hash and skips is a Phase 4 GREEN requirement)

    persistence2.close();
  });

  it('SPEC: hash mismatch triggers re-bootstrap — stale entry invalidated', () => {
    // Store agent with old hash
    persistence.upsertAgent({
      file_path: 'changing.ts',
      file_hash: 'old-hash',
      status: 'ready',
      session_id: 'old-session',
      declarations: makeDeclarations(),
      last_active: new Date(),
    });

    // File changed — new hash
    const agent = persistence.getAgent('changing.ts');
    expect(agent!.file_hash).toBe('old-hash');

    // Phase 4 GREEN: when file hash differs from stored hash,
    // the bootstrap flow should:
    // 1. Invalidate the old session
    // 2. Re-bootstrap with new hash
    // 3. Update SQLite with new session_id

    // Update with new hash + new session
    persistence.upsertAgent({
      file_path: 'changing.ts',
      file_hash: 'new-hash',
      status: 'ready',
      session_id: 'new-session',
      declarations: makeDeclarations(),
      last_active: new Date(),
    });

    const updated = persistence.getAgent('changing.ts');
    expect(updated!.file_hash).toBe('new-hash');
    expect(updated!.session_id).toBe('new-session');
  });
});

// ============================================================================
// §4.8: Frozen oracle pattern
// ============================================================================

describe('SPEC §4.8: Frozen oracle pattern (forkSession)', () => {
  let registry: Registry;

  beforeEach(() => {
    registry = new Registry();
  });

  it('SPEC: forkSession=true used when invoking a ready agent', async () => {
    registry.add({
      file_path: 'target.ts',
      file_hash: 'hash-target',
      status: 'ready',
      session_id: 'base-session-id',
      declarations: makeDeclarations(),
      last_active: new Date(),
      error: null,
    });
    registry.add({
      file_path: 'caller.ts',
      file_hash: 'hash-caller',
      status: 'ready',
      session_id: 'sess-caller',
      declarations: makeDeclarations(),
      last_active: new Date(),
      error: null,
    });

    const mockSessionManager = {
      create: vi.fn(),
      terminate: vi.fn(),
      query: vi.fn().mockResolvedValue({
        task_id: 'task-fork',
        responder: 'target.ts',
        returns: { ok: true },
        source_refs: ['target.ts:1'],
      }),
      invokeOnSession: vi.fn().mockResolvedValue({
        task_id: 'task-fork',
        responder: 'target.ts',
        returns: { ok: true },
        source_refs: ['target.ts:1'],
      }),
    };

    const deps: InvokeDeps = {
      registry,
      sessionManager: mockSessionManager as any,
      traceLog: vi.fn(),
      rateLimitTracker: new RateLimitTracker(),
      selfLoopTracker: new SelfLoopTracker(),
      readFile: vi.fn().mockResolvedValue('// source'),
      projectDir: '/project',
    };

    const envelope: InvokeEnvelope = {
      trace_id: 'trace-fork',
      task_id: 'task-fork',
      caller: 'caller.ts',
      target: 'target.ts',
      function: 'doWork',
      call_stack: [],
      mode: 'sync',
      max_depth: 50,
    };

    try {
      await invoke(envelope, deps);
    } catch {
      // May fail due to mock limitations
    }

    // The invoke should use forkSession: true
    // Check if invokeOnSession was called with forkSession: true
    // OR if query was called with forkSession: true
    const invokeCall = mockSessionManager.invokeOnSession.mock.calls[0];
    const queryCall = mockSessionManager.query.mock.calls[0];

    // At least one of these should have been called with forkSession: true
    const usedFork =
      (invokeCall && invokeCall[0]?.forkSession === true) ||
      (queryCall && queryCall[0]?.forkSession === true);

    expect(usedFork).toBe(true);
  });

  it('SPEC: parallel invokes on same agent both succeed — no contention', async () => {
    registry.add({
      file_path: 'shared-target.ts',
      file_hash: 'hash-shared',
      status: 'ready',
      session_id: 'base-session-shared',
      declarations: makeDeclarations(),
      last_active: new Date(),
      error: null,
    });
    registry.add({
      file_path: 'caller-1.ts',
      file_hash: 'hash-c1',
      status: 'ready',
      session_id: 'sess-c1',
      declarations: makeDeclarations(),
      last_active: new Date(),
      error: null,
    });
    registry.add({
      file_path: 'caller-2.ts',
      file_hash: 'hash-c2',
      status: 'ready',
      session_id: 'sess-c2',
      declarations: makeDeclarations(),
      last_active: new Date(),
      error: null,
    });

    let concurrentInvokes = 0;
    let maxConcurrentInvokes = 0;

    const mockSessionManager = {
      create: vi.fn(),
      terminate: vi.fn(),
      query: vi.fn().mockImplementation(async () => {
        concurrentInvokes++;
        maxConcurrentInvokes = Math.max(maxConcurrentInvokes, concurrentInvokes);
        await new Promise((r) => setTimeout(r, 50));
        concurrentInvokes--;
        return {
          task_id: 'task-parallel',
          responder: 'shared-target.ts',
          returns: { ok: true },
          source_refs: ['shared-target.ts:1'],
        };
      }),
      invokeOnSession: vi.fn().mockImplementation(async () => {
        concurrentInvokes++;
        maxConcurrentInvokes = Math.max(maxConcurrentInvokes, concurrentInvokes);
        await new Promise((r) => setTimeout(r, 50));
        concurrentInvokes--;
        return {
          task_id: 'task-parallel',
          responder: 'shared-target.ts',
          returns: { ok: true },
          source_refs: ['shared-target.ts:1'],
        };
      }),
    };

    const deps: InvokeDeps = {
      registry,
      sessionManager: mockSessionManager as any,
      traceLog: vi.fn(),
      rateLimitTracker: new RateLimitTracker(),
      selfLoopTracker: new SelfLoopTracker(),
      readFile: vi.fn().mockResolvedValue('// source'),
      projectDir: '/project',
    };

    const envelope1: InvokeEnvelope = {
      trace_id: 'trace-p1',
      task_id: 'task-p1',
      caller: 'caller-1.ts',
      target: 'shared-target.ts',
      function: 'process',
      call_stack: [],
      mode: 'sync',
      max_depth: 50,
    };

    const envelope2: InvokeEnvelope = {
      trace_id: 'trace-p2',
      task_id: 'task-p2',
      caller: 'caller-2.ts',
      target: 'shared-target.ts',
      function: 'process',
      call_stack: [],
      mode: 'sync',
      max_depth: 50,
    };

    // Run both invokes concurrently
    const results = await Promise.allSettled([
      invoke(envelope1, deps),
      invoke(envelope2, deps),
    ]);

    // Both should succeed (or at least not deadlock)
    const successes = results.filter((r) => r.status === 'fulfilled');
    expect(successes.length).toBe(2);

    // Both ran concurrently (not serialized)
    expect(maxConcurrentInvokes).toBeGreaterThanOrEqual(2);
  });
});
