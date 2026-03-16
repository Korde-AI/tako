import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { HubRelay } from '../src/hub/relay.js';

describe('hub relay', () => {
  let root: string;

  beforeEach(async () => {
    root = join(tmpdir(), `tako-hub-relay-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('queues and acknowledges pending network session events', async () => {
    const relay = new HubRelay(join(root, 'sessions.json'), join(root, 'pending-events.json'));
    await relay.load();
    const session = await relay.createOrJoinSession({
      projectId: 'project-1',
      projectSlug: 'alpha',
      hostNodeId: 'edge-a',
      participantNodeIds: ['edge-a', 'edge-b'],
    });
    await relay.enqueueEvent({
      eventId: 'event-1',
      networkSessionId: session.networkSessionId,
      projectId: 'project-1',
      fromNodeId: 'edge-a',
      fromPrincipalId: 'principal-a',
      type: 'message',
      audience: 'session-participants',
      payload: { text: 'hello' },
      createdAt: new Date().toISOString(),
    });

    const pending = await relay.fetchPending('edge-b');
    assert.equal(pending.length, 1);
    assert.equal(pending[0]?.eventId, 'event-1');

    const acked = await relay.ackEvent('edge-b', 'event-1');
    assert.equal(acked, true);
    assert.equal((await relay.fetchPending('edge-b')).length, 0);
  });
});
