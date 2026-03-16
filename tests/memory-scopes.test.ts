import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createTakoPaths } from '../src/core/paths.js';
import { resolveVisibleMemoryScopes } from '../src/memory/scopes.js';

describe('memory scopes', () => {
  const paths = createTakoPaths('/tmp/tako-scope-test');
  const workspaceRoot = '/tmp/tako-scope-test/workspace';

  it('resolves solo context to global-private only', () => {
    const scopes = resolveVisibleMemoryScopes(paths, workspaceRoot, {
      mode: 'edge',
      home: paths.home,
      nodeId: 'node-1',
      nodeName: 'edge-main',
      agentId: 'main',
    });

    assert.deepEqual(scopes.readable.map((s) => s.scope), ['global-private']);
    assert.deepEqual(scopes.writable.map((s) => s.scope), ['global-private']);
  });

  it('resolves project context to shared plus caller private', () => {
    const scopes = resolveVisibleMemoryScopes(paths, workspaceRoot, {
      mode: 'edge',
      home: paths.home,
      nodeId: 'node-1',
      nodeName: 'edge-main',
      agentId: 'main',
      principalId: 'principal-1',
      projectId: 'project-1',
      projectSlug: 'alpha',
    });

    assert.deepEqual(scopes.readable.map((s) => s.scope), ['project-shared', 'project-private']);
    assert.deepEqual(scopes.writable.map((s) => s.scope), ['project-private', 'project-shared']);
    assert.ok(scopes.readable[1]?.root.endsWith('/projects/project-1/memory/private/principal-1'));
  });
});
