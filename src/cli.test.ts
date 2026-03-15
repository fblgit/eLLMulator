/**
 * FR-015: CLI Argument Parsing Tests
 * FR-OTEL-009: OTEL CLI Flags, Config Extension, main() Wiring, printUsage
 *
 * SPEC grounding:
 *   CLI:start  -> 'ellmulator start'  with flags: --project, --ext-port, --int-port,
 *                 --bootstrap, --threads, --model, --extensions, --skip-dirs, --verbose,
 *                 --otel-endpoint, --otel-protocol, --no-otel
 *   CLI:trace  -> 'ellmulator trace "<scenario>"' with flags: --entry, --max-depth,
 *                 --output, --state, --otel-endpoint, --otel-protocol
 *   CLI:consolidate -> 'ellmulator consolidate'
 *   CLI:status      -> 'ellmulator status'
 *
 * parseCLI(argv: string[]) -> CLIConfig (union of StartConfig | TraceConfig |
 *   ConsolidateConfig | StatusConfig)
 *
 * Pure parsing -- no execution, no server, no MCP wiring.
 *
 * FR-OTEL-009 tests verify:
 *   - parseStart handles --otel-endpoint, --otel-protocol, --no-otel
 *   - parseTrace handles --otel-endpoint, --otel-protocol
 *   - StartConfig extended with otelEndpoint?, otelProtocol?, otelEnabled
 *   - TraceConfig extended with otelEndpoint?, otelProtocol?
 *   - main() wiring: otelEnabled derived from otelEndpoint + --no-otel
 *   - printUsage() documents all 3 new flags
 */

import { describe, it, expect } from 'vitest';
import {
  parseCLI,
  type CLIConfig,
  type StartConfig,
  type TraceConfig,
  type ConsolidateConfig,
  type StatusConfig,
} from './cli.js';

// ===========================================================================
// 1. parseCLI exists and is callable
// ===========================================================================

describe('FR-015: parseCLI existence', () => {
  it('parseCLI is a function', () => {
    expect(typeof parseCLI).toBe('function');
  });
});

// ===========================================================================
// 2. start command: basic parsing
// ===========================================================================

