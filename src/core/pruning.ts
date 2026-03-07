/**
 * Session pruning — non-destructive context trimming.
 *
 * Unlike compaction (which summarizes and destroys history), pruning
 * selectively removes low-value content while preserving message structure:
 * - Drop tool results older than TTL
 * - Truncate large tool outputs (keep first/last N chars)
 * - Drop thinking/reasoning blocks from old turns
 * - Progressive: more aggressive as context fills up
 */

import type { ChatMessage, ContentPart } from '../providers/provider.js';

export interface PruningConfig {
  /** Enable pruning (default: true) */
  enabled: boolean;
  /** Pruning mode: 'off' | 'cache-ttl' | 'progressive' */
  mode: 'off' | 'cache-ttl' | 'progressive';
  /** TTL for tool results in ms (default: 3600000 / 1h) */
  toolResultTtlMs: number;
  /** Max chars for a single tool result (default: 5000) */
  maxToolResultChars: number;
  /** Context percentage to start pruning at (default: 0.60) */
  startAt: number;
  /** Context percentage to start aggressive pruning (default: 0.75) */
  aggressiveAt: number;
}

const DEFAULT_PRUNING_CONFIG: PruningConfig = {
  enabled: true,
  mode: 'progressive',
  toolResultTtlMs: 3_600_000, // 1 hour
  maxToolResultChars: 5_000,
  startAt: 0.60,
  aggressiveAt: 0.75,
};

/** Timestamp metadata key attached to messages for pruning age tracking. */
const TIMESTAMP_KEY = '_ts';

export class SessionPruner {
  private config: PruningConfig;

  constructor(config?: Partial<PruningConfig>) {
    this.config = { ...DEFAULT_PRUNING_CONFIG, ...config };
  }

  /** Prune messages based on current context usage. Non-destructive (returns new array). */
  prune(messages: ChatMessage[], contextUsage: number): ChatMessage[] {
    if (!this.config.enabled || this.config.mode === 'off') {
      return messages;
    }

    // No pruning needed below start threshold
    if (contextUsage < this.config.startAt) {
      return messages;
    }

    // Deep clone to ensure non-destructive operation
    let result = deepCloneMessages(messages);

    // Progressive pruning levels
    if (contextUsage >= this.config.startAt) {
      result = this.softPrune(result);
    }

    if (contextUsage >= 0.70) {
      result = this.mediumPrune(result);
    }

    if (contextUsage >= this.config.aggressiveAt) {
      result = this.aggressivePrune(result);
    }

    return result;
  }

  /** Soft prune: drop old tool results past TTL. */
  private softPrune(messages: ChatMessage[]): ChatMessage[] {
    const now = Date.now();
    const ttl = this.config.toolResultTtlMs;

    return messages.map(msg => {
      if (msg.role !== 'tool') return msg;

      // Check timestamp from metadata
      const ts = (msg as MessageWithMeta)[TIMESTAMP_KEY] as number | undefined;
      if (ts && (now - ts) > ttl) {
        return {
          ...msg,
          content: '[tool result expired — pruned]',
        };
      }

      return msg;
    });
  }

  /** Medium prune: truncate large tool outputs. */
  private mediumPrune(messages: ChatMessage[]): ChatMessage[] {
    const maxChars = this.config.maxToolResultChars;

    return messages.map(msg => {
      if (msg.role !== 'tool') return msg;

      if (typeof msg.content === 'string' && msg.content.length > maxChars) {
        const headSize = Math.floor(maxChars * 0.7);
        const tailSize = Math.floor(maxChars * 0.3);
        const truncated =
          msg.content.slice(0, headSize) +
          '\n\n[... truncated ...]\n\n' +
          msg.content.slice(-tailSize);
        return { ...msg, content: truncated };
      }

      // Handle structured content parts
      if (Array.isArray(msg.content)) {
        const newContent = msg.content.map((part: ContentPart) => {
          if (part.type === 'tool_result' && part.content.length > maxChars) {
            const headSize = Math.floor(maxChars * 0.7);
            const tailSize = Math.floor(maxChars * 0.3);
            return {
              ...part,
              content:
                part.content.slice(0, headSize) +
                '\n\n[... truncated ...]\n\n' +
                part.content.slice(-tailSize),
            };
          }
          return part;
        });
        return { ...msg, content: newContent };
      }

      return msg;
    });
  }

  /** Aggressive prune: drop thinking blocks, minimize old turns. */
  private aggressivePrune(messages: ChatMessage[]): ChatMessage[] {
    // Keep the last N messages intact (recent context)
    const RECENT_THRESHOLD = 10;
    const cutoff = Math.max(0, messages.length - RECENT_THRESHOLD);

    return messages.map((msg, idx) => {
      // Keep recent messages intact
      if (idx >= cutoff) return msg;

      // Drop thinking/reasoning from old assistant messages
      if (msg.role === 'assistant' && typeof msg.content === 'string') {
        // Strip <thinking>...</thinking> blocks
        const stripped = msg.content.replace(/<thinking>[\s\S]*?<\/thinking>/g, '');
        if (stripped !== msg.content) {
          return { ...msg, content: stripped.trim() || '[thinking pruned]' };
        }
      }

      // For old assistant messages with structured content, drop thinking parts
      if (msg.role === 'assistant' && Array.isArray(msg.content)) {
        const filtered = msg.content.filter((part: ContentPart) => {
          if (part.type === 'text' && /<thinking>/.test(part.text)) {
            return false;
          }
          return true;
        });
        if (filtered.length !== msg.content.length) {
          return { ...msg, content: filtered.length > 0 ? filtered : '[thinking pruned]' };
        }
      }

      return msg;
    });
  }

  /** Estimate tokens saved by pruning. */
  estimateSavings(original: ChatMessage[], pruned: ChatMessage[]): number {
    const originalChars = countChars(original);
    const prunedChars = countChars(pruned);
    return Math.ceil((originalChars - prunedChars) / 4); // ~4 chars per token
  }
}

// ─── Helpers ─────────────────────────────────────────────────────────

type MessageWithMeta = ChatMessage & Record<string, unknown>;

function deepCloneMessages(messages: ChatMessage[]): ChatMessage[] {
  return messages.map(msg => {
    if (typeof msg.content === 'string') {
      return { ...msg };
    }
    return { ...msg, content: [...msg.content] };
  });
}

function countChars(messages: ChatMessage[]): number {
  let chars = 0;
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      chars += msg.content.length;
    } else {
      for (const part of msg.content) {
        if (part.type === 'text') chars += part.text.length;
        if (part.type === 'tool_result') chars += part.content.length;
      }
    }
  }
  return chars;
}
