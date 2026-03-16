import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { access, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ProjectRegistry } from '../src/projects/registry.js';
import { ProjectMembershipRegistry } from '../src/projects/memberships.js';
import { ProjectBindingRegistry } from '../src/projects/bindings.js';
import { bootstrapProjectHome } from '../src/projects/bootstrap.js';
import { isProjectMember, requireProjectRole } from '../src/projects/access.js';
import { ProjectArtifactRegistry } from '../src/projects/artifacts.js';
import { ProjectApprovalRegistry } from '../src/projects/approvals.js';
import { ProjectBackgroundRegistry } from '../src/projects/background.js';
import { ProjectBranchRegistry } from '../src/projects/branches.js';
import { exportArtifactEnvelope, importArtifactEnvelope } from '../src/projects/distribution.js';
import { applyPatchToWorktree, createPatchFromWorktree, getWorktreeRepoStatus } from '../src/projects/patches.js';
import { ProjectWorktreeRegistry } from '../src/projects/worktrees.js';
import { defaultProjectArtifactsRoot, defaultProjectWorktreeRoot, getProjectHome, projectApprovalsRoot, projectBackgroundRoot, projectBranchesRoot } from '../src/projects/root.js';
import { createTakoPaths } from '../src/core/paths.js';

describe('projects', () => {
  let root: string;

  beforeEach(async () => {
    root = join(tmpdir(), `tako-projects-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('creates and reloads a project by slug', async () => {
    const projects = new ProjectRegistry(root);
    await projects.load();
    const created = await projects.create({
      slug: 'alpha',
      displayName: 'Project Alpha',
      ownerPrincipalId: 'principal-owner',
    });

    const reloaded = new ProjectRegistry(root);
    await reloaded.load();
    assert.equal(reloaded.findBySlug('alpha')?.projectId, created.projectId);
  });

  it('rejects duplicate project slugs', async () => {
    const projects = new ProjectRegistry(root);
    await projects.load();
    await projects.create({
      slug: 'alpha',
      displayName: 'Project Alpha',
      ownerPrincipalId: 'principal-owner',
    });
    await assert.rejects(
      projects.create({
        slug: 'alpha',
        displayName: 'Project Alpha 2',
        ownerPrincipalId: 'principal-owner',
      }),
      /already exists/,
    );
  });

  it('stores memberships and resolves access roles', async () => {
    const memberships = new ProjectMembershipRegistry(root);
    await memberships.load();
    await memberships.upsert({
      projectId: 'project-1',
      principalId: 'principal-1',
      role: 'admin',
      addedBy: 'principal-owner',
    });

    assert.equal(isProjectMember(memberships, 'project-1', 'principal-1'), true);
    assert.equal(requireProjectRole(memberships, 'project-1', 'principal-1', 'write'), true);
    assert.equal(requireProjectRole(memberships, 'project-1', 'principal-1', 'admin'), true);
    assert.equal(requireProjectRole(memberships, 'project-1', 'principal-1', 'read'), true);
    assert.equal(requireProjectRole(memberships, 'project-1', 'principal-2', 'read'), false);
  });

  it('binds channels to projects and resolves them', async () => {
    const bindings = new ProjectBindingRegistry(root);
    await bindings.load();
    const binding = await bindings.bind({
      projectId: 'project-1',
      platform: 'discord',
      channelTarget: '12345',
      threadId: '999',
      agentId: 'main',
    });

    assert.equal(bindings.resolve({
      platform: 'discord',
      channelTarget: '12345',
      threadId: '999',
      agentId: 'main',
    })?.bindingId, binding.bindingId);

    assert.equal(bindings.resolve({
      platform: 'discord',
      channelTarget: '12345',
      threadId: '999',
      agentId: 'other',
    })?.bindingId, binding.bindingId);
  });

  it('bootstraps a project home layout', async () => {
    const projects = new ProjectRegistry(root);
    await projects.load();
    const project = await projects.create({
      slug: 'alpha',
      displayName: 'Project Alpha',
      ownerPrincipalId: 'principal-owner',
    });
    const projectHome = await bootstrapProjectHome(root, project);
    assert.equal(projectHome, join(root, project.projectId));
    await assert.doesNotReject(() => access(join(projectHome, 'workspace')));
  });

  it('publishes and persists shared project artifacts', async () => {
    const paths = createTakoPaths(root);
    const projects = new ProjectRegistry(root);
    await projects.load();
    const project = await projects.create({
      slug: 'alpha',
      displayName: 'Project Alpha',
      ownerPrincipalId: 'principal-owner',
    });
    await bootstrapProjectHome(root, project);
    const sourceFile = join(root, 'note.txt');
    await writeFile(sourceFile, 'shared artifact\n', 'utf-8');

    const artifacts = new ProjectArtifactRegistry(defaultProjectArtifactsRoot(paths, project.projectId), project.projectId);
    await artifacts.load();
    const artifact = await artifacts.publish({
      sourcePath: sourceFile,
      publishedByPrincipalId: 'principal-owner',
      sourceNodeId: 'node-a',
      description: 'Shared note',
    });

    const persisted = await readFile(artifacts.resolvePath(artifact), 'utf-8');
    assert.equal(persisted, 'shared artifact\n');

    const reloaded = new ProjectArtifactRegistry(defaultProjectArtifactsRoot(paths, project.projectId), project.projectId);
    await reloaded.load();
    assert.equal(reloaded.get(artifact.artifactId)?.publishedByPrincipalId, 'principal-owner');
    assert.equal(reloaded.list().length, 1);
  });

  it('registers and persists per-node project worktrees', async () => {
    const paths = createTakoPaths(root);
    const projects = new ProjectRegistry(root);
    await projects.load();
    const project = await projects.create({
      slug: 'alpha',
      displayName: 'Project Alpha',
      ownerPrincipalId: 'principal-owner',
    });
    await bootstrapProjectHome(root, project);

    const worktrees = new ProjectWorktreeRegistry(join(getProjectHome(paths, project.projectId), 'worktrees'), project.projectId);
    await worktrees.load();
    const expectedRoot = defaultProjectWorktreeRoot(paths, project.projectId, 'node-a');
    const worktree = await worktrees.register({
      nodeId: 'node-a',
      root: expectedRoot,
      ownerPrincipalId: 'principal-owner',
      label: 'Alice edge',
    });

    await assert.doesNotReject(() => access(expectedRoot));
    assert.equal(worktree.root, expectedRoot);

    const reloaded = new ProjectWorktreeRegistry(join(getProjectHome(paths, project.projectId), 'worktrees'), project.projectId);
    await reloaded.load();
    assert.equal(reloaded.findByNode('node-a')?.label, 'Alice edge');
    assert.equal(reloaded.list().length, 1);
  });

  it('imports a shared artifact envelope', async () => {
    const paths = createTakoPaths(root);
    const projects = new ProjectRegistry(root);
    await projects.load();
    const project = await projects.create({
      slug: 'alpha',
      displayName: 'Project Alpha',
      ownerPrincipalId: 'principal-owner',
    });
    await bootstrapProjectHome(root, project);

    const sourceFile = join(root, 'artifact.txt');
    await writeFile(sourceFile, 'artifact sync payload\n', 'utf-8');

    const sourceRegistry = new ProjectArtifactRegistry(defaultProjectArtifactsRoot(paths, project.projectId), project.projectId);
    await sourceRegistry.load();
    const artifact = await sourceRegistry.publish({
      sourcePath: sourceFile,
      publishedByPrincipalId: 'principal-owner',
      sourceNodeId: 'node-a',
    });

    const envelope = await exportArtifactEnvelope(sourceRegistry, artifact.artifactId);
    const targetRegistry = new ProjectArtifactRegistry(join(root, 'target-artifacts'), project.projectId);
    await targetRegistry.load();
    const imported = await importArtifactEnvelope(targetRegistry, envelope);
    assert.equal(imported.artifactId, artifact.artifactId);
    assert.equal(await readFile(targetRegistry.resolvePath(imported), 'utf-8'), 'artifact sync payload\n');
  });

  it('creates and applies a git patch from a worktree', async () => {
    const worktreeRoot = join(root, 'repo');
    await mkdir(worktreeRoot, { recursive: true });

    const { execFile } = await import('node:child_process');
    const { promisify } = await import('node:util');
    const execFileAsync = promisify(execFile);

    await execFileAsync('git', ['init'], { cwd: worktreeRoot });
    await execFileAsync('git', ['config', 'user.email', 'test@example.com'], { cwd: worktreeRoot });
    await execFileAsync('git', ['config', 'user.name', 'Test User'], { cwd: worktreeRoot });
    await writeFile(join(worktreeRoot, 'README.md'), 'hello\n', 'utf-8');
    await execFileAsync('git', ['add', 'README.md'], { cwd: worktreeRoot });
    await execFileAsync('git', ['commit', '-m', 'init'], { cwd: worktreeRoot });

    await writeFile(join(worktreeRoot, 'README.md'), 'hello\nworld\n', 'utf-8');
    const patch = await createPatchFromWorktree(worktreeRoot);
    assert.match(patch, /diff --git/);

    const patchPath = join(root, 'change.patch');
    await writeFile(patchPath, patch, 'utf-8');

    await execFileAsync('git', ['checkout', '--', 'README.md'], { cwd: worktreeRoot });
    const applied = await applyPatchToWorktree(worktreeRoot, patchPath);
    assert.equal(applied.applied, true);
    assert.equal(await readFile(join(worktreeRoot, 'README.md'), 'utf-8'), 'hello\nworld\n');

    const status = await getWorktreeRepoStatus(worktreeRoot);
    assert.equal(status.isGitRepo, true);
    assert.equal(status.dirty, true);
  });

  it('stores branch records, approvals, and background snapshots', async () => {
    const paths = createTakoPaths(root);
    const projects = new ProjectRegistry(root);
    await projects.load();
    const project = await projects.create({
      slug: 'alpha',
      displayName: 'Project Alpha',
      ownerPrincipalId: 'principal-owner',
      collaboration: { patchRequiresApproval: true, announceJoins: true },
    });
    await bootstrapProjectHome(root, project);

    const branches = new ProjectBranchRegistry(projectBranchesRoot(paths, project.projectId), project.projectId);
    await branches.load();
    const branch = await branches.register({
      nodeId: 'node-a',
      branchName: 'feature/alpha',
      baseBranch: 'main',
      worktreeRoot: defaultProjectWorktreeRoot(paths, project.projectId, 'node-a'),
    });
    assert.equal(branch.branchName, 'feature/alpha');

    const approvals = new ProjectApprovalRegistry(projectApprovalsRoot(paths, project.projectId), project.projectId);
    await approvals.load();
    const approval = await approvals.create({
      artifactId: 'artifact-1',
      artifactName: 'feature.patch',
      requestedByNodeId: 'node-a',
      requestedByPrincipalId: 'principal-owner',
      sourceBranch: 'feature/alpha',
    });
    assert.equal(approval.status, 'pending');
    const approved = await approvals.resolve(approval.approvalId, 'approved', 'principal-owner', 'looks good');
    assert.equal(approved.status, 'approved');
    const conflict = await approvals.markConflict(approval.approvalId, 'source=feature/alpha target=main\npatch failed', {
      targetBranch: 'main',
    });
    assert.equal(conflict.status, 'conflict');
    assert.match(conflict.conflictSummary ?? '', /patch failed/);

    const conflictedBranch = await branches.markConflict(branch.branchRecordId, 'artifact-1', 'Patch no longer applies cleanly');
    assert.equal(conflictedBranch.status, 'conflict');
    assert.equal(conflictedBranch.conflictArtifactId, 'artifact-1');

    const background = new ProjectBackgroundRegistry(projectBackgroundRoot(paths, project.projectId));
    await background.load();
    const snapshot = await background.buildAndSave({
      project,
      reason: 'participant_join:principal-2',
      sharedSession: {
        sharedSessionId: 'shared-1',
        sessionId: 'session-1',
        agentId: 'main',
        projectId: project.projectId,
        projectSlug: project.slug,
        ownerPrincipalId: 'principal-owner',
        participantIds: ['principal-owner', 'principal-2'],
        activeParticipantIds: ['principal-2'],
        channelBindings: [],
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        lastActiveAt: new Date().toISOString(),
      },
      networkSession: null,
      artifacts: [],
      worktrees: [{
        worktreeId: 'wt-1',
        projectId: project.projectId,
        nodeId: 'node-a',
        root: defaultProjectWorktreeRoot(paths, project.projectId, 'node-a'),
        status: 'active',
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        branch: 'feature/alpha',
        dirty: true,
      }],
    });
    assert.match(snapshot.summary, /participant_join/);
    assert.equal(snapshot.participantCount, 2);
    assert.equal(background.get()?.projectId, project.projectId);
  });
});
