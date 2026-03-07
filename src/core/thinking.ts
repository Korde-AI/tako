/**
 * Thinking control — toggle model reasoning depth per-session.
 *
 * Controls Anthropic's extended thinking and OpenAI's reasoning effort.
 * Levels: off | minimal | low | medium | high | xhigh
 */

// ─── Types ──────────────────────────────────────────────────────────

export type ThinkingLevel = 'off' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh';

export interface ThinkingConfig {
  /** Default thinking level. */
  default: ThinkingLevel;
  /** Model-specific defaults (keyed by model ID prefix). */
  modelDefaults?: Record<string, ThinkingLevel>;
}

// ─── Budget mapping ─────────────────────────────────────────────────

/** Anthropic budget_tokens per level. */
const ANTHROPIC_BUDGETS: Record<ThinkingLevel, number> = {
  off: 0,
  minimal: 1024,
  low: 4096,
  medium: 10240,
  high: 25600,
  xhigh: 51200,
};

/** OpenAI reasoning_effort mapping (only supports low/medium/high). */
const OPENAI_EFFORT: Record<ThinkingLevel, string> = {
  off: 'low',
  minimal: 'low',
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'high',
};

// ─── Implementation ─────────────────────────────────────────────────

export class ThinkingManager {
  private sessionLevels = new Map<string, ThinkingLevel>();
  private config: ThinkingConfig;

  constructor(config: Partial<ThinkingConfig> = {}) {
    this.config = {
      default: config.default ?? 'medium',
      modelDefaults: config.modelDefaults,
    };
  }

  /** Get thinking level for a session (session override → model default → global default). */
  getLevel(sessionId: string, modelId?: string): ThinkingLevel {
    const sessionLevel = this.sessionLevels.get(sessionId);
    if (sessionLevel !== undefined) return sessionLevel;

    if (modelId && this.config.modelDefaults) {
      for (const [prefix, level] of Object.entries(this.config.modelDefaults)) {
        if (modelId.startsWith(prefix)) return level;
      }
    }

    return this.config.default;
  }

  /** Set thinking level for a session. */
  setLevel(sessionId: string, level: ThinkingLevel): void {
    this.sessionLevels.set(sessionId, level);
  }

  /** Convert level to provider-specific parameters. */
  toProviderParams(level: ThinkingLevel, provider: string): Record<string, unknown> {
    if (level === 'off') {
      if (provider === 'anthropic') return {};
      if (provider === 'openai') return { reasoning_effort: 'low' };
      return {};
    }

    if (provider === 'anthropic') {
      return {
        thinking: {
          type: 'enabled',
          budget_tokens: ANTHROPIC_BUDGETS[level],
        },
      };
    }

    if (provider === 'openai') {
      return {
        reasoning_effort: OPENAI_EFFORT[level],
      };
    }

    // Unknown provider — return empty
    return {};
  }

  /** Clear session override. */
  clearSession(sessionId: string): void {
    this.sessionLevels.delete(sessionId);
  }
}
