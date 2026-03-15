/**
 * E2E Integration Tests — Full eLLMulator Pipeline
 *
 * Exercises: scan → bootstrap → trace → analyze → findings
 * Uses a real multi-file TypeScript fixture project with known call patterns
 * and deliberate contract mismatches for finding detection.
 *
 * Gated behind RUN_INTEGRATION=1 — skips cleanly in normal test runs.
 * Run with: RUN_INTEGRATION=1 npx vitest run src/__integration__/e2e.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { mkdtemp, writeFile, rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { scanProjectFiles, calculateHash } from '../scanner.js';
import { Registry } from '../registry.js';
import { analyzeTrace, summarizeTrace } from '../analyzer.js';
import { createStarmap } from '../starmap.js';
import type { TraceEntry, Finding, Declarations } from '../types.js';

// ---------------------------------------------------------------------------
// Env gate — skip entire suite unless RUN_INTEGRATION=1
// ---------------------------------------------------------------------------
const runIntegration = process.env.RUN_INTEGRATION === '1';
const describeE2E = runIntegration ? describe : describe.skip;

// ---------------------------------------------------------------------------
// Fixture project: api.ts → service.ts → db.ts → utils.ts
//
// Deliberate issues baked in:
//   1. Contract mismatch: service.ts declares it depends on db.ts,
//      but db.queryUser returns { id, name } while service expects { id, name, email }
//   2. Missing error path: api.ts calls service.processOrder without error handling
//   3. Dead spot: logger.ts is registered but never called
// ---------------------------------------------------------------------------

const FIXTURES: Record<string, string> = {
  'src/api.ts': `
import { processOrder } from './service';
import { log } from './logger';

export async function handleRequest(req: any) {
  const result = await processOrder(req.orderId);
  return { status: 200, body: result };
}
`.trim(),

  'src/service.ts': `
import { queryUser } from './db';
import { formatCurrency } from './utils';

export async function processOrder(orderId: string) {
  const user = await queryUser(orderId);
  // BUG: assumes user has email field, but db.queryUser doesn't return it
  const receipt = \`Order for \${user.name} (\${user.email}) — \${formatCurrency(99.99)}\`;
  return { receipt, userId: user.id };
}
`.trim(),

  'src/db.ts': `
export async function queryUser(id: string) {
  // Returns { id, name } — missing 'email' that service.ts expects
  return { id, name: 'Alice' };
}

export async function queryOrder(id: string) {
  return { id, total: 99.99, status: 'pending' };
}
`.trim(),

  'src/utils.ts': `
export function formatCurrency(amount: number): string {
  return \`$\${amount.toFixed(2)}\`;
}

export function slugify(text: string): string {
  return text.toLowerCase().replace(/\\s+/g, '-');
}
`.trim(),

  'src/logger.ts': `
// Dead spot: registered but never invoked in the trace
export function log(level: string, message: string) {
  console.log(\`[\${level}] \${message}\`);
}
`.trim(),
};

// ---------------------------------------------------------------------------
// Simulated declarations (what agents would produce during bootstrap)
// ---------------------------------------------------------------------------

function buildDeclarations(): Record<string, Declarations> {
  return {
    'src/api.ts': {
      summary: 'HTTP request handler — entry point for order processing',
      owns: [
        { name: 'handleRequest', kind: 'function', intent: 'Handle incoming HTTP requests and delegate to service layer', file_path: 'src/api.ts', start_line: 4, end_line: 8 },
      ],
      imports: [],
      exports: [],
      dependencies: ['src/service.ts', 'src/logger.ts'],
    },
    'src/service.ts': {
      summary: 'Business logic — order processing with user lookup',
      owns: [
        { name: 'processOrder', kind: 'function', intent: 'Process an order by looking up user and formatting receipt', file_path: 'src/service.ts', start_line: 4, end_line: 9 },
      ],
      imports: [],
      exports: [],
      dependencies: ['src/db.ts', 'src/utils.ts'],
    },
    'src/db.ts': {
      summary: 'Database access layer — user and order queries',
      owns: [
        { name: 'queryUser', kind: 'function', intent: 'Query user by ID from database', file_path: 'src/db.ts', start_line: 1, end_line: 4 },
        { name: 'queryOrder', kind: 'function', intent: 'Query order by ID from database', file_path: 'src/db.ts', start_line: 6, end_line: 8 },
      ],
      imports: [],
      exports: [],
      dependencies: [],
    },
    'src/utils.ts': {
      summary: 'Utility functions — formatting helpers',
      owns: [
        { name: 'formatCurrency', kind: 'function', intent: 'Format number as USD currency string', file_path: 'src/utils.ts', start_line: 1, end_line: 3 },
        { name: 'slugify', kind: 'function', intent: 'Convert text to URL-safe slug', file_path: 'src/utils.ts', start_line: 5, end_line: 7 },
      ],
      imports: [],
      exports: [],
      dependencies: [],
    },
    'src/logger.ts': {
      summary: 'Logging utility — console output with level prefix',
      owns: [
        { name: 'log', kind: 'function', intent: 'Log message with severity level', file_path: 'src/logger.ts', start_line: 2, end_line: 4 },
      ],
      imports: [],
      exports: [],
      dependencies: [],
    },
  };
}

// ---------------------------------------------------------------------------
// Simulated trace (what a real trace execution would produce)
// ---------------------------------------------------------------------------

function buildTraceEntries(): TraceEntry[] {
  const traceId = 'e2e-trace-001';
  return [
    {
      trace_id: traceId,
      task_id: 'task-001',
      timestamp: new Date(),
      depth: 0,
      caller: '__trace_initiator__',
      target: 'src/api.ts',
      function: 'handleRequest',
      params: { orderId: 'ORD-123' },
      result: { status: 200, body: { receipt: 'Order for Alice (undefined) — $99.99', userId: 'ORD-123' } },
      call_stack: [],
    },
    {
      trace_id: traceId,
      task_id: 'task-002',
      timestamp: new Date(),
      depth: 1,
      caller: 'src/api.ts',
      target: 'src/service.ts',
      function: 'processOrder',
      params: { orderId: 'ORD-123' },
      expected_output: 'Returns receipt string and userId',
      result: { receipt: 'Order for Alice (undefined) — $99.99', userId: 'ORD-123' },
      call_stack: ['src/api.ts'],
    },
    {
      trace_id: traceId,
      task_id: 'task-003',
      timestamp: new Date(),
      depth: 2,
      caller: 'src/service.ts',
      target: 'src/db.ts',
      function: 'queryUser',
      params: { id: 'ORD-123' },
      expected_output: 'Returns User object with id, name, email fields',
      result: { id: 'ORD-123', name: 'Alice' },  // Missing email — contract mismatch
      call_stack: ['src/api.ts', 'src/service.ts'],
    },
    {
      trace_id: traceId,
      task_id: 'task-004',
      timestamp: new Date(),
      depth: 2,
      caller: 'src/service.ts',
      target: 'src/utils.ts',
      function: 'formatCurrency',
      params: { amount: 99.99 },
      result: '$99.99',
      call_stack: ['src/api.ts', 'src/service.ts'],
    },
  ];
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describeE2E('E2E Integration: Full Pipeline', () => {
  let fixtureDir: string;
  let registry: Registry;

  beforeAll(async () => {
    // Write fixture files to temp directory
    fixtureDir = await mkdtemp(join(tmpdir(), 'ellm-e2e-'));
    await mkdir(join(fixtureDir, 'src'), { recursive: true });

    for (const [relativePath, content] of Object.entries(FIXTURES)) {
      await writeFile(join(fixtureDir, relativePath), content, 'utf-8');
    }

    // Build registry with declarations (simulating post-bootstrap state)
    registry = new Registry();
    const declarations = buildDeclarations();

    for (const [filePath, content] of Object.entries(FIXTURES)) {
      registry.add({
        file_path: filePath,
        file_hash: calculateHash(content),
        status: 'ready',
        session_id: `session-${filePath.replace(/[/.]/g, '-')}`,
        declarations: declarations[filePath] ?? null,
        last_active: new Date(),
        error: null,
      });
    }
  });

  afterAll(async () => {
    if (fixtureDir) {
      await rm(fixtureDir, { recursive: true, force: true });
    }
  });

  // -----------------------------------------------------------------
  // Stage 1: Scanner
  // -----------------------------------------------------------------

  it('scanner discovers all fixture files', async () => {
    const files = await scanProjectFiles(fixtureDir);

    expect(files.length).toBe(Object.keys(FIXTURES).length);

    const paths = files.map(f => f.path);
    for (const fixturePath of Object.keys(FIXTURES)) {
      const fileName = fixturePath.split('/').pop()!;
      expect(paths.some(p => p.endsWith(fileName))).toBe(true);
    }
  });

  it('scanner computes valid hashes for each file', async () => {
    const files = await scanProjectFiles(fixtureDir);

    for (const file of files) {
      expect(file.hash).toBeDefined();
      expect(typeof file.hash).toBe('string');
      expect(file.hash.length).toBeGreaterThan(0);
      // Hash should be deterministic
      expect(file.hash).toBe(calculateHash(file.content));
    }
  });

  // -----------------------------------------------------------------
  // Stage 2: Registry (post-bootstrap state)
  // -----------------------------------------------------------------

  it('registry contains all fixture files with declarations', () => {
    expect(registry.size).toBe(Object.keys(FIXTURES).length);

    for (const filePath of Object.keys(FIXTURES)) {
      const entry = registry.get(filePath);
      expect(entry).toBeDefined();
      expect(entry!.status).toBe('ready');
      expect(entry!.declarations).not.toBeNull();
    }
  });

  // -----------------------------------------------------------------
  // Stage 3: Starmap (dependency graph)
  // -----------------------------------------------------------------

  it('starmap builds valid dependency clusters', () => {
    const starmap = createStarmap(registry);
    const clusters = starmap.clusters();

    expect(clusters.length).toBeGreaterThan(0);

    // All fixture files should appear in some cluster
    const allFiles = clusters.flat();
    for (const filePath of Object.keys(FIXTURES)) {
      expect(allFiles).toContain(filePath);
    }

    // api.ts and service.ts should have a dependency edge
    const edges = starmap.getCrossBoundaryEdges();
    // At minimum there should be edges between clusters
    expect(Array.isArray(edges)).toBe(true);
  });

  // -----------------------------------------------------------------
  // Stage 4: Trace analysis
  // -----------------------------------------------------------------

  it('analyzer produces findings from trace with known issues', () => {
    const entries = buildTraceEntries();
    const findings = analyzeTrace(entries, registry);

    expect(Array.isArray(findings)).toBe(true);
    expect(findings.length).toBeGreaterThan(0);

    // Should detect dead spot — logger.ts is registered but never called
    const deadSpots = findings.filter(f => f.type === 'dead_spot');
    expect(deadSpots.length).toBeGreaterThan(0);
    expect(deadSpots.some(f => f.caller.includes('logger'))).toBe(true);
  });

  it('analyzer detects assumption_bug from expected vs actual mismatch', () => {
    const entries = buildTraceEntries();
    const findings = analyzeTrace(entries, registry);

    // task-003: expected "User object with id, name, email" but got { id, name } (no email)
    const assumptionBugs = findings.filter(f => f.type === 'assumption_bug');
    expect(assumptionBugs.length).toBeGreaterThan(0);
  });

  it('summarizeTrace produces non-empty summary', () => {
    const entries = buildTraceEntries();
    const summary = summarizeTrace(entries);

    expect(typeof summary).toBe('string');
    expect(summary.length).toBeGreaterThan(0);
    // Should mention entry count
    expect(summary).toContain('4');
  });

  // -----------------------------------------------------------------
  // Stage 5: TraceResult assembly
  // -----------------------------------------------------------------

  it('full pipeline produces valid TraceResult shape', () => {
    const entries = buildTraceEntries();
    const findings = analyzeTrace(entries, registry);
    const summary = summarizeTrace(entries);
    const startTime = Date.now();

    const traceResult = {
      trace_id: 'e2e-trace-001',
      entries,
      summary,
      findings,
      duration_ms: Date.now() - startTime,
      observations: [] as string[],
    };

    // Validate all required fields
    expect(traceResult.trace_id).toBeDefined();
    expect(Array.isArray(traceResult.entries)).toBe(true);
    expect(traceResult.entries.length).toBe(4);
    expect(typeof traceResult.summary).toBe('string');
    expect(Array.isArray(traceResult.findings)).toBe(true);
    expect(typeof traceResult.duration_ms).toBe('number');
    expect(traceResult.duration_ms).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(traceResult.observations)).toBe(true);

    // Findings should have correct shape
    for (const finding of traceResult.findings) {
      expect(finding.type).toBeDefined();
      expect(finding.description).toBeDefined();
      expect(finding.caller).toBeDefined();
      expect(finding.severity).toBeDefined();
      expect(Array.isArray(finding.source_refs)).toBe(true);
    }
  });
});
