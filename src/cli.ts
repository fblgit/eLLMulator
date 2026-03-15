#!/usr/bin/env node
/**
 * FR-015: CLI Argument Parsing & Command Dispatch
 * FR-OTEL-009: OTEL CLI Flags, Config Extension, main() Wiring, printUsage
 *
 * SPEC grounding:
 *   CLI.start:        --project, --ext-port, --int-port, --bootstrap, --threads,
 *                     --model, --extensions, --skip-dirs, --verbose,
 *                     --otel-endpoint, --otel-protocol, --no-otel
 *   CLI.trace:        positional <scenario>, --entry, --max-depth, --output, --state,
 *                     --otel-endpoint, --otel-protocol
 *   CLI.consolidate:  (no flags)
 *   CLI.status:       (no flags)
 *
 * Provides:
 *   - parseCLI(argv) pure parser, CLIConfig union, per-command config types.
 *   - main(argv) command dispatcher — creates server, wires bootstrap, routes commands.
 * Manual argv parsing — no CLI library dependency.
 */

import { createServer } from './server.js';
import { createBootstrapHandler } from './bootstrap.js';
import { scanProjectFiles } from './scanner.js';
import { renderSystemPrompt, renderBootstrapPrompt } from './templates.js';
import { readFile } from 'node:fs/promises';
import { createLogger, setLogLevel } from './logger.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type StartConfig = {
  command: 'start';
  project: string;
  extPort: number;
  intPort: number;
  bootstrap: boolean;
  force: boolean;
  threads: number;
  model: string;
  extensions: string[];
  skipDirs: string[];
  verbose: boolean;
  otelEndpoint?: string;
  otelProtocol?: 'http/protobuf' | 'http/json';
  otelEnabled?: boolean;
};

export type TraceConfig = {
  command: 'trace';
  scenario: string;
  entry?: string;
  maxDepth: number;
  output?: string;
  state?: unknown;
  model: string;
  verbose: boolean;
  otelEndpoint?: string;
  otelProtocol?: 'http/protobuf' | 'http/json';
};

export type ConsolidateConfig = {
  command: 'consolidate';
};

export type StatusConfig = {
  command: 'status';
};

export type InitConfig = {
  command: 'init';
  targetDir: string;
  extPort: number;
};

export type CLIConfig = StartConfig | TraceConfig | ConsolidateConfig | StatusConfig | InitConfig;

// ---------------------------------------------------------------------------
// Defaults
// ---------------------------------------------------------------------------

const START_DEFAULTS: {
  extPort: number;
  intPort: number;
  bootstrap: boolean;
  threads: number;
  model: string;
  extensions: string[];
  skipDirs: string[];
  verbose: boolean;
} = {
  extPort: 3100,
  intPort: 3101,
  bootstrap: false,
  threads: 10,
  model: 'claude-sonnet-4-6',
  extensions: ['.ts', '.go', '.py'],
  skipDirs: ['.git', 'node_modules', 'vendor'],
  verbose: false,
};

