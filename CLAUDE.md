# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What Is eLLMulator

Agentic Distributed Trace Simulation service. LLM agents (claude-code-sdk sessions) act as file-level software components that study assigned source code, then interact via synchronous MCP tool calls mirroring real function calls. The call graph emerges naturally from code control flow, capturing not just what happened but WHY each component behaved as it did.

## Commands

```bash
# Run all tests (341 passing, 20 test files)
npx vitest run

# Watch mode
npx vitest

# Run a single test file
npx vitest run src/registry.test.ts

# Build (TypeScript → dist/)
npx tsc

# Start server (after build)
node dist/server.js
```

## Architecture

**Dual MCP surface**: External MCP (port 3100) for users, Internal MCP (port 3101) for inter-agent communication.

### Core Flow
1. User calls `trace` (external MCP) with a scenario description
2. Server resolves entry point agent, builds `InvokeEnvelope`, calls `invoke()`
3. `invoke()` runs guardrails (cycle/depth/rate-limit/self-loop) → resolves target from registry → lazy-spawns agent if cold/stale → forwards prompt via SDK → validates `ResponseEnvelope` → logs `TraceEntry`
4. Agents can call other agents recursively via the internal `invoke` tool

### Key Design Patterns
- **Dependency injection everywhere**: `invoke()`, all handler factories, and external MCP handlers take deps objects — no globals
- **Handler factories**: `createXHandler(deps)` returns a handler function (not classes)
- **`type` for data shapes, `interface` for behavioral contracts** (e.g., `Server` interface vs `ServerConfig` type)
- **Types canonical in `types.ts`**, re-exported from `invoke.ts` for backward compat

### Source Files (src/)

| File | Role |
|------|------|
| `types.ts` | All shared types: InvokeEnvelope, ResponseEnvelope, TraceEntry, Finding, Declarations, etc. |
| `invoke.ts` | **THE CORE** — cycle/depth check, lazy spawn, SDK query, trace log |
| `registry.ts` | File→session→hash→status→declarations mapping (RegistryEntry CRUD) |
| `scanner.ts` | Recursive file tree walk, SHA256 hashing, extension/dir filtering |
| `session-manager.ts` | SDK wrapper — create, get, terminate, query, list sessions |
| `guardrails.ts` | Safety: checkCycle, checkDepth, checkRateLimit, checkSelfLoop, validateEnvelope |
| `handlers.ts` | Internal MCP: register, state_get/set, resolve handler factories |
| `templates.ts` | Prompt rendering: renderSystemPrompt, renderBootstrapPrompt, renderInvokePrompt |
| `mcp-external.ts` | External MCP: trace, inspect, status, list_agents, consolidate handler factories |
| `trace-log.ts` | TraceLog class — add, getByTraceId, toJSONL, list, clear |
| `server.ts` | Main entry — creates both MCP surfaces, wires all handlers via createServer() |
| `bootstrap.ts` | Bootstrap flow — scan → bulk register → concurrent spawn |
| `consolidate-flow.ts` | Consolidate flow — rescan, detect stale, re-bootstrap |
| `cli.ts` | CLI arg parsing — start, trace, consolidate, status commands |
| `analyzer.ts` | Post-trace analysis — contract mismatch, dead spots, summary |

## TypeScript Conventions

- ES2022 target, ES modules (`"type": "module"`)
- Strict mode enabled
- Tests co-located: `foo.ts` → `foo.test.ts` (vitest with globals)
- Status transitions: `cold→bootstrapping→ready→stale`, any→`error`
