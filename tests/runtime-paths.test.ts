import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createTakoPaths, resolveHome, setRuntimePaths } from '../src/core/paths.js';
import { resolveConfig } from '../src/config/resolve.js';
import { writeAuthCredential, readAuthCredential } from '../src/auth/storage.js';
import { saveAllowFrom, loadAllowFrom } from '../src/auth/allow-from.js';

describe('runtime paths', () => {
  let testRoot: string;
  let previousHome: string | undefined;
  let previousMode: string | undefined;

  beforeEach(async () => {
    previousHome = process.env['TAKO_HOME'];
    previousMode = process.env['TAKO_MODE'];
    testRoot = join(tmpdir(), `tako-home-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await mkdir(testRoot, { recursive: true });
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env['TAKO_HOME'];
    else process.env['TAKO_HOME'] = previousHome;
    if (previousMode === undefined) delete process.env['TAKO_MODE'];
    else process.env['TAKO_MODE'] = previousMode;
    await rm(testRoot, { recursive: true, force: true });
  });

  it('resolves explicit homes directly', () => {
    const resolved = resolveHome('/tmp/tako-explicit', 'edge');
    assert.equal(resolved, '/tmp/tako-explicit');
  });

  it('creates home-scoped paths', () => {
    const paths = createTakoPaths('/tmp/tako-edge-main');
    assert.equal(paths.configFile, '/tmp/tako-edge-main/tako.json');
    assert.equal(paths.lockFile, '/tmp/tako-edge-main/runtime/tako.lock');
    assert.equal(paths.authDir, '/tmp/tako-edge-main/auth');
  });

  it('loads config and env from the selected home', async () => {
    const home = join(testRoot, 'edge-a');
    const paths = setRuntimePaths({ home, mode: 'edge' });
    await mkdir(paths.home, { recursive: true });
    await writeFile(paths.envFile, 'ANTHROPIC_API_KEY=test-key\n', 'utf-8');
    await writeFile(paths.configFile, JSON.stringify({
      providers: { primary: 'anthropic/claude-sonnet-4-6' },
      memory: { workspace: 'workspace-a' },
    }), 'utf-8');

    const config = await resolveConfig(undefined, { home });
    assert.equal(config.memory.workspace, join(home, 'workspace-a'));
    assert.equal(process.env['ANTHROPIC_API_KEY'], 'test-key');
  });

  it('stores auth credentials under the selected home', async () => {
    const home = join(testRoot, 'edge-auth');
    const paths = setRuntimePaths({ home, mode: 'edge' });
    await writeAuthCredential({
      provider: 'anthropic',
      auth_method: 'api_key',
      api_key: 'secret',
      created_at: Date.now(),
    });

    const credential = await readAuthCredential('anthropic');
    assert.equal(credential?.provider, 'anthropic');
    const raw = await readFile(join(paths.authDir, 'anthropic.json'), 'utf-8');
    assert.match(raw, /secret/);
  });

  it('stores allow-from data under the selected home', async () => {
    const home = join(testRoot, 'edge-acl');
    const paths = setRuntimePaths({ home, mode: 'edge' });
    await saveAllowFrom('discord', 'main', {
      allowedUserIds: ['u1'],
      allowedPrincipalIds: ['p1'],
      mode: 'allowlist',
      claimed: true,
    });

    const config = await loadAllowFrom('discord', 'main');
    assert.deepEqual(config.allowedUserIds, ['u1']);
    assert.deepEqual(config.allowedPrincipalIds, ['p1']);
    const raw = await readFile(join(paths.credentialsDir, 'discord-main-allowFrom.json'), 'utf-8');
    assert.match(raw, /u1/);
    assert.match(raw, /p1/);
  });

});
