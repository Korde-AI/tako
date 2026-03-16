import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { setRuntimePaths } from '../src/core/paths.js';
import { loadOrCreateNodeIdentity } from '../src/core/node-identity.js';
import { ProjectRegistry } from '../src/projects/registry.js';
import { ProjectMembershipRegistry } from '../src/projects/memberships.js';
import {
  createHubClientFromConfig,
  registerNodeWithHub,
  syncAllProjectsToHub,
} from '../src/network/sync.js';
import type { TakoConfig } from '../src/config/schema.js';

describe('network sync', () => {
  let edgeHome: string;

  beforeEach(async () => {
    edgeHome = join(tmpdir(), `tako-edge-sync-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await mkdir(edgeHome, { recursive: true });
  });

  afterEach(async () => {
    await rm(edgeHome, { recursive: true, force: true });
  });

  it('registers an edge and syncs projects and memberships through the client seam', async () => {
    setRuntimePaths({ home: edgeHome, mode: 'edge' });
    const identity = await loadOrCreateNodeIdentity({
      mode: 'edge',
      home: edgeHome,
      bind: '127.0.0.1',
      port: 21893,
      hub: 'hub.example.com:18790',
    });
    const projects = new ProjectRegistry(join(edgeHome, 'projects'));
    const memberships = new ProjectMembershipRegistry(join(edgeHome, 'projects'));
    await projects.load();
    await memberships.load();
    const project = await projects.create({
      slug: 'alpha',
      displayName: 'Alpha',
      ownerPrincipalId: 'principal-1',
    });
    await memberships.upsert({
      projectId: project.projectId,
      principalId: 'principal-1',
      role: 'admin',
      addedBy: 'principal-1',
    });

    const config = {
      network: { enabled: true, hub: 'hub.example.com:18790', heartbeatSeconds: 30 },
    } as TakoConfig;
    const realClient = createHubClientFromConfig(config);
    assert.ok(realClient);

    const calls: Record<string, unknown[]> = {
      registerNode: [],
      registerProject: [],
      registerProjectMemberships: [],
    };
    const mockClient = {
      registerNode: async (payload: unknown) => { calls.registerNode.push(payload); },
      registerProject: async (payload: unknown) => { calls.registerProject.push(payload); },
      registerProjectMemberships: async (...payload: unknown[]) => { calls.registerProjectMemberships.push(payload); },
    };

    await registerNodeWithHub(mockClient as any, identity);
    await syncAllProjectsToHub(mockClient as any, identity, projects, memberships);

    assert.equal(calls.registerNode.length, 1);
    assert.equal(calls.registerProject.length, 1);
    assert.equal(calls.registerProjectMemberships.length, 1);
    const projectPayload = calls.registerProject[0] as any;
    assert.equal(projectPayload.slug, 'alpha');
    assert.equal(projectPayload.hostNodeId, identity.nodeId);
    const membershipPayload = calls.registerProjectMemberships[0] as any[];
    assert.equal(membershipPayload[0], project.projectId);
    assert.equal(membershipPayload[1], identity.nodeId);
    assert.equal(membershipPayload[2][0].principalId, 'principal-1');
  });

  it('creates a hub client when hub is configured even if network.enabled is omitted', async () => {
    const config = {
      network: { hub: 'hub.example.com:18790', heartbeatSeconds: 30 },
    } as TakoConfig;

    const realClient = createHubClientFromConfig(config);
    assert.ok(realClient);
  });
});
