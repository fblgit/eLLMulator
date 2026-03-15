/**
 * SessionManager Tests — Real SDK Integration
 *
 * Tests for SessionManager with real Claude Agent SDK patterns:
 * - Session IDs from system/init messages
 * - AsyncGenerator iteration
 * - Response capture via Promise pattern
 * - Termination via AbortController
 *
 * All SDK interactions are mocked to test the wrapper logic.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { ResponseEnvelope } from './types.js';

// Create mock AsyncGenerator helper
function createMockQueryGenerator(messages: SDKMessage[]): AsyncGenerator<SDKMessage> {
  let index = 0;
  return {
    async next() {
      if (index < messages.length) {
        return { value: messages[index++], done: false };
      }
      return { value: undefined, done: true };
    },
    async return(value: any) {
      return { value, done: true };
    },
    async throw(e: any) {
      throw e;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  } as AsyncGenerator<SDKMessage>;
}

// Mock the claude-agent-sdk
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

import { SessionManager, type AgentSession } from './session-manager.js';
import { query } from '@anthropic-ai/claude-agent-sdk';

describe('SessionManager — Real SDK Integration', () => {
  let manager: SessionManager;
  const mockQuery = query as unknown as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    manager = new SessionManager();
    vi.clearAllMocks();
  });

  // ─── Test 1: create() captures session_id from system/init message ───

  describe('create() — Session ID Capture', () => {
    it('should capture session_id from SDK system/init message', async () => {
      const mockMessages: SDKMessage[] = [
        {
          type: 'system',
          subtype: 'init',
          session_id: 'sdk-session-abc123',
          agents: [],
          apiKeySource: { type: 'environment' },
          betas: [],
          claude_code_version: '2.1.72',
          cwd: '/test',
          tools: ['Read', 'mcp__internal__register'],
          mcp_servers: [],
          model: 'claude-opus-4-6',
          permissionMode: 'bypassPermissions',
          slash_commands: [],
          output_style: 'normal',
          skills: [],
          plugins: [],
          uuid: 'uuid-1',
        } as SDKMessage,
        {
          type: 'result',
          subtype: 'success',
          duration_ms: 1000,
          duration_api_ms: 800,
          is_error: false,
          num_turns: 1,
          result: 'Bootstrap complete',
          stop_reason: 'end_turn',
          total_cost_usd: 0.05,
          usage: { input_tokens: 100, output_tokens: 50 },
          modelUsage: {},
          permission_denials: [],
          uuid: 'uuid-2',
          session_id: 'sdk-session-abc123',
        } as SDKMessage,
      ];

      mockQuery.mockReturnValue(createMockQueryGenerator(mockMessages));

      const session = await manager.create({
        filePath: '/src/server.ts',
        fileHash: 'abc123',
        systemPrompt: 'You ARE /src/server.ts',
        bootstrapPrompt: 'Bootstrap yourself',
        tools: ['mcp__internal__register'],
        model: 'claude-opus-4-6',
        cwd: '/test',
      });

      // Session ID should come from SDK
      expect(session.session_id).toBe('sdk-session-abc123');
      expect(session.file_path).toBe('/src/server.ts');
      expect(session.status).toBe('active');
    });

    it('should throw error if no system/init message received', async () => {
      // Missing system/init message
      const mockMessages: SDKMessage[] = [
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: 'session-1',
          result: 'Done',
        } as SDKMessage,
      ];

      mockQuery.mockReturnValue(createMockQueryGenerator(mockMessages));

      await expect(
        manager.create({
          filePath: '/src/test.ts',
          fileHash: 'hash1',
          systemPrompt: 'Test',
          bootstrapPrompt: 'Bootstrap',
          tools: [],
          model: 'opus',
          cwd: '/test',
        })
      ).rejects.toThrow('Failed to capture session_id');
    });

    it('should handle SDK errors during creation', async () => {
      const mockMessages: SDKMessage[] = [
        {
          type: 'system',
          subtype: 'init',
          session_id: 'session-error',
        } as SDKMessage,
        {
          type: 'result',
          subtype: 'error_api',
          is_error: true,
          result: 'API rate limit exceeded',
          session_id: 'session-error',
        } as SDKMessage,
      ];

      mockQuery.mockReturnValue(createMockQueryGenerator(mockMessages));

      await expect(
        manager.create({
          filePath: '/src/test.ts',
          fileHash: 'hash1',
          systemPrompt: 'Test',
          bootstrapPrompt: 'Bootstrap',
          tools: [],
          model: 'opus',
          cwd: '/test',
        })
      ).rejects.toThrow('Session creation failed');
    });
  });

  // ─── Test 2: invokeOnSession() with response capture ───

  describe('invokeOnSession() — Response Capture', () => {
    it('should capture response via Promise pattern', async () => {
      // First create a session
      const createMessages: SDKMessage[] = [
        {
          type: 'system',
          subtype: 'init',
          session_id: 'session-invoke-1',
        } as SDKMessage,
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: 'session-invoke-1',
        } as SDKMessage,
      ];

      mockQuery.mockReturnValueOnce(createMockQueryGenerator(createMessages));

      const session = await manager.create({
        filePath: '/src/test.ts',
        fileHash: 'hash1',
        systemPrompt: 'Test',
        bootstrapPrompt: 'Bootstrap',
        tools: ['mcp__internal__respond'],
        model: 'opus',
        cwd: '/test',
      });

      // Invoke messages
      const invokeMessages: SDKMessage[] = [
        {
          type: 'assistant',
          message: {
            id: 'msg-1',
            content: [
              {
                type: 'tool_use',
                id: 'tool-1',
                name: 'mcp__internal__respond',
                input: {
                  task_id: 'task-123',
                  responder: '/src/test.ts',
                  returns: { result: 42 },
                  source_refs: ['test.ts:10'],
                },
              },
            ],
            model: 'opus',
            stop_reason: 'tool_use',
            usage: { input_tokens: 50, output_tokens: 25 },
          },
        } as SDKMessage,
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: 'session-invoke-1',
        } as SDKMessage,
      ];

      mockQuery.mockReturnValueOnce(createMockQueryGenerator(invokeMessages));

      // Start invoke (this will wait for response)
      const invokePromise = manager.invokeOnSession({
        sessionId: session.session_id,
        prompt: 'Process this invoke',
        taskId: 'task-123',
      });

      // Simulate respond() tool handler calling captureResponse
      const responseEnvelope: ResponseEnvelope = {
        task_id: 'task-123',
        responder: '/src/test.ts',
        returns: { result: 42 },
        source_refs: ['test.ts:10'],
      };

      // Give the invoke loop time to setup the promise
      await new Promise(resolve => setTimeout(resolve, 10));
      
      manager.captureResponse('task-123', responseEnvelope);

      const response = await invokePromise;

      expect(response).toEqual(responseEnvelope);
      expect(response.task_id).toBe('task-123');
      expect(response.returns).toEqual({ result: 42 });
    });

    it('should support forkSession option', async () => {
      // Create session
      const createMessages: SDKMessage[] = [
        {
          type: 'system',
          subtype: 'init',
          session_id: 'session-fork',
        } as SDKMessage,
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: 'session-fork',
        } as SDKMessage,
      ];

      mockQuery.mockReturnValueOnce(createMockQueryGenerator(createMessages));

      const session = await manager.create({
        filePath: '/src/test.ts',
        fileHash: 'hash1',
        systemPrompt: 'Test',
        bootstrapPrompt: 'Bootstrap',
        tools: ['mcp__internal__respond'],
        model: 'opus',
        cwd: '/test',
      });

      // Invoke with fork
      const invokeMessages: SDKMessage[] = [
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: 'session-fork',
        } as SDKMessage,
      ];

      mockQuery.mockReturnValueOnce(createMockQueryGenerator(invokeMessages));

      const invokePromise = manager.invokeOnSession({
        sessionId: session.session_id,
        prompt: 'Process with fork',
        taskId: 'task-fork',
        forkSession: true,
      });

      // Provide response
      await new Promise(resolve => setTimeout(resolve, 10));
      manager.captureResponse('task-fork', {
        task_id: 'task-fork',
        responder: '/src/test.ts',
        source_refs: ['test.ts:1'],
      });

      await invokePromise;

      // Verify forkSession was passed to SDK
      expect(mockQuery).toHaveBeenCalledWith(
        expect.objectContaining({
          options: expect.objectContaining({
            forkSession: true,
          }),
        })
      );
    });

    it('should throw error for terminated session', async () => {
      // Create and terminate
      const createMessages: SDKMessage[] = [
        {
          type: 'system',
          subtype: 'init',
          session_id: 'session-term',
        } as SDKMessage,
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: 'session-term',
        } as SDKMessage,
      ];

      mockQuery.mockReturnValueOnce(createMockQueryGenerator(createMessages));

      const session = await manager.create({
        filePath: '/src/test.ts',
        fileHash: 'hash1',
        systemPrompt: 'Test',
        bootstrapPrompt: 'Bootstrap',
        tools: [],
        model: 'opus',
        cwd: '/test',
      });

      await manager.terminate(session.session_id);

      // After termination, session is removed from pool
      await expect(
        manager.invokeOnSession({
          sessionId: session.session_id,
          prompt: 'Should fail',
          taskId: 'task-fail',
        })
      ).rejects.toThrow('Session not found');
    });
  });

  // ─── Test 3: terminate() with AbortController ───

  describe('terminate()', () => {
    it('should abort session via AbortController', async () => {
      const createMessages: SDKMessage[] = [
        {
          type: 'system',
          subtype: 'init',
          session_id: 'session-abort',
        } as SDKMessage,
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: 'session-abort',
        } as SDKMessage,
      ];

      mockQuery.mockReturnValue(createMockQueryGenerator(createMessages));

      const session = await manager.create({
        filePath: '/src/test.ts',
        fileHash: 'hash1',
        systemPrompt: 'Test',
        bootstrapPrompt: 'Bootstrap',
        tools: [],
        model: 'opus',
        cwd: '/test',
      });

      expect(session.abortController).toBeDefined();
      const abortSpy = vi.spyOn(session.abortController!, 'abort');

      await manager.terminate(session.session_id);

      expect(abortSpy).toHaveBeenCalled();
      expect(session.status).toBe('terminated');
      expect(manager.get(session.session_id)).toBeUndefined();
    });

    it('should clean up session from pool', async () => {
      const createMessages: SDKMessage[] = [
        {
          type: 'system',
          subtype: 'init',
          session_id: 'session-cleanup',
        } as SDKMessage,
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: 'session-cleanup',
        } as SDKMessage,
      ];

      mockQuery.mockReturnValue(createMockQueryGenerator(createMessages));

      const session = await manager.create({
        filePath: '/src/test.ts',
        fileHash: 'hash1',
        systemPrompt: 'Test',
        bootstrapPrompt: 'Bootstrap',
        tools: [],
        model: 'opus',
        cwd: '/test',
      });

      expect(manager.size).toBe(1);

      await manager.terminate(session.session_id);

      expect(manager.size).toBe(0);
      expect(manager.get(session.session_id)).toBeUndefined();
    });
  });

  // ─── Test 4: get() and list() ───

  describe('get() and list()', () => {
    it('should retrieve session by ID', async () => {
      const createMessages: SDKMessage[] = [
        {
          type: 'system',
          subtype: 'init',
          session_id: 'session-get',
        } as SDKMessage,
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: 'session-get',
        } as SDKMessage,
      ];

      mockQuery.mockReturnValue(createMockQueryGenerator(createMessages));

      const session = await manager.create({
        filePath: '/src/test.ts',
        fileHash: 'hash1',
        systemPrompt: 'Test',
        bootstrapPrompt: 'Bootstrap',
        tools: [],
        model: 'opus',
        cwd: '/test',
      });

      const retrieved = manager.get(session.session_id);
      expect(retrieved).toBeDefined();
      expect(retrieved!.session_id).toBe('session-get');
    });

    it('should list active and idle sessions', async () => {
      const createMessages1: SDKMessage[] = [
        {
          type: 'system',
          subtype: 'init',
          session_id: 'session-1',
        } as SDKMessage,
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: 'session-1',
        } as SDKMessage,
      ];

      const createMessages2: SDKMessage[] = [
        {
          type: 'system',
          subtype: 'init',
          session_id: 'session-2',
        } as SDKMessage,
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: 'session-2',
        } as SDKMessage,
      ];

      mockQuery
        .mockReturnValueOnce(createMockQueryGenerator(createMessages1))
        .mockReturnValueOnce(createMockQueryGenerator(createMessages2));

      await manager.create({
        filePath: '/src/a.ts',
        fileHash: 'hash1',
        systemPrompt: 'Test A',
        bootstrapPrompt: 'Bootstrap',
        tools: [],
        model: 'opus',
        cwd: '/test',
      });

      await manager.create({
        filePath: '/src/b.ts',
        fileHash: 'hash2',
        systemPrompt: 'Test B',
        bootstrapPrompt: 'Bootstrap',
        tools: [],
        model: 'opus',
        cwd: '/test',
      });

      const sessions = manager.list();
      expect(sessions).toHaveLength(2);
      expect(sessions.map(s => s.session_id)).toContain('session-1');
      expect(sessions.map(s => s.session_id)).toContain('session-2');
    });

    it('should not list terminated sessions', async () => {
      const createMessages: SDKMessage[] = [
        {
          type: 'system',
          subtype: 'init',
          session_id: 'session-term',
        } as SDKMessage,
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: 'session-term',
        } as SDKMessage,
      ];

      mockQuery.mockReturnValue(createMockQueryGenerator(createMessages));

      const session = await manager.create({
        filePath: '/src/test.ts',
        fileHash: 'hash1',
        systemPrompt: 'Test',
        bootstrapPrompt: 'Bootstrap',
        tools: [],
        model: 'opus',
        cwd: '/test',
      });

      expect(manager.list()).toHaveLength(1);

      await manager.terminate(session.session_id);

      expect(manager.list()).toHaveLength(0);
    });
  });

  // ─── Test 5: AgentSession type contract ───

  describe('AgentSession type contract', () => {
    it('should have all required fields', async () => {
      const createMessages: SDKMessage[] = [
        {
          type: 'system',
          subtype: 'init',
          session_id: 'session-contract',
        } as SDKMessage,
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: 'session-contract',
        } as SDKMessage,
      ];

      mockQuery.mockReturnValue(createMockQueryGenerator(createMessages));

      const session = await manager.create({
        filePath: '/src/test.ts',
        fileHash: 'hash1',
        systemPrompt: 'You ARE /src/test.ts',
        bootstrapPrompt: 'Bootstrap',
        tools: ['mcp__internal__register'],
        model: 'claude-opus-4-6',
        cwd: '/test',
      });

      // Required fields
      expect(session.session_id).toBeDefined();
      expect(session.file_path).toBe('/src/test.ts');
      expect(session.created_at).toBeInstanceOf(Date);
      expect(session.file_hash).toBe('hash1');
      expect(session.status).toBe('active');

      // Stored options
      expect(session.systemPrompt).toBe('You ARE /src/test.ts');
      expect(session.tools).toEqual(['mcp__internal__register']);
      expect(session.model).toBe('claude-opus-4-6');

      // AbortController
      expect(session.abortController).toBeInstanceOf(AbortController);
    });
  });

  // ─── Test 6: Legacy query() method ───

  describe('query() — Legacy method', () => {
    it('should work for backward compatibility', async () => {
      const createMessages: SDKMessage[] = [
        {
          type: 'system',
          subtype: 'init',
          session_id: 'session-legacy',
        } as SDKMessage,
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: 'session-legacy',
        } as SDKMessage,
      ];

      mockQuery.mockReturnValueOnce(createMockQueryGenerator(createMessages));

      const session = await manager.create({
        filePath: '/src/test.ts',
        fileHash: 'hash1',
        systemPrompt: 'Test',
        bootstrapPrompt: 'Bootstrap',
        tools: [],
        model: 'opus',
        cwd: '/test',
      });

      const queryMessages: SDKMessage[] = [
        {
          type: 'assistant',
          message: {
            id: 'msg-1',
            content: [{ type: 'text', text: 'Response' }],
            model: 'opus',
            stop_reason: 'end_turn',
            usage: { input_tokens: 10, output_tokens: 5 },
          },
        } as SDKMessage,
      ];

      mockQuery.mockReturnValueOnce(createMockQueryGenerator(queryMessages));

      const result = await manager.query({
        sessionId: session.session_id,
        prompt: 'Test query',
        tools: [],
        stream: false,
      });

      expect(result).toBeDefined();
      expect(Array.isArray(result)).toBe(true);
    });
  });
});
