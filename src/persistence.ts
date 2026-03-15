/**
 * SQLite persistence layer for eLLMulator
 * 
 * Provides durable storage for:
 * - Agent registry (file_path → session_id, declarations, status)
 * - Trace log entries
 * 
 * Uses better-sqlite3 (synchronous API) with WAL mode for concurrent reads.
 */

import BetterSqlite3 from 'better-sqlite3';
import type { RegistryEntry, Declarations, TraceEntry, Mutation } from './types.js';

type Database = BetterSqlite3.Database;

// Database row types (JSON fields are serialized strings)
export type AgentRow = {
  file_path: string;
  session_id: string | null;
  file_hash: string;
  status: string;
  declarations: string | null; // JSON serialized Declarations
  last_active: number | null;  // unix timestamp
  error: string | null;
};

export type TraceRow = {
  trace_id: string;
  task_id: string;
  caller: string;
  callee: string;
  function_name: string;
  params: string | null;       // JSON
  returns: string | null;      // JSON
  source_refs: string | null;  // JSON array
  error: string | null;
  timestamp: number;           // unix timestamp
  depth: number;
  duration_ms: number | null;
  call_stack: string;          // JSON array
  mutations: string | null;    // JSON array of Mutation
};

/**
 * SQLite persistence layer for eLLMulator registry and trace log.
 */
export class PersistenceLayer {
  private db: Database;

  constructor(dbPath: string) {
    this.db = new BetterSqlite3(dbPath);
    
    // Enable WAL mode for concurrent reads
    this.db.pragma('journal_mode = WAL');
    
    // Run migrations
    this.initSchema();
  }

