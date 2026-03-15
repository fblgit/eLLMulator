/**
 * FR-013: TraceLog — TraceEntry collection with JSONL output.
 */

import type { TraceEntry } from './types.js';

export class TraceLog {
  private entries: TraceEntry[] = [];

  get size(): number {
    return this.entries.length;
  }

  add(entry: TraceEntry): void {
    this.entries.push(entry);
  }

  getByTraceId(traceId: string): TraceEntry[] {
    return this.entries.filter((e) => e.trace_id === traceId);
  }

  list(): TraceEntry[] {
    return [...this.entries];
  }

  toJSONL(): string {
    if (this.entries.length === 0) return '';
    return this.entries.map((e) => JSON.stringify(e)).join('\n');
  }

  clear(): void {
    this.entries = [];
  }
}
