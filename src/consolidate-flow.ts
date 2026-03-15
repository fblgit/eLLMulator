/**
 * FR-016: Consolidate Flow Enhancement
 *
 * Extends the base consolidate logic with optional re-bootstrap capability.
 * When reBootstrap=true, stale files get new sessions spawned via spawnSession.
 * refreshed = count of stale files successfully re-bootstrapped.
 *
 * Factory: createConsolidateFlowHandler(deps) => async ({ reBootstrap }) => ConsolidateResult
 */

import type { Registry } from './registry.js';
import type { SessionManager } from './session-manager.js';
import type { ScannedFile } from './scanner.js';
import type { ConsolidateResult } from './types.js';

// ---------------------------------------------------------------------------
// Deps type
// ---------------------------------------------------------------------------

export type ConsolidateFlowDeps = {
  registry: Registry;
  sessionManager: SessionManager;
  scanProjectFiles: () => Promise<ScannedFile[]>;
  projectDir: string;
  spawnSession: (filePath: string, fileHash: string) => Promise<string>;
};

// ---------------------------------------------------------------------------
// Handler factory
// ---------------------------------------------------------------------------

export function createConsolidateFlowHandler(
  deps: ConsolidateFlowDeps,
): (opts?: { reBootstrap?: boolean }) => Promise<ConsolidateResult> {
  return async (opts?: { reBootstrap?: boolean }): Promise<ConsolidateResult> => {
    const reBootstrap = opts?.reBootstrap ?? false;
    let staleCount = 0;
    let newCount = 0;
    let refreshedCount = 0;

    const currentFiles = await deps.scanProjectFiles();
    const scannedPaths = new Set(currentFiles.map((f) => f.path));

    // Track stale files for potential re-bootstrap
    const staleFiles: { path: string; hash: string }[] = [];

    // Process each scanned file
    for (const file of currentFiles) {
      const entry = deps.registry.get(file.path);

      if (!entry) {
        // New file: register as cold
        deps.registry.add({
          file_path: file.path,
          file_hash: file.hash,
          status: 'cold',
          session_id: null,
          declarations: null,
          last_active: null,
          error: null,
        });
        newCount++;
      } else if (entry.file_hash !== file.hash) {
        // Hash changed: mark stale
        // Terminate session if exists
        if (entry.session_id) {
          await deps.sessionManager.terminate(entry.session_id);
        }

        // Update registry: new hash triggers ready->stale side effect,
        // which automatically clears declarations and session_id
        deps.registry.update(file.path, {
          file_hash: file.hash,
        });

        staleCount++;
        staleFiles.push({ path: file.path, hash: file.hash });
      }
      // Hash unchanged: no action
    }

    // Remove entries for deleted files
    const allEntries = deps.registry.list();
    for (const entry of allEntries) {
      if (!scannedPaths.has(entry.file_path)) {
        deps.registry.remove(entry.file_path);
      }
    }

    // Re-bootstrap stale files when requested
    if (reBootstrap) {
      for (const staleFile of staleFiles) {
        try {
          const sessionId = await deps.spawnSession(staleFile.path, staleFile.hash);
          // Update registry with new session_id
          deps.registry.update(staleFile.path, { session_id: sessionId });
          refreshedCount++;
        } catch {
          // Spawn failed: file stays stale, not counted as refreshed
        }
      }
    }

    return {
      total: currentFiles.length,
      stale: staleCount,
      refreshed: refreshedCount,
      new: newCount,
    };
  };
}
