/**
 * Tests for Zod schemas.
 *
 * Validates that:
 * - Valid inputs parse correctly
 * - Invalid inputs are rejected with helpful errors
 * - Schemas match types.ts shapes
 */

import { describe, it, expect } from 'vitest';
import {
  MutationSchema,
  InvokeEnvelopeSchema,
  ResponseEnvelopeSchema,
  DeclarationSchema,
  DependencyRefSchema,
  TraceInputSchema,
  InspectInputSchema,
  StatusInputSchema,
  ListAgentsInputSchema,
  ConsolidateInputSchema,
  StarmapInputSchema,
  InvokeInputSchema,
  AgentInvokeInputSchema,
  RegisterInputSchema,
  StateGetInputSchema,
  StateSetInputSchema,
  ResolveInputSchema,
  RespondInputSchema,
} from './schemas';
import type {
  Mutation,
  InvokeEnvelope,
  ResponseEnvelope,
  Declaration,
  DependencyRef,
} from './types';

describe('Core type schemas', () => {
  describe('MutationSchema', () => {
    it('accepts valid mutation', () => {
      const valid = {
        key: 'user.name',
        before: 'Alice',
        after: 'Bob',
      };
      expect(() => MutationSchema.parse(valid)).not.toThrow();
    });

    it('accepts mutation without before', () => {
      const valid = {
        key: 'user.name',
        after: 'Bob',
      };
      expect(() => MutationSchema.parse(valid)).not.toThrow();
    });

    it('rejects mutation without key', () => {
      const invalid = {
        after: 'Bob',
      };
      expect(() => MutationSchema.parse(invalid)).toThrow();
    });

    it('rejects mutation without after', () => {
      const invalid = {
        key: 'user.name',
      };
      expect(() => MutationSchema.parse(invalid)).toThrow();
    });
  });

  describe('InvokeEnvelopeSchema', () => {
    it('accepts valid invoke envelope', () => {
      const valid = {
        trace_id: 'trace-123',
        task_id: 'task-456',
        caller: 'agentA',
        target: 'agentB',
        function: 'processData',
        params: { data: [1, 2, 3] },
        state: { count: 0 },
        notes: 'Initial call',
        call_stack: ['agentA'],
        mode: 'sync' as const,
        max_depth: 5,
        expected_output: 'processed data',
      };
      expect(() => InvokeEnvelopeSchema.parse(valid)).not.toThrow();
    });

    it('accepts minimal invoke envelope', () => {
      const valid = {
        trace_id: 'trace-123',
        task_id: 'task-456',
        caller: 'agentA',
        target: 'agentB',
        function: 'processData',
        call_stack: [],
        mode: 'async' as const,
        max_depth: 3,
      };
      expect(() => InvokeEnvelopeSchema.parse(valid)).not.toThrow();
    });

    it('rejects invalid mode', () => {
      const invalid = {
        trace_id: 'trace-123',
        task_id: 'task-456',
        caller: 'agentA',
        target: 'agentB',
        function: 'processData',
        call_stack: [],
        mode: 'invalid',
        max_depth: 3,
      };
      expect(() => InvokeEnvelopeSchema.parse(invalid)).toThrow();
    });

    it('rejects negative max_depth', () => {
      const invalid = {
        trace_id: 'trace-123',
        task_id: 'task-456',
        caller: 'agentA',
        target: 'agentB',
        function: 'processData',
        call_stack: [],
        mode: 'sync',
        max_depth: -1,
      };
      expect(() => InvokeEnvelopeSchema.parse(invalid)).toThrow();
    });

    it('rejects missing required fields', () => {
      const invalid = {
        trace_id: 'trace-123',
        caller: 'agentA',
      };
      expect(() => InvokeEnvelopeSchema.parse(invalid)).toThrow();
    });
  });

  describe('ResponseEnvelopeSchema', () => {
    it('accepts valid response envelope', () => {
      const valid = {
        task_id: 'task-456',
        responder: 'agentB',
        returns: { result: 'success' },
        mutations: [
          { key: 'user.status', after: 'active' },
        ],
        source_refs: ['file1.ts:10-20', 'file2.ts:30-40'],
      };
      expect(() => ResponseEnvelopeSchema.parse(valid)).not.toThrow();
    });

    it('accepts minimal response envelope', () => {
      const valid = {
        task_id: 'task-456',
        responder: 'agentB',
        source_refs: ['file.ts:1'],
      };
      expect(() => ResponseEnvelopeSchema.parse(valid)).not.toThrow();
    });

    it('accepts response with error', () => {
      const valid = {
        task_id: 'task-456',
        responder: 'agentB',
        source_refs: ['file.ts:1'],
        error: 'Something went wrong',
      };
      expect(() => ResponseEnvelopeSchema.parse(valid)).not.toThrow();
    });

    it('rejects missing required fields', () => {
      const invalid = {
        task_id: 'task-456',
      };
      expect(() => ResponseEnvelopeSchema.parse(invalid)).toThrow();
    });
  });

  describe('DeclarationSchema', () => {
    it('accepts valid declaration', () => {
      const valid = {
        name: 'processData',
        kind: 'function' as const,
        intent: 'Process incoming data',
        file_path: '/src/processor.ts',
        start_line: 10,
        end_line: 25,
      };
      expect(() => DeclarationSchema.parse(valid)).not.toThrow();
    });

    it('accepts all valid kinds', () => {
      const kinds = ['class', 'method', 'function', 'type', 'struct', 'interface', 'const', 'schema', 'enum'] as const;
      for (const kind of kinds) {
        const valid = {
          name: 'test',
          kind,
          intent: 'test',
          file_path: '/test.ts',
          start_line: 1,
          end_line: 2,
        };
        expect(() => DeclarationSchema.parse(valid)).not.toThrow();
      }
    });

    it('rejects invalid kind', () => {
      const invalid = {
        name: 'test',
        kind: 'invalid',
        intent: 'test',
        file_path: '/test.ts',
        start_line: 1,
        end_line: 2,
      };
      expect(() => DeclarationSchema.parse(invalid)).toThrow();
    });

    it('rejects non-positive line numbers', () => {
      const invalid = {
        name: 'test',
        kind: 'function',
        intent: 'test',
        file_path: '/test.ts',
        start_line: 0,
        end_line: 2,
      };
      expect(() => DeclarationSchema.parse(invalid)).toThrow();
    });

    it('accepts declaration with params and return_type', () => {
      const valid = {
        name: 'SessionManager.create',
        kind: 'method' as const,
        intent: 'Create a new agent session',
        file_path: 'src/session-manager.ts',
        start_line: 89,
        end_line: 196,
        params: [
          { name: 'opts', type: 'CreateOptions' },
          { name: 'model', type: 'string' },
        ],
        return_type: 'Promise<AgentSession>',
      };
      const result = DeclarationSchema.parse(valid);
      expect(result.params).toHaveLength(2);
      expect(result.params![0]).toEqual({ name: 'opts', type: 'CreateOptions' });
      expect(result.return_type).toBe('Promise<AgentSession>');
    });

    it('accepts declaration without params/return_type (optional)', () => {
      const valid = {
        name: 'MyType',
        kind: 'type' as const,
        intent: 'A type alias',
        file_path: 'src/types.ts',
        start_line: 5,
        end_line: 8,
      };
      const result = DeclarationSchema.parse(valid);
      expect(result.params).toBeUndefined();
      expect(result.return_type).toBeUndefined();
    });

    it('accepts className.methodName convention', () => {
      const declarations = [
        { name: 'Registry', kind: 'class', intent: 'File registry', file_path: 'src/registry.ts', start_line: 10, end_line: 200 },
        { name: 'Registry.constructor', kind: 'method', intent: 'Initialize registry', file_path: 'src/registry.ts', start_line: 12, end_line: 20, params: [], return_type: 'Registry' },
        { name: 'Registry.get', kind: 'method', intent: 'Get entry by path', file_path: 'src/registry.ts', start_line: 22, end_line: 30, params: [{ name: 'path', type: 'string' }], return_type: 'RegistryEntry | undefined' },
        { name: 'Registry.get_size', kind: 'method', intent: 'Getter for size', file_path: 'src/registry.ts', start_line: 32, end_line: 34, params: [], return_type: 'number' },
      ];
      for (const decl of declarations) {
        expect(() => DeclarationSchema.parse(decl)).not.toThrow();
      }
    });

    it('rejects params with missing type field', () => {
      const invalid = {
        name: 'myFunc',
        kind: 'function',
        intent: 'test',
        file_path: '/test.ts',
        start_line: 1,
        end_line: 10,
        params: [{ name: 'arg1' }],  // missing type
      };
      expect(() => DeclarationSchema.parse(invalid)).toThrow();
    });
  });

  describe('DependencyRefSchema', () => {
    it('accepts valid dependency with required file_path', () => {
      const valid = {
        name: 'processData',
        from: './utils.js',
        kind: 'import' as const,
        file_path: 'src/utils.ts',
      };
      expect(() => DependencyRefSchema.parse(valid)).not.toThrow();
    });

    it('accepts all valid kinds', () => {
      const kinds = ['import', 'uses', 'reuses', 'inherits'] as const;
      for (const kind of kinds) {
        const valid = {
          name: 'test',
          from: './test.js',
          kind,
          file_path: 'src/test.ts',
        };
        expect(() => DependencyRefSchema.parse(valid)).not.toThrow();
      }
    });

    it('rejects missing file_path', () => {
      const invalid = {
        name: 'test',
        from: './test.js',
        kind: 'import',
      };
      expect(() => DependencyRefSchema.parse(invalid)).toThrow();
    });

    it('rejects invalid kind', () => {
      const invalid = {
        name: 'test',
        from: './test.js',
        kind: 'invalid',
        file_path: 'src/test.ts',
      };
      expect(() => DependencyRefSchema.parse(invalid)).toThrow();
    });
  });
});

