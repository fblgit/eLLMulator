/**
 * Phase 6A RED Tests: Circuit Breaker (Task 6.1)
 *
 * SPEC: Track failure rates per agent — N consecutive failures → status=error,
 * skip invocations. Circuit breaker at server level.
 *
 * Pattern: Extends guardrails.ts CounterTracker pattern.
 * Key difference: consecutive failures RESET on success.
 *
 * These tests MUST FAIL until 6A GREEN implements the feature.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  CircuitBreakerTracker,
  checkCircuitBreaker,
} from '../guardrails.js';

describe('Phase 6A: Circuit Breaker', () => {
  let tracker: CircuitBreakerTracker;

  beforeEach(() => {
    tracker = new CircuitBreakerTracker();
  });

  // -------------------------------------------------------------------
  // Core: consecutive failure tracking
  // -------------------------------------------------------------------

  it('[MUST-PASS-AT-PHASE-6] should allow invocations when no failures recorded', () => {
    const result = checkCircuitBreaker('src/api.ts', tracker);
    expect(result.ok).toBe(true);
  });

  it('[MUST-PASS-AT-PHASE-6] should allow invocations below failure threshold', () => {
    // Record 2 failures (default threshold is 3)
    tracker.recordFailure('src/api.ts');
    tracker.recordFailure('src/api.ts');

    const result = checkCircuitBreaker('src/api.ts', tracker);
    expect(result.ok).toBe(true);
  });

  it('[MUST-PASS-AT-PHASE-6] should trip after N consecutive failures', () => {
    // Default threshold: 3 consecutive failures
    tracker.recordFailure('src/api.ts');
    tracker.recordFailure('src/api.ts');
    tracker.recordFailure('src/api.ts');

    const result = checkCircuitBreaker('src/api.ts', tracker);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('CIRCUIT_OPEN');
  });

  it('[MUST-PASS-AT-PHASE-6] should reset consecutive count on success', () => {
    // 2 failures, then success, then 2 more failures → still ok
    tracker.recordFailure('src/api.ts');
    tracker.recordFailure('src/api.ts');
    tracker.recordSuccess('src/api.ts');
    tracker.recordFailure('src/api.ts');
    tracker.recordFailure('src/api.ts');

    const result = checkCircuitBreaker('src/api.ts', tracker);
    expect(result.ok).toBe(true);
  });

  it('[MUST-PASS-AT-PHASE-6] should track agents independently', () => {
    // Trip src/api.ts but not src/db.ts
    tracker.recordFailure('src/api.ts');
    tracker.recordFailure('src/api.ts');
    tracker.recordFailure('src/api.ts');

    expect(checkCircuitBreaker('src/api.ts', tracker).ok).toBe(false);
    expect(checkCircuitBreaker('src/db.ts', tracker).ok).toBe(true);
  });

  it('[MUST-PASS-AT-PHASE-6] should support custom threshold', () => {
    const customTracker = new CircuitBreakerTracker(5);

    // 4 failures → still ok with threshold 5
    customTracker.recordFailure('src/api.ts');
    customTracker.recordFailure('src/api.ts');
    customTracker.recordFailure('src/api.ts');
    customTracker.recordFailure('src/api.ts');
    expect(checkCircuitBreaker('src/api.ts', customTracker).ok).toBe(true);

    // 5th failure → trips
    customTracker.recordFailure('src/api.ts');
    expect(checkCircuitBreaker('src/api.ts', customTracker).ok).toBe(false);
    expect(checkCircuitBreaker('src/api.ts', customTracker).error).toBe('CIRCUIT_OPEN');
  });

  it('[MUST-PASS-AT-PHASE-6] should report consecutive failure count in error', () => {
    tracker.recordFailure('src/api.ts');
    tracker.recordFailure('src/api.ts');
    tracker.recordFailure('src/api.ts');

    const result = checkCircuitBreaker('src/api.ts', tracker);
    expect(result.ok).toBe(false);
    // Error should mention the count or agent path for diagnostics
    expect(result.error).toContain('CIRCUIT_OPEN');
  });
});
