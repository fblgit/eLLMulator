/**
 * RED-3: Primer Session Immutability
 *
 * The primer session (created during bootstrap) is the canonical identity
 * for a file agent. Trace invocations FORK from the primer — they never
 * create new sessions, never mutate the primer pointer in the registry.
 *
 * Prefix: [MUST-PASS-AT-TRACE-V2]
 *
 * Current broken behavior:
 *   - invoke.ts L93-123: calls sessionManager.create() for cold/stale files
 *   - invoke.ts L151: registry.update(file_path, { session_id }) overwrites primer
 *
 * Expected GREEN behavior:
 *   - invoke() NEVER calls sessionManager.create()
 *   - invoke() NEVER writes session_id to registry
 *   - All trace invocations fork from the existing primer session_id
 *   - After invoke(), registry.get(target).session_id is unchanged
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock SDK before any imports that use it
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

import { Registry } from '../registry.js';
import { SessionManager } from '../session-manager.js';
import { TraceLog } from '../trace-log.js';
import { invoke, RateLimitTracker, SelfLoopTracker } from '../invoke.js';
import type { InvokeEnvelope, ResponseEnvelope, Declarations } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeclarations(overrides: Partial<Declarations> = {}): Declarations {
  return {
    summary: 'Test file',
    owns: [{ name: 'handleRequest', kind: 'function', intent: 'handle incoming request', file_path: 'test.ts', start_line: 1, end_line: 10 }],
    imports: [],
    exports: [],
    dependencies: [],
    ...overrides,
  };
}

function makeInvokeDeps() {
  const registry = new Registry();
  const traceLog = new TraceLog();
  return {
    registry,
    sessionManager: new SessionManager(),
    traceLog,
    rateLimitTracker: new RateLimitTracker(),
    selfLoopTracker: new SelfLoopTracker(),
    readFile: vi.fn().mockResolvedValue('export function handleRequest() {}'),
    projectDir: '/test-project',
  };
}

function makeEnvelope(target: string, overrides: Partial<InvokeEnvelope> = {}): InvokeEnvelope {
  return {
    trace_id: 'trace-primer',
    task_id: 'task-primer',
    caller: '__trace_initiator__',
    target,
    function: 'handleRequest',
    call_stack: [],
    mode: 'sync',
    max_depth: 10,
    ...overrides,
  };
}

const VALID_RESPONSE: ResponseEnvelope = {
  task_id: 'task-primer',
  responder: 'src/target.ts',
  returns: { ok: true },
  source_refs: ['src/target.ts:1-10'],
};

// ============================================================================

describe('[MUST-PASS-AT-TRACE-V2] RED-3: Primer Session Immutability', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // 3a: invoke() must NEVER call sessionManager.create()
  // -------------------------------------------------------------------------
  describe('invoke() must never create sessions', () => {
    it('should NOT call sessionManager.create() for a cold file', async () => {
      // invoke() is a trace operation. Creating sessions is bootstrap's job.
      // When invoke() encounters a cold file it should throw immediately,
      // not attempt to spawn an agent via sessionManager.create().
      const deps = makeInvokeDeps();

      deps.registry.add({
        file_path: 'src/cold-file.ts',
        file_hash: 'hash-cold',
        status: 'cold',
        session_id: null,
        declarations: null,
        last_active: null,
        error: null,
      });

      const createSpy = vi.spyOn(deps.sessionManager, 'create');

      const envelope = makeEnvelope('src/cold-file.ts');

      try {
        await invoke(envelope, deps);
      } catch {
        // We expect it to throw — that's fine
      }

      // CRITICAL: invoke must never call create(), regardless of outcome
      expect(createSpy).not.toHaveBeenCalled();
    });

    it('should NOT call sessionManager.create() for a stale file', async () => {
      // Same rule: stale files need re-bootstrap, but invoke doesn't do that.
      const deps = makeInvokeDeps();

      deps.registry.add({
        file_path: 'src/stale-file.ts',
        file_hash: 'hash-stale-old',
        status: 'ready',
        session_id: 'primer-session-stale',
        declarations: makeDeclarations(),
        last_active: new Date(),
        error: null,
      });

      // Simulate file change → stale
      deps.registry.update('src/stale-file.ts', { file_hash: 'hash-stale-new' });
      // registry auto-transitions ready→stale on hash change

      const createSpy = vi.spyOn(deps.sessionManager, 'create');

      const envelope = makeEnvelope('src/stale-file.ts');

      try {
        await invoke(envelope, deps);
      } catch {
        // Expected to throw
      }

      expect(createSpy).not.toHaveBeenCalled();
    });

    it('should NOT call sessionManager.create() for a ready file', async () => {
      // Baseline: ready files should never trigger create() either —
      // they already have a primer session.
      const deps = makeInvokeDeps();

      deps.registry.add({
        file_path: 'src/ready-file.ts',
        file_hash: 'hash-ready',
        status: 'ready',
        session_id: 'primer-session-ready',
        declarations: makeDeclarations(),
        last_active: new Date(),
        error: null,
      });

      deps.sessionManager.invokeOnSession = vi.fn().mockResolvedValue({
        ...VALID_RESPONSE,
        task_id: 'task-primer',
        responder: 'src/ready-file.ts',
      });

      const createSpy = vi.spyOn(deps.sessionManager, 'create');

      const envelope = makeEnvelope('src/ready-file.ts');
      await invoke(envelope, deps);

      // Baseline: already GREEN — ready files don't trigger create()
      expect(createSpy).not.toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // 3b: invoke() must NEVER update registry session_id
  // -------------------------------------------------------------------------
  describe('invoke() must never overwrite the primer session_id in registry', () => {
    it('should NOT call registry.update() with session_id for a cold file', async () => {
      // The primer pointer in the registry is set during bootstrap.
      // invoke() must never overwrite it — doing so loses the primer.
      const deps = makeInvokeDeps();

      deps.registry.add({
        file_path: 'src/cold-file.ts',
        file_hash: 'hash-cold',
        status: 'cold',
        session_id: null,
        declarations: null,
        last_active: null,
        error: null,
      });

      // Mock create to succeed — otherwise invoke throws before reaching
      // the registry.update() call and the test passes vacuously.
      deps.sessionManager.create = vi.fn().mockResolvedValue({
        session_id: 'new-cold-session',
        file_path: 'src/cold-file.ts',
        created_at: new Date(),
        file_hash: 'hash-cold',
        status: 'active',
        systemPrompt: '',
        tools: [],
        model: 'test',
        cumulativeCostUsd: 0,
      });

      deps.sessionManager.invokeOnSession = vi.fn().mockResolvedValue({
        ...VALID_RESPONSE,
        responder: 'src/cold-file.ts',
      });

      const updateSpy = vi.spyOn(deps.registry, 'update');

      const envelope = makeEnvelope('src/cold-file.ts');

      try {
        await invoke(envelope, deps);
      } catch {
        // May throw or succeed depending on code path — either way, check update
      }

      // registry.update must NEVER be called with session_id from invoke
      const sessionIdUpdates = updateSpy.mock.calls.filter(
        ([, updates]) => 'session_id' in (updates as Record<string, unknown>),
      );
      expect(sessionIdUpdates).toHaveLength(0);
    });

    it('should NOT call registry.update() with session_id for a stale file', async () => {
      const deps = makeInvokeDeps();

      deps.registry.add({
        file_path: 'src/stale-file.ts',
        file_hash: 'hash-stale-old',
        status: 'ready',
        session_id: 'original-primer',
        declarations: makeDeclarations(),
        last_active: new Date(),
        error: null,
      });

      // Trigger stale via hash change
      deps.registry.update('src/stale-file.ts', { file_hash: 'hash-stale-new' });

      // Mock create to succeed for the stale re-bootstrap path
      deps.sessionManager.create = vi.fn().mockResolvedValue({
        session_id: 'new-stale-session',
        file_path: 'src/stale-file.ts',
        created_at: new Date(),
        file_hash: 'hash-stale-new',
        status: 'active',
        systemPrompt: '',
        tools: [],
        model: 'test',
        cumulativeCostUsd: 0,
      });

      deps.sessionManager.invokeOnSession = vi.fn().mockResolvedValue({
        ...VALID_RESPONSE,
        responder: 'src/stale-file.ts',
      });

      // Clear the spy after the setup update
      const updateSpy = vi.spyOn(deps.registry, 'update');

      const envelope = makeEnvelope('src/stale-file.ts');

      try {
        await invoke(envelope, deps);
      } catch {
        // May throw or succeed
      }

      const sessionIdUpdates = updateSpy.mock.calls.filter(
        ([, updates]) => 'session_id' in (updates as Record<string, unknown>),
      );
      expect(sessionIdUpdates).toHaveLength(0);
    });
  });

  // -------------------------------------------------------------------------
  // 3c: For ready files, invoke uses the existing primer session_id
  // -------------------------------------------------------------------------
  describe('invoke() forks from the existing primer session_id', () => {
    it('invokeOnSession receives the primer session_id from registry', async () => {
      // Baseline GREEN: for ready files, invoke resolves session_id from
      // registry and passes it to invokeOnSession.
      const deps = makeInvokeDeps();
      const PRIMER_SESSION_ID = 'primer-session-abc-123';

      deps.registry.add({
        file_path: 'src/target.ts',
        file_hash: 'hash-target',
        status: 'ready',
        session_id: PRIMER_SESSION_ID,
        declarations: makeDeclarations(),
        last_active: new Date(),
        error: null,
      });

      const invokeOnSessionSpy = vi.fn().mockResolvedValue({
        ...VALID_RESPONSE,
        task_id: 'task-primer',
        responder: 'src/target.ts',
      });
      deps.sessionManager.invokeOnSession = invokeOnSessionSpy;

      const envelope = makeEnvelope('src/target.ts');
      await invoke(envelope, deps);

      expect(invokeOnSessionSpy).toHaveBeenCalledTimes(1);
      expect(invokeOnSessionSpy.mock.calls[0][0].sessionId).toBe(PRIMER_SESSION_ID);
      expect(invokeOnSessionSpy.mock.calls[0][0].forkSession).toBe(true);
    });

    it('multiple sequential invocations all use the same primer session_id', async () => {
      const deps = makeInvokeDeps();
      const PRIMER_SESSION_ID = 'primer-session-multi';

      deps.registry.add({
        file_path: 'src/multi-target.ts',
        file_hash: 'hash-multi',
        status: 'ready',
        session_id: PRIMER_SESSION_ID,
        declarations: makeDeclarations(),
        last_active: new Date(),
        error: null,
      });

      const invokeOnSessionSpy = vi.fn().mockResolvedValue({
        ...VALID_RESPONSE,
        responder: 'src/multi-target.ts',
      });
      deps.sessionManager.invokeOnSession = invokeOnSessionSpy;

      // Three sequential invocations on the same file
      for (let i = 0; i < 3; i++) {
        const envelope = makeEnvelope('src/multi-target.ts', {
          task_id: `task-multi-${i}`,
          trace_id: `trace-multi-${i}`,
        });
        await invoke(envelope, deps);
      }

      // All three must use the exact same primer session_id
      expect(invokeOnSessionSpy).toHaveBeenCalledTimes(3);
      for (let i = 0; i < 3; i++) {
        expect(invokeOnSessionSpy.mock.calls[i][0].sessionId).toBe(PRIMER_SESSION_ID);
      }
    });
  });

  // -------------------------------------------------------------------------
  // 3d: Primer session_id unchanged after invoke()
  // -------------------------------------------------------------------------
  describe('primer session_id preserved after invoke()', () => {
    it('registry session_id must be identical before and after invoke on ready file', async () => {
      const deps = makeInvokeDeps();
      const PRIMER_SESSION_ID = 'primer-preserve-me';

      deps.registry.add({
        file_path: 'src/preserve.ts',
        file_hash: 'hash-preserve',
        status: 'ready',
        session_id: PRIMER_SESSION_ID,
        declarations: makeDeclarations(),
        last_active: new Date(),
        error: null,
      });

      deps.sessionManager.invokeOnSession = vi.fn().mockResolvedValue({
        ...VALID_RESPONSE,
        task_id: 'task-preserve',
        responder: 'src/preserve.ts',
      });

      const beforeSessionId = deps.registry.get('src/preserve.ts')!.session_id;

      await invoke(makeEnvelope('src/preserve.ts', { task_id: 'task-preserve' }), deps);

      const afterSessionId = deps.registry.get('src/preserve.ts')!.session_id;

      // Primer pointer must be identical — no mutation allowed
      expect(afterSessionId).toBe(beforeSessionId);
      expect(afterSessionId).toBe(PRIMER_SESSION_ID);
    });

    it('registry session_id must not change even after invoke error on cold file', async () => {
      // Even when invoke fails on a cold file, the registry's session_id
      // must remain untouched. The cold file had session_id=null — it stays null.
      const deps = makeInvokeDeps();

      deps.registry.add({
        file_path: 'src/cold-preserve.ts',
        file_hash: 'hash-cold-p',
        status: 'cold',
        session_id: null,
        declarations: null,
        last_active: null,
        error: null,
      });

      // Mock create to return a session (simulating what current broken code does)
      deps.sessionManager.create = vi.fn().mockResolvedValue({
        session_id: 'SHOULD-NOT-APPEAR-IN-REGISTRY',
        file_path: 'src/cold-preserve.ts',
        created_at: new Date(),
        file_hash: 'hash-cold-p',
        status: 'active',
        systemPrompt: '',
        tools: [],
        model: 'test',
        cumulativeCostUsd: 0,
      });

      deps.sessionManager.invokeOnSession = vi.fn().mockResolvedValue({
        ...VALID_RESPONSE,
        responder: 'src/cold-preserve.ts',
      });

      try {
        await invoke(makeEnvelope('src/cold-preserve.ts'), deps);
      } catch {
        // May throw — that's fine
      }

      // The registry session_id must still be null — invoke must not have
      // written a new session_id into it
      const entry = deps.registry.get('src/cold-preserve.ts')!;
      expect(entry.session_id).toBeNull();
    });

    it('registry session_id must not change even after invoke on stale file', async () => {
      const deps = makeInvokeDeps();
      const ORIGINAL_PRIMER = 'original-primer-id';

      deps.registry.add({
        file_path: 'src/stale-preserve.ts',
        file_hash: 'hash-v1',
        status: 'ready',
        session_id: ORIGINAL_PRIMER,
        declarations: makeDeclarations(),
        last_active: new Date(),
        error: null,
      });

      // Make it stale
      deps.registry.update('src/stale-preserve.ts', { file_hash: 'hash-v2' });
      // ready→stale nullifies session_id and declarations per registry logic
      const staleEntry = deps.registry.get('src/stale-preserve.ts')!;
      const sessionIdAfterStale = staleEntry.session_id;

      // Mock create to return a new session (current broken code path)
      deps.sessionManager.create = vi.fn().mockResolvedValue({
        session_id: 'NEW-SESSION-SHOULD-NOT-REPLACE',
        file_path: 'src/stale-preserve.ts',
        created_at: new Date(),
        file_hash: 'hash-v2',
        status: 'active',
        systemPrompt: '',
        tools: [],
        model: 'test',
        cumulativeCostUsd: 0,
      });

      deps.sessionManager.invokeOnSession = vi.fn().mockResolvedValue({
        ...VALID_RESPONSE,
        responder: 'src/stale-preserve.ts',
      });

      try {
        await invoke(makeEnvelope('src/stale-preserve.ts'), deps);
      } catch {
        // May throw
      }

      // The registry session_id must be whatever it was after going stale
      // — invoke must NOT have written 'NEW-SESSION-SHOULD-NOT-REPLACE' into it
      const afterInvoke = deps.registry.get('src/stale-preserve.ts')!;
      expect(afterInvoke.session_id).toBe(sessionIdAfterStale);
    });
  });
});
