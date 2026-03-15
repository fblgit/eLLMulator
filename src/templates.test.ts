/**
 * RED Phase Tests — FR-009: Prompt Templates
 *
 *   - FileAgentSystemTemplate (file-agent.system)
 *   - FileAgentBootstrapTemplate (file-agent.bootstrap)
 *   - FileAgentInvokeTemplate (file-agent.invoke)
 *
 * Functions under test:
 *   - renderSystemPrompt(vars) -> string
 *   - renderBootstrapPrompt(vars) -> string
 *   - renderInvokePrompt(vars) -> string
 *
 * All tests MUST fail — templates.ts does not exist yet.
 *
 * SPEC contracts tested:
 *   - System prompt: identity, source code, contract rules (MCP only), guardrail rules,
 *     dependency sources, registry map
 *   - Bootstrap prompt: file_path, register() instruction, declaration format rules
 *   - Invoke prompt: function name, params, call_stack, source_refs requirement,
 *     caller declarations
 */

import { describe, it, expect } from 'vitest';
import {
  renderSystemPrompt,
  renderBootstrapPrompt,
  renderInvokePrompt,
} from './templates.js';

// ---------------------------------------------------------------------------
// Import shared types from types.ts
// ---------------------------------------------------------------------------

import type { InvokeEnvelope, Declarations, Declaration, DependencyRef } from './types.js';

// ---------------------------------------------------------------------------
// Helpers / Fixtures
// ---------------------------------------------------------------------------

function makeRegistryMap() {
  return [
    { path: 'src/server.ts', status: 'ready', summary: 'Main entry point' },
    { path: 'src/registry.ts', status: 'ready', summary: 'Registry CRUD' },
    { path: 'src/scanner.ts', status: 'cold', summary: null },
  ];
}

function makeEnvelope(overrides: Partial<InvokeEnvelope> = {}): InvokeEnvelope {
  return {
    trace_id: 'trace-001',
    task_id: 'task-001',
    caller: 'src/server.ts',
    target: 'src/registry.ts',
    function: 'getUserById',
    params: { userId: 42 },
    call_stack: ['src/server.ts'],
    ...overrides,
  };
}

function makeDeclarations(overrides: Partial<Declarations> = {}): Declarations {
  const declaration: Declaration = {
    name: 'getUserById',
    kind: 'function',
    intent: 'Retrieves a user by their ID',
    file_path: 'src/registry.ts',
    start_line: 10,
    end_line: 25,
  };

  return {
    summary: 'Manages user data storage and retrieval',
    owns: [declaration],
    imports: [],
    exports: [],
    dependencies: ['src/types.ts'],
    ...overrides,
  };
}

// ===========================================================================
// 1. renderSystemPrompt — identity (file_path)
// SPEC: FileAgentSystemTemplate.identity = "You ARE {file_path}"
// ===========================================================================