describe('FR-015: start command', () => {
  it('parses start with --project and returns StartConfig', () => {
    const config = parseCLI(['start', '--project', '/foo']);
    expect(config.command).toBe('start');
    expect((config as StartConfig).project).toBe('/foo');
  });

  // -------------------------------------------------------
  // 3. start defaults
  // -------------------------------------------------------
  it('applies correct defaults for start command', () => {
    const config = parseCLI(['start', '--project', '/foo']) as StartConfig;
    expect(config.extPort).toBe(3100);
    expect(config.intPort).toBe(3101);
    expect(config.bootstrap).toBe(false);
    expect(config.threads).toBe(10);
    expect(config.model).toBe('claude-sonnet-4-6');
    expect(config.verbose).toBe(false);
  });

  it('defaults extensions to [".ts", ".go", ".py"]', () => {
    const config = parseCLI(['start', '--project', '/foo']) as StartConfig;
    expect(config.extensions).toEqual(['.ts', '.go', '.py']);
  });

  it('defaults skip-dirs to [".git", "node_modules", "vendor"]', () => {
    const config = parseCLI(['start', '--project', '/foo']) as StartConfig;
    expect(config.skipDirs).toEqual(['.git', 'node_modules', 'vendor']);
  });

  // -------------------------------------------------------
  // 4. start flag overrides
  // -------------------------------------------------------
  it('overrides ext-port via --ext-port', () => {
    const config = parseCLI([
      'start', '--project', '/foo', '--ext-port', '4000',
    ]) as StartConfig;
    expect(config.extPort).toBe(4000);
  });

  it('overrides int-port via --int-port', () => {
    const config = parseCLI([
      'start', '--project', '/foo', '--int-port', '4001',
    ]) as StartConfig;
    expect(config.intPort).toBe(4001);
  });

  it('sets bootstrap to true via --bootstrap flag', () => {
    const config = parseCLI([
      'start', '--project', '/foo', '--bootstrap',
    ]) as StartConfig;
    expect(config.bootstrap).toBe(true);
  });

  it('overrides threads via --threads', () => {
    const config = parseCLI([
      'start', '--project', '/foo', '--threads', '20',
    ]) as StartConfig;
    expect(config.threads).toBe(20);
  });

  it('overrides model via --model', () => {
    const config = parseCLI([
      'start', '--project', '/foo', '--model', 'claude-sonnet-4-6',
    ]) as StartConfig;
    expect(config.model).toBe('claude-sonnet-4-6');
  });

  it('sets verbose to true via --verbose flag', () => {
    const config = parseCLI([
      'start', '--project', '/foo', '--verbose',
    ]) as StartConfig;
    expect(config.verbose).toBe(true);
  });

  it('applies all overrides simultaneously', () => {
    const config = parseCLI([
      'start',
      '--project', '/bar',
      '--ext-port', '4000',
      '--int-port', '4001',
      '--bootstrap',
      '--threads', '20',
      '--model', 'claude-sonnet-4-6',
      '--verbose',
    ]) as StartConfig;
    expect(config.command).toBe('start');
    expect(config.project).toBe('/bar');
    expect(config.extPort).toBe(4000);
    expect(config.intPort).toBe(4001);
    expect(config.bootstrap).toBe(true);
    expect(config.threads).toBe(20);
    expect(config.model).toBe('claude-sonnet-4-6');
    expect(config.verbose).toBe(true);
  });

  // -------------------------------------------------------
  // 5. start requires --project
  // -------------------------------------------------------
  it('throws when --project is missing for start command', () => {
    expect(() => parseCLI(['start'])).toThrow();
  });

  it('throws when --project is provided without a value', () => {
    expect(() => parseCLI(['start', '--project'])).toThrow();
  });

  // -------------------------------------------------------
  // 6. --extensions: comma-separated -> string array
  // -------------------------------------------------------
  it('parses --extensions comma-separated values into string array', () => {
    const config = parseCLI([
      'start', '--project', '/foo', '--extensions', '.ts,.rs,.java',
    ]) as StartConfig;
    expect(config.extensions).toEqual(['.ts', '.rs', '.java']);
  });

  it('handles single extension in --extensions', () => {
    const config = parseCLI([
      'start', '--project', '/foo', '--extensions', '.go',
    ]) as StartConfig;
    expect(config.extensions).toEqual(['.go']);
  });

  // -------------------------------------------------------
  // 7. --skip-dirs: comma-separated -> string array
  // -------------------------------------------------------
  it('parses --skip-dirs comma-separated values into string array', () => {
    const config = parseCLI([
      'start', '--project', '/foo', '--skip-dirs', 'dist,build,.cache',
    ]) as StartConfig;
    expect(config.skipDirs).toEqual(['dist', 'build', '.cache']);
  });

  it('handles single dir in --skip-dirs', () => {
    const config = parseCLI([
      'start', '--project', '/foo', '--skip-dirs', 'dist',
    ]) as StartConfig;
    expect(config.skipDirs).toEqual(['dist']);
  });
});

// ===========================================================================
// 8. trace command
// ===========================================================================

