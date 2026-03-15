/**
 * FR-009: Prompt Templates
 *
 * Renders structured prompt strings for the four agent phases:
 * - System: file-agent identity and constraints (persists across invocations)
 * - Bootstrap: one-shot registration of file declarations
 * - Invoke: per-trace-task analysis prompt with respond() contract
 * - Exploration: entry point detection for trace initialization
 *
 * Amendment A5: SPEC originally specified .md files in a templates/ directory.
 * We use inline TypeScript functions instead — they're testable, typed, and working.
 */

import type { Declarations, InvokeEnvelope, TraceEntry } from './types.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type RegistryMapEntry = {
  path: string;
  status: string;
  summary: string | null;
};

export type BoundaryInfo = {
  /** Files in the same cluster — trace directly, don't invoke */
  sameCluster: string[];
  /** Files in other clusters — use invoke() for cross-boundary calls */
  crossBoundary: string[];
};

// ---------------------------------------------------------------------------
// renderSystemPrompt
// ---------------------------------------------------------------------------

type SystemPromptVars = {
  filePath: string;
  sourceCode: string;
  dependencySources?: string[];
  boundaryInfo?: BoundaryInfo;
};

export function renderSystemPrompt(vars: SystemPromptVars): string {
  const { filePath, sourceCode, dependencySources, boundaryInfo } = vars;

  // --- Source code section ---
  const sourceSection = sourceCode
    ? `\n<source_code>\n${sourceCode}\n</source_code>\n`
    : '';

  // --- Dependency sources section ---
  const depSourcesSection = dependencySources && dependencySources.length > 0
    ? '\n<dependency_sources>\n' + dependencySources.join('\n---\n') + '\n</dependency_sources>\n'
    : '';

  // --- Boundary Routing section ---
  const boundarySection = boundaryInfo
    ? '\n## Boundary Routing\n' +
      (boundaryInfo.sameCluster.length > 0
        ? '**Same cluster** (analyze directly):\n' + boundaryInfo.sameCluster.map(f => '- `' + f + '`').join('\n') + '\n\n'
        : '') +
      (boundaryInfo.crossBoundary.length > 0
        ? '**Cross-boundary** (use invoke):\n' + boundaryInfo.crossBoundary.map(f => '- `' + f + '`').join('\n') + '\n'
        : '')
    : '';

  return `You are the analysis agent for \`${filePath}\`.
${sourceSection}${depSourcesSection}${boundarySection}
Answer ONLY via MCP tool calls. Cite \`${filePath}:<line>\` for every behavioral claim. Do NOT modify files.`;
}

// ---------------------------------------------------------------------------
// renderBootstrapPrompt
// ---------------------------------------------------------------------------

type BootstrapPromptVars = {
  filePath: string;
};

