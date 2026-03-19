# Data Flow and Lifecycle Diagrams

## 1. Trace Flow (End-to-End)

A user calls `trace` via the external MCP surface. The server detects the entry point, builds an invoke envelope, and kicks off a recursive agent call chain.

```mermaid
sequenceDiagram
    participant User as User / CLI
    participant Ext as External MCP :3100
    participant TH as traceHandler
    participant EP as Entry Point Detection
    participant Inv as invoke()
    participant GR as Guardrails
    participant SM as SessionManager
    participant Agent as File Agent (SDK)
    participant Int as Internal MCP :3101
    participant RH as respondHandler
    participant AN as Analyzer

    User->>Ext: trace(scenario, entry_file?, max_depth?)
    Ext->>TH: dispatch request
    TH->>EP: detectEntryPoint(scenario, registry, starmap)
    EP-->>TH: {entry_file, function}
    TH->>Inv: invoke(envelope)
    Inv->>GR: checkCycle, checkDepth, checkRateLimit, checkSelfLoop
    GR-->>Inv: all pass
    Inv->>Inv: resolve target from registry
    Inv->>Inv: revive session if needed
    Inv->>SM: invokeOnSession(prompt)
    SM->>Agent: SDK query (renderInvokePrompt)

    Note over Agent: Agent may call other agents recursively
    Agent->>Int: invoke(child_file, function, params)
    Int->>Inv: invoke(child_envelope)
    Inv-->>Int: child ResponseEnvelope
    Int-->>Agent: result

    Agent->>Int: respond(ResponseEnvelope)
    Int->>RH: validate + resolve pending Promise
    RH-->>SM: ResponseEnvelope
    SM-->>Inv: ResponseEnvelope
    Inv->>Inv: log TraceEntry
    Inv-->>TH: ResponseEnvelope
    TH->>AN: analyzeTrace(entries, registry)
    AN-->>TH: findings[]
    TH->>AN: summarizeTraceAsync(entries)
    AN-->>TH: summary
    TH-->>Ext: TraceResult
    Ext-->>User: JSON result
```

## 2. Bootstrap Flow

Bootstrap scans project files, registers them as cold, then concurrently spawns agent sessions that read their source and register declarations.

```mermaid
flowchart TD
    A["ellmulator start --bootstrap"] --> B[scanProjectFiles]
    B --> C["Register each file as 'cold'"]
    C --> D["runWithConcurrency (threads=N)"]
    D --> E{For each file}

    E --> F["Set status: 'bootstrapping'"]
    F --> G[sessionManager.create]
    G --> H[SDK query with bootstrapPrompt]

    H --> I["Agent reads source via cat -n"]
    I --> J[Agent reads direct imports]
    J --> K["Agent calls register MCP tool"]
    K --> L["registerHandler: set declarations, status='ready'"]
    L --> M[Persist to SQLite]

    E --> N{Error?}
    N --> O["Set status: 'error'"]

    M --> P[BootstrapResult]
    O --> P
```

**Bounded concurrency:** Default 10 threads. Adjust via `--threads` based on API rate limits.

**Incremental bootstrap:** Already-ready files with matching hash are skipped (unless `--force`).

## 3. Agent Lifecycle (Status State Machine)

```mermaid
stateDiagram-v2
    [*] --> cold: scan + register
    cold --> bootstrapping: bootstrap starts
    cold --> error: bootstrap fails
    bootstrapping --> ready: agent calls register()
    bootstrapping --> error: bootstrap fails
    ready --> stale: file hash changes
    ready --> error: runtime failure
    stale --> bootstrapping: re-bootstrap
    stale --> error: re-bootstrap fails
    error --> error: terminal
```

Key transitions:
- **cold → bootstrapping:** Triggered when bootstrap starts spawning the agent
- **bootstrapping → ready:** Triggered when the agent calls `register` with its declarations
- **ready → stale:** Automatic side effect when `Registry.update()` detects a hash change
- **Any → error:** Terminal state on failure

## 4. Invoke Chain (Single Call)

Every invocation passes through this pipeline of guardrails before reaching the target agent.

```mermaid
flowchart TD
    A[invoke envelope] --> B{checkCycle}
    B -->|target in call_stack| Z1["CYCLE_DETECTED"]
    B -->|pass| C{checkDepth}
    C -->|stack >= max_depth| Z2["MAX_DEPTH_EXCEEDED"]
    C -->|pass| D{checkRateLimit}
    D -->|agent called > 5 times| Z3["RATE_LIMITED"]
    D -->|pass| E{checkSelfLoop}
    E -->|target visited > 3 times| Z4["LOOP_SUSPECTED"]
    E -->|pass| F[Resolve target from registry]

    F -->|not found| Z5["FILE_NOT_REGISTERED"]
    F -->|error status| Z6["AGENT_ERROR"]
    F -->|cold or stale| Z7["REGISTRY_NOT_BOOTSTRAPPED"]
    F -->|bootstrapping| G[Poll until ready - 30s timeout]
    F -->|ready| H{Session available?}

    G --> H
    H -->|session null| I[reviveSession]
    H -->|session exists| J[renderInvokePrompt]
    I --> J

    J --> K["invokeOnSession (forkSession=true)"]
    K --> L{validateResponseEnvelope}
    L -->|invalid + retries left| M[Retry with validation feedback]
    L -->|valid| N[Log TraceEntry]
    M --> K

    N --> O[Return ResponseEnvelope]

    style Z1 fill:#f66
    style Z2 fill:#f66
    style Z3 fill:#f66
    style Z4 fill:#f66
    style Z5 fill:#f66
    style Z6 fill:#f66
    style Z7 fill:#f66
```

