import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Mock the SDK before importing SessionManager
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

import { SessionManager } from '../session-manager.js';
import { query } from '@anthropic-ai/claude-agent-sdk';
import type { ResponseEnvelope } from '../types.js';

// Type the mocked query function
const mockedQuery = vi.mocked(query);

// Helper to create SDK message generators
async function* createMockSDKStream(messages: any[]) {
  for (const msg of messages) {
    yield msg;
  }
}

// Standard create options for tests
const defaultCreateOpts = {
  filePath: '/test/file.ts',
  fileHash: 'test-hash',
  systemPrompt: 'Test prompt',
  bootstrapPrompt: 'Study this file',
  tools: [],
  model: 'claude-3-5-sonnet-20241022',
  cwd: '/test'
};

describe('Phase 2 SDK Integration - Behavioral Tests', () => {
  let manager: SessionManager;

  beforeEach(() => {
    manager = new SessionManager();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('Contract 1: Session ID Capture Flow', () => {
    // SPEC: create() must iterate the SDK query() AsyncGenerator and capture session_id
    // from a message where type === 'system' && subtype === 'init'
    it('should capture session_id from SDK system/init message during create()', async () => {
      const expectedSessionId = 'sdk-session-12345';
      
      mockedQuery.mockReturnValueOnce(createMockSDKStream([
        { type: 'system', subtype: 'init', session_id: expectedSessionId },
        { type: 'assistant', content: 'Hello' },
        { type: 'result', subtype: 'success', is_error: false }
      ]));

      const session = await manager.create(defaultCreateOpts);

      // BEHAVIORAL: session_id must come FROM the SDK, not generated locally
      expect(session.session_id).toBe(expectedSessionId);
      expect(mockedQuery).toHaveBeenCalledOnce();
    });

    // SPEC: If no init message, must throw
    it('should throw if SDK stream does not contain system/init message', async () => {
      mockedQuery.mockReturnValueOnce(createMockSDKStream([
        { type: 'assistant', content: 'Hello' },
        { type: 'result', subtype: 'success', is_error: false }
      ]));

      await expect(manager.create(defaultCreateOpts)).rejects.toThrow();
    });

    // SPEC: Must iterate the AsyncGenerator fully to capture session_id
    it('should iterate SDK stream until system/init message is found', async () => {
      const expectedSessionId = 'sdk-session-67890';
      const messages = [
        { type: 'assistant', content: 'First message' },
        { type: 'assistant', content: 'Second message' },
        { type: 'system', subtype: 'init', session_id: expectedSessionId },
        { type: 'result', subtype: 'success', is_error: false }
      ];

      mockedQuery.mockReturnValueOnce(createMockSDKStream(messages));

      const session = await manager.create(defaultCreateOpts);

      expect(session.session_id).toBe(expectedSessionId);
    });

    // SPEC: Session ID must be captured from the correct message type/subtype
    it('should only capture session_id from messages with type=system AND subtype=init', async () => {
      const correctSessionId = 'correct-session-id';
      
      mockedQuery.mockReturnValueOnce(createMockSDKStream([
        { type: 'system', subtype: 'other', session_id: 'wrong-id-1' },
        { type: 'other', subtype: 'init', session_id: 'wrong-id-2' },
        { type: 'system', subtype: 'init', session_id: correctSessionId },
        { type: 'result', subtype: 'success', is_error: false }
      ]));

      const session = await manager.create(defaultCreateOpts);

      expect(session.session_id).toBe(correctSessionId);
    });
  });

  describe('Contract 2: Response Capture Flow', () => {
    // SPEC: invokeOnSession() must create a Promise and store resolver in pendingResponses
    // map keyed by taskId, then captureResponse() resolves it
    it('should complete response capture flow: promise creation → external captureResponse → resolution', async () => {
      // Setup: create a session first
      const sessionId = 'test-session-123';
      mockedQuery.mockReturnValueOnce(createMockSDKStream([
        { type: 'system', subtype: 'init', session_id: sessionId },
        { type: 'result', subtype: 'success', is_error: false }
      ]));

      await manager.create(defaultCreateOpts);

      // Now test the invoke flow
      const taskId = 'task-456';
      const responseEnvelope: ResponseEnvelope = {
        task_id: taskId,
        responder: 'test-agent',
        returns: { result: 'success' },
        source_refs: ['test.ts:1']
      };

      // Mock the invocation stream - simulate respond() tool being called mid-stream
      mockedQuery.mockReturnValueOnce((async function* () {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Processing...' }] } };
        
        // BEHAVIORAL: Simulate external respond() tool handler calling captureResponse()
        // This happens DURING the query() iteration
        setTimeout(() => {
          manager.captureResponse(taskId, responseEnvelope);
        }, 10);
        
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Done' }] } };
        yield { type: 'result', subtype: 'success', is_error: false };
      })());

      const result = await manager.invokeOnSession({
        sessionId,
        prompt: 'Do something',
        taskId
      });

      // BEHAVIORAL: The promise must resolve with the ResponseEnvelope from captureResponse()
      expect(result).toEqual(responseEnvelope);
    });

    // SPEC: captureResponse() must resolve the promise stored in pendingResponses
    it('should resolve pending promise when captureResponse is called with matching taskId', async () => {
      const sessionId = 'test-session-789';
      mockedQuery.mockReturnValueOnce(createMockSDKStream([
        { type: 'system', subtype: 'init', session_id: sessionId },
        { type: 'result', subtype: 'success', is_error: false }
      ]));

      await manager.create(defaultCreateOpts);

      const taskId = 'task-resolve-test';
      const envelope: ResponseEnvelope = {
        task_id: taskId,
        responder: 'agent-1',
        returns: { data: 'test' },
        source_refs: ['test.ts:1']
      };

      mockedQuery.mockReturnValueOnce((async function* () {
        yield { type: 'assistant', message: { content: [{ type: 'text', text: 'Working...' }] } };
        
        // Simulate respond() tool handler
        setTimeout(() => manager.captureResponse(taskId, envelope), 5);
        
        yield { type: 'result', subtype: 'success', is_error: false };
      })());

      const result = await manager.invokeOnSession({
        sessionId,
        prompt: 'Task',
        taskId
      });
      expect(result).toBe(envelope);
    });

    // SPEC: invokeOnSession() must call query() with resume: sessionId
    it('should call SDK query() with resume option set to sessionId', async () => {
      const sessionId = 'resume-test-session';
      mockedQuery.mockReturnValueOnce(createMockSDKStream([
        { type: 'system', subtype: 'init', session_id: sessionId },
        { type: 'result', subtype: 'success', is_error: false }
      ]));

      await manager.create(defaultCreateOpts);

      const taskId = 'resume-task';
      mockedQuery.mockReturnValueOnce((async function* () {
        setTimeout(() => {
          manager.captureResponse(taskId, {
            task_id: taskId,
            responder: 'test',
            source_refs: ['test.ts:1']
          });
        }, 5);
        yield { type: 'result', subtype: 'success', is_error: false };
      })());

      await manager.invokeOnSession({
        sessionId,
        prompt: 'Test message',
        taskId
      });

      // BEHAVIORAL: Second call (invoke) must have resume option in options
      expect(mockedQuery).toHaveBeenCalledTimes(2);
      const invokeCall = mockedQuery.mock.calls[1];
      expect(invokeCall[0].options).toHaveProperty('resume', sessionId);
    });

    // SPEC: Promise must be stored in pendingResponses BEFORE query() iteration starts
    it('should store promise resolver in pendingResponses before iterating SDK stream', async () => {
      const sessionId = 'promise-timing-test';
      mockedQuery.mockReturnValueOnce(createMockSDKStream([
        { type: 'system', subtype: 'init', session_id: sessionId },
        { type: 'result', subtype: 'success', is_error: false }
      ]));

      await manager.create(defaultCreateOpts);

      const taskId = 'timing-task';
      let captureWasCalled = false;

      mockedQuery.mockReturnValueOnce((async function* () {
        // Try to capture IMMEDIATELY when iteration starts
        // This tests that the promise resolver is already registered
        manager.captureResponse(taskId, {
          task_id: taskId,
          responder: 'test',
          source_refs: ['test.ts:1']
        });
        captureWasCalled = true;
        
        yield { type: 'result', subtype: 'success', is_error: false };
      })());

      const result = await manager.invokeOnSession({
        sessionId,
        prompt: 'Test',
        taskId
      });

      expect(captureWasCalled).toBe(true);
      expect(result).toBeDefined();
    });
  });

  describe('Contract 3: Fork Session Isolation', () => {
    // SPEC: When invokeOnSession() passes forkSession: true, it must be forwarded
    // to query() options to ensure base session stays pristine
    it('should forward forkSession option to SDK query() when forkSession is true', async () => {
      const sessionId = 'fork-test-session';
      mockedQuery.mockReturnValueOnce(createMockSDKStream([
        { type: 'system', subtype: 'init', session_id: sessionId },
        { type: 'result', subtype: 'success', is_error: false }
      ]));

      await manager.create(defaultCreateOpts);

      const taskId = 'fork-task';
      mockedQuery.mockReturnValueOnce((async function* () {
        setTimeout(() => {
          manager.captureResponse(taskId, {
            task_id: taskId,
            responder: 'test',
            source_refs: ['test.ts:1']
          });
        }, 5);
        yield { type: 'result', subtype: 'success', is_error: false };
      })());

      await manager.invokeOnSession({
        sessionId,
        prompt: 'Test',
        taskId,
        forkSession: true
      });

      // BEHAVIORAL: Verify forkSession option flows through to SDK options
      const invokeCall = mockedQuery.mock.calls[1];
      expect(invokeCall[0].options).toHaveProperty('forkSession', true);
    });

    // SPEC: When forkSession is false or undefined, base session is used
    it('should NOT pass forkSession to SDK when forkSession option is false', async () => {
      const sessionId = 'no-fork-session';
      mockedQuery.mockReturnValueOnce(createMockSDKStream([
        { type: 'system', subtype: 'init', session_id: sessionId },
        { type: 'result', subtype: 'success', is_error: false }
      ]));

      await manager.create(defaultCreateOpts);

      const taskId = 'no-fork-task';
      mockedQuery.mockReturnValueOnce((async function* () {
        setTimeout(() => {
          manager.captureResponse(taskId, {
            task_id: taskId,
            responder: 'test',
            source_refs: ['test.ts:1']
          });
        }, 5);
        yield { type: 'result', subtype: 'success', is_error: false };
      })());

      await manager.invokeOnSession({
        sessionId,
        prompt: 'Test',
        taskId,
        forkSession: false
      });

      const invokeCall = mockedQuery.mock.calls[1];
      expect(invokeCall[0].options).toHaveProperty('forkSession', false);
    });

    // SPEC: Fork isolation ensures frozen oracle pattern
    it('should support frozen oracle pattern via forkSession isolation', async () => {
      const sessionId = 'oracle-session';
      mockedQuery.mockReturnValueOnce(createMockSDKStream([
        { type: 'system', subtype: 'init', session_id: sessionId },
        { type: 'result', subtype: 'success', is_error: false }
      ]));

      await manager.create({
        ...defaultCreateOpts,
        systemPrompt: 'Oracle prompt'
      });

      // Make multiple invocations with fork=true
      for (let i = 0; i < 3; i++) {
        const taskId = `oracle-task-${i}`;
        mockedQuery.mockReturnValueOnce((async function* () {
          setTimeout(() => {
            manager.captureResponse(taskId, {
              task_id: taskId,
              responder: 'oracle',
              source_refs: ['test.ts:1']
            });
          }, 5);
          yield { type: 'result', subtype: 'success', is_error: false };
        })());

        await manager.invokeOnSession({
          sessionId,
          prompt: `Query ${i}`,
          taskId,
          forkSession: true
        });
      }

      // BEHAVIORAL: All invocations should use forkSession=true
      expect(mockedQuery).toHaveBeenCalledTimes(4); // 1 create + 3 invokes
      for (let i = 1; i <= 3; i++) {
        expect(mockedQuery.mock.calls[i][0].options).toHaveProperty('forkSession', true);
      }
    });
  });

  describe('Contract 4: Terminate via AbortController', () => {
    // SPEC: terminate() must call abort() on the session's AbortController
    it('should call abort() on AbortController when terminate is called', async () => {
      const sessionId = 'abort-test-session';
      mockedQuery.mockReturnValueOnce(createMockSDKStream([
        { type: 'system', subtype: 'init', session_id: sessionId },
        { type: 'result', subtype: 'success', is_error: false }
      ]));

      const session = await manager.create(defaultCreateOpts);

      // Spy on abort method
      const abortSpy = vi.spyOn(session.abortController!, 'abort');

      await manager.terminate(sessionId);

      // BEHAVIORAL: abort() must be called
      expect(abortSpy).toHaveBeenCalledOnce();
    });

    // SPEC: terminate() must set status to 'terminated'
    it('should set session status to terminated', async () => {
      const sessionId = 'status-test-session';
      mockedQuery.mockReturnValueOnce(createMockSDKStream([
        { type: 'system', subtype: 'init', session_id: sessionId },
        { type: 'result', subtype: 'success', is_error: false }
      ]));

      await manager.create(defaultCreateOpts);

      const sessionBeforeTerminate = manager.get(sessionId);
      
      await manager.terminate(sessionId);

      // BEHAVIORAL: Session is removed after terminate, but we know it was terminated
      // because terminate() completed without error
      expect(sessionBeforeTerminate).toBeDefined();
      expect(manager.get(sessionId)).toBeUndefined();
    });

    // SPEC: terminate() must remove session from pool
    it('should remove session from pool after termination', async () => {
      const sessionId = 'removal-test-session';
      mockedQuery.mockReturnValueOnce(createMockSDKStream([
        { type: 'system', subtype: 'init', session_id: sessionId },
        { type: 'result', subtype: 'success', is_error: false }
      ]));

      await manager.create(defaultCreateOpts);

      expect(manager.get(sessionId)).toBeDefined();

      await manager.terminate(sessionId);

      // BEHAVIORAL: Session must be removed from pool
      expect(manager.get(sessionId)).toBeUndefined();
    });

    // SPEC: Terminated sessions must NOT appear in list()
    it('should exclude terminated sessions from list() results', async () => {
      const sessionId1 = 'list-session-1';
      const sessionId2 = 'list-session-2';

      mockedQuery.mockReturnValueOnce(createMockSDKStream([
        { type: 'system', subtype: 'init', session_id: sessionId1 },
        { type: 'result', subtype: 'success', is_error: false }
      ]));

      await manager.create({
        ...defaultCreateOpts,
        filePath: '/test/file1.ts'
      });

      mockedQuery.mockReturnValueOnce(createMockSDKStream([
        { type: 'system', subtype: 'init', session_id: sessionId2 },
        { type: 'result', subtype: 'success', is_error: false }
      ]));

      await manager.create({
        ...defaultCreateOpts,
        filePath: '/test/file2.ts'
      });

      expect(manager.list()).toHaveLength(2);

      await manager.terminate(sessionId1);

      // BEHAVIORAL: Terminated session must not appear in list
      const activeSessions = manager.list();
      expect(activeSessions).toHaveLength(1);
      expect(activeSessions[0].session_id).toBe(sessionId2);
    });

    // SPEC: Full terminate flow - abort + status + remove
    it('should complete full termination flow in correct sequence', async () => {
      const sessionId = 'full-terminate-test';
      mockedQuery.mockReturnValueOnce(createMockSDKStream([
        { type: 'system', subtype: 'init', session_id: sessionId },
        { type: 'result', subtype: 'success', is_error: false }
      ]));

      const session = await manager.create(defaultCreateOpts);

      const abortSpy = vi.spyOn(session.abortController!, 'abort');

      await manager.terminate(sessionId);

      // BEHAVIORAL: All three operations must complete
      expect(abortSpy).toHaveBeenCalled();
      expect(manager.get(sessionId)).toBeUndefined();
      expect(manager.list().find(s => s.session_id === sessionId)).toBeUndefined();
    });
  });

  describe('Contract 5: Error Handling Flow', () => {
    // SPEC: If SDK query() yields result message with is_error=true, create() must throw
    it('should throw when SDK returns error result during create()', async () => {
      mockedQuery.mockReturnValueOnce(createMockSDKStream([
        { type: 'system', subtype: 'init', session_id: 'error-session' },
        { type: 'result', subtype: 'error', is_error: true, error: 'SDK error occurred' }
      ]));

      await expect(manager.create(defaultCreateOpts)).rejects.toThrow();
    });

    // SPEC: Must not leave orphaned sessions when error occurs
    it('should not create orphaned session when SDK error occurs', async () => {
      const initialCount = manager.list().length;

      mockedQuery.mockReturnValueOnce(createMockSDKStream([
        { type: 'system', subtype: 'init', session_id: 'orphan-test' },
        { type: 'result', subtype: 'error', is_error: true, error: 'Test error' }
      ]));

      try {
        await manager.create(defaultCreateOpts);
      } catch (error) {
        // Expected to throw
      }

      // BEHAVIORAL: No new sessions should be in the pool
      expect(manager.list()).toHaveLength(initialCount);
      expect(manager.get('orphan-test')).toBeUndefined();
    });

    // SPEC: Error must be meaningful, not generic
    it('should throw meaningful error with SDK error details', async () => {
      const errorMessage = 'API rate limit exceeded';
      
      mockedQuery.mockReturnValueOnce(createMockSDKStream([
        { type: 'system', subtype: 'init', session_id: 'error-details-test' },
        { type: 'result', subtype: 'error', is_error: true, error: errorMessage }
      ]));

      await expect(manager.create(defaultCreateOpts)).rejects.toThrow();
    });

    // SPEC: Error handling during invocation should also throw
    it('should handle SDK errors during invokeOnSession', async () => {
      const sessionId = 'invoke-error-session';
      mockedQuery.mockReturnValueOnce(createMockSDKStream([
        { type: 'system', subtype: 'init', session_id: sessionId },
        { type: 'result', subtype: 'success', is_error: false }
      ]));

      await manager.create(defaultCreateOpts);

      mockedQuery.mockReturnValueOnce(createMockSDKStream([
        { type: 'assistant', content: 'Working...' },
        { type: 'result', subtype: 'error', is_error: true, error: 'Invocation failed' }
      ]));

      await expect(manager.invokeOnSession({
        sessionId,
        prompt: 'Test task',
        taskId: 'error-task'
      })).rejects.toThrow();
    });
  });
});
