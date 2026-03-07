/**
 * Tests for features 10-17:
 * - Audit Logging
 * - Cron enhancements
 * - Agent Communication
 * - Spawn Agent tool
 * - ACP tool
 * - Browser tools
 * - Marketplace
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, mkdir, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ─── 1. Audit Logger tests ──────────────────────────────────────────

import { AuditLogger, type AuditEntry } from '../src/core/audit.js';

describe('AuditLogger', () => {
  let logger: AuditLogger;
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `tako-audit-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    logger = new AuditLogger(
      { enabled: true, maxFileSizeMb: 10, retention: '30d' },
      testDir,
    );
  });

  afterEach(async () => {
    await logger.dispose();
    await rm(testDir, { recursive: true, force: true });
  });

  it('logs and queries entries', async () => {
    await logger.logToolCall('main', 'session-1', 'read', { path: '/test.txt' }, true, 10);
    await logger.flush();

    const entries = await logger.query({});
    assert.equal(entries.length, 1);
    assert.equal(entries[0].event, 'tool_call');
    assert.equal(entries[0].action, 'read');
    assert.equal(entries[0].success, true);
  });

  it('filters by agent', async () => {
    await logger.logToolCall('agent-a', 'session-1', 'read', {}, true);
    await logger.logToolCall('agent-b', 'session-2', 'write', {}, true);
    await logger.flush();

    const entries = await logger.query({ agentId: 'agent-a' });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].agentId, 'agent-a');
  });

  it('filters by event type', async () => {
    await logger.logToolCall('main', 's1', 'exec', {}, true);
    await logger.logFileModify('main', 's1', '/foo.txt', 'create', true);
    await logger.flush();

    const entries = await logger.query({ event: 'file_modify' });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].event, 'file_modify');
  });

  it('respects tail limit', async () => {
    for (let i = 0; i < 10; i++) {
      await logger.logToolCall('main', 's1', `tool-${i}`, {}, true);
    }
    await logger.flush();

    const entries = await logger.query({ tail: 3 });
    assert.equal(entries.length, 3);
  });

  it('disabled logger does not write', async () => {
    const disabled = new AuditLogger(
      { enabled: false, maxFileSizeMb: 10, retention: '30d' },
      testDir,
    );
    await disabled.logToolCall('main', 's1', 'read', {}, true);
    await disabled.flush();

    const entries = await disabled.query({});
    assert.equal(entries.length, 0);
    await disabled.dispose();
  });

  it('logs security events', async () => {
    await logger.logSecurityEvent('main', 's1', 'permission_denied', 'exec', { command: 'rm -rf /' });
    await logger.flush();

    const entries = await logger.query({ event: 'permission_denied' });
    assert.equal(entries.length, 1);
    assert.equal(entries[0].success, false);
  });

  it('logAgentRun records model and tokens', async () => {
    await logger.logAgentRun('main', 's1', 'claude-sonnet-4-6', 5000, 1200, true);
    await logger.flush();

    const entries = await logger.query({ event: 'agent_run' });
    assert.equal(entries.length, 1);
    assert.equal((entries[0].details as any).model, 'claude-sonnet-4-6');
    assert.equal((entries[0].details as any).tokensUsed, 5000);
  });
});

// ─── 2. Cron run persistence tests ──────────────────────────────────

import { CronScheduler, type CronJob } from '../src/core/cron.js';

describe('CronScheduler run persistence', () => {
  let scheduler: CronScheduler;
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `tako-cron-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    scheduler = new CronScheduler(testDir);
  });

  afterEach(async () => {
    scheduler.stop();
    await rm(testDir, { recursive: true, force: true });
  });

  it('persists run results to disk', async () => {
    await scheduler.start();
    scheduler.stop();

    // Add a system-event job
    const job = await scheduler.add({
      name: 'test-job',
      enabled: true,
      schedule: { kind: 'at', at: new Date(Date.now() - 1000).toISOString() },
      payload: { kind: 'system-event', text: 'test event' },
    });

    // Run it
    scheduler.setHandlers({
      systemEvent: (text) => { /* noop */ },
    });
    const result = await scheduler.run(job.id);
    assert.ok(result);
    assert.equal(result.jobId, job.id);

    // Check run history
    const history = await scheduler.getRunHistory(job.id);
    assert.equal(history.length, 1);
    assert.equal(history[0].jobName, 'test-job');
  });

  it('getRunHistory returns empty for unknown job', async () => {
    await scheduler.start();
    scheduler.stop();
    const history = await scheduler.getRunHistory('nonexistent');
    assert.equal(history.length, 0);
  });
});

// ─── 3. Agent Communication tests ───────────────────────────────────

import { AgentComms } from '../src/agents/communication.js';

