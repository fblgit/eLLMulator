/**
 * RED Phase Tests -- FR-011: Query Handlers (inspect, status, list_agents)
 *
 * SPEC grounding:
 *   inspect:λ(file_path:str!) → { entry:RegistryEntry!, session:AgentSession?, declarations:Declarations? }
 *   status:λ → { total_files:int!, by_status:Record<str,int>!, active_traces:int!, agent_pool_size:int! }
 *   list_agents:λ(filter_status:str?) → [{ file_path:str!, status:str!, has_session:bool!, declaration_count:int! }]
 *
 * Implementation: ./mcp-external.ts (consolidated external MCP handlers)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Registry, type RegistryEntry, type Declarations } from './registry.js';
import type { SessionManager, AgentSession } from './session-manager.js';
import type { TraceEntry } from './types.js';
import {
  createInspectHandler,
  createStatusHandler,
  createListAgentsHandler,
  type QueryDeps,
} from './mcp-external.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    file_path: 'src/server.ts',
    file_hash: 'abc123def456',
    status: 'cold',
    session_id: null,
    declarations: null,
    last_active: null,
    error: null,
    ...overrides,
  };
}

function makeDeclarations(overrides: Partial<Declarations> = {}): Declarations {
  return {
    summary: 'Main server entry point',
    owns: [
      {
        name: 'createServer',
        kind: 'function',
        intent: 'Factory for Server instances',
        file_path: 'src/server.ts',
        start_line: 10,
        end_line: 50,
      },
    ],
    imports: [{ name: 'Registry', from: './registry', kind: 'import' }],
    exports: [
      {
        name: 'createServer',
        kind: 'function',
        intent: 'Factory for Server instances',
        file_path: 'src/server.ts',
        start_line: 10,
        end_line: 50,
      },
    ],
    dependencies: ['src/registry.ts'],
    ...overrides,
  };
}

function makeSession(overrides: Partial<AgentSession> = {}): AgentSession {
  return {
    session_id: 'sess-001',
    file_path: 'src/server.ts',
    created_at: new Date(),
    file_hash: 'abc123def456',
    status: 'active',
    systemPrompt: 'You ARE src/server.ts',
    tools: ['invoke'],
    model: 'claude-opus-4-6',
    ...overrides,
  };
}

function makeTraceEntry(overrides: Partial<TraceEntry> = {}): TraceEntry {
  return {
    trace_id: 'trace-001',
    task_id: 'task-001',
    timestamp: new Date(),
    depth: 0,
    caller: 'src/handler.ts',
    target: 'src/service.ts',
    function: 'doWork',
    call_stack: [],
    ...overrides,
  };
}

/**
 * Build mock deps for query handlers.
 */
function makeDeps(overrides: {
  entries?: RegistryEntry[];
  sessions?: AgentSession[];
  traces?: TraceEntry[];
} = {}): QueryDeps {
  const entries = overrides.entries ?? [];
  const sessions = overrides.sessions ?? [];
  const traces = overrides.traces ?? [];

  const entryMap = new Map(entries.map((e) => [e.file_path, e]));

  const registry = {
    get: vi.fn((path: string) => {
      const e = entryMap.get(path);
      return e ? { ...e } : undefined;
    }),
    add: vi.fn(),
    update: vi.fn(),
    remove: vi.fn(),
    list: vi.fn(() => entries.map((e) => ({ ...e }))),
    listByStatus: vi.fn((status: string) =>
      entries.filter((e) => e.status === status).map((e) => ({ ...e })),
    ),
    size: entries.length,
  };

  const sessionMap = new Map(sessions.map((s) => [s.session_id, s]));
  const sessionManager = {
    create: vi.fn(),
    get: vi.fn((id: string) => sessionMap.get(id)),
    terminate: vi.fn(),
    query: vi.fn(),
    list: vi.fn(() => sessions.filter((s) => s.status === 'active')),
    size: sessions.length,
  };

  const traceLog = {
    entries: [...traces],
    add: vi.fn(),
    list: vi.fn(() => traces),
    getByTraceId: vi.fn((id: string) => traces.filter((t) => t.trace_id === id)),
    getActiveCount: vi.fn(() => traces.filter((t) => t.duration_ms === undefined).length),
    toJSONL: vi.fn(() => ''),
    size: traces.length,
    clear: vi.fn(),
  };

  return {
    registry: registry as any,
    sessionManager: sessionManager as any,
    traceLog: traceLog as any,
  } as QueryDeps;
}

