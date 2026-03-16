import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { DelegationStore } from '../src/network/delegation.js';

describe('delegation store', () => {
  let root: string;

  beforeEach(async () => {
    root = join(tmpdir(), `tako-delegation-store-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('persists requests and results', async () => {
    const store = new DelegationStore(join(root, 'requests.json'), join(root, 'results.json'));
    await store.load();
    const request = await store.createRequest({
      projectId: 'project-1',
      fromNodeId: 'edge-a',
      fromPrincipalId: 'principal-a',
      toNodeId: 'edge-b',
      capabilityId: 'summarize_workspace',
      input: { prompt: 'summarize' },
    });
    await store.saveResult({
      requestId: request.requestId,
      projectId: request.projectId,
      fromNodeId: request.fromNodeId,
      toNodeId: request.toNodeId,
      status: 'ok',
      summary: 'done',
      createdAt: new Date().toISOString(),
    });

    const reloaded = new DelegationStore(join(root, 'requests.json'), join(root, 'results.json'));
    await reloaded.load();
    assert.equal(reloaded.getRequest(request.requestId)?.capabilityId, 'summarize_workspace');
    assert.equal(reloaded.getResult(request.requestId)?.status, 'ok');
  });
});
