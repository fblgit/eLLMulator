/**
 * RED phase tests for FR-002 — Scanner
 *
 * Tests for: scanProjectFiles, calculateHash, ScannedFile type
 *
 * These tests MUST fail — scanner.ts does not exist yet.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';

import { scanProjectFiles, calculateHash } from './scanner.js';
import type { ScannedFile } from './scanner.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let tempDir: string;

/** Create a temp directory for each test */
async function createTempProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'scanner-test-'));
}

/** Write a file inside the temp project, creating intermediate dirs */
async function writeProjectFile(base: string, relPath: string, content: string): Promise<void> {
  const fullPath = join(base, relPath);
  const dir = fullPath.substring(0, fullPath.lastIndexOf('/'));
  await mkdir(dir, { recursive: true });
  await writeFile(fullPath, content, 'utf-8');
}

/** Compute expected SHA256 hex digest for a string */
function expectedHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

beforeEach(async () => {
  tempDir = await createTempProject();
});

afterEach(async () => {
  await rm(tempDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// scanProjectFiles
// ---------------------------------------------------------------------------

describe('scanProjectFiles', () => {

  it('returns files from a directory', async () => {
    await writeProjectFile(tempDir, 'index.ts', 'export const x = 1;');
    await writeProjectFile(tempDir, 'utils.ts', 'export function add(a: number, b: number) { return a + b; }');

    const files = await scanProjectFiles(tempDir);

    expect(files).toBeInstanceOf(Array);
    expect(files.length).toBe(2);
  });

  it('filters by extensions — only includes matching files', async () => {
    await writeProjectFile(tempDir, 'main.ts', 'const a = 1;');
    await writeProjectFile(tempDir, 'style.css', 'body {}');
    await writeProjectFile(tempDir, 'readme.md', '# Readme');
    await writeProjectFile(tempDir, 'data.json', '{}');

    const files = await scanProjectFiles(tempDir);

    // Default extensions from SPEC: *.ts, *.go, *.py, *.js, *.tsx, *.jsx
    // Only main.ts should match
    const paths = files.map((f: ScannedFile) => f.path);
    expect(paths).toContain('main.ts');
    expect(paths).not.toContain('style.css');
    expect(paths).not.toContain('readme.md');
    expect(paths).not.toContain('data.json');
  });

  it('skips configured directories (.git, node_modules, vendor, dist, build, __pycache__)', async () => {
    await writeProjectFile(tempDir, 'src/app.ts', 'export const app = true;');
    await writeProjectFile(tempDir, 'node_modules/dep/index.ts', 'module.exports = {};');
    await writeProjectFile(tempDir, '.git/objects/ab.ts', 'git object');
    await writeProjectFile(tempDir, 'vendor/lib.go', 'package lib');
    await writeProjectFile(tempDir, 'dist/out.js', 'compiled');
    await writeProjectFile(tempDir, 'build/output.js', 'compiled');
    await writeProjectFile(tempDir, '__pycache__/mod.py', 'cached');

    const files = await scanProjectFiles(tempDir);

    const paths = files.map((f: ScannedFile) => f.path);
    expect(paths).toContain('src/app.ts');
    expect(paths).not.toContain('node_modules/dep/index.ts');
    expect(paths).not.toContain('.git/objects/ab.ts');
    expect(paths).not.toContain('vendor/lib.go');
    expect(paths).not.toContain('dist/out.js');
    expect(paths).not.toContain('build/output.js');
    expect(paths).not.toContain('__pycache__/mod.py');
  });

  it('skips patterns (*.test.*, *.spec.*, *.d.ts)', async () => {
    await writeProjectFile(tempDir, 'app.ts', 'const a = 1;');
    await writeProjectFile(tempDir, 'app.test.ts', 'test("it works", () => {});');
    await writeProjectFile(tempDir, 'app.spec.ts', 'describe("app", () => {});');
    await writeProjectFile(tempDir, 'types.d.ts', 'declare module "x";');

    const files = await scanProjectFiles(tempDir);

    const paths = files.map((f: ScannedFile) => f.path);
    expect(paths).toContain('app.ts');
    expect(paths).not.toContain('app.test.ts');
    expect(paths).not.toContain('app.spec.ts');
    expect(paths).not.toContain('types.d.ts');
  });

  it('returns relative paths, not absolute', async () => {
    await writeProjectFile(tempDir, 'src/deep/nested/file.ts', 'export const deep = true;');

    const files = await scanProjectFiles(tempDir);

    expect(files.length).toBe(1);
    const filePath = files[0].path;
    // Must be relative — no leading slash, no temp dir prefix
    expect(filePath).toBe('src/deep/nested/file.ts');
    expect(filePath.startsWith('/')).toBe(false);
    expect(filePath.includes(tmpdir())).toBe(false);
  });

  it('handles empty directory (returns empty array)', async () => {
    const files = await scanProjectFiles(tempDir);

    expect(files).toBeInstanceOf(Array);
    expect(files.length).toBe(0);
  });

  it('handles nested directories recursively', async () => {
    await writeProjectFile(tempDir, 'a.ts', 'const a = 1;');
    await writeProjectFile(tempDir, 'src/b.ts', 'const b = 2;');
    await writeProjectFile(tempDir, 'src/utils/c.ts', 'const c = 3;');
    await writeProjectFile(tempDir, 'src/utils/deep/d.ts', 'const d = 4;');

    const files = await scanProjectFiles(tempDir);

    const paths = files.map((f: ScannedFile) => f.path);
    expect(paths).toContain('a.ts');
    expect(paths).toContain('src/b.ts');
    expect(paths).toContain('src/utils/c.ts');
    expect(paths).toContain('src/utils/deep/d.ts');
    expect(files.length).toBe(4);
  });

  it('each ScannedFile has path, content, and hash fields', async () => {
    const sourceContent = 'export function greet(name: string) { return `Hello ${name}`; }';
    await writeProjectFile(tempDir, 'greet.ts', sourceContent);

    const files = await scanProjectFiles(tempDir);

    expect(files.length).toBe(1);
    const file = files[0];

    // Structural assertion: all three fields present and correctly typed
    expect(file).toHaveProperty('path');
    expect(file).toHaveProperty('content');
    expect(file).toHaveProperty('hash');
    expect(typeof file.path).toBe('string');
    expect(typeof file.content).toBe('string');
    expect(typeof file.hash).toBe('string');

    // Value assertions: content matches what was written, hash is correct
    expect(file.path).toBe('greet.ts');
    expect(file.content).toBe(sourceContent);
    expect(file.hash).toBe(expectedHash(sourceContent));
  });

  it('accepts optional config to override extensions, skip_dirs, and skip_patterns', async () => {
    await writeProjectFile(tempDir, 'data.json', '{"key": "value"}');
    await writeProjectFile(tempDir, 'app.ts', 'const x = 1;');
    await writeProjectFile(tempDir, 'custom_skip/inner.json', '{}');

    const config = {
      extensions: ['*.json'],
      skip_dirs: ['custom_skip'],
      skip_patterns: [] as string[],
    };

    const files = await scanProjectFiles(tempDir, config);

    const paths = files.map((f: ScannedFile) => f.path);
    // With custom config: only .json, skip custom_skip dir
    expect(paths).toContain('data.json');
    expect(paths).not.toContain('app.ts');
    expect(paths).not.toContain('custom_skip/inner.json');
  });
});

// ---------------------------------------------------------------------------
// calculateHash
// ---------------------------------------------------------------------------

describe('calculateHash', () => {

  it('returns consistent SHA256 hex digest for same content', () => {
    const content = 'Hello, World!';
    const hash1 = calculateHash(content);
    const hash2 = calculateHash(content);

    expect(hash1).toBe(hash2);
    // Verify it is indeed SHA256
    expect(hash1).toBe(expectedHash(content));
    // SHA256 hex is always 64 characters
    expect(hash1).toHaveLength(64);
    // Must be hex
    expect(hash1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('returns different hashes for different content', () => {
    const hash1 = calculateHash('content A');
    const hash2 = calculateHash('content B');

    expect(hash1).not.toBe(hash2);
  });
});
