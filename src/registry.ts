/**
 * FR-001: Registry — Minimal GREEN implementation
 *
 * Tracks file entries with status lifecycle and hash-based staleness detection.
 */

import type { Declarations } from './types.js';

export type { Declarations } from './types.js';

export type RegistryStatus = 'cold' | 'bootstrapping' | 'ready' | 'stale' | 'error';

export type RegistryEntry = {
  file_path: string;
  file_hash: string;
  status: RegistryStatus;
  session_id: string | null;
  declarations: Declarations | null;
  last_active: Date | null;
  error: string | null;
  group_id?: string;
};

// Valid transitions: from -> set of allowed destinations
const VALID_TRANSITIONS: Record<RegistryStatus, Set<RegistryStatus>> = {
  cold: new Set(['bootstrapping', 'error']),
  bootstrapping: new Set(['ready', 'error']),
  ready: new Set(['stale', 'error']),
  stale: new Set(['bootstrapping', 'error']),
  error: new Set(['error']),
};

export class Registry {
  private entries: Map<string, RegistryEntry> = new Map();

  get size(): number {
    return this.entries.size;
  }

  add(entry: RegistryEntry): void {
    if (this.entries.has(entry.file_path)) {
      throw new Error(`Duplicate file_path: ${entry.file_path}`);
    }
    this.entries.set(entry.file_path, { ...entry });
  }

  get(filePath: string): RegistryEntry | undefined {
    const entry = this.entries.get(filePath);
    return entry ? { ...entry } : undefined;
  }

  update(filePath: string, updates: Partial<Omit<RegistryEntry, 'file_path'>>): void {
    const entry = this.entries.get(filePath);
    if (!entry) {
      throw new Error(`Entry not found: ${filePath}`);
    }

    // Status transition validation
    if (updates.status !== undefined && updates.status !== entry.status) {
      const allowed = VALID_TRANSITIONS[entry.status];
      if (!allowed || !allowed.has(updates.status)) {
        throw new Error(
          `Invalid status transition: ${entry.status} -> ${updates.status}`,
        );
      }
    }

    // Hash change side effects: ready entry with changed hash -> stale
    if (
      updates.file_hash !== undefined &&
      updates.file_hash !== entry.file_hash &&
      entry.status === 'ready'
    ) {
      entry.status = 'stale';
      entry.declarations = null;
      entry.session_id = null;
    }

    // Apply remaining updates
    if (updates.status !== undefined) entry.status = updates.status;
    if (updates.file_hash !== undefined) entry.file_hash = updates.file_hash;
    if (updates.session_id !== undefined) entry.session_id = updates.session_id;
    if (updates.declarations !== undefined) entry.declarations = updates.declarations;
    if (updates.last_active !== undefined) entry.last_active = updates.last_active;
    if (updates.error !== undefined) entry.error = updates.error;
  }

  remove(filePath: string): void {
    this.entries.delete(filePath);
  }

  list(): RegistryEntry[] {
    return Array.from(this.entries.values()).map((e) => ({ ...e }));
  }

  listByStatus(status: RegistryStatus): RegistryEntry[] {
    return this.list().filter((e) => e.status === status);
  }

  getGroup(groupId: string): RegistryEntry[] {
    return this.list().filter((e) => e.group_id === groupId);
  }
}
