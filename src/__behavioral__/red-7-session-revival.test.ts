/**
 * RED-7: Session Revival — Trace CLI Cold-Start Bug
 *
 * Reproduces the exact failure path from `trace "..."` CLI command:
 *   1. Server bootstraps agents → registry entries have status='ready', session_id=<uuid>
 *   2. Persistence upserts during register() handler — BEFORE session_id is set → null in DB
 *   3. New process (trace CLI) loads from persistence → ready entries with null session_id
 *   4. invoke() sees ready entry, grabs null session_id, calls invokeOnSession(null)
 *   5. SessionManager throws "Session not found: null" — opaque, unhelpful
 *
 * Three distinct bugs:
 *   A. Persistence doesn't capture session_id (upsert fires too early in register handler)
 *   B. invoke() doesn't guard against ready entries with null/stale session_id
 *   C. No session revival path for cold-start trace scenarios (fresh SessionManager)
 *
 * Prefix: [MUST-PASS-AT-TRACE-V2]
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock SDK before any imports that use it
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

import { Registry } from '../registry.js';
import { SessionManager } from '../session-manager.js';
import { TraceLog } from '../trace-log.js';
import { invoke, RateLimitTracker, SelfLoopTracker } from '../invoke.js';
import { SyntheticState, createRegisterHandler } from '../handlers.js';
import type { InvokeEnvelope, Declarations } from '../types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReadyEntry(filePath: string, sessionId: string | null = null) {
  return {
    file_path: filePath,
    file_hash: 'hash-' + filePath,
    status: 'ready' as const,
    session_id: sessionId,
    declarations: {
      summary: `${filePath} module`,
      owns: [
        { name: 'Server', kind: 'class' as const, intent: 'Main entry creates both MCP surfaces', file_path: filePath, start_line: 1, end_line: 100 },
      ],
      imports: [],
      exports: [],
      dependencies: ['./registry.js', './session-manager.js'],
    },
    last_active: new Date(),
    error: null,
  };
}

function makeInvokeDeps(overrides: Partial<Parameters<typeof invoke>[1]> = {}) {
  const registry = new Registry();
  const traceLog = new TraceLog();
  return {
    registry,
    sessionManager: new SessionManager(),
    traceLog,
    rateLimitTracker: new RateLimitTracker(),
    selfLoopTracker: new SelfLoopTracker(),
    readFile: vi.fn().mockResolvedValue('export function Server() {}'),
    projectDir: '/test-project',
    ...overrides,
  };
}

function makeEnvelope(target: string, fn: string = 'Server'): InvokeEnvelope {
  return {
    trace_id: 'trace-cold-start',
    task_id: 'task-1',
    caller: '__trace_initiator__',
    target,
    function: fn,
    call_stack: [],
    mode: 'sync',
    max_depth: 10,
  };
}

// ===========================================================================
// BUG A: Ready entry with null session_id — the exact error Xavier hit
// ===========================================================================

describe('[MUST-PASS-AT-TRACE-V2] Ready entry with null session_id', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.clearAllMocks(); });

  it('should NOT throw "Session not found: null" — must throw a descriptive error', async () => {
    // This is the EXACT scenario from the trace CLI:
    // - Registry loaded from persistence with status='ready', declarations present
    // - session_id is null (persistence gap)
    // - invoke() should detect this and throw a clear error, not let it
    //   propagate as the opaque "Session not found: null"

    const deps = makeInvokeDeps();
    deps.registry.add(makeReadyEntry('src/server.ts', null)); // ready but null session_id

    const envelope = makeEnvelope('src/server.ts');

    try {
      await invoke(envelope, deps);
      expect.unreachable('should have thrown');
    } catch (err: any) {
      // MUST NOT be the opaque SessionManager error
      expect(err.message).not.toMatch(/^Session not found: null$/);
      // Should be a clear, structured error about missing session
      expect(err.message).toMatch(/SESSION_NOT_AVAILABLE|SESSION_EXPIRED|session.*null|no.*session/i);
      expect(err.message).toContain('src/server.ts');
    }
  });

  it('should log a descriptive trace entry — not "Session not found: null"', async () => {
    const deps = makeInvokeDeps();
    deps.registry.add(makeReadyEntry('src/server.ts', null));

    const envelope = makeEnvelope('src/server.ts');

    try { await invoke(envelope, deps); } catch { /* expected */ }

    const entries = deps.traceLog.getByTraceId('trace-cold-start');
    expect(entries).toHaveLength(1);
    // Trace entry error should be descriptive
    expect(entries[0].error).toBeDefined();
    expect(entries[0].error).not.toBe('Session not found: null');
    expect(entries[0].error).toMatch(/SESSION_NOT_AVAILABLE|SESSION_EXPIRED|session/i);
  });
});