describe('FR-015: trace command', () => {
  it('parses trace with positional scenario argument', () => {
    const config = parseCLI([
      'trace', 'what happens when POST /api/users',
    ]);
    expect(config.command).toBe('trace');
    expect((config as TraceConfig).scenario).toBe(
      'what happens when POST /api/users',
    );
  });

  // -------------------------------------------------------
  // 9. trace defaults
  // -------------------------------------------------------
  it('applies correct defaults for trace command', () => {
    const config = parseCLI([
      'trace', 'test scenario',
    ]) as TraceConfig;
    expect(config.maxDepth).toBe(50);
    expect(config.output).toBeUndefined();
    expect(config.entry).toBeUndefined();
    expect(config.state).toBeUndefined();
  });

  it('overrides entry via --entry', () => {
    const config = parseCLI([
      'trace', 'test scenario', '--entry', 'src/main.ts',
    ]) as TraceConfig;
    expect(config.entry).toBe('src/main.ts');
  });

  it('overrides max-depth via --max-depth', () => {
    const config = parseCLI([
      'trace', 'test scenario', '--max-depth', '25',
    ]) as TraceConfig;
    expect(config.maxDepth).toBe(25);
  });

  it('overrides output via --output', () => {
    const config = parseCLI([
      'trace', 'test scenario', '--output', 'trace.jsonl',
    ]) as TraceConfig;
    expect(config.output).toBe('trace.jsonl');
  });

  // -------------------------------------------------------
  // 10. trace --state parses JSON
  // -------------------------------------------------------
  it('parses --state JSON string into object', () => {
    const config = parseCLI([
      'trace', 'scenario', '--state', '{"key":"val"}',
    ]) as TraceConfig;
    expect(config.state).toEqual({ key: 'val' });
  });

  it('parses --state with nested JSON', () => {
    const config = parseCLI([
      'trace', 'scenario', '--state', '{"user":{"name":"Alice"},"debug":true}',
    ]) as TraceConfig;
    expect(config.state).toEqual({ user: { name: 'Alice' }, debug: true });
  });

  it('throws on invalid --state JSON', () => {
    expect(() =>
      parseCLI(['trace', 'scenario', '--state', 'not-json']),
    ).toThrow();
  });

  it('applies all trace overrides simultaneously', () => {
    const config = parseCLI([
      'trace', 'complex scenario',
      '--entry', 'src/app.ts',
      '--max-depth', '30',
      '--output', 'out.jsonl',
      '--state', '{"env":"test"}',
    ]) as TraceConfig;
    expect(config.command).toBe('trace');
    expect(config.scenario).toBe('complex scenario');
    expect(config.entry).toBe('src/app.ts');
    expect(config.maxDepth).toBe(30);
    expect(config.output).toBe('out.jsonl');
    expect(config.state).toEqual({ env: 'test' });
  });
});

// ===========================================================================
// 11. consolidate command
// ===========================================================================

describe('FR-015: consolidate command', () => {
  it('parses consolidate command', () => {
    const config = parseCLI(['consolidate']);
    expect(config.command).toBe('consolidate');
  });

  it('returns ConsolidateConfig type shape', () => {
    const config = parseCLI(['consolidate']) as ConsolidateConfig;
    expect(config.command).toBe('consolidate');
  });
});

// ===========================================================================
// 12. status command
// ===========================================================================

describe('FR-015: status command', () => {
  it('parses status command', () => {
    const config = parseCLI(['status']);
    expect(config.command).toBe('status');
  });

  it('returns StatusConfig type shape', () => {
    const config = parseCLI(['status']) as StatusConfig;
    expect(config.command).toBe('status');
  });
});

// ===========================================================================
// 13. unknown command throws
// ===========================================================================

describe('FR-015: unknown command', () => {
  it('throws on unknown command', () => {
    expect(() => parseCLI(['unknown'])).toThrow();
  });

  it('throws on empty argv', () => {
    expect(() => parseCLI([])).toThrow();
  });
});

// ===========================================================================
// FR-OTEL-009: OTEL CLI Flags — parseStart
// ===========================================================================

