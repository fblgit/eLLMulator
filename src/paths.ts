/**
 * Shared path resolution utilities.
 *
 * Extracted from invoke.ts for reuse in register handler (path normalization at registration time).
 */

import { dirname, posix } from 'node:path';

/**
 * Extension variants tried when resolving dependency paths against the registry.
 * Order matters — .ts first since this is primarily a TypeScript project.
 */
export const EXTENSION_VARIANTS = ['.ts', '.tsx', '.js', '.jsx', '.py', '.go', ''];

/**
 * Resolve a dependency path to a canonical registry key.
 *
 * Bootstrap agents store dependencies in various formats:
 *   ./registry        (relative, no extension)
 *   ./registry.js     (relative, .js extension — TS import convention)
 *   ./types.ts        (relative, .ts extension)
 *
 * Registry keys use project-relative paths with real extensions:
 *   src/registry.ts, src/types.ts, etc.
 *
 * Resolution: resolve relative to the source file's directory, then try
 * extension variants against the registry.
 */
export function resolveDepPath(
  depPath: string,
  sourceFile: string,
  registry: { get(path: string): unknown },
): string | null {
  // 1. Direct match (unlikely but check first)
  if (registry.get(depPath)) return depPath;

  // 2. Resolve relative to source file directory
  const sourceDir = dirname(sourceFile);
  const resolved = posix.normalize(posix.join(sourceDir, depPath));

  // Try direct resolved path
  if (registry.get(resolved)) return resolved;

  // 3. Strip any extension and try all variants
  const stripped = resolved.replace(/\.(ts|tsx|js|jsx|py|go)$/, '');
  for (const ext of EXTENSION_VARIANTS) {
    const candidate = stripped + ext;
    if (registry.get(candidate)) return candidate;
  }

  return null;
}
