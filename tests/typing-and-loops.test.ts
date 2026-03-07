/**
 * Tests for typing indicators and tool loop detection.
 */

import { describe, it, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import { TypingManager } from '../src/core/typing.js';
import { ToolLoopDetector } from '../src/core/tool-loop-detector.js';
import type { Channel } from '../src/channels/channel.js';

// ─── Helpers ─────────────────────────────────────────────────────────

/** Minimal Channel stub that records sendTyping calls. */
function makeChannel(): Channel & { typingCalls: string[] } {
  const typingCalls: string[] = [];
  return {
    id: 'test',
    typingCalls,
    async connect() {},
    async disconnect() {},
    async send() {},
    onMessage() {},
    async sendTyping(chatId: string) {
      typingCalls.push(chatId);
    },
  };
}

/** Channel without sendTyping support. */
function makeChannelNoTyping(): Channel {
  return {
    id: 'cli',
    async connect() {},
    async disconnect() {},
    async send() {},
    onMessage() {},
  };
}

// ─── TypingManager ───────────────────────────────────────────────────

describe('TypingManager', () => {
  it('sends typing immediately on start', () => {
    const manager = new TypingManager({ enabled: true, intervalMs: 50_000 });
    const channel = makeChannel();

    manager.start(channel, 'chat-1');
    assert.equal(channel.typingCalls.length, 1);
    assert.equal(channel.typingCalls[0], 'chat-1');

    manager.stopAll();
  });

  it('re-sends typing at interval', async () => {
    const manager = new TypingManager({ enabled: true, intervalMs: 50 });
    const channel = makeChannel();

    manager.start(channel, 'chat-1');
    assert.equal(channel.typingCalls.length, 1);

    // Wait for at least 2 intervals
    await new Promise((resolve) => setTimeout(resolve, 130));

    assert.ok(channel.typingCalls.length >= 3, `Expected >= 3 calls, got ${channel.typingCalls.length}`);

    manager.stopAll();
  });

  it('stop clears interval for specific chat', async () => {
    const manager = new TypingManager({ enabled: true, intervalMs: 50 });
    const channel = makeChannel();

    manager.start(channel, 'chat-1');
    manager.stop('chat-1');

    const countAfterStop = channel.typingCalls.length;

    // Wait to confirm no more calls
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(channel.typingCalls.length, countAfterStop);
  });

  it('stopAll clears all intervals', () => {
    const manager = new TypingManager({ enabled: true, intervalMs: 50 });
    const channel = makeChannel();

    manager.start(channel, 'chat-1');
    manager.start(channel, 'chat-2');
    manager.stopAll();

    // Verify both chats got initial typing call
    assert.ok(channel.typingCalls.includes('chat-1'));
    assert.ok(channel.typingCalls.includes('chat-2'));
  });

  it('does nothing when disabled', () => {
    const manager = new TypingManager({ enabled: false, intervalMs: 50 });
    const channel = makeChannel();

    manager.start(channel, 'chat-1');
    assert.equal(channel.typingCalls.length, 0);
  });

  it('handles channels without sendTyping gracefully', () => {
    const manager = new TypingManager({ enabled: true, intervalMs: 50 });
    const channel = makeChannelNoTyping();

    // Should not throw
    manager.start(channel, 'chat-1');
    manager.stop('chat-1');
  });

  it('replaces existing interval on re-start', () => {
    const manager = new TypingManager({ enabled: true, intervalMs: 50_000 });
    const channel = makeChannel();

    manager.start(channel, 'chat-1');
    manager.start(channel, 'chat-1'); // Should replace, not duplicate

    assert.equal(channel.typingCalls.length, 2); // Two immediate sends
    manager.stopAll();
  });
});

// ─── ToolLoopDetector ────────────────────────────────────────────────

describe('ToolLoopDetector', () => {
  let detector: ToolLoopDetector;

  beforeEach(() => {
    detector = new ToolLoopDetector({
      enabled: true,
      maxRepetitions: 3,
      maxSimilarCalls: 5,
      windowSize: 10,
    });
  });

  it('allows normal tool calls', () => {
    const result = detector.recordAndCheck('s1', 'read', { path: 'a.txt' });
    assert.equal(result, null);
  });

  it('detects identical tool calls (same tool + same args)', () => {
    const args = { path: '/foo/bar.txt' };
    assert.equal(detector.recordAndCheck('s1', 'read', args), null);
    assert.equal(detector.recordAndCheck('s1', 'read', args), null);

    const warning = detector.recordAndCheck('s1', 'read', args);
    assert.ok(warning !== null);
    assert.ok(warning!.includes('Tool loop detected'));
    assert.ok(warning!.includes('read'));
    assert.ok(warning!.includes('3 times'));
  });

  it('detects similar tool calls (same tool, different args)', () => {
    for (let i = 0; i < 4; i++) {
      assert.equal(detector.recordAndCheck('s1', 'exec', { command: `cmd-${i}` }), null);
    }

    const warning = detector.recordAndCheck('s1', 'exec', { command: 'cmd-4' });
    assert.ok(warning !== null);
    assert.ok(warning!.includes('exec'));
    assert.ok(warning!.includes('5 times'));
  });

  it('respects window size', () => {
    // Fill window with different tools to push old entries out
    const detector2 = new ToolLoopDetector({
      enabled: true,
      maxRepetitions: 3,
      maxSimilarCalls: 5,
      windowSize: 4,
    });

    const args = { path: 'test.txt' };
    detector2.recordAndCheck('s1', 'read', args);
    detector2.recordAndCheck('s1', 'read', args);
    // Insert different tools to push the window
    detector2.recordAndCheck('s1', 'write', { path: 'a' });
    detector2.recordAndCheck('s1', 'exec', { cmd: 'ls' });
    detector2.recordAndCheck('s1', 'list', {});

    // Old read calls should be out of window, this should NOT trigger
    const result = detector2.recordAndCheck('s1', 'read', args);
    assert.equal(result, null);
  });

  it('clears session history', () => {
    const args = { path: 'test.txt' };
    detector.recordAndCheck('s1', 'read', args);
    detector.recordAndCheck('s1', 'read', args);

    detector.clearSession('s1');

    // Should restart counting
    const result = detector.recordAndCheck('s1', 'read', args);
    assert.equal(result, null);
  });

  it('clear removes all sessions', () => {
    detector.recordAndCheck('s1', 'read', { path: 'a' });
    detector.recordAndCheck('s2', 'read', { path: 'b' });

    detector.clear();

    const stats1 = detector.stats('s1');
    const stats2 = detector.stats('s2');
    assert.equal(stats1.totalCalls, 0);
    assert.equal(stats2.totalCalls, 0);
  });

  it('tracks separate sessions independently', () => {
    const args = { path: 'test.txt' };

    detector.recordAndCheck('s1', 'read', args);
    detector.recordAndCheck('s1', 'read', args);
    detector.recordAndCheck('s2', 'read', args);

    // s1 has 2 calls, s2 has 1 — neither should trigger yet
    assert.equal(detector.recordAndCheck('s2', 'read', args), null);

    // s1 now hits 3 — should trigger
    const warning = detector.recordAndCheck('s1', 'read', args);
    assert.ok(warning !== null);
  });

  it('returns correct stats', () => {
    detector.recordAndCheck('s1', 'read', { path: 'a' });
    detector.recordAndCheck('s1', 'read', { path: 'b' });
    detector.recordAndCheck('s1', 'write', { path: 'c' });

    const stats = detector.stats('s1');
    assert.equal(stats.totalCalls, 3);
    assert.equal(stats.uniqueTools, 2);
    assert.equal(stats.repetitions.get('read'), 2);
    assert.equal(stats.repetitions.get('write'), 1);
  });

  it('does nothing when disabled', () => {
    const disabled = new ToolLoopDetector({ enabled: false });
    const args = { path: 'test.txt' };

    for (let i = 0; i < 10; i++) {
      assert.equal(disabled.recordAndCheck('s1', 'read', args), null);
    }
  });

  it('warning message format includes tool name and count', () => {
    const args = { q: 'search' };
    detector.recordAndCheck('s1', 'web_search', args);
    detector.recordAndCheck('s1', 'web_search', args);
    const warning = detector.recordAndCheck('s1', 'web_search', args);

    assert.ok(warning !== null);
    assert.ok(warning!.includes('`web_search`'));
    assert.ok(warning!.includes('identical arguments'));
  });
});