describe('FR-OTEL-009: parseStart OTEL flags', () => {
  // Acceptance criterion 1:
  // GIVEN CLI args ["start", "--project", ".", "--otel-endpoint", "http://localhost:4318/v1/traces"],
  // WHEN parsed, THEN config.otelEndpoint SHALL be "http://localhost:4318/v1/traces"
  it('parseStart extracts --otel-endpoint value into config.otelEndpoint', () => {
    const config = parseCLI([
      'start', '--project', '.', '--otel-endpoint', 'http://localhost:4318/v1/traces',
    ]) as StartConfig;
    expect(config.otelEndpoint).toBe('http://localhost:4318/v1/traces');
  });

  // Acceptance criterion 2:
  // GIVEN CLI args ["start", "--project", ".", "--otel-protocol", "http/json"],
  // WHEN parsed, THEN config.otelProtocol SHALL be "http/json"
  it('parseStart extracts --otel-protocol value into config.otelProtocol', () => {
    const config = parseCLI([
      'start', '--project', '.', '--otel-protocol', 'http/json',
    ]) as StartConfig;
    expect(config.otelProtocol).toBe('http/json');
  });

  // Acceptance criterion 3:
  // GIVEN CLI args ["start", "--project", ".", "--no-otel"],
  // WHEN parsed, THEN config.otelEnabled SHALL be false
  it('parseStart sets otelEnabled to false when --no-otel flag is present', () => {
    const config = parseCLI([
      'start', '--project', '.', '--no-otel',
    ]) as StartConfig;
    expect(config.otelEnabled).toBe(false);
  });

  // Acceptance criterion 4:
  // GIVEN CLI args ["start", "--project", "."] with NO otel flags,
  // WHEN parsed, THEN config.otelEndpoint SHALL be undefined (OTEL disabled by default)
  it('parseStart leaves otelEndpoint undefined when no OTEL flags provided', () => {
    const config = parseCLI([
      'start', '--project', '.',
    ]) as StartConfig;
    expect(config.otelEndpoint).toBeUndefined();
  });

  // Edge case: --otel-protocol defaults to undefined when not specified
  it('parseStart leaves otelProtocol undefined when --otel-protocol not specified', () => {
    const config = parseCLI([
      'start', '--project', '.',
    ]) as StartConfig;
    expect(config.otelProtocol).toBeUndefined();
  });

  // Edge case: --otel-endpoint without a value should throw (consistent with consumeValue pattern)
  it('parseStart throws when --otel-endpoint is provided without a value', () => {
    expect(() => parseCLI([
      'start', '--project', '.', '--otel-endpoint',
    ])).toThrow('Missing value for --otel-endpoint');
  });

  // Edge case: --otel-protocol without a value should throw
  it('parseStart throws when --otel-protocol is provided without a value', () => {
    expect(() => parseCLI([
      'start', '--project', '.', '--otel-protocol',
    ])).toThrow('Missing value for --otel-protocol');
  });

  // Integration: OTEL flags coexist with all existing start flags
  it('parseStart handles OTEL flags alongside all existing flags', () => {
    const config = parseCLI([
      'start',
      '--project', '/app',
      '--ext-port', '4000',
      '--bootstrap',
      '--otel-endpoint', 'http://collector:4318/v1/traces',
      '--otel-protocol', 'http/protobuf',
      '--threads', '5',
      '--verbose',
    ]) as StartConfig;
    expect(config.command).toBe('start');
    expect(config.project).toBe('/app');
    expect(config.extPort).toBe(4000);
    expect(config.bootstrap).toBe(true);
    expect(config.threads).toBe(5);
    expect(config.verbose).toBe(true);
    expect(config.otelEndpoint).toBe('http://collector:4318/v1/traces');
    expect(config.otelProtocol).toBe('http/protobuf');
  });

  // Edge case: --otel-endpoint and --no-otel both present (explicit disable with endpoint)
  it('parseStart accepts both --otel-endpoint and --no-otel simultaneously', () => {
    const config = parseCLI([
      'start', '--project', '.',
      '--otel-endpoint', 'http://localhost:4318/v1/traces',
      '--no-otel',
    ]) as StartConfig;
    expect(config.otelEndpoint).toBe('http://localhost:4318/v1/traces');
    expect(config.otelEnabled).toBe(false);
  });

  // Edge case: --otel-protocol alone without --otel-endpoint
  it('parseStart accepts --otel-protocol without --otel-endpoint', () => {
    const config = parseCLI([
      'start', '--project', '.', '--otel-protocol', 'http/json',
    ]) as StartConfig;
    expect(config.otelProtocol).toBe('http/json');
    expect(config.otelEndpoint).toBeUndefined();
  });
});

// ===========================================================================
// FR-OTEL-009: OTEL CLI Flags — parseTrace
// ===========================================================================