## 5. MCP Tool Routing

```mermaid
graph LR
    subgraph "External MCP :3100"
        trace
        inspect
        status
        list_agents
        consolidate
        starmap
    end

    subgraph "Internal MCP :3101"
        invoke
        register
        state_get
        state_set
        resolve
        respond
    end

    subgraph "Handlers"
        traceHandler
        inspectHandler
        statusHandler
        listAgentsHandler
        consolidateHandler
        invokeHandler
        registerHandler
        stateHandlers
        resolveHandler
        respondHandler
    end

    subgraph "Core"
        invoke_fn["invoke()"]
        registry["Registry"]
        session_mgr["SessionManager"]
        trace_log["TraceLog"]
        synth_state["SyntheticState"]
    end

    trace --> traceHandler --> invoke_fn
    inspect --> inspectHandler --> registry
    status --> statusHandler --> registry
    list_agents --> listAgentsHandler --> registry
    consolidate --> consolidateHandler

    invoke --> invokeHandler --> invoke_fn
    register --> registerHandler --> registry
    state_get --> stateHandlers --> synth_state
    state_set --> stateHandlers
    resolve --> resolveHandler --> registry
    respond --> respondHandler --> session_mgr
```

## 6. Consolidation Flow

Consolidation rescans the project to detect file changes, marks stale entries, and optionally re-bootstraps.

```mermaid
flowchart TD
    A[consolidate] --> B[scanProjectFiles]
    B --> C{For each scanned file}

    C -->|New file| D["Register as 'cold', count++"]
    C -->|Hash changed| E["Terminate old session"]
    E --> F["Mark 'stale', count++"]
    C -->|Hash unchanged| G[No action]

    B --> H[Check for deleted files]
    H --> I[Remove from registry]

    I --> J{reBootstrap?}
    J -->|yes| K["Spawn sessions for stale files"]
    K --> L["Count refreshed"]
    J -->|no| M[Done]
    L --> M

    M --> N["ConsolidateResult {total, stale, refreshed, new}"]
```

## 7. OTEL Export Pipeline

Trace entries are converted to OpenTelemetry spans and exported to a collector. The pipeline is fire-and-forget — errors never affect the server.

```mermaid
flowchart LR
    A["TraceEntry[]"] --> B[convertToSpans]
    B --> C[deriveParentSpanIds]
    B --> D[Set span attributes]
    B --> E[Derive span status]
    B --> F[Generate span events]

    C --> G["ReadableSpan[]"]
    D --> G
    E --> G
    F --> G

    G --> H["SimpleSpanProcessor.onEnd()"]
    H --> I[OTLPTraceExporter]
    I --> J["Collector (Jaeger / Tempo / Honeycomb)"]

    style J fill:#9cf
```

Span hierarchy is derived from `call_stack` — each entry's parent is identified by matching the last element of its call stack to another entry's target.

## 8. Session Revival Decision Tree

When `invoke()` needs a session for a target agent, it follows this decision tree:

```mermaid
flowchart TD
    A[Session needed for target] --> B{session_id in registry?}

    B -->|yes| C["Try rehydrate (register in memory Map)"]
    C -->|success| D["Use resume + forkSession (zero API calls)"]
    C -->|fail| E[Create fresh session via SDK]

    B -->|no| E

    E --> F{Declarations exist?}
    F -->|yes| G["Lightweight 'ready' prompt (skip full bootstrap)"]
    F -->|no| H[Full bootstrap prompt]

    G --> I[SDK query]
    H --> I
    I --> J[Update registry with new session_id]

    D --> K[Ready for invokeOnSession]
    J --> K
```

**Rehydrate** = register existing session_id in the in-memory Map without API calls. The SDK transcript on disk (`~/.claude/projects/`) allows `resume + forkSession` to continue the conversation.

**Create fresh** = spawn a new SDK session. If the agent already has declarations (from a previous bootstrap), use a lightweight prompt instead of re-reading the entire file.

## See Also

- [Architecture](architecture.md) — module structure and composition
- [Tool Reference](tool-reference.md) — MCP tool schemas
- [Operations](operations.md) — how to trigger these flows
