/**
 * Prompt caching — mark static content for provider-level caching.
 *
 * Anthropic supports cache_control breakpoints on system prompts.
 * This module identifies cacheable content and adds cache markers.
 *
 * Benefits: ~90% cost reduction on cached system prompt tokens.
 */

import type { ChatMessage } from './provider.js';

export interface PromptCacheConfig {
  /** Enable prompt caching (default: true) */
  enabled: boolean;
  /** Min tokens for content to be cache-worthy (default: 1024) */
  minTokens: number;
  /** Provider support map */
  providers: {
    anthropic: boolean;
    openai: boolean;
  };
}

export interface PromptCacheStats {
  cacheHits: number;
  cacheMisses: number;
  cachedTokens: number;
  savedTokens: number;
  hitRate: number;
}

const DEFAULT_CACHE_CONFIG: PromptCacheConfig = {
  enabled: true,
  minTokens: 1024,
  providers: {
    anthropic: true,
    openai: false,
  },
};

export class PromptCacheManager {
  private config: PromptCacheConfig;
  private stats: PromptCacheStats;

  constructor(config: Partial<PromptCacheConfig> = {}) {
    this.config = { ...DEFAULT_CACHE_CONFIG, ...config };
    if (config.providers) {
      this.config.providers = { ...DEFAULT_CACHE_CONFIG.providers, ...config.providers };
    }
    this.stats = { cacheHits: 0, cacheMisses: 0, cachedTokens: 0, savedTokens: 0, hitRate: 0 };
  }

  /**
   * Add cache control markers to messages for Anthropic API.
   * Only marks system messages that exceed the minTokens threshold.
   * Non-Anthropic providers are returned unchanged.
   */
  applyCacheMarkers(messages: ChatMessage[], provider: string): ChatMessage[] {
    if (!this.config.enabled) return messages;
    if (provider !== 'anthropic' || !this.config.providers.anthropic) return messages;

    return messages.map((msg) => {
      if (msg.role !== 'system') return msg;

      const text = typeof msg.content === 'string'
        ? msg.content
        : msg.content.filter((p) => p.type === 'text').map((p) => (p as { type: 'text'; text: string }).text).join('\n');

      // Rough token estimate: ~4 chars per token
      const estimatedTokens = Math.ceil(text.length / 4);
      if (estimatedTokens < this.config.minTokens) return msg;

      // Return message with content structured for cache_control.
      // The cache_control field is a runtime extension accepted by the Anthropic API
      // but not present in the ChatMessage ContentPart type, so we cast through unknown.
      return {
        ...msg,
        content: [
          { type: 'text' as const, text, cache_control: { type: 'ephemeral' as const } },
        ] as unknown as ChatMessage['content'],
      };
    });
  }

  /** Update stats from provider response usage data. */
  updateStats(usage: { cache_creation_input_tokens?: number; cache_read_input_tokens?: number }): void {
    const creation = usage.cache_creation_input_tokens ?? 0;
    const read = usage.cache_read_input_tokens ?? 0;

    if (read > 0) {
      this.stats.cacheHits++;
      this.stats.savedTokens += read;
    } else if (creation > 0) {
      this.stats.cacheMisses++;
    }

    this.stats.cachedTokens += creation + read;
    const total = this.stats.cacheHits + this.stats.cacheMisses;
    this.stats.hitRate = total > 0 ? this.stats.cacheHits / total : 0;
  }

  /** Get current cache stats. */
  getStats(): PromptCacheStats {
    return { ...this.stats };
  }

  /** Reset stats. */
  resetStats(): void {
    this.stats = { cacheHits: 0, cacheMisses: 0, cachedTokens: 0, savedTokens: 0, hitRate: 0 };
  }

  /** Format stats for display. */
  formatStats(): string {
    const s = this.stats;
    const total = s.cacheHits + s.cacheMisses;
    if (total === 0) return 'Prompt cache: no data yet.';

    const hitPct = (s.hitRate * 100).toFixed(1);
    return [
      `**Prompt Cache**`,
      `Hits: ${s.cacheHits} / ${total} (${hitPct}%)`,
      `Cached tokens: ${s.cachedTokens.toLocaleString()}`,
      `Saved tokens: ${s.savedTokens.toLocaleString()}`,
    ].join('\n');
  }
}
