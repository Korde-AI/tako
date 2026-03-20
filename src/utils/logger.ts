/**
 * File logger — wraps console.log/error/warn and appends to a daily log file.
 *
 * Log files are written to: ~/.tako/logs/tako-YYYY-MM-DD.log
 * Each line is prefixed with an ISO timestamp and level.
 */

import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { getRuntimePaths } from '../core/paths.js';

function getLogRoot(): string {
  return getRuntimePaths().logsDir;
}

/** Format a Date as YYYY-MM-DD. */
function dateStamp(d: Date = new Date()): string {
  return d.toISOString().slice(0, 10);
}

/** Get the log file path for a given date. */
function logPath(date?: Date): string {
  return join(getLogRoot(), `tako-${dateStamp(date)}.log`);
}

let dirReady = false;

async function ensureDir(): Promise<void> {
  if (dirReady) return;
  await mkdir(getLogRoot(), { recursive: true });
  dirReady = true;
}

/** Append a single line to the daily log file. */
async function writeLine(level: string, args: unknown[]): Promise<void> {
  try {
    await ensureDir();
    const ts = new Date().toISOString();
    const text = args
      .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
      .join(' ');
    await appendFile(logPath(), `${ts} [${level}] ${text}\n`, 'utf-8');
  } catch {
    // Silently swallow file errors — never break the app due to logging
  }
}

// ─── Original console methods (saved before patching) ──────────────

const origLog = console.log.bind(console);
const origError = console.error.bind(console);
const origWarn = console.warn.bind(console);

/**
 * Install the file logger — patches console.log/error/warn to also
 * write to the daily log file. Call once at startup.
 */
export function installFileLogger(): void {
  console.log = (...args: unknown[]) => {
    origLog(...args);
    writeLine('INFO', args);
  };

  console.error = (...args: unknown[]) => {
    origError(...args);
    writeLine('ERROR', args);
  };

  console.warn = (...args: unknown[]) => {
    origWarn(...args);
    writeLine('WARN', args);
  };
}

/** Return the absolute directory where logs are stored. */
export function getLogDir(): string {
  return getLogRoot();
}

/** Return the log file path for a specific date. */
export function getLogPath(date?: Date): string {
  return logPath(date);
}
