/**
 * RED Phase Tests — FR-008: Guardrails
 *
 * Pure validation functions. No side effects. Called by invoke handler.
 *
 * SPEC contracts tested:
 *   - cycle_detection: target in call_stack -> CYCLE_DETECTED
 *   - depth_limit: call_stack.length >= max_depth -> MAX_DEPTH_EXCEEDED (default 50)
 *   - rate_limit: max 5 invocations per agent per task -> RATE_LIMITED
 *   - envelope_validation: ResponseEnvelope schema check, source_refs non-empty
 *   - self_loop_prevention: max 3 visits per target per trace -> LOOP_SUSPECTED
 *
 * All tests MUST fail — guardrails.ts does not exist yet.
 */

import { describe, it, expect } from 'vitest';
import {
  checkCycle,
  checkDepth,
  checkRateLimit,
  validateResponseEnvelope,
  checkSelfLoop,
  RateLimitTracker,
  SelfLoopTracker,
} from './guardrails.js';

// ===========================================================================
// 1. checkCycle — call_stack inspection for circular invocations
// ===========================================================================

describe('checkCycle', () => {
  it('returns ok:true when target is NOT in call_stack', () => {
    const result = checkCycle('src/handler.ts', ['src/server.ts', 'src/router.ts']);
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('returns ok:false with CYCLE_DETECTED when target IS in call_stack', () => {
    const callStack = ['src/server.ts', 'src/router.ts', 'src/handler.ts'];
    const result = checkCycle('src/router.ts', callStack);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('CYCLE_DETECTED');
  });
});

// ===========================================================================
// 2. checkDepth — configurable depth limit (default 50)
// ===========================================================================

describe('checkDepth', () => {
  it('returns ok:true when call_stack.length < maxDepth', () => {
    const callStack = ['a.ts', 'b.ts', 'c.ts'];
    const result = checkDepth(callStack, 10);
    expect(result.ok).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('returns ok:false with MAX_DEPTH_EXCEEDED when call_stack.length >= maxDepth', () => {
    const callStack = Array.from({ length: 10 }, (_, i) => `file_${i}.ts`);
    const result = checkDepth(callStack, 10);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('MAX_DEPTH_EXCEEDED');
  });

  it('uses default maxDepth of 50 when not specified', () => {
    // Under the limit: 49 entries, should pass
    const shortStack = Array.from({ length: 49 }, (_, i) => `file_${i}.ts`);
    const okResult = checkDepth(shortStack);
    expect(okResult.ok).toBe(true);

    // At the limit: 50 entries, should fail
    const fullStack = Array.from({ length: 50 }, (_, i) => `file_${i}.ts`);
    const failResult = checkDepth(fullStack);
    expect(failResult.ok).toBe(false);
    expect(failResult.error).toBe('MAX_DEPTH_EXCEEDED');
  });
});

// ===========================================================================
// 3. checkRateLimit — max 5 invocations per agent per task
// ===========================================================================

describe('checkRateLimit', () => {
  it('returns ok:true for first 5 invocations of the same agent+task', () => {
    const tracker = new RateLimitTracker();

    for (let i = 0; i < 5; i++) {
      const result = checkRateLimit('src/handler.ts', 'task-001', tracker);
      expect(result.ok).toBe(true);
      expect(result.error).toBeUndefined();
    }
  });

  it('returns ok:false with RATE_LIMITED on the 6th invocation', () => {
    const tracker = new RateLimitTracker();

    // Exhaust the 5 allowed invocations
    for (let i = 0; i < 5; i++) {
      checkRateLimit('src/handler.ts', 'task-001', tracker);
    }

    // 6th invocation should be rejected
    const result = checkRateLimit('src/handler.ts', 'task-001', tracker);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('RATE_LIMITED');
  });

  it('tracks per agent AND per task — different tasks have separate counts', () => {
    const tracker = new RateLimitTracker();

    // Exhaust limit for task-001
    for (let i = 0; i < 5; i++) {
      checkRateLimit('src/handler.ts', 'task-001', tracker);
    }

    // Same agent, different task: should still be allowed
    const result = checkRateLimit('src/handler.ts', 'task-002', tracker);
    expect(result.ok).toBe(true);
  });
});

// ===========================================================================
// 4. validateResponseEnvelope — schema validation for ResponseEnvelope
// ===========================================================================

describe('validateResponseEnvelope', () => {
  it('returns valid:true for a correct envelope', () => {
    const envelope = {
      task_id: 'task-001',
      responder: 'src/handler.ts',
      returns: { success: true },
      mutations: [],
      source_refs: ['src/handler.ts:12-18'],
      error: null,
    };

    const result = validateResponseEnvelope(envelope);
    expect(result.valid).toBe(true);
    expect(result.errors).toHaveLength(0);
  });

  it('returns valid:false when source_refs is empty', () => {
    const envelope = {
      task_id: 'task-001',
      responder: 'src/handler.ts',
      returns: { success: true },
      source_refs: [],
    };

    const result = validateResponseEnvelope(envelope);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e: string) => e.toLowerCase().includes('source_refs'))).toBe(true);
  });

  it('returns valid:false when task_id is missing', () => {
    const envelope = {
      responder: 'src/handler.ts',
      returns: null,
      source_refs: ['src/handler.ts:1-5'],
    };

    const result = validateResponseEnvelope(envelope);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e: string) => e.toLowerCase().includes('task_id'))).toBe(true);
  });

  it('returns valid:false when responder is missing', () => {
    const envelope = {
      task_id: 'task-001',
      returns: null,
      source_refs: ['src/handler.ts:1-5'],
    };

    const result = validateResponseEnvelope(envelope);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
    expect(result.errors.some((e: string) => e.toLowerCase().includes('responder'))).toBe(true);
  });
});

// ===========================================================================
// 5. checkSelfLoop — max 3 visits per target per trace
// ===========================================================================

describe('checkSelfLoop', () => {
  it('returns ok:true for first 3 visits to the same target in a trace', () => {
    const tracker = new SelfLoopTracker();

    for (let i = 0; i < 3; i++) {
      const result = checkSelfLoop('src/handler.ts', 'trace-001', tracker);
      expect(result.ok).toBe(true);
      expect(result.error).toBeUndefined();
    }
  });

  it('returns ok:false with LOOP_SUSPECTED on the 4th visit', () => {
    const tracker = new SelfLoopTracker();

    // Exhaust the 3 allowed visits
    for (let i = 0; i < 3; i++) {
      checkSelfLoop('src/handler.ts', 'trace-001', tracker);
    }

    // 4th visit should be rejected
    const result = checkSelfLoop('src/handler.ts', 'trace-001', tracker);
    expect(result.ok).toBe(false);
    expect(result.error).toBe('LOOP_SUSPECTED');
  });

  it('tracks per target AND per trace — different traces have separate counts', () => {
    const tracker = new SelfLoopTracker();

    // Exhaust limit for trace-001
    for (let i = 0; i < 3; i++) {
      checkSelfLoop('src/handler.ts', 'trace-001', tracker);
    }

    // Same target, different trace: should still be allowed
    const result = checkSelfLoop('src/handler.ts', 'trace-002', tracker);
    expect(result.ok).toBe(true);
  });
});