describe('External MCP tool input schemas (:3100)', () => {
  describe('TraceInputSchema', () => {
    it('accepts valid trace input with all fields', () => {
      const valid = {
        entry_file: '/src/main.ts',
        function: 'start',
        params: { user: 'alice' },
        mode: 'full' as const,
        max_depth: 10,
        expected_output: 'User session started',
      };
      expect(() => TraceInputSchema.parse(valid)).not.toThrow();
    });

    it('accepts minimal trace input', () => {
      const valid = {
        entry_file: '/src/main.ts',
        function: 'start',
      };
      expect(() => TraceInputSchema.parse(valid)).not.toThrow();
    });

    it('accepts all valid modes', () => {
      const modes = ['full', 'targeted', 'lens'] as const;
      for (const mode of modes) {
        const valid = {
          entry_file: '/src/main.ts',
          function: 'start',
          mode,
        };
        expect(() => TraceInputSchema.parse(valid)).not.toThrow();
      }
    });

    it('rejects invalid mode', () => {
      const invalid = {
        entry_file: '/src/main.ts',
        function: 'start',
        mode: 'invalid',
      };
      expect(() => TraceInputSchema.parse(invalid)).toThrow();
    });

    it('rejects non-positive max_depth', () => {
      const invalid = {
        entry_file: '/src/main.ts',
        function: 'start',
        max_depth: 0,
      };
      expect(() => TraceInputSchema.parse(invalid)).toThrow();
    });

    it('accepts partial fields (all optional, scenario or entry_file+function)', () => {
      // All fields are optional — scenario-based or entry_file+function
      expect(() => TraceInputSchema.parse({ scenario: 'test' })).not.toThrow();
      expect(() => TraceInputSchema.parse({ entry_file: '/src/main.ts' })).not.toThrow();
      expect(() => TraceInputSchema.parse({})).not.toThrow();
    });
  });

  describe('InspectInputSchema', () => {
    it('accepts valid inspect input', () => {
      const valid = {
        file_path: '/src/agent.ts',
      };
      expect(() => InspectInputSchema.parse(valid)).not.toThrow();
    });

    it('rejects missing file_path', () => {
      const invalid = {};
      expect(() => InspectInputSchema.parse(invalid)).toThrow();
    });
  });

  describe('StatusInputSchema', () => {
    it('accepts empty object', () => {
      const valid = {};
      expect(() => StatusInputSchema.parse(valid)).not.toThrow();
    });

    it('accepts extra fields (Zod default behavior)', () => {
      const valid = { extra: 'ignored' };
      expect(() => StatusInputSchema.parse(valid)).not.toThrow();
    });
  });

  describe('ListAgentsInputSchema', () => {
    it('accepts empty object', () => {
      const valid = {};
      expect(() => ListAgentsInputSchema.parse(valid)).not.toThrow();
    });
  });

  describe('ConsolidateInputSchema', () => {
    it('accepts valid consolidate input', () => {
      const valid = {
        trace_id: 'trace-123',
      };
      expect(() => ConsolidateInputSchema.parse(valid)).not.toThrow();
    });

    it('rejects missing trace_id', () => {
      const invalid = {};
      expect(() => ConsolidateInputSchema.parse(invalid)).toThrow();
    });
  });

  describe('StarmapInputSchema', () => {
    it('accepts empty object', () => {
      const valid = {};
      expect(() => StarmapInputSchema.parse(valid)).not.toThrow();
    });

    it('accepts with file_path', () => {
      const valid = {
        file_path: '/src/agent.ts',
      };
      expect(() => StarmapInputSchema.parse(valid)).not.toThrow();
    });
  });
});

