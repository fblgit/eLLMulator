/**
 * Starmap — Dependency DAG from registry declarations.
 *
 * Builds a directed graph from declarations.dependencies, computes clusters
 * via strongly-connected-components + singleton absorption, detects
 * cross-boundary edges, and exposes queryable graph operations.
 *
 * Clustering algorithm:
 *   1. Compute SCCs (Tarjan's) — mutual dependency groups
 *   2. In the condensation DAG, absorb singleton SCCs into their targets
 *      via union-find (directed edge from singleton → merge into target)
 *   3. Edges between non-singleton SCCs remain as cross-boundary edges
 *
 */

import type { Registry } from './registry.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface Starmap {
  /** Files this file directly depends on (outgoing edges). */
  getDependencies(filePath: string): string[];

  /** Files that directly depend on this file (incoming edges). */
  getDependents(filePath: string): string[];

  /** All files in the same cluster as filePath. */
  getCluster(filePath: string): string[];

  /** Directed edges whose source and target belong to different clusters. */
  getCrossBoundaryEdges(): Array<{ from: string; to: string }>;

  /** All clusters (connected components or overridden groups). */
  getClusters(): string[][];

  /** Alias for getClusters() — convenience accessor. */
  clusters(): string[][];

  /** Serializable representation for persistence / MCP export. */
  toJSON(): StarmapJSON;
}

export interface StarmapOptions {
  /** Manual grouping override — keys are group names, values are file lists. */
  groupConfig?: Record<string, string[]>;
  /** Pre-bootstrap dependency edges (from extractImports). Keys are file paths, values are dependency lists. */
  rawEdges?: Record<string, string[]>;
}

export interface StarmapJSON {
  dependencies: Record<string, string[]>;
  dependents: Record<string, string[]>;
  clusters: string[][];
  crossBoundaryEdges: Array<{ from: string; to: string }>;
}

// ---------------------------------------------------------------------------
// Tarjan's SCC algorithm
// ---------------------------------------------------------------------------

function computeSCCs(
  nodes: Set<string>,
  edges: Map<string, string[]>,
): string[][] {
  let idx = 0;
  const stack: string[] = [];
  const onStack = new Set<string>();
  const indices = new Map<string, number>();
  const lowlinks = new Map<string, number>();
  const sccs: string[][] = [];

  function strongconnect(v: string): void {
    indices.set(v, idx);
    lowlinks.set(v, idx);
    idx++;
    stack.push(v);
    onStack.add(v);

    for (const w of edges.get(v) ?? []) {
      if (!nodes.has(w)) continue; // skip edges to files not in registry
      if (!indices.has(w)) {
        strongconnect(w);
        lowlinks.set(v, Math.min(lowlinks.get(v)!, lowlinks.get(w)!));
      } else if (onStack.has(w)) {
        lowlinks.set(v, Math.min(lowlinks.get(v)!, indices.get(w)!));
      }
    }

    if (lowlinks.get(v) === indices.get(v)) {
      const scc: string[] = [];
      let w: string;
      do {
        w = stack.pop()!;
        onStack.delete(w);
        scc.push(w);
      } while (w !== v);
      sccs.push(scc);
    }
  }

  for (const node of nodes) {
    if (!indices.has(node)) {
      strongconnect(node);
    }
  }

  return sccs;
}

// ---------------------------------------------------------------------------
// Union-Find for merging SCCs in the condensation DAG
// ---------------------------------------------------------------------------

class UnionFind<T> {
  private parent = new Map<T, T>();
  private rank = new Map<T, number>();

  add(x: T): void {
    if (!this.parent.has(x)) {
      this.parent.set(x, x);
      this.rank.set(x, 0);
    }
  }

  find(x: T): T {
    let root = x;
    while (this.parent.get(root) !== root) {
      root = this.parent.get(root)!;
    }
    // Path compression
    let curr = x;
    while (curr !== root) {
      const next = this.parent.get(curr)!;
      this.parent.set(curr, root);
      curr = next;
    }
    return root;
  }

