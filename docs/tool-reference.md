# MCP Tool Reference

eLLMulator exposes 12 MCP tools across two surfaces: 6 external (for users) and 6 internal (for agents).

## External Tools (port 3100)

### `trace`

Start a distributed trace simulation.

**Input:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `scenario` | `string` | No* | Natural language scenario description |
| `entry_file` | `string` | No* | Explicit entry point file path |
| `function` | `string` | No | Function to trace (required with `entry_file`) |
| `params` | `Record<string, any>` | No | Parameters to pass to entry function |
| `mode` | `'full' \| 'targeted' \| 'lens'` | No | Trace execution mode (default: `full`) |
| `max_depth` | `number` | No | Max call stack depth (default: 50) |
| `expected_output` | `string` | No | Expected return shape for assumption bug detection |
| `state` | `Record<string, any>` | No | Initial synthetic state |

*Either `scenario` or `entry_file` must be provided.

**Output:** `TraceResult` — `{trace_id, entries[], summary, findings[], duration_ms, observations?}`

**Example:**
```json
{
  "scenario": "What happens when a user logs in?",
  "max_depth": 10,
  "mode": "targeted"
}
```

### `inspect`

Get declarations and status for a specific file agent.

**Input:** `{ file_path: string }`

**Output:** Registry entry with session info and declarations.

### `status`

Get server statistics.

**Input:** `{}` (no parameters)

**Output:** `{ total_files, by_status: {cold, bootstrapping, ready, stale, error}, active_traces }`

### `list_agents`

List all registered agents.

**Input:** `{}` (no parameters)

**Output:** Array of agent info with file_path, status, session_id, declaration counts.

### `consolidate`

Rescan project, detect changes, and optionally re-bootstrap stale agents.

**Input:** `{ trace_id: string }` — trace to consolidate findings for.

**Output:** `ConsolidateResult` — `{total, stale, refreshed, new}`

### `starmap`

Get the dependency graph.

**Input:** `{ file_path?: string }` — optional filter to a specific file's neighborhood.

**Output:** Dependency graph with nodes, edges, and SCC clusters.

## Internal Tools (port 3101)

These tools are used by file agents during trace execution.

### `invoke`

Call a function on another file agent. The server auto-fills envelope fields from the parent trace context.

**Agent-facing input (simplified):**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `name` | `string` | Yes | Function/method name to trace |
| `kind` | `enum` | Yes | Symbol kind: `class`, `method`, `function`, `type`, `struct`, `interface`, `const`, `schema`, `enum` |
| `file_path` | `string` | Yes | Target file containing the symbol |
| `params` | `unknown` | No | Parameters to pass |
| `expected_output` | `string` | No | Expected return shape |

The server constructs the full `InvokeEnvelope` by looking up `activeInvokeContexts[task_id]` to auto-fill: `trace_id`, `task_id` (new UUID), `caller` (from `mcpSessionToFile`), `call_stack`, `max_depth`, `mode`.

**Output:** `ResponseEnvelope` from the target agent.

### `register`

Register file declarations during bootstrap. Called exactly once per agent per bootstrap cycle.

**Input:**

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `file_path` | `string` | Yes | The file this agent represents |
| `declarations` | `Declaration[]` | Yes | Code elements in the file |
| `exports` | `Declaration[]` | No | Exported declarations |
| `imports` | `DependencyRef[]` | No | Import dependencies |
| `dependencies` | `DependencyRef[] \| string[]` | No | File dependencies |

**Output:** `{ success: true }` or `{ error: string }`

**Merge behavior:** If the agent is already `ready` with existing declarations, new declarations are merged (upsert by name for owns/exports, dedup by name+from for imports, union for dependencies).

### `state_get`

Read a value from the synthetic key-value state.

**Input:** `{ key: string }`

**Output:** The stored value, or `undefined` if not set.

### `state_set`

Write a value to the synthetic key-value state.

**Input:** `{ key: string, value: any }`

**Output:** `{ success: true }`

### `resolve`

Look up another file's declarations. The server enriches results with source content derived from disk.

**Input:** `{ file_path: string }`

**Output:** `EnrichedDeclarations` — declarations with `content` field populated from disk (lines `start_line` to `end_line`), or `undefined` if not registered.

### `respond`

Submit a trace response. This is the mandatory final tool call for every agent during an invoke cycle.

**Input:** `ResponseEnvelope`:

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| `task_id` | `string` | Yes | Must match the invoke's task_id |
| `responder` | `string` | Yes | This agent's file path |
| `returns` | `unknown` | No | Return value (structured `TraceReturn` preferred) |
| `mutations` | `Mutation[]` | No | State changes observed |
| `source_refs` | `string[]` | **Yes (min 1)** | Source line references |
| `error` | `string` | No | Error code if invocation failed |

**Output:** `{ success: true }` or `{ error: string }`

**Validation:** `source_refs` must be a non-empty array. Responses without source citations are rejected. The agent gets up to 2 retries with validation feedback.

## Trace Modes

| Mode | Description | Use When |
|------|-------------|----------|
| **full** | Trace all reachable agents following the natural call graph | Default. Understanding complete system behavior |
| **targeted** | Only trace agents in `targetPath[]`, stub calls to others | Focusing on specific subsystem interactions |
| **lens** | Trace entry point agent only, stub all downstream calls | Quick inspection of a single component's behavior |

In **targeted** and **lens** modes, stubbed calls return a synthetic `ResponseEnvelope` with `stubbed: true` and are logged as stubbed `TraceEntry` records.

## Finding Types

Post-trace analysis detects 5 types of findings:

| Type | Severity | Detection Logic |
|------|----------|-----------------|
| `contract_mismatch` | high | Caller invokes a function that the target's declarations don't include in `owns` |
| `assumption_bug` | high/medium | Caller's `expected_output` doesn't match actual `result` (error when success expected = high; structural mismatch = medium) |
| `missing_error_path` | high | Target returns an error but caller has no subsequent error handling (retry, fallback, or error-related follow-up) |
| `dead_spot` | medium | Trace entry with an error (excluding `CYCLE_DETECTED` and `MAX_DEPTH_EXCEEDED`) |
| `unexpected_call` | low | Caller invokes a target that is not in its declared `dependencies` |

Findings are deduplicated by `(type, caller, target)` tuple.

## Response Envelope Contract

Agents must follow these rules when calling `respond`:

1. **`source_refs` is mandatory and non-empty** — every response must cite at least one source line (e.g., `"src/foo.ts:42-58"`)
2. **`task_id` must match** the invoke request's `task_id`
3. **`responder` must be set** to the agent's file path
4. **Structured `returns` preferred** — use `TraceReturn` shape: `{type, value, params, side_effects}`
5. **Retry behavior** — if validation fails, the agent gets up to 2 retries with feedback about what was wrong

## See Also

- [Type System](type-system.md) — detailed type definitions
- [Data Flow Diagrams](flows.md) — how tools interact at runtime
- [Operations](operations.md) — server configuration