describe('Internal MCP tool input schemas (:3101)', () => {
  describe('InvokeInputSchema', () => {
    it('is the same as InvokeEnvelopeSchema', () => {
      expect(InvokeInputSchema).toBe(InvokeEnvelopeSchema);
    });

    it('accepts valid invoke input', () => {
      const valid = {
        trace_id: 'trace-123',
        task_id: 'task-456',
        caller: 'agentA',
        target: 'agentB',
        function: 'process',
        call_stack: ['agentA'],
        mode: 'sync' as const,
        max_depth: 5,
      };
      expect(() => InvokeInputSchema.parse(valid)).not.toThrow();
    });
  });

  describe('AgentInvokeInputSchema', () => {
    it('accepts valid agent invoke with all fields', () => {
      const valid = {
        name: 'processData',
        kind: 'function' as const,
        file_path: 'src/service.ts',
        params: { userId: 'abc' },
        expected_output: 'ProcessResult object',
      };
      expect(() => AgentInvokeInputSchema.parse(valid)).not.toThrow();
    });

    it('accepts minimal agent invoke (name, kind, file_path only)', () => {
      const valid = {
        name: 'handleRequest',
        kind: 'method' as const,
        file_path: 'src/handler.ts',
      };
      const parsed = AgentInvokeInputSchema.parse(valid);
      expect(parsed.name).toBe('handleRequest');
      expect(parsed.kind).toBe('method');
      expect(parsed.file_path).toBe('src/handler.ts');
      expect(parsed.params).toBeUndefined();
      expect(parsed.expected_output).toBeUndefined();
    });

    it('rejects missing required fields', () => {
      expect(() => AgentInvokeInputSchema.parse({})).toThrow();
      expect(() => AgentInvokeInputSchema.parse({ name: 'foo' })).toThrow();
      expect(() => AgentInvokeInputSchema.parse({ name: 'foo', kind: 'function' })).toThrow();
    });

    it('does NOT include trace_id — server fills it', () => {
      const shape = AgentInvokeInputSchema.shape;
      expect('trace_id' in shape).toBe(false);
    });
  });

  describe('RegisterInputSchema', () => {
    it('accepts valid register input', () => {
      const valid = {
        file_path: '/src/agent.ts',
        declarations: [
          {
            name: 'processData',
            kind: 'function' as const,
            intent: 'Process data',
            file_path: '/src/agent.ts',
            start_line: 10,
            end_line: 20,
          },
        ],
        dependencies: [
          {
            name: 'helper',
            from: './utils.js',
            kind: 'import' as const,
            file_path: 'src/utils.ts',
          },
        ],
      };
      expect(() => RegisterInputSchema.parse(valid)).not.toThrow();
    });

    it('accepts minimal register input', () => {
      const valid = {
        file_path: '/src/agent.ts',
        declarations: [],
      };
      expect(() => RegisterInputSchema.parse(valid)).not.toThrow();
    });

    it('rejects invalid declaration in array', () => {
      const invalid = {
        file_path: '/src/agent.ts',
        declarations: [
          {
            name: 'test',
            kind: 'invalid',
            intent: 'test',
            file_path: '/src/agent.ts',
            start_line: 1,
            end_line: 2,
          },
        ],
      };
      expect(() => RegisterInputSchema.parse(invalid)).toThrow();
    });
  });

  describe('StateGetInputSchema', () => {
    it('accepts valid state_get input', () => {
      const valid = {
        key: 'user.session',
      };
      expect(() => StateGetInputSchema.parse(valid)).not.toThrow();
    });

    it('rejects missing key', () => {
      const invalid = {};
      expect(() => StateGetInputSchema.parse(invalid)).toThrow();
    });
  });

  describe('StateSetInputSchema', () => {
    it('accepts valid state_set input with various value types', () => {
      const testCases = [
        { key: 'user.name', value: 'Alice' },
        { key: 'user.age', value: 30 },
        { key: 'user.active', value: true },
        { key: 'user.data', value: { nested: 'object' } },
        { key: 'user.items', value: [1, 2, 3] },
        { key: 'user.nullable', value: null },
      ];

      for (const testCase of testCases) {
        expect(() => StateSetInputSchema.parse(testCase)).not.toThrow();
      }
    });

    it('rejects missing key', () => {
      const invalid = {
        value: 'test',
      };
      expect(() => StateSetInputSchema.parse(invalid)).toThrow();
    });

    it('rejects missing value', () => {
      const invalid = {
        key: 'test',
      };
      expect(() => StateSetInputSchema.parse(invalid)).toThrow();
    });
  });

  describe('ResolveInputSchema', () => {
    it('accepts valid resolve input', () => {
      const valid = {
        file_path: '/src/agent.ts',
      };
      expect(() => ResolveInputSchema.parse(valid)).not.toThrow();
    });

    it('rejects missing file_path', () => {
      const invalid = {};
      expect(() => ResolveInputSchema.parse(invalid)).toThrow();
    });
  });

  describe('RespondInputSchema', () => {
    it('is the same as ResponseEnvelopeSchema', () => {
      expect(RespondInputSchema).toBe(ResponseEnvelopeSchema);
    });

    it('accepts valid respond input', () => {
      const valid = {
        task_id: 'task-456',
        responder: 'agentB',
        returns: { status: 'success' },
        source_refs: ['file1.ts:10-20'],
      };
      expect(() => RespondInputSchema.parse(valid)).not.toThrow();
    });
  });
});

