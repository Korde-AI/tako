/**
 * Tests for auto-recovery / resilience features:
 * - Model fallback chain (FailoverProvider)
 * - Channel delivery retry (withRetry)
 * - Session compaction (enhanced compactor)
 * - Failed message re-queue (RetryQueue)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';

// ─── 1. FailoverProvider tests ──────────────────────────────────────

import { FailoverProvider } from '../src/providers/failover.js';
import type { Provider, ChatRequest, ChatChunk, ModelInfo } from '../src/providers/provider.js';

/** Create a mock provider that yields the given chunks or throws. */
function mockProvider(
  id: string,
  behavior: 'success' | { status: number } | Error,
): Provider {
  return {
    id,
    async *chat(_req: ChatRequest): AsyncIterable<ChatChunk> {
      if (behavior === 'success') {
        yield { text: `response-from-${id}`, done: false };
        yield { done: true, usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 } };
      } else if (behavior instanceof Error) {
        throw behavior;
      } else {
        const err = new Error(`Rate limited on ${id}`) as Error & { status: number };
        err.status = behavior.status;
        throw err;
      }
    },
    models(): ModelInfo[] {
      return [{ id: 'test', name: 'Test', provider: id, context_window: 100000, max_output_tokens: 8000, capabilities: ['text'] }];
    },
    supports(cap: string) { return cap === 'text'; },
  };
}

describe('FailoverProvider', () => {
  it('uses primary model when it succeeds', async () => {
    const providers = new Map<string, Provider>();
    providers.set('a', mockProvider('a', 'success'));
    providers.set('b', mockProvider('b', 'success'));

    const failover = new FailoverProvider({
      providers,
      chain: ['a/model-1', 'b/model-2'],
    });

    const chunks: ChatChunk[] = [];
    for await (const chunk of failover.chat({ model: 'a/model-1', messages: [], stream: true })) {
      chunks.push(chunk);
    }

    assert.ok(chunks.some((c) => c.text === 'response-from-a'));
  });

  it('falls back to next model on 429', async () => {
    const providers = new Map<string, Provider>();
    providers.set('a', mockProvider('a', { status: 429 }));
    providers.set('b', mockProvider('b', 'success'));

    const failover = new FailoverProvider({
      providers,
      chain: ['a/model-1', 'b/model-2'],
    });

    const chunks: ChatChunk[] = [];
    for await (const chunk of failover.chat({ model: 'a/model-1', messages: [], stream: true })) {
      chunks.push(chunk);
    }

    assert.ok(chunks.some((c) => c.text === 'response-from-b'));
  });

  it('falls back on 503 (overloaded)', async () => {
    const providers = new Map<string, Provider>();
    providers.set('a', mockProvider('a', { status: 503 }));
    providers.set('b', mockProvider('b', 'success'));

    const failover = new FailoverProvider({
      providers,
      chain: ['a/model-1', 'b/model-2'],
    });

    const chunks: ChatChunk[] = [];
    for await (const chunk of failover.chat({ model: 'a/model-1', messages: [], stream: true })) {
      chunks.push(chunk);
    }

    assert.ok(chunks.some((c) => c.text === 'response-from-b'));
  });

  it('does NOT fallback on 401 auth error', async () => {
    const providers = new Map<string, Provider>();
    providers.set('a', mockProvider('a', { status: 401 }));
    providers.set('b', mockProvider('b', 'success'));

    const failover = new FailoverProvider({
      providers,
      chain: ['a/model-1', 'b/model-2'],
    });

    await assert.rejects(
      async () => {
        for await (const _ of failover.chat({ model: 'a/model-1', messages: [], stream: true })) {
          // consume
        }
      },
      (err: Error & { status?: number }) => err.status === 401,
    );
  });

  it('sets cooldown after failure', async () => {
    const providers = new Map<string, Provider>();
    providers.set('a', mockProvider('a', { status: 429 }));
    providers.set('b', mockProvider('b', 'success'));

    const failover = new FailoverProvider({
      providers,
      chain: ['a/model-1', 'b/model-2'],
      cooldownMs: 5000,
    });

    // First call triggers fallback and cooldown
    for await (const _ of failover.chat({ model: 'a/model-1', messages: [], stream: true })) { /* consume */ }

    const cooldowns = failover.getCooldowns();
    assert.ok(cooldowns.has('a'), 'Provider a should be in cooldown');
    assert.ok((cooldowns.get('a')?.remainingMs ?? 0) > 0);
  });

  it('throws when all models fail', async () => {
    const providers = new Map<string, Provider>();
    providers.set('a', mockProvider('a', { status: 429 }));
    providers.set('b', mockProvider('b', { status: 503 }));

    const failover = new FailoverProvider({
      providers,
      chain: ['a/model-1', 'b/model-2'],
    });

    await assert.rejects(
      async () => {
        for await (const _ of failover.chat({ model: 'a/model-1', messages: [], stream: true })) { /* consume */ }
      },
    );
  });
});

