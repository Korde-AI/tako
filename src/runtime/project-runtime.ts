import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DiscordChannel } from '../channels/discord.js';
import type { ChannelPlatform } from '../channels/platforms.js';
import type { TakoConfig } from '../config/schema.js';
import type { ExecutionContext } from '../core/execution-context.js';
import type { NodeIdentity } from '../core/node-identity.js';
import type { TakoPaths } from '../core/paths.js';
import type { SessionManager } from '../gateway/session.js';
import type { EdgeHubClient } from '../network/edge-client.js';
import { compareAuthorityRoles, isRoleWithinAuthorityCeiling, isValidAuthorityCeiling } from '../network/authority.js';
import {
  matchesNodeHint,
  normalizeNodeHint,
  renderProjectInviteRelay,
  selectLatestMatchingRelayInvite,
} from '../network/discord-relay.js';
import { InviteStore, type ProjectInvite } from '../network/invites.js';
import { sendNetworkSessionEvent } from '../network/session-sync.js';
import {
  syncProjectMembershipsToHub,
  syncProjectToHub,
} from '../network/sync.js';
import type { NetworkSharedSessionStore } from '../network/shared-sessions.js';
import { TrustStore } from '../network/trust.js';
import type { PrincipalRegistry } from '../principals/registry.js';
import { getProjectRole, isProjectMember } from '../projects/access.js';
import { ProjectArtifactRegistry } from '../projects/artifacts.js';
import { ProjectBackgroundRegistry } from '../projects/background.js';
import { ProjectBranchRegistry } from '../projects/branches.js';
import type { ProjectBindingRegistry } from '../projects/bindings.js';
import { bootstrapProjectHome } from '../projects/bootstrap.js';
import { inferProjectBootstrapIntent } from '../projects/bootstrap-intent.js';
import type { ProjectChannelCoordinatorRegistry } from '../projects/channel-coordination.js';
import { getWorktreeRepoStatus } from '../projects/patches.js';
import type { ProjectMembershipRegistry } from '../projects/memberships.js';
import type { ProjectRegistry } from '../projects/registry.js';
import {
  defaultProjectArtifactsRoot,
  defaultProjectWorkspaceRootBySlug,
  defaultProjectWorktreeRootForProject,
  projectBackgroundRoot,
  projectBranchesRoot,
  resolveProjectRoot,
} from '../projects/root.js';
import { detectProjectRoomSignal } from '../projects/room-signals.js';
import type { Project, ProjectBackgroundSnapshot, ProjectRole } from '../projects/types.js';
import { ProjectWorktreeRegistry } from '../projects/worktrees.js';
import type { SharedSession } from '../sessions/shared.js';
import type {
  ProjectBootstrapRequest,
  ProjectCloseRequest,
  ProjectMemberManageRequest,
  ProjectNetworkManageRequest,
  ProjectSyncRequest,
} from '../tools/projects.js';
import type { ToolContext, ToolResult } from '../tools/tool.js';
import type { DiscordRoomAccessRequest, DiscordRoomInspectRequest } from '../tools/discord-room.js';
import type { ChannelDeliveryRegistry } from '../core/channel-delivery.js';

interface ResolvedProjectBinding {
  binding: NonNullable<ReturnType<ProjectBindingRegistry['resolve']>>;
  project: Project;
}

interface ResolvedDiscordIdentity {
  principalId: string;
  displayName: string;
  userId?: string;
  username?: string;
}

interface ProjectRoomNotifierLike {
  notify(projectId: string, content: string): Promise<void>;
}

interface DiscordProjectSupportLike {
  resolvePrincipalIdentity(identity: string): ResolvedDiscordIdentity | null;
  resolvePrincipalIdentityFromRoom(identity: string, ctx: ToolContext): Promise<ResolvedDiscordIdentity | null>;
}

interface ProjectRuntimeInput {
  config: TakoConfig;
  runtimePaths: TakoPaths;
  sessions: SessionManager;
  principalRegistry: PrincipalRegistry;
  projectRegistry: ProjectRegistry;
  projectMemberships: ProjectMembershipRegistry;
  projectBindings: ProjectBindingRegistry;
  projectChannelCoordinators: ProjectChannelCoordinatorRegistry;
  channelDeliveryRegistry: ChannelDeliveryRegistry;
  trustStore: TrustStore;
  networkSharedSessions: NetworkSharedSessionStore;
  getHubClient: () => EdgeHubClient | null;
  getNodeIdentity: () => NodeIdentity;
  getProjectRoomNotifier: () => ProjectRoomNotifierLike;
  getDiscordProjectSupport: () => DiscordProjectSupportLike;
  getAgentBaseRole: (agentId: string) => string;
}

