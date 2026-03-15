/**
 * RED: External MCP must support sequential client sessions.
 *
 * Reproduces the exact failure:
 *   1. Server bootstrapped, listening on extPort
 *   2. Client A connects, calls trace → succeeds
 *   3. Client A disconnects
 *   4. Client B connects, calls trace → "Server already initialized"
 *
 * The external MCP transport was single-session: after Client A initialized,
 * the transport rejected all subsequent initialize requests.
 */

import { describe, it, expect } from 'vitest';
import { createServer } from '../server.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

function randomPort(): number {
  return 30000 + Math.floor(Math.random() * 10000);
}

describe('RED: External MCP sequential client sessions', () => {
  it('second client must be able to initialize after first client disconnects', async () => {
    const extPort = randomPort();
    const intPort = randomPort();
    const server = createServer({ extPort, intPort, projectDir: '/tmp/test-multi-session' });

    try {
      await server.start();

      // --- Client A: connect, call status, disconnect ---
      const transportA = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${extPort}/mcp`),
      );
      const clientA = new Client({ name: 'client-a', version: '1.0.0' });
      await clientA.connect(transportA);

      const resultA = await clientA.callTool({ name: 'status', arguments: {} });
      expect(resultA.content).toBeDefined();

      await clientA.close();

      // --- Client B: connect, call status — this MUST NOT fail ---
      const transportB = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${extPort}/mcp`),
      );
      const clientB = new Client({ name: 'client-b', version: '1.0.0' });
      await clientB.connect(transportB);

      const resultB = await clientB.callTool({ name: 'status', arguments: {} });
      expect(resultB.content).toBeDefined();

      await clientB.close();
    } finally {
      await server.stop();
    }
  });

  it('two clients must be able to connect concurrently', async () => {
    const extPort = randomPort();
    const intPort = randomPort();
    const server = createServer({ extPort, intPort, projectDir: '/tmp/test-multi-session-concurrent' });

    try {
      await server.start();

      // Connect both clients simultaneously
      const transportA = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${extPort}/mcp`),
      );
      const transportB = new StreamableHTTPClientTransport(
        new URL(`http://127.0.0.1:${extPort}/mcp`),
      );
      const clientA = new Client({ name: 'client-a', version: '1.0.0' });
      const clientB = new Client({ name: 'client-b', version: '1.0.0' });

      await clientA.connect(transportA);
      await clientB.connect(transportB);

      // Both should be able to call tools
      const [resultA, resultB] = await Promise.all([
        clientA.callTool({ name: 'status', arguments: {} }),
        clientB.callTool({ name: 'status', arguments: {} }),
      ]);

      expect(resultA.content).toBeDefined();
      expect(resultB.content).toBeDefined();

      await clientA.close();
      await clientB.close();
    } finally {
      await server.stop();
    }
  });
});
