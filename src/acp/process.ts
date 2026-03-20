/**
 * Process spawning helpers for acpx CLI commands.
 *
 * Provides utilities to resolve the acpx command, spawn child processes,
 * collect output, and handle process lifecycle.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { omitProviderAuthEnvVars } from './shared.js';

// ─── Types ───────────────────────────────────────────────────────

export type SpawnExit = {
  code: number | null;
  signal: NodeJS.Signals | null;
  error: Error | null;
};

export type SpawnCollectResult = {
  stdout: string;
  stderr: string;
  code: number | null;
  error: Error | null;
};

// ─── Command resolution ──────────────────────────────────────────

/**
 * Resolve the acpx command to use, checking in order:
 * 1. ACPX_CMD environment variable
 * 2. Local ./node_modules/.bin/acpx
 * 3. Global 'acpx' on PATH
 */
export function resolveAcpxCommand(cwd: string): string {
  const envCmd = process.env.ACPX_CMD;
  if (envCmd && envCmd.trim().length > 0) return envCmd;

  const local = join(cwd, 'node_modules', '.bin', 'acpx');
  if (existsSync(local)) return local;

  return 'acpx';
}

// ─── Spawn helpers ───────────────────────────────────────────────

/**
 * Spawn an acpx process with proper env handling.
 * Strips provider auth env vars from child process env for security.
 */
export function spawnAcpx(params: {
  command: string;
  args: string[];
  cwd: string;
  stripProviderAuthEnvVars?: boolean;
}): ChildProcessWithoutNullStreams {
  const childEnv = params.stripProviderAuthEnvVars
    ? omitProviderAuthEnvVars(process.env)
    : { ...process.env };

  return spawn(params.command, params.args, {
    cwd: params.cwd,
    env: childEnv,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

/**
 * Wait for a child process to exit and return the result.
 */
export async function waitForExit(
  child: ChildProcessWithoutNullStreams,
): Promise<SpawnExit> {
  // Handle case where child already exited
  if (child.exitCode !== null || child.signalCode !== null) {
    return { code: child.exitCode, signal: child.signalCode, error: null };
  }

  return new Promise<SpawnExit>((resolve) => {
    let settled = false;
    const finish = (result: SpawnExit): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    child.once('error', (err) => {
      finish({ code: null, signal: null, error: err });
    });

    child.once('close', (code, signal) => {
      finish({ code, signal, error: null });
    });
  });
}

/**
 * Spawn an acpx command, collect stdout/stderr, and wait for exit.
 * Supports abort signals for cancellation.
 */
export async function spawnAndCollect(params: {
  command: string;
  args: string[];
  cwd: string;
  stripProviderAuthEnvVars?: boolean;
  signal?: AbortSignal;
}): Promise<SpawnCollectResult> {
  if (params.signal?.aborted) {
    return { stdout: '', stderr: '', code: null, error: createAbortError() };
  }

  const child = spawnAcpx(params);
  child.stdin.end();

  let stdout = '';
  let stderr = '';
  child.stdout.on('data', (chunk) => { stdout += String(chunk); });
  child.stderr.on('data', (chunk) => { stderr += String(chunk); });

  let abortKillTimer: ReturnType<typeof setTimeout> | undefined;
  let aborted = false;

  const onAbort = (): void => {
    aborted = true;
    try { child.kill('SIGTERM'); } catch { /* ignore race */ }
    abortKillTimer = setTimeout(() => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      try { child.kill('SIGKILL'); } catch { /* ignore race */ }
    }, 250);
    abortKillTimer.unref?.();
  };

  params.signal?.addEventListener('abort', onAbort, { once: true });

  try {
    const exit = await waitForExit(child);
    return {
      stdout,
      stderr,
      code: exit.code,
      error: aborted ? createAbortError() : exit.error,
    };
  } finally {
    params.signal?.removeEventListener('abort', onAbort);
    if (abortKillTimer) clearTimeout(abortKillTimer);
  }
}

/**
 * Classify a spawn failure as missing command or missing cwd.
 */
export function resolveSpawnFailure(
  err: unknown,
  cwd: string,
): 'missing-command' | 'missing-cwd' | null {
  if (!err || typeof err !== 'object') return null;
  const code = (err as NodeJS.ErrnoException).code;
  if (code !== 'ENOENT') return null;
  try {
    return existsSync(cwd) ? 'missing-command' : 'missing-cwd';
  } catch {
    return 'missing-cwd';
  }
}

function createAbortError(): Error {
  const error = new Error('Operation aborted.');
  error.name = 'AbortError';
  return error;
}
