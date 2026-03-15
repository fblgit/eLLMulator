/**
 * SDK Integration Spike Test
 * 
 * Minimal smoke tests verifying the real Claude Agent SDK works as expected.
 * Makes real API calls — gated behind RUN_SPIKE=1 env var.
 * 
 * Run with: RUN_SPIKE=1 npm test src/__spike__/sdk-spike.test.ts
 * 
 * Tests:
 * - S1: query() returns system/init with session_id
 * - S2: Session resume works with captured session_id
 * - S3: Custom MCP tools are callable by the agent
 */

import { describe, it, expect } from 'vitest';
import { 
  query, 
  createSdkMcpServer, 
  tool,
  type SDKMessage,
  type SDKSystemMessage,
  type SDKResultMessage,
  type Options 
} from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';

// Skip entire suite unless RUN_SPIKE=1
const runSpike = process.env.RUN_SPIKE === '1';
const describeSpike = runSpike ? describe : describe.skip;

describeSpike('[MUST-PASS-AT-PHASE-6] SDK Integration Spike', () => {
  /**
   * S1: Can we call query() and get a system/init message with session_id?
   * 
   * Verifies:
   * - query() returns AsyncGenerator<SDKMessage>
   * - system/init message is emitted first
   * - session_id is present and non-empty
   * - result message is emitted at completion
   */
  it('[MUST-PASS-AT-PHASE-6] S1: query() returns system/init with session_id', async () => {
    let sessionId: string | undefined;
    let foundSystemInit = false;
    let foundResult = false;

    const options: Options = {
      model: 'sonnet',
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      maxTurns: 1,
    };

    // Iterate the AsyncGenerator
    for await (const message of query({
      prompt: 'Reply with just the word HELLO',
      options,
    })) {
      // Look for system/init message
      if (message.type === 'system' && message.subtype === 'init') {
        foundSystemInit = true;
        const systemMsg = message as SDKSystemMessage;
        sessionId = systemMsg.session_id;
      }

      // Look for result message
      if (message.type === 'result') {
        foundResult = true;
        const resultMsg = message as SDKResultMessage;
        expect(resultMsg.is_error).toBe(false);
      }
    }

    // Verify we got both message types
    expect(foundSystemInit).toBe(true);
    expect(foundResult).toBe(true);
    expect(sessionId).toBeDefined();
    expect(sessionId).not.toBe('');
    expect(typeof sessionId).toBe('string');
  }, 60_000);

  /**
   * S2: Can we resume a session?
   * 
   * Verifies:
   * - Creating a session captures session_id
   * - Resuming with that session_id works
   * - Agent has context from previous session
   */
  it('[MUST-PASS-AT-PHASE-6] S2: session resume works with captured session_id', async () => {
    // Phase 1: Create a session
    let sessionId: string | undefined;

    const createOptions: Options = {
      model: 'sonnet',
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      maxTurns: 1,
    };

    for await (const message of query({
      prompt: 'Remember the secret word: PINEAPPLE. Reply with OK.',
      options: createOptions,
    })) {
      if (message.type === 'system' && message.subtype === 'init') {
        sessionId = (message as SDKSystemMessage).session_id;
      }
    }

    expect(sessionId).toBeDefined();

    // Phase 2: Resume the session
    let foundResult = false;

    const resumeOptions: Options = {
      resume: sessionId,
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      maxTurns: 1,
    };

    for await (const message of query({
      prompt: 'What was the secret word?',
      options: resumeOptions,
    })) {
      if (message.type === 'result') {
        foundResult = true;
        const resultMsg = message as SDKResultMessage;
        expect(resultMsg.is_error).toBe(false);
        // Agent should have context from previous turn
        // (We don't assert the exact response, just that it completed successfully)
      }
    }

    expect(foundResult).toBe(true);
  }, 60_000);

  /**
   * S3: Does createSdkMcpServer + tool() work for custom tools?
   * 
   * Verifies:
   * - createSdkMcpServer creates in-process MCP server
   * - tool() defines a callable tool
   * - Agent can call the tool via mcp__<server>__<tool> naming
   * - Tool handler executes and returns content
   */
  it('[MUST-PASS-AT-PHASE-6] S3: custom MCP tools are callable by the agent', async () => {
    // Track whether the tool was called
    let toolWasCalled = false;
    let toolCallCount = 0;

    // Create in-process MCP server with a simple ping tool
    const testMcpServer = createSdkMcpServer({
      name: 'test',
      version: '1.0.0',
      tools: [
        tool(
          'ping',
          'Returns pong. Use this to test tool calling.',
          {},
          async () => {
            toolWasCalled = true;
            toolCallCount++;
            return {
              content: [{ type: 'text', text: 'pong' }],
            };
          }
        ),
      ],
    });

    const options: Options = {
      model: 'sonnet',
      permissionMode: 'bypassPermissions',
      allowDangerouslySkipPermissions: true,
      maxTurns: 3,
      mcpServers: {
        'test': testMcpServer,
      },
      allowedTools: ['mcp__test__ping'],
    };

    let foundResult = false;

    for await (const message of query({
      prompt: 'Call the mcp__test__ping tool and tell me what it returned.',
      options,
    })) {
      if (message.type === 'result') {
        foundResult = true;
        const resultMsg = message as SDKResultMessage;
        expect(resultMsg.is_error).toBe(false);
      }
    }

    // Verify the tool was called
    expect(foundResult).toBe(true);
    expect(toolWasCalled).toBe(true);
    expect(toolCallCount).toBeGreaterThan(0);
  }, 60_000);
});
