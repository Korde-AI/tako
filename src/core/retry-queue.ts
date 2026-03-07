/**
 * Failed message re-queue — retry failed model runs after a delay.
 *
 * When all model fallbacks are exhausted, the failed user message is
 * stored in a retry queue. After a configurable delay, it's retried
 * once. If the retry also fails, the failure is logged and optionally
 * a reaction emoji is added to the original message.
 */

import type { RetryQueueConfig } from '../config/schema.js';
import type { Channel } from '../channels/channel.js';

/** A message queued for retry. */
export interface QueuedMessage {
  /** Unique ID for this retry entry. */
  id: string;
  /** The user's original message text. */
  userMessage: string;
  /** Session ID for the conversation. */
  sessionId: string;
  /** Number of retries attempted so far. */
  retryCount: number;
  /** Timestamp when the message was first queued. */
  queuedAt: number;
  /** Channel ID for the original message (for emoji reaction). */
  channelId?: string;
  /** Original message ID (for emoji reaction). */
  messageId?: string;
  /** The channel reference (for reactions). */
  channel?: Channel;
}

/** Callback to run the agent loop for a retried message. */
export type RetryRunner = (
  sessionId: string,
  userMessage: string,
) => Promise<string>;

export class RetryQueue {
  private config: RetryQueueConfig;
  private queue = new Map<string, QueuedMessage>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private runner: RetryRunner | null = null;

  constructor(config: RetryQueueConfig) {
    this.config = config;
  }

  /** Set the retry runner (called when a message is retried). */
  setRunner(runner: RetryRunner): void {
    this.runner = runner;
  }

  /**
   * Enqueue a failed message for retry.
   * Returns true if the message was queued, false if retries are disabled
   * or max retries already reached.
   */
  enqueue(msg: Omit<QueuedMessage, 'id' | 'retryCount' | 'queuedAt'>): boolean {
    if (!this.config.enabled) return false;

    const id = `retry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const entry: QueuedMessage = {
      ...msg,
      id,
      retryCount: 0,
      queuedAt: Date.now(),
    };

    this.queue.set(id, entry);
    this.scheduleRetry(entry);

    console.log(
      `[retry-queue] Queued message for retry in ${this.config.delaySeconds}s ` +
      `(session: ${msg.sessionId})`,
    );

    return true;
  }

  private scheduleRetry(entry: QueuedMessage): void {
    const timer = setTimeout(async () => {
      this.timers.delete(entry.id);
      await this.executeRetry(entry);
    }, this.config.delaySeconds * 1000);

    this.timers.set(entry.id, timer);
  }

  private async executeRetry(entry: QueuedMessage): Promise<void> {
    if (!this.runner) {
      console.warn('[retry-queue] No runner set, dropping retry');
      this.queue.delete(entry.id);
      return;
    }

    entry.retryCount++;
    console.log(
      `[retry-queue] Retrying message (attempt ${entry.retryCount}/${this.config.maxRetries}, ` +
      `session: ${entry.sessionId})`,
    );

    try {
      await this.runner(entry.sessionId, entry.userMessage);
      console.log(`[retry-queue] Retry succeeded (session: ${entry.sessionId})`);
      this.queue.delete(entry.id);
    } catch (err: unknown) {
      console.error(
        `[retry-queue] Retry failed (session: ${entry.sessionId}):`,
        err instanceof Error ? err.message : String(err),
      );

      if (entry.retryCount >= this.config.maxRetries) {
        // Permanent failure — react with failure emoji if possible
        await this.handlePermanentFailure(entry);
        this.queue.delete(entry.id);
      } else {
        // Schedule another retry
        this.scheduleRetry(entry);
      }
    }
  }

  private async handlePermanentFailure(entry: QueuedMessage): Promise<void> {
    console.error(
      `[retry-queue] Permanent failure for message in session ${entry.sessionId} ` +
      `after ${entry.retryCount} retries`,
    );

    // Add failure reaction if channel supports it
    if (entry.channel && entry.channelId && entry.messageId && entry.channel.addReaction) {
      try {
        await entry.channel.addReaction(
          entry.channelId,
          entry.messageId,
          this.config.failureEmoji,
        );
      } catch (err: unknown) {
        console.warn(
          '[retry-queue] Failed to add failure reaction:',
          err instanceof Error ? err.message : String(err),
        );
      }
    }
  }

  /** Get the number of messages currently queued. */
  get size(): number {
    return this.queue.size;
  }

  /** Get all queued messages (for diagnostics). */
  getQueued(): QueuedMessage[] {
    return [...this.queue.values()];
  }

  /** Clear all pending retries and timers. */
  dispose(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.queue.clear();
  }
}
