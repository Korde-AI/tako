import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { runNetwork } from '../src/cli/network.js';
import { saveNodeIdentity } from '../src/core/node-identity.js';
import { setRuntimePaths } from '../src/core/paths.js';
import { InviteStore } from '../src/network/invites.js';
import { TrustStore } from '../src/network/trust.js';
import { ProjectMembershipRegistry } from '../src/projects/memberships.js';
import { ProjectRegistry } from '../src/projects/registry.js';

describe('network pairing flow', () => {
  let hostHome: string;
  let guestHome: string;

  beforeEach(async () => {
    hostHome = join(tmpdir(), `tako-network-host-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    guestHome = join(tmpdir(), `tako-network-guest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await mkdir(hostHome, { recursive: true });
    await mkdir(guestHome, { recursive: true });
    await writeFile(join(hostHome, 'tako.json'), '{}\n', 'utf-8');
    await writeFile(join(guestHome, 'tako.json'), '{}\n', 'utf-8');
  });

  afterEach(async () => {
    await rm(hostHome, { recursive: true, force: true });
    await rm(guestHome, { recursive: true, force: true });
  });

  it('creates, imports, and accepts an invite across two homes', async () => {
    const originalLog = console.log;
    console.log = () => {};
    try {
    const hostPaths = setRuntimePaths({ home: hostHome, mode: 'edge' });
    const projects = new ProjectRegistry(hostPaths.projectsDir);
    const memberships = new ProjectMembershipRegistry(hostPaths.projectsDir);
    await projects.load();
    await memberships.load();
    const project = await projects.create({
      slug: 'alpha',
      displayName: 'Alpha',
      ownerPrincipalId: 'principal-owner',
    });
    await memberships.upsert({
      projectId: project.projectId,
      principalId: 'principal-owner',
      role: 'admin',
      addedBy: 'principal-owner',
    });
    await saveNodeIdentity({
      nodeId: 'edge-host',
      mode: 'edge',
      name: 'host-edge',
      home: hostHome,
      createdAt: new Date().toISOString(),
      lastStartedAt: new Date().toISOString(),
      bind: '127.0.0.1',
      port: 18790,
    });

    await runNetwork([
      'invite',
      'create',
      project.slug,
      '--issued-by',
      'principal-owner',
      '--target-node',
      'edge-guest',
      '--role',
      'contribute',
    ]);

    const hostInvites = new InviteStore(hostPaths.invitesFile);
    await hostInvites.load();
    const invite = hostInvites.list()[0];
    assert.ok(invite);

    const importFile = join(tmpdir(), `tako-network-invite-${Date.now()}.json`);
    await writeFile(importFile, JSON.stringify(invite, null, 2) + '\n', 'utf-8');

    const guestPaths = setRuntimePaths({ home: guestHome, mode: 'edge' });
    await runNetwork(['invite', 'import', importFile]);
    await runNetwork(['invite', 'accept', invite.inviteId, '--ceiling', 'contribute']);

    const guestInvites = new InviteStore(guestPaths.invitesFile);
    await guestInvites.load();
    assert.equal(guestInvites.get(invite.inviteId)?.status, 'accepted');

    const guestTrust = new TrustStore(guestPaths.trustFile);
    await guestTrust.load();
    const trusted = guestTrust.getByNodeId('edge-host');
    assert.equal(trusted?.status, 'trusted');
    assert.equal(trusted?.authorityCeiling, 'contribute');

    const onDisk = JSON.parse(await readFile(guestPaths.trustFile, 'utf-8')) as Array<{ remoteNodeId: string }>;
    assert.equal(onDisk[0]?.remoteNodeId, 'edge-host');
    } finally {
      console.log = originalLog;
    }
  });
});