export function renderBootstrapPrompt(vars: BootstrapPromptVars): string {
  const { filePath } = vars;

  return `# Bootstrap: ${filePath}

## Step 1 — Read your file
\`\`\`
cat -n ${filePath}
\`\`\`

## Step 2 — Read your direct imports
For each project-file import (not npm packages), use \`cat -n <import_path>\` to read the source. Depth 1 only. For re-exports, follow one level to the actual definition.

## Step 3 — Register declarations
Call \`mcp__internal__register\` exactly once with ALL your declarations.

\`\`\`json
{
  "file_path": "${filePath}",
  "declarations": [
    {
      "name": "MyClass",
      "kind": "class",
      "intent": "one-line purpose",
      "file_path": "${filePath}",
      "start_line": 10,
      "end_line": 50
    },
    {
      "name": "MyClass.constructor",
      "kind": "method",
      "intent": "one-line purpose",
      "file_path": "${filePath}",
      "start_line": 12,
      "end_line": 20,
      "params": [{ "name": "config", "type": "Config" }],
      "return_type": "MyClass"
    },
    {
      "name": "MyClass.process",
      "kind": "method",
      "intent": "one-line purpose",
      "file_path": "${filePath}",
      "start_line": 22,
      "end_line": 45,
      "params": [{ "name": "input", "type": "string" }],
      "return_type": "Promise<Result>"
    },
    {
      "name": "helperFunction",
      "kind": "function",
      "intent": "one-line purpose",
      "file_path": "${filePath}",
      "start_line": 55,
      "end_line": 70,
      "params": [{ "name": "data", "type": "Buffer" }],
      "return_type": "void"
    },
    {
      "name": "MyType",
      "kind": "type",
      "intent": "one-line purpose",
      "file_path": "${filePath}",
      "start_line": 5,
      "end_line": 8
    }
  ],
  "exports": [
    {
      "name": "MyClass",
      "kind": "class",
      "intent": "one-line purpose",
      "file_path": "${filePath}",
      "start_line": 10,
      "end_line": 50
    }
  ],
  "imports": [
    {
      "name": "Registry",
      "from": "./registry.js",
      "kind": "import",
      "file_path": "src/registry.ts"
    }
  ],
  "dependencies": ["./registry.js"]
}
\`\`\`

## Declaration Rules

- **declarations**: EVERY symbol you define — exact line numbers from \`cat -n\` output
- **Classes**: register the class AND each method as separate declarations using \`className.methodName\` naming:
  - Methods: \`MyClass.process\`, \`MyClass.handleRequest\`
  - Constructor: \`MyClass.constructor\`
  - Getters/setters: \`MyClass.get_pool\`, \`MyClass.set_config\`
- **params**: required for \`function\` and \`method\` kinds — array of \`{ name, type }\`
- **return_type**: required for \`function\` and \`method\` kinds — e.g. \`"Promise<void>"\`, \`"string[]"\`
- **exports**: the subset of declarations that are exported
- **imports**: symbols from project files only (not npm packages). Include \`file_path\` (resolved canonical path) — line numbers are looked up from the owning file's declarations
- **dependencies**: file paths you import from (not npm packages)
- **kind**: class | method | function | type | struct | interface | const | schema | enum
- **All file paths are relative to the working directory** — use paths like \`${filePath}\`

## Constraints

- Do NOT modify files
- Do NOT delegate to sub-agents
- Do NOT call register more than once
- After registration, you will receive trace tasks. Do NOT register again on subsequent messages.`;
}

// ---------------------------------------------------------------------------
// renderInvokePrompt
// ---------------------------------------------------------------------------

export type CorrelatedDep = {
  path: string;
  relationship: 'imports' | 'imported_by';
  summary: string | null;
  exports: Array<{ name: string; kind: string; intent: string }>;
  imports: Array<{ name: string; from: string; kind: string }>;
};

type InvokePromptVars = {
  envelope: Pick<InvokeEnvelope, 'function' | 'params' | 'call_stack' | 'caller' | 'expected_output'> & { task_id?: string; target?: string; notes?: string; trace_id?: string; max_depth?: number };
  callerDeclarations?: Declarations;
  targetDependencies?: { dependencies: string[]; dependents: string[] };
  correlatedDeps?: CorrelatedDep[];
  priorSpans?: Array<{
    trace_id: string;
    task_id: string;
    timestamp: Date;
    depth: number;
    caller: string;
    target: string;
    function: string;
    params?: unknown;
    result?: unknown;
    call_stack: string[];
  }>;
  syntheticState?: Map<string, unknown> | { get(key: string): unknown };
};

function renderCorrelatedDepsSection(deps: CorrelatedDep[]): string {
  const imports = deps.filter(d => d.relationship === 'imports');
  const importedBy = deps.filter(d => d.relationship === 'imported_by');

  let section = '\n## Correlated Dependencies (from registry)\n';
  section += 'Fresh dependency context pulled from the registry at invocation time.\n';

  if (imports.length > 0) {
    section += '\n### This file imports from:\n';
    for (const dep of imports) {
      section += `\n**\`${dep.path}\`**`;
      if (dep.summary) section += ` — ${dep.summary}`;
      section += '\n';
      if (dep.exports.length > 0) {
        section += 'Exports:\n';
        for (const exp of dep.exports) {
          section += `- \`${exp.name}\` (${exp.kind}): ${exp.intent}\n`;
        }
      }
      if (dep.imports.length > 0) {
        section += 'Imports:\n';
        for (const imp of dep.imports) {
          section += `- \`${imp.name}\` from \`${imp.from}\`\n`;
        }
      }
    }
  }

  if (importedBy.length > 0) {
    section += '\n### This file is imported by:\n';
    for (const dep of importedBy) {
      section += `\n**\`${dep.path}\`**`;
      if (dep.summary) section += ` — ${dep.summary}`;
      section += '\n';
      if (dep.exports.length > 0) {
        section += 'Exports:\n';
        for (const exp of dep.exports) {
          section += `- \`${exp.name}\` (${exp.kind}): ${exp.intent}\n`;
        }
      }
    }
  }

  return section;
}

