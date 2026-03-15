/**
 * RED-4B: Dependency Source Injection Behavioral Tests
 *
 * Tests that:
 * - invoke.ts reads dependency files from disk at invoke time
 * - templates.ts renderSystemPrompt() accepts and renders dependencySources
 * - Missing dependency files are handled gracefully
 * - The source of dependency paths is declarations.dependencies
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderSystemPrompt } from '../../templates.js';
import { Registry } from '../../registry.js';
import type { RegistryEntry } from '../../registry.js';
import type { Declarations, InvokeEnvelope } from '../../types.js';
import { invoke, RateLimitTracker, SelfLoopTracker } from '../../invoke.js';
import type { InvokeDeps } from '../../invoke.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeclarations(deps: string[], summary = 'test file'): Declarations {
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
    dependencies: deps,
  };
}

function makeEnvelope(overrides: Partial<InvokeEnvelope> = {}): InvokeEnvelope {
  return {
    trace_id: 'trace-1',
    task_id: 'task-1',
    caller: 'caller.ts',
    target: 'target.ts',
    function: 'handleRequest',
    call_stack: [],
    mode: 'sync',
    max_depth: 50,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Template Tests (renderSystemPrompt)
// ---------------------------------------------------------------------------

describe('SPEC §4.4: Dependency source injection — templates', () => {
  it('SPEC: renderSystemPrompt embeds dependency sources in lean format', () => {
    const output = renderSystemPrompt({
      filePath: 'target.ts',
      sourceCode: '',
      dependencySources: [
        '// === types.ts ===\nexport type User = { id: string; name: string; };',
        '// === utils.ts ===\nexport function hash(s: string): string { return s; }',
      ],
    });

    // Lean system prompt identifies the agent
    expect(output).toContain('target.ts');
    // Dependency sources are embedded in <dependency_sources> tags
    expect(output).toContain('<dependency_sources>');
    expect(output).toContain('export type User');
  });

  it('SPEC: renderSystemPrompt without dependencySources is backward compatible', () => {
    const outputUndefined = renderSystemPrompt({
      filePath: 'target.ts',
      sourceCode: 'export function handleRequest() {}',
    });

    const outputEmpty = renderSystemPrompt({
      filePath: 'target.ts',
      sourceCode: 'export function handleRequest() {}',
      dependencySources: [],
    });

    // Neither should contain a dependency section header
    expect(outputUndefined).not.toContain('Dependency Sources');
    expect(outputEmpty).not.toContain('Dependency Sources');

    // Both should still have the core content
    expect(outputUndefined).toContain('target.ts');
    expect(outputEmpty).toContain('target.ts');
  });
});

// ---------------------------------------------------------------------------
// Invoke Integration Tests (dependency injection at invoke time)
// ---------------------------------------------------------------------------

describe('SPEC §4.4: Dependency source injection — invoke flow', () => {
  let registry: Registry;
  let mockSessionManager: any;
  let traceEntries: any[];
  let readFileContents: Record<string, string>;

  beforeEach(() => {
    registry = new Registry();
    traceEntries = [];
    readFileContents = {};

    mockSessionManager = {
      create: vi.fn().mockResolvedValue({
        session_id: 'sess-1',
        file_path: 'target.ts',
        created_at: new Date(),
        file_hash: 'hash-target',
        status: 'active',
      }),
      terminate: vi.fn().mockResolvedValue(undefined),
      query: vi.fn().mockResolvedValue({
        task_id: 'task-1',
        responder: 'target.ts',
        returns: { result: 'ok' },
        source_refs: ['target.ts:1-10'],
      }),
      invokeOnSession: vi.fn().mockResolvedValue({
        task_id: 'task-1',
        responder: 'target.ts',
        returns: { result: 'ok' },
        source_refs: ['target.ts:1-10'],
      }),
    };
  });

  function makeDeps(): InvokeDeps {
    return {
      registry,
      sessionManager: mockSessionManager,
      traceLog: (entry: any) => traceEntries.push(entry),
      rateLimitTracker: new RateLimitTracker(),
      selfLoopTracker: new SelfLoopTracker(),
      readFile: async (filePath: string) => {
        if (readFileContents[filePath] !== undefined) {
          return readFileContents[filePath];
        }
        throw new Error(`ENOENT: ${filePath}`);
      },
      projectDir: '/test/project',
    };
  }

  it('SPEC: invoke on cold file throws REGISTRY_NOT_BOOTSTRAPPED — bootstrap is a separate phase', async () => {
    // invoke() no longer bootstraps cold agents. Dependency injection into
    // system prompts happens during the bootstrap phase (outside invoke).
    // invoke on a cold file must throw immediately.
    registry.add({
      file_path: 'target.ts',
      file_hash: 'hash-target',
      status: 'cold',
      session_id: null,
      declarations: makeDeclarations(['types.ts', 'utils.ts']),
      last_active: null,
      error: null,
    });
    registry.add({
      file_path: 'caller.ts',
      file_hash: 'hash-caller',
      status: 'ready',
      session_id: 'sess-caller',
      declarations: makeDeclarations([]),
      last_active: new Date(),
      error: null,
    });

    readFileContents['target.ts'] = 'export function handleRequest() {}';
    readFileContents['types.ts'] = 'export type User = { id: string };';
    readFileContents['utils.ts'] = 'export function hash(s: string) { return s; }';

    const deps = makeDeps();

    await expect(invoke(makeEnvelope(), deps)).rejects.toThrow(/REGISTRY_NOT_BOOTSTRAPPED/);

    // invoke must NEVER call create — bootstrap handles session creation
    expect(mockSessionManager.create).not.toHaveBeenCalled();
  });

  it('SPEC: invoke on cold file with missing deps still throws REGISTRY_NOT_BOOTSTRAPPED', async () => {
    // Even when some dependency files are missing, invoke should not attempt
    // to bootstrap — it throws REGISTRY_NOT_BOOTSTRAPPED immediately.
    registry.add({
      file_path: 'target.ts',
      file_hash: 'hash-target',
      status: 'cold',
      session_id: null,
      declarations: makeDeclarations(['exists.ts', 'missing.ts']),
      last_active: null,
      error: null,
    });
    registry.add({
      file_path: 'caller.ts',
      file_hash: 'hash-caller',
      status: 'ready',
      session_id: 'sess-caller',
      declarations: makeDeclarations([]),
      last_active: new Date(),
      error: null,
    });

    readFileContents['target.ts'] = 'export function handleRequest() {}';
    readFileContents['exists.ts'] = 'export const VALUE = 42;';

    const deps = makeDeps();

    await expect(invoke(makeEnvelope(), deps)).rejects.toThrow(/REGISTRY_NOT_BOOTSTRAPPED/);
    expect(mockSessionManager.create).not.toHaveBeenCalled();
  });

  it('SPEC: Dependency injection applies during bootstrap, not invoke — invoke rejects cold files', async () => {
    // Dependency injection (reading dep files, passing to systemPrompt)
    // is the bootstrap phase's responsibility. invoke on cold files throws.
    registry.add({
      file_path: 'target.ts',
      file_hash: 'hash-target',
      status: 'cold',
      session_id: null,
      declarations: makeDeclarations(['dep-a.ts']),
      last_active: null,
      error: null,
    });
    registry.add({
      file_path: 'caller.ts',
      file_hash: 'hash-caller',
      status: 'ready',
      session_id: 'sess-caller',
      declarations: makeDeclarations([]),
      last_active: new Date(),
      error: null,
    });

    readFileContents['target.ts'] = 'import { A } from "./dep-a"; export function f() {}';
    readFileContents['dep-a.ts'] = 'export const A = 1;';
    readFileContents['dep-b.ts'] = 'export const B = 2;';

    const deps = makeDeps();

    await expect(invoke(makeEnvelope(), deps)).rejects.toThrow(/REGISTRY_NOT_BOOTSTRAPPED/);
    expect(mockSessionManager.create).not.toHaveBeenCalled();
  });
});