// ===========================================================================
// FR-011: inspect()
// ===========================================================================

describe('FR-011: inspect()', () => {
  it('returns entry, session, and declarations for registered file with active session', () => {
    const decls = makeDeclarations();
    const entry = makeEntry({
      file_path: 'src/server.ts',
      status: 'ready',
      session_id: 'sess-001',
      declarations: decls,
    });
    const session = makeSession({ session_id: 'sess-001', file_path: 'src/server.ts' });

    const deps = makeDeps({ entries: [entry], sessions: [session] });
    const inspect = createInspectHandler(deps);

    const result = inspect('src/server.ts');

    expect(result.entry).toBeDefined();
    expect(result.entry.file_path).toBe('src/server.ts');
    expect(result.entry.status).toBe('ready');
    expect(result.session).toBeDefined();
    expect(result.session!.session_id).toBe('sess-001');
    expect(result.declarations).toBeDefined();
    expect(result.declarations!.summary).toBe('Main server entry point');
  });

  it('returns entry with null session and null declarations for cold file', () => {
    const entry = makeEntry({
      file_path: 'src/cold.ts',
      status: 'cold',
      session_id: null,
      declarations: null,
    });

    const deps = makeDeps({ entries: [entry] });
    const inspect = createInspectHandler(deps);

    const result = inspect('src/cold.ts');

    expect(result.entry).toBeDefined();
    expect(result.entry.status).toBe('cold');
    expect(result.session).toBeNull();
    expect(result.declarations).toBeNull();
  });

  it('throws FILE_NOT_REGISTERED for unregistered file', () => {
    const deps = makeDeps({ entries: [] });
    const inspect = createInspectHandler(deps);

    expect(() => inspect('src/nonexistent.ts')).toThrow(/FILE_NOT_REGISTERED/);
  });
});

// ===========================================================================
// FR-011: status()
// ===========================================================================

describe('FR-011: status()', () => {
  it('returns correct total_files count', () => {
    const entries = [
      makeEntry({ file_path: 'src/a.ts', status: 'ready' }),
      makeEntry({ file_path: 'src/b.ts', status: 'cold' }),
      makeEntry({ file_path: 'src/c.ts', status: 'bootstrapping' }),
    ];

    const deps = makeDeps({ entries });
    const status = createStatusHandler(deps);

    expect(status().total_files).toBe(3);
  });

  it('returns correct by_status counts', () => {
    const entries = [
      makeEntry({ file_path: 'src/a.ts', status: 'ready' }),
      makeEntry({ file_path: 'src/b.ts', status: 'ready' }),
      makeEntry({ file_path: 'src/c.ts', status: 'cold' }),
      makeEntry({ file_path: 'src/d.ts', status: 'bootstrapping' }),
      makeEntry({ file_path: 'src/e.ts', status: 'stale' }),
      makeEntry({ file_path: 'src/f.ts', status: 'error', error: 'crash' }),
    ];

    const deps = makeDeps({ entries });
    const status = createStatusHandler(deps);

    expect(status().by_status).toEqual({
      cold: 1,
      bootstrapping: 1,
      ready: 2,
      stale: 1,
      error: 1,
    });
  });

  it('returns active_traces = 0 when all traces completed', () => {
    const traces = [
      makeTraceEntry({ duration_ms: 150 }),
      makeTraceEntry({ duration_ms: 200 }),
    ];

    const deps = makeDeps({ traces });
    const status = createStatusHandler(deps);

    expect(status().active_traces).toBe(0);
  });

  it('counts active traces (entries without duration_ms)', () => {
    const traces = [
      makeTraceEntry({ duration_ms: 150 }),
      makeTraceEntry({}), // active — no duration_ms
      makeTraceEntry({}), // active
      makeTraceEntry({ duration_ms: 50 }),
    ];

    const deps = makeDeps({ traces });
    const status = createStatusHandler(deps);

    expect(status().active_traces).toBe(2);
  });

  it('returns correct agent_pool_size for active sessions', () => {
    const sessions = [
      makeSession({ session_id: 'sess-001', status: 'active' }),
      makeSession({ session_id: 'sess-002', status: 'active' }),
      makeSession({ session_id: 'sess-003', status: 'idle' }),
    ];

    const deps = makeDeps({ sessions });
    const status = createStatusHandler(deps);

    expect(status().agent_pool_size).toBe(2);
  });

  it('handles empty registry returning all zeros', () => {
    const deps = makeDeps({});
    const status = createStatusHandler(deps);

    const result = status();
    expect(result.total_files).toBe(0);
    expect(result.by_status).toEqual({
      cold: 0,
      bootstrapping: 0,
      ready: 0,
      stale: 0,
      error: 0,
    });
    expect(result.active_traces).toBe(0);
    expect(result.agent_pool_size).toBe(0);
  });
});

