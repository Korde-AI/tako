/**
 * Gateway lock — prevent multiple Tako daemons from running simultaneously.
 *
 * Uses a lock file with PID validation. Stale locks (where the PID is no
 * longer running) are automatically cleaned up.
 */

import { readFile, writeFile, unlink, mkdir } from 'node:fs/promises';
import { join, dirname } from 'node:path';

// ─── Implementation ─────────────────────────────────────────────────

export class GatewayLock {
  private lockPath: string;

  constructor(stateDir: string) {
    this.lockPath = join(stateDir, 'tako.lock');
  }

  /** Acquire the lock. Returns true if acquired, false if another instance is running. */
  async acquire(): Promise<boolean> {
    const status = await this.isLocked();
    if (status.locked) return false;

    // Ensure parent directory exists
    await mkdir(dirname(this.lockPath), { recursive: true });

    // Write our PID to the lock file
    await writeFile(this.lockPath, String(process.pid), 'utf-8');

    // Verify we own the lock (race-condition check)
    try {
      const content = await readFile(this.lockPath, 'utf-8');
      return content.trim() === String(process.pid);
    } catch {
      return false;
    }
  }

  /** Release the lock. */
  async release(): Promise<void> {
    try {
      // Only release if we own the lock
      const content = await readFile(this.lockPath, 'utf-8');
      if (content.trim() === String(process.pid)) {
        await unlink(this.lockPath);
      }
    } catch {
      // Lock file doesn't exist — nothing to release
    }
  }

  /** Check if lock is held by a running process. */
  async isLocked(): Promise<{ locked: boolean; pid?: number }> {
    try {
      const content = await readFile(this.lockPath, 'utf-8');
      const pid = parseInt(content.trim(), 10);
      if (isNaN(pid)) {
        // Corrupt lock file — treat as stale
        return { locked: false };
      }

      // Check if the process is still running
      if (this.isProcessRunning(pid)) {
        return { locked: true, pid };
      }

      // Stale lock — process is dead
      return { locked: false, pid };
    } catch {
      // No lock file
      return { locked: false };
    }
  }

  /** Force-break a stale lock. */
  async forceBreak(): Promise<void> {
    try {
      await unlink(this.lockPath);
    } catch {
      // Already gone
    }
  }

  /** Check if a process with the given PID is running. */
  private isProcessRunning(pid: number): boolean {
    try {
      // signal 0 checks existence without actually sending a signal
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }
}