describe('FR-OTEL-009: parseTrace OTEL flags', () => {
  // Acceptance criterion 5:
  // GIVEN CLI args ["trace", "scenario", "--otel-endpoint", "http://collector:4318/v1/traces"],
  // WHEN parsed, THEN config.otelEndpoint SHALL be "http://collector:4318/v1/traces"
  it('parseTrace extracts --otel-endpoint value into config.otelEndpoint', () => {
    const config = parseCLI([
      'trace', 'scenario', '--otel-endpoint', 'http://collector:4318/v1/traces',
    ]) as TraceConfig;
    expect(config.otelEndpoint).toBe('http://collector:4318/v1/traces');
  });

  // Trace command also supports --otel-protocol
  it('parseTrace extracts --otel-protocol value into config.otelProtocol', () => {
    const config = parseCLI([
      'trace', 'scenario', '--otel-protocol', 'http/json',
    ]) as TraceConfig;
    expect(config.otelProtocol).toBe('http/json');
  });

  // Edge case: trace with no OTEL flags — otelEndpoint should be undefined
  it('parseTrace leaves otelEndpoint undefined when no OTEL flags provided', () => {
    const config = parseCLI([
      'trace', 'test scenario',
    ]) as TraceConfig;
    expect(config.otelEndpoint).toBeUndefined();
  });

  // Edge case: trace with no OTEL flags — otelProtocol should be undefined
  it('parseTrace leaves otelProtocol undefined when no OTEL flags provided', () => {
    const config = parseCLI([
      'trace', 'test scenario',
    ]) as TraceConfig;
    expect(config.otelProtocol).toBeUndefined();
  });

  // Integration: OTEL flags coexist with existing trace flags
  it('parseTrace handles OTEL flags alongside existing trace flags', () => {
    const config = parseCLI([
      'trace', 'complex scenario',
      '--entry', 'src/main.ts',
      '--max-depth', '25',
      '--otel-endpoint', 'http://localhost:4318/v1/traces',
      '--otel-protocol', 'http/protobuf',
      '--output', 'trace.jsonl',
    ]) as TraceConfig;
    expect(config.scenario).toBe('complex scenario');
    expect(config.entry).toBe('src/main.ts');
    expect(config.maxDepth).toBe(25);
    expect(config.output).toBe('trace.jsonl');
    expect(config.otelEndpoint).toBe('http://localhost:4318/v1/traces');
    expect(config.otelProtocol).toBe('http/protobuf');
  });

  // Edge case: --otel-endpoint without value in trace command
  it('parseTrace throws when --otel-endpoint is provided without a value', () => {
    expect(() => parseCLI([
      'trace', 'scenario', '--otel-endpoint',
    ])).toThrow('Missing value for --otel-endpoint');
  });

  // Edge case: --otel-protocol without value in trace command
  it('parseTrace throws when --otel-protocol is provided without a value', () => {
    expect(() => parseCLI([
      'trace', 'scenario', '--otel-protocol',
    ])).toThrow('Missing value for --otel-protocol');
  });
});

// ===========================================================================
// FR-OTEL-009: StartConfig Type Extension
// ===========================================================================

describe('FR-OTEL-009: StartConfig type extension', () => {
  // Acceptance criterion 9 (partial):
  // StartConfig SHALL have otelEndpoint?, otelProtocol?, otelEnabled fields
  it('StartConfig includes otelEndpoint field when --otel-endpoint provided', () => {
    const config = parseCLI([
      'start', '--project', '.', '--otel-endpoint', 'http://localhost:4318/v1/traces',
    ]) as StartConfig;
    // The field must exist on the config object (not just be a stray property)
    expect('otelEndpoint' in config).toBe(true);
    expect(config.otelEndpoint).toBe('http://localhost:4318/v1/traces');
  });

  it('StartConfig includes otelProtocol field when --otel-protocol provided', () => {
    const config = parseCLI([
      'start', '--project', '.', '--otel-protocol', 'http/json',
    ]) as StartConfig;
    expect('otelProtocol' in config).toBe(true);
    expect(config.otelProtocol).toBe('http/json');
  });

  it('StartConfig includes otelEnabled field when --no-otel provided', () => {
    const config = parseCLI([
      'start', '--project', '.', '--no-otel',
    ]) as StartConfig;
    expect('otelEnabled' in config).toBe(true);
    expect(config.otelEnabled).toBe(false);
  });
});

// ===========================================================================
// FR-OTEL-009: main() Wiring — otelEnabled Derivation Logic
// ===========================================================================

