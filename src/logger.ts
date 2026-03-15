/**
 * Structured logging for eLLMulator.
 *
 * All log output goes to stderr (stdout is reserved for program output like JSON).
 * Log levels: debug, info, warn, error, silent.
 *
 * Usage:
 *   import { createLogger, setLogLevel } from './logger.js';
 *   const log = createLogger('component');
 *   log.info('message', { key: 'value' });
 *   log.debug('detail', { elapsed: 42 });
 *
 * Format: HH:MM:SS.mmm LVL [component] message key=value key=value
 *
 * CLI flag mapping:
 *   --verbose → setLogLevel('debug')
 *   default   → setLogLevel('info')
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type LogLevel = 'debug' | 'info' | 'warn' | 'error' | 'silent';

export type Logger = {
  debug: (msg: string, meta?: Record<string, unknown>) => void;
  info:  (msg: string, meta?: Record<string, unknown>) => void;
  warn:  (msg: string, meta?: Record<string, unknown>) => void;
  error: (msg: string, meta?: Record<string, unknown>) => void;
  /** Create a child logger with a sub-component name appended. */
  child: (subComponent: string) => Logger;
};

// ---------------------------------------------------------------------------
// Level ordering
// ---------------------------------------------------------------------------

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug:  0,
  info:   1,
  warn:   2,
  error:  3,
  silent: 4,
};

const LEVEL_TAG: Record<Exclude<LogLevel, 'silent'>, string> = {
  debug: 'DBG',
  info:  'INF',
  warn:  'WRN',
  error: 'ERR',
};

// ---------------------------------------------------------------------------
// Global state
// ---------------------------------------------------------------------------

let currentLevel: LogLevel = 'info';

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

// ---------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------

function formatMeta(meta: Record<string, unknown>): string {
  const pairs: string[] = [];
  for (const [k, v] of Object.entries(meta)) {
    if (v === undefined || v === null) continue;
    if (typeof v === 'string') {
      // Quote strings that contain spaces
      pairs.push(v.includes(' ') ? `${k}="${v}"` : `${k}=${v}`);
    } else if (typeof v === 'number' || typeof v === 'boolean') {
      pairs.push(`${k}=${v}`);
    } else {
      const json = JSON.stringify(v);
      // Truncate very long values
      pairs.push(`${k}=${json.length > 200 ? json.slice(0, 200) + '…' : json}`);
    }
  }
  return pairs.length > 0 ? ' ' + pairs.join(' ') : '';
}

function timestamp(): string {
  // HH:MM:SS.mmm — compact, readable
  return new Date().toISOString().slice(11, 23);
}

// ---------------------------------------------------------------------------
// Logger factory
// ---------------------------------------------------------------------------

export function createLogger(component: string): Logger {
  function emit(
    level: Exclude<LogLevel, 'silent'>,
    msg: string,
    meta?: Record<string, unknown>,
  ): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[currentLevel]) return;

    const line = `${timestamp()} ${LEVEL_TAG[level]} [${component}] ${msg}${meta ? formatMeta(meta) : ''}`;
    process.stderr.write(line + '\n');
  }

  const logger: Logger = {
    debug: (msg, meta) => emit('debug', msg, meta),
    info:  (msg, meta) => emit('info',  msg, meta),
    warn:  (msg, meta) => emit('warn',  msg, meta),
    error: (msg, meta) => emit('error', msg, meta),
    child: (sub: string) => createLogger(`${component}:${sub}`),
  };

  return logger;
}
