import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { setRuntimePaths } from '../src/core/paths.js';
import { loadOrCreateNodeIdentity } from '../src/core/node-identity.js';
import { createHubState } from '../src/hub/state.js';
import { HubRegistry } from '../src/hub/registry.js';
import { handleHubRequest } from '../src/hub/routes.js';

async function invoke(registry: HubRegistry, state: Awaited<ReturnType<typeof createHubState>>, input: {
  method?: string;
  url: string;
  body?: unknown;
}): Promise<{ statusCode: number; body: any }> {
  let statusCode = 0;
  let body = '';
  const req = {
    method: input.method ?? (input.body ? 'POST' : 'GET'),
    url: input.url,
    headers: { host: '127.0.0.1:18790' },
    async *[Symbol.asyncIterator]() {
      if (input.body !== undefined) {
        yield Buffer.from(JSON.stringify(input.body));
      }
    },
  } as any;
  const res = {
    writeHead(code: number) { statusCode = code; return this; },
    end(chunk?: string) { body = chunk ?? ''; return this; },
  } as any;
  await handleHubRequest(state, registry, req, res);
  return { statusCode, body: body ? JSON.parse(body) : null };
}

describe('hub routes', () => {
  let root: string;

  beforeEach(async () => {
    root = join(tmpdir(), `tako-hub-routes-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await mkdir(root, { recursive: true });
    setRuntimePaths({ home: root, mode: 'hub' });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('serves status and registration endpoints', async () => {
    const identity = await loadOrCreateNodeIdentity({ mode: 'hub', home: root, bind: '127.0.0.1', port: 18790 });
    const state = await createHubState(identity, '127.0.0.1', 18790, join(root, 'registry'));
    const registry = new HubRegistry(state.store);

    let result = await invoke(registry, state, { url: '/status' });
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.identity.nodeId, identity.nodeId);

    result = await invoke(registry, state, {
      url: '/register/node',
      body: {
        nodeId: 'edge-1',
        mode: 'edge',
        name: 'edge-1',
        capabilities: { projects: true },
      },
    });
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.nodeId, 'edge-1');

    result = await invoke(registry, state, {
      url: '/register/project',
      body: {
        projectId: 'project-1',
        slug: 'alpha',
        displayName: 'Alpha',
        ownerPrincipalId: 'principal-1',
        hostNodeId: 'edge-1',
        status: 'active',
        updatedAt: new Date().toISOString(),
      },
    });
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.projectId, 'project-1');

    result = await invoke(registry, state, { url: '/routes/alpha' });
    assert.equal(result.statusCode, 200);
    assert.equal(result.body.hostNodeId, 'edge-1');
  });
});
