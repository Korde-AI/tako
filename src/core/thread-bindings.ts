/**
 * Thread binding manager — maps Discord threads to sub-agent sessions.
 *
 * When a sub-agent spawns with `thread: true`, a Discord thread is created
 * and bound to that agent's session. Messages in the thread route to the
 * sub-agent instead of the main agent. After 24h idle the thread is unbound
 * and auto-archived.
 *
 * Session key format: agent:<agentId>:<channelId>:thread:<threadId>
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

// ─── Constants ──────────────────────────────────────────────────────

export const THREAD_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours

// ─── Types ──────────────────────────────────────────────────────────

export interface ThreadBinding {
  /** Discord thread channel ID */
  threadId: string;
  /** Parent channel where the thread was created */
  parentChannelId: string;
  /** Agent that owns this thread */
  agentId: string;
  /** Session key for messages in this thread */
  sessionKey: string;
  /** Whether this thread is bound to an ACP runtime session */
  isAcp?: boolean;
  /** Timestamp when the binding was created */
  createdAt: number;
  /** Updated on each message routed through this thread */
  lastActiveAt: number;
}

// ─── Manager ────────────────────────────────────────────────────────

export class ThreadBindingManager {
  private bindings = new Map<string, ThreadBinding>();
  private persistPath: string;

  constructor(persistPath: string) {
    this.persistPath = persistPath;
  }

  /** Bind a thread to a sub-agent session. */
  bind(
    threadId: string,
    binding: Omit<ThreadBinding, 'createdAt' | 'lastActiveAt'>,
  ): void {
    const now = Date.now();
    this.bindings.set(threadId, {
      ...binding,
      createdAt: now,
      lastActiveAt: now,
    });
  }

  /** Unbind a thread. */
  unbind(threadId: string): void {
    this.bindings.delete(threadId);
  }

  /** Get the binding for a thread, if any. */
  getBinding(threadId: string): ThreadBinding | undefined {
    return this.bindings.get(threadId);
  }

  /** Update lastActiveAt for a thread. */
  touch(threadId: string): void {
    const binding = this.bindings.get(threadId);
    if (binding) {
      binding.lastActiveAt = Date.now();
    }
  }

  /** Sweep expired bindings (idle > 24h). Returns the expired bindings. */
  sweepExpired(): ThreadBinding[] {
    const now = Date.now();
    const expired: ThreadBinding[] = [];

    for (const [threadId, binding] of this.bindings) {
      if (now - binding.lastActiveAt > THREAD_IDLE_TIMEOUT_MS) {
        expired.push(binding);
        this.bindings.delete(threadId);
      }
    }

    return expired;
  }

  /** Number of active bindings. */
  get size(): number {
    return this.bindings.size;
  }

  /** Save bindings to disk. */
  async save(): Promise<void> {
    const data: Record<string, ThreadBinding> = {};
    for (const [threadId, binding] of this.bindings) {
      data[threadId] = binding;
    }

    try {
      await mkdir(dirname(this.persistPath), { recursive: true });
      await writeFile(
        this.persistPath,
        JSON.stringify({ bindings: data }, null, 2),
        'utf-8',
      );
    } catch (err) {
      console.error(
        '[tako] Failed to save thread bindings:',
        err instanceof Error ? err.message : err,
      );
    }
  }

  /** Load bindings from disk. */
  async load(): Promise<void> {
    try {
      const raw = await readFile(this.persistPath, 'utf-8');
      const parsed = JSON.parse(raw) as { bindings: Record<string, ThreadBinding> };
      this.bindings.clear();
      for (const [threadId, binding] of Object.entries(parsed.bindings)) {
        this.bindings.set(threadId, binding);
      }
      if (this.bindings.size > 0) {
        console.log(`[tako] Loaded ${this.bindings.size} thread binding(s)`);
      }
    } catch {
      // File doesn't exist yet — that's fine
    }
  }
}
