/**
 * RED Tests: Envelope & Contract Protocol (#2)
 *
 * Documents broken envelope/contract behavior in the trace flow.
 * These tests specify CORRECT behavior that currently FAILS.
 *
 * Core problems:
 * - createTraceHandler builds envelope with `function: '__entry__'` — a synthetic
 *   function that doesn't exist in any source file
 * - renderInvokePrompt tells the agent to "Locate the function `__entry__`" —
 *   the agent will search its code, find nothing, and hallucinate
 * - The scenario (the actual analytical task) is buried in params, not prominently
 *   presented as the agent's primary directive
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
import { RateLimitTracker, SelfLoopTracker } from '../invoke.js';
import { createTraceHandler, type TraceDeps } from '../mcp-external.js';
import { SyntheticState } from '../handlers.js';
import { renderInvokePrompt } from '../templates.js';
import type { InvokeEnvelope, Declarations } from '../types.js';

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

/**
 * Build TraceDeps with an invoke mock that captures the envelope.
 * The invoke mock stores every envelope it receives for later assertion.
 */
function makeTraceDeps(overrides: Partial<TraceDeps> = {}): TraceDeps & { capturedEnvelopes: InvokeEnvelope[] } {
  const capturedEnvelopes: InvokeEnvelope[] = [];
  return {
    registry: new Registry(),
    sessionManager: new SessionManager(),
    traceLog: new TraceLog(),
    syntheticState: new SyntheticState(),
    rateLimitTracker: new RateLimitTracker(),
    selfLoopTracker: new SelfLoopTracker(),
    readFile: vi.fn().mockResolvedValue('export function handleRequest() { return "ok"; }'),
    projectDir: '/test-project',
    invoke: vi.fn().mockImplementation(async (envelope: InvokeEnvelope) => {
      capturedEnvelopes.push({ ...envelope });
      return {
        task_id: envelope.task_id,
        responder: envelope.target,
        returns: { ok: true },
        source_refs: [`${envelope.target}:1-10`],
      };
    }),
    capturedEnvelopes,
    ...overrides,
  };
}

