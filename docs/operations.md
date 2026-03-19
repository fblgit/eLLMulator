# Operations Guide

## Prerequisites

- **Node.js >= 22.0.0**
- **Anthropic API key** with Claude model access
- A target project to analyze

For installation and first-run setup, see [QUICKSTART.md](../QUICKSTART.md).

## Server Lifecycle

### Starting

```bash
ellmulator init /path/to/app
ellmulator start --project /path/to/app --bootstrap
```

Startup sequence:
1. Resolve config (apply defaults for ports, model, OTEL)
2. Open SQLite persistence at `<projectDir>/.ellmulator.db`
3. Hydrate registry from persistence (load previous bootstrap state)
4. Create OTEL exporter (error-isolated — failure doesn't block startup)
5. Bind HTTP servers on `127.0.0.1:3100` (external) and `127.0.0.1:3101` (internal)
6. If `--bootstrap`: scan, register, and spawn agent sessions
7. Rehydrate sessions for ready entries with persisted session_ids

### Stopping

`SIGINT` (Ctrl+C) or `SIGTERM` triggers graceful shutdown:
1. Close OTEL exporter
2. Close HTTP servers
3. Terminate all MCP sessions
4. Clear trace log

### Start Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--project <dir>` | *required* | Path to target project |
| `--bootstrap` | off | Scan and bootstrap all files on startup |
| `--force` | off | Re-bootstrap all files (even already-ready ones) |
| `--ext-port <n>` | 3100 | External MCP port |
| `--int-port <n>` | 3101 | Internal MCP port |
| `--threads <n>` | 10 | Concurrent bootstrap sessions |
| `--model <name>` | `claude-sonnet-4-6` | Claude model for agents |
| `--extensions <list>` | `.ts,.go,.py` | File extensions to scan (comma-separated) |
| `--skip-dirs <list>` | `.git,node_modules,vendor` | Directories to skip |
| `--verbose` | off | Enable debug logging |
| `--otel-endpoint <url>` | *(none)* | OTEL collector endpoint (enables export) |
| `--otel-protocol <proto>` | `http/protobuf` | OTEL wire protocol |
| `--no-otel` | off | Disable OTEL even if endpoint configured |

## Bootstrap Strategies

### Full Bootstrap

```bash
ellmulator start --project ./app --bootstrap --threads 10
```

Scans all matching files, registers as cold, spawns agent sessions concurrently. Each agent reads its source file, analyzes imports, and registers declarations.

### Incremental Bootstrap

On subsequent runs with `--bootstrap`, already-ready files with matching SHA256 hash are skipped. Only new or changed files are bootstrapped.

### Force Re-Bootstrap

```bash
ellmulator start --project ./app --bootstrap --force
```

Re-bootstraps all files regardless of current status.

### Adjusting Concurrency

The `--threads` flag controls how many agents bootstrap concurrently. Default is 10. Adjust based on:
- **API rate limits** — lower if hitting 429s
- **Machine resources** — each agent session is an SDK subprocess
- **Project size** — larger projects benefit from higher concurrency

## Persistence

### SQLite Database

Location: `<projectDir>/.ellmulator.db` (WAL mode for concurrent read/write)

**What's persisted:**
- Agent registry entries: `file_path`, `session_id`, `file_hash`, `status`, `declarations`, `last_active`, `error`

**Hydration on restart:**
- Persisted agents are loaded into the in-memory Registry
- Session IDs are rehydrated in the SessionManager without API calls
- SDK transcripts on disk (`~/.claude/projects/`) allow `resume + forkSession`

**Persistence gap:** If the server crashes after bootstrap marks an entry as `ready` but before `session_id` is persisted, the entry will have `session_id = null`. `invoke()` handles this on-demand by creating a fresh session.

## Consolidation

Consolidation detects file changes and optionally refreshes stale agents.

```bash
# Via MCP tool (requires running server)
# Call the consolidate tool from an MCP client
```

**When to consolidate:**
- After code changes to the target project
- Before re-tracing to ensure agent knowledge is current

**What it does:**
1. Rescans project files, computes new SHA256 hashes
2. **New file** → register as cold
3. **Hash changed** → terminate old session, mark stale
4. **Hash unchanged** → no action
5. **Deleted files** → remove from registry
6. If `reBootstrap=true` → spawn sessions for stale files

## OpenTelemetry Integration

### Enabling

```bash
ellmulator start --project ./app --bootstrap \
  --otel-endpoint http://localhost:4318/v1/traces
```

### Protocols

- `http/protobuf` (default) — binary encoding, efficient
- `http/json` — JSON encoding, human-readable for debugging

### Disabling

```bash
--no-otel  # Disable even if endpoint is configured
```

### Error Isolation

OTEL failures never affect server operation. The exporter is created in a try/catch block — if initialization fails, the server runs without telemetry. Export errors during runtime are logged but never propagate to callers.

### Compatible Collectors

Any OpenTelemetry-compatible collector works:
- **Jaeger** — `http://localhost:4318/v1/traces`
- **Grafana Tempo** — via OTEL collector
- **Honeycomb** — with API key header
- **OTEL Collector** — standard endpoint

## Logging

Structured logging to stderr (stdout reserved for program output).

**Format:** `HH:MM:SS.mmm LVL [component] message key=value`

**Components:** `server`, `invoke`, `trace`, `session`, `inspect`, `status`, `listAgents`, `cli`

**Levels:**
- Default: `info` — startup, bootstrap progress, trace results
- `--verbose`: `debug` — prompts, responses, SDK tool calls, registry state

## Project Onboarding

```bash
ellmulator init /path/to/your/app
```

Creates/updates three files idempotently:
1. **`.mcp.json`** — MCP server configuration pointing to `http://localhost:3100/mcp`
2. **`.claude/settings.local.json`** — Claude Code permissions for eLLMulator tools
3. **`CLAUDE.md`** — instructions for Claude Code to use eLLMulator

Override the port: `ellmulator init ./app --ext-port 4200`

## Troubleshooting

| Error | Meaning | Resolution |
|-------|---------|------------|
| `REGISTRY_NOT_BOOTSTRAPPED` | File is cold or stale | Run with `--bootstrap` or consolidate |
| `SESSION_NOT_AVAILABLE` | Agent session not running | Server will auto-revive on next invoke |
| `BOOTSTRAP_TIMEOUT` | Agent took >30s to register | Check API connectivity, reduce `--threads` |
| `CYCLE_DETECTED` | Circular call chain detected | Expected behavior — agent correctly identified a cycle |
| `MAX_DEPTH_EXCEEDED` | Call stack too deep | Increase `--max-depth` or investigate recursive patterns |
| `RATE_LIMITED` | Agent invoked >5 times per task | Likely indicates a loop — check trace for patterns |
| `LOOP_SUSPECTED` | Target visited >3 times per trace | Similar to rate limit — check for repeated calls |
| `CIRCUIT_OPEN` | Too many consecutive failures | Agent is consistently failing — check its source file |
| `BUDGET_EXCEEDED` | Session cost over limit | Expected safeguard — adjust budget or split trace |
| `NO_PENDING_REQUEST` | Agent called respond() without invoke | Timing issue — agent responded to wrong task_id |
| Database locked | SQLite contention | WAL mode handles this; restart if `.db-shm`/`.db-wal` grow large |
| Port already in use | Another process on 3100/3101 | Use `--ext-port` / `--int-port` to change ports |

## See Also

- [Data Flow Diagrams](flows.md) — what happens at runtime
- [QUICKSTART.md](../QUICKSTART.md) — getting started from scratch
- [Tool Reference](tool-reference.md) — MCP tool details