// ─── 2. Channel retry tests ────────────────────────────────────────

import { withRetry, type RetryConfig } from '../src/channels/retry.js';

describe('withRetry', () => {
  const fastConfig: RetryConfig = { maxAttempts: 3, baseDelayMs: 10, channel: 'test' };

  it('returns on first success', async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      return 'ok';
    }, fastConfig);

    assert.equal(result, 'ok');
    assert.equal(calls, 1);
  });

  it('retries on rate limit error', async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls < 3) {
        const err = new Error('too many requests') as Error & { status: number };
        err.status = 429;
        throw err;
      }
      return 'ok';
    }, fastConfig);

    assert.equal(result, 'ok');
    assert.equal(calls, 3);
  });

  it('does NOT retry on 401', async () => {
    let calls = 0;
    await assert.rejects(async () => {
      await withRetry(async () => {
        calls++;
        const err = new Error('unauthorized') as Error & { status: number };
        err.status = 401;
        throw err;
      }, fastConfig);
    });

    assert.equal(calls, 1);
  });

  it('does NOT retry on 403', async () => {
    let calls = 0;
    await assert.rejects(async () => {
      await withRetry(async () => {
        calls++;
        const err = new Error('forbidden') as Error & { status: number };
        err.status = 403;
        throw err;
      }, fastConfig);
    });

    assert.equal(calls, 1);
  });

  it('retries on connection reset', async () => {
    let calls = 0;
    const result = await withRetry(async () => {
      calls++;
      if (calls === 1) {
        const err = new Error('socket hang up') as Error & { code: string };
        err.code = 'ECONNRESET';
        throw err;
      }
      return 'recovered';
    }, fastConfig);

    assert.equal(result, 'recovered');
    assert.equal(calls, 2);
  });

  it('throws after max attempts exhausted', async () => {
    let calls = 0;
    await assert.rejects(async () => {
      await withRetry(async () => {
        calls++;
        const err = new Error('timeout') as Error & { status: number };
        err.status = 429;
        throw err;
      }, fastConfig);
    });

    assert.equal(calls, 3);
  });
});

// ─── 3. Compaction tests ────────────────────────────────────────────

import { SessionCompactor } from '../src/gateway/compaction.js';
import { ContextManager } from '../src/core/context.js';
import type { ChatMessage } from '../src/providers/provider.js';
import type { Session, SessionManager } from '../src/gateway/session.js';

