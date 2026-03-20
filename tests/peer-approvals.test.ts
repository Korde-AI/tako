import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { PeerTaskApprovalRegistry } from '../src/core/peer-approvals.js';

describe('PeerTaskApprovalRegistry', () => {
  it('reuses pending approvals for the same session and tool call', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tako-peer-approvals-'));
    const registry = new PeerTaskApprovalRegistry(join(root, 'peer-task-approvals.json'));
    await registry.load();

    const first = await registry.createOrReuse({
      sessionId: 'session-1',
      agentId: 'agent-a',
      toolName: 'write',
      toolArgs: { path: 'README.md', content: 'hello' },
      originalUserMessage: 'please update the file',
      resumePrompt: 'resume',
    });
    const second = await registry.createOrReuse({
      sessionId: 'session-1',
      agentId: 'agent-a',
      toolName: 'write',
      toolArgs: { path: 'README.md', content: 'hello' },
      originalUserMessage: 'please update the file',
      resumePrompt: 'resume',
    });

    assert.equal(first.reused, false);
    assert.equal(second.reused, true);
    assert.equal(first.approval.approvalId, second.approval.approvalId);

    await rm(root, { recursive: true, force: true });
  });

  it('consumes an approved grant exactly once', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tako-peer-approvals-'));
    const registry = new PeerTaskApprovalRegistry(join(root, 'peer-task-approvals.json'));
    await registry.load();

    const created = await registry.createOrReuse({
      sessionId: 'session-2',
      agentId: 'agent-b',
      toolName: 'exec',
      toolArgs: { command: 'pwd' },
      originalUserMessage: 'run pwd',
      resumePrompt: 'resume',
    });
    await registry.resolve(created.approval.approvalId, 'approved');

    const firstUse = await registry.consumeApproved('session-2', 'agent-b', 'exec', { command: 'pwd' });
    const secondUse = await registry.consumeApproved('session-2', 'agent-b', 'exec', { command: 'pwd' });

    assert.ok(firstUse);
    assert.equal(firstUse?.status, 'executed');
    assert.equal(secondUse, null);

    await rm(root, { recursive: true, force: true });
  });

  it('marks an approved request as executed after direct replay', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tako-peer-approvals-'));
    const registry = new PeerTaskApprovalRegistry(join(root, 'peer-task-approvals.json'));
    await registry.load();

    const created = await registry.createOrReuse({
      sessionId: 'session-3',
      agentId: 'agent-c',
      toolName: 'message',
      toolArgs: { action: 'send', platform: 'discord', target: 'current', message: 'hello' },
      originalUserMessage: 'tell the room hello',
      resumePrompt: 'resume',
    });
    await registry.resolve(created.approval.approvalId, 'approved');
    const executed = await registry.markExecuted(created.approval.approvalId);

    assert.equal(executed.status, 'executed');
    assert.equal(registry.get(created.approval.approvalId)?.status, 'executed');

    await rm(root, { recursive: true, force: true });
  });
});