// ===========================================================================
// FR-011: list_agents()
// ===========================================================================

describe('FR-011: list_agents()', () => {
  it('returns all agents when no filter', () => {
    const entries = [
      makeEntry({ file_path: 'src/a.ts', status: 'ready' }),
      makeEntry({ file_path: 'src/b.ts', status: 'cold' }),
    ];

    const deps = makeDeps({ entries });
    const listAgents = createListAgentsHandler(deps);

    expect(listAgents()).toHaveLength(2);
  });

  it('filters by status when filter_status provided', () => {
    const entries = [
      makeEntry({ file_path: 'src/a.ts', status: 'ready' }),
      makeEntry({ file_path: 'src/b.ts', status: 'cold' }),
      makeEntry({ file_path: 'src/c.ts', status: 'ready' }),
    ];

    const deps = makeDeps({ entries });
    const listAgents = createListAgentsHandler(deps);

    const result = listAgents('ready');
    expect(result).toHaveLength(2);
    expect(result.every((a: any) => a.status === 'ready')).toBe(true);
  });

  it('returns correct has_session and declaration_count', () => {
    const entries = [
      makeEntry({
        file_path: 'src/a.ts',
        status: 'ready',
        session_id: 'sess-001',
        declarations: makeDeclarations({
          owns: [
            { name: 'fn1', kind: 'function', intent: '', file_path: 'src/a.ts', start_line: 1, end_line: 5 },
            { name: 'fn2', kind: 'function', intent: '', file_path: 'src/a.ts', start_line: 6, end_line: 10 },
          ],
        }),
      }),
      makeEntry({
        file_path: 'src/b.ts',
        status: 'cold',
        session_id: null,
        declarations: null,
      }),
    ];

    const deps = makeDeps({ entries });
    const listAgents = createListAgentsHandler(deps);

    const result = listAgents();

    const a = result.find((x: any) => x.file_path === 'src/a.ts');
    expect(a!.has_session).toBe(true);
    expect(a!.declaration_count).toBe(2);

    const b = result.find((x: any) => x.file_path === 'src/b.ts');
    expect(b!.has_session).toBe(false);
    expect(b!.declaration_count).toBe(0);
  });

  it('returns empty array for empty registry', () => {
    const deps = makeDeps({});
    const listAgents = createListAgentsHandler(deps);

    expect(listAgents()).toEqual([]);
  });

  it('each agent has required shape fields', () => {
    const entries = [
      makeEntry({
        file_path: 'src/server.ts',
        status: 'ready',
        session_id: 'sess-001',
        declarations: makeDeclarations(),
      }),
    ];

    const deps = makeDeps({ entries });
    const listAgents = createListAgentsHandler(deps);

    const result = listAgents();
    const agent = result[0];

    expect(typeof agent.file_path).toBe('string');
    expect(typeof agent.status).toBe('string');
    expect(typeof agent.has_session).toBe('boolean');
    expect(typeof agent.declaration_count).toBe('number');
  });
});
