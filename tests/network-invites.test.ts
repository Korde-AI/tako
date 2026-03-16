import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { InviteStore } from '../src/network/invites.js';
import { isRoleWithinAuthorityCeiling } from '../src/network/authority.js';

describe('network invite store', () => {
  let root: string;

  beforeEach(async () => {
    root = join(tmpdir(), `tako-network-invites-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('creates, expires, and imports invites', async () => {
    const file = join(root, 'invites.json');
    const store = new InviteStore(file);
    await store.load();

    const expired = await store.create({
      projectId: 'project-1',
      projectSlug: 'alpha',
      hostNodeId: 'edge-a',
      issuedByPrincipalId: 'principal-a',
      offeredRole: 'read',
      expiresAt: '2000-01-01T00:00:00.000Z',
    });
    await store.expirePending(new Date('2000-01-02T00:00:00.000Z'));
    assert.equal(store.get(expired.inviteId)?.status, 'expired');

    const imported = await store.importInvite({
      inviteId: 'invite-imported',
      projectId: 'project-2',
      projectSlug: 'beta',
      hostNodeId: 'edge-b',
      issuedByPrincipalId: 'principal-b',
      offeredRole: 'contribute',
      status: 'pending',
      createdAt: new Date().toISOString(),
    });
    assert.equal(imported.projectSlug, 'beta');
    assert.equal(store.get('invite-imported')?.status, 'pending');
  });

  it('enforces role ceilings with authority helper', () => {
    assert.equal(isRoleWithinAuthorityCeiling('read', 'contribute'), true);
    assert.equal(isRoleWithinAuthorityCeiling('write', 'contribute'), false);
  });
});
