/**
 * Project onboarding — `ellmulator init <target-dir>`
 *
 * Three idempotent upsert operations:
 *   1. .mcp.json — add/update ellmulator MCP server entry
 *   2. .claude/settings.local.json — merge permissions + enabledMcpjsonServers
 *   3. CLAUDE.md — append usage section if not present
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type InitResult = {
  mcpJson: 'created' | 'updated' | 'unchanged';
  settings: 'created' | 'updated' | 'unchanged';
  claudeMd: 'created' | 'appended' | 'unchanged';
};

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const REQUIRED_PERMISSIONS = [
  'mcp__ellmulator__trace',
  'mcp__ellmulator__inspect',
  'mcp__ellmulator__status',
  'mcp__ellmulator__list_agents',
  'mcp__ellmulator__consolidate',
];

const CLAUDE_MD_SENTINEL = '## eLLMulator';

const CLAUDE_MD_BLOCK = `## eLLMulator

Agentic Distributed Trace Simulation. eLLMulator agents study your source code and simulate execution traces via MCP.

Available tools: \`trace\`, \`inspect\`, \`status\`, \`list_agents\`, \`consolidate\`.

\`\`\`bash
# Start eLLMulator server pointing at this project
ellmulator start --project . --bootstrap

# Run a trace
ellmulator trace "What happens when a user logs in?"
\`\`\`
`;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readJsonFile(path: string): Promise<Record<string, any> | null> {
  try {
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw);
  } catch (err: any) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

async function readTextFile(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf-8');
  } catch (err: any) {
    if (err.code === 'ENOENT') return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Upsert operations
// ---------------------------------------------------------------------------

async function upsertMcpJson(
  targetDir: string,
  extPort: number,
): Promise<InitResult['mcpJson']> {
  const filePath = join(targetDir, '.mcp.json');
  const entry = { type: 'http', url: `http://localhost:${extPort}/mcp` };

  const existing = await readJsonFile(filePath);

  if (existing === null) {
    await writeFile(filePath, JSON.stringify({ mcpServers: { ellmulator: entry } }, null, 2) + '\n');
    return 'created';
  }

  if (!existing.mcpServers) {
    existing.mcpServers = {};
  }

  const current = existing.mcpServers.ellmulator;
  if (current && current.type === entry.type && current.url === entry.url) {
    return 'unchanged';
  }

  existing.mcpServers.ellmulator = entry;
  await writeFile(filePath, JSON.stringify(existing, null, 2) + '\n');
  return 'updated';
}

async function upsertSettings(
  targetDir: string,
): Promise<InitResult['settings']> {
  const dirPath = join(targetDir, '.claude');
  const filePath = join(dirPath, 'settings.local.json');

  const existing = await readJsonFile(filePath);

  if (existing === null) {
    await mkdir(dirPath, { recursive: true });
    await writeFile(filePath, JSON.stringify({
      permissions: {
        allow: [...REQUIRED_PERMISSIONS],
      },
      enabledMcpjsonServers: ['ellmulator'],
    }, null, 2) + '\n');
    return 'created';
  }

  let changed = false;

  // Ensure permissions.allow exists
  if (!existing.permissions) existing.permissions = {};
  if (!Array.isArray(existing.permissions.allow)) existing.permissions.allow = [];

  // Add missing permissions
  for (const perm of REQUIRED_PERMISSIONS) {
    if (!existing.permissions.allow.includes(perm)) {
      existing.permissions.allow.push(perm);
      changed = true;
    }
  }

  // Ensure enabledMcpjsonServers exists and includes ellmulator
  if (!Array.isArray(existing.enabledMcpjsonServers)) {
    existing.enabledMcpjsonServers = [];
  }
  if (!existing.enabledMcpjsonServers.includes('ellmulator')) {
    existing.enabledMcpjsonServers.push('ellmulator');
    changed = true;
  }

  if (!changed) return 'unchanged';

  await writeFile(filePath, JSON.stringify(existing, null, 2) + '\n');
  return 'updated';
}

async function upsertClaudeMd(
  targetDir: string,
): Promise<InitResult['claudeMd']> {
  const filePath = join(targetDir, 'CLAUDE.md');
  const existing = await readTextFile(filePath);

  if (existing === null) {
    await writeFile(filePath, CLAUDE_MD_BLOCK);
    return 'created';
  }

  if (existing.includes(CLAUDE_MD_SENTINEL)) {
    return 'unchanged';
  }

  const separator = existing.endsWith('\n') ? '\n' : '\n\n';
  await writeFile(filePath, existing + separator + CLAUDE_MD_BLOCK);
  return 'appended';
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

export async function initProject(
  targetDir: string,
  opts: { extPort: number },
): Promise<InitResult> {
  const mcpJson = await upsertMcpJson(targetDir, opts.extPort);
  const settings = await upsertSettings(targetDir);
  const claudeMd = await upsertClaudeMd(targetDir);

  return { mcpJson, settings, claudeMd };
}
