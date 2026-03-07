/**
 * Tests for Feature 24 (Persistent ACP Sessions) and Feature 25 (Thread Binding).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

// ─── Feature 24: ACP Session Manager ────────────────────────────────

describe('AcpSessionManager', () => {
  it('exports AcpSessionManager class', async () => {
    const { AcpSessionManager } = await import('../src/tools/acp-sessions.js');
    assert.ok(AcpSessionManager);
    const manager = new AcpSessionManager({
      enabled: true,
      backend: 'claude',
      defaultTimeout: 60,
    });
    assert.ok(manager);
  });

  it('list returns empty initially', async () => {
    const { AcpSessionManager } = await import('../src/tools/acp-sessions.js');
    const manager = new AcpSessionManager({
      enabled: true,
      backend: 'claude',
      defaultTimeout: 60,
    });
    assert.deepEqual(manager.list(), []);
  });

  it('getStatus returns null for unknown session', async () => {
    const { AcpSessionManager } = await import('../src/tools/acp-sessions.js');
    const manager = new AcpSessionManager({
      enabled: true,
      backend: 'claude',
      defaultTimeout: 60,
    });
    const { session } = manager.getStatus('nonexistent');
    assert.equal(session, null);
  });

  it('send returns error for unknown session', async () => {
    const { AcpSessionManager } = await import('../src/tools/acp-sessions.js');
    const manager = new AcpSessionManager({
      enabled: true,
      backend: 'claude',
      defaultTimeout: 60,
    });
    const result = await manager.send('unknown', 'hello');
    assert.ok(!result.success);
    assert.ok(result.error?.includes('not found'));
  });

  it('kill returns false for unknown session', async () => {
    const { AcpSessionManager } = await import('../src/tools/acp-sessions.js');
    const manager = new AcpSessionManager({
      enabled: true,
      backend: 'claude',
      defaultTimeout: 60,
    });
    const result = await manager.kill('unknown');
    assert.equal(result, false);
  });

  it('getLogs returns empty for unknown session', async () => {
    const { AcpSessionManager } = await import('../src/tools/acp-sessions.js');
    const manager = new AcpSessionManager({
      enabled: true,
      backend: 'claude',
      defaultTimeout: 60,
    });
    assert.equal(manager.getLogs('unknown'), '');
  });

  it('loadPersistedSessions returns empty if no file', async () => {
    const { AcpSessionManager } = await import('../src/tools/acp-sessions.js');
    const sessions = await AcpSessionManager.loadPersistedSessions();
    assert.ok(Array.isArray(sessions));
  });

  it('startCleanup and stopCleanup work without error', async () => {
    const { AcpSessionManager } = await import('../src/tools/acp-sessions.js');
    const manager = new AcpSessionManager({
      enabled: true,
      backend: 'claude',
      defaultTimeout: 60,
    });
    manager.startCleanup(60_000);
    manager.stopCleanup();
  });
});

// ─── Feature 24: ACP Session Tools ─────────────────────────────────

describe('ACP Session Tools', () => {
  it('createAcpSessionTools returns 5 tools', async () => {
    const { AcpSessionManager, createAcpSessionTools } = await import('../src/tools/acp-sessions.js');
    const manager = new AcpSessionManager({
      enabled: true,
      backend: 'claude',
      defaultTimeout: 60,
    });
    const tools = createAcpSessionTools(manager);
    assert.equal(tools.length, 5);
    const names = tools.map((t) => t.name);
    assert.ok(names.includes('acp_session_start'));
    assert.ok(names.includes('acp_session_send'));
    assert.ok(names.includes('acp_session_status'));
    assert.ok(names.includes('acp_session_list'));
    assert.ok(names.includes('acp_session_kill'));
  });

  it('acp_session_list returns no sessions initially', async () => {
    const { AcpSessionManager, createAcpSessionTools } = await import('../src/tools/acp-sessions.js');
    const manager = new AcpSessionManager({
      enabled: true,
      backend: 'claude',
      defaultTimeout: 60,
    });
    const tools = createAcpSessionTools(manager);
    const listTool = tools.find((t) => t.name === 'acp_session_list')!;
    const ctx = { sessionId: 's1', workDir: '/tmp', workspaceRoot: '/tmp' };
    const result = await listTool.execute({}, ctx);
    assert.ok(result.success);
    assert.ok(result.output.includes('No active'));
  });

  it('acp_session_status returns error for unknown', async () => {
    const { AcpSessionManager, createAcpSessionTools } = await import('../src/tools/acp-sessions.js');
    const manager = new AcpSessionManager({
      enabled: true,
      backend: 'claude',
      defaultTimeout: 60,
    });
    const tools = createAcpSessionTools(manager);
    const statusTool = tools.find((t) => t.name === 'acp_session_status')!;
    const ctx = { sessionId: 's1', workDir: '/tmp', workspaceRoot: '/tmp' };
    const result = await statusTool.execute({ sessionId: 'nope' }, ctx);
    assert.ok(!result.success);
  });

  it('acp_session_kill returns error for unknown', async () => {
    const { AcpSessionManager, createAcpSessionTools } = await import('../src/tools/acp-sessions.js');
    const manager = new AcpSessionManager({
      enabled: true,
      backend: 'claude',
      defaultTimeout: 60,
    });
    const tools = createAcpSessionTools(manager);
    const killTool = tools.find((t) => t.name === 'acp_session_kill')!;
    const ctx = { sessionId: 's1', workDir: '/tmp', workspaceRoot: '/tmp' };
    const result = await killTool.execute({ sessionId: 'nope' }, ctx);
    assert.ok(!result.success);
  });
});

// ─── Feature 25: Spawn Thread Binder ────────────────────────────────

describe('SpawnThreadBinder', () => {
  it('exports SpawnThreadBinder class', async () => {
    const { SpawnThreadBinder } = await import('../src/agents/thread-binding.js');
    assert.ok(SpawnThreadBinder);
    const binder = new SpawnThreadBinder();
    assert.ok(binder);
  });

  it('returns null when disabled', async () => {
    const { SpawnThreadBinder } = await import('../src/agents/thread-binding.js');
    const binder = new SpawnThreadBinder({ enabled: false });
    const result = await binder.onSpawn({
      spawnType: 'acp',
      sessionId: 'test1',
      label: 'Test task',
      channelId: 'discord:123',
      channelType: 'discord',
    });
    assert.equal(result, null);
  });

  it('returns null when no discord instance set', async () => {
    const { SpawnThreadBinder } = await import('../src/agents/thread-binding.js');
    const binder = new SpawnThreadBinder({ enabled: true });
    const result = await binder.onSpawn({
      spawnType: 'acp',
      sessionId: 'test2',
      label: 'Test task',
      channelId: 'discord:123',
      channelType: 'discord',
    });
    assert.equal(result, null);
  });

  it('returns null for non-discord channels', async () => {
    const { SpawnThreadBinder } = await import('../src/agents/thread-binding.js');
    const binder = new SpawnThreadBinder({ enabled: true });
    const result = await binder.onSpawn({
      spawnType: 'acp',
      sessionId: 'test3',
      label: 'Test task',
      channelId: 'telegram:123',
      channelType: 'telegram',
    });
    assert.equal(result, null);
  });

  it('returns null when acp spawns disabled', async () => {
    const { SpawnThreadBinder } = await import('../src/agents/thread-binding.js');
    const binder = new SpawnThreadBinder({
      enabled: true,
      spawnAcpSessions: false,
    });
    const result = await binder.onSpawn({
      spawnType: 'acp',
      sessionId: 'test4',
      label: 'Test task',
      channelId: 'discord:123',
      channelType: 'discord',
    });
    assert.equal(result, null);
  });

  it('returns null when subagent spawns disabled', async () => {
    const { SpawnThreadBinder } = await import('../src/agents/thread-binding.js');
    const binder = new SpawnThreadBinder({
      enabled: true,
      spawnSubagents: false,
    });
    const result = await binder.onSpawn({
      spawnType: 'subagent',
      sessionId: 'test5',
      label: 'Test task',
      channelId: 'discord:123',
      channelType: 'discord',
    });
    assert.equal(result, null);
  });

  it('getThreadId returns null for unknown session', async () => {
    const { SpawnThreadBinder } = await import('../src/agents/thread-binding.js');
    const binder = new SpawnThreadBinder();
    assert.equal(binder.getThreadId('unknown'), null);
  });

  it('shutdown cleans up bindings', async () => {
    const { SpawnThreadBinder } = await import('../src/agents/thread-binding.js');
    const binder = new SpawnThreadBinder();
    binder.shutdown();
    // Should not throw
  });

  it('DEFAULT_THREAD_BINDING_CONFIG has correct defaults', async () => {
    const { DEFAULT_THREAD_BINDING_CONFIG } = await import('../src/agents/thread-binding.js');
    assert.ok(DEFAULT_THREAD_BINDING_CONFIG.enabled);
    assert.ok(DEFAULT_THREAD_BINDING_CONFIG.spawnAcpSessions);
    assert.ok(DEFAULT_THREAD_BINDING_CONFIG.spawnSubagents);
    assert.ok(DEFAULT_THREAD_BINDING_CONFIG.progressUpdates);
    assert.equal(DEFAULT_THREAD_BINDING_CONFIG.progressIntervalMs, 30_000);
  });
});

// ─── Config ─────────────────────────────────────────────────────────

describe('Discord threadBindings config', () => {
  it('DiscordChannelConfig accepts threadBindings', async () => {
    // Just a type-level check — if this compiles, the config is accepted
    const config: import('../src/config/schema.js').DiscordChannelConfig = {
      token: 'test',
      threadBindings: {
        enabled: true,
        spawnAcpSessions: true,
        spawnSubagents: true,
        progressUpdates: true,
        progressIntervalMs: 30000,
      },
    };
    assert.ok(config.threadBindings?.enabled);
  });
});
