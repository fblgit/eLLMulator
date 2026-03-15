/**
 * Phase 6C RED Tests: Per-Group Agent Strategy (Task 6.5)
 *
 * SPEC: Alternative to per_file — group files by dependency clustering.
 * Starmap DAG → module boundaries → one agent per group.
 * POC proved agents handle 10-16 files / 5.5K lines effectively.
 *
 * Key challenge: chicken-and-egg — starmap needs declarations.dependencies
 * which come from bootstrap. Solution: lightweight import extraction
 * from raw source content (pre-bootstrap).
 *
 * These tests MUST FAIL until 6C GREEN implements the feature.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { extractImports } from '../scanner.js';
import { createStarmap } from '../starmap.js';
import { Registry } from '../registry.js';

describe('Phase 6C: Per-Group Agent Strategy', () => {

  // -------------------------------------------------------------------
  // 6C.1: Lightweight import extraction (scanner.ts)
  // -------------------------------------------------------------------

  describe('[MUST-PASS-AT-PHASE-6] extractImports — pre-bootstrap dependency edges', () => {
    it('should extract TypeScript/ES6 imports', () => {
      const content = `
import { foo } from './utils';
import { bar } from '../lib/helpers';
import type { Baz } from './types';
export { qux } from './re-export';
`;
      const deps = extractImports(content, 'src/main.ts');

      expect(deps).toContain('src/utils');
      expect(deps).toContain('lib/helpers');
      expect(deps).toContain('src/types');
      expect(deps).toContain('src/re-export');
    });

    it('should extract CommonJS require calls', () => {
      const content = `
const fs = require('fs');
const { helper } = require('./helper');
const config = require('../config');
`;
      const deps = extractImports(content, 'src/main.ts');

      // Should include relative requires, exclude node builtins
      expect(deps).toContain('src/helper');
      expect(deps).toContain('config');
      expect(deps).not.toContain('fs');
    });

    it('should resolve relative paths against file location', () => {
      const content = `import { db } from '../db/connection';`;
      const deps = extractImports(content, 'src/api/handler.ts');

      // ../db/connection relative to src/api/ → src/db/connection
      expect(deps).toContain('src/db/connection');
    });

    it('should return empty array for files with no imports', () => {
      const content = `export const PI = 3.14159;`;
      const deps = extractImports(content, 'src/constants.ts');
      expect(deps).toEqual([]);
    });

    it('should ignore package imports (non-relative)', () => {
      const content = `
import express from 'express';
import { z } from 'zod';
import { helper } from './helper';
`;
      const deps = extractImports(content, 'src/main.ts');

      expect(deps).not.toContain('express');
      expect(deps).not.toContain('zod');
      expect(deps).toContain('src/helper');
    });
  });

  // -------------------------------------------------------------------
  // 6C.2: Pre-bootstrap starmap (starmap.ts)
  // -------------------------------------------------------------------

  describe('[MUST-PASS-AT-PHASE-6] createStarmap from raw dependency edges', () => {
    it('should accept rawEdges option for pre-bootstrap clustering', () => {
      // rawEdges: file → dependencies (from extractImports)
      const rawEdges: Record<string, string[]> = {
        'src/api.ts': ['src/db.ts', 'src/utils.ts'],
        'src/db.ts': ['src/utils.ts'],
        'src/utils.ts': [],
        'src/auth.ts': ['src/db.ts'],
      };

      const starmap = createStarmap(new Registry(), { rawEdges });

      // Should produce valid clusters
      expect(starmap.clusters().length).toBeGreaterThan(0);
      // Every file should be in some cluster
      const allFiles = starmap.clusters().flat();
      expect(allFiles).toContain('src/api.ts');
      expect(allFiles).toContain('src/db.ts');
    });
  });

  // -------------------------------------------------------------------
  // 6C.3: Group-aware registry (registry.ts)
  // -------------------------------------------------------------------

  describe('[MUST-PASS-AT-PHASE-6] Registry group support', () => {
    let registry: Registry;

    beforeEach(() => {
      registry = new Registry();
    });

    it('should support group_id on registry entries', () => {
      registry.add({
        file_path: 'src/api.ts',
        file_hash: 'hash-api',
        status: 'cold',
        group_id: 'group-api',
      });

      const entry = registry.get('src/api.ts');
      expect(entry?.group_id).toBe('group-api');
    });

    it('should find all files in a group via getGroup', () => {
      registry.add({ file_path: 'src/api.ts', file_hash: 'h1', status: 'cold', group_id: 'backend' });
      registry.add({ file_path: 'src/db.ts', file_hash: 'h2', status: 'cold', group_id: 'backend' });
      registry.add({ file_path: 'src/auth.ts', file_hash: 'h3', status: 'cold', group_id: 'auth' });

      const backendGroup = registry.getGroup('backend');
      expect(backendGroup.length).toBe(2);
      expect(backendGroup.map(e => e.file_path).sort()).toEqual(['src/api.ts', 'src/db.ts']);
    });

    it('should share session_id across group members', () => {
      registry.add({ file_path: 'src/api.ts', file_hash: 'h1', status: 'ready', group_id: 'backend', session_id: 'session-backend' });
      registry.add({ file_path: 'src/db.ts', file_hash: 'h2', status: 'ready', group_id: 'backend', session_id: 'session-backend' });

      const api = registry.get('src/api.ts');
      const db = registry.get('src/db.ts');
      expect(api?.session_id).toBe('session-backend');
      expect(db?.session_id).toBe('session-backend');
    });
  });
});