export function renderInvokePrompt(vars: InvokePromptVars): string {
  const { envelope, callerDeclarations, targetDependencies, correlatedDeps, priorSpans, syntheticState } = vars;

  // --- Params section ---
  const paramsSection = envelope.params
    ? `\n## Parameters\n\`\`\`json\n${JSON.stringify(envelope.params, null, 2)}\n\`\`\``
    : '';

  // --- Call Stack section ---
  const callStackSection = envelope.call_stack.length > 0
    ? `\n## Call Stack\nThe following files have already been visited in this trace (most recent last):\n${envelope.call_stack.map((entry, i) => `${i + 1}. \`${entry}\``).join('\n')}\n\n**Do NOT invoke any file already in this stack** — that would create a cycle.`
    : '\n## Call Stack\nThis is the first call in the trace. No prior files visited.';

  // --- Caller context section ---
  const callerSection = callerDeclarations
    ? `\n## Caller Context (\`${envelope.caller}\`)\nThe caller declares:\n- **Summary**: ${callerDeclarations.summary}\n- **Owns**: ${callerDeclarations.owns.map((o: any) => `\`${o.name}\` (${o.kind}): ${o.intent}`).join(', ')}\n- **Dependencies**: ${callerDeclarations.dependencies.length > 0 ? callerDeclarations.dependencies.map(d => '`' + d + '`').join(', ') : 'none'}`
    : '';

  // --- Target Dependencies section ---
  // When correlated deps are provided (fresh from registry), use those. 
  // Fall back to file-path-only targetDependencies for backward compatibility.
  const targetDepsSection = correlatedDeps && correlatedDeps.length > 0
    ? renderCorrelatedDepsSection(correlatedDeps)
    : targetDependencies
      ? `\n## Target Dependencies\nThis file's position in the dependency graph:\n` +
        (targetDependencies.dependencies.length > 0
          ? `**Depends on**: ${targetDependencies.dependencies.map(d => '`' + d + '`').join(', ')}\n`
          : '**Depends on**: nothing\n') +
        (targetDependencies.dependents.length > 0
          ? `**Depended on by**: ${targetDependencies.dependents.map(d => '`' + d + '`').join(', ')}\n`
          : '')
      : `\n## Target Dependencies\nNo dependency graph data available for this target.\n`;

  // --- Prior spans section ---
  const priorSpansSection = priorSpans && priorSpans.length > 0
    ? `\n## Prior Trace Spans\nThese calls have already been traced in this execution:\n${priorSpans.map(span => {
        const paramsStr = span.params ? JSON.stringify(span.params) : '{}';
        const resultStr = span.result ? JSON.stringify(span.result) : 'pending';
        return `- depth ${span.depth}: \`${span.caller}\` → \`${span.target}\`.\`${span.function}\`(${paramsStr}) → ${resultStr}`;
      }).join('\n')}`
    : '';

  // --- Expected output section ---
  const expectedOutputSection = envelope.expected_output
    ? `\n## Expected Output\nThe caller expects this return shape/semantics:\n${envelope.expected_output}`
    : '';

  // --- Available synthetic state ---
  let availableStateSection = '';
  if (syntheticState) {
    const stateKeys: string[] = [];
    if (syntheticState instanceof Map) {
      stateKeys.push(...Array.from(syntheticState.keys()));
    } else if ('keys' in syntheticState && typeof syntheticState.keys === 'function') {
      stateKeys.push(...Array.from(syntheticState.keys() as Iterable<string>));
    }
    if (stateKeys.length > 0) {
      availableStateSection = `\n## Available Synthetic State\nYou can read these state keys via \`state_get\`:\n${stateKeys.map(key => `- \`${key}\``).join('\n')}`;
    }
  }

  // --- Task ID and target for respond schema ---
  const taskId = envelope.task_id || '<from envelope>';
  const responder = envelope.target || '<your file_path>';
  const traceId = envelope.trace_id || '<from envelope>';
  const maxDepth = envelope.max_depth ?? 50;

  // --- Detect __trace_initiator__ and extract scenario for context-aware prompt ---
  const isTraceInitiator = envelope.caller === '__trace_initiator__';
  const traceScenario: string | undefined = isTraceInitiator
    ? (envelope.notes || (envelope.params && typeof envelope.params === 'object' ? (envelope.params as Record<string, unknown>).scenario as string : undefined) || undefined)
    : undefined;

  const headerSection = isTraceInitiator && traceScenario
    ? `# Trace Task: Scenario Analysis

