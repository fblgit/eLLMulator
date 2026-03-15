/**
 * Phase 1 Audit Tests — Declaration and DependencyRef type shapes
 *
 * SPEC grounding:
 *   Declarations.owns: [Declaration]!
 *   Declarations.imports: [DependencyRef]!
 *   Declarations.exports: [Declaration]!
 *
 * Validates that both types exist with all required fields and correct enum values.
 */

import { describe, it, expect } from 'vitest';
import type { Declaration, DependencyRef } from './types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeclaration(overrides: Partial<Declaration> = {}): Declaration {
  return {
    name: 'SessionManager',
    kind: 'class',
    intent: 'Manages agent session lifecycle',
    file_path: 'src/session-manager.ts',
    start_line: 34,
    end_line: 81,
    ...overrides,
  };
}

function makeDependencyRef(overrides: Partial<DependencyRef> = {}): DependencyRef {
  return {
    name: 'query',
    from: '@anthropic-ai/claude-code',
    kind: 'import',
    file_path: 'src/sdk.ts',
    ...overrides,
  };
}

// ===========================================================================
// 1. Declaration type shape
// ===========================================================================

describe('Declaration type (SPEC: Declarations section)', () => {
  it('has all 6 required fields: name, kind, intent, file_path, start_line, end_line', () => {
    const decl = makeDeclaration();

    expect(decl).toHaveProperty('name');
    expect(decl).toHaveProperty('kind');
    expect(decl).toHaveProperty('intent');
    expect(decl).toHaveProperty('file_path');
    expect(decl).toHaveProperty('start_line');
    expect(decl).toHaveProperty('end_line');

    expect(typeof decl.name).toBe('string');
    expect(typeof decl.kind).toBe('string');
    expect(typeof decl.intent).toBe('string');
    expect(typeof decl.file_path).toBe('string');
    expect(typeof decl.start_line).toBe('number');
    expect(typeof decl.end_line).toBe('number');
  });

  it('kind accepts all valid enum values', () => {
    const validKinds: Declaration['kind'][] = [
      'class', 'method', 'function', 'type', 'struct', 'interface', 'const', 'schema', 'enum',
    ];

    for (const kind of validKinds) {
      const decl = makeDeclaration({ kind });
      expect(decl.kind).toBe(kind);
    }
  });

  it('start_line and end_line are positive integers', () => {
    const decl = makeDeclaration({ start_line: 1, end_line: 50 });
    expect(decl.start_line).toBeGreaterThan(0);
    expect(decl.end_line).toBeGreaterThanOrEqual(decl.start_line);
  });
});

// ===========================================================================
// 2. DependencyRef type shape
// ===========================================================================

describe('DependencyRef type (SPEC: Declarations section)', () => {
  it('has all 4 required fields: name, from, kind, file_path', () => {
    const ref = makeDependencyRef();

    expect(ref).toHaveProperty('name');
    expect(ref).toHaveProperty('from');
    expect(ref).toHaveProperty('kind');
    expect(ref).toHaveProperty('file_path');

    expect(typeof ref.name).toBe('string');
    expect(typeof ref.from).toBe('string');
    expect(typeof ref.kind).toBe('string');
    expect(typeof ref.file_path).toBe('string');
  });

  it('kind accepts all valid enum values', () => {
    const validKinds: DependencyRef['kind'][] = [
      'import', 'uses', 'reuses', 'inherits',
    ];

    for (const kind of validKinds) {
      const ref = makeDependencyRef({ kind });
      expect(ref.kind).toBe(kind);
    }
  });
});
