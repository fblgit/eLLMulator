/**
 * FR-006: Register Handler + FR-007: State & Resolve Handlers — Minimal GREEN
 * Phase 3C: Respond Handler — captures ResponseEnvelope from agents
 *
 * register:  checks registry, sets declarations + status='ready' + last_active
 * state_get/state_set:  synthetic key-value state
 * resolve:   returns declarations for a file_path or undefined
 * respond:   validates and captures ResponseEnvelope, resolves pending promise
 */

import type { Registry } from './registry.js';
import type { Declarations, ResponseEnvelope } from './types.js';
import { ResponseEnvelopeSchema } from './schemas.js';

// ---------------------------------------------------------------------------
// SyntheticState — Map<string, unknown> wrapper
// ---------------------------------------------------------------------------

export class SyntheticState {
  private store: Map<string, unknown> = new Map();

  get(key: string): unknown {
    return this.store.get(key);
  }

  set(key: string, value: unknown): void {
    this.store.set(key, value);
  }
}

// ---------------------------------------------------------------------------
// FR-006: Register Handler
// ---------------------------------------------------------------------------

export function createRegisterHandler(registry: Registry) {
  return (file_path: string, declarations: Declarations): { success: true } | { error: string } => {
    const entry = registry.get(file_path);
    if (!entry) {
      return { error: 'FILE_NOT_IN_REGISTRY' };
    }

    // Ensure valid transition: cold → bootstrapping → ready
    // If still cold (bootstrap didn't mark it), transition through bootstrapping first
    if (entry.status === 'cold') {
      registry.update(file_path, { status: 'bootstrapping' });
    }

    // Merge/upsert: if already ready with existing declarations, merge instead of overwrite.
    // This handles models that split large payloads across multiple register calls.
    const merged = (entry.status === 'ready' || entry.status === 'bootstrapping') && entry.declarations
      ? mergeDeclarations(entry.declarations, declarations)
      : declarations;

    registry.update(file_path, {
      declarations: merged,
      status: 'ready',
      last_active: new Date(),
    });

    return { success: true };
  };
}

/**
 * Merge two Declarations objects — upsert semantics.
 * owns/exports: merge by name (new wins on conflict).
 * imports: merge by name+from (deduplicate).
 * dependencies: union as set.
 * summary: latest non-empty wins.
 */
function mergeDeclarations(existing: Declarations, incoming: Declarations): Declarations {
  const mergeByName = <T extends { name: string }>(a: T[], b: T[]): T[] => {
    const map = new Map<string, T>();
    for (const item of a) map.set(item.name, item);
    for (const item of b) map.set(item.name, item); // incoming wins
    return [...map.values()];
  };

  const mergeImports = (a: Declarations['imports'], b: Declarations['imports']) => {
    const key = (i: { name: string; from: string }) => `${i.name}::${i.from}`;
    const map = new Map<string, typeof a[0]>();
    for (const item of a) map.set(key(item), item);
    for (const item of b) map.set(key(item), item);
    return [...map.values()];
  };

  return {
    summary: incoming.summary || existing.summary,
    owns: mergeByName(existing.owns, incoming.owns),
    exports: mergeByName(existing.exports ?? [], incoming.exports ?? []),
    imports: mergeImports(existing.imports ?? [], incoming.imports ?? []),
    dependencies: [...new Set([...existing.dependencies, ...incoming.dependencies])],
  };
}

// ---------------------------------------------------------------------------
// FR-007: State Handlers
// ---------------------------------------------------------------------------

export function createStateHandlers(state: SyntheticState | Map<string, unknown>) {
  return {
    state_get(key: string): unknown {
      if (state instanceof Map) {
        return state.get(key);
      }
      return state.get(key);
    },
    state_set(key: string, value: unknown): { success: true } {
      if (state instanceof Map) {
        state.set(key, value);
      } else {
        state.set(key, value);
      }
      return { success: true };
    },
  };
}

// ---------------------------------------------------------------------------
// FR-007: Resolve Handler
// ---------------------------------------------------------------------------

/**
 * Type for declarations enriched with server-side content derivation.
 * The `content` field is added at resolve time by reading from disk,
 * not stored in the registry (Point 9: server-side content derivation).
 */
export type EnrichedDeclaration = Declarations['owns'][0] & { content?: string };
export type EnrichedDeclarations = Omit<Declarations, 'owns' | 'exports'> & {
  owns: EnrichedDeclaration[];
  exports: EnrichedDeclaration[];
};

export function createResolveHandler(
  registry: Registry,
  readFile?: (path: string) => string,
) {
  return (file_path: string): EnrichedDeclarations | Declarations | undefined => {
    const entry = registry.get(file_path);
    if (!entry || !entry.declarations) {
      return undefined;
    }

    // If no readFile provided, return raw declarations (backward compatible)
    if (!readFile) {
      return entry.declarations;
    }

    // Enrich declarations with content derived from disk
    const enrichDeclaration = (decl: Declarations['owns'][0]): EnrichedDeclaration => {
      try {
        const source = readFile(decl.file_path);
        const lines = source.split('\n');
        const content = lines.slice(decl.start_line - 1, decl.end_line).join('\n');
        return { ...decl, content };
      } catch {
        // File unreadable — return without content
        return decl;
      }
    };

    return {
      ...entry.declarations,
      owns: entry.declarations.owns.map(enrichDeclaration),
      exports: entry.declarations.exports.map(enrichDeclaration),
    };
  };
}

// ---------------------------------------------------------------------------
// Phase 3C: Respond Handler
// ---------------------------------------------------------------------------

/**
 * createRespondHandler — captures agent responses and resolves pending promises
 *
 * When an agent calls respond() with a ResponseEnvelope, this handler:
 * 1. Validates the envelope structure using ResponseEnvelopeSchema
 * 2. Looks up the pending promise by task_id
 * 3. If found: resolves the promise and removes it from the map
 * 4. If not found: returns error 'NO_PENDING_REQUEST'
 *
 * The pendingResponses map is keyed by task_id. When invoke() sends work to
 * an agent, it creates a Promise and stores the resolver in this map.
 */
export function createRespondHandler(
  pendingResponses: Map<string, (envelope: ResponseEnvelope) => void>
) {
  return (envelope: ResponseEnvelope): { success: true } | { error: string } => {
    // 1. Validate envelope using ResponseEnvelopeSchema
    const parseResult = ResponseEnvelopeSchema.safeParse(envelope);
    if (!parseResult.success) {
      return { error: `INVALID_ENVELOPE: ${parseResult.error.message}` };
    }

    const validatedEnvelope = parseResult.data;

    // 2. Look up pendingResponses by task_id
    const resolver = pendingResponses.get(validatedEnvelope.task_id);

    // 4. If not found: return error 'NO_PENDING_REQUEST'
    if (!resolver) {
      return { error: 'NO_PENDING_REQUEST' };
    }

    // 3. If found: call the resolve callback and delete from map
    resolver(validatedEnvelope);
    pendingResponses.delete(validatedEnvelope.task_id);

    // 5. Return { success: true }
    return { success: true };
  };
}
