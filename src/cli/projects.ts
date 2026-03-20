import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig } from '../config/resolve.js';
import { getRuntimePaths } from '../core/paths.js';
import { readNodeIdentity } from '../core/node-identity.js';
import { ProjectApprovalRegistry } from '../projects/approvals.js';
import { ProjectArtifactRegistry } from '../projects/artifacts.js';
import { ProjectBackgroundRegistry } from '../projects/background.js';
import { ProjectBindingRegistry } from '../projects/bindings.js';
import { bootstrapProjectHome } from '../projects/bootstrap.js';
import { ProjectBranchRegistry } from '../projects/branches.js';
import { ProjectMembershipRegistry } from '../projects/memberships.js';
import { applyPatchToWorktree, createPatchFromWorktree, getWorktreeRepoStatus } from '../projects/patches.js';
import {
  defaultProjectArtifactsRoot,
  defaultProjectWorktreeRootForProject,
  getProjectHome,
  projectApprovalsRoot,
  projectBackgroundRoot,
  projectBranchesRoot,
  resolveProjectRoot,
} from '../projects/root.js';
import { ProjectRegistry } from '../projects/registry.js';
import { exportArtifactEnvelope } from '../projects/distribution.js';
import { ProjectWorktreeRegistry } from '../projects/worktrees.js';
import { EdgeHubClient } from '../network/edge-client.js';
import { NetworkSharedSessionStore, type NetworkSessionEvent } from '../network/shared-sessions.js';
import { createHubClientFromConfig, syncProjectMembershipsToHub, syncProjectToHub } from '../network/sync.js';
import { sendNetworkSessionEvent } from '../network/session-sync.js';
import { TrustStore } from '../network/trust.js';

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function readFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function outputJsonAware(args: string[], value: unknown, fallback?: () => void): void {
  if (hasFlag(args, '--json') || !fallback) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  fallback();
}

function projectArtifactsDir(projectId: string): string {
  return defaultProjectArtifactsRoot(getRuntimePaths(), projectId);
}

function projectWorktreesDir(projectId: string): string {
  return `${getProjectHome(getRuntimePaths(), projectId)}/worktrees`;
}

function projectApprovalsDir(projectId: string): string {
  return projectApprovalsRoot(getRuntimePaths(), projectId);
}

function projectBranchesDir(projectId: string): string {
  return projectBranchesRoot(getRuntimePaths(), projectId);
}

function projectBackgroundDir(projectId: string): string {
  return projectBackgroundRoot(getRuntimePaths(), projectId);
}

function readArtifactSourceBranch(metadata: Record<string, unknown> | undefined): string | undefined {
  const repo = metadata?.repo;
  if (!repo || typeof repo !== 'object') return undefined;
  const branch = (repo as Record<string, unknown>).branch;
  return typeof branch === 'string' && branch.trim() ? branch : undefined;
}

async function loadStores() {
  const root = getRuntimePaths().projectsDir;
  const projects = new ProjectRegistry(root);
  const memberships = new ProjectMembershipRegistry(root);
  const bindings = new ProjectBindingRegistry(root);
  await Promise.all([projects.load(), memberships.load(), bindings.load()]);
  return { root, projects, memberships, bindings };
}

async function loadNetworkStores() {
  const paths = getRuntimePaths();
  const networkSessions = new NetworkSharedSessionStore(paths.networkSessionsFile, paths.networkEventsFile);
  const trusts = new TrustStore(paths.trustFile);
  await Promise.all([networkSessions.load(), trusts.load()]);
  return { networkSessions, trusts };
}

function resolveProjectId(projects: ProjectRegistry, idOrSlug?: string): string {
  if (!idOrSlug) throw new Error('Missing project identifier');
  const byId = projects.get(idOrSlug);
  if (byId) return byId.projectId;
  const bySlug = projects.findBySlug(idOrSlug);
  if (bySlug) return bySlug.projectId;
  throw new Error(`Project not found: ${idOrSlug}`);
}

