/**
 * FR-008: Guardrails — Pure validation functions for invoke handler.
 *
 * Exports: checkCycle, checkDepth, checkRateLimit, validateResponseEnvelope,
 *          checkSelfLoop, RateLimitTracker, SelfLoopTracker
 */

type GuardResult = { ok: boolean; error?: string };
type EnvelopeResult = { valid: boolean; errors: string[] };

// ---------------------------------------------------------------------------
// CounterTracker — shared base for frequency-counting guardrails
// ---------------------------------------------------------------------------

class CounterTracker {
  private counts = new Map<string, number>();

  record(key: string): number {
    const current = (this.counts.get(key) ?? 0) + 1;
    this.counts.set(key, current);
    return current;
  }

  get(key: string): number {
    return this.counts.get(key) ?? 0;
  }
}

// ---------------------------------------------------------------------------
// 1. checkCycle — target in call_stack -> CYCLE_DETECTED
// ---------------------------------------------------------------------------

export function checkCycle(target: string, callStack: string[]): GuardResult {
  if (callStack.includes(target)) {
    return { ok: false, error: 'CYCLE_DETECTED' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 2. checkDepth — call_stack.length >= maxDepth -> MAX_DEPTH_EXCEEDED
// ---------------------------------------------------------------------------

export function checkDepth(callStack: string[], maxDepth: number = 50): GuardResult {
  if (callStack.length >= maxDepth) {
    return { ok: false, error: 'MAX_DEPTH_EXCEEDED' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 3. checkRateLimit — max 5 invocations per agent per task
// ---------------------------------------------------------------------------

export class RateLimitTracker extends CounterTracker {}

export function checkRateLimit(
  agentPath: string,
  taskId: string,
  tracker: RateLimitTracker,
): GuardResult {
  const key = `${agentPath}:${taskId}`;
  const count = tracker.record(key);
  if (count > 5) {
    return { ok: false, error: 'RATE_LIMITED' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 4. validateResponseEnvelope — schema check, source_refs non-empty
// ---------------------------------------------------------------------------

export function validateResponseEnvelope(envelope: Record<string, unknown>): EnvelopeResult {
  const errors: string[] = [];

  if (typeof envelope.task_id !== 'string' || envelope.task_id === '') {
    errors.push('task_id must be a non-empty string');
  }

  if (typeof envelope.responder !== 'string' || envelope.responder === '') {
    errors.push('responder must be a non-empty string');
  }

  if (!Array.isArray(envelope.source_refs) || envelope.source_refs.length === 0) {
    errors.push('source_refs must be a non-empty array');
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// 5. checkSelfLoop — max 3 visits per target per trace
// ---------------------------------------------------------------------------

export class SelfLoopTracker extends CounterTracker {}

export function checkSelfLoop(
  target: string,
  traceId: string,
  tracker: SelfLoopTracker,
): GuardResult {
  const key = `${target}:${traceId}`;
  const count = tracker.record(key);
  if (count > 3) {
    return { ok: false, error: 'LOOP_SUSPECTED' };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// 6. Circuit Breaker — N consecutive failures per agent → CIRCUIT_OPEN
// ---------------------------------------------------------------------------

export class CircuitBreakerTracker {
  private consecutiveFailures = new Map<string, number>();
  private threshold: number;

  constructor(threshold: number = 3) {
    this.threshold = threshold;
  }

  recordFailure(agent: string): void {
    const current = this.consecutiveFailures.get(agent) ?? 0;
    this.consecutiveFailures.set(agent, current + 1);
  }

  recordSuccess(agent: string): void {
    this.consecutiveFailures.set(agent, 0);
  }

  getFailureCount(agent: string): number {
    return this.consecutiveFailures.get(agent) ?? 0;
  }

  getThreshold(): number {
    return this.threshold;
  }
}

export function checkCircuitBreaker(
  agent: string,
  tracker: CircuitBreakerTracker,
): GuardResult {
  const count = tracker.getFailureCount(agent);
  if (count >= tracker.getThreshold()) {
    return { ok: false, error: 'CIRCUIT_OPEN' };
  }
  return { ok: true };
}