> ${traceScenario}

You are being asked to trace your source code for the scenario described above.

## What To Do

1. **Analyze** your source code in the context of the above scenario.
2. **Focus on** \`${envelope.function}\` and trace how it relates to this scenario.
3. **If it calls runtime functions in OTHER files**: use \`mcp__internal__invoke\` to trace into them (provide name, kind, file_path).
4. **Report structured trace data** by calling \`mcp__internal__respond\` with the schema below.
5. **Do NOT invoke types/interfaces** — use \`mcp__internal__resolve\` to look them up (content is derived server-side).`
    : `# Trace Task: Analyze \`${envelope.function}\`

You are being asked to trace the behavior of \`${envelope.function}\` in your source code.

## What To Do

1. **Locate** the function \`${envelope.function}\` in your source code.
2. **Analyze** its behavior — extract params, return type, side effects.
3. **If it calls runtime functions in OTHER files**: use \`mcp__internal__invoke\` to trace into them (provide name, kind, file_path).
4. **Report structured trace data** by calling \`mcp__internal__respond\` with the schema below.
5. **Do NOT invoke types/interfaces** — use \`mcp__internal__resolve\` to look them up (content is derived server-side).`;

  return `${headerSection}

## Response Schema (REQUIRED)

You MUST call \`mcp__internal__respond\` exactly once with STRUCTURED trace data:

\`\`\`json
{
  "task_id": "${taskId}",
  "responder": "${responder}",
  "returns": {
    "type": "Promise<AgentSession>",
    "value": "AgentSession { session_id, file_path, status, cumulativeCostUsd }",
    "params": [
      { "name": "opts", "type": "CreateOptions" },
      { "name": "model", "type": "string" }
    ],
    "side_effects": [
      "stores session in this.sessions Map",
      "calls SDK query() — external API call",
      "persists session_id to registry"
    ]
  },
  "source_refs": ["${responder}:89-196", "${responder}:102"],
  "mutations": [
    {
      "key": "sessions",
      "before": "no entry",
      "after": "new AgentSession in map"
    }
  ],
  "error": null
}
\`\`\`

### Field Requirements
- **task_id**: Use exactly \`${taskId}\`.
- **responder**: Your file path (\`${responder}\`).
- **returns**: STRUCTURED data — NOT prose. Include:
  - \`type\`: return type signature (e.g. \`"void"\`, \`"Promise<string>"\`, \`"Registry"\`)
  - \`value\`: the actual/inferred return value or shape
  - \`params\`: array of \`{ name, type }\` for the function parameters
  - \`side_effects\`: array of strings — state mutations, I/O, external calls
- **source_refs**: **MANDATORY. Non-empty array.** Cite \`file:startLine-endLine\` from YOUR source code.
- **mutations**: State changes the function causes.
- **error**: Set to a string if the function would throw/fail. Otherwise null.

**This is a TRACER — return structured span data like OTEL. No prose descriptions.**

## Available Tools (Trace Phase)

You have ONLY these MCP tools — no Read, Write, Bash, Agent, or other built-in tools:
- \`mcp__internal__respond\` — submit structured trace data (call exactly once, LAST)
- \`mcp__internal__invoke\` — trace into runtime functions in other files (call BEFORE respond)
- \`mcp__internal__resolve\` — look up declarations of other files (server enriches with source content)
- \`mcp__internal__state_get\` — read synthetic state
- \`mcp__internal__state_set\` — write synthetic state

## How to Invoke Dependencies

When your function calls runtime functions in OTHER files, trace into them using \`mcp__internal__invoke\`:

\`\`\`json
{
  "name": "createServer",
  "kind": "function",
  "file_path": "src/server.ts",
  "params": { "config": "ServerConfig" }
}
\`\`\`

For class methods, use the \`className.methodName\` convention:

\`\`\`json
{
  "name": "SessionManager.create",
  "kind": "method",
  "file_path": "src/session-manager.ts",
  "params": { "opts": "CreateOptions" }
}
\`\`\`

**Only invoke runtime symbols** (function, method, class, const). Do NOT invoke types or interfaces — use \`mcp__internal__resolve\` to look those up instead.

**Invoke order**: Call \`mcp__internal__invoke\` for each dependency BEFORE calling \`mcp__internal__respond\`.

## Rules

- **INVOKE runtime dependencies first** — trace into functions/methods/classes in other files via \`mcp__internal__invoke\`.
- **Do NOT invoke types/interfaces** — resolve them via \`mcp__internal__resolve\` instead.
- **source_refs is MANDATORY** — cite \`file:startLine-endLine\`. An empty array will be REJECTED.
- **Call \`mcp__internal__respond\` exactly once, LAST** — after all invocations are done.
- **Structured data only** — no prose in returns. Use type, value, params, side_effects fields.
- **Do not invoke files already in the call_stack** — that creates a cycle.
- **Maximum 5 invocations** per task.
${paramsSection}
${callStackSection}
${priorSpansSection}
${expectedOutputSection}
${availableStateSection}
${targetDepsSection}
${callerSection}`;
}

