/**
 * Typing indicator manager — show "typing..." while agent is processing.
 *
 * Sends platform-specific typing indicators at regular intervals
 * while the agent is thinking or executing tools.
 */

import type { Channel } from '../channels/channel.js';

export interface TypingConfig {
  /** Enable typing indicators (default: true) */
  enabled: boolean;
  /** Interval to re-send typing indicator in ms (default: 5000) */
  intervalMs: number;
}

const DEFAULT_TYPING_CONFIG: TypingConfig = {
  enabled: true,
  intervalMs: 5000,
};

export class TypingManager {
  private intervals: Map<string, ReturnType<typeof setInterval>> = new Map();
  private config: TypingConfig;

  constructor(config?: Partial<TypingConfig>) {
    this.config = { ...DEFAULT_TYPING_CONFIG, ...config };
  }

  /** Start showing typing indicator for a chat. */
  start(channel: Channel, chatId: string): void {
    if (!this.config.enabled) return;
    if (!channel.sendTyping) return;

    // Stop any existing interval for this chat
    this.stop(chatId);

    // Send immediately
    channel.sendTyping(chatId).catch(() => {});

    // Re-send at interval
    const interval = setInterval(() => {
      channel.sendTyping!(chatId).catch(() => {});
    }, this.config.intervalMs);

    this.intervals.set(chatId, interval);
  }

  /** Stop showing typing indicator for a chat. */
  stop(chatId: string): void {
    const interval = this.intervals.get(chatId);
    if (interval) {
      clearInterval(interval);
      this.intervals.delete(chatId);
    }
  }

  /** Stop all typing indicators. */
  stopAll(): void {
    for (const [chatId] of this.intervals) {
      this.stop(chatId);
    }
  }
}
