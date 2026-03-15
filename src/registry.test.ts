/**
 * RED Phase Tests — FR-001: Registry
 *
 * All tests MUST fail (implementation does not exist yet).
 *
 * SPEC contracts tested:
 *   - RegistryEntry type shape (file_path:str!, session_id:str?, file_hash:str!,
 *     status:enum!, declarations:Declarations?, last_active:timestamp?, error:str?)
 *   - Registry CRUD: add, get, update, remove, list, listByStatus, size
 *   - Status transitions: cold->bootstrapping->ready, ready->stale, any->error
 *   - Hash comparison: file_hash change on ready entry -> stale
 */

import { describe, it, expect } from 'vitest';
import {
  Registry,
  RegistryEntry,
  RegistryStatus,
} from './registry.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEntry(overrides: Partial<RegistryEntry> = {}): RegistryEntry {
  return {
    file_path: 'src/server.ts',
    file_hash: 'abc123def456',
    status: 'cold' as RegistryStatus,
    session_id: null,
    declarations: null,
    last_active: null,
    error: null,
    ...overrides,
  };
}

// ===========================================================================
// 1. RegistryEntry type has all required and optional fields
// ===========================================================================

describe('RegistryEntry type', () => {
  it('has required fields: file_path, file_hash, status', () => {
    const entry = makeEntry();
    expect(entry.file_path).toBe('src/server.ts');
    expect(entry.file_hash).toBe('abc123def456');
    expect(entry.status).toBe('cold');
  });

  it('has optional fields defaulting to null: session_id, declarations, last_active, error', () => {
    const entry = makeEntry();
    expect(entry.session_id).toBeNull();
    expect(entry.declarations).toBeNull();
    expect(entry.last_active).toBeNull();
    expect(entry.error).toBeNull();
  });

  it('status must be one of the five valid values', () => {
    const validStatuses: RegistryStatus[] = [
      'cold',
      'bootstrapping',
      'ready',
      'stale',
      'error',
    ];
    for (const s of validStatuses) {
      const entry = makeEntry({ status: s });
      expect(entry.status).toBe(s);
    }
  });
});

// ===========================================================================
// 2. Registry.add() adds an entry, retrievable by file_path
// ===========================================================================

describe('Registry.add()', () => {
  it('adds an entry and makes it retrievable by file_path', () => {
    const registry = new Registry();
    const entry = makeEntry();
    registry.add(entry);
    const retrieved = registry.get('src/server.ts');
    expect(retrieved).toBeDefined();
    expect(retrieved!.file_path).toBe('src/server.ts');
    expect(retrieved!.file_hash).toBe('abc123def456');
    expect(retrieved!.status).toBe('cold');
  });

  it('throws or rejects if adding a duplicate file_path', () => {
    const registry = new Registry();
    const entry = makeEntry();
    registry.add(entry);
    expect(() => registry.add(entry)).toThrow();
  });
});

// ===========================================================================
// 3. Registry.get() returns undefined for unknown paths
// ===========================================================================

describe('Registry.get()', () => {
  it('returns undefined for a path that was never added', () => {
    const registry = new Registry();
    const result = registry.get('nonexistent/path.ts');
    expect(result).toBeUndefined();
  });

  it('returns the correct entry when multiple entries exist', () => {
    const registry = new Registry();
    registry.add(makeEntry({ file_path: 'a.ts', file_hash: 'hash_a' }));
    registry.add(makeEntry({ file_path: 'b.ts', file_hash: 'hash_b' }));
    const a = registry.get('a.ts');
    const b = registry.get('b.ts');
    expect(a!.file_hash).toBe('hash_a');
    expect(b!.file_hash).toBe('hash_b');
  });
});

// ===========================================================================
// 4. Registry.update() changes entry fields
// ===========================================================================