  private initSchema(): void {
    // Agents table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agents (
        file_path TEXT PRIMARY KEY,
        session_id TEXT,
        file_hash TEXT NOT NULL,
        status TEXT NOT NULL,
        declarations TEXT,
        last_active INTEGER,
        error TEXT
      )
    `);

    // Traces table
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS traces (
        trace_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        caller TEXT NOT NULL,
        callee TEXT NOT NULL,
        function_name TEXT NOT NULL,
        params TEXT,
        returns TEXT,
        source_refs TEXT,
        error TEXT,
        timestamp INTEGER NOT NULL,
        depth INTEGER NOT NULL,
        duration_ms INTEGER,
        call_stack TEXT NOT NULL,
        mutations TEXT,
        PRIMARY KEY (trace_id, task_id)
      )
    `);

    // Indexes for common queries
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_agents_status ON agents(status);
      CREATE INDEX IF NOT EXISTS idx_traces_trace_id ON traces(trace_id);
      CREATE INDEX IF NOT EXISTS idx_traces_timestamp ON traces(timestamp);
    `);
  }

  close(): void {
    this.db.close();
  }

  // ---------------------------------------------------------------------------
  // Agent CRUD
  // ---------------------------------------------------------------------------

  /**
   * Insert or update an agent registry entry.
   */
  upsertAgent(entry: RegistryEntry): void {
    const stmt = this.db.prepare(`
      INSERT INTO agents (file_path, session_id, file_hash, status, declarations, last_active, error)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(file_path) DO UPDATE SET
        session_id = excluded.session_id,
        file_hash = excluded.file_hash,
        status = excluded.status,
        declarations = excluded.declarations,
        last_active = excluded.last_active,
        error = excluded.error
    `);

    stmt.run(
      entry.file_path,
      entry.session_id ?? null,
      entry.file_hash,
      entry.status,
      entry.declarations ? JSON.stringify(entry.declarations) : null,
      entry.last_active ? Math.floor(entry.last_active.getTime() / 1000) : null,
      entry.error ?? null
    );
  }

  /**
   * Get an agent by file path.
   */
  getAgent(filePath: string): RegistryEntry | null {
    const stmt = this.db.prepare('SELECT * FROM agents WHERE file_path = ?');
    const row = stmt.get(filePath) as AgentRow | undefined;
    
    if (!row) return null;
    
    return this.rowToRegistryEntry(row);
  }

  /**
   * Get all agents.
   */
  getAllAgents(): RegistryEntry[] {
    const stmt = this.db.prepare('SELECT * FROM agents ORDER BY file_path');
    const rows = stmt.all() as AgentRow[];
    
    return rows.map(row => this.rowToRegistryEntry(row));
  }

  /**
   * Get agents filtered by status.
   */
  getAgentsByStatus(status: string): RegistryEntry[] {
    const stmt = this.db.prepare('SELECT * FROM agents WHERE status = ? ORDER BY file_path');
    const rows = stmt.all(status) as AgentRow[];
    
    return rows.map(row => this.rowToRegistryEntry(row));
  }

  /**
   * Delete an agent by file path.
   */
  deleteAgent(filePath: string): boolean {
    const stmt = this.db.prepare('DELETE FROM agents WHERE file_path = ?');
    const result = stmt.run(filePath);
    
    return result.changes > 0;
  }

  // ---------------------------------------------------------------------------
  // Trace CRUD
  // ---------------------------------------------------------------------------

  /**
   * Insert a trace entry.
   */
  insertTraceEntry(entry: TraceEntry): void {
    const stmt = this.db.prepare(`
      INSERT INTO traces (
        trace_id, task_id, caller, callee, function_name,
        params, returns, source_refs, error, timestamp,
        depth, duration_ms, call_stack, mutations
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(trace_id, task_id) DO UPDATE SET
        params = excluded.params,
        returns = excluded.returns,
        source_refs = excluded.source_refs,
        error = excluded.error,
        timestamp = excluded.timestamp,
        depth = excluded.depth,
        duration_ms = excluded.duration_ms,
        call_stack = excluded.call_stack,
        mutations = excluded.mutations
    `);

    stmt.run(
      entry.trace_id,
      entry.task_id,
      entry.caller,
      entry.target, // callee
      entry.function,
      entry.params !== undefined ? JSON.stringify(entry.params) : null,
      entry.result !== undefined ? JSON.stringify(entry.result) : null,
      entry.source_refs ? JSON.stringify(entry.source_refs) : null,
      entry.error ?? null,
      Math.floor(entry.timestamp.getTime() / 1000),
      entry.depth,
      entry.duration_ms ?? null,
      JSON.stringify(entry.call_stack),
      entry.mutations ? JSON.stringify(entry.mutations) : null
    );
  }

  /**
   * Get all trace entries for a given trace_id.
   */
  getTraceEntries(traceId: string): TraceEntry[] {
    const stmt = this.db.prepare('SELECT * FROM traces WHERE trace_id = ? ORDER BY timestamp ASC');
    const rows = stmt.all(traceId) as TraceRow[];
    
    return rows.map(row => this.rowToTraceEntry(row));
  }

  /**
   * Delete all trace entries for a given trace_id.
   */
  deleteTrace(traceId: string): boolean {
    const stmt = this.db.prepare('DELETE FROM traces WHERE trace_id = ?');
    const result = stmt.run(traceId);
    
    return result.changes > 0;
  }

  // ---------------------------------------------------------------------------
  // Utility
  // ---------------------------------------------------------------------------

  /**
   * Clear all data (for testing).
   */
  clearAll(): void {
    this.db.exec('DELETE FROM agents');
    this.db.exec('DELETE FROM traces');
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private rowToRegistryEntry(row: AgentRow): RegistryEntry {
    return {
      file_path: row.file_path,
      session_id: row.session_id ?? undefined,
      file_hash: row.file_hash,
      status: row.status as RegistryEntry['status'],
      declarations: row.declarations ? JSON.parse(row.declarations) as Declarations : undefined,
      last_active: row.last_active ? new Date(row.last_active * 1000) : undefined,
      error: row.error ?? undefined,
    };
  }

  private rowToTraceEntry(row: TraceRow): TraceEntry {
    return {
      trace_id: row.trace_id,
      task_id: row.task_id,
      timestamp: new Date(row.timestamp * 1000),
      depth: row.depth,
      caller: row.caller,
      target: row.callee,
      function: row.function_name,
      params: row.params ? JSON.parse(row.params) : undefined,
      result: row.returns ? JSON.parse(row.returns) : undefined,
      mutations: row.mutations ? JSON.parse(row.mutations) as Mutation[] : undefined,
      source_refs: row.source_refs ? JSON.parse(row.source_refs) as string[] : undefined,
      duration_ms: row.duration_ms ?? undefined,
      error: row.error ?? undefined,
      call_stack: JSON.parse(row.call_stack) as string[],
    };
  }
}
