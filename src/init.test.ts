/**
 * Tests for ellmulator init — project onboarding command.
 * Uses tmp dirs for isolation. Tests initProject() directly (no CLI parsing).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, rm, readFile, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initProject } from './init.js';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'ellmulator-init-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 1. Fresh project — creates all files from scratch
// ---------------------------------------------------------------------------

describe('initProject: fresh project', () => {
  it('creates .mcp.json with ellmulator entry', async () => {
    const result = await initProject(dir, { extPort: 3100 });
    expect(result.mcpJson).toBe('created');

    const raw = await readFile(join(dir, '.mcp.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.mcpServers.ellmulator).toEqual({
      type: 'http',
      url: 'http://localhost:3100/mcp',
    });
  });

  it('creates .claude/settings.local.json with permissions', async () => {
    const result = await initProject(dir, { extPort: 3100 });
    expect(result.settings).toBe('created');

    const raw = await readFile(join(dir, '.claude', 'settings.local.json'), 'utf-8');
    const parsed = JSON.parse(raw);
    expect(parsed.permissions.allow).toContain('mcp__ellmulator__trace');
    expect(parsed.permissions.allow).toContain('mcp__ellmulator__inspect');
    expect(parsed.permissions.allow).toContain('mcp__ellmulator__status');
    expect(parsed.permissions.allow).toContain('mcp__ellmulator__list_agents');
    expect(parsed.permissions.allow).toContain('mcp__ellmulator__consolidate');
    expect(parsed.enabledMcpjsonServers).toContain('ellmulator');
  });

  it('creates CLAUDE.md with eLLMulator section', async () => {
    const result = await initProject(dir, { extPort: 3100 });
    expect(result.claudeMd).toBe('created');

    const content = await readFile(join(dir, 'CLAUDE.md'), 'utf-8');
    expect(content).toContain('## eLLMulator');
    expect(content).toContain('ellmulator start --project . --bootstrap');
  });
});

// ---------------------------------------------------------------------------
// 2. Existing files — merges without clobbering
// ---------------------------------------------------------------------------

describe('initProject: merge into existing files', () => {
  it('adds ellmulator to existing .mcp.json with other servers', async () => {
    await writeFile(join(dir, '.mcp.json'), JSON.stringify({
      mcpServers: {
        dil: { type: 'http', url: 'http://localhost:8080/mcp' },
      },
    }, null, 2));

    const result = await initProject(dir, { extPort: 3100 });
    expect(result.mcpJson).toBe('updated');

    const parsed = JSON.parse(await readFile(join(dir, '.mcp.json'), 'utf-8'));
    expect(parsed.mcpServers.dil).toEqual({ type: 'http', url: 'http://localhost:8080/mcp' });
    expect(parsed.mcpServers.ellmulator).toEqual({ type: 'http', url: 'http://localhost:3100/mcp' });
  });

  it('merges permissions into existing settings.local.json', async () => {
    await mkdir(join(dir, '.claude'), { recursive: true });
    await writeFile(join(dir, '.claude', 'settings.local.json'), JSON.stringify({
      permissions: {
        allow: ['Bash(npx vitest:*)'],
        deny: [],
      },
      enabledMcpjsonServers: ['dil'],
      someOtherKey: true,
    }, null, 2));

    const result = await initProject(dir, { extPort: 3100 });
    expect(result.settings).toBe('updated');

    const parsed = JSON.parse(await readFile(join(dir, '.claude', 'settings.local.json'), 'utf-8'));
    // Existing entries preserved
    expect(parsed.permissions.allow).toContain('Bash(npx vitest:*)');
    expect(parsed.permissions.deny).toEqual([]);
    expect(parsed.enabledMcpjsonServers).toContain('dil');
    expect(parsed.someOtherKey).toBe(true);
    // New entries added
    expect(parsed.permissions.allow).toContain('mcp__ellmulator__trace');
    expect(parsed.enabledMcpjsonServers).toContain('ellmulator');
  });

  it('appends eLLMulator section to existing CLAUDE.md', async () => {
    await writeFile(join(dir, 'CLAUDE.md'), '# My Project\n\nSome existing content.\n');

    const result = await initProject(dir, { extPort: 3100 });
    expect(result.claudeMd).toBe('appended');

    const content = await readFile(join(dir, 'CLAUDE.md'), 'utf-8');
    expect(content).toMatch(/^# My Project/);
    expect(content).toContain('Some existing content.');
    expect(content).toContain('## eLLMulator');
  });
});

// ---------------------------------------------------------------------------
// 3. Idempotent — re-run changes nothing
// ---------------------------------------------------------------------------

describe('initProject: idempotent', () => {
  it('returns unchanged on second run', async () => {
    await initProject(dir, { extPort: 3100 });
    const result = await initProject(dir, { extPort: 3100 });

    expect(result.mcpJson).toBe('unchanged');
    expect(result.settings).toBe('unchanged');
    expect(result.claudeMd).toBe('unchanged');
  });

  it('does not duplicate permissions on re-run', async () => {
    await initProject(dir, { extPort: 3100 });
    await initProject(dir, { extPort: 3100 });

    const parsed = JSON.parse(await readFile(join(dir, '.claude', 'settings.local.json'), 'utf-8'));
    const traceCount = parsed.permissions.allow.filter((p: string) => p === 'mcp__ellmulator__trace').length;
    expect(traceCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Port change — updates URL
// ---------------------------------------------------------------------------

describe('initProject: port change', () => {
  it('updates .mcp.json URL when port changes', async () => {
    await initProject(dir, { extPort: 3100 });
    const result = await initProject(dir, { extPort: 4200 });

    expect(result.mcpJson).toBe('updated');
    const parsed = JSON.parse(await readFile(join(dir, '.mcp.json'), 'utf-8'));
    expect(parsed.mcpServers.ellmulator.url).toBe('http://localhost:4200/mcp');
  });
});

// ---------------------------------------------------------------------------
// 5. Edge: .mcp.json exists but no mcpServers key
// ---------------------------------------------------------------------------

describe('initProject: edge cases', () => {
  it('handles .mcp.json with no mcpServers key', async () => {
    await writeFile(join(dir, '.mcp.json'), JSON.stringify({ someKey: 'value' }, null, 2));

    const result = await initProject(dir, { extPort: 3100 });
    expect(result.mcpJson).toBe('updated');

    const parsed = JSON.parse(await readFile(join(dir, '.mcp.json'), 'utf-8'));
    expect(parsed.someKey).toBe('value');
    expect(parsed.mcpServers.ellmulator.url).toBe('http://localhost:3100/mcp');
  });
});
