/**
 * FR-014: Bootstrap Flow Tests
 *
 * SPEC grounding:
 *   bootstrap:lambda(project_dir:str!, config:BootstrapConfig) -> BootstrapResult
 *   BootstrapConfig:{ threads:int[1,50]=10, extensions, skip_dirs, skip_patterns }
 *   BootstrapResult:{ total:int!, ready:int!, errors:[{ path:str!, error:str! }]? }
 *
 * Tests verify: type shapes, factory DI pattern, default config values,
 * concurrent spawn bounded by threads, bulk register as cold, error collection,
 * result counts, empty project handling.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

import {
  createBootstrapHandler,
  type BootstrapConfig,
  type BootstrapResult,
  type BootstrapDeps,
} from './bootstrap.js';

import type { ScannedFile } from './scanner.js';
import type { RegistryEntry, RegistryStatus } from './registry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeScannedFile(overrides: Partial<ScannedFile> = {}): ScannedFile {
  return {
    path: 'src/server.ts',
    content: 'export function main() {}',
    hash: 'abc123def456',
    ...overrides,
  };
}

function makeRegistryEntry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
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

// ---------------------------------------------------------------------------
// Mock deps factory
// ---------------------------------------------------------------------------

function createMockDeps(overrides: Partial<BootstrapDeps> = {}): BootstrapDeps {
  return {
    scanner: {
      scanProjectFiles: vi.fn<() => Promise<ScannedFile[]>>().mockResolvedValue([]),
    },
    registry: {
      add: vi.fn(),
      get: vi.fn().mockReturnValue(undefined),
      list: vi.fn().mockReturnValue([]),
      listByStatus: vi.fn().mockReturnValue([]),
      update: vi.fn(),
    },
    sessionManager: {
      create: vi.fn().mockResolvedValue({
        session_id: 'mock-session-001',
        file_path: 'src/server.ts',
        created_at: new Date(),
        file_hash: 'abc123',
        status: 'active',
      }),
      terminate: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  };
}

// ===========================================================================
// FR-014: Bootstrap Flow
// ===========================================================================

describe('FR-014: createBootstrapHandler', () => {
  let deps: BootstrapDeps;
  let bootstrap: (projectDir: string, config?: Partial<BootstrapConfig>) => Promise<BootstrapResult>;

  beforeEach(() => {
    deps = createMockDeps();
    bootstrap = createBootstrapHandler(deps);
  });

  // -------------------------------------------------------
  // Test 1: BootstrapConfig type shape
  // -------------------------------------------------------
  it('BootstrapConfig has threads, extensions, skip_dirs, skip_patterns fields', () => {
    const config: BootstrapConfig = {
      threads: 10,
      extensions: ['*.ts', '*.go', '*.py', '*.js', '*.tsx', '*.jsx'],
      skip_dirs: ['.git', 'node_modules', 'vendor', 'dist', 'build', '__pycache__'],
      skip_patterns: ['*.test.*', '*.spec.*', '*.d.ts'],
    };

    expect(config).toHaveProperty('threads');
    expect(config).toHaveProperty('extensions');
    expect(config).toHaveProperty('skip_dirs');
    expect(config).toHaveProperty('skip_patterns');
    expect(typeof config.threads).toBe('number');
    expect(Array.isArray(config.extensions)).toBe(true);
    expect(Array.isArray(config.skip_dirs)).toBe(true);
    expect(Array.isArray(config.skip_patterns)).toBe(true);
  });

  // -------------------------------------------------------
  // Test 2: BootstrapResult type shape
  // -------------------------------------------------------
  it('BootstrapResult has total, ready, and optional errors fields', async () => {
    const result = await bootstrap('/test/project');

    expect(result).toHaveProperty('total');
    expect(result).toHaveProperty('ready');
    expect(typeof result.total).toBe('number');
    expect(typeof result.ready).toBe('number');
    // errors is optional but when present must be an array
    if (result.errors !== undefined) {
      expect(Array.isArray(result.errors)).toBe(true);
    }
  });

  // -------------------------------------------------------
  // Test 3: Factory returns callable function
  // -------------------------------------------------------
  it('createBootstrapHandler returns a function', () => {
    const handler = createBootstrapHandler(deps);

    expect(typeof handler).toBe('function');
  });

  // -------------------------------------------------------
  // Test 4: Lambda signature -- bootstrap(projectDir, config?) returns Promise<BootstrapResult>
  // -------------------------------------------------------
  it('bootstrap(projectDir, config?) returns a Promise<BootstrapResult>', async () => {
    const resultPromise = bootstrap('/test/project');

    expect(resultPromise).toBeInstanceOf(Promise);

    const result = await resultPromise;

    expect(result).toHaveProperty('total');
    expect(result).toHaveProperty('ready');
  });

  // -------------------------------------------------------
  // Test 5: Default values -- threads=10, extensions, skip_dirs, skip_patterns
  // -------------------------------------------------------
  it('applies default config values when no config is provided', async () => {
    const scannedFiles = [
      makeScannedFile({ path: 'src/a.ts', hash: 'h1' }),
    ];
    (deps.scanner.scanProjectFiles as ReturnType<typeof vi.fn>).mockResolvedValue(scannedFiles);

    await bootstrap('/test/project');

    // Scanner should have been called with default extensions, skip_dirs, skip_patterns
    expect(deps.scanner.scanProjectFiles).toHaveBeenCalledWith(
      '/test/project',
      expect.objectContaining({
        extensions: ['*.ts', '*.go', '*.py', '*.js', '*.tsx', '*.jsx'],
        skip_dirs: ['.git', 'node_modules', 'vendor', 'dist', 'build', '__pycache__'],
        skip_patterns: ['*.test.*', '*.spec.*', '*.d.ts'],
      }),
    );
  });

  // -------------------------------------------------------
  // Test 6: Bulk register -- all scanned files registered as 'cold'
  // -------------------------------------------------------
  it('registers all scanned files in registry as cold before spawning', async () => {
    const scannedFiles = [
      makeScannedFile({ path: 'src/a.ts', hash: 'h1' }),
      makeScannedFile({ path: 'src/b.ts', hash: 'h2' }),
      makeScannedFile({ path: 'src/c.ts', hash: 'h3' }),
    ];
    (deps.scanner.scanProjectFiles as ReturnType<typeof vi.fn>).mockResolvedValue(scannedFiles);

    await bootstrap('/test/project');

    // Each file should be registered
    expect(deps.registry.add).toHaveBeenCalledTimes(3);

    // Each should be registered as cold
    for (const file of scannedFiles) {
      expect(deps.registry.add).toHaveBeenCalledWith(
        expect.objectContaining({
          file_path: file.path,
          file_hash: file.hash,
          status: 'cold',
        }),
      );
    }
  });

  // -------------------------------------------------------
  // Test 7: Concurrent spawn bounded by config.threads
  // -------------------------------------------------------
  it('spawns at most config.threads agents concurrently', async () => {
    // Create 5 files but set threads=2 -- at most 2 concurrent spawns
    const scannedFiles = Array.from({ length: 5 }, (_, i) =>
      makeScannedFile({ path: `src/file${i}.ts`, hash: `hash${i}` }),
    );
    (deps.scanner.scanProjectFiles as ReturnType<typeof vi.fn>).mockResolvedValue(scannedFiles);

    let activeConcurrent = 0;
    let maxConcurrent = 0;

    (deps.sessionManager.create as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      activeConcurrent++;
      if (activeConcurrent > maxConcurrent) {
        maxConcurrent = activeConcurrent;
      }
      // Simulate async work
      await new Promise((resolve) => setTimeout(resolve, 10));
      activeConcurrent--;
      return {
        session_id: `sess-${Math.random()}`,
        file_path: 'src/file.ts',
        created_at: new Date(),
        file_hash: 'h',
        status: 'active',
      };
    });

    await bootstrap('/test/project', { threads: 2 });

    // All 5 files should have been spawned
    expect(deps.sessionManager.create).toHaveBeenCalledTimes(5);
    // But never more than 2 concurrently
    expect(maxConcurrent).toBeLessThanOrEqual(2);
  });

  // -------------------------------------------------------
  // Test 8: Error collection -- spawn failure collected, others still processed
  // -------------------------------------------------------
  it('collects spawn errors in errors[] without aborting other files', async () => {
    const scannedFiles = [
      makeScannedFile({ path: 'src/good.ts', hash: 'h1' }),
      makeScannedFile({ path: 'src/bad.ts', hash: 'h2' }),
      makeScannedFile({ path: 'src/also-good.ts', hash: 'h3' }),
    ];
    (deps.scanner.scanProjectFiles as ReturnType<typeof vi.fn>).mockResolvedValue(scannedFiles);

    let callCount = 0;
    (deps.sessionManager.create as ReturnType<typeof vi.fn>).mockImplementation(async (opts: any) => {
      callCount++;
      if (opts.filePath === 'src/bad.ts' || opts.file_path === 'src/bad.ts') {
        throw new Error('SPAWN_FAILED: sdk timeout');
      }
      return {
        session_id: `sess-${callCount}`,
        file_path: opts.filePath ?? opts.file_path,
        created_at: new Date(),
        file_hash: 'h',
        status: 'active',
      };
    });

    const result = await bootstrap('/test/project');

    // All 3 files were attempted
    expect(deps.sessionManager.create).toHaveBeenCalledTimes(3);

    // Error collected for the failing file
    expect(result.errors).toBeDefined();
    expect(Array.isArray(result.errors)).toBe(true);
    expect(result.errors!.length).toBe(1);
    expect(result.errors![0]).toEqual(
      expect.objectContaining({
        path: 'src/bad.ts',
        error: expect.stringContaining('SPAWN_FAILED'),
      }),
    );

    // 2 succeeded
    expect(result.ready).toBe(2);
  });

  // -------------------------------------------------------
  // Test 9: Result counts -- total=scanned, ready=spawned, errors=failures
  // -------------------------------------------------------
  it('returns correct result counts: total, ready, errors', async () => {
    const scannedFiles = Array.from({ length: 4 }, (_, i) =>
      makeScannedFile({ path: `src/file${i}.ts`, hash: `hash${i}` }),
    );
    (deps.scanner.scanProjectFiles as ReturnType<typeof vi.fn>).mockResolvedValue(scannedFiles);

    // File 2 fails
    let callIdx = 0;
    (deps.sessionManager.create as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      const idx = callIdx++;
      if (idx === 2) {
        throw new Error('Agent spawn timeout');
      }
      return {
        session_id: `sess-${idx}`,
        file_path: `src/file${idx}.ts`,
        created_at: new Date(),
        file_hash: `hash${idx}`,
        status: 'active',
      };
    });

    const result = await bootstrap('/test/project');

    expect(result.total).toBe(4);
    expect(result.ready).toBe(3);
    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBe(1);
  });

  // -------------------------------------------------------
  // Test 10: Empty project -- returns {total:0, ready:0, errors:[]}
  // -------------------------------------------------------
  it('returns {total:0, ready:0, errors:[]} for empty project', async () => {
    (deps.scanner.scanProjectFiles as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const result = await bootstrap('/test/project');

    expect(result.total).toBe(0);
    expect(result.ready).toBe(0);
    expect(result.errors).toEqual([]);
  });

  // -------------------------------------------------------
  // Test 11: Custom config overrides defaults
  // -------------------------------------------------------
  it('passes custom config overrides to scanner', async () => {
    (deps.scanner.scanProjectFiles as ReturnType<typeof vi.fn>).mockResolvedValue([]);

    const customConfig: Partial<BootstrapConfig> = {
      threads: 5,
      extensions: ['*.rs', '*.go'],
      skip_dirs: ['target'],
      skip_patterns: [],
    };

    await bootstrap('/test/project', customConfig);

    expect(deps.scanner.scanProjectFiles).toHaveBeenCalledWith(
      '/test/project',
      expect.objectContaining({
        extensions: ['*.rs', '*.go'],
        skip_dirs: ['target'],
        skip_patterns: [],
      }),
    );
  });

  // -------------------------------------------------------
  // Test 12: Each error entry has path and error string
  // -------------------------------------------------------
  it('error entries contain path:string and error:string', async () => {
    const scannedFiles = [
      makeScannedFile({ path: 'src/fail1.ts', hash: 'h1' }),
      makeScannedFile({ path: 'src/fail2.ts', hash: 'h2' }),
    ];
    (deps.scanner.scanProjectFiles as ReturnType<typeof vi.fn>).mockResolvedValue(scannedFiles);

    (deps.sessionManager.create as ReturnType<typeof vi.fn>).mockRejectedValue(
      new Error('SDK_UNAVAILABLE'),
    );

    const result = await bootstrap('/test/project');

    expect(result.errors).toBeDefined();
    expect(result.errors!.length).toBe(2);

    for (const err of result.errors!) {
      expect(typeof err.path).toBe('string');
      expect(typeof err.error).toBe('string');
      expect(err.path.length).toBeGreaterThan(0);
      expect(err.error.length).toBeGreaterThan(0);
    }
  });

  // -------------------------------------------------------
  // Test 13: threads has default of 10
  // -------------------------------------------------------
  it('defaults threads to 10 when not specified in config', async () => {
    // We create 15 files and check concurrency doesn't exceed 10
    const scannedFiles = Array.from({ length: 15 }, (_, i) =>
      makeScannedFile({ path: `src/file${i}.ts`, hash: `hash${i}` }),
    );
    (deps.scanner.scanProjectFiles as ReturnType<typeof vi.fn>).mockResolvedValue(scannedFiles);

    let activeConcurrent = 0;
    let maxConcurrent = 0;

    (deps.sessionManager.create as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      activeConcurrent++;
      if (activeConcurrent > maxConcurrent) {
        maxConcurrent = activeConcurrent;
      }
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeConcurrent--;
      return {
        session_id: `sess-${Math.random()}`,
        file_path: 'f.ts',
        created_at: new Date(),
        file_hash: 'h',
        status: 'active',
      };
    });

    // No config provided -> default threads=10
    await bootstrap('/test/project');

    expect(deps.sessionManager.create).toHaveBeenCalledTimes(15);
    expect(maxConcurrent).toBeLessThanOrEqual(10);
    // Also verify there was actual concurrency (at least 2 if we have 15 files)
    expect(maxConcurrent).toBeGreaterThanOrEqual(2);
  });

  // -------------------------------------------------------
  // Test 14: Register happens BEFORE spawn (ordering)
  // -------------------------------------------------------
  it('registers all files before any spawn begins', async () => {
    const scannedFiles = [
      makeScannedFile({ path: 'src/a.ts', hash: 'h1' }),
      makeScannedFile({ path: 'src/b.ts', hash: 'h2' }),
    ];
    (deps.scanner.scanProjectFiles as ReturnType<typeof vi.fn>).mockResolvedValue(scannedFiles);

    const callOrder: string[] = [];

    (deps.registry.add as ReturnType<typeof vi.fn>).mockImplementation(() => {
      callOrder.push('register');
    });

    (deps.sessionManager.create as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      callOrder.push('spawn');
      return {
        session_id: 'sess',
        file_path: 'f.ts',
        created_at: new Date(),
        file_hash: 'h',
        status: 'active',
      };
    });

    await bootstrap('/test/project');

    // All 'register' calls must come before any 'spawn' call
    const firstSpawnIdx = callOrder.indexOf('spawn');
    const lastRegisterIdx = callOrder.lastIndexOf('register');

    expect(firstSpawnIdx).toBeGreaterThan(-1);
    expect(lastRegisterIdx).toBeGreaterThan(-1);
    expect(lastRegisterIdx).toBeLessThan(firstSpawnIdx);
  });
});
