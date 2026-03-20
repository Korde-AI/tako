/**
 * PID file management for Tako daemon mode.
 *
 * Handles writing, reading, validating, and cleaning up PID files
 * stored at ~/.tako/tako.pid.
 */

import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import { getRuntimePaths } from '../core/paths.js';

export interface DaemonInfo {
  pid: number;
  startedAt: string;
  port: number;
  bind: string;
  mode?: 'edge' | 'hub';
  home?: string;
  nodeId?: string;
  configPath?: string;
}

/** Write daemon info to PID file. */
export async function writePidFile(info: DaemonInfo): Promise<void> {
  const pidPath = getRuntimePaths().pidFile;
  await mkdir(dirname(pidPath), { recursive: true });
  await writeFile(pidPath, JSON.stringify(info, null, 2));
}

/** Read daemon info from PID file. Returns null if not found. */
export async function readPidFile(): Promise<DaemonInfo | null> {
  try {
    const content = await readFile(getRuntimePaths().pidFile, 'utf-8');
    return JSON.parse(content) as DaemonInfo;
  } catch {
    return null;
  }
}

/** Remove the PID file. */
export async function removePidFile(): Promise<void> {
  try {
    await unlink(getRuntimePaths().pidFile);
  } catch {
    // Already gone — fine
  }
}

/** Check if a process with the given PID is running. */
export function isProcessRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Get the status of the daemon. */
export async function getDaemonStatus(): Promise<{
  running: boolean;
  info: DaemonInfo | null;
  stale: boolean;
}> {
  const info = await readPidFile();
  if (!info) {
    return { running: false, info: null, stale: false };
  }

  const running = isProcessRunning(info.pid);
  if (!running) {
    return { running: false, info, stale: true };
  }

  return { running: true, info, stale: false };
}

/** Get the PID file path (for display). */
export function getPidPath(): string {
  return getRuntimePaths().pidFile;
}
