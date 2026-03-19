# System Architecture

eLLMulator is a dual-MCP-surface server where LLM agents (Claude SDK sessions) impersonate source code files. Agents study their assigned file, register declarations, then communicate via synchronous MCP tool calls that mirror real function invocations. The call graph emerges naturally from code control flow, capturing not just what happened but WHY each component behaved as it did.

## Dual MCP Surface

Two HTTP MCP servers run on separate ports, each with distinct audiences:

| Surface | Default Port | Audience | Tools |
|---------|-------------|----------|-------|
| **External** | 3100 | Users, CLI, MCP clients | `trace`, `inspect`, `status`, `list_agents`, `consolidate`, `starmap` |
| **Internal** | 3101 | File agents (SDK sessions) | `invoke`, `register`, `state_get`, `state_set`, `resolve`, `respond` |

Each client/agent gets its own `StreamableHTTPServerTransport` + `McpServer` pair (per-session factory pattern). This is necessary because the MCP SDK transport is single-session, so concurrent agents need independent pairs.

## Module Dependency Map

```mermaid
graph TD
    cli[cli.ts] --> server[server.ts]
    cli --> init[init.ts]

    server --> registry[registry.ts]
    server --> session_mgr[session-manager.ts]
    server --> trace_log[trace-log.ts]
    server --> handlers[handlers.ts]
    server --> mcp_ext[mcp-external.ts]
    server --> invoke_mod[invoke.ts]
    server --> schemas[schemas.ts]
    server --> persistence[persistence.ts]
    server --> otel[otel-export.ts]
    server --> bootstrap_mod[bootstrap.ts]
    server --> scanner[scanner.ts]
    server --> templates[templates.ts]
    server --> validation[validation.ts]

    mcp_ext --> analyzer[analyzer.ts]
    mcp_ext --> starmap_mod[starmap.ts]
    mcp_ext --> consolidate[consolidate-flow.ts]

    invoke_mod --> guardrails[guardrails.ts]
    invoke_mod --> templates
    invoke_mod --> paths[paths.ts]

    bootstrap_mod --> scanner
    bootstrap_mod --> templates

    consolidate --> scanner

    handlers --> schemas

    subgraph "All modules import"
        types[types.ts]
    end

    registry -.-> types
    invoke_mod -.-> types
    handlers -.-> types
    mcp_ext -.-> types
    session_mgr -.-> types
```

## Layer Diagram

```mermaid
graph TB
    subgraph "Entry Points"
        CLI[CLI - cli.ts]
        EXT[External MCP :3100]
    end

    subgraph "MCP Surfaces"
        EXT_TOOLS[trace / inspect / status / list_agents / consolidate / starmap]
        INT_TOOLS[invoke / register / state_get / state_set / resolve / respond]
        INT[Internal MCP :3101]
    end

    subgraph "Core Engine"
        INV[invoke.ts - THE CORE]
        REG[registry.ts]
        SM[session-manager.ts]
        GR[guardrails.ts]
        TL[trace-log.ts]
        TMPL[templates.ts]
        ANA[analyzer.ts]
    end

    subgraph "Infrastructure"
        PERSIST[persistence.ts - SQLite]
        OTEL[otel-export.ts]
        SCAN[scanner.ts]
        BOOT[bootstrap.ts]
    end

    CLI --> EXT
    EXT --> EXT_TOOLS
    INT --> INT_TOOLS
    EXT_TOOLS --> INV
    INT_TOOLS --> INV
    INV --> REG
    INV --> SM
    INV --> GR
    INV --> TL
    INV --> TMPL
    EXT_TOOLS --> ANA
    BOOT --> SCAN
    BOOT --> SM
    REG --> PERSIST
```

## Server Composition

`createServer(config: ServerConfig)` in `src/server.ts` is the main factory. It:

1. **Resolves config** — applies defaults (ports 3100/3101, model `claude-sonnet-4-6`)
2. **Creates shared state:**
   - `Registry` — in-memory Map for file→agent mappings
   - `SessionManager` — SDK session lifecycle wrapper
   - `TraceLog` — trace entry collection
   - `SyntheticState` — shared key-value store for agents
   - `RateLimitTracker` / `SelfLoopTracker` — guardrail counters
3. **Opens persistence** — SQLite WAL-mode database, hydrates registry from disk
4. **Creates OTEL exporter** — error-isolated, fire-and-forget
5. **Wires handler factories** — each handler closes over its deps:
   - `createRegisterHandler(registry)`
   - `createStateHandlers(syntheticState)`
   - `createResolveHandler(registry, readFile)`
   - `createRespondHandler(pendingResponses)`
   - `createTraceHandler(traceDeps)`
   - `createInspectHandler(queryDeps)`
   - `createStatusHandler(queryDeps)`
   - `createListAgentsHandler(queryDeps)`
   - `createConsolidateHandler(consolidateDeps)`
6. **Starts HTTP servers** — binds both MCP surfaces with per-session transport factories

### Per-Session MCP Transport

When a new MCP session connects (agent during bootstrap, or external client):

```
HTTP POST /mcp → session factory → new McpServer + StreamableHTTPServerTransport
                                   ↓
                                   Register all tools for that surface
                                   ↓
                                   mcpSessionToFile[session_id] = agent_file_path
```

Two key maps bridge MCP sessions to trace context:

- **`mcpSessionToFile`** — `Map<mcp_session_id, file_path>` — identifies which agent is making a tool call
- **`activeInvokeContexts`** — `Map<task_id, {trace_id, caller, call_stack, max_depth}>` — auto-fills envelope fields when agents use the simplified `AgentInvokeInputSchema`

## Key Files

| File | Lines | Role |
|------|-------|------|
| `src/server.ts` | ~920 | Main entry, creates both MCP surfaces, wires handlers |
| `src/invoke.ts` | ~630 | THE CORE — guardrails, lazy spawn, SDK query, trace log |
| `src/session-manager.ts` | ~576 | SDK wrapper — create, rehydrate, invokeOnSession, terminate |
| `src/registry.ts` | ~103 | File→session→status mapping with state machine validation |
| `src/guardrails.ts` | ~151 | Safety: cycle, depth, rate-limit, self-loop, circuit breaker |
| `src/handlers.ts` | ~214 | Internal MCP handlers: register, state, resolve, respond |
| `src/mcp-external.ts` | ~200+ | External MCP handlers: trace, inspect, status, consolidate |
| `src/templates.ts` | ~150+ | Prompt rendering: system, bootstrap, invoke |
| `src/analyzer.ts` | ~860 | Post-trace analysis: 5 finding types + entry point detection |
| `src/bootstrap.ts` | ~150+ | Scan → bulk register → concurrent spawn |
| `src/types.ts` | ~170 | All shared type definitions |
| `src/schemas.ts` | ~239 | Zod validation schemas for all 12 MCP tools |

## See Also

- [Data Flow Diagrams](flows.md) — runtime trace, bootstrap, and invoke flows
- [Design Decisions](design-decisions.md) — DI, handler factories, per-session transport rationale
- [Type System](type-system.md) — all data shapes and behavioral contracts