const TRACE_DEFAULTS: {
  maxDepth: number;
} = {
  maxDepth: 50,
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Consume the next argv element as a value for a flag. Throws if missing. */
function consumeValue(args: string[], index: number, flag: string): string {
  const next = args[index + 1];
  if (next === undefined || next.startsWith('--')) {
    throw new Error(`Missing value for ${flag}`);
  }
  return next;
}

// ---------------------------------------------------------------------------
// Command parsers
// ---------------------------------------------------------------------------

function parseStart(args: string[]): StartConfig {
  let project: string | undefined;
  let extPort = START_DEFAULTS.extPort;
  let intPort = START_DEFAULTS.intPort;
  let bootstrap = START_DEFAULTS.bootstrap;
  let force = false;
  let threads = START_DEFAULTS.threads;
  let model: string = START_DEFAULTS.model;
  let extensions: string[] = [...START_DEFAULTS.extensions];
  let skipDirs: string[] = [...START_DEFAULTS.skipDirs];
  let verbose = START_DEFAULTS.verbose;
  let otelEndpoint: string | undefined;
  let otelProtocol: 'http/protobuf' | 'http/json' | undefined;
  let otelEnabled: boolean | undefined;

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    switch (arg) {
      case '--project':
        project = consumeValue(args, i, '--project');
        i += 2;
        break;
      case '--ext-port':
        extPort = Number(consumeValue(args, i, '--ext-port'));
        i += 2;
        break;
      case '--int-port':
        intPort = Number(consumeValue(args, i, '--int-port'));
        i += 2;
        break;
      case '--bootstrap':
        bootstrap = true;
        i += 1;
        break;
      case '--force':
        force = true;
        i += 1;
        break;
      case '--threads':
        threads = Number(consumeValue(args, i, '--threads'));
        i += 2;
        break;
      case '--model':
        model = consumeValue(args, i, '--model');
        i += 2;
        break;
      case '--extensions':
        extensions = consumeValue(args, i, '--extensions').split(',');
        i += 2;
        break;
      case '--skip-dirs':
        skipDirs = consumeValue(args, i, '--skip-dirs').split(',');
        i += 2;
        break;
      case '--verbose':
        verbose = true;
        i += 1;
        break;
      case '--otel-endpoint':
        otelEndpoint = consumeValue(args, i, '--otel-endpoint');
        i += 2;
        break;
      case '--otel-protocol':
        otelProtocol = consumeValue(args, i, '--otel-protocol') as 'http/protobuf' | 'http/json';
        i += 2;
        break;
      case '--no-otel':
        otelEnabled = false;
        i += 1;
        break;
      default:
        i += 1;
        break;
    }
  }

  if (project === undefined) {
    throw new Error('--project is required for start command');
  }

  return {
    command: 'start',
    project,
    extPort,
    intPort,
    bootstrap,
    force,
    threads,
    model,
    extensions,
    skipDirs,
    verbose,
    ...(otelEndpoint !== undefined && { otelEndpoint }),
    ...(otelProtocol !== undefined && { otelProtocol }),
    ...(otelEnabled !== undefined && { otelEnabled }),
  };
}

function parseTrace(args: string[]): TraceConfig {
  let scenario: string | undefined;
  let entry: string | undefined;
  let maxDepth = TRACE_DEFAULTS.maxDepth;
  let output: string | undefined;
  let state: unknown;
  let model = START_DEFAULTS.model;
  let verbose = false;
  let otelEndpoint: string | undefined;
  let otelProtocol: 'http/protobuf' | 'http/json' | undefined;

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--entry') {
      entry = consumeValue(args, i, '--entry');
      i += 2;
    } else if (arg === '--max-depth') {
      maxDepth = Number(consumeValue(args, i, '--max-depth'));
      i += 2;
    } else if (arg === '--output') {
      output = consumeValue(args, i, '--output');
      i += 2;
    } else if (arg === '--state') {
      const raw = consumeValue(args, i, '--state');
      try {
        state = JSON.parse(raw);
      } catch {
        throw new Error(`Invalid JSON for --state: ${raw}`);
      }
      i += 2;
    } else if (arg === '--model') {
      model = consumeValue(args, i, '--model');
      i += 2;
    } else if (arg === '--verbose') {
      verbose = true;
      i += 1;
    } else if (arg === '--otel-endpoint') {
      otelEndpoint = consumeValue(args, i, '--otel-endpoint');
      i += 2;
    } else if (arg === '--otel-protocol') {
      otelProtocol = consumeValue(args, i, '--otel-protocol') as 'http/protobuf' | 'http/json';
      i += 2;
    } else if (!arg.startsWith('--')) {
      scenario = arg;
      i += 1;
    } else {
      i += 1;
    }
  }

  return {
    command: 'trace',
    scenario: scenario ?? '',
    ...(entry !== undefined && { entry }),
    maxDepth,
    ...(output !== undefined && { output }),
    ...(state !== undefined && { state }),
    model,
    verbose,
    ...(otelEndpoint !== undefined && { otelEndpoint }),
    ...(otelProtocol !== undefined && { otelProtocol }),
  };
}

