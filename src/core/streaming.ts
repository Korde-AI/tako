/**
 * Response streaming — deliver model output in chunks as it's generated.
 *
 * Instead of waiting for the full response, stream text chunks to the
 * channel in real-time. Handles:
 * - Chunk buffering (don't send every token, batch ~50-100 chars)
 * - Channel-specific chunk delivery (Discord edits, Telegram edits, CLI stdout)
 * - Tool call handling (pause streaming during tool execution)
 * - Markdown boundary detection (don't split mid-codeblock)
 */

import type { Channel, OutboundMessage } from '../channels/channel.js';

// ─── Config ─────────────────────────────────────────────────────────

/** Configuration for response streaming behavior. */
export interface StreamConfig {
  /** Enable streaming (default: true) */
  enabled: boolean;
  /** Min chars to buffer before sending a chunk (default: 50) */
  minChunkSize: number;
  /** Max ms to wait before flushing buffer (default: 500) */
  flushIntervalMs: number;
  /** Max message length before splitting into new message (default: 2000 for Discord) */
  maxMessageLength: number;
}

const DEFAULT_STREAM_CONFIG: StreamConfig = {
  enabled: true,
  minChunkSize: 200,
  flushIntervalMs: 1000,
  maxMessageLength: 2000,
};

// ─── Context ────────────────────────────────────────────────────────

/** Context for a streaming session — identifies where to deliver chunks. */
export interface StreamContext {
  /** Target chat/channel ID for sending messages. */
  channelId: string;
  /** Existing message ID to edit (for updating in-place). */
  messageId?: string;
  /** The channel adapter to send through. */
  channel: Channel;
}

// ─── ResponseStreamer ───────────────────────────────────────────────

/**
 * Buffers streaming text and delivers it to a channel in chunks.
 *
 * For channels that support `editMessage` (Discord, Telegram), the streamer
 * sends an initial message then edits it as more text arrives. When the
 * message exceeds `maxMessageLength`, it sends a new message and continues.
 *
 * For channels without edit support (CLI), text is written incrementally
 * via `send()`.
 */
export class ResponseStreamer {
  private config: StreamConfig;
  private context: StreamContext;
  private buffer = '';
  private sentMessageId?: string;
  private totalSent = '';
  private flushTimer?: ReturnType<typeof setTimeout>;
  private finished = false;

  constructor(config: Partial<StreamConfig>, context: StreamContext) {
    this.config = { ...DEFAULT_STREAM_CONFIG, ...config };
    this.context = context;
    if (context.messageId) {
      this.sentMessageId = context.messageId;
    }
  }

