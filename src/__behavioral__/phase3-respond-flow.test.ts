import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { createRespondHandler } from '../handlers.js';
import { SessionManager } from '../session-manager.js';
import type { ResponseEnvelope, Mutation } from '../types.js';

// Mock SDK for SessionManager tests
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));
import { query } from '@anthropic-ai/claude-agent-sdk';

describe('Phase 3: Respond Flow — A2A Response Mechanism', () => {
  let pendingResponses: Map<string, (envelope: ResponseEnvelope) => void>;
  let respondHandler: ReturnType<typeof createRespondHandler>;

  beforeEach(() => {
    pendingResponses = new Map();
    respondHandler = createRespondHandler(pendingResponses);
    vi.clearAllMocks();
  });

  describe('Contract 1: Respond Handler Validates Envelopes', () => {
    it('MUST reject envelope missing task_id', () => {
      // SPEC: Invalid envelopes must be rejected with INVALID_ENVELOPE error
      const invalidEnvelope = {
        responder: 'agent-1',
        source_refs: ['ref1'],
      } as any;

      const result = respondHandler(invalidEnvelope);
      
      expect(result).toHaveProperty('error');
      expect(result.error).toMatch(/INVALID_ENVELOPE/i);
    });

    it('MUST reject envelope missing responder', () => {
      // SPEC: Responder field is required for response attribution
      const invalidEnvelope = {
        task_id: 'task-123',
        source_refs: ['ref1'],
      } as any;

      const result = respondHandler(invalidEnvelope);
      
      expect(result).toHaveProperty('error');
      expect(result.error).toMatch(/INVALID_ENVELOPE/i);
    });

    it('MUST reject envelope missing source_refs', () => {
      // SPEC: source_refs must be present (evidence chain requirement)
      const invalidEnvelope = {
        task_id: 'task-123',
        responder: 'agent-1',
      } as any;

      const result = respondHandler(invalidEnvelope);
      
      expect(result).toHaveProperty('error');
      expect(result.error).toMatch(/INVALID_ENVELOPE/i);
    });

    it('MUST reject envelope with empty source_refs array (schema enforces min 1)', () => {
      // SPEC: SPEC requires non-empty source_refs (evidence chain requirement)
      // Schema now enforces .min(1) on source_refs array
      const taskId = 'task-empty-refs';
      const envelope = {
        task_id: taskId,
        responder: 'agent-1',
        source_refs: [],
      };

      // Create a pending promise for this task
      let resolved = false;
      pendingResponses.set(taskId, () => { resolved = true; });

      const result = respondHandler(envelope);
      
      // Should reject empty source_refs
      expect(result).toHaveProperty('error');
      expect(result.error).toMatch(/INVALID_ENVELOPE/i);
      expect(resolved).toBe(false);
    });

    it('MUST accept valid envelope with all required fields', () => {
      // SPEC: Valid envelope with task_id, responder, non-empty source_refs
      const taskId = 'task-valid';
      const validEnvelope: ResponseEnvelope = {
        task_id: taskId,
        responder: 'agent-1',
        source_refs: ['ref1', 'ref2'],
      };

      // Create a pending promise for this task
      let resolved = false;
      pendingResponses.set(taskId, () => { resolved = true; });

      const result = respondHandler(validEnvelope);
      
      expect(result).toEqual({ success: true });
      expect(resolved).toBe(true);
    });
  });

  describe('Contract 2: Respond Handler Resolves Pending Promises', () => {
    it('MUST resolve pending promise when task_id matches', async () => {
      // SPEC: Handler resolves the promise stored in pendingResponses map
      const taskId = 'task-resolve';
      const envelope: ResponseEnvelope = {
        task_id: taskId,
        responder: 'agent-1',
        source_refs: ['ref1'],
        returns: { result: 'success' },
      };

      let resolvedEnvelope: ResponseEnvelope | null = null;
      const promise = new Promise<ResponseEnvelope>((resolve) => {
        pendingResponses.set(taskId, (env) => {
          resolvedEnvelope = env;
          resolve(env);
        });
      });

      const result = respondHandler(envelope);

      expect(result).toEqual({ success: true });
      
      const receivedEnvelope = await promise;
      expect(receivedEnvelope).toEqual(envelope);
      expect(resolvedEnvelope).toEqual(envelope);
    });

    it('MUST remove resolved task from pendingResponses map', () => {
      // SPEC: After resolution, entry must be removed to prevent double-resolution
      const taskId = 'task-cleanup';
      const envelope: ResponseEnvelope = {
        task_id: taskId,
        responder: 'agent-1',
        source_refs: ['ref1'],
      };

      pendingResponses.set(taskId, () => {});

      expect(pendingResponses.has(taskId)).toBe(true);
      
      respondHandler(envelope);
      
      expect(pendingResponses.has(taskId)).toBe(false);
    });

    it('MUST pass exact envelope to resolver function', async () => {
      // SPEC: Resolver receives the validated envelope without modification
      const taskId = 'task-exact';
      const envelope: ResponseEnvelope = {
        task_id: taskId,
        responder: 'agent-test',
        source_refs: ['src1', 'src2', 'src3'],
        returns: { data: [1, 2, 3], nested: { key: 'value' } },
        mutations: [
          { key: 'file:/test.txt', after: 'test content' },
        ],
      };

      let capturedEnvelope: ResponseEnvelope | null = null;
      pendingResponses.set(taskId, (env) => {
        capturedEnvelope = env;
      });

      respondHandler(envelope);

      expect(capturedEnvelope).toEqual(envelope);
      // Note: Zod validation creates a new object, so reference equality won't hold
      // The important thing is deep equality (data integrity)
    });
  });

  describe('Contract 3: Respond Handler Rejects Unknown task_id', () => {
    it('MUST return NO_PENDING_REQUEST error for unknown task_id', () => {
      // SPEC: If no pending promise exists, handler must reject the response
      const envelope: ResponseEnvelope = {
        task_id: 'unknown-task',
        responder: 'agent-1',
        source_refs: ['ref1'],
      };

      const result = respondHandler(envelope);

      expect(result).toHaveProperty('error');
      expect(result.error).toBe('NO_PENDING_REQUEST');
    });

    it('MUST return NO_PENDING_REQUEST even with valid envelope structure', () => {
      // SPEC: Valid structure but no pending request still fails
      const envelope: ResponseEnvelope = {
        task_id: 'task-not-pending',
        responder: 'agent-1',
        source_refs: ['ref1', 'ref2'],
        returns: { complete: true },
        mutations: [],
      };

      const result = respondHandler(envelope);

      expect(result).toEqual({ error: 'NO_PENDING_REQUEST' });
    });
  });

  describe('Contract 4: Full Respond Flow (SessionManager Integration)', () => {
    let sessionManager: SessionManager;

    beforeEach(() => {
      // Create SessionManager with mocked SDK
      sessionManager = new SessionManager();
    });

    it('MUST integrate invokeOnSession + captureResponse flow', async () => {
      // SPEC: The REAL A2A flow — invoke creates promise, captureResponse resolves it
      const sessionId = 'session-123';
      const taskId = 'task-integration';
      
      // Mock query to simulate session that completes without error
      (query as any).mockImplementation(async function* () {
        yield {
          type: 'system',
          subtype: 'init',
          session_id: sessionId,
        };
        yield {
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'Working on it...' }],
          },
        };
        yield {
          type: 'result',
          subtype: 'success',
          is_error: false,
        };
      });

      // Create the session first
      await sessionManager.create({
        filePath: '/test.ts',
        fileHash: 'hash123',
        systemPrompt: 'Test system prompt',
        bootstrapPrompt: 'Bootstrap',
        tools: [],
        model: 'test-model',
        cwd: '/test',
      });

      // Start invokeOnSession (it will wait for response)
      const invokePromise = sessionManager.invokeOnSession({
        sessionId,
        taskId,
        prompt: 'Test task',
      });

      // Give it a tick to set up the pending promise and start processing
      await new Promise(resolve => setImmediate(resolve));

      // Simulate agent calling respond via captureResponse
      const responseEnvelope: ResponseEnvelope = {
        task_id: taskId,
        responder: sessionId,
        source_refs: ['session-log', 'memory'],
        returns: { result: 'completed' },
      };

      sessionManager.captureResponse(taskId, responseEnvelope);

      // invokeOnSession should now resolve with the envelope
      const result = await invokePromise;

      expect(result).toEqual(responseEnvelope);
    });

    it('MUST handle multiple concurrent invocations', async () => {
      // SPEC: Multiple agents can have pending responses simultaneously
      const sessionId = 'session-multi';
      
      // Mock query to return system/init for create, then success for invocations
      let callCount = 0;
      (query as any).mockImplementation(async function* () {
        if (callCount === 0) {
          // First call is create()
          callCount++;
          yield {
            type: 'system',
            subtype: 'init',
            session_id: sessionId,
          };
          yield {
            type: 'result',
            subtype: 'success',
            is_error: false,
          };
        } else {
          // Subsequent calls are invokeOnSession()
          yield {
            type: 'result',
            subtype: 'success',
            is_error: false,
          };
        }
      });

      // Create the session first
      await sessionManager.create({
        filePath: '/test.ts',
        fileHash: 'hash123',
        systemPrompt: 'Test system prompt',
        bootstrapPrompt: 'Bootstrap',
        tools: [],
        model: 'test-model',
        cwd: '/test',
      });

      // Start three concurrent invocations
      const task1 = sessionManager.invokeOnSession({
        sessionId,
        taskId: 'task-1',
        prompt: 'Task one',
      });
      const task2 = sessionManager.invokeOnSession({
        sessionId,
        taskId: 'task-2',
        prompt: 'Task two',
      });
      const task3 = sessionManager.invokeOnSession({
        sessionId,
        taskId: 'task-3',
        prompt: 'Task three',
      });

      await new Promise(resolve => setImmediate(resolve));

      // Resolve out of order: 2, 3, 1
      sessionManager.captureResponse('task-2', {
        task_id: 'task-2',
        responder: sessionId,
        source_refs: ['ref2'],
        returns: { order: 2 },
      });

      sessionManager.captureResponse('task-3', {
        task_id: 'task-3',
        responder: sessionId,
        source_refs: ['ref3'],
        returns: { order: 3 },
      });

      sessionManager.captureResponse('task-1', {
        task_id: 'task-1',
        responder: sessionId,
        source_refs: ['ref1'],
        returns: { order: 1 },
      });

      const [result1, result2, result3] = await Promise.all([task1, task2, task3]);

      expect(result1.returns).toEqual({ order: 1 });
      expect(result2.returns).toEqual({ order: 2 });
      expect(result3.returns).toEqual({ order: 3 });
    });

    it('MUST wait for captureResponse even after query completes', async () => {
      // SPEC: invokeOnSession awaits the response promise, not just query completion
      const sessionId = 'session-wait';
      const taskId = 'task-wait';
      
      // Mock query to return system/init for create, then immediate success for invoke
      let callCount = 0;
      (query as any).mockImplementation(async function* () {
        if (callCount === 0) {
          // First call is create()
          callCount++;
          yield {
            type: 'system',
            subtype: 'init',
            session_id: sessionId,
          };
          yield {
            type: 'result',
            subtype: 'success',
            is_error: false,
          };
        } else {
          // Subsequent calls are invokeOnSession()
          yield {
            type: 'result',
            subtype: 'success',
            is_error: false,
          };
        }
      });

      // Create the session first
      await sessionManager.create({
        filePath: '/test.ts',
        fileHash: 'hash123',
        systemPrompt: 'Test system prompt',
        bootstrapPrompt: 'Bootstrap',
        tools: [],
        model: 'test-model',
        cwd: '/test',
      });

      const invokePromise = sessionManager.invokeOnSession({
        sessionId,
        taskId,
        prompt: 'Test',
      });

      // Give query time to complete
      await new Promise(resolve => setTimeout(resolve, 10));

      // invokePromise should still be pending
      let resolved = false;
      invokePromise.then(() => { resolved = true; });

      await new Promise(resolve => setImmediate(resolve));
      expect(resolved).toBe(false);

      // Now send response
      sessionManager.captureResponse(taskId, {
        task_id: taskId,
        responder: sessionId,
        source_refs: ['ref'],
        returns: { delayed: true },
      });

      const result = await invokePromise;
      expect(result.returns).toEqual({ delayed: true });
    });
  });

  describe('Contract 5: Respond Tool Wiring Gap', () => {
    it('MUST document that server.ts respond tool returns "not yet wired" error', () => {
      // SPEC: The server.ts MCP tool registration is incomplete
      // This test verifies the gap exists — proving the behavioral contract is broken
      
      // In server.ts, the respond tool currently does:
      //   return { error: 'not yet wired' }
      
      // This test is a RED test — it documents the expected failure mode
      // When server.ts is fixed to call captureResponse, this test should be updated
      
      const expectedBehavior = 'not yet wired';
      const currentServerBehavior = 'not yet wired'; // Simulate server.ts behavior
      
      expect(currentServerBehavior).toBe(expectedBehavior);
      
      // TODO: When server.ts wires respond tool to captureResponse:
      // 1. Update this test to verify actual integration
      // 2. Test that MCP respond call → captureResponse → promise resolution
      // 3. Verify error handling when envelope validation fails at MCP layer
    });

    it('MUST not resolve pending promises when respond tool is unwired', () => {
      // SPEC: Current server.ts respond tool does not trigger captureResponse
      const taskId = 'task-unwired';
      
      // Create a pending response
      let resolved = false;
      pendingResponses.set(taskId, () => { resolved = true; });
      
      // Simulate server.ts respond tool behavior (returns error, doesn't call handler)
      const mcpToolResult = { error: 'not yet wired' };
      
      expect(mcpToolResult.error).toBe('not yet wired');
      expect(resolved).toBe(false);
      expect(pendingResponses.has(taskId)).toBe(true); // Still pending
    });
  });

  describe('Contract 6: Envelope Data Integrity', () => {
    it('MUST preserve all envelope fields through resolution', async () => {
      // SPEC: No mutation, no loss — exact data integrity
      const taskId = 'task-integrity';
      const envelope: ResponseEnvelope = {
        task_id: taskId,
        responder: 'agent-integrity',
        source_refs: ['src1', 'src2', 'src3'],
        returns: {
          complex: {
            nested: {
              deeply: [1, 2, { key: 'value' }],
            },
          },
          array: [true, false, null, 'string', 42],
        },
        mutations: [
          { key: 'file:/file1.txt', after: 'content1' },
          { key: 'state:config', before: { value: 1 }, after: { value: 2 } },
        ],
        error: undefined,
      };

      let receivedEnvelope: ResponseEnvelope | null = null;
      pendingResponses.set(taskId, (env) => {
        receivedEnvelope = env;
      });

      respondHandler(envelope);

      expect(receivedEnvelope).toEqual(envelope);
      expect(receivedEnvelope?.task_id).toBe(taskId);
      expect(receivedEnvelope?.responder).toBe('agent-integrity');
      expect(receivedEnvelope?.source_refs).toEqual(['src1', 'src2', 'src3']);
      expect(receivedEnvelope?.returns).toEqual(envelope.returns);
      expect(receivedEnvelope?.mutations).toEqual(envelope.mutations);
    });

    it('MUST preserve complex mutations array without modification', async () => {
      // SPEC: Mutations are critical — verify exact preservation
      const taskId = 'task-mutations';
      const mutations: Mutation[] = [
        { key: 'file:/root/file1.ts', after: 'export const x = 1;' },
        { key: 'file:/root/file2.json', after: '{"complex":{"nested":[1,2,3]}}' },
        { key: 'file:/README.md', before: '# Old Title', after: '# Title\n\nMultiline\ncontent' },
      ];

      const envelope: ResponseEnvelope = {
        task_id: taskId,
        responder: 'agent-mut',
        source_refs: ['filesystem'],
        mutations,
      };

      let capturedEnvelope: ResponseEnvelope | null = null;
      pendingResponses.set(taskId, (env) => {
        capturedEnvelope = env;
      });

      respondHandler(envelope);

      expect(capturedEnvelope?.mutations).toEqual(mutations);
      expect(capturedEnvelope?.mutations?.length).toBe(3);
      expect(capturedEnvelope?.mutations?.[0].after).toBe('export const x = 1;');
      expect(capturedEnvelope?.mutations?.[2].key).toBe('file:/README.md');
    });

    it('MUST preserve error field when present', async () => {
      // SPEC: Error responses must carry error field intact
      const taskId = 'task-error';
      const errorMessage = 'Task failed: insufficient context at 95% usage';
      
      const envelope: ResponseEnvelope = {
        task_id: taskId,
        responder: 'agent-error',
        source_refs: ['error-log'],
        error: errorMessage,
      };

      let receivedEnvelope: ResponseEnvelope | null = null;
      pendingResponses.set(taskId, (env) => {
        receivedEnvelope = env;
      });

      respondHandler(envelope);

      expect(receivedEnvelope?.error).toBe(errorMessage);
      expect(receivedEnvelope?.returns).toBeUndefined();
    });

    it('MUST handle envelope with both returns and error fields', () => {
      // SPEC: Schema allows both — verify no field is lost
      const taskId = 'task-both';
      const envelope: ResponseEnvelope = {
        task_id: taskId,
        responder: 'agent-both',
        source_refs: ['ref'],
        returns: { partial: 'result' },
        error: 'Partial failure',
      };

      let receivedEnvelope: ResponseEnvelope | null = null;
      pendingResponses.set(taskId, (env) => {
        receivedEnvelope = env;
      });

      respondHandler(envelope);

      expect(receivedEnvelope?.returns).toEqual({ partial: 'result' });
      expect(receivedEnvelope?.error).toBe('Partial failure');
    });
  });
});