describe('Envelope & Contract Protocol — RED Tests', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // =========================================================================
  // TEST 1: Initial envelope must NOT use `function: '__entry__'`
  // =========================================================================
  describe('[MUST-PASS-AT-TRACE-V2] Initial trace envelope function field', () => {
    it('should NOT use __entry__ as the function name — it is a synthetic marker that does not exist in any source file', async () => {
      // BUG: mcp-external.ts L91 builds the initial envelope with:
      //   function: '__entry__'
      // This is a fake function name. The invoke prompt then tells the agent
      // to "Locate the function `__entry__`" in its source code. The agent
      // searches for __entry__, finds nothing, and hallucinates.
      //
      // EXPECTED: The function field should reference something real —
      // either a detected entry function from the target's declarations,
      // or a scenario-derived descriptor. NOT a synthetic marker.

      const deps = makeTraceDeps();

      // Register a ready file with known declarations (has a real function)
      deps.registry.add({
        file_path: 'src/auth.ts',
        file_hash: 'hash-auth',
        status: 'ready',
        session_id: 'session-auth',
        declarations: makeDeclarations({
          summary: 'Authentication and login handling',
          owns: [
            { name: 'login', kind: 'function', intent: 'authenticate user with credentials', file_path: 'src/auth.ts', start_line: 1, end_line: 20 },
            { name: 'logout', kind: 'function', intent: 'terminate user session', file_path: 'src/auth.ts', start_line: 22, end_line: 35 },
          ],
        }),
        last_active: new Date(),
        error: null,
      });

      const traceHandler = createTraceHandler(deps);
      await traceHandler({
        scenario: 'user attempts to login with valid credentials',
        entry_point: 'src/auth.ts',
      });

      // The invoke mock captured the envelope
      expect(deps.capturedEnvelopes).toHaveLength(1);
      const envelope = deps.capturedEnvelopes[0];

      // The function field must NOT be '__entry__'
      // It should reference something real from the target's declarations
      // or be derived from the scenario
      expect(envelope.function).not.toBe('__entry__');
    });

    it('should derive the function field from the entry point declarations when a matching function exists', async () => {
      // When the scenario mentions "login" and the entry point has a function
      // named "login", the envelope should use "login" as the function.
      // Not __entry__. The agent needs to know WHAT to analyze.

      const deps = makeTraceDeps();

      deps.registry.add({
        file_path: 'src/auth.ts',
        file_hash: 'hash-auth',
        status: 'ready',
        session_id: 'session-auth',
        declarations: makeDeclarations({
          summary: 'Authentication and login handling',
          owns: [
            { name: 'login', kind: 'function', intent: 'authenticate user with credentials', file_path: 'src/auth.ts', start_line: 1, end_line: 20 },
            { name: 'logout', kind: 'function', intent: 'terminate user session', file_path: 'src/auth.ts', start_line: 22, end_line: 35 },
          ],
        }),
        last_active: new Date(),
        error: null,
      });

      const traceHandler = createTraceHandler(deps);
      await traceHandler({
        scenario: 'user attempts to login with valid credentials',
        entry_point: 'src/auth.ts',
      });

      expect(deps.capturedEnvelopes).toHaveLength(1);
      const envelope = deps.capturedEnvelopes[0];

      // The function should be intelligently derived — scenario says "login",
      // entry point declares "login" → function should be "login"
      expect(envelope.function).toBe('login');
    });
  });

  // =========================================================================
  // TEST 2: Scenario must be the primary analytical task, not buried in params
  // =========================================================================
  describe('[MUST-PASS-AT-TRACE-V2] Scenario prominence in envelope', () => {
    it('the scenario must be directly accessible in the envelope, not only nested in params', async () => {
      // BUG: mcp-external.ts L92 puts the scenario inside:
      //   params: { scenario: request.scenario }
      // The scenario IS already in `notes: request.scenario` (L93), but it's
      // also the only thing in params. The actual analytical task (the scenario)
      // should be a first-class field or the primary content of the envelope,
      // not hidden inside a generic params bag.
      //
      // EXPECTED: The envelope should carry the scenario as a first-class
      // field that the prompt renderer can use directly. The params should
      // contain actual function parameters, not the scenario.

      const deps = makeTraceDeps();

      deps.registry.add({
        file_path: 'src/server.ts',
        file_hash: 'hash-server',
        status: 'ready',
        session_id: 'session-server',
        declarations: makeDeclarations({
          summary: 'HTTP server entry point',
          owns: [{ name: 'startServer', kind: 'function', intent: 'start the HTTP server', file_path: 'src/server.ts', start_line: 1, end_line: 30 }],
        }),
        last_active: new Date(),
        error: null,
      });

      const traceHandler = createTraceHandler(deps);
      await traceHandler({
        scenario: 'process an incoming payment request',
        entry_point: 'src/server.ts',
      });

      expect(deps.capturedEnvelopes).toHaveLength(1);
      const envelope = deps.capturedEnvelopes[0];

      // The scenario should NOT be the only thing in params.
      // params: { scenario: '...' } is wrong — that's stuffing the analytical
      // task into a field meant for function parameters.
      if (envelope.params && typeof envelope.params === 'object') {
        const params = envelope.params as Record<string, unknown>;
        expect(params).not.toHaveProperty('scenario');
      }
    });
  });

  // =========================================================================
  // TEST 3: renderInvokePrompt must NOT tell agent to "locate __entry__"
  // =========================================================================
  describe('[MUST-PASS-AT-TRACE-V2] Invoke prompt does not reference synthetic function names', () => {
    it('should NOT produce "Locate the function `__entry__`" in the prompt', () => {
      // BUG: renderInvokePrompt generates:
      //   "# Trace Task: Analyze `__entry__`"
      //   "1. **Locate** the function `__entry__` in your source code."
      //
      // The agent then tries to find __entry__ in its source, finds nothing,
      // and either hallucinates or produces garbage analysis.
      //
      // EXPECTED: When the caller is __trace_initiator__, the prompt should
      // present the SCENARIO as the analytical task, not ask the agent to
      // locate a non-existent function.

      const prompt = renderInvokePrompt({
        envelope: {
          function: '__entry__',
          params: { scenario: 'user attempts to login' },
          call_stack: [],
          caller: '__trace_initiator__',
        },
      });

      // The prompt must NOT contain instructions to locate __entry__
      expect(prompt).not.toContain('Locate the function `__entry__`');
      expect(prompt).not.toContain('Analyze `__entry__`');
    });

    it('when caller is __trace_initiator__, prompt should present the scenario as the primary task', () => {
      // The initial trace call comes from __trace_initiator__. The agent
      // should be told to analyze the SCENARIO, not locate a function.
      // The scenario should be prominent in the prompt.

      const scenario = 'user attempts to login with invalid credentials';

      const prompt = renderInvokePrompt({
        envelope: {
          function: '__entry__',
          params: { scenario },
          call_stack: [],
          caller: '__trace_initiator__',
        },
      });

      // The scenario text must appear prominently in the prompt
      // Not buried in a JSON params block, but as the analytical directive
      expect(prompt).toContain(scenario);

      // And it should NOT be only inside a ```json code block (params dump)
      // It should appear in the prose instructions as the task description
      const jsonBlockPattern = /```json\s*\n[^`]*user attempts to login[^`]*\n```/;
      const scenarioOutsideJson = prompt.replace(jsonBlockPattern, '').includes(scenario);
      expect(scenarioOutsideJson).toBe(true);
    });

    it('for non-initiator calls (agent-to-agent), function name should be used normally', () => {
      // Agent-to-agent invocations (caller is a real file, not __trace_initiator__)
      // have real function names. Those should still be rendered normally.
      // This test ensures we don't break the normal invoke path.

      const prompt = renderInvokePrompt({
        envelope: {
          function: 'processPayment',
          params: { amount: 100 },
          call_stack: ['src/server.ts'],
          caller: 'src/server.ts',
        },
      });

      // For real function names, the normal "locate function" instruction is correct
      expect(prompt).toContain('processPayment');
      // The prompt template uses markdown bold: "**Locate** the function `X`"
      expect(prompt).toContain('**Locate** the function `processPayment`');
    });
  });

  // =========================================================================
  // TEST 4: Full flow — trace handler → invoke → prompt chain coherence
  // =========================================================================
  describe('[MUST-PASS-AT-TRACE-V2] Trace handler → invoke → prompt contract coherence', () => {
    it('the entire chain from TraceRequest to agent prompt should not reference __entry__', async () => {
      // End-to-end test: create a trace handler, run a trace, capture the
      // envelope, render the invoke prompt from that envelope, and verify
      // __entry__ never appears at any stage.

      const deps = makeTraceDeps();

      deps.registry.add({
        file_path: 'src/payments.ts',
        file_hash: 'hash-payments',
        status: 'ready',
        session_id: 'session-payments',
        declarations: makeDeclarations({
          summary: 'Payment processing module',
          owns: [
            { name: 'processPayment', kind: 'function', intent: 'process a payment transaction', file_path: 'src/payments.ts', start_line: 1, end_line: 50 },
            { name: 'refundPayment', kind: 'function', intent: 'issue a refund for a payment', file_path: 'src/payments.ts', start_line: 52, end_line: 80 },
          ],
        }),
        last_active: new Date(),
        error: null,
      });

      const traceHandler = createTraceHandler(deps);
      await traceHandler({
        scenario: 'process a payment of $100',
        entry_point: 'src/payments.ts',
      });

      expect(deps.capturedEnvelopes).toHaveLength(1);
      const envelope = deps.capturedEnvelopes[0];

      // Render the prompt as the invoke handler would
      const prompt = renderInvokePrompt({
        envelope: {
          task_id: envelope.task_id,
          target: envelope.target,
          function: envelope.function,
          params: envelope.params,
          call_stack: envelope.call_stack,
          caller: envelope.caller,
          expected_output: envelope.expected_output,
        },
      });

      // __entry__ must not appear ANYWHERE in the chain
      expect(envelope.function).not.toBe('__entry__');
      expect(prompt).not.toContain('__entry__');

      // The scenario should be in the prompt
      expect(prompt).toContain('payment');
    });
  });
});