describe('SessionCompactor', () => {
  function makeSession(messageCount: number): Session {
    const messages: ChatMessage[] = [];
    for (let i = 0; i < messageCount; i++) {
      messages.push({
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `Message ${i}: ${'x'.repeat(100)}`,
      });
    }
    return {
      id: 'test-session',
      name: 'Test',
      createdAt: new Date(),
      lastActiveAt: new Date(),
      messages,
      metadata: {},
    };
  }

  function makeMockSessionManager(session: Session): SessionManager {
    return {
      get: () => session,
      compact: async (_id: string, keepLast: number) => {
        if (session.messages.length <= keepLast) return;
        const trimmed = session.messages.length - keepLast;
        session.messages = [
          { role: 'system', content: `[${trimmed} messages compacted]` },
          ...session.messages.slice(-keepLast),
        ];
      },
      list: () => [],
      delete: () => {},
    } as unknown as SessionManager;
  }

  it('detects when compaction is needed', () => {
    const ctx = new ContextManager({ maxTokens: 1000, compactionThreshold: 0.5, reservedForResponse: 100 });
    const session = makeSession(50); // 50 * ~104 chars = ~5200 chars = ~1300 tokens
    const config = { compaction: { auto: true, thresholdPercent: 80 }, pruneAfterDays: 7, maxEntries: 100 };
    const compactor = new SessionCompactor(config, ctx, makeMockSessionManager(session));

    assert.ok(compactor.needsCompaction(session));
  });

  it('does not compact when below threshold', () => {
    const ctx = new ContextManager({ maxTokens: 200000, compactionThreshold: 0.85, reservedForResponse: 8192 });
    const session = makeSession(5);
    const config = { compaction: { auto: true, thresholdPercent: 80 }, pruneAfterDays: 7, maxEntries: 100 };
    const compactor = new SessionCompactor(config, ctx, makeMockSessionManager(session));

    assert.ok(!compactor.needsCompaction(session));
  });

  it('builds summary with topics and tools', async () => {
    const ctx = new ContextManager({ maxTokens: 1000, compactionThreshold: 0.5, reservedForResponse: 100 });
    const session: Session = {
      id: 'test-session',
      name: 'Test',
      createdAt: new Date(),
      lastActiveAt: new Date(),
      messages: [
        { role: 'user', content: 'How do I use TypeScript?' },
        { role: 'assistant', content: [
          { type: 'text', text: 'Let me check...' },
          { type: 'tool_use', id: 'tc1', name: 'read_file', input: { path: 'tsconfig.json' } },
        ] },
        { role: 'tool', content: '{}', tool_call_id: 'tc1' },
        { role: 'assistant', content: 'Here is how...' },
        { role: 'user', content: 'What about ESLint?' },
        { role: 'assistant', content: 'ESLint can be configured...' },
        // Add more to push over threshold
        ...Array.from({ length: 20 }, (_, i) => ({
          role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
          content: `Conversation message ${i}: ${'padding '.repeat(20)}`,
        })),
      ],
      metadata: {},
    };

    const config = { compaction: { auto: true, thresholdPercent: 50 }, pruneAfterDays: 7, maxEntries: 100 };
    const compactor = new SessionCompactor(config, ctx, makeMockSessionManager(session));

    const result = await compactor.compact(session, 5);
    assert.ok(result.compactionCount === 1);
    assert.ok(result.messagesAfter < result.messagesBefore);
    assert.ok(session.metadata.compactionCount === 1);
  });

  it('tracks compaction count across multiple compactions', async () => {
    const ctx = new ContextManager({ maxTokens: 500, compactionThreshold: 0.3, reservedForResponse: 50 });
    const session = makeSession(40);
    const config = { compaction: { auto: true, thresholdPercent: 30 }, pruneAfterDays: 7, maxEntries: 100 };
    const compactor = new SessionCompactor(config, ctx, makeMockSessionManager(session));

    await compactor.compact(session, 10);
    assert.equal(session.metadata.compactionCount, 1);

    // Add more messages to trigger second compaction
    for (let i = 0; i < 30; i++) {
      session.messages.push({ role: 'user', content: `More message ${i}: ${'y'.repeat(100)}` });
    }

    await compactor.compact(session, 10);
    assert.equal(session.metadata.compactionCount, 2);
  });
});

// ─── 4. RetryQueue tests ───────────────────────────────────────────

import { RetryQueue } from '../src/core/retry-queue.js';

