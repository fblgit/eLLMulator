/**
 * RED-4D: Boundary Awareness Behavioral Tests
 *
 * Tests that renderSystemPrompt() can include boundary awareness guidance
 * when starmap data is provided, telling agents which files to invoke()
 * vs trace directly based on cluster membership.
 */

import { describe, it, expect } from 'vitest';
import { renderSystemPrompt } from '../../templates.js';

// ---------------------------------------------------------------------------
// Types for boundary data (expected to be accepted by renderSystemPrompt)
// ---------------------------------------------------------------------------

type BoundaryInfo = {
  /** Files in the same cluster — trace directly, don't invoke */
  sameCluster: string[];
  /** Files in other clusters — use invoke() for cross-boundary calls */
  crossBoundary: string[];
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SPEC §4.9: Boundary awareness in system prompts', () => {
  it('SPEC: system prompt includes boundary guidance when starmap data provided', () => {
    const output = renderSystemPrompt({
      filePath: 'handler.ts',
      sourceCode: 'export function handleRequest() {}',
      // Phase 4 GREEN must add boundary support to renderSystemPrompt
      boundaryInfo: {
        sameCluster: ['service.ts'],
        crossBoundary: ['external-api.ts'],
      },
    } as any); // Cast to any because boundaryInfo doesn't exist yet in the type

    // Should contain boundary guidance section
    expect(output).toMatch(/boundary|cluster|routing/i);

    // Should mention which files are in the same cluster
    expect(output).toContain('service.ts');

    // Should mention which files require invoke()
    expect(output).toContain('external-api.ts');
  });

  it('SPEC: same-cluster files identified — told to trace directly', () => {
    const output = renderSystemPrompt({
      filePath: 'A.ts',
      sourceCode: 'export class A {}',
      boundaryInfo: {
        sameCluster: ['B.ts', 'C.ts'],
        crossBoundary: [],
      },
    } as any);

    // B.ts and C.ts are in the same cluster — should be identified as local/direct
    expect(output).toContain('B.ts');
    expect(output).toContain('C.ts');

    // Should convey that these are "direct" or "same group" or "local"
    // The exact wording is up to GREEN, but the semantic must be:
    // "B.ts and C.ts are in your group — trace them directly"
    const lowerOutput = output.toLowerCase();
    expect(
      lowerOutput.includes('direct') ||
      lowerOutput.includes('same') ||
      lowerOutput.includes('group') ||
      lowerOutput.includes('local') ||
      lowerOutput.includes('cluster'),
    ).toBe(true);
  });

  it('SPEC: cross-boundary files identified — told to use invoke()', () => {
    const output = renderSystemPrompt({
      filePath: 'A.ts',
      sourceCode: 'export class A {}',
      boundaryInfo: {
        sameCluster: [],
        crossBoundary: ['D.ts'],
      },
    } as any);

    // D.ts is cross-boundary — should instruct to use invoke()
    expect(output).toContain('D.ts');

    const lowerOutput = output.toLowerCase();
    expect(
      lowerOutput.includes('invoke') ||
      lowerOutput.includes('cross') ||
      lowerOutput.includes('boundary') ||
      lowerOutput.includes('external'),
    ).toBe(true);
  });

  it('SPEC: backward compatible without starmap — no boundary section when omitted', () => {
    // renderSystemPrompt with NO boundaryInfo → should work as before
    const output = renderSystemPrompt({
      filePath: 'standalone.ts',
      sourceCode: '',
    });

    // Should still have the core content
    expect(output).toContain('standalone.ts');
    expect(output).toContain('analysis agent');

    // Should NOT contain boundary guidance
    const lowerOutput = output.toLowerCase();
    const hasBoundarySection =
      lowerOutput.includes('boundary') &&
      lowerOutput.includes('cluster');
    expect(hasBoundarySection).toBe(false);
  });

  it('SPEC: prompt includes actual dependency file paths, not abstract IDs', () => {
    const output = renderSystemPrompt({
      filePath: 'controller.ts',
      sourceCode: 'export class Controller {}',
      boundaryInfo: {
        sameCluster: ['src/models/user.ts'],
        crossBoundary: ['src/external/stripe.ts'],
      },
    } as any);

    // Should contain actual file paths
    expect(output).toContain('src/models/user.ts');
    expect(output).toContain('src/external/stripe.ts');

    // Should NOT contain abstract cluster IDs like "cluster-1" or "group-a"
    expect(output).not.toMatch(/cluster-\d/);
    expect(output).not.toMatch(/group-[a-z]/);
  });
});
