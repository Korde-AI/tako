import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SharedSessionRegistry } from '../src/sessions/shared.js';

describe('shared sessions', () => {
  let root: string;

  beforeEach(async () => {
    root = join(tmpdir(), `tako-shared-sessions-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('creates and reloads shared sessions', async () => {
    const registry = new SharedSessionRegistry(root);
    await registry.load();
    const created = await registry.create({
      sessionId: 'session-1',
      agentId: 'main',
      projectId: 'project-1',
      projectSlug: 'alpha',
      ownerPrincipalId: 'principal-1',
      initialParticipantId: 'principal-1',
      binding: {
        platform: 'discord',
        channelId: 'discord:123',
        channelTarget: '123',
      },
    });

    const reloaded = new SharedSessionRegistry(root);
    await reloaded.load();
    assert.equal(reloaded.get(created.sharedSessionId)?.projectSlug, 'alpha');
    assert.equal(reloaded.findBySessionId('session-1')?.sharedSessionId, created.sharedSessionId);
  });

  it('reuses channel binding lookup and updates participants', async () => {
    const registry = new SharedSessionRegistry(root);
    await registry.load();
    const created = await registry.create({
      sessionId: 'session-1',
      agentId: 'main',
      projectId: 'project-1',
      ownerPrincipalId: 'principal-1',
      initialParticipantId: 'principal-1',
      binding: {
        platform: 'discord',
        channelId: 'discord:123',
        channelTarget: '123',
        threadId: '456',
      },
    });

    assert.equal(registry.findByBinding({
      projectId: 'project-1',
      platform: 'discord',
      channelTarget: '123',
      threadId: '456',
      agentId: 'main',
    })?.sharedSessionId, created.sharedSessionId);

    const touched = await registry.touchParticipant(created.sharedSessionId, 'principal-2');
    assert.deepEqual(touched.participantIds, ['principal-1', 'principal-2']);

    const active = await registry.setActiveParticipant(created.sharedSessionId, 'principal-2');
    assert.deepEqual(active.activeParticipantIds, ['principal-1', 'principal-2']);
  });
});