describe('RetryQueue', () => {
  let queue: RetryQueue;

  afterEach(() => {
    queue?.dispose();
  });

  it('enqueues and retries after delay', async () => {
    queue = new RetryQueue({
      enabled: true,
      delaySeconds: 0.05, // 50ms for fast test
      maxRetries: 1,
      failureEmoji: '😨',
    });

    let retryCalled = false;
    queue.setRunner(async (_sessionId, _msg) => {
      retryCalled = true;
      return 'ok';
    });

    const queued = queue.enqueue({
      userMessage: 'test message',
      sessionId: 'session-1',
    });

    assert.ok(queued);
    assert.equal(queue.size, 1);

    // Wait for retry to fire
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(retryCalled);
    assert.equal(queue.size, 0);
  });

  it('does not enqueue when disabled', () => {
    queue = new RetryQueue({
      enabled: false,
      delaySeconds: 30,
      maxRetries: 1,
      failureEmoji: '😨',
    });

    const queued = queue.enqueue({
      userMessage: 'test',
      sessionId: 'session-1',
    });

    assert.ok(!queued);
    assert.equal(queue.size, 0);
  });

  it('handles permanent failure after max retries', async () => {
    queue = new RetryQueue({
      enabled: true,
      delaySeconds: 0.05,
      maxRetries: 1,
      failureEmoji: '😨',
    });

    queue.setRunner(async () => {
      throw new Error('still broken');
    });

    queue.enqueue({
      userMessage: 'test',
      sessionId: 'session-1',
    });

    // Wait for retry + failure
    await new Promise((r) => setTimeout(r, 200));
    assert.equal(queue.size, 0);
  });

  it('cleans up on dispose', () => {
    queue = new RetryQueue({
      enabled: true,
      delaySeconds: 60,
      maxRetries: 1,
      failureEmoji: '😨',
    });

    queue.enqueue({ userMessage: 'test', sessionId: 's1' });
    queue.enqueue({ userMessage: 'test2', sessionId: 's2' });
    assert.equal(queue.size, 2);

    queue.dispose();
    assert.equal(queue.size, 0);
  });
});

// ─── 5. Prompt caching tests ───────────────────────────────────────

import { AnthropicProvider } from '../src/providers/anthropic.js';

