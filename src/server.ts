/**
 * FR-004: Server — Main entry that creates both MCP surfaces and wires everything.
 *
 * SPEC grounding:
 *   Architecture.server.external_mcp: { port:int!, tools:['trace','inspect','status','consolidate','list_agents'] }
 *   Architecture.server.internal_mcp: { port:int!, tools:['invoke','register','state_get','state_set','resolve'] }
 *   FileStructure.'src/server.ts': 'main entry — creates both MCP servers, wires everything'
 *   CLI.start: --ext-port (default: 3100), --int-port (default: 3101), --project <dir>
 *
 * Phase 3B: Real Streamable HTTP MCP transport on both surfaces.
 * Phase 4: OTEL exporter wiring (FR-OTEL-009, FR-OTEL-010).
 *
 * Provides: createServer factory, Server interface, ServerConfig type, ServerHandlers type.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { createServer as createHttpServer } from 'node:http';
import type { Server as HttpServer } from 'node:http';
import { Registry, type RegistryStatus } from './registry.js';
import { SessionManager } from './session-manager.js';
import { TraceLog } from './trace-log.js';
import { SyntheticState, createRegisterHandler, createStateHandlers, createResolveHandler, createRespondHandler } from './handlers.js';
import { invoke as invokeHandler, RateLimitTracker, SelfLoopTracker } from './invoke.js';
import type { InvokeEnvelope, ResponseEnvelope } from './types.js';
import type { InvokeDeps } from './invoke.js';
import {
  createTraceHandler,
  createInspectHandler,
  createStatusHandler,
  createListAgentsHandler,
  createConsolidateHandler,
} from './mcp-external.js';
import {
  TraceInputSchema,
  InspectInputSchema,
  StatusInputSchema,
  ListAgentsInputSchema,
  ConsolidateInputSchema,
  StarmapInputSchema,
  InvokeInputSchema,
  AgentInvokeInputSchema,
  RegisterInputSchema,
  StateGetInputSchema,
  StateSetInputSchema,
  ResolveInputSchema,
  RespondInputSchema,
} from './schemas.js';
import { scanProjectFiles } from './scanner.js';
import { readFile } from 'node:fs/promises';
import { renderSystemPrompt, renderBootstrapPrompt } from './templates.js';
import { resolveDepPath } from './paths.js';
import { validateAndFixDeclarations } from './validation.js';
import { PersistenceLayer } from './persistence.js';
import { createLogger } from './logger.js';
import * as fs from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createOtelExporter, type OtelExporter } from './otel-export.js';

const log = createLogger('server');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type ServerConfig = {
  extPort?: number;
  intPort?: number;
  projectDir: string;
  /** Enable verbose logging of prompts, responses, and trace events */
  verbose?: boolean;
  /** Model to use for agent sessions (default: claude-sonnet-4-6) */
  model?: string;
  /** OTEL collector endpoint URL (default: '' — not configured) */
  otelEndpoint?: string;
  /** OTEL wire protocol (default: 'http/protobuf') */
  otelProtocol?: 'http/protobuf' | 'http/json';
  /** Enable OTEL trace export (default: false) */
  otelEnabled?: boolean;
};

/** Resolved config with defaults applied — all fields required. */
type ResolvedConfig = Required<ServerConfig>;

const DEFAULT_MODEL = 'claude-sonnet-4-6';

/**
 * All wired handler functions, grouped by MCP surface.
 *
 * Internal: invoke, register, state_get, state_set, resolve, respond
 * External: trace, inspect, status, listAgents, consolidate
 */
export type ServerHandlers = {
  // Internal MCP tools
  invoke: (envelope: InvokeEnvelope, deps: InvokeDeps) => Promise<ResponseEnvelope>;
  register: ReturnType<typeof createRegisterHandler>;
  state_get: (key: string) => unknown;
  state_set: (key: string, value: unknown) => { success: true };
  resolve: ReturnType<typeof createResolveHandler>;
  respond: ReturnType<typeof createRespondHandler>;
  // External MCP tools
  trace: ReturnType<typeof createTraceHandler>;
  inspect: ReturnType<typeof createInspectHandler>;
  status: ReturnType<typeof createStatusHandler>;
  listAgents: ReturnType<typeof createListAgentsHandler>;
  consolidate: ReturnType<typeof createConsolidateHandler>;
};