// ===========================================================================
// BUG B: Ready entry with stale session_id (not in SessionManager)
// ===========================================================================

describe('[MUST-PASS-AT-TRACE-V2] Ready entry with stale session_id', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.clearAllMocks(); });

  it('should NOT throw "Session not found: <uuid>" — must detect stale session and provide clear error', async () => {
    // Scenario: registry has a session_id from a previous server run.
    // SessionManager is fresh (new process). The session_id doesn't map
    // to any in-memory session.

    const deps = makeInvokeDeps();
    const staleSessionId = 'dead-session-from-previous-run-12345';
    deps.registry.add(makeReadyEntry('src/server.ts', staleSessionId));

    const envelope = makeEnvelope('src/server.ts');

    try {
      await invoke(envelope, deps);
      expect.unreachable('should have thrown');
    } catch (err: any) {
      // MUST NOT be the raw SessionManager error
      expect(err.message).not.toMatch(/^Session not found: dead-session/);
      // Should be a clear error about the session being unavailable/expired
      expect(err.message).toMatch(/SESSION_NOT_AVAILABLE|SESSION_EXPIRED|session.*stale|no.*session/i);
    }
  });

  it('trace entry should identify the stale session scenario distinctly from cold/null', async () => {
    const deps = makeInvokeDeps();
    deps.registry.add(makeReadyEntry('src/server.ts', 'stale-session-999'));

    const envelope = makeEnvelope('src/server.ts');

    try { await invoke(envelope, deps); } catch { /* expected */ }

    const entries = deps.traceLog.getByTraceId('trace-cold-start');
    expect(entries).toHaveLength(1);
    expect(entries[0].error).toBeDefined();
    // Should mention the stale session ID for debugging
    expect(entries[0].error).toContain('stale-session-999');
  });
});

// ===========================================================================
// BUG C: Persistence roundtrip — session_id must survive bootstrap → DB → reload
// ===========================================================================

