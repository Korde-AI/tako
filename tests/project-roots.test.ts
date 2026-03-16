import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { createTakoPaths } from '../src/core/paths.js';
import { resolveProjectRoot } from '../src/projects/root.js';
import type { Project } from '../src/projects/types.js';

describe('project roots', () => {
  let home: string;

  beforeEach(async () => {
    home = join(tmpdir(), `tako-project-root-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await mkdir(home, { recursive: true });
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
  });

  it('resolves the default project workspace under the project home', () => {
    const paths = createTakoPaths(home);
    const project: Project = {
      projectId: 'project-1',
      slug: 'alpha',
      displayName: 'Alpha',
      ownerPrincipalId: 'principal-1',
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    assert.equal(resolveProjectRoot(paths, project), join(paths.projectsDir, 'project-1', 'workspace'));
  });

  it('resolves an explicit workspace root when configured', () => {
    const paths = createTakoPaths(home);
    const project: Project = {
      projectId: 'project-1',
      slug: 'alpha',
      displayName: 'Alpha',
      ownerPrincipalId: 'principal-1',
      workspaceRoot: '/tmp/custom-alpha-root',
      status: 'active',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    assert.equal(resolveProjectRoot(paths, project), '/tmp/custom-alpha-root');
  });
});
