/**
 * Tests for register deviation validation (Point 3 — Protocol V2).
 *
 * Covers: 7 deviation checks + auto-fix behavior.
 */

import { describe, it, expect } from 'vitest';
import { validateAndFixDeclarations, type Deviation } from './validation.js';

function makeDecl(overrides: Partial<{
  name: string; kind: string; intent: string; file_path: string;
  start_line: number; end_line: number;
  params: { name: string; type: string }[];
  return_type: string;
}> = {}) {
  return {
    name: overrides.name ?? 'testFn',
    kind: overrides.kind ?? 'function',
    intent: overrides.intent ?? 'test function',
    file_path: overrides.file_path ?? 'src/test.ts',
    start_line: overrides.start_line ?? 1,
    end_line: overrides.end_line ?? 10,
    ...(overrides.params !== undefined ? { params: overrides.params } : {}),
    ...(overrides.return_type !== undefined ? { return_type: overrides.return_type } : {}),
  };
}

describe('validateAndFixDeclarations', () => {
  describe('Check 1: class without className.methodName entries', () => {
    it('should flag class without methods', () => {
      const decls = {
        owns: [
          makeDecl({ name: 'MyClass', kind: 'class', params: [{ name: 'x', type: 'number' }], return_type: 'MyClass' }),
        ],
      };
      const deviations = validateAndFixDeclarations(decls);
      const classDeviation = deviations.find(d => d.issue.includes("class 'MyClass'") && d.issue.includes('without className.methodName'));
      expect(classDeviation).toBeDefined();
      expect(classDeviation!.sop).toContain('MyClass.methodName');
    });

    it('should not flag class that has className.methodName methods', () => {
      const decls = {
        owns: [
          makeDecl({ name: 'MyClass', kind: 'class', params: [{ name: 'x', type: 'number' }], return_type: 'MyClass' }),
          makeDecl({ name: 'MyClass.create', kind: 'method', params: [{ name: 'opts', type: 'Options' }], return_type: 'MyClass' }),
        ],
      };
      const deviations = validateAndFixDeclarations(decls);
      const classDeviation = deviations.find(d => d.issue.includes("class 'MyClass'") && d.issue.includes('without'));
      expect(classDeviation).toBeUndefined();
    });
  });

  describe('Check 2: function/method without params', () => {
    it('should flag function without params', () => {
      const decls = {
        owns: [
          makeDecl({ name: 'doStuff', kind: 'function', return_type: 'void' }),
        ],
      };
      const deviations = validateAndFixDeclarations(decls);
      const paramDeviation = deviations.find(d => d.issue.includes("'doStuff' missing params"));
      expect(paramDeviation).toBeDefined();
      expect(paramDeviation!.sop).toContain('params array');
    });

    it('should flag method without params', () => {
      const decls = {
        owns: [
          makeDecl({ name: 'MyClass.run', kind: 'method', return_type: 'void' }),
        ],
      };
      const deviations = validateAndFixDeclarations(decls);
      expect(deviations.some(d => d.issue.includes("'MyClass.run' missing params"))).toBe(true);
    });

    it('should not flag function with params', () => {
      const decls = {
        owns: [
          makeDecl({ name: 'doStuff', kind: 'function', params: [{ name: 'x', type: 'number' }], return_type: 'void' }),
        ],
      };
      const deviations = validateAndFixDeclarations(decls);
      expect(deviations.some(d => d.issue.includes("missing params"))).toBe(false);
    });

    it('should not flag const without params', () => {
      const decls = {
        owns: [
          makeDecl({ name: 'MAX_SIZE', kind: 'const' }),
        ],
      };
      const deviations = validateAndFixDeclarations(decls);
      expect(deviations.some(d => d.issue.includes("missing params"))).toBe(false);
    });
  });

  describe('Check 3: function/method without return_type', () => {
    it('should flag function without return_type', () => {
      const decls = {
        owns: [
          makeDecl({ name: 'doStuff', kind: 'function', params: [{ name: 'x', type: 'number' }] }),
        ],
      };
      const deviations = validateAndFixDeclarations(decls);
      const rtDeviation = deviations.find(d => d.issue.includes("'doStuff' missing return_type"));
      expect(rtDeviation).toBeDefined();
      expect(rtDeviation!.sop).toContain('return_type');
    });

    it('should not flag function with return_type', () => {
      const decls = {
        owns: [
          makeDecl({ name: 'doStuff', kind: 'function', params: [{ name: 'x', type: 'number' }], return_type: 'void' }),
        ],
      };
      const deviations = validateAndFixDeclarations(decls);
      expect(deviations.some(d => d.issue.includes("missing return_type"))).toBe(false);
    });
  });

  describe('Check 4: unknown kind (auto-fix)', () => {
    it('should auto-fix type_alias to type', () => {
      const decls = {
        owns: [
          makeDecl({ name: 'MyType', kind: 'type_alias' as any }),
        ],
      };
      const deviations = validateAndFixDeclarations(decls);
      expect(decls.owns[0].kind).toBe('type');
      expect(deviations.some(d => d.issue.includes("auto-fixed to 'type'"))).toBe(true);
    });

    it('should auto-fix arrow_function to function', () => {
      const decls = {
        owns: [
          makeDecl({ name: 'handler', kind: 'arrow_function' as any, params: [{ name: 'req', type: 'Request' }], return_type: 'void' }),
        ],
      };
      const deviations = validateAndFixDeclarations(decls);
      expect(decls.owns[0].kind).toBe('function');
      expect(deviations.some(d => d.issue.includes("auto-fixed to 'function'"))).toBe(true);
    });

    it('should flag unrecognized kind without auto-fix', () => {
      const decls = {
        owns: [
          makeDecl({ name: 'weird', kind: 'gobbledygook' as any }),
        ],
      };
      const deviations = validateAndFixDeclarations(decls);
      expect(decls.owns[0].kind).toBe('gobbledygook'); // NOT mutated
      expect(deviations.some(d => d.issue.includes("not recognized"))).toBe(true);
    });

    it('should also fix exports kind', () => {
      const decls = {
        owns: [
          makeDecl({ name: 'MyType', kind: 'type_alias' as any }),
        ],
        exports: [
          makeDecl({ name: 'MyType', kind: 'type_alias' as any }),
        ],
      };
      validateAndFixDeclarations(decls);
      expect(decls.exports![0].kind).toBe('type');
    });
  });

  describe('Check 5: start_line > end_line', () => {
    it('should flag inverted line range', () => {
      const decls = {
        owns: [
          makeDecl({ name: 'broken', kind: 'const', start_line: 50, end_line: 10 }),
        ],
      };
      const deviations = validateAndFixDeclarations(decls);
      expect(deviations.some(d => d.issue.includes('start_line (50) > end_line (10)'))).toBe(true);
      expect(deviations.find(d => d.issue.includes('start_line (50)'))!.sop).toContain('cat -n');
    });
  });

  describe('Check 6: start_line or end_line ≤ 0', () => {
    it('should flag zero start_line', () => {
      const decls = {
        owns: [
          makeDecl({ name: 'bad', kind: 'const', start_line: 0, end_line: 5 }),
        ],
      };
      const deviations = validateAndFixDeclarations(decls);
      expect(deviations.some(d => d.issue.includes('start_line is 0'))).toBe(true);
    });

    it('should flag negative end_line', () => {
      const decls = {
        owns: [
          makeDecl({ name: 'bad', kind: 'const', start_line: 1, end_line: -3 }),
        ],
      };
      const deviations = validateAndFixDeclarations(decls);
      expect(deviations.some(d => d.issue.includes('end_line is -3'))).toBe(true);
    });
  });

  describe('Check 7: duplicate declaration names (auto-fix)', () => {
    it('should keep last occurrence and flag deviation', () => {
      const decls = {
        owns: [
          makeDecl({ name: 'doStuff', kind: 'const', start_line: 1, end_line: 5 }),
          makeDecl({ name: 'other', kind: 'const', start_line: 6, end_line: 10 }),
          makeDecl({ name: 'doStuff', kind: 'const', start_line: 20, end_line: 30 }),
        ],
      };
      const deviations = validateAndFixDeclarations(decls);
      expect(deviations.some(d => d.issue.includes("duplicate declaration 'doStuff'"))).toBe(true);
      // After dedup: should have 2 items, last doStuff wins
      expect(decls.owns.length).toBe(2);
      expect(decls.owns.find((d: any) => d.name === 'doStuff')!.start_line).toBe(20);
    });
  });

  describe('valid registration', () => {
    it('should return no deviations for a fully valid registration', () => {
      const decls = {
        owns: [
          makeDecl({ name: 'MyClass', kind: 'class', params: [{ name: 'x', type: 'number' }], return_type: 'MyClass' }),
          makeDecl({ name: 'MyClass.create', kind: 'method', params: [{ name: 'opts', type: 'Options' }], return_type: 'MyClass' }),
          makeDecl({ name: 'helper', kind: 'function', params: [{ name: 'x', type: 'number' }], return_type: 'void' }),
          makeDecl({ name: 'MAX_SIZE', kind: 'const' }),
          makeDecl({ name: 'Config', kind: 'type' }),
        ],
      };
      const deviations = validateAndFixDeclarations(decls);
      expect(deviations).toEqual([]);
    });
  });

  describe('combined scenarios', () => {
    it('should report multiple deviations for a messy registration', () => {
      const decls = {
        owns: [
          makeDecl({ name: 'MyClass', kind: 'class' }), // no methods, no params/return_type (class exempt from params)
          makeDecl({ name: 'handler', kind: 'arrow_function' as any, start_line: 50, end_line: 10 }), // auto-fix kind, inverted lines, missing params/return_type
          makeDecl({ name: 'handler', kind: 'function' }), // duplicate of previous (after fix)
        ],
      };
      const deviations = validateAndFixDeclarations(decls);
      // Should have: kind auto-fix, inverted lines, class without methods, missing params, missing return_type, duplicate
      expect(deviations.length).toBeGreaterThanOrEqual(3);
      // Kind should be fixed
      expect(decls.owns.find((d: any) => d.name === 'handler')?.kind).toBe('function');
    });
  });
});