  union(a: T, b: T): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra === rb) return;
    const rankA = this.rank.get(ra)!;
    const rankB = this.rank.get(rb)!;
    if (rankA < rankB) {
      this.parent.set(ra, rb);
    } else if (rankA > rankB) {
      this.parent.set(rb, ra);
    } else {
      this.parent.set(rb, ra);
      this.rank.set(ra, rankA + 1);
    }
  }

  components(): T[][] {
    const groups = new Map<T, T[]>();
    for (const node of this.parent.keys()) {
      const root = this.find(node);
      let group = groups.get(root);
      if (!group) {
        group = [];
        groups.set(root, group);
      }
      group.push(node);
    }
    return Array.from(groups.values());
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createStarmap(
  registry: Registry,
  options?: StarmapOptions,
): Starmap {
  // 1. Build adjacency lists — from rawEdges (pre-bootstrap) or registry declarations
  const forward = new Map<string, string[]>(); // file → its dependencies
  const reverse = new Map<string, string[]>(); // file → files that depend on it
  const allFiles = new Set<string>();

  if (options?.rawEdges) {
    // Pre-bootstrap mode: use raw dependency edges directly
    for (const [filePath, deps] of Object.entries(options.rawEdges)) {
      allFiles.add(filePath);
      forward.set(filePath, [...deps]);

      if (!reverse.has(filePath)) {
        reverse.set(filePath, []);
      }
      for (const dep of deps) {
        allFiles.add(dep);
        if (!reverse.has(dep)) {
          reverse.set(dep, []);
        }
        reverse.get(dep)!.push(filePath);
        // Ensure forward map has an entry for every node
        if (!forward.has(dep)) {
          forward.set(dep, []);
        }
      }
    }
  } else {
    // Normal mode: read from registry declarations
    for (const entry of registry.list()) {
      const filePath = entry.file_path;
      allFiles.add(filePath);

      const deps = entry.declarations?.dependencies ?? [];
      forward.set(filePath, [...deps]);

      if (!reverse.has(filePath)) {
        reverse.set(filePath, []);
      }
      for (const dep of deps) {
        if (!reverse.has(dep)) {
          reverse.set(dep, []);
        }
        reverse.get(dep)!.push(filePath);
      }
    }
  }

  // 2. Compute clusters
  let clusters: string[][];

  if (options?.groupConfig) {
    // Manual override — use provided groups directly
    clusters = Object.values(options.groupConfig);
  } else {
    clusters = computeClusters(allFiles, forward);
  }

  // 3. Build file→cluster index for fast lookup
  const fileToCluster = new Map<string, string[]>();
  for (const cluster of clusters) {
    for (const file of cluster) {
      fileToCluster.set(file, cluster);
    }
  }

  // 4. Compute cross-boundary edges (directed edges between different clusters)
  const crossBoundaryEdges: Array<{ from: string; to: string }> = [];
  for (const [file, deps] of forward) {
    const srcCluster = fileToCluster.get(file);
    for (const dep of deps) {
      const dstCluster = fileToCluster.get(dep);
      if (srcCluster && dstCluster && srcCluster !== dstCluster) {
        crossBoundaryEdges.push({ from: file, to: dep });
      }
    }
  }

  // 5. Return queryable Starmap
  return {
    getDependencies(filePath: string): string[] {
      return forward.get(filePath) ?? [];
    },

    getDependents(filePath: string): string[] {
      return reverse.get(filePath) ?? [];
    },

    getCluster(filePath: string): string[] {
      return fileToCluster.get(filePath) ?? [];
    },

    getCrossBoundaryEdges(): Array<{ from: string; to: string }> {
      return crossBoundaryEdges;
    },

    getClusters(): string[][] {
      return clusters;
    },

    clusters(): string[][] {
      return clusters;
    },

    toJSON(): StarmapJSON {
      const dependencies: Record<string, string[]> = {};
      const dependents: Record<string, string[]> = {};
      for (const file of allFiles) {
        dependencies[file] = forward.get(file) ?? [];
        dependents[file] = reverse.get(file) ?? [];
      }
      return {
        dependencies,
        dependents,
        clusters,
        crossBoundaryEdges,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Cluster computation: SCC + singleton absorption
//
// 1. Compute SCCs via Tarjan's algorithm
// 2. Build condensation DAG (DAG of SCC nodes)
// 3. Singleton SCCs with outgoing edges absorb into their targets via union-find
//    (only singleton → any target merges; non-singleton → non-singleton stays separate)
// 4. Remaining singletons with no edges stay as singleton clusters
// ---------------------------------------------------------------------------

function computeClusters(
  allFiles: Set<string>,
  forward: Map<string, string[]>,
): string[][] {
  if (allFiles.size === 0) return [];

  // Step 1: Compute SCCs
  const sccs = computeSCCs(allFiles, forward);

  // Step 2: Map each file to its SCC index
  const fileToSccIdx = new Map<string, number>();
  for (let i = 0; i < sccs.length; i++) {
    for (const file of sccs[i]) {
      fileToSccIdx.set(file, i);
    }
  }

  // Step 3: Build condensation DAG edges (SCC idx → SCC idx)
  // and identify which SCCs are singletons
  const sccEdges = new Map<number, Set<number>>();
  for (let i = 0; i < sccs.length; i++) {
    sccEdges.set(i, new Set());
  }
  for (const [file, deps] of forward) {
    const srcScc = fileToSccIdx.get(file)!;
    for (const dep of deps) {
      const dstScc = fileToSccIdx.get(dep);
      if (dstScc !== undefined && dstScc !== srcScc) {
        sccEdges.get(srcScc)!.add(dstScc);
      }
    }
  }

  // Step 4: Union-find on SCC indices — merge singletons into their targets
  const uf = new UnionFind<number>();
  for (let i = 0; i < sccs.length; i++) {
    uf.add(i);
  }

  for (let i = 0; i < sccs.length; i++) {
    if (sccs[i].length === 1) {
      // Singleton SCC: absorb into each target SCC
      for (const targetScc of sccEdges.get(i)!) {
        uf.union(i, targetScc);
      }
    }
    // Non-singleton SCCs: do NOT merge across condensation edges
  }

  // Step 5: Build final clusters from union-find groups
  const sccGroups = uf.components(); // groups of SCC indices
  const clusters: string[][] = [];
  for (const group of sccGroups) {
    const cluster: string[] = [];
    for (const sccIdx of group) {
      cluster.push(...sccs[sccIdx]);
    }
    clusters.push(cluster);
  }

  return clusters;
}
