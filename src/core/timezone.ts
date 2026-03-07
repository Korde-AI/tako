/**
 * Timezone — provide timezone context to the agent.
 *
 * Auto-detects from the system or uses a configured IANA timezone.
 * Generates a human-readable context string for system prompt injection.
 */

// ─── Types ──────────────────────────────────────────────────────────

export interface TimezoneConfig {
  /** User's timezone (IANA format, e.g. 'Asia/Riyadh'). */
  timezone?: string;
  /** Auto-detect from system (default: true). */
  autoDetect: boolean;
}

// ─── Implementation ─────────────────────────────────────────────────

export class TimezoneManager {
  private tz: string;

  constructor(config: Partial<TimezoneConfig> = {}) {
    if (config.timezone) {
      this.tz = config.timezone;
    } else if (config.autoDetect !== false) {
      this.tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    } else {
      this.tz = 'UTC';
    }
  }

  /** Get current timezone. */
  getTimezone(): string {
    return this.tz;
  }

  /** Get current time formatted for the agent. */
  getCurrentTime(): string {
    return this.format(new Date());
  }

  /** Format a date in the user's timezone. */
  format(date: Date, fmt?: string): string {
    if (fmt === 'iso') {
      return date.toLocaleString('sv-SE', { timeZone: this.tz }).replace(' ', 'T');
    }

    if (fmt === 'time') {
      return date.toLocaleTimeString('en-US', {
        timeZone: this.tz,
        hour: '2-digit',
        minute: '2-digit',
        hour12: true,
      });
    }

    if (fmt === 'date') {
      return date.toLocaleDateString('en-US', {
        timeZone: this.tz,
        weekday: 'long',
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      });
    }

    // Default: full human-readable format
    return date.toLocaleString('en-US', {
      timeZone: this.tz,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    });
  }

  /**
   * Get timezone context string for system prompt injection.
   * Returns: "Current date/time: Saturday, March 7th, 2026 — 2:09 PM (Asia/Riyadh)"
   */
  getContextString(): string {
    const formatted = this.format(new Date());
    return `Current date/time: ${formatted} (${this.tz})`;
  }
}
