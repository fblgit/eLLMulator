/**
 * RED Phase Tests — FR-006: Register Handler + FR-007: State & Resolve Handlers
 * Phase 3C: Respond Handler Tests
 *
 * SPEC grounding:
 *   register:lambda(file_path:str!, declarations:Declarations!) -> {success:bool}
 *     - Checks file_path exists in registry -> error if not
 *     - Sets entry.declarations = declarations
 *     - Sets entry.status = 'ready'
 *     - Sets entry.last_active = now
 *
 *   state_get:lambda(key:str!) -> *?  — returns synthetic_state[key] or undefined
 *   state_set:lambda(key:str!, value:*!) -> {success:bool} — sets synthetic_state[key] = value
 *
 *   resolve:lambda(file_path:str!) -> Declarations?
 *     - returns registry entry's declarations or undefined
 *
 *   respond:lambda(envelope:ResponseEnvelope!) -> {success:bool} | {error:str}
 *     - Validates envelope structure
 *     - Looks up pending promise by task_id
 *     - If found: resolves promise and removes from map
 *     - If not found: returns error 'NO_PENDING_REQUEST'
 *
 * Implementation target: ./handlers.ts (DOES NOT EXIST — tests MUST fail)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { Registry, type RegistryEntry, type Declarations } from './registry.js';
import type { ResponseEnvelope } from './types.js';
import {
  createRegisterHandler,
  createStateHandlers,
  createResolveHandler,
  createRespondHandler,
  SyntheticState,
} from './handlers.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    file_path: 'src/server.ts',
    file_hash: 'abc123def456',
    status: 'bootstrapping',
    session_id: 'sess-001',
    declarations: null,
    last_active: null,
    error: null,
    ...overrides,
  };
}

function makeDeclarations(overrides: Partial<Declarations> = {}): Declarations {
  return {
    summary: 'Main server entry point — creates dual MCP servers',
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
    imports: [
      { name: 'Registry', from: './registry', kind: 'import', file_path: 'src/registry.ts' },
    ],
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
    dependencies: ['src/registry.ts', 'src/session-manager.ts'],
    ...overrides,
  };
}

function makeResponseEnvelope(overrides: Partial<ResponseEnvelope> = {}): ResponseEnvelope {
  return {
    task_id: 'task-001',
    responder: 'agent-server',
    returns: { result: 'success' },
    source_refs: ['src/server.ts:10-50'],
    ...overrides,
  };
}

// ===========================================================================
// FR-006: Register Handler
// ===========================================================================

describe('FR-006: register()', () => {
  let registry: Registry;
  let register: ReturnType<typeof createRegisterHandler>;

  beforeEach(() => {
    registry = new Registry();
    register = createRegisterHandler(registry);
  });

  // -------------------------------------------------------
  // Test 1: register() sets declarations on registry entry
  // -------------------------------------------------------
  it('sets declarations on the registry entry', () => {
    registry.add(makeEntry({ file_path: 'src/server.ts', status: 'bootstrapping' }));
    const decls = makeDeclarations();

    register('src/server.ts', decls);

    const entry = registry.get('src/server.ts');
    expect(entry).toBeDefined();
    expect(entry!.declarations).toEqual(decls);
  });

  // -------------------------------------------------------
  // Test 2: register() sets entry status to 'ready'
  // -------------------------------------------------------
  it('sets entry status to ready', () => {
    registry.add(makeEntry({ file_path: 'src/server.ts', status: 'bootstrapping' }));
    const decls = makeDeclarations();

    register('src/server.ts', decls);

    const entry = registry.get('src/server.ts');
    expect(entry!.status).toBe('ready');
  });

  // -------------------------------------------------------
  // Test 3: register() sets entry last_active to current time
  // -------------------------------------------------------
  it('sets entry last_active to current time', () => {
    registry.add(makeEntry({ file_path: 'src/server.ts', status: 'bootstrapping' }));
    const decls = makeDeclarations();

    const before = new Date();
    register('src/server.ts', decls);
    const after = new Date();

    const entry = registry.get('src/server.ts');
    expect(entry!.last_active).toBeInstanceOf(Date);
    expect(entry!.last_active!.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(entry!.last_active!.getTime()).toBeLessThanOrEqual(after.getTime());
  });

  // -------------------------------------------------------
  // Test 4: register() returns {success: true}
  // -------------------------------------------------------
  it('returns {success: true}', () => {
    registry.add(makeEntry({ file_path: 'src/server.ts', status: 'bootstrapping' }));
    const decls = makeDeclarations();

    const result = register('src/server.ts', decls);

    expect(result).toEqual({ success: true });
  });

  // -------------------------------------------------------
  // Test 5: register() returns error when file_path not in registry
  // SPEC: entry = registry[file_path], entry = null -> error FILE_NOT_IN_REGISTRY
  // -------------------------------------------------------
  it('returns error when file_path is not in registry', () => {
    const decls = makeDeclarations();

    const result = register('nonexistent/file.ts', decls);

    expect(result).toHaveProperty('error');
    expect(result.error).toBe('FILE_NOT_IN_REGISTRY');
  });
});

// ===========================================================================
// FR-007: State Handlers (state_get / state_set)
// ===========================================================================

describe('FR-007: state_get / state_set', () => {
  let syntheticState: SyntheticState;
  let stateHandlers: ReturnType<typeof createStateHandlers>;

  beforeEach(() => {
    syntheticState = new SyntheticState();
    stateHandlers = createStateHandlers(syntheticState);
  });

  // -------------------------------------------------------
  // Test 6: state_set() stores a value retrievable by state_get()
  // -------------------------------------------------------
  it('state_set stores a value retrievable by state_get', () => {
    stateHandlers.state_set('user.name', 'Alice');

    const result = stateHandlers.state_get('user.name');

    expect(result).toBe('Alice');
  });

  // -------------------------------------------------------
  // Test 7: state_get() returns undefined for unknown keys
  // SPEC: synthetic_state[key] ?? null (undefined)
  // -------------------------------------------------------
  it('state_get returns undefined for unknown keys', () => {
    const result = stateHandlers.state_get('nonexistent.key');

    expect(result).toBeUndefined();
  });

  // -------------------------------------------------------
  // Test 8: state_set() overwrites existing values
  // -------------------------------------------------------
  it('state_set overwrites existing values', () => {
    stateHandlers.state_set('counter', 1);
    stateHandlers.state_set('counter', 42);

    const result = stateHandlers.state_get('counter');

    expect(result).toBe(42);
  });

  // -------------------------------------------------------
  // Test 9: state_set() returns {success: true}
  // SPEC: state_set -> {success: bool}
  // -------------------------------------------------------
  it('state_set returns {success: true}', () => {
    const result = stateHandlers.state_set('key', 'value');

    expect(result).toEqual({ success: true });
  });

  // -------------------------------------------------------
  // Test 10: state supports any value type (string, number, object, array)
  // SPEC: synthetic_state:Map<str,*> — * = any type
  // -------------------------------------------------------
  it('supports any value type: string, number, object, array', () => {
    stateHandlers.state_set('str', 'hello');
    stateHandlers.state_set('num', 99);
    stateHandlers.state_set('obj', { id: 1, name: 'test' });
    stateHandlers.state_set('arr', [1, 'two', { three: 3 }]);
    stateHandlers.state_set('bool', true);
    stateHandlers.state_set('nil', null);

    expect(stateHandlers.state_get('str')).toBe('hello');
    expect(stateHandlers.state_get('num')).toBe(99);
    expect(stateHandlers.state_get('obj')).toEqual({ id: 1, name: 'test' });
    expect(stateHandlers.state_get('arr')).toEqual([1, 'two', { three: 3 }]);
    expect(stateHandlers.state_get('bool')).toBe(true);
    expect(stateHandlers.state_get('nil')).toBeNull();
  });
});

// ===========================================================================
// FR-007: Resolve Handler
// ===========================================================================

describe('FR-007: resolve()', () => {
  let registry: Registry;
  let resolve: ReturnType<typeof createResolveHandler>;

  beforeEach(() => {
    registry = new Registry();
    resolve = createResolveHandler(registry);
  });

  // -------------------------------------------------------
  // Test 11: resolve() returns declarations for a registered file with declarations
  // -------------------------------------------------------
  it('returns declarations for a registered file with declarations', () => {
    const decls = makeDeclarations();
    registry.add(makeEntry({
      file_path: 'src/server.ts',
      status: 'ready',
      declarations: decls,
    }));

    const result = resolve('src/server.ts');

    expect(result).toBeDefined();
    expect(result).toEqual(decls);
  });

  // -------------------------------------------------------
  // Test 12: resolve() returns undefined for unknown file_path
  // SPEC: entry = registry[file_path], entry = null -> null (undefined)
  // -------------------------------------------------------
  it('returns undefined for unknown file_path', () => {
    const result = resolve('nonexistent/file.ts');

    expect(result).toBeUndefined();
  });

  // -------------------------------------------------------
  // Test 13: resolve() returns undefined for registered file without declarations (cold)
  // SPEC: entry.declarations (null when cold -> undefined return)
  // -------------------------------------------------------
  it('returns undefined for registered file without declarations (cold entry)', () => {
    registry.add(makeEntry({
      file_path: 'src/cold-file.ts',
      status: 'cold',
      declarations: null,
    }));

    const result = resolve('src/cold-file.ts');

    expect(result).toBeUndefined();
  });

  // -------------------------------------------------------
  // Test 14b: resolve() enriches declarations with content when readFile provided
  // -------------------------------------------------------
  it('enriches declarations with content from disk when readFile provided', () => {
    const fileContent = 'line1\nline2\nline3\nline4\nline5\nline6\nline7\nline8\nline9\nline10\n' +
      'export function createServer() {\n  return {};\n}\n';
    const readFile = (path: string) => fileContent;
    const resolveWithContent = createResolveHandler(registry, readFile);
    const decls = makeDeclarations({
      owns: [{
        name: 'createServer',
        kind: 'function',
        intent: 'Factory',
        file_path: 'src/server.ts',
        start_line: 11,
        end_line: 13,
      }],
    });
    registry.add(makeEntry({ file_path: 'src/server.ts', status: 'ready', declarations: decls }));

    const result = resolveWithContent('src/server.ts');
    expect(result).toBeDefined();
    expect((result as any).owns[0].content).toBe('export function createServer() {\n  return {};\n}');
  });

  it('returns declarations without content when readFile not provided', () => {
    const decls = makeDeclarations();
    registry.add(makeEntry({ file_path: 'src/server.ts', status: 'ready', declarations: decls }));

    const result = resolve('src/server.ts');
    expect(result).toBeDefined();
    expect((result as any).owns[0].content).toBeUndefined();
  });
});

// ===========================================================================
// Phase 3C: Respond Handler
// ===========================================================================

describe('Phase 3C: respond()', () => {
  let pendingResponses: Map<string, (envelope: ResponseEnvelope) => void>;
  let respond: ReturnType<typeof createRespondHandler>;

  beforeEach(() => {
    pendingResponses = new Map();
    respond = createRespondHandler(pendingResponses);
  });

  // -------------------------------------------------------
  // Test 14: respond() resolves pending promise with valid envelope
  // -------------------------------------------------------
  it('resolves pending promise with valid envelope', () => {
    const envelope = makeResponseEnvelope({ task_id: 'task-001' });
    let capturedEnvelope: ResponseEnvelope | null = null;

    // Set up pending response
    pendingResponses.set('task-001', (env) => {
      capturedEnvelope = env;
    });

    const result = respond(envelope);

    expect(result).toEqual({ success: true });
    expect(capturedEnvelope).toEqual(envelope);
  });

  // -------------------------------------------------------
  // Test 15: respond() removes task from pendingResponses after resolving
  // -------------------------------------------------------
  it('removes task from pendingResponses after resolving', () => {
    const envelope = makeResponseEnvelope({ task_id: 'task-002' });

    pendingResponses.set('task-002', () => {});
    expect(pendingResponses.has('task-002')).toBe(true);

    respond(envelope);

    expect(pendingResponses.has('task-002')).toBe(false);
  });

  // -------------------------------------------------------
  // Test 16: respond() returns error for unknown task_id
  // SPEC: If not found: return error 'NO_PENDING_REQUEST'
  // -------------------------------------------------------
  it('returns error NO_PENDING_REQUEST for unknown task_id', () => {
    const envelope = makeResponseEnvelope({ task_id: 'unknown-task' });

    const result = respond(envelope);

    expect(result).toHaveProperty('error');
    expect(result.error).toBe('NO_PENDING_REQUEST');
  });

  // -------------------------------------------------------
  // Test 17: respond() rejects invalid envelope structure
  // SPEC: Validate envelope using ResponseEnvelopeSchema
  // -------------------------------------------------------
  it('rejects invalid envelope structure (missing required fields)', () => {
    // Missing required field 'task_id'
    const invalidEnvelope = {
      responder: 'agent-server',
      source_refs: ['src/test.ts'],
    } as any;

    const result = respond(invalidEnvelope);

    expect(result).toHaveProperty('error');
    expect(result.error).toContain('INVALID_ENVELOPE');
  });

  // -------------------------------------------------------
  // Test 18: respond() rejects envelope with invalid field types
  // -------------------------------------------------------
  it('rejects envelope with invalid field types', () => {
    const invalidEnvelope = {
      task_id: 'task-003',
      responder: 'agent-server',
      source_refs: 'not-an-array', // should be array
    } as any;

    const result = respond(invalidEnvelope);

    expect(result).toHaveProperty('error');
    expect(result.error).toContain('INVALID_ENVELOPE');
  });

  // -------------------------------------------------------
  // Test 19: respond() accepts valid envelope with optional fields
  // -------------------------------------------------------
  it('accepts valid envelope with optional fields (mutations, error)', () => {
    const envelope = makeResponseEnvelope({
      task_id: 'task-004',
      mutations: [
        { key: 'counter', before: 0, after: 1 },
      ],
      error: 'Some error occurred',
    });

    pendingResponses.set('task-004', () => {});

    const result = respond(envelope);

    expect(result).toEqual({ success: true });
  });

  // -------------------------------------------------------
  // Test 20: respond() returns error when valid envelope has no pending request
  // SPEC: Response with valid fields but no pending request returns error
  // -------------------------------------------------------
  it('returns error when valid envelope has no pending request', () => {
    const envelope = makeResponseEnvelope({ task_id: 'task-orphan' });

    // Don't add to pendingResponses
    const result = respond(envelope);

    expect(result).toHaveProperty('error');
    expect(result.error).toBe('NO_PENDING_REQUEST');
  });
});
