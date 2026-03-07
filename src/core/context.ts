/**
 * Context manager — assembles and manages the context window.
 *
 * Tracks token usage, decides when to compact, and ensures
 * the context fits within the model's limits.
 */

import type { ChatMessage } from '../providers/provider.js';
import { SessionPruner, type PruningConfig } from './pruning.js';

export interface ContextConfig {
  /** Max tokens for the context window */
  maxTokens: number;
  /** Reserved tokens for the response */
  reservedForResponse: number;
  /** When to trigger compaction (percentage of max) */
  compactionThreshold: number;
  /** Pruning configuration */
  pruning?: Partial<PruningConfig>;
}

const DEFAULT_CONTEXT_CONFIG: ContextConfig = {
  maxTokens: 200_000,
  reservedForResponse: 8_192,
  compactionThreshold: 0.80, // lowered from 0.70 — pruning handles 60-80%
};

export class ContextManager {
  private config: ContextConfig;
  private pruner: SessionPruner;

  constructor(config?: Partial<ContextConfig>) {
    this.config = { ...DEFAULT_CONTEXT_CONFIG, ...config };
    this.pruner = new SessionPruner(this.config.pruning);
  }

  /**
   * Estimate token count for a message array.
   * Uses rough heuristic: ~4 chars per token.
   */
  estimateTokens(messages: ChatMessage[]): number {
    // TODO: Use a proper tokenizer (tiktoken or similar)
    let chars = 0;
    for (const msg of messages) {
      if (typeof msg.content === 'string') {
        chars += msg.content.length;
      } else {
        for (const part of msg.content) {
          if (part.type === 'text') chars += part.text.length;
        }
      }
    }
    return Math.ceil(chars / 4);
  }

  /**
   * Check if the context needs compaction.
   * Runs pruning first — only triggers compaction if pruning wasn't enough.
   */
  needsCompaction(messages: ChatMessage[]): boolean {
    const tokens = this.estimateTokens(messages);
    const threshold = this.config.maxTokens * this.config.compactionThreshold;
    return tokens > threshold;
  }

  /**
   * Prune messages before compaction check.
   * Returns pruned messages and estimated token savings.
   */
  pruneMessages(messages: ChatMessage[]): { messages: ChatMessage[]; tokensSaved: number } {
    const contextUsage = this.estimateTokens(messages) / this.config.maxTokens;
    const pruned = this.pruner.prune(messages, contextUsage);
    const tokensSaved = this.pruner.estimateSavings(messages, pruned);
    return { messages: pruned, tokensSaved };
  }

  /** Available tokens for the response. */
  availableTokens(messages: ChatMessage[]): number {
    const used = this.estimateTokens(messages);
    return Math.max(0, this.config.maxTokens - used - this.config.reservedForResponse);
  }
}
