/**
 * FR-002 — Scanner
 *
 * Scans project directories for source files, returning relative paths,
 * file content, and SHA256 hashes.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join, relative, posix } from 'node:path';
import { createHash } from 'node:crypto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ScannedFile = {
  path: string;
  content: string;
  hash: string;
};

export type ScanConfig = {
  extensions?: string[];
  skip_dirs?: string[];
  skip_patterns?: string[];
};

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_EXTENSIONS = ['*.ts', '*.go', '*.py', '*.js', '*.tsx', '*.jsx'];
const DEFAULT_SKIP_DIRS = ['.git', 'node_modules', 'vendor', 'dist', 'build', '__pycache__'];
const DEFAULT_SKIP_PATTERNS = ['*.test.*', '*.spec.*', '*.d.ts'];

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute SHA256 hex digest of a string.
 */
export function calculateHash(content: string): string {
  return createHash('sha256').update(content).digest('hex');
}

/**
 * Extract import/dependency file paths from source content (pre-bootstrap).
 *
 * Handles ES6 imports, type imports, re-exports, and CommonJS require.
 * Only relative imports (starting with . or ..) are returned.
 * Paths are resolved against the importing file's directory and deduplicated.
 * Extensions (.ts, .js, .tsx, .jsx) are stripped from the resolved paths.
 */
export function extractImports(content: string, filePath: string): string[] {
  const dir = posix.dirname(filePath);
  const specifiers: string[] = [];

  // ES6 imports and re-exports: import/export ... from '...'
  const fromPattern = /(?:import|export)\s+(?:type\s+)?[^'"]*from\s+['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = fromPattern.exec(content)) !== null) {
    specifiers.push(match[1]);
  }

  // CommonJS require('...')
  const requirePattern = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  while ((match = requirePattern.exec(content)) !== null) {
    specifiers.push(match[1]);
  }

  // Filter to relative only, resolve, strip extensions, deduplicate
  const seen = new Set<string>();
  const result: string[] = [];

  for (const spec of specifiers) {
    if (!spec.startsWith('.')) continue; // skip package/node imports

    // Strip known extensions from the specifier
    const stripped = spec.replace(/\.(tsx?|jsx?)$/, '');

    // Resolve against the importing file's directory
    const resolved = posix.normalize(posix.join(dir, stripped));

    if (!seen.has(resolved)) {
      seen.add(resolved);
      result.push(resolved);
    }
  }

  return result;
}

/**
 * Recursively scan a project directory and return matching files.
 */
export async function scanProjectFiles(
  projectDir: string,
  config?: ScanConfig,
): Promise<ScannedFile[]> {
  const extensions = config?.extensions ?? DEFAULT_EXTENSIONS;
  const skipDirs = config?.skip_dirs ?? DEFAULT_SKIP_DIRS;
  const skipPatterns = config?.skip_patterns ?? DEFAULT_SKIP_PATTERNS;

  const results: ScannedFile[] = [];
  await walk(projectDir, projectDir, extensions, skipDirs, skipPatterns, results);
  return results;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function walk(
  root: string,
  dir: string,
  extensions: string[],
  skipDirs: string[],
  skipPatterns: string[],
  results: ScannedFile[],
): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true });

  for (const entry of entries) {
    const fullPath = join(dir, entry.name);

    if (entry.isDirectory()) {
      if (skipDirs.includes(entry.name)) continue;
      await walk(root, fullPath, extensions, skipDirs, skipPatterns, results);
    } else if (entry.isFile()) {
      if (!matchesExtension(entry.name, extensions)) continue;
      if (matchesSkipPattern(entry.name, skipPatterns)) continue;

      const content = await readFile(fullPath, 'utf-8');
      const relPath = relative(root, fullPath).split('\\').join('/');

      results.push({
        path: relPath,
        content,
        hash: calculateHash(content),
      });
    }
  }
}

/**
 * Check if a filename matches any of the extension globs.
 * Globs are in the form "*.ext" — we extract the extension and compare.
 */
function matchesExtension(filename: string, extensions: string[]): boolean {
  for (const pattern of extensions) {
    // pattern like "*.ts" or "*.tsx"
    const ext = pattern.replace('*', '');  // ".ts", ".tsx", etc.
    if (filename.endsWith(ext)) return true;
  }
  return false;
}

/**
 * Check if a filename matches any skip pattern.
 * Supported patterns: "*.test.*", "*.spec.*", "*.d.ts"
 */
function matchesSkipPattern(filename: string, patterns: string[]): boolean {
  for (const pattern of patterns) {
    if (globMatch(filename, pattern)) return true;
  }
  return false;
}

/**
 * Minimal glob matching for skip patterns.
 * Handles: "*.test.*", "*.spec.*", "*.d.ts"
 */
function globMatch(filename: string, pattern: string): boolean {
  // Convert glob pattern to regex:
  // - escape dots
  // - replace * with [^]* (match any chars)
  const regexStr = '^' + pattern
    .replace(/\./g, '\\.')
    .replace(/\*/g, '.*') + '$';
  return new RegExp(regexStr).test(filename);
}
