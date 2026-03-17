/**
 * Failover provider — wraps multiple providers with automatic fallback.
 *
 * Tries the primary model first. On rate-limit (429) or overload (529/503),
 * falls through to the next model in the fallback chain. Tracks per-provider
 * cooldowns to avoid hammering a provider that just failed.
 */

import type {
  Provider,
  ChatRequest,
  ChatChunk,
  ModelInfo,
} from './provider.js';

/** Tracks cooldown state for a provider. */
interface CooldownEntry {
  /** Timestamp (ms) when the cooldown expires. */
  expiresAt: number;
}

/** Error status codes that trigger fallback. */
const FALLBACK_STATUS_CODES = new Set([429, 500, 502, 503, 504, 529]);

export interface FailoverProviderOpts {
  /** Map of provider ID → Provider instance. */
  providers: Map<string, Provider>;
  /** Ordered model refs: ['anthropic/claude-sonnet-4-6', 'openai/gpt-5-mini', ...] */
  chain: string[];
  /** Cooldown duration in ms after a provider fails (default: 60000). */
  cooldownMs?: number;
  /** Immediate retry attempts per model before falling through (default: 1). */
  immediateRetries?: number;
  /** Delay between immediate retries in ms (default: 800). */
  retryDelayMs?: number;
}

export class FailoverProvider implements Provider {
  id = 'failover';
  private providers: Map<string, Provider>;
  private chain: string[];
  private cooldownMs: number;
  private immediateRetries: number;
  private retryDelayMs: number;
  private cooldowns = new Map<string, CooldownEntry>();

  constructor(opts: FailoverProviderOpts) {
    this.providers = opts.providers;
    this.chain = opts.chain;
    this.cooldownMs = opts.cooldownMs ?? 60_000;
    this.immediateRetries = Math.max(0, opts.immediateRetries ?? 1);
    this.retryDelayMs = Math.max(0, opts.retryDelayMs ?? 800);
  }

  /**
   * Parse a model ref like 'anthropic/claude-sonnet-4-6' into provider + model.
   */
  private parseModelRef(ref: string): { providerId: string; model: string } {
    const slash = ref.indexOf('/');
    if (slash >= 0) {
      return { providerId: ref.slice(0, slash), model: ref };
    }
    // No slash — assume first provider
    return { providerId: this.chain.length > 0
      ? this.chain[0].split('/')[0]
      : 'anthropic', model: ref };
  }

  /** Check if a provider is currently in cooldown. */
  private isInCooldown(key: string): boolean {
    const entry = this.cooldowns.get(key);
    if (!entry) return false;
    if (Date.now() >= entry.expiresAt) {
      this.cooldowns.delete(key);
      return false;
    }
    return true;
  }

  /** Put a provider into cooldown. */
  private setCooldown(key: string): void {
    this.cooldowns.set(key, {
      expiresAt: Date.now() + this.cooldownMs,
    });
  }

  /** Check if an error is a retryable overload/rate-limit. */
  private isFallbackError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const status = (err as { status?: number }).status;
    if (status && FALLBACK_STATUS_CODES.has(status)) return true;
    const msg = String((err as { message?: string }).message ?? '').toLowerCase();
    return msg.includes('rate_limit') ||
      msg.includes('api_error') ||
      msg.includes('internal server error') ||
      msg.includes('overloaded') ||
      msg.includes('resource exhausted') ||
      msg.includes('capacity') ||
      msg.includes('too many requests');
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
    let lastError: unknown;

    for (const modelRef of this.chain) {
      const { providerId } = this.parseModelRef(modelRef);
      const provider = this.providers.get(providerId);

      if (!provider) {
        console.warn(`[failover] Provider "${providerId}" not found, skipping`);
        continue;
      }

      if (this.isInCooldown(modelRef)) {
        console.warn(`[failover] Model "${modelRef}" in cooldown, skipping`);
        continue;
      }

      for (let attempt = 0; attempt <= this.immediateRetries; attempt++) {
        let emittedAnyChunk = false;
        try {
          const modifiedReq: ChatRequest = { ...req, model: modelRef };

          if (modelRef !== this.chain[0] && attempt === 0) {
            console.log(`[failover] Using fallback model: ${modelRef}`);
          }

          // Stream-through chunks immediately for low latency.
          for await (const chunk of provider.chat(modifiedReq)) {
            emittedAnyChunk = true;
            yield chunk;
          }
          return;
        } catch (err: unknown) {
          lastError = err;

          // If streaming already started, we cannot safely retry or fallback mid-response.
          if (emittedAnyChunk) {
            throw err;
          }

          if (this.isFallbackError(err) && attempt < this.immediateRetries) {
            console.warn(
              `[failover] ${modelRef} transient failure (${this.getErrorStatus(err)}), retrying model (${attempt + 1}/${this.immediateRetries})`,
            );
            if (this.retryDelayMs > 0) {
              await new Promise((resolve) => setTimeout(resolve, this.retryDelayMs));
            }
            continue;
          }

          if (this.isFallbackError(err)) {
            this.setCooldown(modelRef);
            console.warn(
              `[failover] ${modelRef} failed (${this.getErrorStatus(err)}), trying next fallback`,
            );
            break;
          }

          // Non-retryable error (auth, bad request, etc.) — fail immediately
          throw err;
        }
      }
    }

    // All fallbacks exhausted
    throw lastError ?? new Error('[failover] All models in fallback chain failed');
  }

  private getErrorStatus(err: unknown): string {
    if (err && typeof err === 'object') {
      const status = (err as { status?: number }).status;
      if (status) return `HTTP ${status}`;
    }
    return err instanceof Error ? err.message.slice(0, 60) : 'unknown';
  }

  models(): ModelInfo[] {
    const all: ModelInfo[] = [];
    for (const provider of this.providers.values()) {
      all.push(...provider.models());
    }
    return all;
  }

  supports(capability: string): boolean {
    for (const provider of this.providers.values()) {
      if (provider.supports(capability)) return true;
    }
    return false;
  }

  /** Get the current fallback chain. */
  getChain(): string[] {
    return [...this.chain];
  }

  /** Get current cooldown state (for diagnostics). */
  getCooldowns(): Map<string, { expiresAt: number; remainingMs: number }> {
    const result = new Map<string, { expiresAt: number; remainingMs: number }>();
    const now = Date.now();
    for (const [id, entry] of this.cooldowns) {
      if (entry.expiresAt > now) {
        result.set(id, {
          expiresAt: entry.expiresAt,
          remainingMs: entry.expiresAt - now,
        });
      }
    }
    return result;
  }
}
