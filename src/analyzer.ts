/**
 * FR-017 / FR-018 / FR-019: Trace Analysis
 *
 * Provides seven analysis functions:
 *   - analyzeContractMismatches: detects calls to undeclared functions on targets
 *   - analyzeDeadSpots: detects trace entries with non-excluded errors
 *   - analyzeUnexpectedCalls: detects calls to targets not in caller's dependencies
 *   - analyzeMissingErrorPaths: detects error responses with no caller error handling (Phase 6.2)
 *   - analyzeAssumptionBugs: detects expected_output vs actual result mismatches (Phase 6.3)
 *   - analyzeTrace: master aggregator combining all sub-analyzers + orphan detection
 *   - summarizeTrace: generates human-readable trace summary (Phase 5: LLM-based)
 * 
 * Phase 5 additions:
 *   - detectEntryPoint: smart entry point detection using LLM + starmap + declarations
 *   - analyzeTraceWithObservations: freeform architectural observations
 */

import type { TraceEntry, Finding, Declaration } from './types.js';
import { Registry } from './registry.js';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { Starmap } from './starmap.js';

// ---------------------------------------------------------------------------
// Excluded error types for dead spot detection
// ---------------------------------------------------------------------------
const EXCLUDED_ERRORS = new Set(['CYCLE_DETECTED', 'MAX_DEPTH_EXCEEDED']);

// ---------------------------------------------------------------------------
// FR-017: Contract Mismatch Detection
// ---------------------------------------------------------------------------

/**
 * For each trace entry, checks whether the target's declarations.owns
 * contains the called function. If not, emits a contract_mismatch Finding.
 *
 * Skips when:
 *  - caller is '__trace_initiator__'
 *  - target is not in registry
 *  - target has no declarations (null)
 *  - caller has no declarations (null)
 */
