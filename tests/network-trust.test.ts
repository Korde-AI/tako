import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { TrustStore } from '../src/network/trust.js';

describe('network trust store', () => {
  let root: string;

  beforeEach(async () => {
    root = join(tmpdir(), `tako-network-trust-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('creates, trusts, and revokes a remote node', async () => {
    const store = new TrustStore(join(root, 'trust.json'));
    await store.load();

    const pending = await store.createPending({
      remoteNodeId: 'edge-b',
      remoteNodeName: 'bob-edge',
      authorityCeiling: 'contribute',
    });
    assert.equal(pending.status, 'pending');

    const trusted = await store.markTrusted('edge-b', 'read');
    assert.equal(trusted?.status, 'trusted');
    assert.equal(trusted?.authorityCeiling, 'read');

    const revoked = await store.revoke('edge-b');
    assert.equal(revoked?.status, 'revoked');

    const reloaded = new TrustStore(join(root, 'trust.json'));
    await reloaded.load();
    assert.equal(reloaded.getByNodeId('edge-b')?.status, 'revoked');
  });
});