describe('renderSystemPrompt', () => {
  it('includes file_path in identity', () => {
    const result = renderSystemPrompt({
      filePath: 'src/server.ts',
      sourceCode: 'export const x = 1;',
    });

    expect(typeof result).toBe('string');
    expect(result).toContain('src/server.ts');
    // Lean identity — "You are the analysis agent for"
    expect(result.toLowerCase()).toContain('you are');
    expect(result.toLowerCase()).toContain('analysis agent');
  });

  // ===========================================================================
  // 2. renderSystemPrompt — source code inclusion (in prompt, not via cat -n)
  // Protocol V2: source code stays in system prompt for cached access across turns
  // ===========================================================================

  it('includes source code in <source_code> block when provided', () => {
    const result = renderSystemPrompt({
      filePath: 'src/user-service.ts',
      sourceCode: 'export function createUser() { return {}; }',
    });

    expect(result).toContain('<source_code>');
    expect(result).toContain('export function createUser()');
    expect(result).toContain('</source_code>');
  });

  it('omits source_code block when source is empty', () => {
    const result = renderSystemPrompt({
      filePath: 'src/user-service.ts',
      sourceCode: '',
    });

    expect(result).not.toContain('<source_code>');
  });

  // ===========================================================================
  // 3. renderSystemPrompt — contract rules (MCP only, cite file:line)
  // Protocol V2: lean contract — one-liner in system prompt
  // ===========================================================================

  it('includes MCP-only and cite contract in lean form', () => {
    const result = renderSystemPrompt({
      filePath: 'src/server.ts',
      sourceCode: 'const a = 1;',
    });

    // Must mention MCP tool calls
    expect(result.toLowerCase()).toContain('mcp tool call');
    // Must mention citing file:line
    expect(result).toContain('src/server.ts:<line>');
    // Must mention no file modification
    expect(result.toLowerCase()).toContain('do not modify');
  });

  // ===========================================================================
  // 4. renderSystemPrompt — lean: no guardrails, no operating phases
  // Protocol V2: guardrails moved to invoke prompt + tool descriptions
  // ===========================================================================

  it('is lean — no guardrails, no operating phases, no lengthy contract', () => {
    const result = renderSystemPrompt({
      filePath: 'src/server.ts',
      sourceCode: 'const a = 1;',
    });

    // Guardrails, operating phases, and verbose contract are NOT in system prompt
    expect(result).not.toContain('## Guardrails');
    expect(result).not.toContain('## Operating Phases');
    expect(result).not.toContain('## Scope');
    expect(result).not.toContain('Phase 1');
    expect(result).not.toContain('Phase 2');
    // No registry map
    expect(result).not.toContain('Registry Map');
  });

  // ===========================================================================
  // 5. renderSystemPrompt — dependency sources when provided
  // ===========================================================================

  it('includes dependency sources in block when provided', () => {
    const result = renderSystemPrompt({
      filePath: 'src/server.ts',
      sourceCode: 'import { Registry } from "./registry"',
      dependencySources: ['// registry.ts\nexport class Registry {}'],
    });

    expect(result).toContain('<dependency_sources>');
    expect(result).toContain('export class Registry {}');
    expect(result).toContain('</dependency_sources>');
  });

  // ===========================================================================
  // 6. renderSystemPrompt — boundary info when provided
  // ===========================================================================

  it('includes boundary routing when provided', () => {
    const result = renderSystemPrompt({
      filePath: 'src/server.ts',
      sourceCode: 'const a = 1;',
      boundaryInfo: {
        sameCluster: ['src/handler.ts'],
        crossBoundary: ['src/db.ts'],
      },
    });

    expect(result).toContain('Boundary Routing');
    expect(result).toContain('src/handler.ts');
    expect(result).toContain('src/db.ts');
  });
});

// ===========================================================================
// 6. renderBootstrapPrompt — file_path
// SPEC: FileAgentBootstrapTemplate.instruction + file_path context
// ===========================================================================

describe('renderBootstrapPrompt', () => {
  it('includes file_path in output', () => {
    const result = renderBootstrapPrompt({
      filePath: 'src/registry.ts',
    });

    expect(typeof result).toBe('string');
    expect(result).toContain('src/registry.ts');
  });

  // ===========================================================================
  // 7. renderBootstrapPrompt — instruction to call register()
  // SPEC: FileAgentBootstrapTemplate.tasks[5] = "Call register() with your Declarations via MCP"
  // ===========================================================================

  it('includes instruction to call register() via MCP', () => {
    const result = renderBootstrapPrompt({
      filePath: 'src/server.ts',
    });

    // Must instruct the agent to call register()
    expect(result.toLowerCase()).toContain('register');
    // Must reference MCP as the delivery channel
    expect(result.toLowerCase()).toContain('mcp');
  });

  // ===========================================================================
  // 8. renderBootstrapPrompt — declaration format instructions
  // SPEC: FileAgentBootstrapTemplate.declaration_rules includes:
  //   "Use references (name, kind, intent, file_path, start_line, end_line)"
  //   "intent should be 1 line describing purpose"
  //   "List ALL direct file dependencies by path"
  // ===========================================================================

  it('includes declaration format instructions (references, not copies)', () => {
    const result = renderBootstrapPrompt({
      filePath: 'src/server.ts',
    });

    // Must reference the declaration fields from SPEC
    expect(result.toLowerCase()).toContain('name');
    expect(result.toLowerCase()).toContain('kind');
    expect(result.toLowerCase()).toContain('intent');
    // Must include the register tool schema
    expect(result.toLowerCase()).toContain('register');
    expect(result.toLowerCase()).toContain('start_line');
    expect(result.toLowerCase()).toContain('end_line');
    // Must mention dependencies
    expect(result.toLowerCase()).toContain('dependenc');
  });

  // ===========================================================================
  // Point 6: className.methodName convention
  // ===========================================================================

  it('includes className.methodName convention in bootstrap prompt', () => {
    const result = renderBootstrapPrompt({
      filePath: 'src/session-manager.ts',
    });

    // Must show className.methodName examples
    expect(result).toContain('MyClass.constructor');
    expect(result).toContain('MyClass.process');
    // Must document the naming convention
    expect(result).toContain('className.methodName');
    // Must mention getter/setter convention
    expect(result).toContain('get_');
    expect(result).toContain('set_');
  });

  // ===========================================================================
  // Point 5: params and return_type in bootstrap example
  // ===========================================================================

  it('includes params and return_type in bootstrap declaration example', () => {
    const result = renderBootstrapPrompt({
      filePath: 'src/handler.ts',
    });

    // Must show params array in example
    expect(result).toContain('"params"');
    expect(result).toContain('"return_type"');
    // Must mention they're required for function/method
    expect(result.toLowerCase()).toContain('required for');
  });
});

