/**
 * Rate Limiter — sliding window counter for per-user, per-channel, and global rate limits.
 *
 * In-memory only, no external dependencies. Tracks request timestamps
 * in a circular buffer per key.
 */

// ─── Types ──────────────────────────────────────────────────────────

export interface RateLimitConfig {
  /** Enable rate limiting (default: true). */
  enabled: boolean;
  /** Per-user limits. */
  perUser: { maxRequests: number; windowMs: number };
  /** Per-channel limits. */
  perChannel: { maxRequests: number; windowMs: number };
  /** Global limits. */
  global: { maxRequests: number; windowMs: number };
}

export interface RateLimitResult {
  /** Whether the request is allowed. */
  allowed: boolean;
  /** Seconds until the user can retry (if blocked). */
  retryAfterSeconds: number;
  /** Which limit was hit ('user' | 'channel' | 'global' | null). */
  limitType: 'user' | 'channel' | 'global' | null;
  /** Remaining requests in the most constrained window. */
  remaining: number;
}

// ─── Sliding Window ─────────────────────────────────────────────────

class SlidingWindow {
  private timestamps: number[] = [];
  private maxRequests: number;
  private windowMs: number;

  constructor(maxRequests: number, windowMs: number) {
    this.maxRequests = maxRequests;
    this.windowMs = windowMs;
  }

  /** Record a request and return whether it's allowed. */
  check(now: number): { allowed: boolean; retryAfterMs: number; remaining: number } {
    // Prune old timestamps
    const cutoff = now - this.windowMs;
    this.timestamps = this.timestamps.filter((t) => t > cutoff);

    if (this.timestamps.length >= this.maxRequests) {
      // Calculate when the oldest request in window will expire
      const oldestInWindow = this.timestamps[0];
      const retryAfterMs = (oldestInWindow + this.windowMs) - now;
      return {
        allowed: false,
        retryAfterMs: Math.max(0, retryAfterMs),
        remaining: 0,
      };
    }

    this.timestamps.push(now);
    return {
      allowed: true,
      retryAfterMs: 0,
      remaining: this.maxRequests - this.timestamps.length,
    };
  }

  /** Get current count without recording. */
  count(now: number): number {
    const cutoff = now - this.windowMs;
    return this.timestamps.filter((t) => t > cutoff).length;
  }

  /** Reset this window. */
  reset(): void {
    this.timestamps = [];
  }
}

// ─── Rate Limiter ───────────────────────────────────────────────────

export class RateLimiter {
  private config: RateLimitConfig;
  private userWindows = new Map<string, SlidingWindow>();
  private channelWindows = new Map<string, SlidingWindow>();
  private globalWindow: SlidingWindow;

  constructor(config: RateLimitConfig) {
    this.config = config;
    this.globalWindow = new SlidingWindow(config.global.maxRequests, config.global.windowMs);
  }

  /**
   * Check if a request is allowed.
   * @param userId - User identifier (Discord user ID, Telegram chat ID, etc.)
   * @param channelId - Channel identifier
   */
  check(userId: string, channelId: string): RateLimitResult {
    if (!this.config.enabled) {
      return { allowed: true, retryAfterSeconds: 0, limitType: null, remaining: Infinity };
    }

    const now = Date.now();

    // Check global limit first
    const globalResult = this.globalWindow.check(now);
    if (!globalResult.allowed) {
      // Undo the check (we didn't actually record it)
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil(globalResult.retryAfterMs / 1000),
        limitType: 'global',
        remaining: 0,
      };
    }

    // Check per-channel limit
    let channelWindow = this.channelWindows.get(channelId);
    if (!channelWindow) {
      channelWindow = new SlidingWindow(
        this.config.perChannel.maxRequests,
        this.config.perChannel.windowMs,
      );
      this.channelWindows.set(channelId, channelWindow);
    }
    const channelResult = channelWindow.check(now);
    if (!channelResult.allowed) {
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil(channelResult.retryAfterMs / 1000),
        limitType: 'channel',
        remaining: 0,
      };
    }

    // Check per-user limit
    let userWindow = this.userWindows.get(userId);
    if (!userWindow) {
      userWindow = new SlidingWindow(
        this.config.perUser.maxRequests,
        this.config.perUser.windowMs,
      );
      this.userWindows.set(userId, userWindow);
    }
    const userResult = userWindow.check(now);
    if (!userResult.allowed) {
      return {
        allowed: false,
        retryAfterSeconds: Math.ceil(userResult.retryAfterMs / 1000),
        limitType: 'user',
        remaining: 0,
      };
    }

    // All limits OK — return the most constrained remaining
    const minRemaining = Math.min(
      globalResult.remaining,
      channelResult.remaining,
      userResult.remaining,
    );

    return {
      allowed: true,
      retryAfterSeconds: 0,
      limitType: null,
      remaining: minRemaining,
    };
  }

  /**
   * Reset all rate limit counters.
   */
  reset(): void {
    this.userWindows.clear();
    this.channelWindows.clear();
    this.globalWindow.reset();
  }

  /**
   * Reset rate limits for a specific user.
   */
  resetUser(userId: string): void {
    this.userWindows.delete(userId);
  }

  /**
   * Get stats for debugging.
   */
  getStats(): { users: number; channels: number } {
    return {
      users: this.userWindows.size,
      channels: this.channelWindows.size,
    };
  }
}
