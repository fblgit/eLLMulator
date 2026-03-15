/**
 * MCP Lifecycle Integration Test — Sequential Bootstrap Registration
 *
 * Reproduces the bug: first MCP register call succeeds, subsequent calls fail.
 * Uses real MCP HTTP server + real MCP client SDK — no mocks.
 *
 * Tests:
 * 1. Server starts, internal MCP listens on a dynamic port
 * 2. MCP client connects, initializes session, calls register → should succeed
 * 3. SECOND MCP client connects, initializes, calls register → should ALSO succeed
 * 4. THIRD MCP client connects, initializes, calls register → should ALSO succeed
 * 5. All three files end up `ready` in the registry with correct declarations
 *
 * Gated behind RUN_INTEGRATION=1 — skips cleanly in normal test runs.
 * Run with: RUN_INTEGRATION=1 npx vitest run src/__integration__/mcp-lifecycle.test.ts
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';

import { createServer, type Server } from '../server.js';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ---------------------------------------------------------------------------
// Env gate
// ---------------------------------------------------------------------------
const runIntegration = process.env.RUN_INTEGRATION === '1';
const describeIT = runIntegration ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Fixture files — small TypeScript files with known symbols
// ---------------------------------------------------------------------------

const FIXTURE_FILES: Record<string, string> = {
  'src/auth.ts': `
// Authentication module
import { hash } from './utils';

export interface User {
  id: string;
  name: string;
  email: string;
}

export function login(email: string, password: string): User | null {
  const hashed = hash(password);
  // lookup logic
  return { id: '1', name: 'test', email };
}

export function logout(userId: string): boolean {
  return true;
}
`,
  'src/utils.ts': `
// Utility functions

export function hash(input: string): string {
  return input.split('').reverse().join('');
}

export function slugify(text: string): string {
  return text.toLowerCase().replace(/\\s+/g, '-');
}

export const MAX_RETRIES = 3;
`,
  'src/db.ts': `
// Database access layer
import { MAX_RETRIES } from './utils';

export interface DBConfig {
  host: string;
  port: number;
}

export class Database {
  private config: DBConfig;

  constructor(config: DBConfig) {
    this.config = config;
  }

  async query(sql: string): Promise<unknown[]> {
    for (let i = 0; i < MAX_RETRIES; i++) {
      try {
        return [];
      } catch (e) {
        if (i === MAX_RETRIES - 1) throw e;
      }
    }
    return [];
  }

  async close(): Promise<void> {
    // cleanup
  }
}
`,
};

// ---------------------------------------------------------------------------
// Test Suite
// ---------------------------------------------------------------------------

describeIT('MCP Lifecycle — Sequential Bootstrap Registration', () => {
  let server: Server;
  let projectDir: string;
  let intPort: number;

  beforeAll(async () => {
    // Create fixture project on disk
    projectDir = await mkdtemp(join(tmpdir(), 'ellmulator-mcp-lifecycle-'));
    await mkdir(join(projectDir, 'src'), { recursive: true });

    for (const [relPath, content] of Object.entries(FIXTURE_FILES)) {
      const absPath = join(projectDir, relPath);
      await writeFile(absPath, content, 'utf-8');
    }

    // Use a random port to avoid conflicts
    intPort = 30000 + Math.floor(Math.random() * 10000);

    server = createServer({
      projectDir,
      extPort: intPort + 1,
      intPort,
    });

    await server.start();

    // Pre-register files as cold in the registry (mimics bootstrap scan phase)
    const registry = server.getRegistry();
    for (const relPath of Object.keys(FIXTURE_FILES)) {
      const absPath = join(projectDir, relPath);
      registry.add({
        file_path: absPath,
        file_hash: 'test-hash-' + relPath,
        status: 'cold',
        session_id: null,
        declarations: null,
        last_active: null,
        error: null,
      });
    }
  }, 30_000);

  afterAll(async () => {
    if (server) await server.stop();
    if (projectDir) await rm(projectDir, { recursive: true, force: true });
  });

  /**
   * Helper: create an MCP client, connect, list tools, call register, disconnect.
   * Returns the tool call result.
   */
  async function registerViaClient(
    filePath: string,
    declarations: Array<{
      name: string;
      kind: string;
      intent: string;
      file_path: string;
      start_line: number;
      end_line: number;
    }>,
    dependencies: Array<{
      name: string;
      from: string;
      kind: string;
    }> = [],
  ): Promise<{ success: boolean; toolResult: any; toolsAvailable: string[] }> {
    const url = new URL(`http://127.0.0.1:${intPort}/mcp`);

    // Create fresh client + transport for each call (mimics what SDK does per bootstrap agent)
    const transport = new StreamableHTTPClientTransport(url);
    const client = new Client({
      name: 'test-bootstrap-agent',
      version: '1.0.0',
    });

    try {
      await client.connect(transport);

      // List available tools
      const { tools } = await client.listTools();
      const toolNames = tools.map((t: any) => t.name);

      // Call register
      const result = await client.callTool({
        name: 'register',
        arguments: {
          file_path: filePath,
          declarations,
          dependencies,
        },
      });

      const content = (result.content as any[])?.[0];
      const parsed = content?.text ? JSON.parse(content.text) : null;

      return {
        success: !result.isError && parsed && !parsed.error,
        toolResult: parsed,
        toolsAvailable: toolNames,
      };
    } finally {
      try {
        await transport.close();
      } catch {
        // ignore close errors
      }
    }
  }

  it('first registration (src/utils.ts) succeeds', async () => {
    const filePath = join(projectDir, 'src/utils.ts');

    // Transition to bootstrapping (mimics bootstrap.ts)
    server.getRegistry().update(filePath, { status: 'bootstrapping' });

    const result = await registerViaClient(filePath, [
      { name: 'hash', kind: 'function', intent: 'Reverses input string as a hash', file_path: filePath, start_line: 4, end_line: 6 },
      { name: 'slugify', kind: 'function', intent: 'Converts text to URL-friendly slug', file_path: filePath, start_line: 8, end_line: 10 },
      { name: 'MAX_RETRIES', kind: 'const', intent: 'Maximum retry count constant', file_path: filePath, start_line: 12, end_line: 12 },
    ]);

    expect(result.toolsAvailable).toContain('register');
    expect(result.success).toBe(true);
    expect(result.toolResult.success).toBe(true);

    // Verify registry
    const entry = server.getRegistry().get(filePath);
    expect(entry?.status).toBe('ready');
    expect(entry?.declarations).toBeTruthy();
    expect(entry?.declarations?.owns).toHaveLength(3);
  }, 15_000);

  it('second registration (src/auth.ts) succeeds — MCP still alive', async () => {
    const filePath = join(projectDir, 'src/auth.ts');

    server.getRegistry().update(filePath, { status: 'bootstrapping' });

    const result = await registerViaClient(
      filePath,
      [
        { name: 'User', kind: 'interface', intent: 'User data interface', file_path: filePath, start_line: 4, end_line: 8 },
        { name: 'login', kind: 'function', intent: 'Authenticates user by email and password', file_path: filePath, start_line: 10, end_line: 15 },
        { name: 'logout', kind: 'function', intent: 'Logs out user by ID', file_path: filePath, start_line: 17, end_line: 19 },
      ],
      [
        { name: 'hash', from: './utils', kind: 'import' },
      ],
    );

    expect(result.toolsAvailable).toContain('register');
    expect(result.success).toBe(true);
    expect(result.toolResult.success).toBe(true);

    const entry = server.getRegistry().get(filePath);
    expect(entry?.status).toBe('ready');
    expect(entry?.declarations?.owns).toHaveLength(3);
    expect(entry?.declarations?.dependencies).toContain('./utils');
  }, 15_000);

  it('third registration (src/db.ts) succeeds — MCP still alive', async () => {
    const filePath = join(projectDir, 'src/db.ts');

    server.getRegistry().update(filePath, { status: 'bootstrapping' });

    const result = await registerViaClient(
      filePath,
      [
        { name: 'DBConfig', kind: 'interface', intent: 'Database configuration', file_path: filePath, start_line: 4, end_line: 7 },
        { name: 'Database', kind: 'class', intent: 'Database access with retry logic', file_path: filePath, start_line: 9, end_line: 28 },
      ],
      [
        { name: 'MAX_RETRIES', from: './utils', kind: 'import' },
      ],
    );

    expect(result.toolsAvailable).toContain('register');
    expect(result.success).toBe(true);
    expect(result.toolResult.success).toBe(true);

    const entry = server.getRegistry().get(filePath);
    expect(entry?.status).toBe('ready');
    expect(entry?.declarations?.owns).toHaveLength(2);
  }, 15_000);

  it('all three files are ready with correct declarations', () => {
    const registry = server.getRegistry();
    const readyFiles = registry.listByStatus('ready');

    expect(readyFiles).toHaveLength(3);

    // Verify each file
    for (const relPath of Object.keys(FIXTURE_FILES)) {
      const absPath = join(projectDir, relPath);
      const entry = registry.get(absPath);
      expect(entry?.status).toBe('ready');
      expect(entry?.declarations).toBeTruthy();
      expect(entry?.declarations?.owns.length).toBeGreaterThan(0);
    }
  });

  it('concurrent registrations also work (threads > 1)', async () => {
    // Reset all to cold, then register all 3 concurrently
    const registry = server.getRegistry();
    const files = Object.keys(FIXTURE_FILES).map(r => join(projectDir, r));

    for (const f of files) {
      // ready → stale (via hash change) → bootstrapping
      registry.update(f, { file_hash: 'changed-' + Date.now() });
      registry.update(f, { status: 'bootstrapping' });
    }

    const results = await Promise.all([
      registerViaClient(files[0], [
        { name: 'hash', kind: 'function', intent: 'Hash function', file_path: files[0], start_line: 4, end_line: 6 },
      ]),
      registerViaClient(files[1], [
        { name: 'login', kind: 'function', intent: 'Login function', file_path: files[1], start_line: 10, end_line: 15 },
      ]),
      registerViaClient(files[2], [
        { name: 'Database', kind: 'class', intent: 'DB class', file_path: files[2], start_line: 9, end_line: 28 },
      ]),
    ]);

    for (const r of results) {
      expect(r.success).toBe(true);
      expect(r.toolsAvailable).toContain('register');
    }

    // All should be ready
    for (const f of files) {
      expect(registry.get(f)?.status).toBe('ready');
    }
  }, 15_000);

  it('MCP session isolation — each client gets independent session', async () => {
    // Connect two clients simultaneously and verify they have different sessions
    const url = new URL(`http://127.0.0.1:${intPort}/mcp`);

    const transport1 = new StreamableHTTPClientTransport(url);
    const client1 = new Client({ name: 'agent-1', version: '1.0.0' });

    const transport2 = new StreamableHTTPClientTransport(url);
    const client2 = new Client({ name: 'agent-2', version: '1.0.0' });

    try {
      await client1.connect(transport1);
      await client2.connect(transport2);

      // Both should see tools
      const tools1 = await client1.listTools();
      const tools2 = await client2.listTools();

      expect(tools1.tools.map((t: any) => t.name)).toContain('register');
      expect(tools2.tools.map((t: any) => t.name)).toContain('register');

      // They should have different session IDs
      expect(transport1.sessionId).toBeTruthy();
      expect(transport2.sessionId).toBeTruthy();
      expect(transport1.sessionId).not.toBe(transport2.sessionId);
    } finally {
      try { await transport1.close(); } catch {}
      try { await transport2.close(); } catch {}
    }
  }, 15_000);

  it('rapid sequential connect/disconnect cycles do not break the server', async () => {
    // Simulate 5 rapid sequential bootstrap agents
    const filePath = join(projectDir, 'src/utils.ts');

    for (let i = 0; i < 5; i++) {
      // Reset to bootstrapping each time
      const entry = server.getRegistry().get(filePath);
      if (entry?.status === 'ready') {
        // ready → stale (via hash change) → bootstrapping
        server.getRegistry().update(filePath, { file_hash: 'rapid-' + i + '-' + Date.now() });
        server.getRegistry().update(filePath, { status: 'bootstrapping' });
      }

      const url = new URL(`http://127.0.0.1:${intPort}/mcp`);
      const transport = new StreamableHTTPClientTransport(url);
      const client = new Client({ name: `rapid-agent-${i}`, version: '1.0.0' });

      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.map((t: any) => t.name)).toContain('register');

      const result = await client.callTool({
        name: 'register',
        arguments: {
          file_path: filePath,
          declarations: [{
            name: `symbol_${i}`,
            kind: 'function',
            intent: `Test symbol ${i}`,
            file_path: filePath,
            start_line: 1,
            end_line: 2,
          }],
          dependencies: [],
        },
      });

      expect(result.isError).toBeFalsy();
      await transport.close();

      expect(server.getRegistry().get(filePath)?.status).toBe('ready');
    }
  }, 30_000);
});