describe('Prompt caching (AnthropicProvider)', () => {
  // We test the buildSystemParam and injectConversationCacheBreakpoints methods
  // by accessing them through the provider's internal convertMessages + chat flow.
  // Since we can't call the real API, we verify the request structure.

  it('buildSystemParam returns string when cache is none', () => {
    const provider = new AnthropicProvider('test-key');
    // Access private method via casting
    const build = (provider as unknown as {
      buildSystemParam: (s: string, mode: 'none' | 'short' | 'long') => unknown;
    }).buildSystemParam;

    const result = build.call(provider, 'You are a helpful assistant.', 'none');
    assert.equal(typeof result, 'string');
    assert.equal(result, 'You are a helpful assistant.');
  });

  it('buildSystemParam returns array with cache_control when cache is short', () => {
    const provider = new AnthropicProvider('test-key');
    const build = (provider as unknown as {
      buildSystemParam: (s: string, mode: 'none' | 'short' | 'long') => unknown;
    }).buildSystemParam;

    const result = build.call(provider, 'System prompt here.', 'short') as Array<{ type: string; text: string; cache_control?: { type: string } }>;
    assert.ok(Array.isArray(result));
    assert.equal(result.length, 1);
    assert.equal(result[0].type, 'text');
    assert.equal(result[0].text, 'System prompt here.');
    assert.deepEqual(result[0].cache_control, { type: 'ephemeral' });
  });

  it('buildSystemParam returns array with cache_control when cache is long', () => {
    const provider = new AnthropicProvider('test-key');
    const build = (provider as unknown as {
      buildSystemParam: (s: string, mode: 'none' | 'short' | 'long') => unknown;
    }).buildSystemParam;

    const result = build.call(provider, 'Long prompt.', 'long') as Array<{ type: string; text: string; cache_control?: { type: string } }>;
    assert.ok(Array.isArray(result));
    assert.deepEqual(result[0].cache_control, { type: 'ephemeral' });
  });

  it('buildSystemParam returns empty string when system is empty', () => {
    const provider = new AnthropicProvider('test-key');
    const build = (provider as unknown as {
      buildSystemParam: (s: string, mode: 'none' | 'short' | 'long') => unknown;
    }).buildSystemParam;

    const result = build.call(provider, '', 'short');
    assert.equal(result, '');
  });

  it('injectConversationCacheBreakpoints adds cache_control to last user message', () => {
    const provider = new AnthropicProvider('test-key');
    const inject = (provider as unknown as {
      injectConversationCacheBreakpoints: (msgs: Array<{ role: string; content: unknown }>) => void;
    }).injectConversationCacheBreakpoints;

    const messages = [
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'First answer' },
      { role: 'user', content: 'Second question' },
    ];

    inject.call(provider, messages);

    // Last user message should be converted to array with cache_control
    const lastUser = messages[2];
    assert.ok(Array.isArray(lastUser.content));
    const blocks = lastUser.content as Array<{ type: string; text: string; cache_control?: { type: string } }>;
    assert.equal(blocks.length, 1);
    assert.equal(blocks[0].text, 'Second question');
    assert.deepEqual(blocks[0].cache_control, { type: 'ephemeral' });

    // First user message should NOT be modified
    assert.equal(typeof messages[0].content, 'string');
  });

  it('injectConversationCacheBreakpoints handles array content blocks', () => {
    const provider = new AnthropicProvider('test-key');
    const inject = (provider as unknown as {
      injectConversationCacheBreakpoints: (msgs: Array<{ role: string; content: unknown }>) => void;
    }).injectConversationCacheBreakpoints;

    const messages = [
      { role: 'user', content: [{ type: 'text', text: 'With image' }] },
    ];

    inject.call(provider, messages);

    const blocks = messages[0].content as Array<{ type: string; text: string; cache_control?: { type: string } }>;
    assert.deepEqual(blocks[0].cache_control, { type: 'ephemeral' });
  });

  it('getCacheStats returns initial zeros', () => {
    const provider = new AnthropicProvider('test-key');
    const stats = provider.getCacheStats();
    assert.equal(stats.cacheCreationTokens, 0);
    assert.equal(stats.cacheReadTokens, 0);
    assert.equal(stats.cacheHits, 0);
    assert.equal(stats.cacheMisses, 0);
  });

  it('updateCacheStats tracks hits and misses', () => {
    const provider = new AnthropicProvider('test-key');
    const update = (provider as unknown as {
      updateCacheStats: (creation: number, read: number) => void;
    }).updateCacheStats;

    // First call: cache miss (creation)
    update.call(provider, 5000, 0);
    let stats = provider.getCacheStats();
    assert.equal(stats.cacheCreationTokens, 5000);
    assert.equal(stats.cacheMisses, 1);
    assert.equal(stats.cacheHits, 0);

    // Second call: cache hit (read)
    update.call(provider, 0, 5000);
    stats = provider.getCacheStats();
    assert.equal(stats.cacheReadTokens, 5000);
    assert.equal(stats.cacheHits, 1);
    assert.equal(stats.cacheMisses, 1);

    // Third call: another cache hit
    update.call(provider, 0, 3000);
    stats = provider.getCacheStats();
    assert.equal(stats.cacheReadTokens, 8000);
    assert.equal(stats.cacheHits, 2);
  });

  it('config defaults have no cacheRetention', () => {
    // Verify that DEFAULT_CONFIG doesn't set cacheRetention
    // (it's an optional field, defaults to undefined/'none')
    const { DEFAULT_CONFIG } = require('../src/config/schema.js');
    assert.ok(!DEFAULT_CONFIG.providers.cacheRetention || DEFAULT_CONFIG.providers.cacheRetention === 'none');
  });
});