describe('AgentComms', () => {
  let comms: AgentComms;
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `tako-comms-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    comms = new AgentComms({ enabled: true }, testDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('sends and receives messages', async () => {
    comms.setHandler(async (toAgent, msg) => {
      return `Hello from ${toAgent}, received: ${msg.content}`;
    });

    const response = await comms.send('agent-a', 'agent-b', 'hi there');
    assert.ok(response.includes('Hello from agent-b'));
    assert.ok(response.includes('hi there'));
  });

  it('persists message history', async () => {
    comms.setHandler(async () => 'ok');
    await comms.send('agent-a', 'agent-b', 'first message');

    const history = await comms.getHistory('agent-a', 'agent-b');
    assert.ok(history.length >= 2); // original + reply
    assert.equal(history[0].content, 'first message');
  });

  it('rejects disabled communication', async () => {
    const disabledComms = new AgentComms({ enabled: false }, testDir);
    await assert.rejects(
      () => disabledComms.send('a', 'b', 'msg'),
      /disabled/,
    );
  });

  it('enforces allow list', async () => {
    const restricted = new AgentComms(
      { enabled: true, allowList: { 'agent-a': ['agent-b'] } },
      testDir,
    );
    restricted.setHandler(async () => 'ok');

    // agent-a → agent-b: allowed
    await restricted.send('agent-a', 'agent-b', 'hi');

    // agent-a → agent-c: blocked
    await assert.rejects(
      () => restricted.send('agent-a', 'agent-c', 'hi'),
      /not allowed/,
    );
  });

  it('throws when no handler set', async () => {
    await assert.rejects(
      () => comms.send('a', 'b', 'hi'),
      /handler/,
    );
  });
});

// ─── 4. Browser tools config test ───────────────────────────────────

import { createBrowserTools } from '../src/tools/browser.js';

describe('Browser tools', () => {
  it('creates 6 browser tools', () => {
    const tools = createBrowserTools({
      enabled: true,
      headless: true,
      idleTimeoutMs: 300000,
    });
    assert.equal(tools.length, 6);
    const names = tools.map((t) => t.name);
    assert.ok(names.includes('browser_navigate'));
    assert.ok(names.includes('browser_snapshot'));
    assert.ok(names.includes('browser_screenshot'));
    assert.ok(names.includes('browser_click'));
    assert.ok(names.includes('browser_type'));
    assert.ok(names.includes('browser_evaluate'));
  });

  it('returns error when disabled', async () => {
    const tools = createBrowserTools({
      enabled: false,
      headless: true,
      idleTimeoutMs: 300000,
    });
    const ctx = { sessionId: 's1', workDir: '/tmp', workspaceRoot: '/tmp' };
    const result = await tools[0].execute({ url: 'https://example.com' }, ctx);
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('disabled'));
  });
});

// ─── 5. ACP tool config test ────────────────────────────────────────

import { createAcpTool } from '../src/tools/acp.js';

describe('ACP tool', () => {
  it('creates acp_spawn tool', () => {
    const tools = createAcpTool({
      enabled: true,
      backend: 'claude',
      defaultTimeout: 600,
    });
    assert.equal(tools.length, 1);
    assert.equal(tools[0].name, 'acp_spawn');
  });

  it('returns error when disabled', async () => {
    const tools = createAcpTool({
      enabled: false,
      backend: 'claude',
      defaultTimeout: 600,
    });
    const ctx = { sessionId: 's1', workDir: '/tmp', workspaceRoot: '/tmp' };
    const result = await tools[0].execute({ task: 'test' }, ctx);
    assert.equal(result.success, false);
    assert.ok(result.error?.includes('disabled'));
  });
});

// ─── 6. Marketplace tests ───────────────────────────────────────────

import { SkillMarketplace } from '../src/skills/marketplace.js';

describe('SkillMarketplace', () => {
  let marketplace: SkillMarketplace;
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `tako-market-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    marketplace = new SkillMarketplace(testDir);
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('list returns empty initially', async () => {
    const skills = await marketplace.list();
    assert.equal(skills.length, 0);
  });

  it('info returns null for unknown skill', async () => {
    const info = await marketplace.info('nonexistent');
    assert.equal(info, null);
  });

  it('remove returns false for unknown skill', async () => {
    const removed = await marketplace.remove('nonexistent');
    assert.equal(removed, false);
  });
});

// ─── 7. Config integration tests ────────────────────────────────────

import { DEFAULT_CONFIG } from '../src/config/schema.js';

describe('Config defaults', () => {
  it('has audit config with defaults', () => {
    assert.equal(DEFAULT_CONFIG.audit.enabled, true);
    assert.equal(DEFAULT_CONFIG.audit.maxFileSizeMb, 10);
    assert.equal(DEFAULT_CONFIG.audit.retention, '30d');
  });
});