export function analyzeContractMismatches(
  entries: TraceEntry[],
  registry: Registry,
): Finding[] {
  const findings: Finding[] = [];

  for (const entry of entries) {
    // Skip trace initiator
    if (entry.caller === '__trace_initiator__') continue;

    // Look up target in registry
    const targetEntry = registry.get(entry.target);
    if (!targetEntry) continue;

    // Skip if target has no declarations
    if (!targetEntry.declarations) continue;

    // Look up caller in registry
    const callerEntry = registry.get(entry.caller);
    if (!callerEntry) continue;

    // Skip if caller has no declarations
    if (!callerEntry.declarations) continue;

    // Check if target owns the called function
    const owns = targetEntry.declarations.owns;
    const functionDeclared = owns.some(
      (item: Declaration) => item.name === entry.function,
    );

    if (!functionDeclared) {
      findings.push({
        type: 'contract_mismatch',
        severity: 'high',
        caller: entry.caller,
        target: entry.target,
        source_refs: entry.source_refs ?? [],
        description: `${entry.caller} calls ${entry.function} on ${entry.target} but ${entry.target} does not declare it`,
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// FR-018: Dead Spot Detection
// ---------------------------------------------------------------------------

/**
 * Detects trace entries with errors, excluding CYCLE_DETECTED and
 * MAX_DEPTH_EXCEEDED. Each qualifying entry produces a dead_spot Finding.
 */
export function analyzeDeadSpots(entries: TraceEntry[]): Finding[] {
  const findings: Finding[] = [];

  for (const entry of entries) {
    if (!entry.error) continue;
    if (EXCLUDED_ERRORS.has(entry.error)) continue;

    findings.push({
      type: 'dead_spot',
      severity: 'medium',
      caller: entry.caller,
      target: entry.target,
      source_refs: entry.source_refs ?? [],
      description: `${entry.target}.${entry.function}: ${entry.error}`,
    });
  }

  return findings;
}

// ---------------------------------------------------------------------------
// FR-018: Unexpected Call Detection
// ---------------------------------------------------------------------------

/**
 * For each trace entry, checks whether the caller's declared dependencies
 * include the target. If not, emits an unexpected_call Finding.
 *
 * Skips when:
 *  - caller is '__trace_initiator__'
 *  - caller is not in registry or has no declarations
 */
export function analyzeUnexpectedCalls(
  entries: TraceEntry[],
  registry: Registry,
): Finding[] {
  const findings: Finding[] = [];

  for (const entry of entries) {
    // Skip trace initiator
    if (entry.caller === '__trace_initiator__') continue;

    // Look up caller in registry
    const callerEntry = registry.get(entry.caller);
    if (!callerEntry) continue;

    // Skip if caller has no declarations
    if (!callerEntry.declarations) continue;

    // Check if target is in caller's dependencies
    const deps = callerEntry.declarations.dependencies;
    if (!deps.includes(entry.target)) {
      findings.push({
        type: 'unexpected_call',
        severity: 'low',
        caller: entry.caller,
        target: entry.target,
        source_refs: entry.source_refs ?? [],
        description: `${entry.caller} calls ${entry.target} but does not declare it as a dependency`,
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Phase 6.2: Missing Error Path Detection
// ---------------------------------------------------------------------------

/**
 * Detects invocations that returned errors where the caller has no
 * subsequent error handling (retry, fallback, or error-related follow-up).
 *
 * Error handling heuristics:
 *  - Retry pattern: same caller→target.function after the error entry
 *  - Error-related follow-up: caller makes any subsequent call after the error
 *    to a target containing 'error', 'log', 'fallback', or 'retry' in path/function
 *
 * If no error handling is detected → missing_error_path finding.
 * Skips entries from '__trace_initiator__'.
 */
export function analyzeMissingErrorPaths(
  entries: TraceEntry[],
  registry: Registry,
): Finding[] {
  const findings: Finding[] = [];

  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i];

    // Only care about entries with errors
    if (!entry.error) continue;

    // Skip trace initiator
    if (entry.caller === '__trace_initiator__') continue;

    // Look for error handling in subsequent entries from the same caller
    let hasErrorHandling = false;

    for (let j = i + 1; j < entries.length; j++) {
      const subsequent = entries[j];

      // Only look at entries from the same caller
      if (subsequent.caller !== entry.caller) continue;

      // Retry pattern: same caller → same target.function, no error this time
      if (
        subsequent.target === entry.target &&
        subsequent.function === entry.function
      ) {
        hasErrorHandling = true;
        break;
      }

      // Error-related follow-up: caller calls something error/log/fallback-ish
      const errorKeywords = ['error', 'log', 'fallback', 'retry', 'catch', 'recover'];
      const targetLower = subsequent.target.toLowerCase();
      const funcLower = subsequent.function.toLowerCase();
      if (errorKeywords.some(kw => targetLower.includes(kw) || funcLower.includes(kw))) {
        hasErrorHandling = true;
        break;
      }
    }

    if (!hasErrorHandling) {
      findings.push({
        type: 'missing_error_path',
        severity: 'high',
        caller: entry.caller,
        target: entry.target,
        source_refs: entry.source_refs ?? [],
        description: `${entry.caller} receives error '${entry.error}' from ${entry.target}.${entry.function} but has no error handling`,
      });
    }
  }

  return findings;
}

// ---------------------------------------------------------------------------
// Phase 6.3: Assumption Bug Detection
// ---------------------------------------------------------------------------

/**
 * Detects mismatches between caller's expected_output and actual results.
 *
 * For each entry with expected_output set:
 *  - If entry.error exists → assumption_bug (expected success, got error)
 *  - If entry.result exists, heuristic comparison:
 *    - Extract field names mentioned in expected_output
 *    - Check if result (when object) contains those fields
 *    - Check if result looks like an error object (has 'error', 'status' with
 *      error-ish values like 'not_found', 'failed', etc.)
 *
 * No expected_output → skip (not an assumption to verify).
 */
export function analyzeAssumptionBugs(entries: TraceEntry[]): Finding[] {
  const findings: Finding[] = [];

  for (const entry of entries) {
    // Only care about entries with expected_output set
    if (!entry.expected_output) continue;

    // Skip trace initiator
    if (entry.caller === '__trace_initiator__') continue;

    // Case 1: error when success was expected
    if (entry.error) {
      findings.push({
        type: 'assumption_bug',
        severity: 'high',
        caller: entry.caller,
        target: entry.target,
        source_refs: entry.source_refs ?? [],
        description: `${entry.caller} expected '${entry.expected_output}' from ${entry.target}.${entry.function} but got error: ${entry.error}`,
      });
      continue;
    }

    // Case 2: result exists — heuristic comparison
    if (entry.result !== undefined && entry.result !== null) {
      if (isAssumptionMismatch(entry.expected_output, entry.result)) {
        findings.push({
          type: 'assumption_bug',
          severity: 'medium',
          caller: entry.caller,
          target: entry.target,
          source_refs: entry.source_refs ?? [],
          description: `${entry.caller} expected '${entry.expected_output}' from ${entry.target}.${entry.function} but result does not match`,
        });
      }
    }
  }

  return findings;
}

/**
 * Heuristic mismatch detection between expected_output description and actual result.
 *
 * Checks:
 * 1. If result looks like an error object (has error/status fields with error-ish values)
 * 2. If expected_output mentions specific field names and result doesn't have them
 */
function isAssumptionMismatch(expectedOutput: string, result: unknown): boolean {
  // If result is not an object, can't do structural comparison
  if (typeof result !== 'object' || result === null) return false;

  const resultObj = result as Record<string, unknown>;
  const resultKeys = Object.keys(resultObj);

  // Check 1: result looks like an error object
  const errorIndicators = ['error', 'err', 'fault', 'failure'];
  const errorStatusValues = ['not_found', 'failed', 'error', 'unauthorized', 'forbidden', 'timeout', 'unavailable'];

  // Result has an 'error' key → likely an error response, not expected data
  if (resultKeys.some(k => errorIndicators.includes(k.toLowerCase()))) {
    return true;
  }

  // Result has 'status' with error-ish value
  if ('status' in resultObj && typeof resultObj.status === 'string') {
    if (errorStatusValues.includes(resultObj.status.toLowerCase())) {
      return true;
    }
  }

  // Check 2: extract field names from expected_output and verify presence
  // Look for patterns like "with id, name, email fields" or "Returns a User object with id and name"
  const expectedLower = expectedOutput.toLowerCase();
  const fieldPattern = /\b(?:with|has|contains|includes|having)\b\s+(.+?)(?:\s+fields?)?$/i;
  const fieldMatch = expectedOutput.match(fieldPattern);

  if (fieldMatch) {
    // Extract individual field names: "id, name, email" or "id and name"
    const fieldStr = fieldMatch[1];
    const fields = fieldStr
      .split(/[,\s]+(?:and\s+)?/)
      .map(f => f.trim().toLowerCase())
      .filter(f => f.length > 0 && f !== 'and');

    if (fields.length > 0) {
      const resultKeysLower = resultKeys.map(k => k.toLowerCase());
      const missingFields = fields.filter(f => !resultKeysLower.includes(f));

      // If any expected field is missing, it's a mismatch
      if (missingFields.length > 0) {
        return true;
      }
    }
  }

  return false;
}

// ---------------------------------------------------------------------------
// FR-019: Master Aggregator
// ---------------------------------------------------------------------------

/**
 * Aggregates findings from all sub-analyzers:
 *  1. analyzeContractMismatches
 *  2. analyzeDeadSpots
 *  3. analyzeUnexpectedCalls
 *  4. analyzeMissingErrorPaths (Phase 6.2)
 *  5. analyzeAssumptionBugs (Phase 6.3)
 *
 * Also detects "orphan" files: files registered in the registry that are
 * never called as targets in the trace (dead_spot findings).
 *
 * Deduplicates findings by (type, caller, target).
 */
export function analyzeTrace(
  entries: TraceEntry[],
  registry: Registry,
): Finding[] {
  const contractFindings = analyzeContractMismatches(entries, registry);
  const deadSpotFindings = analyzeDeadSpots(entries);
  const unexpectedFindings = analyzeUnexpectedCalls(entries, registry);
  const missingErrorFindings = analyzeMissingErrorPaths(entries, registry);
  const assumptionFindings = analyzeAssumptionBugs(entries);

  // Combine all findings
  // NOTE: No orphan detection — traces report only what was observed.
  // Reachable-but-untraced files are NOT dead spots (same as Zipkin/Datadog).
  const all = [
    ...contractFindings,
    ...deadSpotFindings,
    ...unexpectedFindings,
    ...missingErrorFindings,
    ...assumptionFindings,
  ];

  // Deduplicate by (type, caller, target)
  const seen = new Set<string>();
  const deduplicated: Finding[] = [];
  for (const f of all) {
    const key = `${f.type}:${f.caller}:${f.target ?? ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      deduplicated.push(f);
    }
  }

  return deduplicated;
}

// ---------------------------------------------------------------------------
// FR-019: Trace Summary (Phase 5: LLM-based)
// ---------------------------------------------------------------------------

/**
 * Template-based fallback summary (when LLM unavailable).
 */
function templateSummary(entries: TraceEntry[]): string {
  if (entries.length === 0) {
    return 'Trace summary: 0 entries (empty trace)';
  }

  const entryCount = entries.length;
  const files = new Set<string>();
  for (const entry of entries) {
    files.add(entry.caller);
    files.add(entry.target);
  }
  const fileCount = files.size;
  const maxDepth = Math.max(...entries.map((e) => e.depth));
  const errorCount = entries.filter((e) => e.error).length;

  let summary = `Trace summary: ${entryCount} entries across ${fileCount} files, max depth ${maxDepth}`;
  if (errorCount > 0) {
    summary += `, ${errorCount} errors`;
  }
  return summary;
}

/**
 * Phase 5.6: Trace summary — synchronous template-based.
 *
 * Returns a human-readable summary string covering entry count,
 * unique files, max depth, and error count.
 *
 * For LLM-enriched summaries, use summarizeTraceAsync().
 */
export function summarizeTrace(entries: TraceEntry[]): string {
  return templateSummary(entries);
}

/**
 * Phase 5.6: LLM-enriched trace summary (async).
 *
 * Uses SDK query() to analyze trace entries for natural language summary.
 * Falls back to templateSummary on LLM failure.
 *
 * Prompt is token-efficient: sends structured summary data, not full trace JSON.
 */
export async function summarizeTraceAsync(entries: TraceEntry[]): Promise<string> {
  if (entries.length === 0) {
    return templateSummary(entries);
  }

  // Build concise prompt (not full JSON dump)
  const entryCount = entries.length;
  const files = new Set<string>();
  for (const entry of entries) {
    files.add(entry.caller);
    files.add(entry.target);
  }
  const fileCount = files.size;
  const maxDepth = Math.max(...entries.map((e) => e.depth));
  const errorCount = entries.filter((e) => e.error).length;

  // Extract key trace flow patterns (concise) with params
  const callFlow: string[] = [];
  for (let i = 0; i < Math.min(10, entries.length); i++) {
    const e = entries[i];
    const errorSuffix = e.error ? ` [ERROR: ${e.error}]` : '';
    const paramsStr = e.params ? ` (${JSON.stringify(e.params)})` : '';
    callFlow.push(`${e.caller} → ${e.target}.${e.function}${paramsStr}${errorSuffix}`);
  }
  if (entries.length > 10) {
    callFlow.push(`... (${entries.length - 10} more entries)`);
  }

  const prompt = `Analyze this distributed trace and provide a natural language summary (2-3 sentences).

Trace statistics:
- ${entryCount} entries across ${fileCount} files
- max depth ${maxDepth}
- Errors: ${errorCount}

Key call flow:
${callFlow.join('\n')}

Summarize what happened in this trace execution. Focus on the high-level behavior and architecture, not individual calls.`;

  try {
    // Call LLM for summary
    let llmSummary = '';
    for await (const message of query({
      prompt,
      options: {
        model: 'claude-sonnet-4-6',  // Use Sonnet for cost efficiency
        systemPrompt: 'You are a distributed trace analyzer. Provide concise, architectural summaries.',
        maxTurns: 1,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      },
    })) {
      if (message.type === 'assistant') {
        const assistantMsg = message as any;
        
        // Handle both real SDK structure (message.content) and test mock structure (content directly)
        const content = assistantMsg.message?.content || assistantMsg.content;
        
        if (typeof content === 'string') {
          // Test mock format: content is a string
          llmSummary += content;
        } else if (Array.isArray(content)) {
          // Real SDK format: content is ContentBlock[]
          for (const block of content) {
            if ('text' in block) {
              llmSummary += block.text;
            }
          }
        }
      }
      if (message.type === 'result') {
        const resultMsg = message as any;
        if (resultMsg.is_error) {
          // LLM failed, fall back to template
          return templateSummary(entries);
        }
      }
    }

    return llmSummary.trim() || templateSummary(entries);
  } catch {
    // LLM unavailable or error — fall back to template
    return templateSummary(entries);
  }
}

// ---------------------------------------------------------------------------
// Phase 5.7: Smart Entry Point Detection
// ---------------------------------------------------------------------------

/**
 * Detects the best entry point for a scenario using keyword matching + LLM fallback.
 * 
 * Strategy (in order):
 * 1. Keyword matching: tokenize scenario, score against declaration summaries + intents
 * 2. Root node tiebreaker: among equal-scoring candidates, prefer root nodes (no dependents)
 * 3. LLM fallback: if keyword matching produces no clear winner, ask LLM
 * 4. Heuristic fallback: first root node, or first candidate
 * 
 * @param scenario - Natural language description of what to trace
 * @param registry - Registry with file declarations
 * @param starmap - Dependency graph
 * @returns file_path of best entry point
 */
export async function detectEntryPoint(
  scenario: string,
  registry: Registry,
  starmap: Starmap,
): Promise<string> {
  const readyEntries = registry.listByStatus('ready');
  
  if (readyEntries.length === 0) {
    throw new Error('CANNOT_DETECT_ENTRY_POINT');
  }

  // Single candidate — no need for analysis
  if (readyEntries.length === 1) {
    return readyEntries[0].file_path;
  }

  // Build candidate list with metadata
  const candidates: Array<{
    path: string;
    summary: string;
    owns: Array<{ name: string; intent: string }>;
    isRoot: boolean;
  }> = [];

  for (const entry of readyEntries) {
    const isRoot = starmap.getDependents(entry.file_path).length === 0;
    candidates.push({
      path: entry.file_path,
      summary: entry.declarations?.summary || '',
      owns: (entry.declarations?.owns || []).map(d => ({ name: d.name, intent: d.intent })),
      isRoot,
    });
  }

  // ---------------------------------------------------------------------------
  // Step 1: Keyword matching — score each candidate against scenario tokens
  // ---------------------------------------------------------------------------
  const keywordResult = scoreByKeywords(scenario, candidates);
  if (keywordResult) {
    return keywordResult;
  }

  // ---------------------------------------------------------------------------
  // Step 2: LLM fallback — keyword matching didn't produce a clear winner
  // ---------------------------------------------------------------------------
  const candidateList = candidates.map(c => {
    const rootLabel = c.isRoot ? ' [ROOT NODE]' : '';
    const owns = c.owns.slice(0, 5).map(o => `    - ${o.name}: ${o.intent}`).join('\n');
    return `${c.path}${rootLabel}\n  Summary: ${c.summary}\n  Key functions:\n${owns}`;
  }).join('\n\n');

  const prompt = `Given this scenario:
"${scenario}"

Select the BEST entry point from these candidates:

${candidateList}

Consider:
1. Which file's declarations match the scenario keywords?
2. Root nodes [ROOT NODE] are often entry points (no incoming dependencies)
3. Match scenario intent to function intents

Respond with ONLY the file path, nothing else.`;

  try {
    let llmResponse = '';
    for await (const message of query({
      prompt,
      options: {
        model: 'claude-sonnet-4-6',
        systemPrompt: 'You are a code architecture analyzer. Select the best entry point for distributed traces.',
        maxTurns: 1,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      },
    })) {
      if (message.type === 'assistant') {
        const assistantMsg = message as any;
        const content = assistantMsg.message?.content || assistantMsg.content;
        if (typeof content === 'string') {
          llmResponse += content;
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if ('text' in block) {
              llmResponse += block.text;
            }
          }
        }
      }
      if (message.type === 'result') {
        const resultMsg = message as any;
        if (resultMsg.is_error) {
          return heuristicFallback(candidates);
        }
      }
    }

    const cleanResponse = llmResponse.trim();
    const matchedCandidate = candidates.find(c => cleanResponse.includes(c.path));
    if (matchedCandidate) {
      return matchedCandidate.path;
    }

    return heuristicFallback(candidates);
  } catch {
    return heuristicFallback(candidates);
  }
}

// ---------------------------------------------------------------------------
// Keyword scoring: tokenize scenario → match against declarations
// ---------------------------------------------------------------------------

/** Stop words to ignore during keyword extraction */
const STOP_WORDS = new Set([
  'a', 'an', 'the', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'to', 'of', 'in', 'for',
  'on', 'with', 'at', 'by', 'from', 'as', 'into', 'through', 'during',
  'before', 'after', 'above', 'below', 'between', 'and', 'but', 'or',
  'nor', 'not', 'so', 'yet', 'both', 'either', 'neither', 'each', 'every',
  'all', 'any', 'few', 'more', 'most', 'some', 'no', 'this', 'that',
  'these', 'those', 'it', 'its', 'what', 'which', 'who', 'whom', 'how',
  'when', 'where', 'why', 'if', 'then', 'than', 'too', 'very', 'just',
  'about', 'up', 'out', 'off', 'over', 'under', 'again', 'further',
  'once', 'here', 'there', 'such', 'only', 'same', 'other',
]);

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_\s]/g, ' ')
    .split(/\s+/)
    .filter(t => t.length > 1 && !STOP_WORDS.has(t));
}

/**
 * Score each candidate by counting how many scenario keywords appear in their
 * summary and declaration intents. Returns the best match if there's a clear
 * winner, or null if scores are too close/zero (indicating LLM should decide).
 */
function scoreByKeywords(
  scenario: string,
  candidates: Array<{
    path: string;
    summary: string;
    owns: Array<{ name: string; intent: string }>;
    isRoot: boolean;
  }>,
): string | null {
  const tokens = tokenize(scenario);
  if (tokens.length === 0) return null;

  const scores: Array<{ path: string; score: number; isRoot: boolean }> = [];

  for (const c of candidates) {
    // Build searchable text from summary + all intent strings + symbol names
    const searchText = [
      c.summary,
      ...c.owns.map(o => o.intent),
      ...c.owns.map(o => o.name),
    ].join(' ').toLowerCase();

    let score = 0;
    for (const token of tokens) {
      if (searchText.includes(token)) {
        score++;
      }
    }

    scores.push({ path: c.path, score, isRoot: c.isRoot });
  }

  // Sort by score descending, then prefer root nodes as tiebreaker
  scores.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score;
    if (a.isRoot && !b.isRoot) return -1;
    if (!a.isRoot && b.isRoot) return 1;
    return 0;
  });

  const best = scores[0];
  const second = scores[1];

  // Clear winner: best score > 0 and strictly better than second
  if (best.score > 0 && best.score > second.score) {
    return best.path;
  }

  // Tied scores but one is a root node — prefer root
  if (best.score > 0 && best.score === second.score && best.isRoot && !second.isRoot) {
    return best.path;
  }

  // No clear winner — let LLM decide
  return null;
}

/** Heuristic fallback: prefer root nodes, then first candidate */
function heuristicFallback(
  candidates: Array<{ path: string; isRoot: boolean }>,
): string {
  const roots = candidates.filter(c => c.isRoot);
  return roots.length > 0 ? roots[0].path : candidates[0].path;
}

// ---------------------------------------------------------------------------
// Phase 5: Freeform Observations (POC Pattern P5)
// ---------------------------------------------------------------------------

/**
 * Analyzes trace for freeform architectural observations.
 * 
 * Goes beyond typed findings to surface architectural insights:
 * - Race conditions, concurrency issues
 * - Missing error handling
 * - Performance bottlenecks
 * - Design pattern violations
 * 
 * @param entries - Trace entries
 * @param registry - Registry for context
 * @returns Object with observations array
 */
export async function analyzeTraceWithObservations(
  entries: TraceEntry[],
  registry: Registry,
): Promise<{ observations: string[] }> {
  if (entries.length === 0) {
    return { observations: [] };
  }

  // Build concise trace summary for LLM
  const callGraph: string[] = [];
  for (const entry of entries) {
    const errorSuffix = entry.error ? ` ❌ ${entry.error}` : '';
    callGraph.push(`[depth ${entry.depth}] ${entry.caller} → ${entry.target}.${entry.function}${errorSuffix}`);
  }

  const prompt = `Analyze this distributed trace for architectural insights.

Call graph:
${callGraph.join('\n')}

Provide 2-4 freeform observations about:
- Race conditions or concurrency issues
- Missing error handling patterns
- Performance bottlenecks
- Design pattern violations
- Silent failure points

Format as JSON: { "observations": ["observation 1", "observation 2", ...] }`;

  try {
    let llmResponse = '';
    for await (const message of query({
      prompt,
      options: {
        model: 'claude-sonnet-4-6',
        systemPrompt: 'You are an expert software architect analyzing distributed traces. Focus on architectural insights, not code details.',
        maxTurns: 1,
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
      },
    })) {
      if (message.type === 'assistant') {
        const assistantMsg = message as any;
        
        // Handle both real SDK structure and test mock structure
        const content = assistantMsg.message?.content || assistantMsg.content;
        
        if (typeof content === 'string') {
          llmResponse += content;
        } else if (Array.isArray(content)) {
          for (const block of content) {
            if ('text' in block) {
              llmResponse += block.text;
            }
          }
        }
      }
      if (message.type === 'result') {
        const resultMsg = message as any;
        if (resultMsg.is_error) {
          return { observations: [] };
        }
      }
    }

    // Parse JSON response
    const jsonMatch = llmResponse.match(/\{[\s\S]*"observations"[\s\S]*\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      if (Array.isArray(parsed.observations)) {
        return { observations: parsed.observations };
      }
    }

    // Fallback: treat response as single observation
    return { observations: [llmResponse.trim()] };
  } catch {
    // LLM unavailable or parse error
    return { observations: [] };
  }
}
