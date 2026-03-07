/**
 * Channel delivery retry — exponential backoff wrapper for message sends.
 *
 * Wraps channel send operations with automatic retry on transient errors:
 * - 429 (rate limit) with retry_after support
 * - Timeout / connection reset
 * - 5xx server errors
 *
 * Does NOT retry on auth errors (401/403) or client errors (4xx).
 */

/** Configuration for retry behavior. */
export interface RetryConfig {
  /** Maximum number of attempts (including the first). */
  maxAttempts: number;
  /** Base delay in ms for exponential backoff. */
  baseDelayMs: number;
  /** Channel name for logging. */
  channel: string;
}

/** Default retry configs per channel. */
export const DISCORD_RETRY: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 500,
  channel: 'discord',
};

export const TELEGRAM_RETRY: RetryConfig = {
  maxAttempts: 3,
  baseDelayMs: 400,
  channel: 'telegram',
};

/** HTTP status codes that should NOT be retried. */
const NO_RETRY_STATUSES = new Set([400, 401, 403, 404, 405]);

/** Check if an error is retryable (rate limit, timeout, server error). */
function isRetryable(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false;

  const status = (err as { status?: number; statusCode?: number; httpError?: { status?: number } }).status
    ?? (err as { statusCode?: number }).statusCode
    ?? (err as { httpError?: { status?: number } }).httpError?.status;

  if (status !== undefined) {
    if (NO_RETRY_STATUSES.has(status)) return false;
    if (status === 429 || status >= 500) return true;
  }

  const msg = String((err as { message?: string }).message ?? '').toLowerCase();
  const code = String((err as { code?: string }).code ?? '').toLowerCase();

  return msg.includes('timeout') ||
    msg.includes('econnreset') ||
    msg.includes('econnrefused') ||
    msg.includes('socket hang up') ||
    msg.includes('rate limit') ||
    msg.includes('too many requests') ||
    code === 'econnreset' ||
    code === 'etimedout' ||
    code === 'econnrefused';
}

/** Extract retry_after value from an error (seconds → ms). */
function getRetryAfter(err: unknown): number | null {
  if (!err || typeof err !== 'object') return null;

  // Discord: error.retryAfter (seconds)
  const retryAfter = (err as { retryAfter?: number }).retryAfter;
  if (typeof retryAfter === 'number' && retryAfter > 0) {
    return retryAfter * 1000;
  }

  // Telegram / generic: error.parameters?.retry_after (seconds)
  const params = (err as { parameters?: { retry_after?: number } }).parameters;
  if (params?.retry_after && typeof params.retry_after === 'number') {
    return params.retry_after * 1000;
  }

  return null;
}

/**
 * Execute a function with retry and exponential backoff.
 *
 * @param fn - The async function to retry.
 * @param config - Retry configuration.
 * @param description - Short description of the operation for logging.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  config: RetryConfig,
  description?: string,
): Promise<T> {
  let lastError: unknown;

  for (let attempt = 1; attempt <= config.maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err: unknown) {
      lastError = err;

      if (!isRetryable(err) || attempt === config.maxAttempts) {
        throw err;
      }

      // Use retry_after header if available, otherwise exponential backoff
      const retryAfterMs = getRetryAfter(err);
      const backoffMs = retryAfterMs ?? config.baseDelayMs * Math.pow(2, attempt - 1);
      const desc = description ?? 'send';

      console.warn(
        `[${config.channel}] ${desc} failed (attempt ${attempt}/${config.maxAttempts}), ` +
        `retrying in ${backoffMs}ms: ${err instanceof Error ? err.message : String(err)}`,
      );

      await new Promise((resolve) => setTimeout(resolve, backoffMs));
    }
  }

  throw lastError;
}
