import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { HubStateStore } from '../src/hub/state.js';
import { HubRegistry } from '../src/hub/registry.js';

describe('hub registry', () => {
  let root: string;
  let registry: HubRegistry;

  beforeEach(async () => {
    root = join(tmpdir(), `tako-hub-registry-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await mkdir(root, { recursive: true });
    const state = new HubStateStore(root);
    await state.load();
    registry = new HubRegistry(state);
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('registers nodes and updates heartbeat', async () => {
    const node = await registry.registerNode({
      nodeId: 'edge-1',
      mode: 'edge',
      name: 'edge-1',
      capabilities: { projects: true },
    });
    assert.equal(node.status, 'online');
    const beat = await registry.heartbeat('edge-1');
    assert.equal(beat?.nodeId, 'edge-1');
  });

  it('registers projects and resolves routes by id and slug', async () => {
    await registry.registerNode({
      nodeId: 'edge-1',
      mode: 'edge',
      name: 'edge-1',
      capabilities: { projects: true },
    });
    await registry.registerProject({
      projectId: 'project-1',
      slug: 'alpha',
      displayName: 'Alpha',
      ownerPrincipalId: 'principal-1',
      hostNodeId: 'edge-1',
      status: 'active',
      updatedAt: new Date().toISOString(),
    });
    assert.deepEqual(registry.resolveProjectRoute('project-1'), { projectId: 'project-1', hostNodeId: 'edge-1' });
    assert.deepEqual(registry.resolveProjectRoute('alpha'), { projectId: 'project-1', hostNodeId: 'edge-1' });
  });

  it('rejects conflicting project hosts', async () => {
    await registry.registerNode({
      nodeId: 'edge-1',
      mode: 'edge',
      name: 'edge-1',
      capabilities: { projects: true },
    });
    await registry.registerProject({
      projectId: 'project-1',
      slug: 'alpha',
      displayName: 'Alpha',
      ownerPrincipalId: 'principal-1',
      hostNodeId: 'edge-1',
      status: 'active',
      updatedAt: new Date().toISOString(),
    });
    await assert.rejects(() => registry.registerProject({
      projectId: 'project-1',
      slug: 'alpha',
      displayName: 'Alpha',
      ownerPrincipalId: 'principal-1',
      hostNodeId: 'edge-2',
      status: 'active',
      updatedAt: new Date().toISOString(),
    }), /host conflict/);
  });
});
