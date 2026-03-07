/**
 * Delivery queue — async message delivery with retry.
 *
 * When channel.send() fails, the message is queued as a JSON file
 * in ~/.tako/delivery-queue/. A background worker retries every 30s
 * with max 3 attempts. Failed messages move to ~/.tako/delivery-queue/failed/.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, writeFile, readdir, rename, unlink } from 'node:fs/promises';
import type { Channel, OutboundMessage } from './channel.js';

// ─── Types ──────────────────────────────────────────────────────────

interface QueuedMessage {
  id: string;
  channelId: string;
  message: OutboundMessage;
  attempts: number;
  maxAttempts: number;
  createdAt: string;
  lastAttemptAt?: string;
  lastError?: string;
}

// ─── Paths ──────────────────────────────────────────────────────────

function getQueueDir(): string {
  return join(homedir(), '.tako', 'delivery-queue');
}

function getFailedDir(): string {
  return join(getQueueDir(), 'failed');
}

// ─── DeliveryQueue ──────────────────────────────────────────────────

const RETRY_INTERVAL_MS = 30_000;
const MAX_ATTEMPTS = 3;

export class DeliveryQueue {
  private channels = new Map<string, Channel>();
  private retryTimer: ReturnType<typeof setInterval> | null = null;
  private queueDir: string;
  private failedDir: string;

  constructor() {
    this.queueDir = getQueueDir();
    this.failedDir = getFailedDir();
  }

  /** Register a channel for retry delivery. */
  registerChannel(channel: Channel): void {
    this.channels.set(channel.id, channel);
  }

  /** Start the background retry worker. */
  async start(): Promise<void> {
    await mkdir(this.queueDir, { recursive: true });
    await mkdir(this.failedDir, { recursive: true });

    this.retryTimer = setInterval(() => {
      this.processQueue().catch((err) => {
        console.error('[delivery-queue] Retry error:', err instanceof Error ? err.message : err);
      });
    }, RETRY_INTERVAL_MS);
  }

  /** Stop the background retry worker. */
  stop(): void {
    if (this.retryTimer) {
      clearInterval(this.retryTimer);
      this.retryTimer = null;
    }
  }

  /**
   * Enqueue a failed message for retry.
   * Called when channel.send() throws.
   */
  async enqueue(channelId: string, message: OutboundMessage, error: string): Promise<void> {
    const id = crypto.randomUUID();
    const queued: QueuedMessage = {
      id,
      channelId,
      message,
      attempts: 1, // already tried once
      maxAttempts: MAX_ATTEMPTS,
      createdAt: new Date().toISOString(),
      lastAttemptAt: new Date().toISOString(),
      lastError: error,
    };

    const filePath = join(this.queueDir, `${id}.json`);
    await writeFile(filePath, JSON.stringify(queued, null, 2) + '\n', 'utf-8');
    console.log(`[delivery-queue] Queued message ${id} for ${channelId} (error: ${error.slice(0, 100)})`);
  }

  /** Process all queued messages, retrying delivery. */
  private async processQueue(): Promise<void> {
    let files: string[];
    try {
      files = await readdir(this.queueDir);
    } catch {
      return;
    }

    const jsonFiles = files.filter((f) => f.endsWith('.json'));
    if (jsonFiles.length === 0) return;

    for (const file of jsonFiles) {
      const filePath = join(this.queueDir, file);
      try {
        const raw = await readFile(filePath, 'utf-8');
        const queued = JSON.parse(raw) as QueuedMessage;

        const channel = this.channels.get(queued.channelId);
        if (!channel) {
          // Channel not registered — move to failed
          await this.moveFailed(filePath, queued, 'Channel not registered');
          continue;
        }

        try {
          await channel.send(queued.message);
          // Success — remove from queue
          await unlink(filePath);
          console.log(`[delivery-queue] Delivered queued message ${queued.id}`);
        } catch (err) {
          queued.attempts++;
          queued.lastAttemptAt = new Date().toISOString();
          queued.lastError = err instanceof Error ? err.message : String(err);

          if (queued.attempts >= queued.maxAttempts) {
            await this.moveFailed(filePath, queued, queued.lastError);
          } else {
            await writeFile(filePath, JSON.stringify(queued, null, 2) + '\n', 'utf-8');
            console.log(`[delivery-queue] Retry ${queued.attempts}/${queued.maxAttempts} for ${queued.id}`);
          }
        }
      } catch (err) {
        console.error(`[delivery-queue] Error processing ${file}:`, err instanceof Error ? err.message : err);
      }
    }
  }

  /** Move a message to the failed directory. */
  private async moveFailed(filePath: string, queued: QueuedMessage, reason: string): Promise<void> {
    queued.lastError = reason;
    const failedPath = join(this.failedDir, `${queued.id}.json`);
    await writeFile(failedPath, JSON.stringify(queued, null, 2) + '\n', 'utf-8');
    await unlink(filePath);
    console.log(`[delivery-queue] Message ${queued.id} moved to failed (${reason.slice(0, 100)})`);
  }
}
