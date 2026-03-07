/**
 * Sprint 3 tests — thinking control, reactions, gateway lock, secrets, timezone.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ThinkingManager, type ThinkingLevel } from '../src/core/thinking.js';
import { ReactionManager, type ReactionState } from '../src/core/reactions.js';
import { GatewayLock } from '../src/gateway/lock.js';
import { SecretsManager } from '../src/core/secrets.js';
import { TimezoneManager } from '../src/core/timezone.js';

// ─── ThinkingManager ────────────────────────────────────────────────

describe('ThinkingManager', () => {
  it('returns default level when no session override', () => {
    const tm = new ThinkingManager({ default: 'high' });
    assert.equal(tm.getLevel('session-1'), 'high');
  });

  it('returns session override when set', () => {
    const tm = new ThinkingManager({ default: 'medium' });
    tm.setLevel('session-1', 'xhigh');
    assert.equal(tm.getLevel('session-1'), 'xhigh');
    assert.equal(tm.getLevel('session-2'), 'medium');
  });

  it('clears session override', () => {
    const tm = new ThinkingManager({ default: 'low' });
    tm.setLevel('s1', 'high');
    tm.clearSession('s1');
    assert.equal(tm.getLevel('s1'), 'low');
  });

  it('uses model defaults when no session override', () => {
    const tm = new ThinkingManager({
      default: 'medium',
      modelDefaults: { 'openai/': 'low', 'anthropic/claude-opus': 'xhigh' },
    });
    assert.equal(tm.getLevel('s1', 'openai/gpt-4'), 'low');
    assert.equal(tm.getLevel('s1', 'anthropic/claude-opus-4'), 'xhigh');
    assert.equal(tm.getLevel('s1', 'anthropic/claude-sonnet-4-6'), 'medium');
  });

  it('converts to Anthropic provider params', () => {
    const tm = new ThinkingManager();
    const params = tm.toProviderParams('high', 'anthropic');
    assert.deepEqual(params, {
      thinking: { type: 'enabled', budget_tokens: 25600 },
    });
  });

  it('converts to Anthropic off params', () => {
    const tm = new ThinkingManager();
    const params = tm.toProviderParams('off', 'anthropic');
    assert.deepEqual(params, {});
  });

  it('converts to OpenAI provider params', () => {
    const tm = new ThinkingManager();
    assert.deepEqual(tm.toProviderParams('low', 'openai'), { reasoning_effort: 'low' });
    assert.deepEqual(tm.toProviderParams('medium', 'openai'), { reasoning_effort: 'medium' });
    assert.deepEqual(tm.toProviderParams('xhigh', 'openai'), { reasoning_effort: 'high' });
  });

  it('returns empty params for unknown provider', () => {
    const tm = new ThinkingManager();
    assert.deepEqual(tm.toProviderParams('high', 'litellm'), {});
  });
});

// ─── ReactionManager ────────────────────────────────────────────────

describe('ReactionManager', () => {
  it('calls addReaction on channel', async () => {
    const calls: Array<{ chatId: string; messageId: string; emoji: string }> = [];
    const channel = {
      id: 'test',
      connect: async () => {},
      disconnect: async () => {},
      send: async () => {},
      onMessage: () => {},
      addReaction: async (chatId: string, messageId: string, emoji: string) => {
        calls.push({ chatId, messageId, emoji });
      },
    };

    const rm = new ReactionManager();
    await rm.react(channel, 'chat-1', 'msg-1', 'received');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].emoji, '👀');
  });

  it('calls removeReaction on channel', async () => {
    const calls: Array<{ emoji: string }> = [];
    const channel = {
      id: 'test',
      connect: async () => {},
      disconnect: async () => {},
      send: async () => {},
      onMessage: () => {},
      removeReaction: async (_chatId: string, _messageId: string, emoji: string) => {
        calls.push({ emoji });
      },
    };

    const rm = new ReactionManager();
    await rm.unreact(channel, 'chat-1', 'msg-1', 'processing');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].emoji, '⏳');
  });

  it('transitions between states', async () => {
    const added: string[] = [];
    const removed: string[] = [];
    const channel = {
      id: 'test',
      connect: async () => {},
      disconnect: async () => {},
      send: async () => {},
      onMessage: () => {},
      addReaction: async (_c: string, _m: string, emoji: string) => { added.push(emoji); },
      removeReaction: async (_c: string, _m: string, emoji: string) => { removed.push(emoji); },
    };

    const rm = new ReactionManager();
    await rm.transition(channel, 'c', 'm', 'processing', 'completed');
    assert.deepEqual(removed, ['⏳']);
    assert.deepEqual(added, ['✅']);
  });

  it('skips reaction when channel lacks addReaction', async () => {
    const channel = {
      id: 'test',
      connect: async () => {},
      disconnect: async () => {},
      send: async () => {},
      onMessage: () => {},
    };

    const rm = new ReactionManager();
    await rm.react(channel, 'c', 'm', 'received'); // Should not throw
  });

  it('skips reaction when disabled', async () => {
    const calls: string[] = [];
    const channel = {
      id: 'test',
      connect: async () => {},
      disconnect: async () => {},
      send: async () => {},
      onMessage: () => {},
      addReaction: async (_c: string, _m: string, emoji: string) => { calls.push(emoji); },
    };

    const rm = new ReactionManager({ enabled: false });
    await rm.react(channel, 'c', 'm', 'received');
    assert.equal(calls.length, 0);
  });

  it('returns correct emoji for each state', () => {
    const rm = new ReactionManager();
    assert.equal(rm.getEmoji('received'), '👀');
    assert.equal(rm.getEmoji('processing'), '⏳');
    assert.equal(rm.getEmoji('completed'), '✅');
    assert.equal(rm.getEmoji('failed'), '❌');
    assert.equal(rm.getEmoji('retrying'), '🔄');
    assert.equal(rm.getEmoji('thinking'), '🤔');
  });
});

// ─── GatewayLock ────────────────────────────────────────────────────

describe('GatewayLock', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'tako-lock-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('acquires lock when no other instance running', async () => {
    const lock = new GatewayLock(tmpDir);
    const acquired = await lock.acquire();
    assert.equal(acquired, true);

    // Lock file should contain our PID
    const content = await readFile(join(tmpDir, 'tako.lock'), 'utf-8');
    assert.equal(content, String(process.pid));

    await lock.release();
  });

  it('releases lock and allows re-acquisition', async () => {
    const lock = new GatewayLock(tmpDir);
    await lock.acquire();
    await lock.release();

    const lock2 = new GatewayLock(tmpDir);
    const acquired = await lock2.acquire();
    assert.equal(acquired, true);
    await lock2.release();
  });

  it('reports locked status with PID', async () => {
    const lock = new GatewayLock(tmpDir);
    await lock.acquire();

    const status = await lock.isLocked();
    assert.equal(status.locked, true);
    assert.equal(status.pid, process.pid);

    await lock.release();
  });

  it('detects stale lock (dead PID)', async () => {
    const lock = new GatewayLock(tmpDir);
    // Write a fake PID that isn't running (99999999 is unlikely)
    const { writeFile: wf } = await import('node:fs/promises');
    await wf(join(tmpDir, 'tako.lock'), '99999999', 'utf-8');

    const status = await lock.isLocked();
    assert.equal(status.locked, false);
    assert.equal(status.pid, 99999999);

    // Should be able to acquire after stale lock
    const acquired = await lock.acquire();
    assert.equal(acquired, true);
    await lock.release();
  });

  it('force-breaks a lock', async () => {
    const lock = new GatewayLock(tmpDir);
    await lock.acquire();

    const lock2 = new GatewayLock(tmpDir);
    await lock2.forceBreak();

    const status = await lock2.isLocked();
    assert.equal(status.locked, false);
  });
});

// ─── SecretsManager ─────────────────────────────────────────────────

describe('SecretsManager', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'tako-secrets-'));
  });

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('set and get a secret', async () => {
    const sm = new SecretsManager({ backend: 'file', path: join(tmpDir, 'secrets.enc') });
    await sm.set('API_KEY', 'sk-test-12345');
    const value = await sm.get('API_KEY');
    assert.equal(value, 'sk-test-12345');
  });

  it('returns undefined for missing secret', async () => {
    const sm = new SecretsManager({ backend: 'file', path: join(tmpDir, 'secrets.enc') });
    const value = await sm.get('MISSING');
    assert.equal(value, undefined);
  });

  it('deletes a secret', async () => {
    const sm = new SecretsManager({ backend: 'file', path: join(tmpDir, 'secrets.enc') });
    await sm.set('KEY', 'value');
    await sm.delete('KEY');
    const value = await sm.get('KEY');
    assert.equal(value, undefined);
  });

  it('lists secret keys', async () => {
    const sm = new SecretsManager({ backend: 'file', path: join(tmpDir, 'secrets.enc') });
    await sm.set('KEY_A', 'value-a');
    await sm.set('KEY_B', 'value-b');
    const keys = await sm.list();
    assert.deepEqual(keys.sort(), ['KEY_A', 'KEY_B']);
  });

  it('masks secrets in text after preload', async () => {
    const sm = new SecretsManager({ backend: 'file', path: join(tmpDir, 'secrets.enc') });
    await sm.set('TOKEN', 'abcdef123456');
    await sm.preload();

    const masked = sm.mask('My token is abcdef123456, keep it safe');
    assert.ok(!masked.includes('abcdef123456'));
    assert.ok(masked.includes('ab***56'));
  });

  it('provides env injection after preload', async () => {
    const sm = new SecretsManager({ backend: 'file', path: join(tmpDir, 'secrets.enc') });
    await sm.set('API_KEY', 'sk-test');
    await sm.preload();

    const env = sm.toEnv();
    assert.equal(env['API_KEY'], 'sk-test');
  });

  it('works with env backend', async () => {
    const sm = new SecretsManager({ backend: 'env' });
    await sm.set('TAKO_TEST_SECRET', 'env-value');
    const value = await sm.get('TAKO_TEST_SECRET');
    assert.equal(value, 'env-value');
    // Clean up
    await sm.delete('TAKO_TEST_SECRET');
  });
});

// ─── TimezoneManager ────────────────────────────────────────────────

describe('TimezoneManager', () => {
  it('auto-detects system timezone by default', () => {
    const tm = new TimezoneManager();
    const tz = tm.getTimezone();
    // Should be a valid IANA timezone string
    assert.ok(tz.includes('/') || tz === 'UTC', `Expected IANA timezone, got: ${tz}`);
  });

  it('uses configured timezone', () => {
    const tm = new TimezoneManager({ timezone: 'Asia/Riyadh' });
    assert.equal(tm.getTimezone(), 'Asia/Riyadh');
  });

  it('falls back to UTC when autoDetect is false', () => {
    const tm = new TimezoneManager({ autoDetect: false });
    assert.equal(tm.getTimezone(), 'UTC');
  });

  it('formats date in specified timezone', () => {
    const tm = new TimezoneManager({ timezone: 'UTC' });
    const date = new Date('2026-03-07T14:30:00Z');
    const formatted = tm.format(date, 'time');
    assert.ok(formatted.includes('2:30'), `Expected 2:30, got: ${formatted}`);
  });

  it('formats date-only', () => {
    const tm = new TimezoneManager({ timezone: 'UTC' });
    const date = new Date('2026-03-07T14:30:00Z');
    const formatted = tm.format(date, 'date');
    assert.ok(formatted.includes('March'), `Expected March in date, got: ${formatted}`);
    assert.ok(formatted.includes('2026'), `Expected 2026 in date, got: ${formatted}`);
  });

  it('generates context string for prompt injection', () => {
    const tm = new TimezoneManager({ timezone: 'Asia/Riyadh' });
    const ctx = tm.getContextString();
    assert.ok(ctx.startsWith('Current date/time:'), `Expected prefix, got: ${ctx}`);
    assert.ok(ctx.includes('Asia/Riyadh'), `Expected timezone in context, got: ${ctx}`);
  });

  it('formats ISO string', () => {
    const tm = new TimezoneManager({ timezone: 'UTC' });
    const date = new Date('2026-03-07T14:30:00Z');
    const formatted = tm.format(date, 'iso');
    assert.ok(formatted.includes('2026-03-07'), `Expected ISO date, got: ${formatted}`);
  });

  it('getCurrentTime returns non-empty string', () => {
    const tm = new TimezoneManager({ timezone: 'UTC' });
    const time = tm.getCurrentTime();
    assert.ok(time.length > 0);
  });
});
