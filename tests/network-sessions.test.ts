import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { NetworkSharedSessionStore } from '../src/network/shared-sessions.js';

describe('network shared session store', () => {
  let root: string;

  beforeEach(async () => {
    root = join(tmpdir(), `tako-network-sessions-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('creates, binds, and persists network sessions and events', async () => {
    const store = new NetworkSharedSessionStore(join(root, 'network-sessions.json'), join(root, 'network-events.json'));
    await store.load();
    const session = await store.create({
      projectId: 'project-1',
      projectSlug: 'alpha',
      hostNodeId: 'edge-a',
      collaboration: { autoArtifactSync: true },
      participantNodeIds: ['edge-a', 'edge-b'],
    });
    await store.bindLocalSession({
      networkSessionId: session.networkSessionId,
      nodeId: 'edge-a',
      localSessionId: 'local-1',
      sharedSessionId: 'shared-1',
    });
    await store.appendEvent({
      eventId: 'event-1',
      networkSessionId: session.networkSessionId,
      projectId: 'project-1',
      fromNodeId: 'edge-a',
      fromPrincipalId: 'principal-a',
      type: 'message',
      audience: 'session-participants',
      payload: { text: 'hello' },
      createdAt: new Date().toISOString(),
    }, 'sent');

    const reloaded = new NetworkSharedSessionStore(join(root, 'network-sessions.json'), join(root, 'network-events.json'));
    await reloaded.load();
    assert.equal(reloaded.findByLocalSessionId('local-1')?.networkSessionId, session.networkSessionId);
    assert.equal(reloaded.findBySharedSessionId('shared-1')?.networkSessionId, session.networkSessionId);
    assert.equal(reloaded.listEvents(session.networkSessionId).length, 1);
    assert.equal(reloaded.get(session.networkSessionId)?.collaboration?.autoArtifactSync, true);
  });
});
