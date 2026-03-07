/**
 * Usage tracker — monitor token consumption and estimated costs.
 *
 * Tracks per-session and global usage:
 * - Input/output tokens per model call
 * - Estimated cost based on model pricing
 * - Cache savings from prompt caching
 * - Usage trends over time
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';

export interface UsageEntry {
  sessionId: string;
  model: string;
  provider: string;
  timestamp: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  totalTokens: number;
  estimatedCost: number;
  durationMs: number;
}

export interface SessionUsage {
  sessionId: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCachedTokens: number;
  totalTokens: number;
  totalCost: number;
  turnCount: number;
  avgTokensPerTurn: number;
}

export interface GlobalUsage {
  totalTokens: number;
  totalCost: number;
  totalTurns: number;
  byModel: Map<string, { tokens: number; cost: number; turns: number }>;
  bySession: Map<string, SessionUsage>;
  since: number;
}

/** Pricing per 1M tokens (input/output) */
const MODEL_PRICING: Record<string, { input: number; output: number; cachedInput?: number }> = {
  'claude-sonnet-4-6': { input: 3.0, output: 15.0, cachedInput: 0.3 },
  'claude-opus-4-6': { input: 15.0, output: 75.0, cachedInput: 1.5 },
  'claude-haiku-4-5': { input: 0.8, output: 4.0, cachedInput: 0.08 },
  'claude-haiku-3.5': { input: 0.8, output: 4.0, cachedInput: 0.08 },
  'gpt-4o': { input: 2.5, output: 10.0 },
  'gpt-4o-mini': { input: 0.15, output: 0.6 },
};

export class UsageTracker {
  private entries: UsageEntry[] = [];
  private maxEntries: number;

  constructor(maxEntries: number = 10_000) {
    this.maxEntries = maxEntries;
  }

  /** Record a model call's usage. */
  record(entry: Omit<UsageEntry, 'estimatedCost'>): void {
    const cost = this.estimateCost(entry.model, entry.inputTokens, entry.outputTokens, entry.cachedTokens);
    this.entries.push({ ...entry, estimatedCost: cost });

    // Enforce cap
    if (this.entries.length > this.maxEntries) {
      this.entries = this.entries.slice(this.entries.length - this.maxEntries);
    }
  }

  /** Get usage for a specific session. */
  getSessionUsage(sessionId: string): SessionUsage {
    const sessionEntries = this.entries.filter((e) => e.sessionId === sessionId);
    const totalInputTokens = sessionEntries.reduce((s, e) => s + e.inputTokens, 0);
    const totalOutputTokens = sessionEntries.reduce((s, e) => s + e.outputTokens, 0);
    const totalCachedTokens = sessionEntries.reduce((s, e) => s + e.cachedTokens, 0);
    const totalTokens = sessionEntries.reduce((s, e) => s + e.totalTokens, 0);
    const totalCost = sessionEntries.reduce((s, e) => s + e.estimatedCost, 0);
    const turnCount = sessionEntries.length;

    return {
      sessionId,
      totalInputTokens,
      totalOutputTokens,
      totalCachedTokens,
      totalTokens,
      totalCost,
      turnCount,
      avgTokensPerTurn: turnCount > 0 ? Math.round(totalTokens / turnCount) : 0,
    };
  }

  /** Get global usage summary. */
  getGlobalUsage(): GlobalUsage {
    const byModel = new Map<string, { tokens: number; cost: number; turns: number }>();
    const bySession = new Map<string, SessionUsage>();

    let totalTokens = 0;
    let totalCost = 0;
    let since = Infinity;

    // Aggregate by model
    for (const entry of this.entries) {
      totalTokens += entry.totalTokens;
      totalCost += entry.estimatedCost;
      if (entry.timestamp < since) since = entry.timestamp;

      const modelStats = byModel.get(entry.model) ?? { tokens: 0, cost: 0, turns: 0 };
      modelStats.tokens += entry.totalTokens;
      modelStats.cost += entry.estimatedCost;
      modelStats.turns++;
      byModel.set(entry.model, modelStats);
    }

    // Aggregate by session
    const sessionIds = new Set(this.entries.map((e) => e.sessionId));
    for (const sid of sessionIds) {
      bySession.set(sid, this.getSessionUsage(sid));
    }

    return {
      totalTokens,
      totalCost,
      totalTurns: this.entries.length,
      byModel,
      bySession,
      since: since === Infinity ? Date.now() : since,
    };
  }

  /** Estimate cost for a model call. */
  estimateCost(model: string, inputTokens: number, outputTokens: number, cachedTokens: number = 0): number {
    // Strip provider prefix
    const modelId = model.includes('/') ? model.split('/').pop()! : model;
    const pricing = MODEL_PRICING[modelId];
    if (!pricing) return 0;

    const uncachedInput = inputTokens - cachedTokens;
    const inputCost = (uncachedInput / 1_000_000) * pricing.input;
    const cachedCost = pricing.cachedInput ? (cachedTokens / 1_000_000) * pricing.cachedInput : 0;
    const outputCost = (outputTokens / 1_000_000) * pricing.output;

    return inputCost + cachedCost + outputCost;
  }

  /** Format usage for display. */
  formatSessionUsage(sessionId: string): string {
    const u = this.getSessionUsage(sessionId);
    if (u.turnCount === 0) return 'No usage recorded for this session.';

    return [
      `**Session Usage**`,
      `Turns: ${u.turnCount}`,
      `Input: ${u.totalInputTokens.toLocaleString()} tokens`,
      `Output: ${u.totalOutputTokens.toLocaleString()} tokens`,
      `Cached: ${u.totalCachedTokens.toLocaleString()} tokens`,
      `Total: ${u.totalTokens.toLocaleString()} tokens`,
      `Avg/turn: ${u.avgTokensPerTurn.toLocaleString()} tokens`,
      `Cost: $${u.totalCost.toFixed(4)}`,
    ].join('\n');
  }

  formatGlobalUsage(): string {
    const g = this.getGlobalUsage();
    if (g.totalTurns === 0) return 'No usage data recorded.';

    const lines = [
      `**Global Usage**`,
      `Total turns: ${g.totalTurns}`,
      `Total tokens: ${g.totalTokens.toLocaleString()}`,
      `Total cost: $${g.totalCost.toFixed(4)}`,
      `Sessions: ${g.bySession.size}`,
      '',
      `**By Model**`,
    ];

    for (const [model, stats] of g.byModel) {
      lines.push(`  ${model}: ${stats.tokens.toLocaleString()} tokens, $${stats.cost.toFixed(4)} (${stats.turns} turns)`);
    }

    return lines.join('\n');
  }

  /** Persist usage to disk. */
  async save(path: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(this.entries, null, 2), 'utf-8');
  }

  /** Load usage from disk. */
  async load(path: string): Promise<void> {
    try {
      const data = await readFile(path, 'utf-8');
      const parsed = JSON.parse(data);
      if (Array.isArray(parsed)) {
        this.entries = parsed;
        // Enforce cap after load
        if (this.entries.length > this.maxEntries) {
          this.entries = this.entries.slice(this.entries.length - this.maxEntries);
        }
      }
    } catch {
      // File doesn't exist or is invalid — start fresh
    }
  }

  /** Reset all usage data. */
  reset(): void {
    this.entries = [];
  }
}
