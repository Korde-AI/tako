import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { setRuntimePaths } from '../src/core/paths.js';
import { claimOwner, isUserAllowed, loadAllowFrom } from '../src/auth/allow-from.js';

describe('allow-from principal compatibility', () => {
  let root: string;
  let previousHome: string | undefined;
  let previousMode: string | undefined;

  beforeEach(async () => {
    previousHome = process.env['TAKO_HOME'];
    previousMode = process.env['TAKO_MODE'];
    root = join(tmpdir(), `tako-allowfrom-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await mkdir(root, { recursive: true });
    setRuntimePaths({ home: join(root, 'edge'), mode: 'edge' });
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env['TAKO_HOME'];
    else process.env['TAKO_HOME'] = previousHome;
    if (previousMode === undefined) delete process.env['TAKO_MODE'];
    else process.env['TAKO_MODE'] = previousMode;
    await rm(root, { recursive: true, force: true });
  });

  it('claims ownership with both platform and principal identity', async () => {
    const result = await claimOwner('discord', 'main', 'discord-user-1', 'principal-1');
    assert.equal(result.success, true);

    const config = await loadAllowFrom('discord', 'main');
    assert.deepEqual(config.allowedUserIds, ['discord-user-1']);
    assert.deepEqual(config.allowedPrincipalIds, ['principal-1']);
  });

  it('allows a claimed principal even if the platform user id changes', async () => {
    await claimOwner('discord', 'main', 'discord-user-1', 'principal-1');

    assert.equal(await isUserAllowed('discord', 'main', 'discord-user-1', 'principal-1'), true);
    assert.equal(await isUserAllowed('discord', 'main', 'discord-user-2', 'principal-1'), true);
    assert.equal(await isUserAllowed('discord', 'main', 'discord-user-2', 'principal-2'), false);
  });
});
