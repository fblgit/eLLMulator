# eLLMulator — Quick Start Guide

Get from zero to your first agentic trace in minutes.

---

## Prerequisites

- **Node.js 22+** — check with `node -v`
- **Anthropic API key** — with access to Claude models ([console.anthropic.com](https://console.anthropic.com))
- **A target project** — any TypeScript, Go, or Python codebase you want to analyze

## 1. Install

```bash
git clone https://github.com/fblgit/eLLMulator.git
cd eLLMulator
npm install
npm run build
```

Verify the build:

```bash
npx ellmulator --help
# Should show: No command provided (this is expected — commands are: start, trace, consolidate, status)
```

## 2. Configure

Create a `.env` file in the eLLMulator directory:

```bash
ANTHROPIC_API_KEY=sk-ant-your-key-here
```

That's it. Everything else has sensible defaults.

## 3. Bootstrap a Project

Point eLLMulator at your project and let it build its understanding:

```bash
npx ellmulator start --project /path/to/your/app --bootstrap
```

What happens:

1. **Scan** — walks your project, finds source files (`.ts`, `.go`, `.py` by default), skips `node_modules`, `.git`, `vendor`, test files
2. **Register** — each file gets a registry entry with a SHA256 hash
3. **Bootstrap** — spawns Claude SDK sessions (default: 10 concurrent) where each agent analyzes its source file and registers its declarations (functions, classes, types, dependencies)
4. **Server** — starts listening on ports 3100 (external MCP) and 3101 (internal MCP)

You'll see output like:

```
Server running. Press Ctrl+C to stop.
```

The server stays running. Open a second terminal for traces.

### Customizing the Bootstrap

```bash
# Fewer concurrent sessions (saves API cost)
npx ellmulator start --project ./app --bootstrap --threads 3

# Only TypeScript files
npx ellmulator start --project ./app --bootstrap --extensions .ts,.tsx

# Use a faster/cheaper model
npx ellmulator start --project ./app --bootstrap --model claude-sonnet-4-5-20250514

# Custom ports
npx ellmulator start --project ./app --bootstrap --ext-port 4000 --int-port 4001

# Skip additional directories
npx ellmulator start --project ./app --bootstrap --skip-dirs .git,node_modules,vendor,generated,migrations
```

## 4. Run Your First Trace

With the server running, open a second terminal:

```bash
npx ellmulator trace "What happens when a user submits a login request?" \
  --entry src/auth/handler.ts
```

### What You Get Back

A `TraceResult` JSON object:

```json
{
  "trace_id": "a1b2c3d4-...",
  "entries": [
    {
      "trace_id": "a1b2c3d4-...",
      "task_id": "e5f6g7h8-...",
      "depth": 0,
      "caller": "__trace_initiator__",
      "target": "src/auth/handler.ts",
      "function": "__entry__",
      "params": { "scenario": "What happens when a user submits a login request?" },
      "result": { "status": 200, "body": { "token": "jwt-..." } },
      "source_refs": ["src/auth/handler.ts:15-28"],
      "duration_ms": 3200
    },
    {
      "depth": 1,
      "caller": "src/auth/handler.ts",
      "target": "src/db/users.ts",
      "function": "findByEmail",
      "params": { "email": "user@example.com" },
      "result": { "id": "u-1", "email": "user@example.com", "passwordHash": "..." },
      "source_refs": ["src/db/users.ts:42-55"]
    }
  ],
  "findings": [
    {
      "type": "missing_error_path",
      "severity": "medium",
      "caller": "src/auth/handler.ts",
      "target": "src/db/users.ts",
      "description": "src/auth/handler.ts calls src/db/users.ts.findByEmail but has no error handling for failure"
    }
  ],
  "summary": "Trace explored 4 files across 3 depth levels. Entry: src/auth/handler.ts → src/auth/service.ts → src/db/users.ts. 1 finding: missing error path in auth handler.",
  "duration_ms": 8500
}
```

### Save the Trace Log

```bash
npx ellmulator trace "Process a payment" \
  --entry src/payments/index.ts \
  --output payment-trace.jsonl
```

The `--output` flag writes the raw trace log in JSONL format — one JSON object per line, one line per trace entry.

### Inject Initial State

Pass synthetic state that agents can read during the trace:

```bash
npx ellmulator trace "Handle checkout for premium user" \
  --entry src/checkout.ts \
  --state '{"user": {"id": "u-1", "tier": "premium"}, "cart": {"items": 3}}'
```

Agents access this via `state_get` during execution.

### Limit Depth

For large codebases, limit how deep the call graph goes:

```bash
npx ellmulator trace "User signup flow" \
  --entry src/signup.ts \
  --max-depth 5
```

Default is 50. At the depth limit, agents summarize instead of recursing deeper.

## 5. Understanding Findings

eLLMulator produces five types of findings:

### contract_mismatch ⚠️

```json
{
  "type": "contract_mismatch",
  "severity": "high",
  "caller": "src/api/orders.ts",
  "target": "src/services/inventory.ts",
  "description": "src/api/orders.ts calls checkStock on src/services/inventory.ts but target does not declare this function"
}
```

**What it means:** The caller assumes an API that doesn't exist on the target. Maybe the function was renamed, moved, or the import is wrong.

### assumption_bug 🐛

```json
{
  "type": "assumption_bug",
  "severity": "medium",
  "caller": "src/services/billing.ts",
  "target": "src/db/users.ts",
  "description": "src/services/billing.ts expected 'Returns User with id, name, email' from src/db/users.ts.getUser but result does not match"
}
```

**What it means:** The caller expects certain fields or shapes from a dependency's return value, but the actual result doesn't match. Classic data contract mismatch.

### missing_error_path 🚧

```json
{
  "type": "missing_error_path",
  "severity": "medium",
  "caller": "src/api/handler.ts",
  "target": "src/services/payment.ts",
  "description": "src/services/payment.ts returned error 'PAYMENT_DECLINED' but src/api/handler.ts has no error handling"
}
```

**What it means:** A dependency can fail, but the caller doesn't handle it. The error will propagate unexpectedly.

### dead_spot 💀

```json
{
  "type": "dead_spot",
  "severity": "medium",
  "caller": "src/utils/logger.ts",
  "target": "src/utils/logger.ts",
  "description": "src/utils/logger.ts is registered but never referenced in the trace"
}
```

**What it means:** This file exists and was bootstrapped, but no trace scenario exercised it. Could be dead code, or you need more trace scenarios.

### unexpected_call ❓

```json
{
  "type": "unexpected_call",
  "severity": "low",
  "caller": "src/auth/service.ts",
  "target": "src/notifications/email.ts",
  "description": "src/auth/service.ts calls src/notifications/email.ts which is not in its declared dependencies"
}
```

**What it means:** The caller invoked a target it didn't declare as a dependency. May indicate an undeclared import or implicit coupling.

## 6. Trace Modes

### Full Mode (default)

Recursively follows the entire call graph depth-first. Every agent that gets invoked can invoke its own dependencies.

```bash
npx ellmulator trace "Complete order flow" --entry src/api.ts
```

### Targeted Mode

Invokes the entry point and selectively follows specific dependencies. Useful when you want to focus on a particular call path.

Use this through the MCP `trace` tool with `mode: "targeted"`.

### Lens Mode

Invokes only the entry point agent. All of its dependencies are replaced with stub entries in the trace log. Fast and cheap — great for analyzing a single file's behavior.

Use this through the MCP `trace` tool with `mode: "lens"`.

## 7. Consolidate After Changes

When you modify source files, eLLMulator detects changes via hash comparison:

Connect to the running server via an MCP client and call the `consolidate` tool. It will:

1. Rescan the project directory
2. Compare file hashes against the registry
3. Mark changed files as `stale` (terminates their old sessions)
4. Register new files as `cold`
5. Optionally re-bootstrap stale files with fresh sessions

After consolidation, traces will use updated agents for modified files.

## 8. Using with Claude Code

eLLMulator exposes a standard MCP interface. The `init` command wires everything into your project automatically.

### Step 1: Initialize Your Project

From the eLLMulator directory, run:

```bash
npx ellmulator init /path/to/your/app
```

This idempotently configures three files in your project:

| File | What it does |
|------|-------------|
| `.mcp.json` | Adds `ellmulator` MCP server entry (localhost:3100) |
| `.claude/settings.local.json` | Adds tool permissions (`trace`, `inspect`, `status`, `list_agents`, `consolidate`) |
| `CLAUDE.md` | Appends eLLMulator usage section |

Safe to re-run — it merges without clobbering existing config.

```bash
# Custom port (if running eLLMulator on non-default port)
npx ellmulator init /path/to/your/app --ext-port 4200
```

### Step 2: Start the Server

```bash
npx ellmulator start --project /path/to/your/app --bootstrap
```

### Step 3: Use Tools in Claude Code

Once initialized and server is running, Claude Code can call eLLMulator tools directly:

- **`trace`** — *"Trace what happens when a user resets their password"*
- **`inspect`** — *"Show me the declarations for src/auth/service.ts"*
- **`status`** — *"How many files are bootstrapped?"*
- **`list_agents`** — *"List all agents with status=ready"*
- **`consolidate`** — *"Rescan the project for changes"*

## 9. Tips

### Cost Management

Each agent session uses Claude API calls. To control costs:

- Use `--threads 3` (or lower) for bootstrap — limits concurrent sessions
- Use `--model claude-sonnet-4-5-20250514` for cheaper traces when deep analysis isn't needed
- Use `--max-depth 10` to limit trace recursion
- Use lens mode for quick single-file analysis

### Best Scenarios

Traces work best with specific, behavioral scenarios:

```bash
# Good — specific flow
npx ellmulator trace "What happens when a user with expired session tries to access /api/orders?"

# Good — error path exploration
npx ellmulator trace "What happens when the database is unreachable during checkout?"

# Less useful — too vague
npx ellmulator trace "How does the app work?"
```

### Large Projects

For projects with hundreds of files:

- Bootstrap in stages: use `--extensions .ts` first, add more later
- Use targeted or lens mode for focused analysis
- Start with key entry points (`src/index.ts`, `src/api/router.ts`)
- Consolidate after major changes instead of re-bootstrapping everything

### Reading Trace Logs

JSONL output (`--output`) gives you one trace entry per line. You can process it with standard tools:

```bash
# Count entries
wc -l trace.jsonl

# Find errors
cat trace.jsonl | jq 'select(.error != null)'

# Show the call tree
cat trace.jsonl | jq '{depth, caller, target, function}'
```

## 10. OpenTelemetry Export

eLLMulator can export trace data as OpenTelemetry spans to any OTLP-compatible collector (Jaeger, Grafana Tempo, Honeycomb, etc.).

### Enable OTEL on the Server

```bash
npx ellmulator start --project ./app --bootstrap \
  --otel-endpoint http://localhost:4318/v1/traces
```

That's it. Each `TraceEntry` becomes an OTEL span with:
- **Span name:** `target.function` (e.g., `src/auth.ts.loginUser`)
- **Parent-child hierarchy:** derived from call depth and caller/target matching
- **Attributes:** `ellmulator.caller`, `ellmulator.target`, `ellmulator.depth`, `ellmulator.call_stack`, source refs
- **Events:** invoke params/results, state mutations, findings — all attached as span events

### OTEL Flags

| Flag | Default | Description |
|------|---------|-------------|
| `--otel-endpoint <url>` | *(none)* | Collector URL — enables OTEL when set |
| `--otel-protocol <proto>` | `http/protobuf` | Wire protocol: `http/protobuf` or `http/json` |
| `--no-otel` | — | Disable export even if endpoint is configured |

### Per-Trace OTEL

The `trace` command also accepts `--otel-endpoint` and `--otel-protocol` for per-trace export:

```bash
npx ellmulator trace "Login flow" --entry src/auth.ts \
  --otel-endpoint http://localhost:4318/v1/traces
```

### Example with Jaeger

```bash
# Start Jaeger all-in-one (Docker)
docker run -d --name jaeger \
  -p 16686:16686 \
  -p 4318:4318 \
  jaegertracing/all-in-one:latest

# Start eLLMulator with OTEL pointed at Jaeger
npx ellmulator start --project ./app --bootstrap \
  --otel-endpoint http://localhost:4318/v1/traces

# Run a trace
npx ellmulator trace "User login" --entry src/auth.ts

# View in Jaeger UI: http://localhost:16686
# Search for service: ellmulator
```

### Design Notes

- **Fire-and-forget:** Export happens asynchronously after trace completion — it never blocks or fails the trace
- **Error isolation:** If the collector is unreachable, the trace still succeeds; export errors are logged but swallowed
- **Immediate export:** Uses `SimpleSpanProcessor` (not batched) for real-time span emission

## 11. Troubleshooting

### "No command provided"

eLLMulator requires a subcommand: `start`, `trace`, `init`, `consolidate`, or `status`.

```bash
npx ellmulator start --project ./app --bootstrap
```

### "—project is required for start command"

The `--project` flag is mandatory for `start`:

```bash
npx ellmulator start --project /absolute/or/relative/path
```

### Bootstrap is slow

Each file gets its own Claude session. For a 50-file project with 10 threads, that's 5 rounds of API calls. Reduce threads to reduce cost, or use a faster model:

```bash
npx ellmulator start --project ./app --bootstrap --threads 3 --model claude-sonnet-4-5-20250514
```

### "consolidate/status command requires access to live server state"

These commands need a running server. Start the server first with `ellmulator start`, then connect via an MCP client.

### Agent shows status "error"

Check the agent's error field via the `inspect` tool. Common causes:
- API rate limits (too many concurrent sessions)
- Malformed source files
- Missing dependencies referenced in imports

### Trace shows CYCLE_DETECTED

The guardrails prevented an infinite loop. The agent tried to invoke a file that was already in the call stack. This is expected behavior — the trace continues with other branches.

### Trace shows MAX_DEPTH_EXCEEDED

The call graph is deeper than `--max-depth` (default: 50). Either:
- Increase the limit: `--max-depth 100`
- Or accept it — the agent summarizes instead of recursing at the limit

---

**Ready to go?** Start with a small project (5-20 files), bootstrap it, and run a trace on its main flow. You'll see findings you wouldn't catch with static analysis alone.