export interface Server {
  start(): Promise<void>;
  stop(): Promise<void>;
  getConfig(): ResolvedConfig;
  getRegistry(): Registry;
  getSessionManager(): SessionManager;
  getHandlers(): ServerHandlers;
  getTraceLog(): TraceLog;
  getPersistence(): PersistenceLayer | null;
  getOtelExporter(): OtelExporter | undefined;
}

// ---------------------------------------------------------------------------
// Defaults (from SPEC CLI.start flags)
// ---------------------------------------------------------------------------

const DEFAULT_EXT_PORT = 3100;
const DEFAULT_INT_PORT = 3101;

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function resolveConfig(config: ServerConfig): ResolvedConfig {
  return {
    extPort: config.extPort ?? DEFAULT_EXT_PORT,
    intPort: config.intPort ?? DEFAULT_INT_PORT,
    projectDir: config.projectDir,
    verbose: config.verbose ?? false,
    model: config.model ?? DEFAULT_MODEL,
    otelEndpoint: config.otelEndpoint ?? '',
    otelProtocol: config.otelProtocol ?? 'http/protobuf',
    otelEnabled: config.otelEnabled ?? false,
  };
}

export function createServer(config: ServerConfig): Server {
  const resolved = resolveConfig(config);
  const registry = new Registry();
  const sessionManager = new SessionManager();

  log.info('creating server', { projectDir: resolved.projectDir, model: resolved.model });

  // Wire SQLite persistence — stores registry state across restarts
  const dbPath = join(resolved.projectDir, '.ellmulator.db');
  let persistence: PersistenceLayer | null = null;
  try {
    persistence = new PersistenceLayer(dbPath);
    log.info('persistence layer opened', { dbPath });

    // Hydrate registry from persisted state
    const persisted = persistence.getAllAgents();
    let hydratedCount = 0;
    let skippedCount = 0;
    for (const entry of persisted) {
      try {
        registry.add({
          file_path: entry.file_path,
          file_hash: entry.file_hash,
          status: (entry.status as RegistryStatus) ?? 'cold',
          session_id: entry.session_id ?? null,
          declarations: entry.declarations ?? null,
          last_active: entry.last_active ?? null,
          error: entry.error ?? null,
        });
        hydratedCount++;
        log.debug('hydrated registry entry', {
          file: entry.file_path,
          status: entry.status,
          sessionId: entry.session_id ?? 'null',
          hasDeclarations: !!entry.declarations,
        });
      } catch {
        skippedCount++;
        log.debug('skipped duplicate/invalid entry during hydration', { file: entry.file_path });
      }
    }
    log.info('registry hydrated from persistence', { hydrated: hydratedCount, skipped: skippedCount, total: persisted.length });
  } catch (err) {
    // SQLite not available — fall back to in-memory only
    persistence = null;
    log.warn('persistence layer unavailable, using in-memory only', { dbPath, error: err instanceof Error ? err.message : String(err) });
  }

  // ---------------------------------------------------------------------------
  // FR-OTEL-009 + FR-OTEL-010: OTEL exporter creation (error-isolated)
  // ---------------------------------------------------------------------------
  let otelExporter: OtelExporter | undefined;
  if (resolved.otelEnabled && resolved.otelEndpoint) {
    try {
      otelExporter = createOtelExporter({
        endpoint: resolved.otelEndpoint,
        protocol: resolved.otelProtocol,
        serviceName: 'ellmulator',
        serviceVersion: '0.1.0',
      });
    } catch (err) {
      // FR-OTEL-010: factory init error isolation — server starts anyway
      log.warn('OTEL exporter initialization failed', { error: err instanceof Error ? err.message : String(err) });
      otelExporter = undefined;
    }
  }

  // Shared infrastructure — created eagerly so getHandlers()/getTraceLog() work pre-start
  log.debug('wiring shared infrastructure');
  const traceLog = new TraceLog();
  const syntheticState = new SyntheticState();
  const rateLimitTracker = new RateLimitTracker();
  const selfLoopTracker = new SelfLoopTracker();
  /** Shared invoke context map — invoke() stores parent trace context here (keyed by task_id),
   *  MCP invoke handler reads it to auto-fill envelope fields for agent invoke calls. */
  const activeInvokeContexts = new Map<string, { trace_id: string; caller: string; call_stack: string[]; max_depth: number }>();
  /** Maps MCP session IDs to agent file paths — populated on register, used by invoke to identify the calling agent. */
  const mcpSessionToFile = new Map<string, string>();
  // ---------------------------------------------------------------------------
  // Wire internal handlers (SPEC: Architecture.server.internal_mcp.tools)
  // ---------------------------------------------------------------------------
  const rawRegisterHandler = createRegisterHandler(registry);
  // Wrap register to persist to SQLite after successful registration
  const registerHandler: typeof rawRegisterHandler = (file_path, declarations) => {
    const result = rawRegisterHandler(file_path, declarations);
    if ('success' in result && persistence) {
      const entry = registry.get(file_path);
      if (entry) {
        persistence.upsertAgent({
          file_path: entry.file_path,
          file_hash: entry.file_hash,
          status: entry.status,
          session_id: entry.session_id ?? undefined,
          declarations: entry.declarations ?? undefined,
          last_active: entry.last_active ?? undefined,
          error: entry.error ?? undefined,
        });
      }
    }
    return result;
  };
  const stateHandlers = createStateHandlers(syntheticState);
  const resolveHandler = createResolveHandler(registry, (filePath: string) => {
    return readFileSync(join(resolved.projectDir, filePath), 'utf-8');
  });
  const respondHandler = createRespondHandler(sessionManager.getPendingResponses());

  // ---------------------------------------------------------------------------
  // Wire external handlers (SPEC: Architecture.server.external_mcp.tools)
  // ---------------------------------------------------------------------------
  // Verbose callback — logs trace prompts and responses via logger (debug level)
  const onVerbose = (event: { type: string; [key: string]: unknown }) => {
    if (event.type === 'invoke_prompt') {
      log.debug('invoke prompt', {
        target: event.target,
        function: event.function,
        caller: event.caller,
        depth: event.depth,
        sessionId: event.sessionId,
        promptLength: typeof event.prompt === 'string' ? (event.prompt as string).length : 0,
      });
    } else if (event.type === 'invoke_response') {
      log.debug('invoke response', {
        target: event.target,
        function: event.function,
        elapsed: `${event.duration_ms}ms`,
        refs: event.source_refs,
        error: event.error || undefined,
      });
    } else if (event.type === 'exploration_result') {
      log.debug('exploration result', {
        entryPoint: event.entry_point,
        function: event.function,
        reasoning: event.reasoning,
      });
    }
  };

  const traceHandler = createTraceHandler({
    registry,
    sessionManager,
    traceLog,
    syntheticState,
    rateLimitTracker,
    selfLoopTracker,
    readFile: (filePath: string) => fs.readFile(filePath, 'utf-8'),
    projectDir: resolved.projectDir,
    intPort: resolved.intPort,
    invoke: (envelope, invokeDepsShape) => invokeHandler(envelope, {
      ...invokeDepsShape,
      rateLimitTracker,
      selfLoopTracker,
      readFile: (filePath: string) => fs.readFile(filePath, 'utf-8'),
      projectDir: resolved.projectDir,
      model: resolved.model,
      intPort: resolved.intPort,
      invokeContexts: activeInvokeContexts,
    }),
    onVerbose,
    otelExporter,
  });

  const queryDeps = { registry, sessionManager, traceLog };
  const inspectHandler = createInspectHandler(queryDeps);
  const statusHandler = createStatusHandler(queryDeps);
  const listAgentsHandler = createListAgentsHandler(queryDeps);
  const consolidateHandler = createConsolidateHandler({
    registry,
    sessionManager,
    scanProjectFiles: () => scanProjectFiles(resolved.projectDir),
    projectDir: resolved.projectDir,
    spawnSession: async (filePath: string, fileHash: string) => {
      const systemPrompt = renderSystemPrompt({
        filePath,
        sourceCode: '',  // source is read by agent via cat -n, not embedded
      });
      const bootstrapPrompt = renderBootstrapPrompt({
        filePath,
      });
      const session = await sessionManager.create({
        filePath,
        fileHash,
        systemPrompt,
        bootstrapPrompt,
        cwd: resolved.projectDir,
        tools: ['mcp__internal__invoke', 'mcp__internal__register', 'mcp__internal__state_get', 'mcp__internal__state_set', 'mcp__internal__resolve'],
        mcpServers: {
          'internal': { type: 'http', url: `http://127.0.0.1:${resolved.intPort}/mcp` },
        },
        model: resolved.model,
      });
      return session.session_id;
    },
  });

  // ---------------------------------------------------------------------------
  // Assembled handlers object
  // ---------------------------------------------------------------------------
  const handlers: ServerHandlers = {
    // Internal
    invoke: invokeHandler,
    register: registerHandler,
    state_get: stateHandlers.state_get,
    state_set: stateHandlers.state_set,
    resolve: resolveHandler,
    respond: respondHandler,
    // External
    trace: traceHandler,
    inspect: inspectHandler,
    status: statusHandler,
    listAgents: listAgentsHandler,
    consolidate: consolidateHandler,
  };

  // ---------------------------------------------------------------------------
  // MCP Server Setup
  // ---------------------------------------------------------------------------

  // External MCP Server (:3100) — 6 tools for human/orchestrator
  const externalMcp = new McpServer({
    name: 'ellmulator-external',
    version: '1.0.0',
  });

  // Register external tools
  externalMcp.tool(
    'trace',
    'Start a trace scenario through the emulated codebase. Provide a free-form scenario string, or entry_file + function for targeted tracing.',
    TraceInputSchema.shape,
    async (args: any) => {
      // Map schema input to TraceRequest — scenario takes priority over entry_file+function
      const scenario = args.scenario
        || (args.function ? `Call ${args.function}(${JSON.stringify(args.params ?? {})})` : 'Trace the codebase');
      const request = {
        scenario,
        entry_point: args.entry_file,
        state: args.state ?? args.params,
        max_depth: args.max_depth,
        mode: args.mode,
      };
      const result = await traceHandler(request);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  externalMcp.tool(
    'inspect',
    'Inspect agent declarations for a specific file',
    InspectInputSchema.shape,
    async (args) => {
      const result = inspectHandler(args.file_path);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  externalMcp.tool(
    'status',
    'Get server status and statistics',
    StatusInputSchema.shape,
    async () => {
      const result = statusHandler();
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  externalMcp.tool(
    'list_agents',
    'List all registered agents with optional status filter',
    ListAgentsInputSchema.shape,
    async (args) => {
      const result = listAgentsHandler((args as any).filter_status);
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  externalMcp.tool(
    'consolidate',
    'Consolidate findings from a completed trace',
    ConsolidateInputSchema.shape,
    async (args) => {
      const result = await consolidateHandler({ reBootstrap: false });
      return {
        content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
      };
    }
  );

  externalMcp.tool(
    'starmap',
    'Generate dependency graph (Phase 4 — returns empty for now)',
    StarmapInputSchema.shape,
    async () => {
      return {
        content: [{ type: 'text', text: JSON.stringify({}, null, 2) }],
      };
    }
  );

  // Internal MCP tools are registered per-session in createInternalSession() below.
  // The MCP SDK's StreamableHTTPServerTransport is single-session: after the first
  // agent initializes, it rejects subsequent initialization requests. Each bootstrap
  // agent needs its own transport+server pair, with tool handlers sharing state via closures.

  // ---------------------------------------------------------------------------
  // HTTP Server Setup
  // ---------------------------------------------------------------------------

  let externalHttpServer: HttpServer | null = null;
  let internalHttpServer: HttpServer | null = null;
  let running = false;
  const internalSessions = new Map<string, { transport: StreamableHTTPServerTransport; server: McpServer }>();

  // Helper to read request body
  async function readBody(req: any): Promise<string> {
    return new Promise((resolve, reject) => {
      let body = '';
      req.on('data', (chunk: Buffer) => {
        body += chunk.toString();
      });
      req.on('end', () => resolve(body));
      req.on('error', reject);
    });
  }

  // ---------------------------------------------------------------------------
  // Lifecycle methods
  // ---------------------------------------------------------------------------

  return {
    async start(): Promise<void> {
      if (running) {
        log.debug('server already running, skipping start');
        return;
      }
      running = true;
      log.info('server starting', { extPort: resolved.extPort, intPort: resolved.intPort });

      // Create external HTTP server
      const externalTransport = new StreamableHTTPServerTransport({
        sessionIdGenerator: () => crypto.randomUUID(),
      });
      await externalMcp.connect(externalTransport);

      externalHttpServer = createHttpServer(async (req, res) => {
        if (req.url !== '/mcp') {
          res.writeHead(404);
          res.end();
          return;
        }

        try {
          if (req.method === 'POST') {
            const body = await readBody(req);
            await externalTransport.handleRequest(req, res, JSON.parse(body));
          } else if (req.method === 'GET' || req.method === 'DELETE') {
            // GET = SSE stream, DELETE = session termination
            await externalTransport.handleRequest(req, res);
          } else {
            res.writeHead(405);
            res.end();
          }
        } catch (error) {
          if (!res.headersSent) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: 'Internal server error' }));
          }
        }
      });

      await new Promise<void>((resolve, reject) => {
        externalHttpServer!.listen(resolved.extPort, '127.0.0.1', () => resolve());
        externalHttpServer!.on('error', reject);
      });

      // Create internal HTTP server — per-session transport pattern.
      // Each bootstrap agent initializes its own MCP session. The MCP SDK's
      // StreamableHTTPServerTransport is single-session: after the first agent
      // initializes, it rejects subsequent initialization requests with 400.
      // Fix: create a fresh transport+server per request, sharing tool handlers
      // via closures over the same registry/handler instances.
      function createInternalSession(): { transport: StreamableHTTPServerTransport; server: McpServer } {
        const sessionTransport = new StreamableHTTPServerTransport({
          sessionIdGenerator: () => crypto.randomUUID(),
        });
        const sessionMcp = new McpServer({
          name: 'ellmulator-internal',
          version: '1.0.0',
        });

        const mcpLog = log.child('mcp');
        // Re-register all internal tools on this session's server (closures share state)
        sessionMcp.tool('invoke', 'Trace into a runtime function in another file. Provide name, kind, file_path, optional params, and optional expected_output. The system fills in trace context (trace_id, task_id, caller, call_stack, max_depth) automatically. Check call_stack before invoking to prevent cycles. Maximum 5 invocations per task.', AgentInvokeInputSchema.shape, async (args) => {
          const agentArgs = args as { name: string; kind: string; file_path: string; params?: unknown; expected_output?: string };
          mcpLog.info('invoke called', { name: agentArgs.name, kind: agentArgs.kind, file_path: agentArgs.file_path });

          // Find parent invoke context via session-keyed lookup.
          // mcpSessionToFile maps this MCP session → agent file_path (set during register).
          // Then we find the invoke context where ctx.caller matches this agent's file.
          const callerFile = mcpSessionToFile.get(sessionTransport.sessionId ?? '');
          let parentCtx: { trace_id: string; caller: string; call_stack: string[]; max_depth: number } | undefined;
          if (callerFile) {
            for (const [, ctx] of activeInvokeContexts) {
              if (ctx.caller === callerFile) {
                parentCtx = ctx;
                break;
              }
            }
          }
          if (!parentCtx) {
            // Fallback: take first context (for backward compat / single-trace scenarios)
            for (const [, ctx] of activeInvokeContexts) {
              parentCtx = ctx;
              break;
            }
          }

          // Build full InvokeEnvelope from agent's simplified args + parent context
          const fullEnvelope = {
            trace_id: parentCtx?.trace_id ?? crypto.randomUUID(),
            task_id: crypto.randomUUID(),
            caller: parentCtx?.caller ?? 'unknown',
            target: agentArgs.file_path,
            function: agentArgs.name,
            params: agentArgs.params,
            call_stack: parentCtx?.call_stack ?? [],
            mode: 'sync' as const,
            max_depth: parentCtx?.max_depth ?? 50,
            ...(agentArgs.expected_output && { expected_output: agentArgs.expected_output }),
          };

          mcpLog.info('invoke envelope built', { caller: fullEnvelope.caller, target: fullEnvelope.target, function: fullEnvelope.function, depth: fullEnvelope.call_stack.length });

          const result = await invokeHandler(fullEnvelope, {
            registry, sessionManager, traceLog: (entry) => traceLog.add(entry),
            rateLimitTracker, selfLoopTracker,
            readFile: (filePath: string) => fs.readFile(filePath, 'utf-8'),
            projectDir: resolved.projectDir,
            model: resolved.model,
            intPort: resolved.intPort,
            onVerbose,
            invokeContexts: activeInvokeContexts,
          });
          mcpLog.debug('invoke result', { target: agentArgs.file_path, function: agentArgs.name, result: JSON.stringify(result).slice(0, 200) });
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        });

        sessionMcp.tool('register', 'Register declarations for this file agent. Call ONCE with file_path, declarations (with className.methodName for methods, params/return_type for functions/methods), exports, imports (with resolved file_path), and dependencies. Do NOT call more than once.', RegisterInputSchema.shape, async (args) => {
          mcpLog.info('register called', { file: args.file_path, declarations: Array.isArray(args.declarations) ? args.declarations.length : '?' });
          // Map this MCP session to its agent file_path — used by invoke handler for context lookup
          if (sessionTransport.sessionId) {
            mcpSessionToFile.set(sessionTransport.sessionId, args.file_path as string);
          }
          try {
            let declarations: any[] = args.declarations;
            if (typeof declarations === 'string') {
              mcpLog.warn('declarations received as string, parsing JSON', { file: args.file_path });
              try { declarations = JSON.parse(declarations); } catch { declarations = []; }
            }
            if (!Array.isArray(declarations)) declarations = [];

            // Parse exports (new field — subset of declarations that are exported)
            let exports: any[] = args.exports ?? [];
            if (typeof exports === 'string') {
              try { exports = JSON.parse(exports); } catch { exports = []; }
            }
            if (!Array.isArray(exports)) exports = [];

            // Parse imports (symbol-level imports from project files)
            let imports: any[] = args.imports ?? [];
            if (typeof imports === 'string') {
              try { imports = JSON.parse(imports); } catch { imports = []; }
            }
            if (!Array.isArray(imports)) imports = [];

            // Parse dependencies (file-level deps — can be DependencyRef[] or string[])
            let dependencies: any[] = args.dependencies ?? [];
            if (typeof dependencies === 'string') {
              console.error(`[register] WARNING: dependencies for ${args.file_path} received as string, parsing JSON`);
              try { dependencies = JSON.parse(dependencies); } catch { dependencies = []; }
            }
            if (!Array.isArray(dependencies)) dependencies = [];

            // Normalize dependency paths: can be string[] or DependencyRef[]
            const depPaths: string[] = dependencies.map((d: any) =>
              typeof d === 'string' ? d : (d.from || d.name)
            );
            // If imports provided but dependencies not, derive deps from imports
            const finalDepPaths = depPaths.length > 0 ? depPaths
              : imports.map((i: any) => i.from).filter(Boolean);

            // --- Point 10: Path normalization at registration time ---
            // Normalize dependency paths to canonical registry keys
            const normalizedDepPaths = finalDepPaths.map((dep: string) => {
              const resolved = resolveDepPath(dep, args.file_path as string, registry);
              return resolved ?? dep; // keep raw if unresolvable (bootstrap ordering)
            });

            // Normalize import file_path fields
            const finalImports = imports.length > 0 ? imports : dependencies.filter((d: any) => typeof d !== 'string');
            for (const imp of finalImports) {
              if (imp.from) {
                const resolvedFrom = resolveDepPath(imp.from, args.file_path as string, registry);
                if (resolvedFrom) {
                  imp.file_path = resolvedFrom;
                } else if (!imp.file_path) {
                  imp.file_path = imp.from; // fallback: raw path
                }
              }
              // Also try normalizing file_path directly if present
              if (imp.file_path) {
                const resolvedFp = resolveDepPath(imp.file_path, args.file_path as string, registry);
                if (resolvedFp) {
                  imp.file_path = resolvedFp;
                }
              }
            }

            // --- Point 3: Auto-fix + deviation validation ---
            const declPayload = {
              owns: declarations,
              exports,
              imports: finalImports,
              dependencies: normalizedDepPaths,
            };
            const deviations = validateAndFixDeclarations(declPayload);
            if (deviations.length > 0) {
              mcpLog.info('register deviations', {
                file: args.file_path,
                count: deviations.length,
                autoFixed: deviations.filter(d => d.issue.includes('auto-fixed') || d.issue.includes('keeping last')).length,
              });
            }

            const summary = declPayload.owns.length > 0
              ? declPayload.owns.map((d: any) => d.intent).filter(Boolean).join('; ').slice(0, 200) : '';
            const result = registerHandler(args.file_path, {
              summary,
              owns: declPayload.owns,
              exports: declPayload.exports,
              imports: declPayload.imports,
              dependencies: [...new Set(declPayload.dependencies)],
            });

            // Return deviations alongside success
            const response = deviations.length > 0
              ? { ...result, deviations }
              : result;
            return { content: [{ type: 'text', text: JSON.stringify(response, null, 2) }] };
          } catch (err) {
            const errorMsg = err instanceof Error ? err.message : String(err);
            mcpLog.error('register failed', { file: args.file_path, error: errorMsg });
            return { content: [{ type: 'text', text: JSON.stringify({ error: errorMsg }, null, 2) }], isError: true };
          }
        });

        sessionMcp.tool('state_get', 'Get synthetic state value by key', StateGetInputSchema.shape, async (args) => {
          mcpLog.debug('state_get called', { key: args.key });
          const result = stateHandlers.state_get(args.key);
          return { content: [{ type: 'text', text: JSON.stringify({ value: result }, null, 2) }] };
        });
        sessionMcp.tool('state_set', 'Set synthetic state value by key', StateSetInputSchema.shape, async (args) => {
          mcpLog.debug('state_set called', { key: args.key, value: JSON.stringify(args.value).slice(0, 100) });
          stateHandlers.state_set(args.key, args.value);
          return { content: [{ type: 'text', text: JSON.stringify({ success: true }, null, 2) }] };
        });
        sessionMcp.tool('resolve', 'Resolve declarations for a file path. Returns declarations enriched with source content from disk. Use for types/interfaces instead of invoking them.', ResolveInputSchema.shape, async (args) => {
          mcpLog.debug('resolve called', { file: args.file_path });
          const result = resolveHandler(args.file_path);
          return { content: [{ type: 'text', text: JSON.stringify({ declarations: result ?? null }, null, 2) }] };
        });
        sessionMcp.tool('respond', 'Submit structured trace data for a pending invoke. Call exactly once per task, LAST (after all invoke calls). source_refs MUST be a non-empty array of file:line citations.', RespondInputSchema.shape, async (args) => {
          const envelope = args as any;
          mcpLog.info('respond called', { taskId: envelope.task_id, responder: envelope.responder, refs: envelope.source_refs?.length ?? 0, error: envelope.error ?? undefined });
          const result = respondHandler(envelope);
          return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
        });

        return { transport: sessionTransport, server: sessionMcp };
      }

      internalHttpServer = createHttpServer(async (req, res) => {
        if (req.url !== '/mcp') {
          res.writeHead(404);
          res.end();
          return;
        }

        try {
          const sessionId = req.headers['mcp-session-id'] as string | undefined;

          if (req.method === 'POST') {
            const body = await readBody(req);
            const parsed = JSON.parse(body);

            // Check for existing session
            if (sessionId && internalSessions.has(sessionId)) {
              // Existing session — route to its transport
              const session = internalSessions.get(sessionId)!;
              await session.transport.handleRequest(req, res, parsed);
              return;
            }

            // New session — create fresh transport+server
            const session = createInternalSession();
            await session.server.connect(session.transport);

            // Capture session ID after handling (it's set during initialization)
            await session.transport.handleRequest(req, res, parsed);

            // Store session for subsequent requests
            if (session.transport.sessionId) {
              internalSessions.set(session.transport.sessionId, session);
              // Cleanup when session closes
              session.transport.onclose = () => {
                internalSessions.delete(session.transport.sessionId!);
              };
            }
          } else if ((req.method === 'GET' || req.method === 'DELETE') && sessionId && internalSessions.has(sessionId)) {
            // GET = SSE stream for server-to-client notifications
            // DELETE = client session termination
            const session = internalSessions.get(sessionId)!;
            await session.transport.handleRequest(req, res);
          } else if (req.method === 'DELETE') {
            // DELETE for unknown session — nothing to clean up
            res.writeHead(204);
            res.end();
          } else {
            // GET without session ID or other methods
            res.writeHead(400);
            res.end(JSON.stringify({ error: 'Bad Request: missing session ID' }));
          }
        } catch (error) {
          if (!res.headersSent) {
            res.writeHead(500);
            res.end(JSON.stringify({ error: 'Internal server error' }));
          }
        }
      });

      // Disable timeouts on the internal server — invoke chains can take minutes
      // as they fan out across multiple agents. Default Node.js timeouts (2min)
      // would kill long-running traces mid-flight.
      internalHttpServer.timeout = 0;
      internalHttpServer.requestTimeout = 0;
      internalHttpServer.keepAliveTimeout = 0;

      await new Promise<void>((resolve, reject) => {
        internalHttpServer!.listen(resolved.intPort, '127.0.0.1', () => resolve());
        internalHttpServer!.on('error', reject);
      });

      // Signal handlers
      const shutdown = async () => {
        await this.stop();
        process.exit(0);
      };

      process.on('SIGINT', shutdown);
      process.on('SIGTERM', shutdown);
    },

    async stop(): Promise<void> {
      if (!running) {
        log.debug('server already stopped, skipping');
        return;
      }
      running = false;
      log.info('server stopping');

      // FR-OTEL-010: Shutdown OTEL exporter (error-isolated)
      if (otelExporter) {
        try {
          await otelExporter.shutdown();
        } catch (err) {
          // FR-OTEL-010: shutdown error isolation — stop() completes anyway
          log.warn('OTEL shutdown failed', { error: err instanceof Error ? err.message : String(err) });
        }
      }

      // Close HTTP servers
      if (externalHttpServer) {
        await new Promise<void>((resolve) => {
          externalHttpServer!.close(() => resolve());
        });
        externalHttpServer = null;
      }

      if (internalHttpServer) {
        await new Promise<void>((resolve) => {
          internalHttpServer!.close(() => resolve());
        });
        internalHttpServer = null;
      }

      // Close all internal MCP sessions
      for (const [id, session] of internalSessions) {
        try { await session.transport.close(); } catch { /* ignore */ }
      }
      internalSessions.clear();

      // Clear trace log and guardrail trackers on shutdown
      traceLog.clear();
      log.info('server stopped');
    },

    getConfig(): ResolvedConfig {
      return resolved;
    },

    getRegistry(): Registry {
      return registry;
    },

    getSessionManager(): SessionManager {
      return sessionManager;
    },

    getHandlers(): ServerHandlers {
      return handlers;
    },

    getTraceLog(): TraceLog {
      return traceLog;
    },

    getPersistence(): PersistenceLayer | null {
      return persistence;
    },

    getOtelExporter(): OtelExporter | undefined {
      return otelExporter;
    },
  };
}