// ---------------------------------------------------------------------------
// renderExplorationPrompt
// ---------------------------------------------------------------------------

type ExplorationPromptVars = {
  scenario: string;
  registryMap: RegistryMapEntry[];
  starmap?: {
    nodes: Array<{ path: string; summary: string | null }>;
    edges: Array<{ from: string; to: string }>;
  };
};

export function renderExplorationPrompt(vars: ExplorationPromptVars): string {
  const { scenario, registryMap, starmap } = vars;

  // --- Registry summary ---
  const registrySection = registryMap
    .map(e => `- \`${e.path}\` [${e.status}]${e.summary ? ' — ' + e.summary : ''}`)
    .join('\n');

  // --- Starmap section ---
  let starmapSection = '';
  if (starmap && starmap.nodes.length > 0) {
    const nodeList = starmap.nodes
      .map(n => `- \`${n.path}\`${n.summary ? ': ' + n.summary : ''}`)
      .join('\n');
    const edgeList = starmap.edges.length > 0
      ? starmap.edges.map(e => `- \`${e.from}\` → \`${e.to}\``).join('\n')
      : '(no cross-file dependencies detected)';

    starmapSection = `
## Dependency Graph (Starmap)

### Files
${nodeList}

### Dependencies
${edgeList}
`;
  }

  return `# Exploration Task: Identify Trace Entry Points

You are a trace planning agent. Your job is to analyze a codebase and identify the best entry point(s) for a distributed trace.

## Scenario

The user wants to trace:
> ${scenario}

## Available Tools

You may use these tools to explore the codebase:
- **Read** — Read file contents to understand code structure
- **Glob** — Find files matching patterns
- **Grep** — Search for symbols, function names, or patterns across files

You MUST NOT use: Write, Edit, Bash, or any tool that modifies files.

## Registry

These files have been bootstrapped with known declarations:
${registrySection}
${starmapSection}
## What Makes a Good Entry Point

A trace entry point is the file where execution BEGINS for the given scenario:
- It's the file that receives external input (HTTP request, CLI args, event handler)
- It's the file that orchestrates the flow described in the scenario
- It imports/calls the other files involved in the scenario
- It is NOT a utility, type definition, or leaf dependency

## What To Return

After exploration, produce a JSON response with this structure:

\`\`\`json
{
  "entry_points": [
    {
      "file_path": "src/server.ts",
      "confidence": "high",
      "reason": "This file handles incoming HTTP requests and routes to handlers"
    }
  ],
  "trace_targets": ["src/server.ts", "src/handler.ts", "src/db.ts"],
  "trace_strategy": "Start from server.ts request handler, follow through handler to DB layer",
  "observations": [
    "The scenario involves authentication which is handled in src/auth.ts"
  ]
}
\`\`\`

### Field Requirements
- **entry_points**: 1-3 candidate entry files, ranked by confidence (high/medium/low). The first one will be used.
- **trace_targets**: All files that should be visited during the trace.
- **trace_strategy**: Brief description of the expected call flow.
- **observations**: Anything notable you discovered during exploration.

## Rules

- Do NOT guess. If you can't determine the entry point from the registry and starmap alone, use Read/Grep to examine the actual code.
- Prefer files that are imported by few others but import many (high fan-out, low fan-in).
- Ignore test files, type-only files, and configuration files.
- Be concise. The trace system will use your output to configure the actual trace run.`;
}