function parseInit(args: string[]): InitConfig {
  let targetDir: string | undefined;
  let extPort = 3100;

  let i = 0;
  while (i < args.length) {
    const arg = args[i];
    if (arg === '--ext-port') {
      extPort = Number(consumeValue(args, i, '--ext-port'));
      i += 2;
    } else if (!arg.startsWith('--')) {
      targetDir = arg;
      i += 1;
    } else {
      i += 1;
    }
  }

  if (targetDir === undefined) {
    throw new Error('<target-dir> is required for init command');
  }

  return { command: 'init', targetDir, extPort };
}

// ---------------------------------------------------------------------------
// Main parser
// ---------------------------------------------------------------------------

export function parseCLI(argv: string[]): CLIConfig {
  if (argv.length === 0) {
    throw new Error('No command provided');
  }

  const command = argv[0];
  const rest = argv.slice(1);

  switch (command) {
    case 'start':
      return parseStart(rest);
    case 'trace':
      return parseTrace(rest);
    case 'consolidate':
      return { command: 'consolidate' };
    case 'status':
      return { command: 'status' };
    case 'init':
      return parseInit(rest);
    default:
      throw new Error(`Unknown command: ${command}`);
  }
}

// ---------------------------------------------------------------------------
// Command dispatcher
// ---------------------------------------------------------------------------

