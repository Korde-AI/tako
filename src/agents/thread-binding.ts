/**
 * Discord Thread Binding for ACP/Sub-agent Spawns.
 *
 * When an agent spawns an ACP session or sub-agent from a Discord channel,
 * auto-creates a thread for status updates and progress reporting.
 *
 * Features:
 * - Auto-create thread on spawn
 * - Periodic progress updates (every N seconds while running)
 * - Completion summary with files changed and duration
 */

import type { DiscordChannel } from '../channels/discord.js';

// ─── Types ──────────────────────────────────────────────────────────

export interface ThreadBindingConfig {
  /** Enable thread binding (default: true). */
  enabled: boolean;
  /** Create threads for ACP session spawns (default: true). */
  spawnAcpSessions: boolean;
  /** Create threads for sub-agent spawns (default: true). */
  spawnSubagents: boolean;
  /** Post periodic progress updates (default: true). */
  progressUpdates: boolean;
  /** Interval between progress updates in ms (default: 30000). */
  progressIntervalMs: number;
}

export const DEFAULT_THREAD_BINDING_CONFIG: ThreadBindingConfig = {
  enabled: true,
  spawnAcpSessions: true,
  spawnSubagents: true,
  progressUpdates: true,
  progressIntervalMs: 30_000,
};

export interface SpawnThreadBinding {
  threadId: string;
  parentChannelId: string;
  spawnType: 'acp' | 'subagent';
  sessionId: string;
  label: string;
  startedAt: number;
  progressTimer: ReturnType<typeof setInterval> | null;
}

// ─── Manager ────────────────────────────────────────────────────────

export class SpawnThreadBinder {
  private config: ThreadBindingConfig;
  private bindings = new Map<string, SpawnThreadBinding>();
  private discord: DiscordChannel | null = null;

  constructor(config?: Partial<ThreadBindingConfig>) {
    this.config = { ...DEFAULT_THREAD_BINDING_CONFIG, ...config };
  }

  /** Set the Discord channel instance. Must be called after Discord connects. */
  setDiscord(discord: DiscordChannel): void {
    this.discord = discord;
  }

  /**
   * Called when an ACP session or sub-agent is spawned.
   * Creates a Discord thread if the triggering message came from Discord.
   *
   * @returns The thread ID if created, null otherwise.
   */
  async onSpawn(opts: {
    spawnType: 'acp' | 'subagent';
    sessionId: string;
    label: string;
    channelId: string;
    channelType: string;
    getProgress?: () => { status: string; filesChanged?: number };
  }): Promise<string | null> {
    if (!this.config.enabled) return null;
    if (!this.discord) return null;
    if (opts.channelType !== 'discord') return null;
    if (opts.spawnType === 'acp' && !this.config.spawnAcpSessions) return null;
    if (opts.spawnType === 'subagent' && !this.config.spawnSubagents) return null;

    // Extract raw Discord channel ID (strip 'discord:' prefix if present)
    const rawChannelId = opts.channelId.startsWith('discord:')
      ? opts.channelId.slice(8)
      : opts.channelId;

    try {
      // Create thread
      const prefix = opts.spawnType === 'acp' ? '[acp]' : '[agent]';
      const threadName = `${prefix} ${opts.label.slice(0, 50)}`;

      const thread = await this.discord.createThread(rawChannelId, threadName);

      // Post initial message
      const emoji = opts.spawnType === 'acp' ? '\uD83D\uDD27' : '\uD83E\uDD16';
      const typeLabel = opts.spawnType === 'acp' ? 'ACP session' : 'Sub-agent';
      await this.discord.send({
        target: thread.id,
        content: `${emoji} ${typeLabel} started: ${opts.label}`,
      });

      const binding: SpawnThreadBinding = {
        threadId: thread.id,
        parentChannelId: rawChannelId,
        spawnType: opts.spawnType,
        sessionId: opts.sessionId,
        label: opts.label,
        startedAt: Date.now(),
        progressTimer: null,
      };

      // Start progress updates
      if (this.config.progressUpdates && opts.getProgress) {
        const getProgress = opts.getProgress;
        binding.progressTimer = setInterval(async () => {
          try {
            const progress = getProgress();
            const elapsed = Math.round((Date.now() - binding.startedAt) / 1000);
            let msg = `Still working... (${elapsed}s elapsed)`;
            if (progress.filesChanged !== undefined && progress.filesChanged > 0) {
              msg += ` — ${progress.filesChanged} file(s) changed`;
            }
            if (progress.status !== 'running') {
              // Session ended, stop updates
              this.stopProgress(opts.sessionId);
              return;
            }
            await this.discord!.send({ target: thread.id, content: msg });
          } catch {
            // Thread may have been deleted — stop updates
            this.stopProgress(opts.sessionId);
          }
        }, this.config.progressIntervalMs);
        binding.progressTimer.unref();
      }

      this.bindings.set(opts.sessionId, binding);
      return thread.id;
    } catch (err) {
      console.error(
        '[thread-binding] Failed to create spawn thread:',
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  /**
   * Called when an ACP session or sub-agent completes.
   * Posts a summary to the thread.
   */
  async onComplete(opts: {
    sessionId: string;
    success: boolean;
    filesChanged?: string[];
    summary?: string;
    parentChannelId?: string;
  }): Promise<void> {
    const binding = this.bindings.get(opts.sessionId);
    if (!binding || !this.discord) return;

    // Stop progress updates
    this.stopProgress(opts.sessionId);

    const elapsed = Math.round((Date.now() - binding.startedAt) / 1000);
    const status = opts.success ? 'Completed' : 'Failed';
    const emoji = opts.success ? '\u2705' : '\u274C';

    const lines = [
      `${emoji} **${status}** in ${elapsed}s`,
    ];

    if (opts.filesChanged && opts.filesChanged.length > 0) {
      lines.push(`Files changed: ${opts.filesChanged.length}`);
      for (const f of opts.filesChanged.slice(0, 10)) {
        lines.push(`  \u2022 ${f}`);
      }
      if (opts.filesChanged.length > 10) {
        lines.push(`  ... and ${opts.filesChanged.length - 10} more`);
      }
    }

    if (opts.summary) {
      lines.push('', opts.summary.slice(0, 500));
    }

    try {
      await this.discord.send({
        target: binding.threadId,
        content: lines.join('\n'),
      });
    } catch {
      // Thread may have been deleted
    }

    this.bindings.delete(opts.sessionId);
  }

  /** Stop progress updates for a session. */
  private stopProgress(sessionId: string): void {
    const binding = this.bindings.get(sessionId);
    if (binding?.progressTimer) {
      clearInterval(binding.progressTimer);
      binding.progressTimer = null;
    }
  }

  /** Get the thread ID for a session, if any. */
  getThreadId(sessionId: string): string | null {
    return this.bindings.get(sessionId)?.threadId ?? null;
  }

  /** Clean up all bindings and timers. */
  shutdown(): void {
    for (const [, binding] of this.bindings) {
      if (binding.progressTimer) {
        clearInterval(binding.progressTimer);
      }
    }
    this.bindings.clear();
  }
}
