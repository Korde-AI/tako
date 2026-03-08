/**
 * Reaction feedback — use emoji reactions to signal agent state.
 *
 * - 👋 = received/processing
 * - 🧑‍💻 = queued/waiting
 * - 🎉 = completed successfully
 * - 😕 = failed
 * - 🔁 = retrying
 * - 🤔 = thinking/reasoning
 */

import type { Channel } from '../channels/channel.js';

// ─── Types ──────────────────────────────────────────────────────────

export type ReactionState = 'received' | 'processing' | 'completed' | 'failed' | 'retrying' | 'thinking';

export interface ReactionConfig {
  enabled: boolean;
  reactions: Record<ReactionState, string>;
}

// ─── Defaults ───────────────────────────────────────────────────────

const DEFAULT_REACTIONS: Record<ReactionState, string> = {
  received: '👋',
  processing: '🧑‍💻',
  completed: '🎉',
  failed: '😕',
  retrying: '🔁',
  thinking: '🤔',
};

// ─── Implementation ─────────────────────────────────────────────────

export class ReactionManager {
  private config: ReactionConfig;

  constructor(config: Partial<ReactionConfig> = {}) {
    this.config = {
      enabled: config.enabled ?? true,
      reactions: { ...DEFAULT_REACTIONS, ...config.reactions },
    };
  }

  /** Whether reactions are enabled. */
  get enabled(): boolean {
    return this.config.enabled;
  }

  /** Get the emoji for a given state. */
  getEmoji(state: ReactionState): string {
    return this.config.reactions[state];
  }

  /** React to a message with a state emoji. */
  async react(channel: Channel, chatId: string, messageId: string, state: ReactionState): Promise<void> {
    if (!this.config.enabled || !channel.addReaction) return;
    const emoji = this.config.reactions[state];
    try {
      await channel.addReaction(chatId, messageId, emoji);
    } catch {
      // Silently swallow — never break the agent loop due to reaction failures
    }
  }

  /** Remove a previous reaction. */
  async unreact(channel: Channel, chatId: string, messageId: string, state: ReactionState): Promise<void> {
    if (!this.config.enabled || !channel.removeReaction) return;
    const emoji = this.config.reactions[state];
    try {
      await channel.removeReaction(chatId, messageId, emoji);
    } catch {
      // Silently swallow
    }
  }

  /** Transition reaction (remove old, add new). */
  async transition(
    channel: Channel,
    chatId: string,
    messageId: string,
    from: ReactionState,
    to: ReactionState,
  ): Promise<void> {
    await this.unreact(channel, chatId, messageId, from);
    await this.react(channel, chatId, messageId, to);
  }
}
