/**
 * FR-015: CLI main() Dispatcher Tests
 * FR-OTEL-009: OTEL config wiring through main() to createServer()
 *
 * SPEC grounding:
 *   CLI.start:        main() creates server, optionally runs bootstrap, then starts server
 *   CLI.trace:        main() throws — requires bootstrapped agents
 *   CLI.consolidate:  main() creates single-process server, dispatches consolidate, stops
 *   CLI.status:       main() creates single-process server, dispatches status, stops
 *
 * Tests validate the command dispatcher: server creation with correct config,
 * bootstrap wiring via --bootstrap flag, and error paths for commands that
 * require a running server.
 *
 * All module dependencies (server, bootstrap, scanner) are mocked at the module level.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

// ---------------------------------------------------------------------------
// Module-level mocks — must precede the SUT import
// ---------------------------------------------------------------------------

const mockStart = vi.fn().mockResolvedValue(undefined);
const mockStop = vi.fn().mockResolvedValue(undefined);
const mockGetConfig = vi.fn().mockReturnValue({
  extPort: 3100,
  intPort: 3101,
  projectDir: '/test',
});
const mockRegistryAdd = vi.fn();
const mockRegistryGet = vi.fn().mockReturnValue(undefined);
const mockRegistryList = vi.fn().mockReturnValue([]);
const mockRegistryListByStatus = vi.fn().mockReturnValue([]);
const mockSessionCreate = vi.fn().mockResolvedValue({
  session_id: 'mock-sess-001',
  file_path: 'src/a.ts',
  created_at: new Date(),
  file_hash: 'h1',
  status: 'active',
});
const mockSessionTerminate = vi.fn().mockResolvedValue(undefined);

const mockRegistry = {
  add: mockRegistryAdd,
  get: mockRegistryGet,
  list: mockRegistryList,
  listByStatus: mockRegistryListByStatus,
};

const mockSessionManager = {
  create: mockSessionCreate,
  terminate: mockSessionTerminate,
};

const mockConsolidateHandler = vi.fn().mockResolvedValue({
  stale: 0,
  new: 0,
  refreshed: 0,
  removed: 0,
});
const mockStatusHandler = vi.fn().mockReturnValue({
  total_files: 0,
  by_status: { cold: 0, bootstrapping: 0, ready: 0, stale: 0, error: 0 },
  active_traces: 0,
  agent_pool_size: 0,
});
const mockGetHandlers = vi.fn().mockReturnValue({
  consolidate: mockConsolidateHandler,
  status: mockStatusHandler,
});

const mockServer = {
  start: mockStart,
  stop: mockStop,
  getConfig: mockGetConfig,
  getRegistry: vi.fn().mockReturnValue(mockRegistry),
  getSessionManager: vi.fn().mockReturnValue(mockSessionManager),
  getHandlers: mockGetHandlers,
  getPersistence: vi.fn().mockReturnValue(null),
};

const mockCreateServer = vi.fn().mockReturnValue(mockServer);

vi.mock('./server.js', () => ({
  createServer: (...args: unknown[]) => mockCreateServer(...args),
}));

const mockBootstrapFn = vi.fn().mockResolvedValue({
  total: 0,
  ready: 0,
  errors: [],
});

const mockCreateBootstrapHandler = vi.fn().mockReturnValue(mockBootstrapFn);

vi.mock('./bootstrap.js', () => ({
  createBootstrapHandler: (...args: unknown[]) => mockCreateBootstrapHandler(...args),
}));

const mockScanProjectFiles = vi.fn().mockResolvedValue([]);

vi.mock('./scanner.js', () => ({
  scanProjectFiles: (...args: unknown[]) => mockScanProjectFiles(...args),
}));

// Import SUT after mocks are set up
import { main } from './cli.js';

// ===========================================================================
// FR-015: main() command dispatcher
// ===========================================================================

describe('FR-015: main() dispatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset default mock returns
    mockCreateServer.mockReturnValue(mockServer);
    mockCreateBootstrapHandler.mockReturnValue(mockBootstrapFn);
    mockBootstrapFn.mockResolvedValue({ total: 0, ready: 0, errors: [] });
    mockStart.mockResolvedValue(undefined);
  });

  // -------------------------------------------------------
  // 1. main() is a function
  // -------------------------------------------------------
  it('main is an exported async function', () => {
    expect(typeof main).toBe('function');
  });

  // -------------------------------------------------------
  // 2. start command creates server with correct config
  // -------------------------------------------------------
  it('start command calls createServer with parsed config', async () => {
    await main(['start', '--project', '/my/project', '--ext-port', '4000', '--int-port', '4001']);

    expect(mockCreateServer).toHaveBeenCalledTimes(1);
    expect(mockCreateServer).toHaveBeenCalledWith({
      projectDir: '/my/project',
      extPort: 4000,
      intPort: 4001,
      verbose: false,
      model: 'claude-sonnet-4-6',
    });
  });

  // -------------------------------------------------------
  // 3. start command calls server.start()
  // -------------------------------------------------------
  it('start command calls server.start()', async () => {
    await main(['start', '--project', '/my/project']);

    expect(mockStart).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------
  // 4. start without --bootstrap does NOT invoke bootstrap handler
  // -------------------------------------------------------
  it('start without --bootstrap does not invoke bootstrap', async () => {
    await main(['start', '--project', '/my/project']);

    expect(mockCreateBootstrapHandler).not.toHaveBeenCalled();
    expect(mockBootstrapFn).not.toHaveBeenCalled();
  });

  // -------------------------------------------------------
  // 5. start with --bootstrap creates and invokes bootstrap handler
  // -------------------------------------------------------
  it('start with --bootstrap creates and invokes bootstrap handler', async () => {
    await main(['start', '--project', '/my/project', '--bootstrap']);

    expect(mockCreateBootstrapHandler).toHaveBeenCalledTimes(1);
    expect(mockBootstrapFn).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------
  // 6. bootstrap handler receives correct deps
  // -------------------------------------------------------
  it('bootstrap handler receives scanner, registry, and sessionManager deps', async () => {
    await main(['start', '--project', '/my/project', '--bootstrap']);

    const deps = mockCreateBootstrapHandler.mock.calls[0][0];
    expect(deps).toHaveProperty('scanner');
    expect(deps).toHaveProperty('registry');
    expect(deps).toHaveProperty('sessionManager');
    expect(typeof deps.scanner.scanProjectFiles).toBe('function');
    expect(typeof deps.sessionManager.create).toBe('function');
    expect(typeof deps.sessionManager.terminate).toBe('function');
  });

  // -------------------------------------------------------
  // 7. bootstrap handler is called with correct project dir and config
  // -------------------------------------------------------
  it('bootstrap handler is called with project dir and config', async () => {
    await main([
      'start', '--project', '/my/project', '--bootstrap',
      '--threads', '5',
      '--extensions', '.ts,.go',
      '--skip-dirs', 'dist,build',
    ]);

    expect(mockBootstrapFn).toHaveBeenCalledWith(
      '/my/project',
      expect.objectContaining({
        threads: 5,
        skip_dirs: ['dist', 'build'],
        skip_patterns: ['*.test.*', '*.spec.*', '*.d.ts'],
      }),
    );
  });

  // -------------------------------------------------------
  // 8. server.start() runs BEFORE bootstrap (agents need internal MCP)
  // -------------------------------------------------------
  it('server starts before bootstrap (agents need MCP)', async () => {
    const callOrder: string[] = [];
    mockBootstrapFn.mockImplementation(async () => {
      callOrder.push('bootstrap');
      return { total: 0, ready: 0, errors: [] };
    });
    mockStart.mockImplementation(async () => {
      callOrder.push('server.start');
    });

    await main(['start', '--project', '/my/project', '--bootstrap']);

    expect(callOrder).toEqual(['server.start', 'bootstrap']);
  });

  // -------------------------------------------------------
  // 9. trace command connects to running server via MCP client
  // -------------------------------------------------------
  it('trace command exits with error when no server is running', async () => {
    // trace now connects to a running server via MCP client.
    // When no server is running, it should exit with code 1.
    const mockExit = vi.spyOn(process, 'exit').mockImplementation(() => { throw new Error('process.exit called'); });

    await expect(main(['trace', 'test scenario'])).rejects.toThrow();

    expect(mockExit).toHaveBeenCalledWith(1);
    // Should NOT create its own server
    expect(mockCreateServer).not.toHaveBeenCalled();

    mockExit.mockRestore();
  });

  // -------------------------------------------------------
  // 10. consolidate command throws directing users to MCP client
  // -------------------------------------------------------
  it('consolidate command throws directing users to use MCP client', async () => {
    await expect(main(['consolidate'])).rejects.toThrow(
      /consolidate command requires access to live server state — use "ellmulator start" then connect via MCP client/,
    );
  });

  // -------------------------------------------------------
  // 11. status command throws directing users to MCP client
  // -------------------------------------------------------
  it('status command throws directing users to use MCP client', async () => {
    await expect(main(['status'])).rejects.toThrow(
      /status command requires access to live server state — use "ellmulator start" then connect via MCP client/,
    );
  });

  // -------------------------------------------------------
  // 12. extensions are glob-normalized for bootstrap
  // -------------------------------------------------------
  it('extensions are normalized to glob patterns (prefixed with *) for bootstrap', async () => {
    await main([
      'start', '--project', '/my/project', '--bootstrap',
      '--extensions', '.ts,.go',
    ]);

    const bootstrapArgs = mockBootstrapFn.mock.calls[0];
    const config = bootstrapArgs[1];
    // .ts -> *.ts, .go -> *.go
    expect(config.extensions).toEqual(['*.ts', '*.go']);
  });

  // -------------------------------------------------------
  // 13. start uses default ports when not specified
  // -------------------------------------------------------
  it('start uses default ports when not specified', async () => {
    await main(['start', '--project', '/my/project']);

    expect(mockCreateServer).toHaveBeenCalledWith({
      projectDir: '/my/project',
      extPort: 3100,
      intPort: 3101,
      verbose: false,
      model: 'claude-sonnet-4-6',
    });
  });

  // -------------------------------------------------------
  // 14. OTEL: --otel-endpoint passes otelEndpoint and otelEnabled=true to createServer
  // -------------------------------------------------------
  it('start with --otel-endpoint passes otelEndpoint and otelEnabled=true to createServer', async () => {
    await main(['start', '--project', '.', '--otel-endpoint', 'http://localhost:4318/v1/traces']);

    expect(mockCreateServer).toHaveBeenCalledTimes(1);
    const serverConfig = mockCreateServer.mock.calls[0][0];
    expect(serverConfig.otelEndpoint).toBe('http://localhost:4318/v1/traces');
    expect(serverConfig.otelEnabled).toBe(true);
  });

  // -------------------------------------------------------
  // 15. OTEL: --otel-endpoint with --no-otel passes otelEnabled=false to createServer
  // -------------------------------------------------------
  it('start with --otel-endpoint and --no-otel passes otelEnabled=false to createServer', async () => {
    await main(['start', '--project', '.', '--otel-endpoint', 'http://localhost:4318/v1/traces', '--no-otel']);

    expect(mockCreateServer).toHaveBeenCalledTimes(1);
    const serverConfig = mockCreateServer.mock.calls[0][0];
    expect(serverConfig.otelEndpoint).toBe('http://localhost:4318/v1/traces');
    expect(serverConfig.otelEnabled).toBe(false);
  });

  // -------------------------------------------------------
  // 16. OTEL: no OTEL flags means createServer does NOT receive otelEndpoint
  // -------------------------------------------------------
  it('start without OTEL flags does not pass otelEndpoint to createServer', async () => {
    await main(['start', '--project', '.']);

    expect(mockCreateServer).toHaveBeenCalledTimes(1);
    const serverConfig = mockCreateServer.mock.calls[0][0];
    expect(serverConfig).not.toHaveProperty('otelEndpoint');
    expect(serverConfig).not.toHaveProperty('otelEnabled');
  });
});
