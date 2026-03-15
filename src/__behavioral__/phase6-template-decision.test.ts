/**
 * Phase 6D RED Tests: Template Format Decision (Task 6.7)
 *
 * SPEC says .md template files, but code uses inline functions (testable, typed).
 * Decision per SPEC Amendment A5: keep inline functions.
 *
 * This test validates the decision is documented and no stale template
 * directory exists.
 *
 * These tests MUST FAIL until 6D GREEN implements the cleanup.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

describe('Phase 6D: Template Format Decision', () => {
  const projectRoot = join(import.meta.dirname, '..', '..');

  it('[MUST-PASS-AT-PHASE-6] templates.ts should document Amendment A5 decision', () => {
    const content = readFileSync(join(projectRoot, 'src', 'templates.ts'), 'utf-8');

    // The file should contain a comment explaining the decision
    expect(content).toContain('Amendment A5');
    expect(content).toContain('inline');
  });

  it('[MUST-PASS-AT-PHASE-6] templates/ directory should not exist', () => {
    // Empty templates/ dir is stale artifact — should be removed
    const templatesDir = join(projectRoot, 'templates');
    expect(existsSync(templatesDir)).toBe(false);
  });
});