describe('Registry.update()', () => {
  it('updates session_id on an existing entry', () => {
    const registry = new Registry();
    registry.add(makeEntry());
    registry.update('src/server.ts', { session_id: 'sess-001' });
    const entry = registry.get('src/server.ts');
    expect(entry!.session_id).toBe('sess-001');
  });

  it('updates status on an existing entry', () => {
    const registry = new Registry();
    registry.add(makeEntry());
    registry.update('src/server.ts', { status: 'bootstrapping' });
    const entry = registry.get('src/server.ts');
    expect(entry!.status).toBe('bootstrapping');
  });

  it('updates declarations on an existing entry', () => {
    const registry = new Registry();
    registry.add(makeEntry());
    const decls = {
      summary: 'Main server entry point',
      owns: [],
      imports: [],
      exports: [],
      dependencies: [],
    };
    registry.update('src/server.ts', { declarations: decls });
    const entry = registry.get('src/server.ts');
    expect(entry!.declarations).toEqual(decls);
  });

  it('throws or returns error when updating a nonexistent path', () => {
    const registry = new Registry();
    expect(() =>
      registry.update('nonexistent.ts', { status: 'ready' }),
    ).toThrow();
  });

  it('preserves fields not included in the update', () => {
    const registry = new Registry();
    registry.add(makeEntry({ session_id: 'original-session' }));
    registry.update('src/server.ts', { status: 'bootstrapping' });
    const entry = registry.get('src/server.ts');
    expect(entry!.session_id).toBe('original-session');
    expect(entry!.file_hash).toBe('abc123def456');
  });
});

// ===========================================================================
// 5. Registry.remove() deletes an entry
// ===========================================================================

describe('Registry.remove()', () => {
  it('removes an existing entry so get() returns undefined', () => {
    const registry = new Registry();
    registry.add(makeEntry());
    registry.remove('src/server.ts');
    expect(registry.get('src/server.ts')).toBeUndefined();
  });

  it('is a no-op or throws when removing a nonexistent path', () => {
    const registry = new Registry();
    // Should not throw (idempotent remove) or should throw — either is valid
    // We test that the registry remains empty
    registry.remove('nonexistent.ts');
    expect(registry.size).toBe(0);
  });
});

// ===========================================================================
// 6. Registry.list() returns all entries
// ===========================================================================

describe('Registry.list()', () => {
  it('returns an empty array when registry is empty', () => {
    const registry = new Registry();
    expect(registry.list()).toEqual([]);
  });

  it('returns all added entries', () => {
    const registry = new Registry();
    registry.add(makeEntry({ file_path: 'a.ts' }));
    registry.add(makeEntry({ file_path: 'b.ts' }));
    registry.add(makeEntry({ file_path: 'c.ts' }));
    const all = registry.list();
    expect(all).toHaveLength(3);
    const paths = all.map((e) => e.file_path).sort();
    expect(paths).toEqual(['a.ts', 'b.ts', 'c.ts']);
  });
});

// ===========================================================================
// 7. Registry.listByStatus() filters entries by status
// ===========================================================================

describe('Registry.listByStatus()', () => {
  it('returns only entries matching the given status', () => {
    const registry = new Registry();
    registry.add(makeEntry({ file_path: 'a.ts', status: 'cold' }));
    registry.add(makeEntry({ file_path: 'b.ts', status: 'ready' }));
    registry.add(makeEntry({ file_path: 'c.ts', status: 'cold' }));
    registry.add(makeEntry({ file_path: 'd.ts', status: 'error' }));

    const cold = registry.listByStatus('cold');
    expect(cold).toHaveLength(2);
    expect(cold.map((e) => e.file_path).sort()).toEqual(['a.ts', 'c.ts']);

    const ready = registry.listByStatus('ready');
    expect(ready).toHaveLength(1);
    expect(ready[0].file_path).toBe('b.ts');
  });

  it('returns empty array when no entries match status', () => {
    const registry = new Registry();
    registry.add(makeEntry({ file_path: 'a.ts', status: 'cold' }));
    expect(registry.listByStatus('error')).toEqual([]);
  });
});

// ===========================================================================
// 8. Status transitions
// ===========================================================================

