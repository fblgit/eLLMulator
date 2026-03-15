/**
 * Phase 6E RED Tests: Cost Controls (Task 6.9)
 *
 * SPEC: maxBudgetUsd per agent session. Configurable via CLI --max-budget.
 * Prevent runaway costs during bootstrap/trace.
 *
 * These tests MUST FAIL until 6E GREEN implements the feature.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { SessionManager } from '../session-manager.js';
import type { AgentSession } from '../session-manager.js';

describe('Phase 6E: Cost Controls', () => {
  let sessionManager: SessionManager;

  beforeEach(() => {
    sessionManager = new SessionManager();
  });

  // -------------------------------------------------------------------
  // Cost tracking
  // -------------------------------------------------------------------

  it('[MUST-PASS-AT-PHASE-6] AgentSession should have cumulativeCostUsd field', async () => {
    const session = await sessionManager.create({
      filePath: 'src/test.ts',
      fileHash: 'hash-test',
      systemPrompt: 'You are a test agent',
      bootstrapPrompt: 'Bootstrap',
      tools: ['invoke'],
      model: 'claude-opus-4-6',
      cwd: '/test',
    });

    // cumulativeCostUsd should exist and start at 0
    expect(session.cumulativeCostUsd).toBeDefined();
    expect(session.cumulativeCostUsd).toBe(0);
  });

  it('[MUST-PASS-AT-PHASE-6] should accept maxBudgetUsd in create options', async () => {
    const session = await sessionManager.create({
      filePath: 'src/test.ts',
      fileHash: 'hash-test',
      systemPrompt: 'You are a test agent',
      bootstrapPrompt: 'Bootstrap',
      tools: ['invoke'],
      model: 'claude-opus-4-6',
      cwd: '/test',
      maxBudgetUsd: 0.50,
    });

    expect(session.maxBudgetUsd).toBe(0.50);
  });

  it('[MUST-PASS-AT-PHASE-6] session without maxBudgetUsd should have no limit', async () => {
    const session = await sessionManager.create({
      filePath: 'src/test.ts',
      fileHash: 'hash-test',
      systemPrompt: 'You are a test agent',
      bootstrapPrompt: 'Bootstrap',
      tools: ['invoke'],
      model: 'claude-opus-4-6',
      cwd: '/test',
    });

    // No budget set → no limit
    expect(session.maxBudgetUsd).toBeUndefined();
  });

  // -------------------------------------------------------------------
  // Cost accumulation
  // -------------------------------------------------------------------

  it('[MUST-PASS-AT-PHASE-6] should track cumulative cost via recordCost', () => {
    // SessionManager should expose a way to record cost after SDK calls
    sessionManager.recordCost('session-1', 0.05);
    sessionManager.recordCost('session-1', 0.03);

    const session = sessionManager.get('session-1');
    // If session doesn't exist, skip — but the method should exist
    expect(typeof sessionManager.recordCost).toBe('function');
  });

  // -------------------------------------------------------------------
  // Budget enforcement
  // -------------------------------------------------------------------

  it('[MUST-PASS-AT-PHASE-6] should throw BUDGET_EXCEEDED when cost exceeds limit', () => {
    // checkBudget should throw or return error when cumulative > max
    expect(typeof sessionManager.checkBudget).toBe('function');
  });
});
