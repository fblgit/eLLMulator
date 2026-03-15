/**
 * FR-014: Bootstrap Flow
 *
 * Factory-pattern handler that scans a project directory, registers all files
 * as cold in the registry, then spawns agent sessions with bounded concurrency.
 *
 * SPEC: bootstrap:lambda(project_dir:str!, config:BootstrapConfig) -> BootstrapResult
 */

import type { ScannedFile, ScanConfig } from './scanner.js';
import type { RegistryEntry, RegistryStatus } from './registry.js';
import type { AgentSession } from './session-manager.js';
import { renderBootstrapPrompt } from './templates.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type BootstrapConfig = {
  threads: number;
  extensions: string[];
  skip_dirs: string[];
  skip_patterns: string[];
  force?: boolean;
};

export type BootstrapResult = {
  total: number;
  ready: number;
  errors: Array<{ path: string; error: string }>;
};

export type BootstrapDeps = {
  scanner: {
    scanProjectFiles: (projectDir: string, config?: ScanConfig) => Promise<ScannedFile[]>;
  };
  registry: {
    add: (entry: RegistryEntry) => void;
    get: (filePath: string) => RegistryEntry | undefined;
    list: () => RegistryEntry[];
    listByStatus: (status: RegistryStatus) => RegistryEntry[];
    update: (filePath: string, updates: Partial<Omit<RegistryEntry, 'file_path'>>) => void;
  };
  sessionManager: {
    create: (opts: { filePath: string; fileHash: string; bootstrapPrompt?: string }) => Promise<AgentSession>;
    terminate: (sessionId: string) => Promise<void>;
  };
  /** Called per-file immediately after session_id is set on registry. Use for persistence. */
  onSessionReady?: (filePath: string, entry: RegistryEntry) => void;
};

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const DEFAULT_CONFIG: BootstrapConfig = {
  threads: 10,
  extensions: ['*.ts', '*.go', '*.py', '*.js', '*.tsx', '*.jsx'],
  skip_dirs: ['.git', 'node_modules', 'vendor', 'dist', 'build', '__pycache__'],
  skip_patterns: ['*.test.*', '*.spec.*', '*.d.ts'],
};

// ---------------------------------------------------------------------------
// Bounded concurrency helper
// ---------------------------------------------------------------------------

async function runWithConcurrency<T>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<void>,
): Promise<void> {
  const executing: Promise<void>[] = [];
  for (const item of items) {
    const p = fn(item).then(() => {
      executing.splice(executing.indexOf(p), 1);
    });
    executing.push(p);
    if (executing.length >= limit) {
      await Promise.race(executing);
    }
  }
  await Promise.all(executing);
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createBootstrapHandler(
  deps: BootstrapDeps,
): (projectDir: string, config?: Partial<BootstrapConfig>) => Promise<BootstrapResult> {
  return async (
    projectDir: string,
    config?: Partial<BootstrapConfig>,
  ): Promise<BootstrapResult> => {
    const merged: BootstrapConfig = {
      threads: config?.threads ?? DEFAULT_CONFIG.threads,
      extensions: config?.extensions ?? DEFAULT_CONFIG.extensions,
      skip_dirs: config?.skip_dirs ?? DEFAULT_CONFIG.skip_dirs,
      skip_patterns: config?.skip_patterns ?? DEFAULT_CONFIG.skip_patterns,
    };

    // 1. Scan project files
    const scanConfig: ScanConfig = {
      extensions: merged.extensions,
      skip_dirs: merged.skip_dirs,
      skip_patterns: merged.skip_patterns,
    };

    const scannedFiles = await deps.scanner.scanProjectFiles(projectDir, scanConfig);

    // 2. Register files — skip already-ready files with matching hash (unless force)
    const filesToBootstrap: ScannedFile[] = [];
    let skipped = 0;

    for (const file of scannedFiles) {
      const existing = deps.registry.get(file.path);

      if (existing) {
        // File already in registry
        if (!merged.force && existing.status === 'ready' && existing.file_hash === file.hash) {
          // Already bootstrapped with same hash — skip
          skipped++;
          continue;
        }
        // Hash changed or force — mark stale/cold for re-bootstrap
        if (existing.status === 'ready' && existing.file_hash !== file.hash) {
          deps.registry.update(file.path, { file_hash: file.hash });
          // hash change on ready → auto-stale via side effect
        }
        filesToBootstrap.push(file);
      } else {
        // New file — register as cold
        deps.registry.add({
          file_path: file.path,
          file_hash: file.hash,
          status: 'cold' as RegistryStatus,
          session_id: null,
          declarations: null,
          last_active: null,
          error: null,
        });
        filesToBootstrap.push(file);
      }
    }

    // 3. Spawn agent sessions with bounded concurrency, collecting errors
    const errors: Array<{ path: string; error: string }> = [];
    let ready = skipped; // count already-ready as ready

    await runWithConcurrency(filesToBootstrap, merged.threads, async (file) => {
      try {
        // Mark as bootstrapping before spawning agent
        const entry = deps.registry.get(file.path);
        if (entry && (entry.status === 'cold' || entry.status === 'stale')) {
          deps.registry.update(file.path, { status: 'bootstrapping' });
        }

        const bootstrapPrompt = renderBootstrapPrompt({ filePath: file.path });
        const session = await deps.sessionManager.create({
          filePath: file.path,
          fileHash: file.hash,
          bootstrapPrompt,
        });
        deps.registry.update(file.path, { session_id: session.session_id });
        // Persist immediately — don't wait for the whole batch
        if (deps.onSessionReady) {
          const updated = deps.registry.get(file.path);
          if (updated) deps.onSessionReady(file.path, updated);
        }
        ready++;
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push({ path: file.path, error: message });
      }
    });

    return {
      total: scannedFiles.length,
      ready,
      errors,
    };
  };
}
