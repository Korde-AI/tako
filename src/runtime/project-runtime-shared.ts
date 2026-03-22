import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExecutionContext } from '../core/execution-context.js';
import { syncProjectToHub } from '../network/sync.js';
import { ProjectArtifactRegistry } from '../projects/artifacts.js';
import { ProjectBackgroundRegistry } from '../projects/background.js';
import { ProjectBranchRegistry } from '../projects/branches.js';
import { bootstrapProjectHome } from '../projects/bootstrap.js';
import {
  defaultProjectArtifactsRoot,
  defaultProjectWorkspaceRootBySlug,
  defaultProjectWorktreeRootForProject,
  projectBackgroundRoot,
  projectBranchesRoot,
  resolveProjectRoot,
} from '../projects/root.js';
import type { Project, ProjectBackgroundSnapshot, ProjectRole } from '../projects/types.js';
import { ProjectWorktreeRegistry } from '../projects/worktrees.js';
import { getWorktreeRepoStatus } from '../projects/patches.js';
import type { SharedSession } from '../sessions/shared.js';
import type { ProjectRuntimeInput, ProjectRuntimeShared, ResolvedProjectBinding } from './project-runtime-types.js';

export function createProjectRuntimeShared(input: ProjectRuntimeInput): ProjectRuntimeShared {
  const resolveProject = (args: {
    platform: string;
    channelTarget: string;
    threadId?: string;
    agentId?: string;
  }): ResolvedProjectBinding | null => {
    const binding = input.projectBindings.resolve(args);
    if (!binding) return null;
    const project = input.projectRegistry.get(binding.projectId);
    if (!project) return null;
    return { binding, project };
  };

  const resolveProjectForToolContext = (args: {
    explicitProjectSlug?: string;
    executionContext?: ExecutionContext;
    sessionId?: string;
  }): Project | null => {
    if (args.explicitProjectSlug) {
      return input.projectRegistry.findBySlug(args.explicitProjectSlug) ?? null;
    }
    if (args.executionContext?.projectId) {
      return input.projectRegistry.get(args.executionContext.projectId);
    }
    if (args.executionContext?.platform && args.executionContext.channelTarget) {
      const metadata = args.executionContext.metadata ?? {};
      const channelTarget = typeof metadata['parentChannelId'] === 'string'
        ? metadata['parentChannelId']
        : args.executionContext.channelTarget;
      const threadId = typeof metadata['threadId'] === 'string'
        ? metadata['threadId']
        : args.executionContext.threadId;
      const resolved = resolveProject({
        platform: args.executionContext.platform,
        channelTarget,
        threadId,
        agentId: args.executionContext.agentId,
      });
      if (resolved?.project) {
        return resolved.project;
      }
    }
    const session = args.sessionId ? input.sessions.get(args.sessionId) : undefined;
    if (args.executionContext?.platform && args.executionContext.channelTarget) {
      const sessionRecentProjectId = typeof session?.metadata?.recentProjectId === 'string'
        ? session.metadata.recentProjectId
        : undefined;
      const sessionRecentProjectSlug = typeof session?.metadata?.recentProjectSlug === 'string'
        ? session.metadata.recentProjectSlug
        : undefined;
      const sessionRecentChannelId = typeof session?.metadata?.recentProjectRoomChannelId === 'string'
        ? session.metadata.recentProjectRoomChannelId
        : undefined;
      const sessionRecentThreadId = typeof session?.metadata?.recentProjectRoomThreadId === 'string'
        ? session.metadata.recentProjectRoomThreadId
        : undefined;
      const metadata = args.executionContext.metadata ?? {};
      const currentChannelTarget = typeof metadata['parentChannelId'] === 'string'
        ? metadata['parentChannelId']
        : args.executionContext.channelTarget;
      const currentThreadId = typeof metadata['threadId'] === 'string'
        ? metadata['threadId']
        : args.executionContext.threadId;
      const sameRecentRoom = sessionRecentChannelId
        && sessionRecentChannelId === currentChannelTarget
        && (sessionRecentThreadId ?? undefined) === (currentThreadId ?? undefined);
      if (sameRecentRoom) {
        if (sessionRecentProjectId) {
          const project = input.projectRegistry.get(sessionRecentProjectId);
          if (project) return project;
        }
        if (sessionRecentProjectSlug) {
          const project = input.projectRegistry.findBySlug(sessionRecentProjectSlug);
          if (project) return project;
        }
      }
    }
    const recentProjectId = typeof session?.metadata?.recentProjectId === 'string'
      ? session.metadata.recentProjectId
      : undefined;
    if (recentProjectId) {
      return input.projectRegistry.get(recentProjectId);
    }
    const recentProjectSlug = typeof session?.metadata?.recentProjectSlug === 'string'
      ? session.metadata.recentProjectSlug
      : undefined;
    if (recentProjectSlug) {
      return input.projectRegistry.findBySlug(recentProjectSlug);
    }
    return null;
  };

  const ensureLocalProjectMirror = async (args: {
    project: Project;
    source: 'invite_accept' | 'project_sync';
    inviteId?: string;
    hostNodeId?: string;
    hostNodeName?: string;
    offeredRole?: ProjectRole;
    sharedDocs?: Record<string, string>;
  }): Promise<{ projectRoot: string; worktreeRoot: string; created: boolean }> => {
    await bootstrapProjectHome(input.runtimePaths.projectsDir, args.project);
    const projectRoot = resolveProjectRoot(input.runtimePaths, args.project);
    const worktreeRoot = defaultProjectWorktreeRootForProject(args.project, input.runtimePaths, input.getNodeIdentity().nodeId);
    const worktrees = new ProjectWorktreeRegistry(join(input.runtimePaths.projectsDir, args.project.projectId, 'worktrees'), args.project.projectId);
    await worktrees.load();
    const existingWorktree = worktrees.findByNode(input.getNodeIdentity().nodeId);
    await worktrees.register({
      nodeId: input.getNodeIdentity().nodeId,
      root: worktreeRoot,
      label: existingWorktree?.label ?? (args.source === 'invite_accept' ? 'network-joined' : 'node-local'),
      ownerPrincipalId: existingWorktree?.ownerPrincipalId,
      metadata: {
        ...(existingWorktree?.metadata ?? {}),
        source: args.source,
        ...(args.inviteId ? { inviteId: args.inviteId } : {}),
        ...(args.hostNodeId ? { hostNodeId: args.hostNodeId } : {}),
      },
    });

    const projectDocPath = join(projectRoot, 'PROJECT.md');
    const statusPath = join(projectRoot, 'STATUS.md');
    const noticePath = join(projectRoot, 'NOTICE.md');
    const sharedDocs = args.sharedDocs ?? {};
    const created = !existsSync(projectDocPath) || !existsSync(statusPath) || !existsSync(noticePath) || !existingWorktree;

    if (!existsSync(projectDocPath)) {
      await writeFile(projectDocPath, sharedDocs['PROJECT.md'] ?? [
        `# ${args.project.displayName}`,
        '',
        `- Slug: \`${args.project.slug}\``,
        `- Project ID: \`${args.project.projectId}\``,
        args.hostNodeId ? `- Imported from node: \`${args.hostNodeName ?? args.hostNodeId}\`` : null,
        args.offeredRole ? `- Role on this node: \`${args.offeredRole}\`` : null,
        '',
        '## Local Node Workspace',
        `- Workspace root: \`${projectRoot}\``,
        `- Worktree root: \`${worktreeRoot}\``,
        '',
      ].filter(Boolean).join('\n'), 'utf-8');
    }
    if (!existsSync(statusPath)) {
      await writeFile(statusPath, sharedDocs['STATUS.md'] ?? [
        '# STATUS',
        '',
        '## Current Goal',
        args.hostNodeId ? `- Sync shared project context from ${args.hostNodeName ?? args.hostNodeId}` : '- Review the current shared project state',
        '',
        '## In Progress',
        '- Local workspace bootstrapped',
        '- Local worktree registered',
        '',
        '## Next Actions',
        '- Review PROJECT.md and shared coordination updates',
        '- Sync or pull shared project artifacts if needed',
        '',
      ].join('\n'), 'utf-8');
    }
    if (!existsSync(noticePath)) {
      await writeFile(noticePath, sharedDocs['NOTICE.md'] ?? [
        '# NOTICE',
        '',
        args.inviteId
          ? `Joined through invite \`${args.inviteId}\` from \`${args.hostNodeName ?? args.hostNodeId}\`.`
          : 'This local project mirror was provisioned so this node has an active workspace and worktree.',
        '',
        '## Local Node Workspace',
        `- Workspace root: \`${projectRoot}\``,
        `- Worktree root: \`${worktreeRoot}\``,
        '',
      ].join('\n'), 'utf-8');
    }

    return { projectRoot, worktreeRoot, created };
  };

  const notifyPatchApprovalReview = async (args: {
    projectId: string;
    projectSlug?: string;
    approvalId: string;
    artifactName: string;
    requestedByNodeId?: string;
    requestedByPrincipalId?: string;
    sourceBranch?: string;
    targetBranch?: string;
    conflictSummary?: string;
  }): Promise<void> => {
    const bindings = input.projectBindings.list().filter((binding) => binding.projectId === args.projectId);
    if (bindings.length === 0) return;
    const bindingsByPlatform = new Map<string, typeof bindings>();
    for (const binding of bindings) {
      const bucket = bindingsByPlatform.get(binding.platform) ?? [];
      bucket.push(binding);
      bindingsByPlatform.set(binding.platform, bucket);
    }
    for (const [platform, platformBindings] of bindingsByPlatform.entries()) {
      const adapter = input.channelDeliveryRegistry.get(platform);
      if (!adapter) continue;
      await adapter.sendPatchApproval(platformBindings, args);
    }
  };

  const formatSharedSessionJoinNotice = (args: {
    displayName: string;
    projectSlug: string;
    snapshotSummary?: string;
  }): string => {
    return [
      '🤝 **Participant Joined**',
      `${args.displayName} joined **${args.projectSlug}**.`,
      args.snapshotSummary ? `🧭 ${args.snapshotSummary}` : null,
    ].filter(Boolean).join('\n');
  };

  const buildProjectBackground = async (
    projectId: string,
    reason: string,
    shared?: SharedSession | null,
  ): Promise<ProjectBackgroundSnapshot | null> => {
    const project = input.projectRegistry.get(projectId);
    if (!project) return null;
    const artifactRegistry = new ProjectArtifactRegistry(defaultProjectArtifactsRoot(input.runtimePaths, projectId), projectId);
    const worktreeRegistry = new ProjectWorktreeRegistry(join(input.runtimePaths.projectsDir, projectId, 'worktrees'), projectId);
    const branchRegistry = new ProjectBranchRegistry(projectBranchesRoot(input.runtimePaths, projectId), projectId);
    const backgroundRegistry = new ProjectBackgroundRegistry(projectBackgroundRoot(input.runtimePaths, projectId));
    await Promise.all([artifactRegistry.load(), worktreeRegistry.load(), branchRegistry.load(), backgroundRegistry.load()]);
    const branches = branchRegistry.list();
    const members = input.projectMemberships.listByProject(projectId).map((membership) => ({
      principalId: membership.principalId,
      displayName: input.principalRegistry.get(membership.principalId)?.displayName,
      role: membership.role,
    }));
    const worktrees = await Promise.all(worktreeRegistry.list().map(async (worktree) => {
      const repo = await getWorktreeRepoStatus(worktree.root);
      const branch = branches.find((row) => row.nodeId === worktree.nodeId && row.status === 'active');
      return {
        ...worktree,
        branch: branch?.branchName ?? repo.branch,
        dirty: repo.dirty,
      };
    }));
    const networkSession = input.networkSharedSessions.findByProject(projectId)
      .find((candidate) => candidate.participantNodeIds.includes(input.getNodeIdentity().nodeId)) ?? null;
    const snapshot = await backgroundRegistry.buildAndSave({
      project,
      reason,
      sharedSession: shared ?? null,
      networkSession,
      members,
      artifacts: artifactRegistry.list(),
      worktrees,
    });
    for (const session of input.sessions.list()) {
      if (session.metadata?.projectId === projectId) {
        session.metadata.projectBackgroundSummary = snapshot.summary;
      }
    }
    return snapshot;
  };

  const activateCollaborativeProject = async (projectId: string, reason: string): Promise<Project | null> => {
    const project = input.projectRegistry.get(projectId);
    if (!project) return null;
    const memberCount = input.projectMemberships.listByProject(projectId).length;
    if (memberCount <= 1) return project;
    if (project.collaboration?.mode === 'collaborative') return project;
    const updated = await input.projectRegistry.update(projectId, {
      collaboration: {
        ...(project.collaboration ?? {}),
        mode: 'collaborative',
        announceJoins: true,
        autoArtifactSync: project.collaboration?.autoArtifactSync ?? true,
      },
      metadata: {
        ...(project.metadata ?? {}),
        collaborationActivatedAt: new Date().toISOString(),
        collaborationActivatedReason: reason,
      },
    });
    const hubClient = input.getHubClient();
    if (hubClient) {
      await syncProjectToHub(hubClient, input.getNodeIdentity(), updated, input.projectMemberships).catch(() => {});
    }
    return updated;
  };

  const reconcileProjectCollaborationMode = async (projectId: string, reason: string): Promise<Project | null> => {
    const project = input.projectRegistry.get(projectId);
    if (!project) return null;
    const memberCount = input.projectMemberships.listByProject(projectId).length;
    const nextMode = memberCount > 1 ? 'collaborative' : 'single-user';
    if ((project.collaboration?.mode ?? 'single-user') === nextMode) {
      if (nextMode === 'collaborative') {
        return activateCollaborativeProject(projectId, reason);
      }
      return project;
    }
    const updated = await input.projectRegistry.update(projectId, {
      collaboration: {
        ...(project.collaboration ?? {}),
        mode: nextMode,
        announceJoins: nextMode === 'collaborative',
        autoArtifactSync: nextMode === 'collaborative'
          ? (project.collaboration?.autoArtifactSync ?? true)
          : false,
      },
      metadata: {
        ...(project.metadata ?? {}),
        collaborationReconciledAt: new Date().toISOString(),
        collaborationReconciledReason: reason,
      },
    });
    const hubClient = input.getHubClient();
    if (hubClient) {
      await syncProjectToHub(hubClient, input.getNodeIdentity(), updated, input.projectMemberships).catch(() => {});
    }
    return updated;
  };

  const collectInviteSharedDocsSnapshot = async (project: Project): Promise<Record<string, string>> => {
    const projectRoot = resolveProjectRoot(input.runtimePaths, project);
    const docs: Record<string, string> = {};
    for (const name of ['PROJECT.md', 'STATUS.md', 'NOTICE.md']) {
      const path = join(projectRoot, name);
      if (!existsSync(path)) continue;
      try {
        docs[name] = await readFile(path, 'utf-8');
      } catch {
        // Invite snapshots are best-effort.
      }
    }
    return docs;
  };

  const ensureAcceptedProjectWorkspaceAtRuntime = async (args: {
    invite: {
      inviteId: string;
      projectId: string;
      projectSlug: string;
      hostNodeId: string;
      hostNodeName?: string;
      issuedByPrincipalId: string;
      offeredRole: ProjectRole;
      metadata?: Record<string, unknown>;
    };
    executionContext?: ExecutionContext;
  }): Promise<{ projectId: string; projectRoot: string; worktreeRoot: string }> => {
    const inviteMetadata = args.invite.metadata ?? {};
    const projectDisplayName = typeof inviteMetadata['projectDisplayName'] === 'string'
      ? inviteMetadata['projectDisplayName']
      : args.invite.projectSlug;
    const sharedDocs = typeof inviteMetadata['sharedDocs'] === 'object' && inviteMetadata['sharedDocs']
      ? inviteMetadata['sharedDocs'] as Record<string, string>
      : {};
    const imported = await input.projectRegistry.importProject({
      projectId: args.invite.projectId,
      slug: args.invite.projectSlug,
      displayName: projectDisplayName,
      ownerPrincipalId: args.invite.issuedByPrincipalId,
      workspaceRoot: defaultProjectWorkspaceRootBySlug(input.config.memory.workspace, args.invite.projectSlug),
      status: 'active',
      collaboration: {
        mode: 'collaborative',
        announceJoins: true,
        autoArtifactSync: true,
      },
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      metadata: {
        importedFromInviteId: args.invite.inviteId,
        importedFromNodeId: args.invite.hostNodeId,
        importedFromNodeName: args.invite.hostNodeName,
        acceptedRole: args.invite.offeredRole,
      },
    });

    const localMirror = await ensureLocalProjectMirror({
      project: imported,
      source: 'invite_accept',
      inviteId: args.invite.inviteId,
      hostNodeId: args.invite.hostNodeId,
      hostNodeName: args.invite.hostNodeName,
      offeredRole: args.invite.offeredRole,
      sharedDocs,
    });

    const acceptedCtx = args.executionContext;
    if (acceptedCtx?.platform === 'discord' && acceptedCtx.agentId) {
      const bindChannelTarget = acceptedCtx.threadId
        ? (acceptedCtx.metadata?.['parentChannelId'] as string | undefined) ?? acceptedCtx.channelTarget
        : acceptedCtx.channelTarget;
      if (bindChannelTarget) {
        const existingBinding = input.projectBindings.resolve({
          platform: 'discord',
          channelTarget: bindChannelTarget,
          threadId: acceptedCtx.threadId,
          agentId: acceptedCtx.agentId,
        });
        if (!existingBinding || existingBinding.projectId !== imported.projectId) {
          await input.projectBindings.bind({
            projectId: imported.projectId,
            platform: 'discord',
            channelTarget: bindChannelTarget,
            threadId: acceptedCtx.threadId,
            agentId: acceptedCtx.agentId,
          });
        }
      }
    }
    return { projectId: imported.projectId, projectRoot: localMirror.projectRoot, worktreeRoot: localMirror.worktreeRoot };
  };

  return {
    input,
    resolveProject,
    resolveProjectForToolContext,
    ensureLocalProjectMirror,
    collectInviteSharedDocsSnapshot,
    ensureAcceptedProjectWorkspaceAtRuntime,
    buildProjectBackground,
    activateCollaborativeProject,
    reconcileProjectCollaborationMode,
    notifyPatchApprovalReview,
    formatSharedSessionJoinNotice,
  };
}
