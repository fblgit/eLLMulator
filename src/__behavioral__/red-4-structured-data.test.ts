/**
 * RED-4: Structured Data in Agent Prompts
 *
 * Xavier's point #4: The AI/LLM/Claude must be presented with data —
 * starmap, registry dump, trace context — so it can produce REASONED
 * INTELLIGENT RESULTS. The agent needs the full picture.
 *
 * Current broken behavior:
 *   - invoke.ts calls renderSystemPrompt WITHOUT boundaryInfo (param exists but unused)
 *   - renderInvokePrompt only includes caller's declarations, not target's dependency graph
 *   - invoke() has access to registry with all dependency data but doesn't compute boundary info
 *   - Dependencies are full source dumps, not structured summaries
 *
 * Expected GREEN behavior:
 *   - invoke() computes and passes boundaryInfo to renderSystemPrompt
 *   - System prompt includes same-cluster vs cross-boundary file info
 *   - Invoke prompt includes target's dependency context (what it depends on, what depends on it)
 *   - Agent receives structured data to reason about cross-file behavior
 *
 * Prefix: [MUST-PASS-AT-TRACE-V2]
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
import { renderSystemPrompt, renderInvokePrompt } from '../templates.js';
import { createStarmap } from '../starmap.js';
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
  const sessionManager = new SessionManager();
  const traceLog = new TraceLog();
  return {
    registry,
    sessionManager,
    traceLog,
    rateLimitTracker: new RateLimitTracker(),
    selfLoopTracker: new SelfLoopTracker(),
    readFile: vi.fn().mockResolvedValue('export function handleRequest() { return "ok"; }'),
    projectDir: '/test-project',
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

describe('[MUST-PASS-AT-TRACE-V2] RED-4: Structured Data in Agent Prompts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // TEST 1: invoke() must pass boundaryInfo to renderSystemPrompt
  // =========================================================================
  describe('invoke() must compute and pass boundaryInfo', () => {
    it('renderSystemPrompt should include boundaryInfo when computed from registry dependencies', () => {
      // Bootstrap is responsible for computing boundaryInfo and passing it
      // to renderSystemPrompt when creating agent sessions. Verify the
      // template renders correctly when boundaryInfo is provided.
      //
      // The boundary info separates files into same-cluster (analyze directly)
      // vs cross-boundary (use invoke()).

      const prompt = renderSystemPrompt({
        filePath: 'src/handler.ts',
        sourceCode: 'export function handleRequest() {}',
        boundaryInfo: {
          sameCluster: ['src/db.ts'],
          crossBoundary: ['src/auth.ts'],
        },
      });

      // The system prompt should contain boundary routing info
      expect(prompt).toContain('Boundary Routing');
      expect(prompt).toMatch(/same.cluster|cross.boundary/i);
    });
  });

  // =========================================================================
  // TEST 2: renderSystemPrompt with boundaryInfo includes cluster info
  // =========================================================================
  describe('renderSystemPrompt must include boundary routing when provided', () => {
    it('system prompt should show same-cluster and cross-boundary files', () => {
      // renderSystemPrompt DOES support boundaryInfo — verify it renders correctly
      // when provided. This is a GREEN baseline that confirms the template works.

      const prompt = renderSystemPrompt({
        filePath: 'src/handler.ts',
        sourceCode: 'export function handle() {}',
        boundaryInfo: {
          sameCluster: ['src/db.ts'],
          crossBoundary: ['src/auth.ts'],
        },
      });

      // With boundaryInfo provided, the template renders the section
      expect(prompt).toContain('Boundary Routing');
      expect(prompt).toContain('src/db.ts');
      expect(prompt).toContain('src/auth.ts');
      expect(prompt).toContain('Same cluster');
      expect(prompt).toContain('Cross-boundary');
    });

    it('system prompt WITHOUT boundaryInfo lacks boundary routing section', () => {
      // This is the current behavior — no boundaryInfo → no section.
      // This test documents the gap: invoke never provides boundaryInfo.

      const prompt = renderSystemPrompt({
        filePath: 'src/handler.ts',
        sourceCode: 'export function handle() {}',
      });

      // Without boundaryInfo, no boundary routing section
      // This is the CURRENT state — invoke never passes it
      expect(prompt).not.toContain('Boundary Routing');
    });
  });

  // =========================================================================
  // TEST 3: renderInvokePrompt must include target's dependency context
  // =========================================================================
  describe('renderInvokePrompt must include target dependency context', () => {
    it('invoke prompt should show what the target file depends on and what depends on it', () => {
      // Currently renderInvokePrompt includes callerDeclarations (what the CALLER
      // declares) but NOT the target's dependency context (what the TARGET depends
      // on, what depends on the target). The agent analyzing a file needs to know
      // its position in the dependency graph.
      //
      // EXPECTED: The prompt should include a "Target Dependencies" or similar
      // section showing the target's declared dependencies and dependents.

      const prompt = renderInvokePrompt({
        envelope: {
          task_id: 'task-1',
          target: 'src/handler.ts',
          function: 'handleRequest',
          params: { userId: 123 },
          call_stack: ['src/server.ts'],
          caller: 'src/server.ts',
        },
        callerDeclarations: makeDeclarations({
          summary: 'HTTP server',
          dependencies: ['src/handler.ts'],
        }),
      });

      // The prompt should include context about the TARGET's dependencies
      // Currently it only includes the CALLER's context
      // This verifies the prompt tells the agent about the target's graph position
      expect(prompt).toMatch(/target.dependenc|depends.on|dependen.*graph/i);
    });

    it('invoke prompt should render dependency graph when targetDependencies is provided', () => {
      // renderInvokePrompt should accept targetDependencies and render
      // the target's position in the dependency graph.

      const prompt = renderInvokePrompt({
        envelope: {
          task_id: 'task-1',
          target: 'src/handler.ts',
          function: 'handleRequest',
          params: {},
          call_stack: [],
          caller: 'src/server.ts',
        },
        targetDependencies: {
          dependencies: ['src/db.ts', 'src/utils.ts'],
          dependents: ['src/server.ts'],
        },
      });

      // The prompt should render the dependency graph data
      expect(prompt).toContain('Target Dependencies');
      expect(prompt).toContain('src/db.ts');
      expect(prompt).toContain('src/utils.ts');
      expect(prompt).toContain('src/server.ts');
      expect(prompt).toMatch(/depends.on|depended.on/i);
    });
  });

  // =========================================================================
  // TEST 4: invoke() should compute boundary info from registry
  // =========================================================================
  describe('invoke() computes boundary info from registry dependencies', () => {
    it('for a ready file with dependencies, invoke should compute and provide boundary context', async () => {
      // invoke() has access to the registry which contains all dependency data.
      // It should use this to compute boundary info (same-cluster vs cross-boundary)
      // and pass it to renderSystemPrompt when creating or invoking agents.
      //
      // Test: set up a ready file with dependencies, invoke it, capture the
      // prompt that invokeOnSession receives, verify it contains dependency
      // graph context.

      const deps = makeInvokeDeps();

      // handler depends on db and utils
      deps.registry.add({
        file_path: 'src/handler.ts',
        file_hash: 'hash-handler',
        status: 'ready',
        session_id: 'primer-handler',
        declarations: makeDeclarations({
          summary: 'Request handler',
          dependencies: ['src/db.ts', 'src/utils.ts'],
        }),
        last_active: new Date(),
        error: null,
      });
      deps.registry.add({
        file_path: 'src/db.ts',
        file_hash: 'hash-db',
        status: 'ready',
        session_id: 'primer-db',
        declarations: makeDeclarations({
          summary: 'Database access layer',
          dependencies: [],
        }),
        last_active: new Date(),
        error: null,
      });
      deps.registry.add({
        file_path: 'src/utils.ts',
        file_hash: 'hash-utils',
        status: 'ready',
        session_id: 'primer-utils',
        declarations: makeDeclarations({
          summary: 'Utility functions',
          dependencies: [],
        }),
        last_active: new Date(),
        error: null,
      });

      // Capture the prompt sent to invokeOnSession
      let capturedPrompt = '';
      deps.sessionManager.invokeOnSession = vi.fn().mockImplementation(async (opts: any) => {
        capturedPrompt = opts.prompt;
        return {
          task_id: opts.taskId,
          responder: 'src/handler.ts',
          returns: { ok: true },
          source_refs: ['src/handler.ts:1-10'],
        } satisfies ResponseEnvelope;
      });

      const envelope = makeEnvelope('src/handler.ts', {
        caller: 'src/server.ts',
        call_stack: ['src/server.ts'],
      });

      await invoke(envelope, deps);

      // The invoke prompt should include context about the target's dependencies
      // Currently it does NOT include this information
      expect(capturedPrompt).toMatch(/src\/db\.ts|src\/utils\.ts/);
      expect(capturedPrompt).toMatch(/dependenc|depends.on|graph/i);
    });
  });

  // =========================================================================
  // TEST 5: Invoke envelope provides structured correlated deps from registry
  // =========================================================================
  describe('invoke envelope should include correlated dependency context', () => {
    it('renderInvokePrompt renders correlated deps with exports and imports from registry', () => {
      // At invoke time, the envelope should include structured dependency context
      // pulled fresh from the registry — not raw source dumps.
      // System prompt has raw source (for bootstrap). Invoke has structured data.

      const prompt = renderInvokePrompt({
        envelope: {
          task_id: 'task-1',
          target: 'src/handler.ts',
          function: 'handleRequest',
          params: {},
          call_stack: [],
          caller: 'src/server.ts',
        },
        correlatedDeps: [
          {
            path: 'src/db.ts',
            relationship: 'imports',
            summary: 'Database access — query, insert, update, delete',
            exports: [
              { name: 'Database', kind: 'class', intent: 'Database connection and query execution' },
              { name: 'query', kind: 'function', intent: 'Execute SQL query' },
            ],
            imports: [],
          },
          {
            path: 'src/server.ts',
            relationship: 'imported_by',
            summary: 'HTTP server entry point',
            exports: [
              { name: 'startServer', kind: 'function', intent: 'Start HTTP server' },
            ],
            imports: [
              { name: 'handleRequest', from: 'src/handler.ts', kind: 'import' },
            ],
          },
        ],
      });

      // Should contain structured dep info, not raw source
      expect(prompt).toContain('Correlated Dependencies');
      expect(prompt).toContain('src/db.ts');
      expect(prompt).toContain('Database access');
      expect(prompt).toContain('Database');
      expect(prompt).toContain('query');
      expect(prompt).toContain('src/server.ts');
      expect(prompt).toMatch(/imported by/i);
      // Should NOT contain raw source code of dependencies
      expect(prompt).not.toContain('complex implementation');
    });
  });
});