describe('Type compatibility', () => {
  it('schemas produce types compatible with types.ts', () => {
    // This is a compile-time check - if schemas don't match types.ts,
    // TypeScript will error during tsc --noEmit

    // These type assertions verify compatibility
    // If schemas diverge from types.ts, these will fail at compile time
    const mutation: Mutation = MutationSchema.parse({
      key: 'test',
      after: 'value',
    });

    const invoke: InvokeEnvelope = InvokeEnvelopeSchema.parse({
      trace_id: 'trace-1',
      task_id: 'task-1',
      caller: 'a',
      target: 'b',
      function: 'f',
      call_stack: [],
      mode: 'sync',
      max_depth: 1,
    });

    const response: ResponseEnvelope = ResponseEnvelopeSchema.parse({
      task_id: 'task-1',
      responder: 'b',
      source_refs: ['file.ts:1'],
    });

    const declaration: Declaration = DeclarationSchema.parse({
      name: 'test',
      kind: 'function',
      intent: 'test',
      file_path: '/test.ts',
      start_line: 1,
      end_line: 2,
    });

    const dependency: DependencyRef = DependencyRefSchema.parse({
      name: 'test',
      from: './test.js',
      kind: 'import',
      file_path: 'src/test.ts',
    });

    // Suppress unused variable warnings
    expect(mutation).toBeDefined();
    expect(invoke).toBeDefined();
    expect(response).toBeDefined();
    expect(declaration).toBeDefined();
    expect(dependency).toBeDefined();
  });
});
