import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { setRuntimePaths } from '../src/core/paths.js';
import { loadOrCreateNodeIdentity, readNodeIdentity } from '../src/core/node-identity.js';
import { createHubState } from '../src/hub/state.js';
import { HubRegistry } from '../src/hub/registry.js';
import { handleHubRequest } from '../src/hub/routes.js';

describe('node identity', () => {
  let root: string;
  let previousHome: string | undefined;
  let previousMode: string | undefined;

  beforeEach(async () => {
    previousHome = process.env['TAKO_HOME'];
    previousMode = process.env['TAKO_MODE'];
    root = join(tmpdir(), `tako-node-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env['TAKO_HOME'];
    else process.env['TAKO_HOME'] = previousHome;
    if (previousMode === undefined) delete process.env['TAKO_MODE'];
    else process.env['TAKO_MODE'] = previousMode;
    await rm(root, { recursive: true, force: true });
  });

  it('creates and persists node identity for an edge home', async () => {
    const home = join(root, 'edge-a');
    setRuntimePaths({ home, mode: 'edge' });

    const identity = await loadOrCreateNodeIdentity({
      mode: 'edge',
      home,
      bind: '127.0.0.1',
      port: 21893,
      hub: 'hub.example.com:18790',
    });

    assert.equal(identity.mode, 'edge');
    assert.equal(identity.home, home);
    assert.equal(identity.port, 21893);

    const raw = JSON.parse(await readFile(join(home, 'node.json'), 'utf-8'));
    assert.equal(raw.nodeId, identity.nodeId);

    const reloaded = await loadOrCreateNodeIdentity({
      mode: 'edge',
      home,
      bind: '127.0.0.1',
      port: 21894,
    });
    assert.equal(reloaded.nodeId, identity.nodeId);
    assert.equal(reloaded.port, 21894);
  });

  it('creates different node identities for separate homes', async () => {
    const homeA = join(root, 'edge-a');
    const homeB = join(root, 'hub-b');

    setRuntimePaths({ home: homeA, mode: 'edge' });
    const identityA = await loadOrCreateNodeIdentity({ mode: 'edge', home: homeA });

    setRuntimePaths({ home: homeB, mode: 'hub' });
    const identityB = await loadOrCreateNodeIdentity({ mode: 'hub', home: homeB });

    assert.notEqual(identityA.nodeId, identityB.nodeId);
    assert.equal(identityB.mode, 'hub');
  });

  it('serves hub health, status, and identity payloads', async () => {
    const home = join(root, 'hub');
    setRuntimePaths({ home, mode: 'hub' });
    const identity = await loadOrCreateNodeIdentity({
      mode: 'hub',
      home,
      bind: '127.0.0.1',
      port: 18790,
    });
    const state = await createHubState(identity, '127.0.0.1', 18790, join(home, 'registry'));
    const registry = new HubRegistry(state.store);

    for (const path of ['/healthz', '/status', '/identity']) {
      let statusCode = 0;
      let body = '';
      await handleHubRequest(
        state,
        registry,
        { url: path } as any,
        {
          writeHead: (code: number) => { statusCode = code; return undefined as any; },
          end: (chunk?: string) => { body = chunk ?? ''; return undefined as any; },
        } as any,
      );
      assert.equal(statusCode, 200);
      const parsed = JSON.parse(body);
      assert.equal(parsed.nodeId ?? parsed.identity?.nodeId, identity.nodeId);
    }

    const persisted = await readNodeIdentity();
    assert.equal(persisted?.nodeId, identity.nodeId);
  });
});