  /** Add text to the stream buffer. May trigger a flush. */
  async push(text: string): Promise<void> {
    if (this.finished) return;
    this.buffer += text;

    if (this.shouldFlush()) {
      await this.flush();
    } else if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flushTimer = undefined;
        if (this.buffer.length > 0 && !this.finished) {
          this.flush().catch((err) => {
            console.warn('[streaming] Timer flush error:', err instanceof Error ? err.message : err);
          });
        }
      }, this.config.flushIntervalMs);
    }
  }

  /** Force flush remaining buffer (call at end of response). */
  async finish(): Promise<void> {
    if (this.finished) return;
    this.finished = true;
    this.clearTimer();
    if (this.buffer.length > 0) {
      await this.flush();
    }
  }

  /** Cancel streaming (e.g., on error). */
  async cancel(): Promise<void> {
    this.finished = true;
    this.clearTimer();
    this.buffer = '';
  }

  /** Get total characters streamed so far. */
  get length(): number {
    return this.totalSent.length + this.buffer.length;
  }

  // ─── Private ────────────────────────────────────────────────────

  private clearTimer(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  private shouldFlush(): boolean {
    return this.buffer.length >= this.config.minChunkSize;
  }

  /**
   * Flush the buffer to the channel.
   *
   * Strategy depends on channel capabilities:
   * - If channel has editMessage + sendAndGetId: edit-in-place, split on overflow
   * - Otherwise: send incremental chunks via send()
   */
  private async flush(): Promise<void> {
    if (this.buffer.length === 0) return;
    this.clearTimer();

    const { channel, channelId } = this.context;

    // Determine how much to flush — find a safe breakpoint
    const breakAt = this.findSafeBreakpoint(this.buffer);
    if (breakAt === 0) {
      // Safe breakpoint says "don't flush yet" (unclosed markdown formatting)
      // Re-arm the timer to try again later
      if (!this.flushTimer && !this.finished) {
        this.flushTimer = setTimeout(() => {
          this.flushTimer = undefined;
          if (this.buffer.length > 0 && !this.finished) {
            this.flush().catch(() => {});
          }
        }, this.config.flushIntervalMs);
      }
      return;
    }
    const toFlush = this.buffer.slice(0, breakAt);
    this.buffer = this.buffer.slice(breakAt);

    if (channel.editMessage && channel.sendAndGetId) {
      // Edit-in-place strategy — channel has both methods (narrowed by guard above)
      await this.flushWithEdit(toFlush, channelId, channel as Channel & { editMessage: NonNullable<Channel['editMessage']>; sendAndGetId: NonNullable<Channel['sendAndGetId']> });
    } else {
      // Incremental send strategy (CLI-style)
      await channel.send({ target: channelId, content: toFlush });
      this.totalSent += toFlush;
    }
  }

  /** Flush using edit-in-place (Discord/Telegram style). */
  private async flushWithEdit(
    text: string,
    channelId: string,
    channel: Channel & { editMessage: NonNullable<Channel['editMessage']>; sendAndGetId: NonNullable<Channel['sendAndGetId']> },
  ): Promise<void> {
    const candidate = this.totalSent + text;

    if (candidate.length <= this.config.maxMessageLength) {
      // Still fits in current message — edit or send initial
      if (this.sentMessageId) {
        await channel.editMessage(channelId, this.sentMessageId, candidate);
      } else {
        const msg: OutboundMessage = { target: channelId, content: candidate };
        this.sentMessageId = await channel.sendAndGetId(msg);
      }
      this.totalSent = candidate;
    } else {
      // Overflow — finalize current message, start a new one
      // First, fill current message to capacity if we haven't sent yet
      if (!this.sentMessageId) {
        const first = candidate.slice(0, this.config.maxMessageLength);
        const msg: OutboundMessage = { target: channelId, content: first };
        this.sentMessageId = await channel.sendAndGetId(msg);
        this.totalSent = first;
        // Put the overflow back in the buffer
        this.buffer = candidate.slice(this.config.maxMessageLength) + this.buffer;
      } else {
        // Edit current message to its final state (up to maxMessageLength)
        const currentCapacity = this.config.maxMessageLength - this.totalSent.length;
        if (currentCapacity > 0) {
          const fitText = text.slice(0, currentCapacity);
          const finalContent = this.totalSent + fitText;
          await channel.editMessage(channelId, this.sentMessageId, finalContent);
          // Remaining text goes into a new message
          const overflow = text.slice(currentCapacity);
          this.totalSent = '';
          this.sentMessageId = undefined;
          if (overflow.length > 0) {
            this.buffer = overflow + this.buffer;
          }
        } else {
          // Current message is full — start fresh
          this.totalSent = '';
          this.sentMessageId = undefined;
          this.buffer = text + this.buffer;
        }
      }
    }
  }

  /**
   * Find a safe position to break the text at, avoiding splits inside:
   * - Fenced code blocks (```)
   * - Markdown formatting (**bold**, *italic*, __underline__, ~~strike~~)
   * - Bullet points / list items
   * - Mid-word
   *
   * Returns the index to break at (exclusive).
   */
  private findSafeBreakpoint(text: string): number {
    // If the entire buffer is small enough, take it all
    if (text.length <= this.config.minChunkSize * 2) {
      return text.length;
    }

    // Don't split inside a fenced code block
    const codeBlockPattern = /```/g;
    let match: RegExpExecArray | null;
    let openCount = 0;
    let lastOpenPos = -1;

    while ((match = codeBlockPattern.exec(text)) !== null) {
      if (openCount % 2 === 0) {
        lastOpenPos = match.index;
      }
      openCount++;
    }

    // If we have an unclosed code block, break before it opens
    if (openCount % 2 !== 0 && lastOpenPos > this.config.minChunkSize) {
      return lastOpenPos;
    }

    // Don't split inside markdown formatting markers
    // Count ** and * to check if we're mid-bold/italic
    const hasUnclosedBold = (text.match(/\*\*/g)?.length ?? 0) % 2 !== 0;
    const hasUnclosedItalic = (text.match(/(?<!\*)\*(?!\*)/g)?.length ?? 0) % 2 !== 0;
    const hasUnclosedStrike = (text.match(/~~/g)?.length ?? 0) % 2 !== 0;
    const hasUnclosedUnderline = (text.match(/__/g)?.length ?? 0) % 2 !== 0;

    if (hasUnclosedBold || hasUnclosedItalic || hasUnclosedStrike || hasUnclosedUnderline) {
      // Find the last complete markdown section (break at a double newline or paragraph)
      const lastParagraph = text.lastIndexOf('\n\n');
      if (lastParagraph > this.config.minChunkSize) {
        return lastParagraph + 2;
      }
      // Otherwise don't flush yet — wait for more text to close the formatting
      if (text.length < this.config.maxMessageLength) {
        return 0; // signal: don't flush yet
      }
    }

    // Try to break at a double newline (paragraph boundary — safest)
    const lastParagraph = text.lastIndexOf('\n\n');
    if (lastParagraph > this.config.minChunkSize) {
      return lastParagraph + 2;
    }

    // Try to break at a newline (but not mid-list-item)
    // Find the last newline that isn't followed by a continuation (bullet, space, etc.)
    for (let i = text.length - 1; i >= this.config.minChunkSize; i--) {
      if (text[i] === '\n') {
        // Check if the next line starts a new block (not a continuation)
        const nextChar = text[i + 1];
        if (nextChar === '\n' || nextChar === '#' || nextChar === '-' || nextChar === '*' ||
            nextChar === '|' || nextChar === '>' || nextChar === undefined) {
          return i + 1;
        }
      }
    }

    // Try any newline
    const lastNewline = text.lastIndexOf('\n');
    if (lastNewline > this.config.minChunkSize) {
      return lastNewline + 1;
    }

    // Try to break at a sentence boundary (. or ! or ? followed by space)
    for (let i = text.length - 1; i >= this.config.minChunkSize; i--) {
      if ((text[i] === '.' || text[i] === '!' || text[i] === '?') &&
          (text[i + 1] === ' ' || text[i + 1] === '\n' || i === text.length - 1)) {
        return i + 1;
      }
    }

    // Try to break at a space
    const lastSpace = text.lastIndexOf(' ');
    if (lastSpace > this.config.minChunkSize) {
      return lastSpace + 1;
    }

    // Take everything
    return text.length;
  }
}