export async function runProjects(args: string[]): Promise<void> {
  const sub = args[0] ?? 'list';
  const { root, projects, memberships, bindings } = await loadStores();
  const config = await resolveConfig();
  const hubClient = createHubClientFromConfig(config);
  const identity = hubClient ? await readNodeIdentity() : null;

  const syncProjectState = async (projectId: string): Promise<void> => {
    if (!hubClient || !identity) return;
    const project = projects.get(projectId);
    if (!project) return;
    await syncProjectToHub(hubClient, identity, project, memberships);
    await syncProjectMembershipsToHub(hubClient, identity, projectId, memberships);
  };

  const syncArtifactToTrustedEdges = async (
    projectId: string,
    artifactRegistry: ProjectArtifactRegistry,
    artifactId: string,
  ): Promise<{ networkSessionId: string; targetNodeIds: string[] }> => {
    const cfg = await resolveConfig();
    if (!cfg.network?.hub) {
      throw new Error('Artifact sync requires network.hub to be configured');
    }
    const localIdentity = await readNodeIdentity();
    if (!localIdentity) {
      throw new Error('Node identity not initialized');
    }
    const { networkSessions, trusts } = await loadNetworkStores();
    const requestedSessionId = readFlag(args, '--network-session');
    const session = requestedSessionId
      ? networkSessions.get(requestedSessionId)
      : networkSessions.findByProject(projectId).find((candidate) => candidate.participantNodeIds.includes(localIdentity.nodeId)) ?? null;
    if (!session) {
      throw new Error(`No network session found for project ${projectId}`);
    }
    const requestedTargets = (readFlag(args, '--to') ?? '')
      .split(',')
      .map((value) => value.trim())
      .filter(Boolean);
    const targetNodeIds = (requestedTargets.length > 0 ? requestedTargets : session.participantNodeIds)
      .filter((nodeId) => nodeId !== localIdentity.nodeId);
    if (targetNodeIds.length === 0) {
      throw new Error('No remote target nodes available for artifact sync');
    }
    const client = new EdgeHubClient(cfg.network.hub);
    const envelope = await exportArtifactEnvelope(artifactRegistry, artifactId);
    const artifactEvent: NetworkSessionEvent = {
      eventId: crypto.randomUUID(),
      networkSessionId: session.networkSessionId,
      projectId,
      fromNodeId: localIdentity.nodeId,
      fromPrincipalId: envelope.artifact.publishedByPrincipalId,
      type: 'artifact_publish',
      audience: 'specific-nodes',
      targetNodeIds,
      payload: {
        artifactEnvelope: envelope,
        summary: `Artifact published: ${envelope.artifact.name}`,
        metadata: {
          artifactId: envelope.artifact.artifactId,
          artifactKind: envelope.artifact.kind,
        },
      },
      createdAt: new Date().toISOString(),
    };
    await sendNetworkSessionEvent(client, networkSessions, trusts, artifactEvent);
    return { networkSessionId: session.networkSessionId, targetNodeIds };
  };

  const shouldAutoSyncArtifacts = async (projectId: string): Promise<boolean> => {
    const project = projects.get(projectId);
    if (project?.collaboration?.autoArtifactSync) return true;
    const { networkSessions } = await loadNetworkStores();
    return networkSessions.findByProject(projectId).some((session) => session.collaboration?.autoArtifactSync === true);
  };

  switch (sub) {
    case 'list': {
      const all = projects.list();
      if (all.length === 0) {
        console.log('No projects found.');
        return;
      }
      outputJsonAware(args, all, () => {
        for (const project of all) {
          console.log(`${project.projectId}  ${project.slug}  ${project.displayName}  owner=${project.ownerPrincipalId}  status=${project.status}`);
        }
      });
      return;
    }
    case 'create': {
      const slug = args[1];
      const displayName = readFlag(args, '--name') ?? slug;
      const ownerPrincipalId = readFlag(args, '--owner');
      const description = readFlag(args, '--description');
      if (!slug || !ownerPrincipalId) {
        throw new Error('Usage: tako projects create <slug> --owner <principalId> [--name <name>] [--description <text>]');
      }
      const project = await projects.create({ slug, displayName: displayName ?? slug, ownerPrincipalId, description });
      await memberships.upsert({
        projectId: project.projectId,
        principalId: ownerPrincipalId,
        role: 'admin',
        addedBy: ownerPrincipalId,
      });
      await bootstrapProjectHome(root, project);
      await syncProjectState(project.projectId);
      outputJsonAware(args, project);
      return;
    }
    case 'show': {
      const projectId = resolveProjectId(projects, args[1]);
      const project = projects.get(projectId);
      outputJsonAware(args, {
        ...project,
        effectiveWorkspaceRoot: project ? resolveProjectRoot(getRuntimePaths(), project) : undefined,
      });
      return;
    }
    case 'policy': {
      const projectId = resolveProjectId(projects, args[1]);
      const project = projects.get(projectId);
      outputJsonAware(args, { projectId, collaboration: project?.collaboration ?? {} });
      return;
    }
    case 'set-policy': {
      const projectId = resolveProjectId(projects, args[1]);
      const project = projects.get(projectId);
      if (!project) throw new Error(`Project not found: ${args[1]}`);
      const updated = await projects.update(projectId, {
        collaboration: {
          ...(project.collaboration ?? {}),
          ...(readFlag(args, '--auto-artifacts') ? { autoArtifactSync: ['on', 'true', '1'].includes(String(readFlag(args, '--auto-artifacts')).toLowerCase()) } : {}),
          ...(readFlag(args, '--patch-approval') ? { patchRequiresApproval: ['required', 'on', 'true', '1'].includes(String(readFlag(args, '--patch-approval')).toLowerCase()) } : {}),
          ...(readFlag(args, '--announce-joins') ? { announceJoins: ['on', 'true', '1'].includes(String(readFlag(args, '--announce-joins')).toLowerCase()) } : {}),
        },
      });
      outputJsonAware(args, updated);
      return;
    }
    case 'root': {
      const projectId = resolveProjectId(projects, args[1]);
      const project = projects.get(projectId);
      if (!project) throw new Error(`Project not found: ${args[1]}`);
      console.log(resolveProjectRoot(getRuntimePaths(), project));
      return;
    }
    case 'set-root': {
      const projectId = resolveProjectId(projects, args[1]);
      const workspaceRoot = args[2];
      if (!workspaceRoot) {
        throw new Error('Usage: tako projects set-root <projectId|slug> <path>');
      }
      const project = await projects.update(projectId, { workspaceRoot });
      await syncProjectState(projectId);
      outputJsonAware(args, project);
      return;
    }
    case 'members': {
      const projectId = resolveProjectId(projects, args[1]);
      const members = memberships.listByProject(projectId);
      if (members.length === 0) {
        console.log('No members found.');
        return;
      }
      outputJsonAware(args, members, () => {
        for (const member of members) {
          console.log(`${member.principalId}  ${member.role}  addedBy=${member.addedBy}`);
        }
      });
      return;
    }
    case 'add-member': {
      const projectId = resolveProjectId(projects, args[1]);
      const principalId = args[2];
      const role = (readFlag(args, '--role') ?? 'contribute') as 'read' | 'contribute' | 'write' | 'admin';
      const addedBy = readFlag(args, '--added-by');
      if (!principalId || !addedBy) {
        throw new Error('Usage: tako projects add-member <projectId|slug> <principalId> --added-by <principalId> [--role <role>]');
      }
      const membership = await memberships.upsert({ projectId, principalId, role, addedBy });
      await syncProjectState(projectId);
      outputJsonAware(args, membership);
      return;
    }
    case 'remove-member': {
      const projectId = resolveProjectId(projects, args[1]);
      const principalId = args[2];
      if (!principalId) {
        throw new Error('Usage: tako projects remove-member <projectId|slug> <principalId>');
      }
      const removed = await memberships.remove(projectId, principalId);
      if (removed) await syncProjectState(projectId);
      console.log(removed ? 'Removed.' : 'No membership found.');
      return;
    }
    case 'bind': {
      const projectId = resolveProjectId(projects, args[1]);
      const platform = readFlag(args, '--platform') as 'discord' | 'telegram' | 'cli' | undefined;
      const channelTarget = readFlag(args, '--target');
      const threadId = readFlag(args, '--thread');
      const agentId = readFlag(args, '--agent');
      if (!platform || !channelTarget) {
        throw new Error('Usage: tako projects bind <projectId|slug> --platform <discord|telegram|cli> --target <id> [--thread <id>] [--agent <agentId>]');
      }
      const binding = await bindings.bind({ projectId, platform, channelTarget, threadId, agentId });
      outputJsonAware(args, binding);
      return;
    }
    case 'artifacts': {
      const projectId = resolveProjectId(projects, args[1]);
      const artifacts = new ProjectArtifactRegistry(projectArtifactsDir(projectId), projectId);
      await artifacts.load();
      const rows = artifacts.list();
      if (rows.length === 0) {
        console.log('No project artifacts found.');
        return;
      }
      outputJsonAware(args, rows, () => {
        for (const artifact of rows) {
          console.log(`${artifact.artifactId}  ${artifact.name}  kind=${artifact.kind}  size=${artifact.sizeBytes}  by=${artifact.publishedByPrincipalId}${artifact.sourceNodeId ? `  node=${artifact.sourceNodeId}` : ''}`);
        }
      });
      return;
    }
    case 'artifact-show': {
      const projectId = resolveProjectId(projects, args[1]);
      const artifactId = args[2];
      if (!artifactId) {
        throw new Error('Usage: tako projects artifact-show <projectId|slug> <artifactId>');
      }
      const artifacts = new ProjectArtifactRegistry(projectArtifactsDir(projectId), projectId);
      await artifacts.load();
      const artifact = artifacts.get(artifactId);
      if (!artifact) throw new Error(`Artifact not found: ${artifactId}`);
      outputJsonAware(args, { ...artifact, absolutePath: artifacts.resolvePath(artifact) });
      return;
    }
    case 'artifact-publish': {
      const projectId = resolveProjectId(projects, args[1]);
      const sourcePath = readFlag(args, '--from');
      const publishedByPrincipalId = readFlag(args, '--published-by');
      const name = readFlag(args, '--name');
      const description = readFlag(args, '--description');
      const sourceNodeId = readFlag(args, '--node');
      if (!sourcePath || !publishedByPrincipalId) {
        throw new Error('Usage: tako projects artifact-publish <projectId|slug> --from <path> --published-by <principalId> [--name <name>] [--description <text>] [--node <nodeId>]');
      }
      const artifacts = new ProjectArtifactRegistry(projectArtifactsDir(projectId), projectId);
      await artifacts.load();
      const artifact = await artifacts.publish({
        sourcePath,
        name,
        kind: readFlag(args, '--kind') === 'patch' ? 'patch' : 'file',
        publishedByPrincipalId,
        description,
        sourceNodeId,
      });
      const synced = (hasFlag(args, '--sync') || await shouldAutoSyncArtifacts(projectId))
        ? await syncArtifactToTrustedEdges(projectId, artifacts, artifact.artifactId)
        : null;
      outputJsonAware(args, {
        ...artifact,
        absolutePath: artifacts.resolvePath(artifact),
        synced,
      });
      return;
    }
    case 'artifact-sync': {
      const projectId = resolveProjectId(projects, args[1]);
      const artifactId = args[2];
      if (!artifactId) {
        throw new Error('Usage: tako projects artifact-sync <projectId|slug> <artifactId> [--network-session <id>] [--to <nodeId,nodeId>]');
      }
      const artifacts = new ProjectArtifactRegistry(projectArtifactsDir(projectId), projectId);
      await artifacts.load();
      const artifact = artifacts.get(artifactId);
      if (!artifact) throw new Error(`Artifact not found: ${artifactId}`);
      const synced = await syncArtifactToTrustedEdges(projectId, artifacts, artifactId);
      outputJsonAware(args, { ...artifact, synced });
      return;
    }
    case 'worktrees': {
      const projectId = resolveProjectId(projects, args[1]);
      const worktrees = new ProjectWorktreeRegistry(projectWorktreesDir(projectId), projectId);
      await worktrees.load();
      const rows = worktrees.list();
      if (rows.length === 0) {
        console.log('No worktrees registered.');
        return;
      }
      outputJsonAware(args, rows, () => {
        for (const worktree of rows) {
          console.log(`${worktree.worktreeId}  node=${worktree.nodeId}  root=${worktree.root}  status=${worktree.status}${worktree.label ? `  label=${worktree.label}` : ''}`);
        }
      });
      return;
    }
    case 'worktree-register': {
      const projectId = resolveProjectId(projects, args[1]);
      const project = projects.get(projectId);
      if (!project) throw new Error(`Project not found: ${projectId}`);
      const nodeId = readFlag(args, '--node') ?? (await readNodeIdentity())?.nodeId;
      const ownerPrincipalId = readFlag(args, '--owner');
      const label = readFlag(args, '--label');
      if (!nodeId) {
        throw new Error('Usage: tako projects worktree-register <projectId|slug> [--node <nodeId>] [--root <path>] [--owner <principalId>] [--label <label>]');
      }
      const requestedRoot = readFlag(args, '--root') ?? defaultProjectWorktreeRootForProject(project, getRuntimePaths(), nodeId);
      const worktrees = new ProjectWorktreeRegistry(projectWorktreesDir(projectId), projectId);
      await worktrees.load();
      const worktree = await worktrees.register({ nodeId, root: requestedRoot, ownerPrincipalId, label });
      outputJsonAware(args, worktree);
      return;
    }
    case 'workspace-status': {
      const projectId = resolveProjectId(projects, args[1]);
      const project = projects.get(projectId);
      if (!project) throw new Error(`Project not found: ${args[1]}`);
      const worktrees = new ProjectWorktreeRegistry(projectWorktreesDir(projectId), projectId);
      const artifacts = new ProjectArtifactRegistry(projectArtifactsDir(projectId), projectId);
      const branches = new ProjectBranchRegistry(projectBranchesDir(projectId), projectId);
      const background = new ProjectBackgroundRegistry(projectBackgroundDir(projectId));
      await Promise.all([worktrees.load(), artifacts.load(), branches.load(), background.load()]);
      const projectRoot = resolveProjectRoot(getRuntimePaths(), project);
      const projectRootStats = await stat(projectRoot).catch(() => null);
      const worktreeRows = worktrees.list();
      const gitStatus = await Promise.all(worktreeRows.map(async (worktree) => ({
        worktreeId: worktree.worktreeId,
        nodeId: worktree.nodeId,
        repo: await getWorktreeRepoStatus(worktree.root),
      })));
      outputJsonAware(args, {
        projectId,
        projectRoot,
        projectRootExists: !!projectRootStats,
        sharedArtifactsDir: projectArtifactsDir(projectId),
        worktrees: worktreeRows,
        gitStatus,
        branches: branches.list(),
        background: background.get(),
        artifactCount: artifacts.list().length,
      }, () => {
        console.log(`project=${project.slug}`);
        console.log(`projectRoot=${projectRoot}`);
        console.log(`sharedArtifactsDir=${projectArtifactsDir(projectId)}`);
        console.log(`artifactCount=${artifacts.list().length}`);
        console.log(`worktrees=${worktreeRows.length}`);
        console.log(`branches=${branches.list().length}`);
        for (const row of gitStatus) {
          console.log(`  ${row.nodeId}: git=${row.repo.isGitRepo ? 'yes' : 'no'}${row.repo.branch ? ` branch=${row.repo.branch}` : ''}${row.repo.dirty != null ? ` dirty=${row.repo.dirty}` : ''}`);
        }
      });
      return;
    }
    case 'patch-create': {
      const projectId = resolveProjectId(projects, args[1]);
      const nodeId = readFlag(args, '--node') ?? (await readNodeIdentity())?.nodeId;
      const publishedByPrincipalId = readFlag(args, '--published-by');
      if (!nodeId || !publishedByPrincipalId) {
        throw new Error('Usage: tako projects patch-create <projectId|slug> --published-by <principalId> [--node <nodeId>] [--name <name>] [--description <text>] [--sync]');
      }
      const worktrees = new ProjectWorktreeRegistry(projectWorktreesDir(projectId), projectId);
      await worktrees.load();
      const worktree = worktrees.findByNode(nodeId);
      if (!worktree) throw new Error(`No worktree registered for node ${nodeId}`);
      const patch = await createPatchFromWorktree(worktree.root);
      if (!patch.trim()) {
        throw new Error(`No git diff available in worktree ${worktree.root}`);
      }
      const tmpRoot = await mkdtemp(join(tmpdir(), 'tako-project-patch-'));
      const patchPath = join(tmpRoot, readFlag(args, '--name') ?? `${projectId}-${nodeId}.patch`);
      try {
        await writeFile(patchPath, patch, 'utf-8');
        const artifacts = new ProjectArtifactRegistry(projectArtifactsDir(projectId), projectId);
        await artifacts.load();
        const artifact = await artifacts.publish({
          sourcePath: patchPath,
          name: readFlag(args, '--name') ?? `${projectId}-${nodeId}.patch`,
          kind: 'patch',
          publishedByPrincipalId,
          description: readFlag(args, '--description') ?? `Patch from worktree ${nodeId}`,
          sourceNodeId: nodeId,
          metadata: {
            worktreeRoot: worktree.root,
            repo: await getWorktreeRepoStatus(worktree.root),
          },
        });
        const project = projects.get(projectId);
        const sourceBranch = readArtifactSourceBranch(artifact.metadata);
        if (project?.collaboration?.patchRequiresApproval) {
          const approvals = new ProjectApprovalRegistry(projectApprovalsDir(projectId), projectId);
          await approvals.load();
          await approvals.create({
            artifactId: artifact.artifactId,
            artifactName: artifact.name,
            requestedByNodeId: nodeId,
            requestedByPrincipalId: publishedByPrincipalId,
            sourceBranch,
          });
        }
        const synced = (hasFlag(args, '--sync') || await shouldAutoSyncArtifacts(projectId))
          ? await syncArtifactToTrustedEdges(projectId, artifacts, artifact.artifactId)
          : null;
        outputJsonAware(args, {
          ...artifact,
          absolutePath: artifacts.resolvePath(artifact),
          synced,
        });
      } finally {
        await rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
      }
      return;
    }
    case 'patch-apply': {
      const projectId = resolveProjectId(projects, args[1]);
      const artifactId = args[2];
      const nodeId = readFlag(args, '--node') ?? (await readNodeIdentity())?.nodeId;
      if (!artifactId || !nodeId) {
        throw new Error('Usage: tako projects patch-apply <projectId|slug> <artifactId> [--node <nodeId>]');
      }
      const artifacts = new ProjectArtifactRegistry(projectArtifactsDir(projectId), projectId);
      const worktrees = new ProjectWorktreeRegistry(projectWorktreesDir(projectId), projectId);
      await Promise.all([artifacts.load(), worktrees.load()]);
      const artifact = artifacts.get(artifactId);
      if (!artifact) throw new Error(`Artifact not found: ${artifactId}`);
      if (artifact.kind !== 'patch') {
        throw new Error(`Artifact ${artifactId} is not a patch`);
      }
      const project = projects.get(projectId);
      if (!project) throw new Error(`Project not found: ${projectId}`);
      let approvalId: string | undefined;
      if (project.collaboration?.patchRequiresApproval) {
        const approvals = new ProjectApprovalRegistry(projectApprovalsDir(projectId), projectId);
        await approvals.load();
        const approval = approvals.list().find((row) => row.artifactId === artifactId && row.status === 'approved') ?? null;
        if (!approval) {
          throw new Error(`Patch ${artifactId} requires approval before apply`);
        }
        approvalId = approval.approvalId;
      }
      const worktree = worktrees.findByNode(nodeId);
      if (!worktree) throw new Error(`No worktree registered for node ${nodeId}`);
      const branchRegistry = new ProjectBranchRegistry(projectBranchesDir(projectId), projectId);
      await branchRegistry.load();
      const targetBranchRecord = branchRegistry.findByNode(nodeId).find((row) => row.status === 'active');
      const targetRepo = await getWorktreeRepoStatus(worktree.root);
      const sourceBranch = readArtifactSourceBranch(artifact.metadata);
      const targetBranch = targetBranchRecord?.branchName ?? targetRepo.branch;
      const result = await applyPatchToWorktree(worktree.root, artifacts.resolvePath(artifact));
      let conflictApprovalId: string | undefined;
      if (!result.applied) {
        const approvals = new ProjectApprovalRegistry(projectApprovalsDir(projectId), projectId);
        await approvals.load();
        const existingApproval = approvals.list().find((row) => row.artifactId === artifactId) ?? null;
        const conflictSummary = [
          sourceBranch && targetBranch && sourceBranch !== targetBranch
            ? `source=${sourceBranch} target=${targetBranch}`
            : null,
          result.output,
        ].filter(Boolean).join('\n');
        const conflictApproval = existingApproval
          ? await approvals.markConflict(existingApproval.approvalId, conflictSummary, { targetBranch })
          : await approvals.create({
              artifactId: artifact.artifactId,
              artifactName: artifact.name,
              requestedByNodeId: artifact.sourceNodeId,
              requestedByPrincipalId: artifact.publishedByPrincipalId,
              sourceBranch,
              targetBranch,
              conflictSummary,
              status: 'conflict',
            });
        conflictApprovalId = conflictApproval.approvalId;
        if (targetBranchRecord) {
          await branchRegistry.markConflict(targetBranchRecord.branchRecordId, artifactId, conflictSummary);
        }
      }
      outputJsonAware(args, {
        artifactId,
        nodeId,
        worktreeRoot: worktree.root,
        approvalId,
        conflictApprovalId,
        sourceBranch,
        targetBranch,
        applied: result.applied,
        output: result.output,
      });
      return;
    }
    case 'patches': {
      const projectId = resolveProjectId(projects, args[1]);
      const approvals = new ProjectApprovalRegistry(projectApprovalsDir(projectId), projectId);
      await approvals.load();
      outputJsonAware(args, approvals.list(), () => {
        for (const approval of approvals.list()) {
          const branchInfo = [approval.sourceBranch, approval.targetBranch].filter(Boolean).join(' -> ');
          console.log(`${approval.approvalId}  artifact=${approval.artifactName}  status=${approval.status}${branchInfo ? `  branch=${branchInfo}` : ''}`);
        }
      });
      return;
    }
    case 'patch-approve':
    case 'patch-deny': {
      const projectId = resolveProjectId(projects, args[1]);
      const approvalId = args[2];
      if (!approvalId) {
        throw new Error(`Usage: tako projects ${sub} <projectId|slug> <approvalId> [--reviewed-by <principalId>] [--reason <text>]`);
      }
      const approvals = new ProjectApprovalRegistry(projectApprovalsDir(projectId), projectId);
      await approvals.load();
      const row = await approvals.resolve(
        approvalId,
        sub === 'patch-approve' ? 'approved' : 'denied',
        readFlag(args, '--reviewed-by'),
        readFlag(args, '--reason'),
      );
      outputJsonAware(args, row);
      return;
    }
    case 'branches': {
      const projectId = resolveProjectId(projects, args[1]);
      const branches = new ProjectBranchRegistry(projectBranchesDir(projectId), projectId);
      await branches.load();
      outputJsonAware(args, branches.list(), () => {
        for (const branch of branches.list()) {
          console.log(`${branch.branchRecordId}  node=${branch.nodeId}  branch=${branch.branchName}  status=${branch.status}`);
        }
      });
      return;
    }
    case 'branch-register': {
      const projectId = resolveProjectId(projects, args[1]);
      const nodeId = readFlag(args, '--node') ?? (await readNodeIdentity())?.nodeId;
      const branchName = readFlag(args, '--branch');
      if (!nodeId || !branchName) {
        throw new Error('Usage: tako projects branch-register <projectId|slug> --branch <name> [--node <nodeId>] [--base <branch>]');
      }
      const worktrees = new ProjectWorktreeRegistry(projectWorktreesDir(projectId), projectId);
      await worktrees.load();
      const worktree = worktrees.findByNode(nodeId);
      const branchRegistry = new ProjectBranchRegistry(projectBranchesDir(projectId), projectId);
      await branchRegistry.load();
      const row = await branchRegistry.register({
        nodeId,
        branchName,
        baseBranch: readFlag(args, '--base'),
        worktreeRoot: worktree?.root,
      });
      outputJsonAware(args, row);
      return;
    }
    case 'background': {
      const projectId = resolveProjectId(projects, args[1]);
      const background = new ProjectBackgroundRegistry(projectBackgroundDir(projectId));
      await background.load();
      outputJsonAware(args, background.get() ?? { projectId, snapshot: null });
      return;
    }
    default:
      throw new Error('Usage: tako projects <list|create|show|policy|set-policy|root|set-root|members|add-member|remove-member|bind|artifacts|artifact-show|artifact-publish|artifact-sync|worktrees|worktree-register|workspace-status|patch-create|patch-apply|patches|patch-approve|patch-deny|branches|branch-register|background>');
  }
}