export interface ProjectRuntime {
  resolveProject(input: {
    platform: ChannelPlatform;
    channelTarget: string;
    threadId?: string;
    agentId?: string;
  }): ResolvedProjectBinding | null;
  buildProjectBackground(projectId: string, reason: string, shared?: SharedSession | null): Promise<ProjectBackgroundSnapshot | null>;
  activateCollaborativeProject(projectId: string, reason: string): Promise<Project | null>;
  autoEnrollProjectRoomParticipant(input: {
    project: Project;
    principalId: string;
    principalName?: string;
    platformUserId?: string;
    platform: ChannelPlatform;
    addedBy: string;
  }): Promise<boolean>;
  sweepProjectRoomSignal(input: {
    project: Project;
    principalId: string;
    principalName?: string;
    text: string;
  }): Promise<void>;
  normalizeDiscordPolicyIdentity(value?: string | null): string | null;
  buildAgentAccessMetadata(input: {
    platform: ChannelPlatform;
    agentId: string;
    authorId: string;
    principalId?: string;
    project?: Project | null;
    metadata?: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
  isDiscordInvocationAllowed(input: {
    agentId: string;
    authorId: string;
    authorName?: string;
    username?: string;
    principalId?: string;
    channelName?: string;
    parentChannelName?: string;
    project?: Project | null;
  }): Promise<{ allowed: boolean; reason: string }>;
  manageDiscordProjectMemberFromTool(input: ProjectMemberManageRequest, ctx: ToolContext): Promise<ToolResult>;
  syncDiscordProjectFromTool(input: ProjectSyncRequest, ctx: ToolContext): Promise<ToolResult>;
  closeDiscordProjectFromTool(input: ProjectCloseRequest, ctx: ToolContext): Promise<ToolResult>;
  manageDiscordRoomAccessFromTool(input: DiscordRoomAccessRequest, ctx: ToolContext): Promise<ToolResult>;
  inspectDiscordRoomFromTool(input: DiscordRoomInspectRequest, ctx: ToolContext): Promise<ToolResult>;
  manageProjectNetworkFromTool(input: ProjectNetworkManageRequest, ctx: ToolContext): Promise<ToolResult>;
  bootstrapDiscordProjectFromTool(input: ProjectBootstrapRequest, ctx: ToolContext): Promise<ToolResult>;
  notifyPatchApprovalReview(input: {
    projectId: string;
    projectSlug?: string;
    approvalId: string;
    artifactName: string;
    requestedByNodeId?: string;
    requestedByPrincipalId?: string;
    sourceBranch?: string;
    targetBranch?: string;
    conflictSummary?: string;
  }): Promise<void>;
  formatSharedSessionJoinNotice(input: {
    displayName: string;
    projectSlug: string;
    snapshotSummary?: string;
  }): string;
}

export function createProjectRuntime(input: ProjectRuntimeInput): ProjectRuntime {
  const resolveProject = (args: {
    platform: ChannelPlatform;
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
    const bindingsByPlatform = new Map<ChannelPlatform, typeof bindings>();
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

  const formatProjectWelcomeNotice = (args: {
    mention?: string;
    displayName: string;
    projectName: string;
    projectSlug: string;
    collaborative: boolean;
    summaryLine: string;
  }): string => {
    return [
      '🎉 **New Collaborator Joined**',
      `${args.mention ?? args.displayName} is now part of **${args.projectName}** \`(${args.projectSlug})\`.`,
      args.collaborative ? '🤝 Collaboration mode is now active.' : null,
      `🧭 Sync: ${args.summaryLine}`,
      '📘 Read `PROJECT.md` and `STATUS.md`, then share your current goal, progress, or blockers here.',
    ].filter(Boolean).join('\n');
  };

  const formatCoordinationNotice = (args: {
    kind: 'progress' | 'rebuttal';
    who: string;
    summary: string;
  }): string => {
    if (args.kind === 'progress') {
      return `📈 **Progress Update**\n${args.who}: ${args.summary}`;
    }
    return `⚠️ **Rebuttal / Risk Raised**\n${args.who}: ${args.summary}\nPlease review, respond, and align the next step.`;
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

  const autoEnrollProjectRoomParticipant = async (args: {
    project: Project;
    principalId: string;
    principalName?: string;
    platformUserId?: string;
    platform: ChannelPlatform;
    addedBy: string;
  }): Promise<boolean> => {
    if (args.platform !== 'discord') return false;
    if (isProjectMember(input.projectMemberships, args.project.projectId, args.principalId)) return false;
    if (args.principalId === args.project.ownerPrincipalId) return false;
    await input.projectMemberships.upsert({
      projectId: args.project.projectId,
      principalId: args.principalId,
      role: 'contribute',
      addedBy: args.addedBy,
    });
    const updatedProject = await activateCollaborativeProject(args.project.projectId, `member_auto_join:${args.principalId}`);
    const background = await buildProjectBackground(args.project.projectId, `member_auto_join:${args.principalId}`);
    const hubClient = input.getHubClient();
    if (hubClient) {
      await syncProjectToHub(hubClient, input.getNodeIdentity(), updatedProject ?? args.project, input.projectMemberships).catch(() => {});
      await syncProjectMembershipsToHub(hubClient, input.getNodeIdentity(), args.project.projectId, input.projectMemberships).catch(() => {});
    }
    const who = args.principalName ?? args.principalId;
    const mention = args.platformUserId ? `<@${args.platformUserId}>` : who;
    const summaryLine = background?.summary.split('\n')[0] ?? `Project ${args.project.displayName} (${args.project.slug})`;
    await input.getProjectRoomNotifier().notify(
      args.project.projectId,
      formatProjectWelcomeNotice({
        mention,
        displayName: who,
        projectName: args.project.displayName,
        projectSlug: args.project.slug,
        collaborative: (updatedProject?.collaboration?.mode ?? args.project.collaboration?.mode) === 'collaborative',
        summaryLine,
      }),
    );
    return true;
  };

  const sweepProjectRoomSignal = async (args: {
    project: Project;
    principalId: string;
    principalName?: string;
    text: string;
  }): Promise<void> => {
    const signal = detectProjectRoomSignal(args.text);
    if (!signal) return;

    const projectRoot = resolveProjectRoot(input.runtimePaths, args.project);
    const statusPath = join(projectRoot, 'STATUS.md');
    const prior = existsSync(statusPath) ? await readFile(statusPath, 'utf-8') : '# STATUS\n';
    const stamp = new Date().toISOString();
    const heading = signal.kind === 'progress' ? '## Room Progress Signals' : '## Rebuttals And Risks';
    const line = `- ${stamp} — ${args.principalName ?? args.principalId}: ${signal.summary}`;
    await writeFile(statusPath, `${prior.trimEnd()}\n\n${heading}\n${line}\n`, 'utf-8');

    const background = await buildProjectBackground(args.project.projectId, `room_signal:${signal.kind}`);
    const notice = formatCoordinationNotice({
      kind: signal.kind === 'progress' ? 'progress' : 'rebuttal',
      who: args.principalName ?? args.principalId,
      summary: signal.summary,
    });
    await input.getProjectRoomNotifier().notify(args.project.projectId, notice);

    const hubClient = input.getHubClient();
    if (hubClient) {
      await syncProjectToHub(hubClient, input.getNodeIdentity(), input.projectRegistry.get(args.project.projectId) ?? args.project, input.projectMemberships).catch(() => {});
    }

    const networkSession = input.networkSharedSessions.findByProject(args.project.projectId)
      .find((candidate) => candidate.participantNodeIds.includes(input.getNodeIdentity().nodeId)) ?? null;
    if (hubClient && networkSession?.participantNodeIds.length) {
      await sendNetworkSessionEvent(hubClient, input.networkSharedSessions, input.trustStore, {
        eventId: crypto.randomUUID(),
        networkSessionId: networkSession.networkSessionId,
        projectId: args.project.projectId,
        fromNodeId: input.getNodeIdentity().nodeId,
        fromPrincipalId: args.principalId,
        type: 'system',
        audience: 'specific-nodes',
        targetNodeIds: networkSession.participantNodeIds,
        payload: {
          summary: notice,
          metadata: {
            signalKind: signal.kind,
            projectSlug: args.project.slug,
            backgroundSummary: background?.summary,
          },
        },
        createdAt: new Date().toISOString(),
      }).catch(() => {});
    }
  };

  const ensureDiscordBootstrapOwnership = async (
    agentId: string,
    authorId: string,
    principalId?: string,
  ): Promise<boolean> => {
    const { claimOwner, loadAllowFrom } = await import('../auth/allow-from.js');
    const acl = await loadAllowFrom('discord', agentId);
    if (acl.mode === 'open' && acl.claimed !== true) {
      const claimed = await claimOwner('discord', agentId, authorId, principalId);
      return claimed.success;
    }
    if (acl.mode !== 'allowlist' || acl.claimed !== true) return false;
    if (principalId && (acl.allowedPrincipalIds ?? []).includes(principalId)) return true;
    return (acl.allowedUserIds ?? []).includes(authorId);
  };

  const normalizeDiscordPolicyIdentity = (value?: string | null): string | null => {
    if (!value) return null;
    const normalized = value.trim().replace(/^@+/, '').toLowerCase();
    return normalized.length > 0 ? normalized : null;
  };

  const matchesDiscordPolicyUser = (
    configured: string[] | undefined,
    args: { authorId: string; authorName?: string; username?: string; principalId?: string },
  ): boolean => {
    if (!configured?.length) return false;
    const candidates = new Set<string>();
    const add = (value?: string | null) => {
      const normalized = normalizeDiscordPolicyIdentity(value);
      if (normalized) candidates.add(normalized);
    };
    add(args.authorId);
    add(args.authorName);
    add(args.username);
    add(args.principalId);
    return configured.some((value) => {
      const normalized = normalizeDiscordPolicyIdentity(value);
      return normalized ? candidates.has(normalized) : false;
    });
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
        // Ignore unreadable files; invite snapshots are best-effort.
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

  const buildAgentAccessMetadata = async (args: {
    platform: ChannelPlatform;
    agentId: string;
    authorId: string;
    principalId?: string;
    project?: Project | null;
    metadata?: Record<string, unknown>;
  }): Promise<Record<string, unknown>> => {
    const baseRole = input.getAgentBaseRole(args.agentId);
    if (args.platform === 'cli') {
      return {
        ...(args.metadata ?? {}),
        agentAccessMode: 'owner_full',
        effectiveAgentRole: baseRole,
        sharedMemoryOnly: false,
      };
    }

    const { loadAllowFrom } = await import('../auth/allow-from.js');
    const acl = await loadAllowFrom(args.platform, args.agentId);
    const isBotOrigin = args.metadata?.['isBot'] === true;
    const allowedPrincipalIds = acl.allowedPrincipalIds ?? [];
    const allowedUserIds = acl.allowedUserIds ?? [];
    const ownerPrincipalIds = allowedPrincipalIds.length > 0 ? [allowedPrincipalIds[0]] : [];
    const ownerUserIds = allowedUserIds.length > 0 ? [allowedUserIds[0]] : [];
    const isOwner = acl.mode === 'open' && acl.claimed !== true
      ? true
      : Boolean(
          (args.principalId && allowedPrincipalIds.includes(args.principalId))
          || allowedUserIds.includes(args.authorId),
        );

    if (isOwner) {
      return {
        ...(args.metadata ?? {}),
        agentAccessMode: 'owner_full',
        effectiveAgentRole: baseRole,
        sharedMemoryOnly: false,
      };
    }

    return {
      ...(args.metadata ?? {}),
      agentAccessMode: isBotOrigin ? 'peer_agent_readonly' : 'shared_readonly',
      effectiveAgentRole: 'shared_reader',
      sharedMemoryOnly: true,
      ownerUserIds,
      ownerPrincipalIds,
      isBotOrigin,
    };
  };

  const isDiscordInvocationAllowed = async (args: {
    agentId: string;
    authorId: string;
    authorName?: string;
    username?: string;
    principalId?: string;
    channelName?: string;
    parentChannelName?: string;
    project?: Project | null;
  }): Promise<{ allowed: boolean; reason: string }> => {
    const policy = input.config.channels.discord?.authPolicy;
    if (!policy?.enabled) return { allowed: true, reason: 'policy_disabled' };

    if (args.project) {
      if (args.principalId && isProjectMember(input.projectMemberships, args.project.projectId, args.principalId)) {
        return { allowed: true, reason: 'project_member' };
      }
      return {
        allowed: true,
        reason: 'project_room_presence',
      };
    }

    const generalChannels = (policy.generalChannels ?? ['general']).map((name) => name.trim().toLowerCase()).filter(Boolean);
    const channelName = (args.parentChannelName ?? args.channelName ?? '').trim().toLowerCase();
    const isGeneral = channelName.length > 0 && generalChannels.includes(channelName);
    if (isGeneral) {
      const { isUserAllowed } = await import('../auth/allow-from.js');
      const ownerAllowed = await isUserAllowed('discord', args.agentId, args.authorId, args.principalId);
      if (ownerAllowed) return { allowed: true, reason: 'general_owner' };
      return {
        allowed: matchesDiscordPolicyUser(policy.extraGeneralUsers, args),
        reason: 'general_extra_user',
      };
    }

    const { isUserAllowed } = await import('../auth/allow-from.js');
    const ownerAllowed = await isUserAllowed('discord', args.agentId, args.authorId, args.principalId);
    if (ownerAllowed) {
      return { allowed: true, reason: 'unbound_owner' };
    }

    return {
      allowed: true,
      reason: 'unbound_shared_readonly',
    };
  };

  const isCurrentNodeHint = (hint: string, executionContext?: ExecutionContext | null): boolean => matchesNodeHint(hint, [
    input.getNodeIdentity().nodeId,
    input.getNodeIdentity().name,
    executionContext?.agentId,
    (executionContext as { agentName?: string } | null | undefined)?.agentName,
    String(executionContext?.metadata?.['agentDiscordName'] ?? ''),
  ]);

  const resolveRemoteNodeIdFromHint = (
    hint: string,
    trusts: TrustStore,
    invites: InviteStore,
  ): { nodeId: string; nodeName?: string } | null => {
    const normalized = normalizeNodeHint(hint);
    if (!normalized) return null;

    for (const trust of trusts.list()) {
      if (matchesNodeHint(normalized, [trust.remoteNodeId, trust.remoteNodeName])) {
        return { nodeId: trust.remoteNodeId, nodeName: trust.remoteNodeName };
      }
    }

    for (const invite of invites.list()) {
      if (invite.targetNodeId && matchesNodeHint(normalized, [invite.targetNodeId, invite.targetHint])) {
        return { nodeId: invite.targetNodeId };
      }
      if (matchesNodeHint(normalized, [invite.hostNodeId, invite.hostNodeName])) {
        return { nodeId: invite.hostNodeId, nodeName: invite.hostNodeName };
      }
    }

    return null;
  };

  const manageDiscordProjectMemberFromTool = async (
    args: ProjectMemberManageRequest,
    ctx: ToolContext,
  ): Promise<ToolResult> => {
    const executionContext = ctx.executionContext;
    if (!executionContext || !executionContext.principalId || !executionContext.authorId || !executionContext.agentId) {
      return { output: '', success: false, error: 'Missing principal or channel execution context.' };
    }
    const project = resolveProjectForToolContext({
      explicitProjectSlug: args.projectSlug,
      executionContext,
      sessionId: ctx.sessionId,
    });
    if (!project) {
      return {
        output: 'There is no active or recently created project in this conversation yet. Move to the project room, or specify the project slug.',
        success: false,
        error: 'missing_project_context',
      };
    }

    const actorRole = getProjectRole(input.projectMemberships, project.projectId, executionContext.principalId);
    const isOwner = project.ownerPrincipalId === executionContext.principalId;
    const isAdmin = actorRole === 'admin';
    if (!isOwner && !isAdmin) {
      return {
        output: 'Only the project owner or an admin can manage project members.',
        success: false,
        error: 'owner_or_admin_required',
      };
    }

    if (args.action === 'list') {
      const memberships = input.projectMemberships.listByProject(project.projectId);
      const lines = memberships.map((membership) => {
        const principal = input.principalRegistry.get(membership.principalId);
        return `- ${principal?.displayName ?? membership.principalId} (${membership.role})`;
      });
      return {
        output: [
          `Project ${project.displayName} (${project.slug}) members:`,
          ...(lines.length ? lines : ['- none']),
        ].join('\n'),
        success: true,
        data: memberships,
      };
    }

    const targetIdentity = args.targetIdentity?.trim();
    if (!targetIdentity) {
      return { output: `targetIdentity is required to ${args.action} a project member.`, success: false, error: 'missing_target_identity' };
    }
    const resolved = input.getDiscordProjectSupport().resolvePrincipalIdentity(targetIdentity)
      ?? await input.getDiscordProjectSupport().resolvePrincipalIdentityFromRoom(targetIdentity, ctx);
    if (!resolved) {
      return {
        output: `Could not resolve Discord user or principal: ${targetIdentity}. Ask that user or agent to speak in this room once so I can map them, then retry.`,
        success: false,
        error: 'target_not_found',
      };
    }
    if (args.action === 'remove') {
      const removed = await input.projectMemberships.remove(project.projectId, resolved.principalId);
      if (!removed) {
        return {
          output: `${resolved.displayName} is not currently a member of ${project.displayName} (${project.slug}).`,
          success: false,
          error: 'membership_not_found',
        };
      }
      const updatedProject = await reconcileProjectCollaborationMode(project.projectId, `member_removed:${resolved.principalId}`);
      const background = await buildProjectBackground(project.projectId, `member_removed:${resolved.principalId}`);
      const hubClient = input.getHubClient();
      if (hubClient) {
        await syncProjectMembershipsToHub(hubClient, input.getNodeIdentity(), project.projectId, input.projectMemberships).catch(() => {});
      }
      await input.getProjectRoomNotifier().notify(
        project.projectId,
        `🧹 ${resolved.displayName} was removed from ${project.slug}.`,
      );
      return {
        output: [
          `Removed ${resolved.displayName} from ${project.displayName} (${project.slug}).`,
          `Project mode: ${updatedProject?.collaboration?.mode ?? 'single-user'}.`,
          background ? `Background: ${background.summary.split('\n')[0]}` : null,
        ].filter(Boolean).join('\n'),
        success: true,
        data: {
          projectId: project.projectId,
          principalId: resolved.principalId,
          removed: true,
        },
      };
    }

    const role: ProjectRole = args.role ?? 'contribute';
    await input.projectMemberships.upsert({
      projectId: project.projectId,
      principalId: resolved.principalId,
      role,
      addedBy: executionContext.principalId,
    });
    const updatedProject = await reconcileProjectCollaborationMode(project.projectId, `member_added:${resolved.principalId}`);
    const background = await buildProjectBackground(project.projectId, `member_added:${resolved.principalId}`);
    const hubClient = input.getHubClient();
    if (hubClient) {
      await syncProjectMembershipsToHub(hubClient, input.getNodeIdentity(), project.projectId, input.projectMemberships).catch(() => {});
    }
    await input.getProjectRoomNotifier().notify(
      project.projectId,
      `🎉 ${resolved.displayName} joined ${project.slug} as ${role}.`,
    );
    return {
      output: [
        `Added ${resolved.displayName} to ${project.displayName} (${project.slug}) as ${role}.`,
        `Project mode: ${updatedProject?.collaboration?.mode ?? 'single-user'}.`,
        background ? `Background: ${background.summary.split('\n')[0]}` : null,
      ].filter(Boolean).join('\n'),
      success: true,
      data: {
        projectId: project.projectId,
        principalId: resolved.principalId,
        role,
      },
    };
  };

  const syncDiscordProjectFromTool = async (
    args: ProjectSyncRequest,
    ctx: ToolContext,
  ): Promise<ToolResult> => {
    const executionContext = ctx.executionContext;
    if (!executionContext || !executionContext.principalId) {
      return { output: '', success: false, error: 'Missing principal execution context.' };
    }
    const project = resolveProjectForToolContext({
      explicitProjectSlug: args.projectSlug,
      executionContext,
      sessionId: ctx.sessionId,
    });
    if (!project) {
      return {
        output: 'There is no active or recently created project in this conversation yet. Move to the project room, or specify the project slug.',
        success: false,
        error: 'missing_project_context',
      };
    }
    const accessMode = String(executionContext.metadata?.['agentAccessMode'] ?? '');
    const isOwnerFull = accessMode === 'owner_full';
    const isMember = isProjectMember(input.projectMemberships, project.projectId, executionContext.principalId);
    const canWriteSharedState = isOwnerFull || isMember;
    if (!canWriteSharedState && accessMode !== 'shared_readonly') {
      return { output: 'Only project members or the owning agent can sync project state.', success: false, error: 'project_membership_required' };
    }

    const projectRoot = resolveProjectRoot(input.runtimePaths, project);
    const localMirror = await ensureLocalProjectMirror({
      project,
      source: 'project_sync',
    });
    const statusPath = join(projectRoot, 'STATUS.md');
    const update = args.update?.trim();
    if (update && canWriteSharedState) {
      const prior = existsSync(statusPath) ? await readFile(statusPath, 'utf-8') : '# STATUS\n';
      const stamp = new Date().toISOString();
      const appended = `${prior.trimEnd()}\n\n## Sync Notes\n- ${stamp} — ${update}\n`;
      await writeFile(statusPath, appended, 'utf-8');
    }

    const background = await buildProjectBackground(project.projectId, update ? 'project_sync:update' : 'project_sync');
    const summaryLine = background?.summary.split('\n')[0] ?? `Project ${project.displayName} (${project.slug})`;
    const announce = [
      canWriteSharedState ? `[sync] ${summaryLine}` : `[shared sync] ${summaryLine}`,
      update ? `Update: ${update}` : null,
    ].filter(Boolean).join('\n');
    await input.getProjectRoomNotifier().notify(project.projectId, announce);

    return {
      output: [
        `Synced ${project.displayName} (${project.slug}).`,
        localMirror.created ? `Provisioned local project workspace ${localMirror.projectRoot} and worktree ${localMirror.worktreeRoot}.` : null,
        update && canWriteSharedState ? 'STATUS.md updated.' : null,
        update && !canWriteSharedState ? 'Shared view announced without modifying project files.' : null,
        background ? `Background: ${summaryLine}` : null,
      ].filter(Boolean).join('\n'),
      success: true,
      data: {
        projectId: project.projectId,
        projectSlug: project.slug,
        statusPath,
      },
    };
  };

  const closeDiscordProjectFromTool = async (
    args: ProjectCloseRequest,
    ctx: ToolContext,
  ): Promise<ToolResult> => {
    const executionContext = ctx.executionContext;
    if (!executionContext || !executionContext.principalId) {
      return { output: '', success: false, error: 'Missing principal execution context.' };
    }
    const project = resolveProjectForToolContext({
      explicitProjectSlug: args.projectSlug,
      executionContext,
      sessionId: ctx.sessionId,
    });
    if (!project) {
      return {
        output: 'There is no active or recently created project in this conversation yet. Move to the project room, or specify the project slug.',
        success: false,
        error: 'missing_project_context',
      };
    }
    const actorRole = getProjectRole(input.projectMemberships, project.projectId, executionContext.principalId);
    const isOwner = project.ownerPrincipalId === executionContext.principalId;
    const isAdmin = actorRole === 'admin';
    if (!isOwner && !isAdmin) {
      return {
        output: 'Only the project owner or an admin can close a project.',
        success: false,
        error: 'owner_or_admin_required',
      };
    }

    const projectRoot = resolveProjectRoot(input.runtimePaths, project);
    const statusPath = join(projectRoot, 'STATUS.md');
    const reason = args.reason?.trim();
    const updated = await input.projectRegistry.update(project.projectId, {
      status: 'closed',
      metadata: {
        ...(project.metadata ?? {}),
        closedAt: new Date().toISOString(),
        closedBy: executionContext.principalId,
        closeReason: reason ?? null,
      },
    });

    const prior = existsSync(statusPath) ? await readFile(statusPath, 'utf-8') : '# STATUS\n';
    const closureBlock = [
      '',
      '## Closure',
      '- Status: closed',
      `- Closed by: ${executionContext.principalName ?? executionContext.principalId}`,
      reason ? `- Reason: ${reason}` : null,
    ].filter(Boolean).join('\n');
    await writeFile(statusPath, `${prior.trimEnd()}\n${closureBlock}\n`, 'utf-8');

    const background = await buildProjectBackground(project.projectId, 'project_close');
    await input.getProjectRoomNotifier().notify(
      project.projectId,
      [
        `[project closed] ${updated.displayName} (${updated.slug})`,
        reason ? `Reason: ${reason}` : null,
      ].filter(Boolean).join('\n'),
    );

    return {
      output: [
        `Closed ${updated.displayName} (${updated.slug}).`,
        'Project status: closed.',
        reason ? `Reason: ${reason}` : null,
        background ? `Background: ${background.summary.split('\n')[0]}` : null,
      ].filter(Boolean).join('\n'),
      success: true,
      data: {
        projectId: updated.projectId,
        projectSlug: updated.slug,
        status: updated.status,
      },
    };
  };

  const manageDiscordRoomAccessFromTool = async (
    args: DiscordRoomAccessRequest,
    ctx: ToolContext,
  ): Promise<ToolResult> => {
    const executionContext = ctx.executionContext;
    if (!executionContext?.agentId) {
      return { output: '', success: false, error: 'Missing Discord execution context.' };
    }

    const targetIdentity = args.targetIdentity?.trim();
    if (!targetIdentity) {
      return { output: 'targetIdentity is required.', success: false, error: 'missing_target_identity' };
    }

    const resolved = input.getDiscordProjectSupport().resolvePrincipalIdentity(targetIdentity);
    if (!resolved?.userId) {
      return {
        output: `I could not resolve ${targetIdentity} to a Discord user in my known identities. Use their Discord user ID, or have them speak in the server first so I can map them.`,
        success: false,
        error: 'target_not_found',
      };
    }

    const metadata = executionContext.metadata ?? {};
    const currentChannelId = typeof metadata['parentChannelId'] === 'string'
      ? metadata['parentChannelId']
      : executionContext.channelTarget;
    const channelId = args.channelId?.trim() || currentChannelId;
    if (!channelId) {
      return {
        output: 'I do not know which Discord channel to update from this context. Specify the channel explicitly.',
        success: false,
        error: 'missing_channel_context',
      };
    }

    const coordinator = input.projectChannelCoordinators.get('discord');
    if (!coordinator) return { output: '', success: false, error: 'Discord project coordinator not available.' };

    try {
      await coordinator.grantRoomAccess({
        agentId: executionContext.agentId,
        channelId,
        userId: resolved.userId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('is not in guild')) {
        return {
          output: `${resolved.displayName} is not currently in this Discord server. Invite them to the server first, then I can grant channel access.`,
          success: false,
          error: 'target_not_in_guild',
        };
      }
      return {
        output: `Failed to grant Discord channel access: ${message}`,
        success: false,
        error: 'channel_access_failed',
      };
    }

    return {
      output: `Granted ${resolved.displayName} access to this Discord channel.`,
      success: true,
      data: {
        channelId,
        principalId: resolved.principalId,
        userId: resolved.userId,
      },
    };
  };

  const inspectDiscordRoomFromTool = async (
    args: DiscordRoomInspectRequest,
    ctx: ToolContext,
  ): Promise<ToolResult> => {
    const executionContext = ctx.executionContext;
    if (!executionContext?.agentId) {
      return { output: '', success: false, error: 'Missing Discord execution context.' };
    }

    const metadata = executionContext.metadata ?? {};
    const currentChannelId = typeof metadata['parentChannelId'] === 'string'
      ? metadata['parentChannelId']
      : executionContext.channelTarget;
    const threadId = typeof metadata['threadId'] === 'string' ? metadata['threadId'] : undefined;
    const channelId = args.channelId?.trim() || currentChannelId;
    if (!channelId) {
      return {
        output: 'I do not know which Discord room to inspect from this context.',
        success: false,
        error: 'missing_channel_context',
      };
    }

    const coordinator = input.projectChannelCoordinators.get('discord');
    if (!coordinator) return { output: '', success: false, error: 'Discord project coordinator not available.' };

    let inspection;
    try {
      inspection = await coordinator.inspectRoom({
        agentId: executionContext.agentId,
        channelId,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        output: `Failed to inspect the Discord room: ${message}`,
        success: false,
        error: 'discord_room_inspect_failed',
      };
    }

    const binding = input.projectBindings.resolve({
      platform: 'discord',
      channelTarget: channelId,
      threadId,
      agentId: executionContext.agentId,
    });
    const project = binding
      ? input.projectRegistry.get(binding.projectId)
      : resolveProjectForToolContext({
          executionContext,
          sessionId: ctx.sessionId,
        });
    const membershipLines = project
      ? input.projectMemberships.listByProject(project.projectId).map((membership) => {
          const principal = input.principalRegistry.get(membership.principalId);
          return `- ${principal?.displayName ?? membership.principalId} (${membership.role})`;
        })
      : [];

    return {
      output: [
        'Use this as the fresh room-access snapshot for the current question. Do not reuse older membership observations or infer unlisted users/bots.',
        'When you need to @mention someone in Discord, use the provided `mention` form exactly as shown.',
        `Discord room: ${inspection.channelName ?? inspection.channelId}`,
        inspection.guildName ? `Server: ${inspection.guildName} (${inspection.guildId})` : null,
        `Room type: ${inspection.kind}${inspection.private ? ' (private/private-like)' : ' (public or role-visible)'}`,
        `Observed room members/access count: ${inspection.members.length}`,
        inspection.members.length > 0
          ? `Observed room members/access:\n${inspection.members.map((member) => `- ${member.displayName ?? member.username ?? member.userId} [${member.source}] mention=<@${member.userId}> userId=${member.userId}`).join('\n')}`
          : 'Observed room members/access: none listed directly from Discord.',
        inspection.notes.length > 0 ? `Notes:\n${inspection.notes.map((note) => `- ${note}`).join('\n')}` : null,
        project
          ? `Bound project: ${project.displayName} (${project.slug})`
          : 'Bound project: none',
        project
          ? `Project members:\n${membershipLines.join('\n') || '- none'}`
          : null,
      ].filter(Boolean).join('\n'),
      success: true,
      data: {
        inspection,
        projectId: project?.projectId,
        projectSlug: project?.slug,
      },
    };
  };

  const manageProjectNetworkFromTool = async (
    args: ProjectNetworkManageRequest,
    ctx: ToolContext,
  ): Promise<ToolResult> => {
    const executionContext = ctx.executionContext;
    const nodeIdentity = input.getNodeIdentity();
    if (!executionContext?.principalId) {
      return { output: '', success: false, error: 'Missing principal or node execution context.' };
    }

    const invites = new InviteStore(input.runtimePaths.invitesFile);
    const trusts = new TrustStore(input.runtimePaths.trustFile);
    await Promise.all([invites.load(), trusts.load()]);

    if (args.action === 'invite_list') {
      await invites.expirePending();
      const rows = invites.list();
      return {
        output: rows.length > 0
          ? `Invites on this node:\n${rows.map((invite) => `- ${invite.inviteId}: ${invite.projectSlug} host=${invite.hostNodeName ?? invite.hostNodeId} role=${invite.offeredRole} status=${invite.status}`).join('\n')}`
          : 'No invites found on this node.',
        success: true,
        data: rows,
      };
    }

    if (args.action === 'invite_create') {
      const project = resolveProjectForToolContext({
        explicitProjectSlug: args.projectSlug,
        executionContext,
        sessionId: ctx.sessionId,
      });
      if (!project) {
        return { output: 'There is no active or recently created project in this conversation yet. Move to the project room, or specify the project slug.', success: false, error: 'missing_project_context' };
      }
      const actorRole = getProjectRole(input.projectMemberships, project.projectId, executionContext.principalId);
      const isOwner = project.ownerPrincipalId === executionContext.principalId;
      if (!isOwner && actorRole !== 'admin') {
        return { output: 'Only the project owner or an admin can invite another node into the project.', success: false, error: 'owner_or_admin_required' };
      }
      const targetHint = args.targetHint?.trim();
      const resolvedRemote = args.targetNodeId?.trim()
        ? { nodeId: args.targetNodeId.trim(), nodeName: undefined }
        : (targetHint ? resolveRemoteNodeIdFromHint(targetHint, trusts, invites) : null);
      const targetNodeId = resolvedRemote?.nodeId;
      const role = (args.role ?? 'contribute');
      const ceiling = (args.ceiling ?? role);
      const sharedDocs = await collectInviteSharedDocsSnapshot(project);
      if (!isValidAuthorityCeiling(role) || !isValidAuthorityCeiling(ceiling) || !isRoleWithinAuthorityCeiling(role, ceiling)) {
        return { output: 'The requested invite role exceeds the requested authority ceiling.', success: false, error: 'invalid_role_ceiling' };
      }

      if (!targetNodeId && !targetHint) {
        return {
          output: 'Provide a target bot/agent identity such as `jiaxinassistant`, an @mention, or a node name so I can route the invite without exposing raw node IDs.',
          success: false,
          error: 'missing_target_identity',
        };
      }

      if (targetNodeId) {
        await trusts.createPending({
          remoteNodeId: targetNodeId,
          remoteNodeName: resolvedRemote?.nodeName,
          authorityCeiling: ceiling,
          metadata: { source: 'discord_invite_create', projectId: project.projectId },
        });
      }
      const invite = await invites.create({
        projectId: project.projectId,
        projectSlug: project.slug,
        hostNodeId: nodeIdentity.nodeId,
        hostNodeName: nodeIdentity.name,
        issuedByPrincipalId: executionContext.principalId,
        targetNodeId,
        targetHint,
        offeredRole: role,
        metadata: {
          transport: targetNodeId ? 'hub_or_direct' : 'discord_relay',
          requestedByAgentId: executionContext.agentId,
          projectDisplayName: project.displayName,
          projectDescription: project.description ?? '',
          sharedDocs,
        },
      });
      await input.projectRegistry.update(project.projectId, {
        collaboration: {
          ...(project.collaboration ?? {}),
          mode: 'collaborative',
          announceJoins: true,
          autoArtifactSync: project.collaboration?.autoArtifactSync ?? true,
        },
      });

      const useDiscordRelay = !targetNodeId && ctx.channelType === 'discord' && ctx.channel instanceof DiscordChannel;
      if (useDiscordRelay) {
        const discordChannel = ctx.channel as DiscordChannel;
        const channelTarget = executionContext.threadId ?? executionContext.channelTarget;
        if (!channelTarget) {
          return {
            output: 'I created the invite locally, but this Discord context does not expose a room target to relay it. Ask again from the shared room or specify the remote node directly.',
            success: false,
            error: 'missing_discord_relay_target',
          };
        }
        const relayPacket = renderProjectInviteRelay({
          kind: 'tako_project_invite_v1',
          invite,
        });
        await discordChannel.send({
          target: channelTarget,
          content: [
            `📨 Invite prepared for ${targetHint}.`,
            `Project: ${project.displayName} (${project.slug})`,
            `Role: ${role}`,
            '',
            relayPacket,
          ].join('\n'),
        }).catch(() => {});
        return {
          output: `Created a Discord relay invite for ${targetHint} to join ${project.displayName} (${project.slug}) as ${role}. Ask the receiving agent in this room to accept the latest invite here.`,
          success: true,
          data: invite,
        };
      }

      return {
        output: targetNodeId
          ? `Created invite ${invite.inviteId} for ${resolvedRemote?.nodeName ?? targetNodeId} to join ${project.displayName} (${project.slug}) as ${role}. The remote agent can accept invite ${invite.inviteId}.`
          : `Created invite ${invite.inviteId} for ${targetHint} to join ${project.displayName} (${project.slug}) as ${role}.`,
        success: true,
        data: invite,
      };
    }

    if (args.action === 'invite_accept') {
      const trusts = new TrustStore(input.runtimePaths.trustFile);
      await trusts.load();
      let invite: ProjectInvite | null = null;
      const inviteId = args.inviteId?.trim();
      if (inviteId) {
        invite = invites.get(inviteId);
      } else if (ctx.channelType === 'discord' && ctx.channel instanceof DiscordChannel) {
        const channelTarget = executionContext.threadId ?? executionContext.channelTarget;
        if (channelTarget) {
          const messages = await ctx.channel.fetchRecentMessages(channelTarget, 30).catch(() => []);
          const relay = selectLatestMatchingRelayInvite(messages, (candidate) => {
            const targetHint = candidate.invite.targetHint?.trim();
            return !targetHint || isCurrentNodeHint(targetHint, executionContext);
          });
          if (relay) {
            invite = await invites.importInvite(relay.invite);
          }
        }
      }
      if (!invite) {
        return {
          output: inviteId
            ? `Invite not found: ${inviteId}`
            : 'No matching project invite was found for this agent in the recent Discord room history. Ask the host agent to post an invite here or specify the invite ID.',
          success: false,
          error: inviteId ? 'invite_not_found' : 'invite_not_found_in_room',
        };
      }
      if (invite.status !== 'pending') {
        return { output: `Invite ${invite.inviteId} is not pending. Current status: ${invite.status}.`, success: false, error: 'invite_not_pending' };
      }
      const desiredCeiling = (args.ceiling ?? invite.offeredRole);
      if (!isValidAuthorityCeiling(desiredCeiling) || !isRoleWithinAuthorityCeiling(invite.offeredRole, desiredCeiling)) {
        return { output: `Invite role ${invite.offeredRole} exceeds requested ceiling ${desiredCeiling}.`, success: false, error: 'offered_role_exceeds_ceiling' };
      }
      const currentTrust = trusts.getByNodeId(invite.hostNodeId);
      if (currentTrust && compareAuthorityRoles(invite.offeredRole, currentTrust.authorityCeiling) > 0) {
        return { output: `Invite role ${invite.offeredRole} exceeds trusted ceiling ${currentTrust.authorityCeiling}.`, success: false, error: 'offered_role_exceeds_existing_ceiling' };
      }
      if (!currentTrust) {
        await trusts.createPending({
          remoteNodeId: invite.hostNodeId,
          remoteNodeName: invite.hostNodeName,
          authorityCeiling: desiredCeiling,
          metadata: { source: 'discord_invite_accept', projectId: invite.projectId },
        });
      }
      const trust = await trusts.markTrusted(invite.hostNodeId, desiredCeiling);
      await invites.markAccepted(invite.inviteId);
      const localProject = await ensureAcceptedProjectWorkspaceAtRuntime({
        invite,
        executionContext,
      });
      const session = ctx.sessionId ? input.sessions.get(ctx.sessionId) : undefined;
      if (session) {
        session.metadata.recentProjectId = invite.projectId;
        session.metadata.recentProjectSlug = invite.projectSlug;
        if (executionContext?.channelTarget) {
          const metadata = executionContext.metadata ?? {};
          session.metadata.recentProjectRoomChannelId = typeof metadata['parentChannelId'] === 'string'
            ? metadata['parentChannelId']
            : executionContext.channelTarget;
          session.metadata.recentProjectRoomThreadId = typeof metadata['threadId'] === 'string'
            ? metadata['threadId']
            : executionContext.threadId;
        }
        input.sessions.markSessionDirty(session.id);
      }
      const sharedDocNames = Object.keys((invite.metadata?.['sharedDocs'] as Record<string, string> | undefined) ?? {});
      return {
        output: [
          `Accepted invite ${invite.inviteId}.`,
          `This node joined ${invite.projectSlug} and trusted host ${invite.hostNodeName ?? invite.hostNodeId}.`,
          `Provisioned local project root ${localProject.projectRoot} and registered worktree ${localProject.worktreeRoot}.`,
          sharedDocNames.length > 0 ? `Synced shared docs: ${sharedDocNames.join(', ')}.` : null,
        ].filter(Boolean).join(' '),
        success: true,
        data: { trust, localProject, inviteId: invite.inviteId },
      };
    }

    return { output: '', success: false, error: 'unsupported_action' };
  };

  const bootstrapDiscordProjectFromTool = async (
    args: ProjectBootstrapRequest,
    ctx: ToolContext,
  ): Promise<ToolResult> => {
    if (ctx.channelType !== 'discord') {
      return { output: '', success: false, error: 'project_bootstrap currently supports Discord only.' };
    }
    if (!(ctx.channel instanceof DiscordChannel)) {
      return { output: '', success: false, error: 'Discord channel adapter not available in tool context.' };
    }
    const executionContext = ctx.executionContext;
    if (!executionContext?.principalId || !executionContext.authorId || !executionContext.agentId) {
      return { output: '', success: false, error: 'Missing principal or channel execution context.' };
    }

    const prompt = args.prompt?.trim();
    if (!prompt) return { output: '', success: false, error: 'prompt is required.' };

    const intent = inferProjectBootstrapIntent(prompt);
    const destination = args.destination && args.destination !== 'auto'
      ? args.destination
      : intent.destination;
    const projectType = intent.projectType;
    const displayName = args.displayName?.trim() || intent.displayName;
    const slug = args.slug?.trim() || intent.slug;
    const description = args.description?.trim() || intent.description;

    const isOwner = await ensureDiscordBootstrapOwnership(executionContext.agentId, executionContext.authorId, executionContext.principalId);
    const currentProjectId = executionContext.projectId;
    const existingRole = currentProjectId
      ? getProjectRole(input.projectMemberships, currentProjectId, executionContext.principalId)
      : null;
    const isAdmin = existingRole === 'admin';
    if (!isOwner && !isAdmin) {
      return {
        output: 'Project bootstrap is restricted to the claimed owner or a project admin in this Discord context.',
        success: false,
        error: 'owner_or_admin_required',
      };
    }

    const existing = input.projectRegistry.findBySlug(slug);
    const project = existing ?? await input.projectRegistry.create({
      slug,
      displayName,
      ownerPrincipalId: executionContext.principalId,
      workspaceRoot: defaultProjectWorkspaceRootBySlug(input.config.memory.workspace, slug),
      description,
      collaboration: {
        mode: 'single-user',
        autoArtifactSync: false,
        patchRequiresApproval: true,
        announceJoins: false,
      },
      metadata: {
        createdFrom: 'discord-tool-bootstrap',
        requestedInChannel: executionContext.channelId,
        projectType,
      },
    });
    if (!existing) {
      await bootstrapProjectHome(input.runtimePaths.projectsDir, project);
    }
    await input.projectMemberships.upsert({
      projectId: project.projectId,
      principalId: executionContext.principalId,
      role: 'admin',
      addedBy: executionContext.principalId,
    });

    const metadata = executionContext.metadata ?? {};
    const currentChannelTarget = ctx.channelTarget ?? executionContext.channelTarget ?? '';
    const currentThreadId = executionContext.threadId;
    const parentChannelId = typeof metadata['parentChannelId'] === 'string' ? metadata['parentChannelId'] : undefined;
    const guildId = typeof metadata['guildId'] === 'string' ? metadata['guildId'] : undefined;

    let boundChannelTarget = currentChannelTarget;
    let boundThreadId: string | undefined = currentThreadId;
    let createdChannel: { id: string; name: string } | null = null;
    let createdThread: { id: string; name: string } | null = null;

    if (destination === 'channel') {
      if (!guildId) {
        return {
          output: 'Cannot create a Discord channel here because no guild context is available. Ask to use the current channel instead.',
          success: false,
          error: 'missing_guild_context',
        };
      }
      const coordinator = input.projectChannelCoordinators.get('discord');
      if (!coordinator) {
        return {
          output: 'Discord project coordinator is not available. Cannot create or bind a Discord project room here.',
          success: false,
          error: 'missing_discord_project_coordinator',
        };
      }
      const room = await coordinator.bootstrapProjectRoom({
        agentId: executionContext.agentId,
        guildId,
        currentChannelTarget,
        currentThreadId,
        parentChannelId,
        slug,
        displayName: project.displayName,
        description,
        destination,
        ownerUserId: executionContext.authorId,
      });
      boundChannelTarget = room.channelTarget;
      boundThreadId = room.threadId;
      createdChannel = room.createdChannel ?? null;
      createdThread = room.createdThread ?? null;
    }

    await input.projectBindings.bind({
      projectId: project.projectId,
      platform: 'discord',
      channelTarget: boundChannelTarget,
      threadId: boundThreadId,
      agentId: executionContext.agentId,
    });

    if (project.metadata?.['roomState'] === 'pending_rebind') {
      await input.projectRegistry.update(project.projectId, {
        metadata: {
          ...(project.metadata ?? {}),
          roomState: 'active',
          pendingRoomReason: null,
          pendingRoomAt: null,
          pendingRoomBindingId: null,
        },
      });
    }

    const worktreeRegistry = new ProjectWorktreeRegistry(join(input.runtimePaths.projectsDir, project.projectId, 'worktrees'), project.projectId);
    await worktreeRegistry.load();
    const projectRoot = resolveProjectRoot(input.runtimePaths, project);
    await worktreeRegistry.register({
      nodeId: input.getNodeIdentity().nodeId,
      root: projectRoot,
      label: 'owner-default',
      ownerPrincipalId: executionContext.principalId,
    });

    const statusPath = join(projectRoot, 'STATUS.md');
    const projectDocPath = join(projectRoot, 'PROJECT.md');
    const noticePath = join(projectRoot, 'NOTICE.md');
    const modeLabel = project.collaboration?.mode ?? 'single-user';
    const templateSectionsByType: Record<string, string[]> = {
      programming: [
        '## Engineering Focus',
        '- Repo / codebase',
        '- Milestone tasks',
        '- Bugs / blockers',
        '- Review and merge plan',
      ],
      design: [
        '## Design Focus',
        '- Product goals',
        '- User flows',
        '- Screens / assets',
        '- Review checkpoints',
      ],
      research: [
        '## Research Focus',
        '- Research question',
        '- Sources / papers',
        '- Findings',
        '- Open questions',
      ],
      general: [
        '## Project Focus',
        '- Goal',
        '- Workstreams',
        '- Risks',
        '- Next review',
      ],
    };
    const templateSection = templateSectionsByType[projectType] ?? templateSectionsByType.general;
    if (!existsSync(projectDocPath)) {
      const projectDoc = [
        `# ${project.displayName}`,
        '',
        `- Slug: \`${project.slug}\``,
        `- Type: \`${projectType}\``,
        `- Owner principal: \`${project.ownerPrincipalId}\``,
        `- Mode: \`${modeLabel}\``,
        project.description ? '' : null,
        project.description ? '## Description' : null,
        project.description ?? null,
        '',
        ...templateSection,
      ].filter(Boolean).join('\n');
      await writeFile(projectDocPath, `${projectDoc}\n`, 'utf-8');
    }
    if (!existsSync(statusPath)) {
      const statusDoc = [
        '# STATUS',
        '',
        `Project: ${project.displayName} (\`${project.slug}\`)`,
        `Type: ${projectType}`,
        `Mode: ${modeLabel}`,
        '',
        '## Current Goal',
        '- Define the immediate next milestone.',
        '',
        '## In Progress',
        '- Project room initialized.',
        '',
        '## Done',
        `- Project created by ${executionContext.principalName ?? executionContext.principalId}.`,
        '',
        '## Blockers',
        '- None recorded yet.',
        '',
        '## Next Actions',
        '- Add collaborators if needed.',
        '- Update this file as work progresses.',
        '',
        ...templateSection,
      ].join('\n');
      await writeFile(statusPath, `${statusDoc}\n`, 'utf-8');
    }
    if (!existsSync(noticePath)) {
      const noticeDoc = [
        '# Notice',
        '',
        `${project.displayName} was initialized as a private ${projectType} project room.`,
        `This room starts in \`${modeLabel}\` mode and becomes collaborative after another member is added.`,
        '',
        '## Workspace',
        `- Local workspace: \`${projectRoot}\``,
        '- Shared starter docs: `PROJECT.md`, `STATUS.md`',
      ].join('\n');
      await writeFile(noticePath, `${noticeDoc}\n`, 'utf-8');
    }

    const background = await buildProjectBackground(project.projectId, existing ? 'discord_tool_rebind' : 'discord_tool_bootstrap');
    const hubClient = input.getHubClient();
    if (hubClient) {
      await syncProjectToHub(hubClient, input.getNodeIdentity(), project, input.projectMemberships).catch(() => {});
      await syncProjectMembershipsToHub(hubClient, input.getNodeIdentity(), project.projectId, input.projectMemberships).catch(() => {});
    }

    if (createdThread || createdChannel) {
      await ctx.channel.send({
        target: createdThread?.id ?? createdChannel!.id,
        content: [
          `Project room initialized for **${project.displayName}**.`,
          `Type: \`${projectType}\``,
          `Mode: \`${modeLabel}\``,
          `Workspace: \`${projectRoot}\``,
          'Starter docs created: \`PROJECT.md\`, \`STATUS.md\`, \`NOTICE.md\`',
          '',
          'This room is private to the owner until another member is added.',
          '',
          'Intro:',
          project.description || description,
          '',
          background?.summary ?? '',
        ].join('\n\n'),
      }).catch(() => {});
    }

    if (ctx.sessionId) {
      const sourceSession = input.sessions.get(ctx.sessionId);
      if (sourceSession) {
        sourceSession.metadata.recentProjectId = project.projectId;
        sourceSession.metadata.recentProjectSlug = project.slug;
        sourceSession.metadata.recentProjectRoomChannelId = createdChannel?.id ?? boundChannelTarget;
        sourceSession.metadata.recentProjectRoomThreadId = createdThread?.id ?? boundThreadId;
      }
    }

    return {
      output: [
        existing ? `Bound existing project ${project.displayName} (${project.slug}).` : `Created project ${project.displayName} (${project.slug}).`,
        createdChannel ? `Opened private channel: ${createdChannel.id}` : null,
        createdThread ? `Opened thread: ${createdThread.id}` : null,
        !createdChannel && !createdThread ? (boundThreadId ? `Bound current thread: ${boundThreadId}` : 'Bound current channel.') : null,
        `Type: ${projectType}`,
        `Workspace: ${projectRoot}`,
        'Starter docs: PROJECT.md, STATUS.md, NOTICE.md',
        background ? `Background: ${background.summary.split('\n')[0]}` : null,
      ].filter(Boolean).join('\n'),
      success: true,
      data: {
        projectId: project.projectId,
        projectSlug: project.slug,
        channelId: createdChannel?.id ?? boundChannelTarget,
        threadId: createdThread?.id ?? boundThreadId,
      },
    };
  };

  return {
    resolveProject,
    buildProjectBackground,
    activateCollaborativeProject,
    autoEnrollProjectRoomParticipant,
    sweepProjectRoomSignal,
    normalizeDiscordPolicyIdentity,
    buildAgentAccessMetadata,
    isDiscordInvocationAllowed,
    manageDiscordProjectMemberFromTool,
    syncDiscordProjectFromTool,
    closeDiscordProjectFromTool,
    manageDiscordRoomAccessFromTool,
    inspectDiscordRoomFromTool,
    manageProjectNetworkFromTool,
    bootstrapDiscordProjectFromTool,
    notifyPatchApprovalReview,
    formatSharedSessionJoinNotice,
  };
}
