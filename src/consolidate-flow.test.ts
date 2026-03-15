/**
 * FR-016: Consolidate Flow Enhancement Tests
 *
 * SPEC grounding:
 *   consolidate:lambda -> { total:int!, stale:int!, refreshed:int!, new:int! }
 *   Enhancement: when reBootstrap=true, stale files get new sessions spawned.
 *   refreshed = count of stale files successfully re-bootstrapped.
 *   On re-bootstrap failure: file stays stale, not counted as refreshed.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the claude-agent-sdk before other imports
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: vi.fn(),
}));

import { Registry, type RegistryEntry, type RegistryStatus } from './registry.js';
import { SessionManager } from './session-manager.js';
import type { ScannedFile } from './scanner.js';
import type { ConsolidateResult } from './types.js';
import type { SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { query } from '@anthropic-ai/claude-agent-sdk';

import {
  createConsolidateFlowHandler,
  type ConsolidateFlowDeps,
} from './consolidate-flow.js';

// ---------------------------------------------------------------------------
// Helpers (same pattern as consolidate-handler.test.ts)
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
// FR-016: Consolidate Flow Enhancement
// ===========================================================================

describe('FR-016: createConsolidateFlowHandler', () => {
  let registry: Registry;
  let sessionManager: SessionManager;
  let mockScanProjectFiles: ReturnType<typeof vi.fn>;
  let mockSpawnSession: ReturnType<typeof vi.fn>;

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
    
    // Mock spawn function: simulates creating a new session for a stale file.
    // Returns a session_id on success, throws on failure.
    mockSpawnSession = vi.fn<(filePath: string, fileHash: string) => Promise<string>>()
      .mockImplementation(async (_filePath: string, _fileHash: string) => {
        const session = await sessionManager.create({
          filePath: _filePath,
          fileHash: _fileHash,
          systemPrompt: 'Test prompt',
          bootstrapPrompt: 'Bootstrap test',
          cwd: '/test/project',
          tools: [],
          model: 'test-model',
        });
        return session.session_id;
      });
    
    vi.clearAllMocks();
  });

  function makeDeps(overrides: Partial<ConsolidateFlowDeps> = {}): ConsolidateFlowDeps {
    return {
      registry,
      sessionManager,
      scanProjectFiles: mockScanProjectFiles,
      projectDir: '/test/project',
      spawnSession: mockSpawnSession,
      ...overrides,
    } as ConsolidateFlowDeps;
  }

  // -------------------------------------------------------
  // Test 1: Handler exists and is importable
  // -------------------------------------------------------
  it('createConsolidateFlowHandler is a function', () => {
    expect(typeof createConsolidateFlowHandler).toBe('function');
  });

  // -------------------------------------------------------
  // Test 2: reBootstrap=false => refreshed=0 (existing behavior)
  // -------------------------------------------------------
  it('returns refreshed=0 when reBootstrap is false', async () => {
    registry.add(makeEntry({
      file_path: 'src/stale.ts',
      file_hash: 'old_hash',
      status: 'ready',
    }));

    mockScanProjectFiles.mockResolvedValue([
      makeScannedFile({ path: 'src/stale.ts', hash: 'new_hash' }),
    ]);

    const handler = createConsolidateFlowHandler(makeDeps());
    const result = await handler({ reBootstrap: false });

    expect(result.refreshed).toBe(0);
    expect(result.stale).toBe(1);
    expect(mockSpawnSession).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------
  // Test 3: reBootstrap=true, stale files exist => refreshed > 0
  // -------------------------------------------------------
  it('re-bootstraps stale files when reBootstrap is true', async () => {
    registry.add(makeEntry({
      file_path: 'src/changed.ts',
      file_hash: 'old_hash',
      status: 'ready',
      session_id: 'sess-old',
    }));

    mockScanProjectFiles.mockResolvedValue([
      makeScannedFile({ path: 'src/changed.ts', hash: 'new_hash' }),
    ]);

    const handler = createConsolidateFlowHandler(makeDeps());
    const result = await handler({ reBootstrap: true });

    expect(result.stale).toBe(1);
    expect(result.refreshed).toBe(1);
    expect(mockSpawnSession).toHaveBeenCalledWith('src/changed.ts', 'new_hash');
  });

  // -------------------------------------------------------
  // Test 4: reBootstrap=true, no stale files => refreshed=0
  // -------------------------------------------------------
  it('returns refreshed=0 when reBootstrap is true but no files are stale', async () => {
    mockScanProjectFiles.mockResolvedValue([
      makeScannedFile({ path: 'src/brand-new.ts', hash: 'hash_new' }),
    ]);

    const handler = createConsolidateFlowHandler(makeDeps());
    const result = await handler({ reBootstrap: true });

    expect(result.refreshed).toBe(0);
    expect(result.new).toBe(1);
    expect(result.stale).toBe(0);
    expect(mockSpawnSession).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------
  // Test 5: reBootstrap=true, spawn fails => NOT counted as refreshed
  // -------------------------------------------------------
  it('does not count failed re-bootstrap as refreshed', async () => {
    registry.add(makeEntry({
      file_path: 'src/failing.ts',
      file_hash: 'old_hash',
      status: 'ready',
    }));

    mockScanProjectFiles.mockResolvedValue([
      makeScannedFile({ path: 'src/failing.ts', hash: 'new_hash' }),
    ]);

    // Spawn throws for this file
    mockSpawnSession.mockRejectedValueOnce(new Error('SPAWN_FAILED'));

    const handler = createConsolidateFlowHandler(makeDeps());
    const result = await handler({ reBootstrap: true });

    expect(result.stale).toBe(1);
    expect(result.refreshed).toBe(0);
    // File should still be stale, not crashed
    const entry = registry.get('src/failing.ts');
    expect(entry).toBeDefined();
    expect(entry!.status).toBe('stale');
  });

  // -------------------------------------------------------
  // Test 6: reBootstrap=true, mixed success/failure
  // -------------------------------------------------------
  it('refreshed counts only successful re-bootstraps in mixed scenario', async () => {
    // Three files that will be stale
    registry.add(makeEntry({
      file_path: 'src/ok1.ts',
      file_hash: 'old1',
      status: 'ready',
    }));
    registry.add(makeEntry({
      file_path: 'src/fail.ts',
      file_hash: 'old2',
      status: 'ready',
    }));
    registry.add(makeEntry({
      file_path: 'src/ok2.ts',
      file_hash: 'old3',
      status: 'ready',
    }));

    mockScanProjectFiles.mockResolvedValue([
      makeScannedFile({ path: 'src/ok1.ts', hash: 'new1' }),
      makeScannedFile({ path: 'src/fail.ts', hash: 'new2' }),
      makeScannedFile({ path: 'src/ok2.ts', hash: 'new3' }),
    ]);

    // Second call fails
    mockSpawnSession
      .mockResolvedValueOnce('sess-ok1')     // src/ok1.ts succeeds
      .mockRejectedValueOnce(new Error('SPAWN_FAILED'))  // src/fail.ts fails
      .mockResolvedValueOnce('sess-ok2');     // src/ok2.ts succeeds

    const handler = createConsolidateFlowHandler(makeDeps());
    const result = await handler({ reBootstrap: true });

    expect(result.stale).toBe(3);
    expect(result.refreshed).toBe(2);
    expect(result.total).toBe(3);
  });

  // -------------------------------------------------------
  // Test 7: Stale files get new session_id after re-bootstrap
  // -------------------------------------------------------
  it('assigns new session_id to re-bootstrapped files', async () => {
    registry.add(makeEntry({
      file_path: 'src/target.ts',
      file_hash: 'old_hash',
      status: 'ready',
      session_id: 'sess-old',
    }));

    mockScanProjectFiles.mockResolvedValue([
      makeScannedFile({ path: 'src/target.ts', hash: 'new_hash' }),
    ]);

    mockSpawnSession.mockResolvedValueOnce('sess-new-uuid');

    const handler = createConsolidateFlowHandler(makeDeps());
    await handler({ reBootstrap: true });

    const entry = registry.get('src/target.ts');
    expect(entry).toBeDefined();
    expect(entry!.session_id).toBe('sess-new-uuid');
    expect(entry!.session_id).not.toBe('sess-old');
  });

  // -------------------------------------------------------
  // Test 8: total/stale/new counts not affected by re-bootstrap
  // -------------------------------------------------------
  it('preserves total, stale, and new counts regardless of re-bootstrap', async () => {
    // Set up mixed scenario: 1 unchanged, 2 stale, 1 new
    registry.add(makeEntry({
      file_path: 'src/unchanged.ts',
      file_hash: 'hash_same',
      status: 'ready',
      declarations: {
        summary: 'Unchanged', owns: [], imports: [], exports: [], dependencies: [],
      },
    }));
    registry.add(makeEntry({
      file_path: 'src/stale1.ts',
      file_hash: 'old1',
      status: 'ready',
    }));
    registry.add(makeEntry({
      file_path: 'src/stale2.ts',
      file_hash: 'old2',
      status: 'ready',
    }));

    mockScanProjectFiles.mockResolvedValue([
      makeScannedFile({ path: 'src/unchanged.ts', hash: 'hash_same' }),
      makeScannedFile({ path: 'src/stale1.ts', hash: 'changed1' }),
      makeScannedFile({ path: 'src/stale2.ts', hash: 'changed2' }),
      makeScannedFile({ path: 'src/brand-new.ts', hash: 'hash_new' }),
    ]);

    const handler = createConsolidateFlowHandler(makeDeps());
    const result = await handler({ reBootstrap: true });

    // These counts must match what the base consolidation logic computes,
    // independent of whether re-bootstrap is enabled.
    expect(result.total).toBe(4);
    expect(result.stale).toBe(2);
    expect(result.new).toBe(1);
    // refreshed is additive info, does not change the above
    expect(result.refreshed).toBe(2);
  });
});