export async function main(argv: string[]): Promise<void> {
  const config = parseCLI(argv);

  // Set log level based on --verbose flag (available on start and trace commands)
  if ('verbose' in config && config.verbose) {
    setLogLevel('debug');
  }

  const log = createLogger('cli');
  log.info('command dispatching', { command: config.command });

  switch (config.command) {
    case 'start': {
      log.info('starting server', {
        project: config.project,
        extPort: config.extPort,
        intPort: config.intPort,
        model: config.model,
        bootstrap: config.bootstrap,
        threads: config.threads,
      });

      // OTEL fields use conditional spread to avoid adding undefined keys to
      // ServerConfig. This is semantically equivalent to the PRD ternary
      // formula (otelEnabled: endpoint ? (enabled ?? true) : false) because
      // resolveConfig() defaults otelEnabled to false when the key is absent.
      const server = createServer({
        projectDir: config.project,
        extPort: config.extPort,
        intPort: config.intPort,
        verbose: config.verbose,
        model: config.model,
        ...(config.otelEndpoint !== undefined && { otelEndpoint: config.otelEndpoint }),
        ...(config.otelProtocol !== undefined && { otelProtocol: config.otelProtocol }),
        ...(config.otelEndpoint !== undefined && { otelEnabled: config.otelEnabled ?? true }),
      });

      // Start MCP servers FIRST — agents need internal MCP during bootstrap
      await server.start();
      log.info('MCP servers listening', {
        extPort: config.extPort,
        intPort: config.intPort,
        project: config.project,
        model: config.model,
      });

      const sm = server.getSessionManager();

      if (config.bootstrap) {
        const startTime = Date.now();
        let filesScanned = 0;
        let filesReady = 0;

        log.info('bootstrap starting', {
          threads: config.threads,
          extensions: config.extensions.join(','),
          skipDirs: config.skipDirs.join(','),
          force: config.force,
        });

        const bootstrapHandler = createBootstrapHandler({
          scanner: { scanProjectFiles },
          registry: server.getRegistry(),
          sessionManager: {
            create: async (opts: { filePath: string; fileHash: string }) => {
              const systemPrompt = renderSystemPrompt({
                filePath: opts.filePath,
                sourceCode: '',  // source is read by agent via cat -n, not embedded
              });
              const bootstrapPrompt = renderBootstrapPrompt({
                filePath: opts.filePath,
              });

              log.info('bootstrap spawning agent', { file: opts.filePath });
              log.debug('bootstrap system prompt', { file: opts.filePath, length: systemPrompt.length });
              log.debug('bootstrap prompt', { file: opts.filePath, length: bootstrapPrompt.length });

              // Capture register tool call args from model output.
              // The model sometimes delegates via Agent (built-in tool that can't be
              // blocked), causing the MCP register call to fail. We capture the args
              // and apply them manually if the MCP path didn't work.
              const captured: { registerArgs: Record<string, any> | null } = { registerArgs: null };

              const session = await sm.create({
                ...opts,
                systemPrompt,
                bootstrapPrompt,
                cwd: config.project,
                tools: ['mcp__internal__register'],
                disallowedTools: ['Agent', 'Task', 'Write', 'Edit', 'Read'],
                mcpServers: {
                  'internal': {
                    type: 'http',
                    url: `http://127.0.0.1:${config.intPort}/mcp`
                  }
                },
                model: config.model,
                onMessage: (msg: { type: string; subtype?: string; content?: unknown }) => {
                  if (msg.type === 'assistant' && msg.content) {
                    const blocks = msg.content as Array<{ type: string; name?: string; text?: string; input?: unknown }>;
                    for (const block of blocks) {
                      // Capture register args from any tool call (direct or via Agent sub-agent)
                      if (block.type === 'tool_use' && block.name === 'mcp__internal__register' && block.input) {
                        captured.registerArgs = block.input as Record<string, any>;
                      }
                      if (block.type === 'tool_use') {
                        log.debug('sdk tool call', { file: opts.filePath, tool: block.name, input: JSON.stringify(block.input).slice(0, 200) });
                      } else if (block.type === 'text' && block.text) {
                        log.debug('sdk text', { file: opts.filePath, text: block.text.slice(0, 200) });
                      }
                    }
                  } else if (msg.type === 'result') {
                    log.debug('sdk result', { file: opts.filePath, content: JSON.stringify(msg.content).slice(0, 200) });
                  }
                },
              });

              // Check if MCP registration succeeded; if not, apply captured args manually
              filesReady++;
              let regEntry = server.getRegistry().get(opts.filePath);

              if (!regEntry?.declarations && captured.registerArgs !== null) {
                // MCP path failed (Agent delegation, transport issue, etc.) but we have the args
                const regArgs = captured.registerArgs;
                log.warn('MCP register missed, applying captured args manually', { file: opts.filePath });
                try {
                  let declarations: any[] = regArgs.declarations;
                  if (typeof declarations === 'string') {
                    try { declarations = JSON.parse(declarations); } catch { declarations = []; }
                  }
                  if (!Array.isArray(declarations)) declarations = [];

                  let dependencies: any[] = regArgs.dependencies ?? [];
                  if (typeof dependencies === 'string') {
                    try { dependencies = JSON.parse(dependencies); } catch { dependencies = []; }
                  }
                  if (!Array.isArray(dependencies)) dependencies = [];

                  const summary = declarations.length > 0
                    ? declarations.map((d: any) => d.intent).filter(Boolean).join('; ').slice(0, 200)
                    : '';

                  const handlers = server.getHandlers();
                  handlers.register(regArgs.file_path, {
                    summary,
                    owns: declarations,
                    imports: dependencies,
                    exports: [],
                    dependencies: dependencies.map((d: any) => d.from || d.name),
                  });

                  // Re-read after manual registration
                  regEntry = server.getRegistry().get(opts.filePath);
                } catch (err) {
                  log.error('manual registration failed', { file: opts.filePath, error: err instanceof Error ? err.message : String(err) });
                }
              }

              if (regEntry?.declarations) {
                const decl = regEntry.declarations;
                log.info('bootstrap file ready', {
                  file: opts.filePath,
                  progress: `${filesReady}/${filesScanned}`,
                  owns: decl.owns.length,
                  deps: decl.dependencies.length,
                });
                log.debug('bootstrap declarations', {
                  file: opts.filePath,
                  summary: decl.summary,
                  owns: decl.owns.map(o => `${o.name}(${o.kind})`).join(', '),
                  dependencies: decl.dependencies.join(', ') || '(none)',
                });
              } else {
                log.warn('bootstrap file has no declarations', { file: opts.filePath, progress: `${filesReady}/${filesScanned}` });
              }

              return session;
            },
            terminate: (sessionId: string) => sm.terminate(sessionId),
          },
          onSessionReady: (filePath, entry) => {
            const p = server.getPersistence();
            if (p) {
              p.upsertAgent({
                file_path: entry.file_path,
                file_hash: entry.file_hash,
                status: entry.status,
                session_id: entry.session_id ?? undefined,
                declarations: entry.declarations ?? undefined,
                last_active: entry.last_active ?? undefined,
                error: entry.error ?? undefined,
              });
            }
          },
        });

        const result = await bootstrapHandler(config.project, {
          threads: config.threads,
          extensions: config.extensions.map(e => e.startsWith('*') ? e : `*${e}`),
          skip_dirs: config.skipDirs,
          skip_patterns: ['*.test.*', '*.spec.*', '*.d.ts'],
          force: config.force,
        });

        filesScanned = result.total;
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        const skippedCount = result.total - (result.ready + result.errors.length);
        log.info('bootstrap complete', {
          ready: result.ready,
          total: result.total,
          skipped: skippedCount,
          errors: result.errors.length,
          elapsed: `${elapsed}s`,
        });
        if (result.errors.length > 0) {
          for (const err of result.errors) {
            log.error('bootstrap file failed', { file: err.path, error: err.error });
          }
        }

        // No batch persistence write needed — onSessionReady persists per-file
        // immediately after each session_id is set, surviving Ctrl+C.
      }

      // Rehydrate sessions for ready entries that have persisted session_ids.
      // SDK transcripts live on disk (~/.claude/projects/) and survive process
      // restarts.  We just register the session_id in the in-memory Map so
      // invokeOnSession() can use `resume + forkSession` natively — zero API calls.
      //
      // Entries without a session_id (persistence gap: upsert fired before
      // bootstrap set it) are skipped; invoke() handles them on-demand.
      {
        const registry = server.getRegistry();
        const allEntries = registry.list();
        const rehydratable = allEntries.filter(e =>
          e.status === 'ready' && e.session_id && !sm.get(e.session_id)
        );

        if (rehydratable.length > 0) {
          log.info('rehydrating sessions from persistence', { count: rehydratable.length });
          let rehydrated = 0;

          for (const entry of rehydratable) {
            try {
              const systemPrompt = renderSystemPrompt({
                filePath: entry.file_path,
                sourceCode: '',
              });

              sm.rehydrate({
                sessionId: entry.session_id!,
                filePath: entry.file_path,
                fileHash: entry.file_hash,
                systemPrompt,
                tools: ['mcp__internal__register'],
                model: config.model,
              });

              rehydrated++;
            } catch (err) {
              log.error('session rehydration failed', { file: entry.file_path, error: err instanceof Error ? err.message : String(err) });
            }
          }

          log.info('session rehydration complete', { rehydrated, total: rehydratable.length });
        }
      }

      // Keep the event loop alive — HTTP servers alone may not suffice when
      // SDK child processes drain during bootstrap/warmup.
      const keepAlive = setInterval(() => {}, 30_000);

      log.info('server running, press Ctrl+C to stop');
      const shutdown = async () => {
        log.info('shutting down');
        clearInterval(keepAlive);
        await server.stop();
        process.exit(0);
      };
      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
      break;
    }
    case 'trace': {
      log.info('trace command starting', {
        scenario: config.scenario.slice(0, 120),
        maxDepth: config.maxDepth,
        model: config.model,
        entry: config.entry || '(auto-detect)',
        output: config.output || '(none)',
      });

      // Connect to the running server via MCP client
      const extPort = 3100; // hardcoded — trace connects to running server on default port
      const serverUrl = `http://127.0.0.1:${extPort}/mcp`;

      log.info('connecting to running server', { url: serverUrl });

      const { Client } = await import('@modelcontextprotocol/sdk/client/index.js');
      const { StreamableHTTPClientTransport } = await import('@modelcontextprotocol/sdk/client/streamableHttp.js');

      let mcpClient: InstanceType<typeof Client>;
      let transport: InstanceType<typeof StreamableHTTPClientTransport>;

      try {
        transport = new StreamableHTTPClientTransport(new URL(serverUrl));
        mcpClient = new Client({ name: 'ellmulator-cli', version: '1.0.0' });
        await mcpClient.connect(transport);
        log.info('connected to server', { url: serverUrl });
      } catch (connErr) {
        const errMsg = connErr instanceof Error ? connErr.message : String(connErr);
        log.error('cannot connect to server', { url: serverUrl, error: errMsg });
        console.error(`\nError: Cannot connect to eLLMulator server at ${serverUrl}`);
        console.error('Start the server first: ellmulator start --project <dir> --bootstrap\n');
        process.exit(1);
      }

      try {
        // Build trace tool arguments
        const traceArgs: Record<string, unknown> = {
          scenario: config.scenario,
          max_depth: config.maxDepth,
        };
        if (config.entry) traceArgs.entry_file = config.entry;
        if (config.state) traceArgs.state = config.state;

        log.info('calling trace tool on server');
        const traceStart = Date.now();

        const result = await mcpClient.callTool({
          name: 'trace',
          arguments: traceArgs,
        }, undefined, { timeout: 900_000 });

        const traceElapsed = ((Date.now() - traceStart) / 1000).toFixed(1);

        // Parse trace result from MCP response
        const contentArr = result.content as Array<{ type: string; text?: string }>;
        const textContent = contentArr?.find((c) => c.type === 'text');
        const traceResult = textContent?.text ? JSON.parse(textContent.text) : {};

        log.info('trace complete', {
          elapsed: `${traceElapsed}s`,
          entries: traceResult.entries?.length ?? 0,
          findings: traceResult.findings?.length ?? 0,
          errors: traceResult.entries?.filter((e: any) => e.error).length ?? 0,
        });

        // Debug: show trace entries
        if (traceResult.entries) {
          for (const entry of traceResult.entries) {
            const status = entry.error ? `ERROR:${entry.error}` : 'ok';
            log.debug('trace entry', {
              depth: entry.depth,
              caller: entry.caller,
              target: entry.target,
              function: entry.function,
              elapsed: entry.duration_ms ? `${entry.duration_ms}ms` : 'n/a',
              status,
              refs: entry.source_refs?.length ?? 0,
            });
            if (entry.mutations?.length) {
              for (const m of entry.mutations) {
                log.debug('trace mutation', { key: m.key, after: m.after });
              }
            }
          }
        }

        // Debug: show findings
        if (traceResult.findings?.length) {
          for (const f of traceResult.findings) {
            log.debug('trace finding', { type: f.type, severity: f.severity, description: f.description });
          }
        }

        // Debug: show summary
        if (traceResult.summary) {
          log.debug('trace summary', { summary: traceResult.summary });
        }

        // Print JSON result to stdout (program output)
        console.log(JSON.stringify(traceResult, null, 2));

        if (config.output) {
          const fs = await import('node:fs/promises');
          await fs.writeFile(config.output, JSON.stringify(traceResult, null, 2));
          log.info('trace result written', { output: config.output });
        }
      } finally {
        await mcpClient.close();
        log.debug('MCP client disconnected');
      }

      break;
    }
    case 'init': {
      const { initProject } = await import('./init.js');
      const result = await initProject(config.targetDir, { extPort: config.extPort });

      const labels: Record<string, string> = {
        created: 'created',
        updated: 'updated',
        appended: 'appended',
        unchanged: 'unchanged',
      };

      console.log(`.mcp.json\t\t${labels[result.mcpJson]}`);
      console.log(`.claude/settings.local\t${labels[result.settings]}`);
      console.log(`CLAUDE.md\t\t${labels[result.claudeMd]}`);

      const allUnchanged = result.mcpJson === 'unchanged'
        && result.settings === 'unchanged'
        && result.claudeMd === 'unchanged';

      if (allUnchanged) {
        console.log('\nAlready initialized. Nothing to do.');
      } else {
        console.log(`\nDone. Start the server with: ellmulator start --project ${config.targetDir} --bootstrap`);
      }
      break;
    }
    case 'consolidate':
      throw new Error(
        'consolidate command requires access to live server state — use "ellmulator start" then connect via MCP client',
      );
    case 'status':
      throw new Error(
        'status command requires access to live server state — use "ellmulator start" then connect via MCP client',
      );
  }
}

