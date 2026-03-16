import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { PrincipalRegistry } from '../src/principals/registry.js';

describe('principal registry', () => {
  let root: string;

  beforeEach(async () => {
    root = join(tmpdir(), `tako-principals-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('creates and reuses the same principal for the same platform mapping', async () => {
    const registry = new PrincipalRegistry(join(root, 'principals'));
    await registry.load();

    const first = await registry.getOrCreateHuman({
      displayName: 'shu',
      platform: 'discord',
      platformUserId: '123',
      username: 'alice',
    });
    const second = await registry.getOrCreateHuman({
      displayName: 'shu updated',
      platform: 'discord',
      platformUserId: '123',
      username: 'alice',
    });

    assert.equal(first.principalId, second.principalId);
    assert.equal(second.displayName, 'shu updated');
    assert.equal(registry.list().length, 1);
    assert.equal(registry.listMappings().length, 1);
  });

  it('persists principals and mappings across reloads', async () => {
    const dir = join(root, 'principals');
    const registry = new PrincipalRegistry(dir);
    await registry.load();
    const created = await registry.getOrCreateHuman({
      displayName: 'alice',
      platform: 'telegram',
      platformUserId: '555',
      username: 'alice_tg',
    });

    const reloaded = new PrincipalRegistry(dir);
    await reloaded.load();

    const found = reloaded.findByPlatform('telegram', '555');
    assert.equal(found?.principalId, created.principalId);
    assert.equal(reloaded.get(created.principalId)?.displayName, 'alice');
  });

  it('seeds reserved local-agent and system principals', async () => {
    const registry = new PrincipalRegistry(join(root, 'principals'));
    await registry.load();
    const agent = await registry.seedReservedPrincipal({ type: 'local-agent', displayName: 'edge-main' });
    const system = await registry.seedReservedPrincipal({ type: 'system', displayName: 'system' });

    assert.equal(agent.type, 'local-agent');
    assert.equal(system.type, 'system');
    assert.equal(registry.list().length, 2);
  });
});
