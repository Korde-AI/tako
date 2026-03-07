/**
 * Tests for prompt caching and usage tracking.
 *
 * Prompt caching:
 * - Cache marker application for Anthropic
 * - Cache stats tracking
 * - minTokens threshold
 * - Non-Anthropic providers not affected
 *
 * Usage tracking:
 * - Record and getSessionUsage
 * - getGlobalUsage aggregation
 * - Cost estimation with known pricing
 * - formatSessionUsage output
 * - save/load persistence
 * - maxEntries cap
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdtemp, rm } from 'node:fs/promises';

import { PromptCacheManager } from '../src/providers/prompt-cache.js';
import { UsageTracker } from '../src/core/usage-tracker.js';
import type { ChatMessage } from '../src/providers/provider.js';

// ─── Prompt Cache Manager ────────────────────────────────────────────

describe('PromptCacheManager', () => {
  it('applies cache markers to Anthropic system messages above threshold', () => {
    const mgr = new PromptCacheManager({ minTokens: 10 }); // low threshold for testing
    const longText = 'a'.repeat(200); // ~50 tokens, well above 10
    const messages: ChatMessage[] = [
      { role: 'system', content: longText },
      { role: 'user', content: 'hello' },
    ];

    const result = mgr.applyCacheMarkers(messages, 'anthropic');

    // System message should be converted to array with cache_control
    assert.ok(Array.isArray(result[0].content));
    const block = (result[0].content as any)[0];
    assert.equal(block.type, 'text');
    assert.equal(block.text, longText);
    assert.deepEqual(block.cache_control, { type: 'ephemeral' });

    // User message should be unchanged
    assert.equal(result[1].content, 'hello');
  });

  it('does not apply markers when content is below minTokens', () => {
    const mgr = new PromptCacheManager({ minTokens: 1024 });
    const shortText = 'short system prompt';
    const messages: ChatMessage[] = [
      { role: 'system', content: shortText },
    ];

    const result = mgr.applyCacheMarkers(messages, 'anthropic');

    // Should remain unchanged (string content)
    assert.equal(result[0].content, shortText);
  });

  it('does not apply markers for non-Anthropic providers', () => {
    const mgr = new PromptCacheManager({ minTokens: 10 });
    const longText = 'a'.repeat(200);
    const messages: ChatMessage[] = [
      { role: 'system', content: longText },
    ];

    const result = mgr.applyCacheMarkers(messages, 'openai');
    assert.equal(result[0].content, longText);
  });

  it('does not apply markers when disabled', () => {
    const mgr = new PromptCacheManager({ enabled: false, minTokens: 10 });
    const longText = 'a'.repeat(200);
    const messages: ChatMessage[] = [
      { role: 'system', content: longText },
    ];

    const result = mgr.applyCacheMarkers(messages, 'anthropic');
    assert.equal(result[0].content, longText);
  });

  it('tracks cache stats on hits', () => {
    const mgr = new PromptCacheManager();

    mgr.updateStats({ cache_creation_input_tokens: 500 });
    let stats = mgr.getStats();
    assert.equal(stats.cacheMisses, 1);
    assert.equal(stats.cacheHits, 0);
    assert.equal(stats.cachedTokens, 500);

    mgr.updateStats({ cache_read_input_tokens: 500 });
    stats = mgr.getStats();
    assert.equal(stats.cacheHits, 1);
    assert.equal(stats.cacheMisses, 1);
    assert.equal(stats.savedTokens, 500);
    assert.equal(stats.hitRate, 0.5);
  });

  it('tracks cache stats on misses', () => {
    const mgr = new PromptCacheManager();

    mgr.updateStats({ cache_creation_input_tokens: 1000 });
    mgr.updateStats({ cache_creation_input_tokens: 800 });

    const stats = mgr.getStats();
    assert.equal(stats.cacheMisses, 2);
    assert.equal(stats.cacheHits, 0);
    assert.equal(stats.cachedTokens, 1800);
    assert.equal(stats.hitRate, 0);
  });

  it('resets stats', () => {
    const mgr = new PromptCacheManager();
    mgr.updateStats({ cache_read_input_tokens: 100 });
    mgr.resetStats();
    const stats = mgr.getStats();
    assert.equal(stats.cacheHits, 0);
    assert.equal(stats.savedTokens, 0);
  });

  it('formats stats for display', () => {
    const mgr = new PromptCacheManager();
    assert.ok(mgr.formatStats().includes('no data'));

    mgr.updateStats({ cache_creation_input_tokens: 500 });
    mgr.updateStats({ cache_read_input_tokens: 500 });
    const output = mgr.formatStats();
    assert.ok(output.includes('Prompt Cache'));
    assert.ok(output.includes('50.0%'));
  });
});

// ─── Usage Tracker ───────────────────────────────────────────────────

describe('UsageTracker', () => {
  function makeEntry(overrides: Partial<Omit<import('../src/core/usage-tracker.js').UsageEntry, 'estimatedCost'>> = {}) {
    return {
      sessionId: 'sess-1',
      model: 'anthropic/claude-sonnet-4-6',
      provider: 'anthropic',
      timestamp: Date.now(),
      inputTokens: 1000,
      outputTokens: 500,
      cachedTokens: 0,
      totalTokens: 1500,
      durationMs: 2000,
      ...overrides,
    };
  }

  it('records entries and retrieves session usage', () => {
    const tracker = new UsageTracker();
    tracker.record(makeEntry());
    tracker.record(makeEntry({ inputTokens: 2000, outputTokens: 1000, totalTokens: 3000 }));

    const usage = tracker.getSessionUsage('sess-1');
    assert.equal(usage.turnCount, 2);
    assert.equal(usage.totalInputTokens, 3000);
    assert.equal(usage.totalOutputTokens, 1500);
    assert.equal(usage.totalTokens, 4500);
    assert.equal(usage.avgTokensPerTurn, 2250);
  });

  it('returns empty session usage for unknown session', () => {
    const tracker = new UsageTracker();
    const usage = tracker.getSessionUsage('nonexistent');
    assert.equal(usage.turnCount, 0);
    assert.equal(usage.totalTokens, 0);
    assert.equal(usage.totalCost, 0);
  });

  it('aggregates global usage', () => {
    const tracker = new UsageTracker();
    tracker.record(makeEntry({ sessionId: 'sess-1' }));
    tracker.record(makeEntry({ sessionId: 'sess-2' }));
    tracker.record(makeEntry({ sessionId: 'sess-1', model: 'anthropic/claude-opus-4-6' }));

    const global = tracker.getGlobalUsage();
    assert.equal(global.totalTurns, 3);
    assert.equal(global.bySession.size, 2);
    assert.equal(global.byModel.size, 2);

    const sonnetStats = global.byModel.get('anthropic/claude-sonnet-4-6');
    assert.ok(sonnetStats);
    assert.equal(sonnetStats.turns, 2);

    const opusStats = global.byModel.get('anthropic/claude-opus-4-6');
    assert.ok(opusStats);
    assert.equal(opusStats.turns, 1);
  });

  it('estimates cost with known pricing', () => {
    const tracker = new UsageTracker();

    // claude-sonnet-4-6: $3/M input, $15/M output
    const cost = tracker.estimateCost('claude-sonnet-4-6', 1_000_000, 1_000_000, 0);
    assert.equal(cost, 3.0 + 15.0); // $18 total

    // With cached tokens: cached at $0.3/M
    const costWithCache = tracker.estimateCost('claude-sonnet-4-6', 1_000_000, 1_000_000, 500_000);
    const expectedInput = (500_000 / 1_000_000) * 3.0; // uncached
    const expectedCached = (500_000 / 1_000_000) * 0.3; // cached
    const expectedOutput = 15.0;
    assert.ok(Math.abs(costWithCache - (expectedInput + expectedCached + expectedOutput)) < 0.001);
  });

  it('returns 0 cost for unknown models', () => {
    const tracker = new UsageTracker();
    const cost = tracker.estimateCost('unknown-model', 1000, 500);
    assert.equal(cost, 0);
  });

  it('strips provider prefix for pricing lookup', () => {
    const tracker = new UsageTracker();
    const cost = tracker.estimateCost('anthropic/claude-sonnet-4-6', 1_000_000, 0, 0);
    assert.equal(cost, 3.0);
  });

  it('formats session usage', () => {
    const tracker = new UsageTracker();
    tracker.record(makeEntry());
    const output = tracker.formatSessionUsage('sess-1');
    assert.ok(output.includes('Session Usage'));
    assert.ok(output.includes('Turns: 1'));
    assert.ok(output.includes('Cost:'));
  });

  it('formats empty session usage', () => {
    const tracker = new UsageTracker();
    const output = tracker.formatSessionUsage('nonexistent');
    assert.ok(output.includes('No usage recorded'));
  });

  it('formats global usage', () => {
    const tracker = new UsageTracker();
    tracker.record(makeEntry());
    tracker.record(makeEntry({ sessionId: 'sess-2' }));
    const output = tracker.formatGlobalUsage();
    assert.ok(output.includes('Global Usage'));
    assert.ok(output.includes('Total turns: 2'));
    assert.ok(output.includes('By Model'));
  });

  it('enforces maxEntries cap', () => {
    const tracker = new UsageTracker(5);
    for (let i = 0; i < 10; i++) {
      tracker.record(makeEntry({ sessionId: `sess-${i}` }));
    }
    const global = tracker.getGlobalUsage();
    assert.equal(global.totalTurns, 5);
  });

  it('saves and loads from disk', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'tako-usage-'));
    const filePath = join(dir, 'usage.json');

    try {
      const tracker1 = new UsageTracker();
      tracker1.record(makeEntry({ sessionId: 'persist-1' }));
      tracker1.record(makeEntry({ sessionId: 'persist-2' }));
      await tracker1.save(filePath);

      const tracker2 = new UsageTracker();
      await tracker2.load(filePath);

      const global = tracker2.getGlobalUsage();
      assert.equal(global.totalTurns, 2);
      assert.equal(global.bySession.size, 2);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('handles load from missing file gracefully', async () => {
    const tracker = new UsageTracker();
    await tracker.load('/tmp/nonexistent-usage-file.json');
    const global = tracker.getGlobalUsage();
    assert.equal(global.totalTurns, 0);
  });

  it('resets all data', () => {
    const tracker = new UsageTracker();
    tracker.record(makeEntry());
    tracker.record(makeEntry());
    tracker.reset();
    const global = tracker.getGlobalUsage();
    assert.equal(global.totalTurns, 0);
  });

  it('records estimated cost automatically', () => {
    const tracker = new UsageTracker();
    tracker.record(makeEntry({ model: 'anthropic/claude-sonnet-4-6', inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 }));
    const usage = tracker.getSessionUsage('sess-1');
    assert.ok(usage.totalCost > 0);
    assert.equal(usage.totalCost, 18.0); // $3 input + $15 output
  });
});