describe('FR-OTEL-009: main() wiring otelEnabled logic', () => {
  // These tests verify the otelEnabled derivation formula from the PRD:
  //   otelEnabled: config.otelEndpoint ? (config.otelEnabled ?? true) : false
  //
  // Actual main() -> createServer() wiring is tested in cli-main.test.ts
  // (tests 14-16). These formula tests complement that by validating the
  // derivation logic in isolation from server-side effects.

  // Acceptance criterion 6:
  // GIVEN otelEndpoint provided without --no-otel,
  // WHEN main() runs start command, THEN createServer SHALL receive otelEnabled=true
  it('otelEndpoint without --no-otel derives otelEnabled=true', () => {
    const config = parseCLI([
      'start', '--project', '.',
      '--otel-endpoint', 'http://localhost:4318/v1/traces',
    ]) as StartConfig;
    // The wiring formula: config.otelEndpoint ? (config.otelEnabled ?? true) : false
    const derivedOtelEnabled = config.otelEndpoint
      ? (config.otelEnabled ?? true)
      : false;
    expect(derivedOtelEnabled).toBe(true);
  });

  // Acceptance criterion 7:
  // GIVEN otelEndpoint provided WITH --no-otel,
  // WHEN main() runs start command, THEN createServer SHALL receive otelEnabled=false
  it('otelEndpoint with --no-otel derives otelEnabled=false', () => {
    const config = parseCLI([
      'start', '--project', '.',
      '--otel-endpoint', 'http://localhost:4318/v1/traces',
      '--no-otel',
    ]) as StartConfig;
    const derivedOtelEnabled = config.otelEndpoint
      ? (config.otelEnabled ?? true)
      : false;
    expect(derivedOtelEnabled).toBe(false);
  });

  // Acceptance criterion 8:
  // GIVEN no otelEndpoint,
  // WHEN main() runs start command, THEN createServer SHALL receive otelEnabled=false
  it('no otelEndpoint derives otelEnabled=false regardless of other flags', () => {
    const config = parseCLI([
      'start', '--project', '.',
    ]) as StartConfig;
    const derivedOtelEnabled = config.otelEndpoint
      ? (config.otelEnabled ?? true)
      : false;
    expect(derivedOtelEnabled).toBe(false);
  });
});

// ===========================================================================
// FR-OTEL-009: printUsage() Documents OTEL Flags
// ===========================================================================

describe('FR-OTEL-009: printUsage documents OTEL flags', () => {
  // Acceptance criterion 10:
  // printUsage() SHALL document --otel-endpoint, --otel-protocol, --no-otel flags

  it('printUsage is exported and callable', async () => {
    // Dynamic import to get all exports and check printUsage presence
    const cliModule = await import('./cli.js');
    expect(typeof (cliModule as any).printUsage).toBe('function');
  });

  it('printUsage output contains --otel-endpoint flag documentation', async () => {
    const cliModule = await import('./cli.js');
    const printUsage = (cliModule as any).printUsage as () => void;

    // Capture stdout output
    let captured = '';
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Buffer) => {
      captured += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    }) as typeof process.stdout.write;

    try {
      printUsage();
    } finally {
      process.stdout.write = originalWrite;
    }

    expect(captured).toContain('--otel-endpoint');
  });

  it('printUsage output contains --otel-protocol flag documentation', async () => {
    const cliModule = await import('./cli.js');
    const printUsage = (cliModule as any).printUsage as () => void;

    let captured = '';
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Buffer) => {
      captured += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    }) as typeof process.stdout.write;

    try {
      printUsage();
    } finally {
      process.stdout.write = originalWrite;
    }

    expect(captured).toContain('--otel-protocol');
  });

  it('printUsage output contains --no-otel flag documentation', async () => {
    const cliModule = await import('./cli.js');
    const printUsage = (cliModule as any).printUsage as () => void;

    let captured = '';
    const originalWrite = process.stdout.write;
    process.stdout.write = ((chunk: string | Buffer) => {
      captured += typeof chunk === 'string' ? chunk : chunk.toString();
      return true;
    }) as typeof process.stdout.write;

    try {
      printUsage();
    } finally {
      process.stdout.write = originalWrite;
    }

    expect(captured).toContain('--no-otel');
  });
});

// ===========================================================================
// init command
// ===========================================================================

describe('FR-INIT: init command parsing', () => {
  it('parses init with positional target-dir', () => {
    const config = parseCLI(['init', './my-project']);
    expect(config.command).toBe('init');
    expect((config as any).targetDir).toBe('./my-project');
    expect((config as any).extPort).toBe(3100);
  });

  it('parses init with --ext-port override', () => {
    const config = parseCLI(['init', './my-project', '--ext-port', '4200']);
    expect(config.command).toBe('init');
    expect((config as any).targetDir).toBe('./my-project');
    expect((config as any).extPort).toBe(4200);
  });

  it('throws if target-dir is missing', () => {
    expect(() => parseCLI(['init'])).toThrow('<target-dir> is required');
  });
});
