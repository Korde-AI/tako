/**
 * Message queue — collect, debounce, and cap inbound messages.
 *
 * When messages arrive faster than the model can process them:
 * - collect: batch messages within a time window
 * - debounce: wait for a pause in typing before processing
 * - cap: limit max queued messages to prevent context overflow
 * - drop: configurable strategy when cap is hit (oldest, summarize)
 */

export interface QueueConfig {
  /** Queue mode: 'off' | 'collect' | 'debounce' */
  mode: 'off' | 'collect' | 'debounce';
  /** Debounce delay in ms (default: 2000) */
  debounceMs: number;
  /** Max messages to collect before force-processing (default: 25) */
  cap: number;
  /** What to do when cap is hit: 'oldest' drops oldest, 'summarize' summarizes */
  dropStrategy: 'oldest' | 'summarize';
  /** Max wait time before force-processing in ms (default: 10000) */
  maxWaitMs: number;
}

export interface QueuedMessage {
  content: string;
  channelId: string;
  authorId: string;
  timestamp: number;
  messageId: string;
}

const DEFAULT_QUEUE_CONFIG: QueueConfig = {
  mode: 'collect',
  debounceMs: 2000,
  cap: 25,
  dropStrategy: 'oldest',
  maxWaitMs: 10_000,
};

export class MessageQueue {
  private config: QueueConfig;
  private queues: Map<string, QueuedMessage[]>;
  private timers: Map<string, ReturnType<typeof setTimeout>>;
  private maxTimers: Map<string, ReturnType<typeof setTimeout>>;
  private processor: (sessionId: string, messages: QueuedMessage[]) => Promise<void>;

  constructor(
    config: Partial<QueueConfig>,
    processor: (sessionId: string, messages: QueuedMessage[]) => Promise<void>,
  ) {
    this.config = { ...DEFAULT_QUEUE_CONFIG, ...config };
    this.queues = new Map();
    this.timers = new Map();
    this.maxTimers = new Map();
    this.processor = processor;
  }

  /** Enqueue a message. Returns true if message was queued (not processed immediately). */
  enqueue(sessionId: string, message: QueuedMessage): boolean {
    if (this.config.mode === 'off') {
      // Process immediately — don't queue
      this.processor(sessionId, [message]).catch((err) => {
        console.error(`[message-queue] Processor error for session ${sessionId}:`, err instanceof Error ? err.message : err);
      });
      return false;
    }

    let queue = this.queues.get(sessionId);
    if (!queue) {
      queue = [];
      this.queues.set(sessionId, queue);
    }

    queue.push(message);

    // Enforce cap
    if (queue.length > this.config.cap) {
      if (this.config.dropStrategy === 'oldest') {
        queue.shift();
      }
      // 'summarize' strategy keeps all messages — mergeMessages handles it
    }

    // Force-process when cap is hit exactly
    if (queue.length >= this.config.cap) {
      this.processQueue(sessionId).catch((err) => {
        console.error(`[message-queue] Cap-triggered flush error for session ${sessionId}:`, err instanceof Error ? err.message : err);
      });
      return true;
    }

    if (this.config.mode === 'debounce') {
      this.startDebounceTimer(sessionId);
    } else {
      // 'collect' mode: start debounce timer on first message, maxWait governs force-flush
      this.startDebounceTimer(sessionId);
    }

    // Start max wait timer if not already running
    this.startMaxWaitTimer(sessionId);

    return true;
  }

  /** Force-flush a session's queue immediately. */
  async flush(sessionId: string): Promise<void> {
    await this.processQueue(sessionId);
  }

  /** Get current queue depth for a session. */
  depth(sessionId: string): number {
    return this.queues.get(sessionId)?.length ?? 0;
  }

  /** Clear all queues and timers. */
  clear(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    for (const timer of this.maxTimers.values()) clearTimeout(timer);
    this.timers.clear();
    this.maxTimers.clear();
    this.queues.clear();
  }

  /** Get queue status for all sessions. */
  status(): Array<{ sessionId: string; depth: number; oldestMs: number }> {
    const now = Date.now();
    const result: Array<{ sessionId: string; depth: number; oldestMs: number }> = [];
    for (const [sessionId, queue] of this.queues) {
      if (queue.length === 0) continue;
      result.push({
        sessionId,
        depth: queue.length,
        oldestMs: now - queue[0].timestamp,
      });
    }
    return result;
  }

  /** Update the queue mode at runtime. */
  setMode(mode: 'off' | 'collect' | 'debounce'): void {
    this.config.mode = mode;
  }

  /** Get current config. */
  getConfig(): QueueConfig {
    return { ...this.config };
  }

  private startDebounceTimer(sessionId: string): void {
    // Clear existing debounce timer
    const existing = this.timers.get(sessionId);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.timers.delete(sessionId);
      this.processQueue(sessionId).catch((err) => {
        console.error(`[message-queue] Debounce-triggered flush error for session ${sessionId}:`, err instanceof Error ? err.message : err);
      });
    }, this.config.debounceMs);

    this.timers.set(sessionId, timer);
  }

  private startMaxWaitTimer(sessionId: string): void {
    // Only start if not already running
    if (this.maxTimers.has(sessionId)) return;

    const timer = setTimeout(() => {
      this.maxTimers.delete(sessionId);
      this.processQueue(sessionId).catch((err) => {
        console.error(`[message-queue] MaxWait-triggered flush error for session ${sessionId}:`, err instanceof Error ? err.message : err);
      });
    }, this.config.maxWaitMs);

    this.maxTimers.set(sessionId, timer);
  }

  private async processQueue(sessionId: string): Promise<void> {
    // Clear timers
    const debounceTimer = this.timers.get(sessionId);
    if (debounceTimer) {
      clearTimeout(debounceTimer);
      this.timers.delete(sessionId);
    }
    const maxTimer = this.maxTimers.get(sessionId);
    if (maxTimer) {
      clearTimeout(maxTimer);
      this.maxTimers.delete(sessionId);
    }

    // Grab and clear the queue atomically
    const queue = this.queues.get(sessionId);
    if (!queue || queue.length === 0) return;

    const messages = [...queue];
    queue.length = 0;

    await this.processor(sessionId, messages);
  }

  /** Merge queued messages into a single string for the model. */
  static mergeMessages(messages: QueuedMessage[]): string {
    if (messages.length === 0) return '';
    if (messages.length === 1) return messages[0].content;

    // Detect group chat (multiple authors)
    const authors = new Set(messages.map((m) => m.authorId));
    const isGroup = authors.size > 1;

    // Calculate time span
    const oldest = messages[0].timestamp;
    const newest = messages[messages.length - 1].timestamp;
    const spanSeconds = Math.round((newest - oldest) / 1000);

    const lines: string[] = [];
    for (const msg of messages) {
      if (isGroup) {
        lines.push(`[${msg.authorId}]: ${msg.content}`);
      } else {
        lines.push(msg.content);
      }
    }

    const header = `[queued: ${messages.length} messages over ${spanSeconds}s]`;
    return `${header}\n${lines.join('\n')}`;
  }
}