describe('Status transitions', () => {
  it('allows cold -> bootstrapping', () => {
    const registry = new Registry();
    registry.add(makeEntry({ status: 'cold' }));
    registry.update('src/server.ts', { status: 'bootstrapping' });
    expect(registry.get('src/server.ts')!.status).toBe('bootstrapping');
  });

  it('allows bootstrapping -> ready', () => {
    const registry = new Registry();
    registry.add(makeEntry({ status: 'bootstrapping' }));
    registry.update('src/server.ts', { status: 'ready' });
    expect(registry.get('src/server.ts')!.status).toBe('ready');
  });

  it('allows ready -> stale', () => {
    const registry = new Registry();
    registry.add(makeEntry({ status: 'ready' }));
    registry.update('src/server.ts', { status: 'stale' });
    expect(registry.get('src/server.ts')!.status).toBe('stale');
  });

  it('allows any status -> error', () => {
    const statuses: RegistryStatus[] = [
      'cold',
      'bootstrapping',
      'ready',
      'stale',
    ];
    for (const fromStatus of statuses) {
      const registry = new Registry();
      const path = `file_${fromStatus}.ts`;
      registry.add(makeEntry({ file_path: path, status: fromStatus }));
      registry.update(path, { status: 'error', error: 'something failed' });
      expect(registry.get(path)!.status).toBe('error');
      expect(registry.get(path)!.error).toBe('something failed');
    }
  });

  it('rejects invalid transitions (e.g. ready -> cold)', () => {
    const registry = new Registry();
    registry.add(makeEntry({ status: 'ready' }));
    expect(() =>
      registry.update('src/server.ts', { status: 'cold' }),
    ).toThrow();
  });

  it('rejects invalid transitions (e.g. cold -> ready, skipping bootstrapping)', () => {
    const registry = new Registry();
    registry.add(makeEntry({ status: 'cold' }));
    expect(() =>
      registry.update('src/server.ts', { status: 'ready' }),
    ).toThrow();
  });
});

// ===========================================================================
// 9. Hash comparison: updating file_hash marks ready entry as stale
// ===========================================================================

describe('Hash comparison and staleness', () => {
  it('marks a ready entry as stale when file_hash changes', () => {
    const registry = new Registry();
    registry.add(makeEntry({ status: 'ready', file_hash: 'original_hash' }));
    registry.update('src/server.ts', { file_hash: 'changed_hash' });
    const entry = registry.get('src/server.ts');
    expect(entry!.status).toBe('stale');
    expect(entry!.file_hash).toBe('changed_hash');
  });

  it('does not change status when hash is updated on a cold entry', () => {
    const registry = new Registry();
    registry.add(makeEntry({ status: 'cold', file_hash: 'original_hash' }));
    registry.update('src/server.ts', { file_hash: 'changed_hash' });
    const entry = registry.get('src/server.ts');
    expect(entry!.status).toBe('cold');
    expect(entry!.file_hash).toBe('changed_hash');
  });

  it('clears declarations when hash changes on a ready entry (SPEC: consolidate clears declarations on stale)', () => {
    const registry = new Registry();
    registry.add(
      makeEntry({
        status: 'ready',
        file_hash: 'original_hash',
        declarations: {
          summary: 'test',
          owns: [],
          imports: [],
          exports: [],
          dependencies: [],
        },
      }),
    );
    registry.update('src/server.ts', { file_hash: 'changed_hash' });
    const entry = registry.get('src/server.ts');
    expect(entry!.declarations).toBeNull();
  });

  it('clears session_id when hash changes on a ready entry (SPEC: consolidate clears session on stale)', () => {
    const registry = new Registry();
    registry.add(
      makeEntry({
        status: 'ready',
        file_hash: 'original_hash',
        session_id: 'sess-active',
      }),
    );
    registry.update('src/server.ts', { file_hash: 'changed_hash' });
    const entry = registry.get('src/server.ts');
    expect(entry!.session_id).toBeNull();
  });
});

// ===========================================================================
// 10. Registry.size returns count of entries
// ===========================================================================

describe('Registry.size', () => {
  it('returns 0 for an empty registry', () => {
    const registry = new Registry();
    expect(registry.size).toBe(0);
  });

  it('returns correct count after adding entries', () => {
    const registry = new Registry();
    registry.add(makeEntry({ file_path: 'a.ts' }));
    registry.add(makeEntry({ file_path: 'b.ts' }));
    expect(registry.size).toBe(2);
  });

  it('decrements after removing an entry', () => {
    const registry = new Registry();
    registry.add(makeEntry({ file_path: 'a.ts' }));
    registry.add(makeEntry({ file_path: 'b.ts' }));
    registry.remove('a.ts');
    expect(registry.size).toBe(1);
  });
});
