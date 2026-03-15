/**
 * RED Phase Tests -- FR-012: Consolidate Handler
 *
 * SPEC grounding:
 *   consolidate:⚡λ → { total:int!, stale:int!, refreshed:int!, new:int! }
 *   - Scans project files via scanProjectFiles()
 *   - New files: register as cold, new_count++
 *   - Changed hash: mark stale, clear declarations+session, stale_count++
 *   - Unchanged: no action
 *   - Deleted: remove from registry
 *
 * Implementation: ./mcp-external.ts (consolidated external MCP handlers)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the claude-agent-sdk before other imports
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

import { Registry, type RegistryEntry, type RegistryStatus } from './registry.js';
import { SessionManager } from './session-manager.js';
import type { ScannedFile } from './scanner.js';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';
import {
  createConsolidateHandler,
  type ConsolidateDeps,
  type ConsolidateResult,
} from './mcp-external.js';

// Note: After unification, ConsolidateDeps is an alias for ConsolidateFlowDeps
// which requires a spawnSession dep. Tests below use reBootstrap=false (default)
// so spawnSession is never called, but it must be present in the deps shape.

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Helper to create mock AsyncGenerator for SDK query
function createMockQueryGenerator(messages: SDKMessage[]): AsyncGenerator<SDKMessage> {
  let index = 0;
  return {
    async next() {
      if (index < messages.length) {
        return { value: messages[index++], done: false };
      }
      return { value: undefined, done: true };
    },
    async return(value: any) {
      return { value, done: true };
    },
    async throw(e: any) {
      throw e;
    },
    [Symbol.asyncIterator]() {
      return this;
    },
  } as AsyncGenerator<SDKMessage>;
}

function makeEntry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    file_path: 'src/server.ts',
    file_hash: 'abc123def456',
    status: 'cold' as RegistryStatus,
    session_id: null,
    declarations: null,
    last_active: null,
    error: null,
    ...overrides,
  };
}

function makeScannedFile(overrides: Partial<ScannedFile> = {}): ScannedFile {
  return {
    path: 'src/server.ts',
    content: 'export function main() {}',
    hash: 'abc123def456',
    ...overrides,
  };
}

// ===========================================================================
// FR-012: Consolidate Handler
// ===========================================================================

describe('FR-012: createConsolidateHandler', () => {
  let registry: Registry;
  let sessionManager: SessionManager;
  let mockScanProjectFiles: ReturnType<typeof vi.fn>;
  let mockSpawnSession: ReturnType<typeof vi.fn>;
  let consolidate: (opts?: { reBootstrap?: boolean }) => Promise<ConsolidateResult>;

  beforeEach(() => {
    registry = new Registry();
    sessionManager = new SessionManager();
    mockScanProjectFiles = vi.fn<() => Promise<ScannedFile[]>>().mockResolvedValue([]);
    
    // Set up SDK mock to return proper messages
    const mockQuery = query as unknown as ReturnType<typeof vi.fn>;
    let sessionIdCounter = 0;
    mockQuery.mockImplementation(() => {
      const sessionId = `test-session-${++sessionIdCounter}`;
      const mockMessages: SDKMessage[] = [
        {
          type: 'system',
          subtype: 'init',
          session_id: sessionId,
        } as SDKMessage,
        {
          type: 'result',
          subtype: 'success',
          is_error: false,
          session_id: sessionId,
        } as SDKMessage,
      ];
      return createMockQueryGenerator(mockMessages);
    });
    
    mockSpawnSession = vi.fn<(filePath: string, fileHash: string) => Promise<string>>()
      .mockResolvedValue('mock-session-id');

    consolidate = createConsolidateHandler({
      registry,
      sessionManager,
      scanProjectFiles: mockScanProjectFiles,
      projectDir: '/test/project',
      spawnSession: mockSpawnSession,
    });
    
    vi.clearAllMocks();
  });

  // -------------------------------------------------------
  // Test 1: All scanned files are new
  // -------------------------------------------------------
  it('returns correct counts when all scanned files are new', async () => {
    mockScanProjectFiles.mockResolvedValue([
      makeScannedFile({ path: 'src/a.ts', hash: 'hash_a' }),
      makeScannedFile({ path: 'src/b.ts', hash: 'hash_b' }),
      makeScannedFile({ path: 'src/c.ts', hash: 'hash_c' }),
    ]);

    const result = await consolidate();

    expect(result).toEqual({ total: 3, stale: 0, refreshed: 0, new: 3 });
  });

  // -------------------------------------------------------
  // Test 2: Detects stale files (hash changed)
  // -------------------------------------------------------
  it('detects stale files when hash has changed', async () => {
    registry.add(makeEntry({
      file_path: 'src/server.ts',
      file_hash: 'old_hash',
      status: 'ready',
      declarations: {
        summary: 'Server', owns: [], imports: [], exports: [], dependencies: [],
      },
    }));

    mockScanProjectFiles.mockResolvedValue([
      makeScannedFile({ path: 'src/server.ts', hash: 'new_hash' }),
    ]);

    const result = await consolidate();

    expect(result.stale).toBe(1);
    expect(result.new).toBe(0);

    const entry = registry.get('src/server.ts');
    expect(entry!.file_hash).toBe('new_hash');
    expect(entry!.status).toBe('stale');
    expect(entry!.declarations).toBeNull();
    expect(entry!.session_id).toBeNull();
  });

  // -------------------------------------------------------
  // Test 3: Leaves unchanged files alone
  // -------------------------------------------------------
  it('leaves unchanged files alone when hash matches', async () => {
    registry.add(makeEntry({
      file_path: 'src/server.ts',
      file_hash: 'same_hash',
      status: 'ready',
      declarations: {
        summary: 'Existing', owns: [], imports: [], exports: [], dependencies: [],
      },
    }));

    mockScanProjectFiles.mockResolvedValue([
      makeScannedFile({ path: 'src/server.ts', hash: 'same_hash' }),
    ]);

    const result = await consolidate();

    expect(result.stale).toBe(0);
    expect(result.new).toBe(0);

    const entry = registry.get('src/server.ts');
    expect(entry!.status).toBe('ready');
    expect(entry!.declarations!.summary).toBe('Existing');
  });

  // -------------------------------------------------------
  // Test 4: Removes registry entries for deleted files
  // -------------------------------------------------------
  it('removes registry entries for files no longer on disk', async () => {
    registry.add(makeEntry({ file_path: 'src/deleted.ts', file_hash: 'hash_del' }));
    registry.add(makeEntry({ file_path: 'src/still-here.ts', file_hash: 'hash_still' }));

    mockScanProjectFiles.mockResolvedValue([
      makeScannedFile({ path: 'src/still-here.ts', hash: 'hash_still' }),
    ]);

    await consolidate();

    expect(registry.get('src/deleted.ts')).toBeUndefined();
    expect(registry.get('src/still-here.ts')).toBeDefined();
  });

  // -------------------------------------------------------
  // Test 5: Terminates session for stale files
  // -------------------------------------------------------
  it('terminates active session for stale files', async () => {
    const session = await sessionManager.create({
      filePath: 'src/server.ts',
      fileHash: 'old_hash',
      systemPrompt: 'Test prompt',
      bootstrapPrompt: 'Bootstrap test',
      cwd: '/test/project',
      tools: [],
      model: 'test-model',
    });

    registry.add(makeEntry({
      file_path: 'src/server.ts',
      file_hash: 'old_hash',
      status: 'ready',
      session_id: session.session_id,
    }));

    const terminateSpy = vi.spyOn(sessionManager, 'terminate');

    mockScanProjectFiles.mockResolvedValue([
      makeScannedFile({ path: 'src/server.ts', hash: 'changed_hash' }),
    ]);

    await consolidate();

    expect(terminateSpy).toHaveBeenCalledWith(session.session_id);
  });

  // -------------------------------------------------------
  // Test 6: Registers new files as cold
  // -------------------------------------------------------
  it('registers new files with cold status', async () => {
    mockScanProjectFiles.mockResolvedValue([
      makeScannedFile({ path: 'src/new-file.ts', hash: 'hash_new' }),
    ]);

    await consolidate();

    const entry = registry.get('src/new-file.ts');
    expect(entry).toBeDefined();
    expect(entry!.status).toBe('cold');
    expect(entry!.file_hash).toBe('hash_new');
    expect(entry!.session_id).toBeNull();
    expect(entry!.declarations).toBeNull();
  });

  // -------------------------------------------------------
  // Test 7: Returns total matching scan count
  // -------------------------------------------------------
  it('returns total matching scanned file count', async () => {
    mockScanProjectFiles.mockResolvedValue([
      makeScannedFile({ path: 'src/a.ts', hash: 'h1' }),
      makeScannedFile({ path: 'src/b.ts', hash: 'h2' }),
      makeScannedFile({ path: 'src/c.ts', hash: 'h3' }),
      makeScannedFile({ path: 'src/d.ts', hash: 'h4' }),
      makeScannedFile({ path: 'src/e.ts', hash: 'h5' }),
    ]);

    const result = await consolidate();

    expect(result.total).toBe(5);
  });

  // -------------------------------------------------------
  // Test 8: Handles empty scan
  // -------------------------------------------------------
  it('handles empty scan returning zero counts', async () => {
    mockScanProjectFiles.mockResolvedValue([]);

    const result = await consolidate();

    expect(result).toEqual({ total: 0, stale: 0, refreshed: 0, new: 0 });
  });

  // -------------------------------------------------------
  // Test 9: Mixed scenario
  // -------------------------------------------------------
  it('handles mixed: new + stale + unchanged + deleted', async () => {
    registry.add(makeEntry({
      file_path: 'src/unchanged.ts',
      file_hash: 'hash_unchanged',
      status: 'ready',
      declarations: {
        summary: 'Unchanged', owns: [], imports: [], exports: [], dependencies: [],
      },
    }));
    registry.add(makeEntry({
      file_path: 'src/stale.ts',
      file_hash: 'old_stale',
      status: 'ready',
    }));
    registry.add(makeEntry({
      file_path: 'src/deleted.ts',
      file_hash: 'hash_del',
    }));

    mockScanProjectFiles.mockResolvedValue([
      makeScannedFile({ path: 'src/unchanged.ts', hash: 'hash_unchanged' }),
      makeScannedFile({ path: 'src/stale.ts', hash: 'new_stale' }),
      makeScannedFile({ path: 'src/brand-new.ts', hash: 'hash_new' }),
    ]);

    const result = await consolidate();

    expect(result.total).toBe(3);
    expect(result.new).toBe(1);
    expect(result.stale).toBe(1);
    expect(result.refreshed).toBe(0);

    expect(registry.get('src/unchanged.ts')!.status).toBe('ready');
    expect(registry.get('src/stale.ts')!.status).toBe('stale');
    expect(registry.get('src/deleted.ts')).toBeUndefined();
    expect(registry.get('src/brand-new.ts')!.status).toBe('cold');
  });

  // -------------------------------------------------------
  // Test 10: refreshed is always 0
  // -------------------------------------------------------
  it('always returns refreshed as 0', async () => {
    registry.add(makeEntry({
      file_path: 'src/stale.ts',
      file_hash: 'old',
      status: 'ready',
    }));

    mockScanProjectFiles.mockResolvedValue([
      makeScannedFile({ path: 'src/stale.ts', hash: 'new' }),
      makeScannedFile({ path: 'src/fresh.ts', hash: 'fresh' }),
    ]);

    const result = await consolidate();

    expect(result.refreshed).toBe(0);
  });

  // -------------------------------------------------------
  // Test 11: Clears session_id on stale entries
  // -------------------------------------------------------
  it('clears session_id on stale entries', async () => {
    registry.add(makeEntry({
      file_path: 'src/orphaned.ts',
      file_hash: 'old',
      status: 'ready',
      session_id: 'sess-orphaned',
    }));

    mockScanProjectFiles.mockResolvedValue([
      makeScannedFile({ path: 'src/orphaned.ts', hash: 'new' }),
    ]);

    await consolidate();

    expect(registry.get('src/orphaned.ts')!.session_id).toBeNull();
  });

  // -------------------------------------------------------
  // Test 12: Removes all entries when scan is empty
  // -------------------------------------------------------
  it('removes all entries when scan returns empty', async () => {
    registry.add(makeEntry({ file_path: 'src/a.ts', file_hash: 'h1' }));
    registry.add(makeEntry({ file_path: 'src/b.ts', file_hash: 'h2' }));

    mockScanProjectFiles.mockResolvedValue([]);

    await consolidate();

    expect(registry.get('src/a.ts')).toBeUndefined();
    expect(registry.get('src/b.ts')).toBeUndefined();
    expect(registry.size).toBe(0);
  });
});
