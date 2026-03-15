/**
 * RED-4A: Starmap Behavioral Tests
 *
 * These tests define the behavioral contract for src/starmap.ts — a module
 * that DOES NOT EXIST YET. They will fail at import time until GREEN
 * implementation creates it.
 *
 * Starmap builds a dependency DAG from registry declarations, computes
 * connected-component clusters, and provides queryable graph operations.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Registry } from '../../registry.js';
import type { RegistryEntry } from '../../registry.js';
import type { Declarations, Declaration, DependencyRef } from '../../types.js';

// This import WILL FAIL until starmap.ts is created by GREEN implementation
import { createStarmap } from '../../starmap.js';
import type { Starmap } from '../../starmap.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeDeclarations(deps: string[], summary = 'test file'): Declarations {
  return {
    summary,
    owns: [],
    imports: [],
    exports: [],
    dependencies: deps,
  };
}

function makeEntry(filePath: string, deps: string[] = []): RegistryEntry {
  return {
    file_path: filePath,
    file_hash: 'hash-' + filePath,
    status: 'ready',
    session_id: 'session-' + filePath,
    declarations: makeDeclarations(deps),
    last_active: new Date(),
    error: null,
  };
}

function makeEntryNoDeclrations(filePath: string): RegistryEntry {
  return {
    file_path: filePath,
    file_hash: 'hash-' + filePath,
    status: 'cold',
    session_id: null,
    declarations: null,
    last_active: null,
    error: null,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SPEC §4.6: Starmap generation', () => {
  let registry: Registry;

  beforeEach(() => {
    registry = new Registry();
  });

  it('SPEC: DAG from declarations — getDependencies follows declaration dependencies', () => {
    // A→B→C chain
    registry.add(makeEntry('A.ts', ['B.ts']));
    registry.add(makeEntry('B.ts', ['C.ts']));
    registry.add(makeEntry('C.ts', []));

    const starmap = createStarmap(registry);

    expect(starmap.getDependencies('A.ts')).toEqual(['B.ts']);
    expect(starmap.getDependencies('B.ts')).toEqual(['C.ts']);
    expect(starmap.getDependencies('C.ts')).toEqual([]);
  });

  it('SPEC: Reverse lookup — getDependents returns files that depend on target', () => {
    // A→B, A→C, D→B
    registry.add(makeEntry('A.ts', ['B.ts', 'C.ts']));
    registry.add(makeEntry('B.ts', []));
    registry.add(makeEntry('C.ts', []));
    registry.add(makeEntry('D.ts', ['B.ts']));

    const starmap = createStarmap(registry);

    const dependents = starmap.getDependents('B.ts');
    expect(dependents).toHaveLength(2);
    expect(dependents).toContain('A.ts');
    expect(dependents).toContain('D.ts');
  });

  it('SPEC: Connected-components clustering — mutual deps form clusters', () => {
    // A↔B (mutual), C↔D (mutual), E→A
    registry.add(makeEntry('A.ts', ['B.ts']));
    registry.add(makeEntry('B.ts', ['A.ts']));
    registry.add(makeEntry('C.ts', ['D.ts']));
    registry.add(makeEntry('D.ts', ['C.ts']));
    registry.add(makeEntry('E.ts', ['A.ts']));

    const starmap = createStarmap(registry);
    const clusters = starmap.getClusters();

    // Two clusters: {A,B,E} and {C,D}
    expect(clusters).toHaveLength(2);

    // Find which cluster has A
    const clusterWithA = clusters.find((c) => c.includes('A.ts'));
    expect(clusterWithA).toBeDefined();
    expect(clusterWithA).toContain('A.ts');
    expect(clusterWithA).toContain('B.ts');
    expect(clusterWithA).toContain('E.ts');

    // Find which cluster has C
    const clusterWithC = clusters.find((c) => c.includes('C.ts'));
    expect(clusterWithC).toBeDefined();
    expect(clusterWithC).toContain('C.ts');
    expect(clusterWithC).toContain('D.ts');
  });

  it('SPEC: Cross-boundary edges — edges between different clusters', () => {
    // Cluster 1: A↔B, Cluster 2: C↔D, Cross: B→C
    registry.add(makeEntry('A.ts', ['B.ts']));
    registry.add(makeEntry('B.ts', ['A.ts', 'C.ts']));
    registry.add(makeEntry('C.ts', ['D.ts']));
    registry.add(makeEntry('D.ts', ['C.ts']));

    const starmap = createStarmap(registry);
    const crossEdges = starmap.getCrossBoundaryEdges();

    // B→C crosses cluster boundary
    expect(crossEdges).toEqual(
      expect.arrayContaining([expect.objectContaining({ from: 'B.ts', to: 'C.ts' })]),
    );
  });

  it('SPEC: --groups override — manual groupConfig overrides computed clustering', () => {
    // Dependencies: A→B, C→D (would compute 2 clusters)
    registry.add(makeEntry('A.ts', ['B.ts']));
    registry.add(makeEntry('B.ts', []));
    registry.add(makeEntry('C.ts', ['D.ts']));
    registry.add(makeEntry('D.ts', []));

    // Override: put all in one group
    const groupConfig = {
      group1: ['A.ts', 'B.ts', 'C.ts', 'D.ts'],
    };

    const starmap = createStarmap(registry, { groupConfig });
    const clusters = starmap.getClusters();

    expect(clusters).toHaveLength(1);
    expect(clusters[0]).toHaveLength(4);
  });

  it('SPEC: Empty registry — all queries return empty', () => {
    const starmap = createStarmap(registry);

    expect(starmap.getDependencies('A.ts')).toEqual([]);
    expect(starmap.getDependents('A.ts')).toEqual([]);
    expect(starmap.getCluster('A.ts')).toEqual([]);
    expect(starmap.getCrossBoundaryEdges()).toEqual([]);
    expect(starmap.getClusters()).toEqual([]);
  });

  it('SPEC: Isolated files — files with no deps form singleton clusters', () => {
    registry.add(makeEntry('lonely.ts', []));
    registry.add(makeEntry('also-lonely.ts', []));

    const starmap = createStarmap(registry);
    const clusters = starmap.getClusters();

    // Each isolated file is its own cluster
    expect(clusters).toHaveLength(2);
    expect(clusters).toEqual(
      expect.arrayContaining([['lonely.ts'], ['also-lonely.ts']]),
    );
  });

  it('SPEC: Queryable artifact — starmap is serializable to JSON', () => {
    registry.add(makeEntry('A.ts', ['B.ts']));
    registry.add(makeEntry('B.ts', []));

    const starmap = createStarmap(registry);

    // toJSON should return a serializable representation
    const serialized = starmap.toJSON();
    expect(() => JSON.stringify(serialized)).not.toThrow();

    // Roundtrip: should contain dependency and cluster info
    const parsed = JSON.parse(JSON.stringify(serialized));
    expect(parsed).toHaveProperty('dependencies');
    expect(parsed).toHaveProperty('clusters');
  });

  it('SPEC: Declaration-based — files without declarations have no outgoing edges', () => {
    // A has declarations with deps, B has no declarations (cold, not yet registered)
    registry.add(makeEntry('A.ts', ['B.ts']));
    registry.add(makeEntryNoDeclrations('B.ts'));

    const starmap = createStarmap(registry);

    // A depends on B (via its declarations)
    expect(starmap.getDependencies('A.ts')).toEqual(['B.ts']);

    // B has no declarations → no outgoing edges
    expect(starmap.getDependencies('B.ts')).toEqual([]);

    // But B still appears in the graph (it's in the registry)
    const allClusters = starmap.getClusters();
    const allFiles = allClusters.flat();
    expect(allFiles).toContain('B.ts');
  });
});