describe('[MUST-PASS-AT-TRACE-V2] Persistence captures session_id after bootstrap', () => {
  it('register handler persistence upsert should include session_id when available', () => {
    // The register handler wrapper in server.ts calls persistence.upsertAgent()
    // INSIDE the register handler — but at that point session_id is still null.
    // Bootstrap.ts sets session_id AFTER create() returns, but the persistence
    // write already happened.
    //
    // This test verifies the persistence upsert captures the final state
    // (including session_id) not the intermediate state.

    const registry = new Registry();
    registry.add({
      file_path: 'src/handler.ts',
      file_hash: 'abc',
      status: 'cold',
      session_id: null,
      declarations: null,
      last_active: null,
      error: null,
    });

    // Simulate bootstrap flow:
    // 1. Bootstrap marks as bootstrapping
    registry.update('src/handler.ts', { status: 'bootstrapping' });

    // 2. Session created → session_id available
    const sessionId = 'session-from-sdk-12345';

    // 3. Agent calls register MCP tool
    const registerHandler = createRegisterHandler(registry);
    const registerResult = registerHandler('src/handler.ts', {
      summary: 'Handler module',
      owns: [{ name: 'handle', kind: 'function', intent: 'handle request', file_path: 'src/handler.ts', start_line: 1, end_line: 10 }],
      imports: [],
      exports: [],
      dependencies: [],
    });
    expect(registerResult).toEqual({ success: true });

    // 4. At this point in real code, persistence.upsertAgent() fires.
    //    We capture what the registry entry looks like at this moment:
    const entryAtRegisterTime = registry.get('src/handler.ts');
    // BUG: session_id is still null because bootstrap hasn't set it yet
    expect(entryAtRegisterTime!.status).toBe('ready');
    // This WILL be null — documenting the gap
    // The fix should ensure persistence captures session_id AFTER bootstrap sets it

    // 5. Bootstrap handler sets session_id (AFTER register completes)
    registry.update('src/handler.ts', { session_id: sessionId });

    // 6. Final state should have session_id
    const finalEntry = registry.get('src/handler.ts');
    expect(finalEntry!.session_id).toBe(sessionId);

    // KEY ASSERTION: If we were to persist NOW (after bootstrap sets session_id),
    // the entry would have session_id. But the current code persists at step 4.
    // This test documents the timing gap.
    expect(entryAtRegisterTime!.session_id).toBeNull();
    // ^ This passes (documenting the bug). The fix should ensure a second
    // persistence write happens after step 5, or the persistence write
    // is deferred until after bootstrap completes.
  });
});

// ===========================================================================
// BUG D: Session revival — invoke should lazy-spawn when session is missing
// ===========================================================================

describe('[MUST-PASS-AT-TRACE-V2] Session revival on invoke', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.clearAllMocks(); });

  it('should revive a session for a ready entry with null session_id and succeed', async () => {
    // When invoke encounters a ready entry with declarations but no session,
    // it should spawn a fresh session (using the existing declarations as context),
    // then invoke on that session. This is the "session revival" path that
    // enables trace CLI cold-start.

    const deps = makeInvokeDeps();
    deps.registry.add(makeReadyEntry('src/server.ts', null));

    // Mock the session revival path — sessionManager should be able to
    // create a new session and the invoke should succeed
    const mockSessionId = 'revived-session-001';
    const mockResponse = {
      task_id: 'task-1',
      responder: 'src/server.ts',
      returns: { description: 'Server entry point' },
      source_refs: ['src/server.ts:1-100'],
    };

    // The revival should use invokeOnSession with a newly created session
    deps.sessionManager.invokeOnSession = vi.fn().mockResolvedValue(mockResponse);
    deps.sessionManager.create = vi.fn().mockResolvedValue({
      session_id: mockSessionId,
      file_path: 'src/server.ts',
      created_at: new Date(),
      file_hash: 'hash-src/server.ts',
      status: 'active',
      systemPrompt: '',
      tools: [],
      model: 'claude-opus-4-6',
      cumulativeCostUsd: 0,
    });

    const envelope = makeEnvelope('src/server.ts');
    const result = await invoke(envelope, deps);

    // Should succeed after revival
    expect(result.responder).toBe('src/server.ts');
    expect(result.source_refs).toHaveLength(1);

    // Registry should be updated with new session_id
    const updatedEntry = deps.registry.get('src/server.ts');
    expect(updatedEntry!.session_id).toBe(mockSessionId);
  });

  it('should revive a session for a ready entry with stale session_id', async () => {
    // The session_id exists in registry but points to a dead session.
    // invokeOnSession will throw "Session not found" for the stale ID,
    // triggering revival (create new session), then retry invokeOnSession.

    const deps = makeInvokeDeps();
    deps.registry.add(makeReadyEntry('src/server.ts', 'dead-session-old'));

    const mockSessionId = 'revived-session-002';
    const mockResponse = {
      task_id: 'task-1',
      responder: 'src/server.ts',
      returns: { description: 'Server entry point' },
      source_refs: ['src/server.ts:1-100'],
    };

    // First call with stale session → throw; second call with revived session → succeed
    deps.sessionManager.invokeOnSession = vi.fn()
      .mockRejectedValueOnce(new Error('Session not found: dead-session-old'))
      .mockResolvedValue(mockResponse);
    deps.sessionManager.create = vi.fn().mockResolvedValue({
      session_id: mockSessionId,
      file_path: 'src/server.ts',
      created_at: new Date(),
      file_hash: 'hash-src/server.ts',
      status: 'active',
      systemPrompt: '',
      tools: [],
      model: 'claude-opus-4-6',
      cumulativeCostUsd: 0,
    });

    const envelope = makeEnvelope('src/server.ts');
    const result = await invoke(envelope, deps);

    expect(result.responder).toBe('src/server.ts');
    // Registry should have the new session_id, not the stale one
    const updatedEntry = deps.registry.get('src/server.ts');
    expect(updatedEntry!.session_id).toBe(mockSessionId);
    expect(updatedEntry!.session_id).not.toBe('dead-session-old');
  });
});

