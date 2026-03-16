import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { HubStateStore } from '../src/hub/state.js';

describe('hub state', () => {
  let root: string;

  beforeEach(async () => {
    root = join(tmpdir(), `tako-hub-state-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('persists nodes, projects, memberships, and routes', async () => {
    const state = new HubStateStore(root);
    await state.load();
    await state.upsertNode({
      nodeId: 'edge-1',
      mode: 'edge',
      name: 'edge-1',
      status: 'online',
      capabilities: { projects: true },
      registeredAt: new Date().toISOString(),
      lastSeenAt: new Date().toISOString(),
    });
    await state.upsertProject({
      projectId: 'project-1',
      slug: 'alpha',
      displayName: 'Alpha',
      ownerPrincipalId: 'principal-1',
      hostNodeId: 'edge-1',
      status: 'active',
      updatedAt: new Date().toISOString(),
    });
    await state.replaceMembershipsForProject('project-1', [{
      projectId: 'project-1',
      principalId: 'principal-1',
      role: 'admin',
      hostNodeId: 'edge-1',
      updatedAt: new Date().toISOString(),
    }]);

    const reloaded = new HubStateStore(root);
    await reloaded.load();
    assert.equal(reloaded.getNode('edge-1')?.nodeId, 'edge-1');
    assert.equal(reloaded.getProject('project-1')?.slug, 'alpha');
    assert.equal(reloaded.listMemberships('project-1').length, 1);
    assert.equal(reloaded.getRoute('project-1')?.hostNodeId, 'edge-1');
  });
});
