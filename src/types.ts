/**
 * Shared types for eLLMulator.
 *
 * InvokeEnvelope is the canonical request shape used by both invoke() and templates.
 * Defined once here to prevent drift between modules.
 */

/**
 * InvokeEnvelope — the request payload for inter-agent invocation.
 *
 * Used by invoke() (strict: mode + max_depth required at runtime) and by
 * prompt templates (looser: mode + max_depth optional for rendering).
 * The strict variant is the canonical export; templates accept it via
 * structural subtyping.
 */
export type InvokeEnvelope = {
  trace_id: string;
  task_id: string;
  caller: string;
  target: string;
  function: string;
  params?: unknown;
  state?: unknown;
  notes?: string;
  call_stack: string[];
  mode: 'sync' | 'async';
  max_depth: number;
  expected_output?: string;
  traceMode?: 'full' | 'targeted' | 'lens';  // Phase 5: trace execution mode
};

export type Mutation = {
  key: string;
  before?: unknown;
  after: unknown;
};

export type ResponseEnvelope = {
  task_id: string;
  responder: string;
  returns?: unknown;
  mutations?: Mutation[];
  source_refs: string[];
  error?: string;
};

export type TraceEntry = {
  trace_id: string;
  task_id: string;
  timestamp: Date;
  depth: number;
  caller: string;
  target: string;
  function: string;
  params?: unknown;
  result?: unknown;
  mutations?: Mutation[];
  source_refs?: string[];
  duration_ms?: number;
  error?: string;
  call_stack: string[];
  stubbed?: boolean;  // Phase 5: marks stubbed calls in lens mode
  expected_output?: string;  // Phase 6: caller's expectation of return shape/semantics (from InvokeEnvelope)
};

// ---------------------------------------------------------------------------
// Declaration types (SPEC: Declarations section)
// ---------------------------------------------------------------------------

export type Declaration = {
  name: string;
  kind: 'class' | 'method' | 'function' | 'type' | 'struct' | 'interface' | 'const' | 'schema' | 'enum';
  intent: string;
  file_path: string;
  start_line: number;
  end_line: number;
  // content removed — server derives from file_path + start_line:end_line on demand
  /** Function/method parameters — optional at schema level, deviation flagged for function/method kinds */
  params?: Array<{ name: string; type: string }>;
  /** Return type signature — optional at schema level, deviation flagged for function/method kinds */
  return_type?: string;
};

export type DependencyRef = {
  name: string;
  from: string;
  kind: 'import' | 'uses' | 'reuses' | 'inherits';
  /** Resolved canonical file path — required */
  file_path: string;
};

export type Declarations = {
  summary: string;
  owns: Declaration[];
  imports: DependencyRef[];
  exports: Declaration[];
  dependencies: string[];
};

// ---------------------------------------------------------------------------
// Registry types (SPEC: Registry section)
// ---------------------------------------------------------------------------

export type RegistryEntry = {
  file_path: string;
  session_id?: string;                    // undefined when cold
  file_hash: string;                      // SHA256 of file content
  status: 'cold' | 'bootstrapping' | 'ready' | 'stale' | 'error';
  declarations?: Declarations;            // undefined until agent registers
  last_active?: Date;                     // timestamp
  error?: string;                         // last error if status=error
};

// ---------------------------------------------------------------------------
// External MCP types (SPEC: External MCP section)
// ---------------------------------------------------------------------------

export type FindingType =
  | 'contract_mismatch'
  | 'assumption_bug'
  | 'missing_error_path'
  | 'dead_spot'
  | 'unexpected_call';

export type Finding = {
  type: FindingType;
  description: string;
  caller: string;
  target?: string;
  source_refs: string[];
  severity: 'high' | 'medium' | 'low';
};

export type TraceRequest = {
  scenario: string;
  entry_point?: string;
  state?: Record<string, unknown>;
  max_depth?: number;
  stream?: boolean;
  mode?: 'full' | 'targeted' | 'lens';
  targetPath?: string[];  // Phase 5.1: specify which files to trace in targeted mode
};

export type TraceResult = {
  trace_id: string;
  entries: TraceEntry[];
  summary: string;
  findings: Finding[];
  duration_ms: number;
  observations?: string[];
};

export type ConsolidateResult = {
  total: number;
  stale: number;
  refreshed: number;
  new: number;
};

// ---------------------------------------------------------------------------
// Trace planning types (exploration agent output)
// ---------------------------------------------------------------------------

export type TraceProspectus = {
  entry_points: Array<{ file_path: string; confidence: 'high' | 'medium' | 'low'; reason: string }>;
  trace_targets: string[];
  trace_strategy: string;
  observations: string[];
};