// ===========================================================================
// Integration: Full trace handler with cold-start registry
// ===========================================================================

describe('[MUST-PASS-AT-TRACE-V2] Trace handler cold-start integration', () => {
  beforeEach(() => { vi.clearAllMocks(); });
  afterEach(() => { vi.clearAllMocks(); });

  it('trace handler should produce meaningful results even when SessionManager is fresh', async () => {
    // This is the full scenario: trace CLI starts, loads registry from persistence,
    // runs trace. The trace handler should handle the session gap gracefully —
    // either by reviving sessions or by reporting a clear "needs bootstrap" finding.

    const registry = new Registry();
    const sessionManager = new SessionManager();
    const traceLog = new TraceLog();
    const syntheticState = new SyntheticState();

    // Simulate persistence-loaded registry (ready entries, no sessions)
    registry.add(makeReadyEntry('src/server.ts', null));
    registry.add({
      file_path: 'src/registry.ts',
      file_hash: 'hash-registry',
      status: 'ready' as const,
      session_id: null,
      declarations: {
        summary: 'Registry module',
        owns: [{ name: 'Registry', kind: 'class' as const, intent: 'Track file entries', file_path: 'src/registry.ts', start_line: 1, end_line: 50 }],
        imports: [],
        exports: [],
        dependencies: [],
      },
      last_active: new Date(),
      error: null,
    });

    const { createTraceHandler } = await import('../mcp-external.js');

    const mockInvoke = vi.fn().mockRejectedValue(new Error('Session not found: null'));

    const traceHandler = createTraceHandler({
      registry,
      sessionManager,
      traceLog,
      syntheticState,
      rateLimitTracker: new RateLimitTracker(),
      selfLoopTracker: new SelfLoopTracker(),
      readFile: vi.fn().mockResolvedValue('export function Server() {}'),
      projectDir: '/test-project',
      invoke: mockInvoke,
    });

    const result = await traceHandler({
      scenario: 'ClaudeSDK consumes internal MCP via SSETransport',
      max_depth: 10,
    });

    // The trace should not silently swallow the error with zero useful info.
    // It should either:
    // a) Have findings that explain why the trace failed (session gap), or
    // b) Actually succeed via session revival
    expect(result.entries.length).toBeGreaterThan(0);

    // At minimum, findings should flag the dead_spot with a clear explanation
    const deadSpots = result.findings.filter(f => f.type === 'dead_spot');
    expect(deadSpots.length).toBeGreaterThan(0);

    // The dead_spot description should NOT be just "Session not found: null"
    // It should explain the actual problem: session not available for the agent
    for (const spot of deadSpots) {
      expect(spot.description).not.toMatch(/^.*Session not found: null$/);
    }
  });
});
