/**
 * Zod schemas for eLLMulator MCP tool validation.
 *
 * Provides runtime validation for all 12 MCP tools (6 external, 6 internal).
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Core type schemas
// ---------------------------------------------------------------------------

export const MutationSchema = z.object({
  key: z.string(),
  before: z.any().optional(),
  after: z.any(),
}).refine(
  (data) => 'after' in data,
  { message: 'after field is required', path: ['after'] }
);

export const InvokeEnvelopeSchema = z.object({
  trace_id: z.string(),
  task_id: z.string(),
  caller: z.string(),
  target: z.string(),
  function: z.string(),
  params: z.unknown().optional(),
  state: z.unknown().optional(),
  notes: z.string().optional(),
  call_stack: z.array(z.string()),
  mode: z.enum(['sync', 'async']),
  max_depth: z.number().int().nonnegative(),
  expected_output: z.string().optional(),
});

/** Structured return type for trace responses — OTEL-style span data, not prose */
export const TraceReturnSchema = z.object({
  /** Return type signature (e.g. "Promise<AgentSession>", "void", "string[]") */
  type: z.string().optional(),
  /** Inferred/actual return value or shape */
  value: z.unknown().optional(),
  /** Function parameters with name and type */
  params: z.array(z.object({
    name: z.string(),
    type: z.string(),
  })).optional(),
  /** Side effects: state mutations, I/O, external calls */
  side_effects: z.array(z.string()).optional(),
});

export const ResponseEnvelopeSchema = z.object({
  task_id: z.string(),
  responder: z.string(),
  /** Structured trace return data (TraceReturnSchema) preferred, raw values accepted for backward compat */
  returns: z.unknown().optional(),
  mutations: z.array(MutationSchema).optional(),
  source_refs: z.array(z.string()).min(1),
  error: z.string().optional(),
});

export const DeclarationSchema = z.object({
  name: z.string(),
  kind: z.enum(['class', 'method', 'function', 'type', 'struct', 'interface', 'const', 'schema', 'enum']),
  intent: z.string(),
  file_path: z.string(),
  start_line: z.number().int().positive(),
  end_line: z.number().int().positive(),
  // content removed — server derives from file_path + start_line:end_line on demand (Point 4/9)
  /** Function/method parameters — optional at schema level, deviation flagged for function/method kinds */
  params: z.array(z.object({
    name: z.string(),
    type: z.string(),
  })).optional(),
  /** Return type signature — optional at schema level, deviation flagged for function/method kinds */
  return_type: z.string().optional(),
});

export const DependencyRefSchema = z.object({
  name: z.string(),
  from: z.string(),
  kind: z.enum(['import', 'uses', 'reuses', 'inherits']),
  /** Resolved canonical file path — required. Lines come from owning file's declarations (Point 8). */
  file_path: z.string(),
});

export const TraceEntrySchema = z.object({
  trace_id: z.string(),
  task_id: z.string(),
  timestamp: z.date(),
  depth: z.number().int().nonnegative(),
  caller: z.string(),
  target: z.string(),
  function: z.string(),
  params: z.unknown().optional(),
  result: z.unknown().optional(),
  mutations: z.array(MutationSchema).optional(),
  source_refs: z.array(z.string()).optional(),
  duration_ms: z.number().nonnegative().optional(),
  error: z.string().optional(),
  call_stack: z.array(z.string()),
});

export const DeclarationsSchema = z.object({
  summary: z.string(),
  owns: z.array(DeclarationSchema),
  imports: z.array(DependencyRefSchema),
  exports: z.array(DeclarationSchema),
  dependencies: z.array(z.string()),
});

export const RegistryEntrySchema = z.object({
  file_path: z.string(),
  session_id: z.string().optional(),
  file_hash: z.string(),
  status: z.enum(['cold', 'bootstrapping', 'ready', 'stale', 'error']),
  declarations: DeclarationsSchema.optional(),
  last_active: z.date().optional(),
  error: z.string().optional(),
});

// ---------------------------------------------------------------------------
// External MCP tool input schemas (:3100)
// ---------------------------------------------------------------------------