// ===========================================================================
// 9. renderInvokePrompt — function name from envelope
// SPEC: FileAgentInvokeTemplate.envelope contains function field
//        tasks[0] = "Locate the function {function} in your source code"
// ===========================================================================

describe('renderInvokePrompt', () => {
  it('includes function name from envelope in output', () => {
    const envelope = makeEnvelope({ function: 'processPayment' });

    const result = renderInvokePrompt({
      envelope,
    });

    expect(typeof result).toBe('string');
    expect(result).toContain('processPayment');
  });

  // ===========================================================================
  // 10. renderInvokePrompt — params from envelope
  // SPEC: InvokeEnvelope.params = {str,*}? (typed parameters)
  //        tasks[1] = "Trace the execution path with the given params"
  // ===========================================================================

  it('includes params from envelope in output', () => {
    const envelope = makeEnvelope({
      function: 'createUser',
      params: { name: 'Alice', role: 'admin' },
    });

    const result = renderInvokePrompt({
      envelope,
    });

    // Params should be serialized into the prompt
    expect(result).toContain('Alice');
    expect(result).toContain('admin');
    // The param keys should also appear
    expect(result).toContain('name');
    expect(result).toContain('role');
  });

  // ===========================================================================
  // 11. renderInvokePrompt — call_stack from envelope
  // SPEC: InvokeEnvelope.call_stack = [str]! (grows with depth, cycle detector)
  //        rules[0] = "Append your file_path to call_stack before any invoke()"
  // ===========================================================================

  it('includes call_stack from envelope in output', () => {
    const envelope = makeEnvelope({
      call_stack: ['src/server.ts', 'src/router.ts', 'src/controller.ts'],
    });

    const result = renderInvokePrompt({
      envelope,
    });

    // The call stack entries should appear in the rendered output
    expect(result).toContain('src/server.ts');
    expect(result).toContain('src/router.ts');
    expect(result).toContain('src/controller.ts');
  });

  // ===========================================================================
  // 12. renderInvokePrompt — source_refs requirement
  // SPEC: FileAgentInvokeTemplate.tasks[5] =
  //        "source_refs is MANDATORY — cite file:line for every behavioral claim"
  // ===========================================================================

  it('includes source_refs requirement in output', () => {
    const envelope = makeEnvelope();

    const result = renderInvokePrompt({
      envelope,
    });

    // Must mention source_refs as mandatory
    expect(result.toLowerCase()).toContain('source_ref');
    expect(result.toLowerCase()).toMatch(/mandatory|required|must/);
  });

  // ===========================================================================
  // 13. renderInvokePrompt — caller declarations when provided
  // SPEC: FileAgentInvokeTemplate.caller_declarations = Declarations?
  //        "so you know who is calling and why"
  // ===========================================================================

  it('includes caller declarations when provided', () => {
    const envelope = makeEnvelope({ caller: 'src/server.ts' });
    const callerDeclarations = makeDeclarations({
      summary: 'HTTP server handling incoming requests',
    });

    const result = renderInvokePrompt({
      envelope,
      callerDeclarations,
    });

    // Caller summary should appear
    expect(result).toContain('HTTP server handling incoming requests');
    // Caller's function declarations should appear
    expect(result).toContain('getUserById');
  });

  // ===========================================================================
  // Point 6: invoke prompt includes className.methodName convention
  // ===========================================================================

  it('includes className.methodName invoke example in prompt', () => {
    const envelope = makeEnvelope({ function: 'handleRequest' });
    const result = renderInvokePrompt({ envelope });

    // Must show className.methodName example in invoke instructions
    expect(result).toContain('SessionManager.create');
  });
});
