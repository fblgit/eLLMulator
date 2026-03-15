/**
 * RED Tests: Registry Guard — invoke() must not bootstrap during trace
 *
 * Expected GREEN behavior (currently RED):
 * - invoke() on cold/stale files throws REGISTRY_NOT_BOOTSTRAPPED immediately
 * - invoke() NEVER calls sessionManager.create() — bootstrap is not invoke's job
 * - Trace entries log REGISTRY_NOT_BOOTSTRAPPED, not AGENT_BOOTSTRAP_FAILED
 *
 * Current broken behavior:
 * - invoke.ts L93-123: cold/stale files trigger sessionManager.create() with bootstrap prompt
 * - Failures wrapped in AGENT_BOOTSTRAP_FAILED — wrong error, wrong approach
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
import type { InvokeEnvelope } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInvokeDeps(overrides: Partial<Parameters<typeof invoke>[1]> = {}) {
  const registry = new Registry();
  const sessionManager = new SessionManager();
  const traceLog = new TraceLog();
  return {
    registry,
    sessionManager,
    traceLog,
    rateLimitTracker: new RateLimitTracker(),
    selfLoopTracker: new SelfLoopTracker(),
    readFile: vi.fn().mockResolvedValue('export function handleRequest() {}'),
    projectDir: '/test-project',
    ...overrides,
  };
}

function makeEnvelope(target: string, overrides: Partial<InvokeEnvelope> = {}): InvokeEnvelope {
  return {
    trace_id: 'trace-1',
    task_id: 'task-1',
    caller: '__trace_initiator__',
    target,
    function: 'handleRequest',
    call_stack: [],
    mode: 'sync',
    max_depth: 10,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Registry Guard — invoke() must not bootstrap during trace', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // #1: Cold file → REGISTRY_NOT_BOOTSTRAPPED
  // =========================================================================
  it('invoke on a COLD file must throw REGISTRY_NOT_BOOTSTRAPPED immediately', async () => {
    const deps = makeInvokeDeps();

    deps.registry.add({
      file_path: 'src/cold-file.ts',
      file_hash: 'abc123',
      status: 'cold',
      session_id: null,
      declarations: null,
      last_active: null,
      error: null,
    });

    const envelope = makeEnvelope('src/cold-file.ts');

    try {
      await invoke(envelope, deps);
      expect.unreachable('should have thrown');
    } catch (err: any) {
      // Must be REGISTRY_NOT_BOOTSTRAPPED, not AGENT_BOOTSTRAP_FAILED
      expect(err.message).toMatch(/REGISTRY_NOT_BOOTSTRAPPED/);
      expect(err.message).not.toMatch(/AGENT_BOOTSTRAP_FAILED/);
    }
  });

  // =========================================================================
  // #2: invoke must NEVER call sessionManager.create()
  // =========================================================================
  it('invoke must NEVER call sessionManager.create() — bootstrap is not invoke\'s job', async () => {
    const deps = makeInvokeDeps();

    deps.registry.add({
      file_path: 'src/cold-file.ts',
      file_hash: 'abc123',
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
      // expected to throw
    }

    // sessionManager.create() must NEVER be called from invoke
    expect(createSpy).not.toHaveBeenCalled();
  });

  // =========================================================================
  // #3: Stale file → REGISTRY_NOT_BOOTSTRAPPED
  // =========================================================================
  it('invoke on a STALE file must throw REGISTRY_NOT_BOOTSTRAPPED immediately', async () => {
    const deps = makeInvokeDeps();

    // A stale file has a session_id from a previous bootstrap, but the file changed
    deps.registry.add({
      file_path: 'src/stale-file.ts',
      file_hash: 'old-hash',
      status: 'cold', // start cold
      session_id: null,
      declarations: null,
      last_active: null,
      error: null,
    });
    // Transition to bootstrapping → ready → stale
    deps.registry.update('src/stale-file.ts', { status: 'bootstrapping' });
    deps.registry.update('src/stale-file.ts', {
      status: 'ready',
      session_id: 'primer-session-old',
      declarations: {
        summary: 'Test file',
        owns: [{ name: 'handle', kind: 'function', intent: 'handles things', file_path: 'src/stale-file.ts', start_line: 1, end_line: 10 }],
        imports: [],
        exports: [],
        dependencies: [],
      },
    });
    // Make it stale by changing the hash
    deps.registry.update('src/stale-file.ts', { file_hash: 'new-hash' });

    // Confirm it's stale
    const entry = deps.registry.get('src/stale-file.ts');
    expect(entry!.status).toBe('stale');

    const createSpy = vi.spyOn(deps.sessionManager, 'create');
    const envelope = makeEnvelope('src/stale-file.ts');

    try {
      await invoke(envelope, deps);
      expect.unreachable('should have thrown');
    } catch (err: any) {
      expect(err.message).toMatch(/REGISTRY_NOT_BOOTSTRAPPED/);
      expect(err.message).not.toMatch(/AGENT_BOOTSTRAP_FAILED/);
    }

    // Must not attempt to create a session
    expect(createSpy).not.toHaveBeenCalled();
  });

  // =========================================================================
  // #4: Trace entry must log REGISTRY_NOT_BOOTSTRAPPED
  // =========================================================================
  it('trace entry for cold file must log REGISTRY_NOT_BOOTSTRAPPED error', async () => {
    const deps = makeInvokeDeps();

    deps.registry.add({
      file_path: 'src/cold-file.ts',
      file_hash: 'abc123',
      status: 'cold',
      session_id: null,
      declarations: null,
      last_active: null,
      error: null,
    });

    const envelope = makeEnvelope('src/cold-file.ts');

    try {
      await invoke(envelope, deps);
    } catch {
      // expected
    }

    const entries = deps.traceLog.getByTraceId('trace-1');
    expect(entries).toHaveLength(1);
    expect(entries[0].error).toMatch(/REGISTRY_NOT_BOOTSTRAPPED/);
    // Must NOT contain AGENT_BOOTSTRAP_FAILED
    expect(entries[0].error).not.toMatch(/AGENT_BOOTSTRAP_FAILED/);
  });

  it('trace entry for stale file must log REGISTRY_NOT_BOOTSTRAPPED error', async () => {
    const deps = makeInvokeDeps();

    deps.registry.add({
      file_path: 'src/stale-file.ts',
      file_hash: 'old-hash',
      status: 'cold',
      session_id: null,
      declarations: null,
      last_active: null,
      error: null,
    });
    deps.registry.update('src/stale-file.ts', { status: 'bootstrapping' });
    deps.registry.update('src/stale-file.ts', {
      status: 'ready',
      session_id: 'primer-session-old',
      declarations: {
        summary: 'Test file',
        owns: [{ name: 'handle', kind: 'function', intent: 'handles things', file_path: 'src/stale-file.ts', start_line: 1, end_line: 10 }],
        imports: [],
        exports: [],
        dependencies: [],
      },
    });
    deps.registry.update('src/stale-file.ts', { file_hash: 'new-hash' });

    const envelope = makeEnvelope('src/stale-file.ts');

    try {
      await invoke(envelope, deps);
    } catch {
      // expected
    }

    const entries = deps.traceLog.getByTraceId('trace-1');
    expect(entries).toHaveLength(1);
    expect(entries[0].error).toMatch(/REGISTRY_NOT_BOOTSTRAPPED/);
  });

  // =========================================================================
  // Sanity: ready file should NOT throw REGISTRY_NOT_BOOTSTRAPPED
  // =========================================================================
  it('invoke on a READY file must proceed normally (not throw REGISTRY_NOT_BOOTSTRAPPED)', async () => {
    const deps = makeInvokeDeps();

    deps.registry.add({
      file_path: 'src/ready-file.ts',
      file_hash: 'abc123',
      status: 'cold',
      session_id: null,
      declarations: null,
      last_active: null,
      error: null,
    });
    deps.registry.update('src/ready-file.ts', { status: 'bootstrapping' });
    deps.registry.update('src/ready-file.ts', {
      status: 'ready',
      session_id: 'primer-session-1',
      declarations: {
        summary: 'Ready test file',
        owns: [{ name: 'handleRequest', kind: 'function', intent: 'handle request', file_path: 'src/ready-file.ts', start_line: 1, end_line: 10 }],
        imports: [],
        exports: [],
        dependencies: [],
      },
    });

    // Mock invokeOnSession for the ready path
    deps.sessionManager.invokeOnSession = vi.fn().mockResolvedValue({
      task_id: 'task-1',
      responder: 'src/ready-file.ts',
      returns: { ok: true },
      source_refs: ['src/ready-file.ts:1-10'],
    });

    const envelope = makeEnvelope('src/ready-file.ts');

    // Should NOT throw — ready files proceed normally
    const result = await invoke(envelope, deps);
    expect(result).toBeDefined();
    expect(result.responder).toBe('src/ready-file.ts');
  });
});