export const TraceInputSchema = z.object({
  /** Free-form scenario description — triggers LLM entry point detection */
  scenario: z.string().optional(),
  /** Explicit entry file — skips detection when provided with function */
  entry_file: z.string().optional(),
  /** Function to trace — required when entry_file is provided */
  function: z.string().optional(),
  params: z.record(z.string(), z.any()).optional(),
  mode: z.enum(['full', 'targeted', 'lens']).optional(),
  max_depth: z.number().int().positive().optional(),
  expected_output: z.string().optional(),
  state: z.record(z.string(), z.any()).optional(),
});

export const InspectInputSchema = z.object({
  file_path: z.string(),
});

export const StatusInputSchema = z.object({});

export const ListAgentsInputSchema = z.object({});

export const ConsolidateInputSchema = z.object({
  trace_id: z.string(),
});

export const StarmapInputSchema = z.object({
  file_path: z.string().optional(),
});

// ---------------------------------------------------------------------------
// Internal MCP tool input schemas (:3101)
// ---------------------------------------------------------------------------

// Full invoke envelope — used internally by invoke() handler
export const InvokeInputSchema = InvokeEnvelopeSchema;

/**
 * Agent-facing invoke schema — agents provide name, kind, file_path, params.
 * The MCP handler constructs the full InvokeEnvelope from parent trace context.
 * No line numbers needed — the registry already has those from bootstrap.
 */
export const AgentInvokeInputSchema = z.object({
  /** Function/method name to trace */
  name: z.string(),
  /** Symbol kind (function, method, class, const, etc.) */
  kind: z.enum(['class', 'method', 'function', 'type', 'struct', 'interface', 'const', 'schema', 'enum']),
  /** Target file path containing the symbol */
  file_path: z.string(),
  /** Parameters to pass (optional) */
  params: z.unknown().optional(),
  /** Expected return shape/description (optional) */
  expected_output: z.string().optional(),
});

export const RegisterInputSchema = z.object({
  file_path: z.string(),
  declarations: z.array(DeclarationSchema),
  exports: z.array(DeclarationSchema).optional(),
  imports: z.array(DependencyRefSchema).optional(),
  dependencies: z.union([
    z.array(DependencyRefSchema),
    z.array(z.string()),
  ]).optional(),
});

export const StateGetInputSchema = z.object({
  key: z.string(),
});

export const StateSetInputSchema = z.object({
  key: z.string(),
  value: z.any(),
}).refine(
  (data) => 'value' in data,
  { message: 'value field is required', path: ['value'] }
);

export const ResolveInputSchema = z.object({
  file_path: z.string(),
});

// respond uses ResponseEnvelopeSchema directly
export const RespondInputSchema = ResponseEnvelopeSchema;

// ---------------------------------------------------------------------------
// Type exports (for TypeScript compatibility)
// ---------------------------------------------------------------------------

export type MutationInput = z.infer<typeof MutationSchema>;
export type InvokeEnvelopeInput = z.infer<typeof InvokeEnvelopeSchema>;
export type ResponseEnvelopeInput = z.infer<typeof ResponseEnvelopeSchema>;
export type DeclarationInput = z.infer<typeof DeclarationSchema>;
export type DependencyRefInput = z.infer<typeof DependencyRefSchema>;
export type TraceEntryInput = z.infer<typeof TraceEntrySchema>;
export type DeclarationsInput = z.infer<typeof DeclarationsSchema>;
export type RegistryEntryInput = z.infer<typeof RegistryEntrySchema>;

export type TraceInput = z.infer<typeof TraceInputSchema>;
export type InspectInput = z.infer<typeof InspectInputSchema>;
export type StatusInput = z.infer<typeof StatusInputSchema>;
export type ListAgentsInput = z.infer<typeof ListAgentsInputSchema>;
export type ConsolidateInput = z.infer<typeof ConsolidateInputSchema>;
export type StarmapInput = z.infer<typeof StarmapInputSchema>;

export type InvokeInput = z.infer<typeof InvokeInputSchema>;
export type AgentInvokeInput = z.infer<typeof AgentInvokeInputSchema>;
export type TraceReturn = z.infer<typeof TraceReturnSchema>;
export type RegisterInput = z.infer<typeof RegisterInputSchema>;
export type StateGetInput = z.infer<typeof StateGetInputSchema>;
export type StateSetInput = z.infer<typeof StateSetInputSchema>;
export type ResolveInput = z.infer<typeof ResolveInputSchema>;
export type RespondInput = z.infer<typeof RespondInputSchema>;