// ---------------------------------------------------------------------------
// Help
// ---------------------------------------------------------------------------

export function printUsage(): void {
  process.stdout.write(`eLLMulator v0.1.0 — Agentic Distributed Trace Simulation

Usage: ellmulator <command> [options]

Commands:
  start          Start server with optional bootstrap
  trace          Run a trace scenario
  consolidate    Rescan and refresh stale agents (requires running server)
  status         Show server statistics (requires running server)
  init           Initialize a project to use eLLMulator

Start options:
  --project <dir>       Path to target project (required)
  --bootstrap           Scan and bootstrap all files on startup
  --force               Re-bootstrap all files (even already-ready ones)
  --ext-port <n>        External MCP port (default: 3100)
  --int-port <n>        Internal MCP port (default: 3101)
  --threads <n>         Concurrent bootstrap sessions (default: 10)
  --model <name>        Claude model (default: claude-sonnet-4-6)
  --extensions <list>   File extensions to scan (default: .ts,.go,.py)
  --skip-dirs <list>    Directories to skip (default: .git,node_modules,vendor)
  --verbose             Enable verbose logging
  --otel-endpoint <url> OTEL collector endpoint (enables OTEL export)
  --otel-protocol <proto> OTEL wire protocol: http/protobuf or http/json
  --no-otel             Disable OTEL export even if endpoint is configured

Trace options:
  <scenario>            Natural language scenario description
  --entry <file>        Entry point file path (auto-detected if omitted)
  --max-depth <n>       Maximum call stack depth (default: 50)
  --output <file>       Write trace log as JSONL
  --state <json>        Initial synthetic state (JSON string)
  --model <name>        Claude model (default: claude-sonnet-4-6)
  --verbose             Show registry state, trace entries, findings, timing
  --otel-endpoint <url> OTEL collector endpoint for this trace
  --otel-protocol <proto> OTEL wire protocol: http/protobuf or http/json

Init options:
  <target-dir>          Path to project to onboard (required)
  --ext-port <n>        eLLMulator external MCP port (default: 3100)

Examples:
  ellmulator start --project ./my-app --bootstrap
  ellmulator trace "What happens when a user logs in?" --entry src/auth.ts
  ellmulator trace "Process payment" --max-depth 10 --output trace.jsonl
  ellmulator init ./my-project
  ellmulator init ./my-project --ext-port 4200
`);
}

// ---------------------------------------------------------------------------
// Entry point — only runs when executed directly, not when imported
// ---------------------------------------------------------------------------

import { fileURLToPath } from 'node:url';
import { realpathSync } from 'node:fs';

let isDirectExecution = false;
try {
  const thisFile = fileURLToPath(import.meta.url);
  const invoked = realpathSync(process.argv[1] ?? '');
  isDirectExecution = invoked === thisFile;
} catch {
  // If resolution fails, fall back to suffix check
  isDirectExecution = process.argv[1]?.endsWith('cli.js') || process.argv[1]?.endsWith('cli.ts') || false;
}

if (isDirectExecution) {
  const args = process.argv.slice(2);

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    printUsage();
    process.exit(0);
  }

  main(args).catch((err: Error) => {
    const log = createLogger('cli');
    log.error('fatal error', { message: err.message });
    process.exit(1);
  });
}
