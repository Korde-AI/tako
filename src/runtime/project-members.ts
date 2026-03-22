import { getProjectRole, isProjectMember } from '../projects/access.js';
import type { ProjectRole } from '../projects/types.js';
import type { DiscordRoomAccessRequest, DiscordRoomInspectRequest } from '../tools/discord-room.js';
import type { ProjectMemberManageRequest } from '../tools/projects.js';
import type { ToolContext, ToolResult } from '../tools/tool.js';
import type { ProjectRuntime, ProjectRuntimeShared } from './project-runtime-types.js';
import { syncProjectMembershipsToHub } from '../network/sync.js';

function formatProjectWelcomeNotice(args: {
  mention?: string;
  displayName: string;
  projectName: string;
  projectSlug: string;
  collaborative: boolean;
  summaryLine: string;
}): string {
  return [
    '🎉 **New Collaborator Joined**',
    `${args.mention ?? args.displayName} is now part of **${args.projectName}** \`(${args.projectSlug})\`.`,
    args.collaborative ? '🤝 Collaboration mode is now active.' : null,
    `🧭 Sync: ${args.summaryLine}`,
    '📘 Read `PROJECT.md` and `STATUS.md`, then share your current goal, progress, or blockers here.',
  ].filter(Boolean).join('\n');
}

export function createProjectMembersRuntime(shared: ProjectRuntimeShared): Pick<ProjectRuntime,
  | 'autoEnrollProjectRoomParticipant'
  | 'normalizeDiscordPolicyIdentity'
  | 'buildAgentAccessMetadata'
  | 'isDiscordInvocationAllowed'
  | 'manageDiscordProjectMemberFromTool'
  | 'manageDiscordRoomAccessFromTool'
  | 'inspectDiscordRoomFromTool'
> {
  const { input } = shared;

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

  const buildAgentAccessMetadata = async (args: {
    platform: string;
    agentId: string;
    authorId: string;
    principalId?: string;
    project?: any;
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
    project?: any;
  }): Promise<{ allowed: boolean; reason: string }> => {
    const policy = input.config.channels.discord?.authPolicy;
    if (!policy?.enabled) return { allowed: true, reason: 'policy_disabled' };

    if (args.project) {
      if (args.principalId && isProjectMember(input.projectMemberships, args.project.projectId, args.principalId)) {
        return { allowed: true, reason: 'project_member' };
      }
      return { allowed: true, reason: 'project_room_presence' };
    }

    const generalChannels = (policy.generalChannels ?? ['general']).map((name) => name.trim().toLowerCase()).filter(Boolean);
    const channelName = (args.parentChannelName ?? args.channelName ?? '').trim().toLowerCase();
    const isGeneral = channelName.length > 0 && generalChannels.includes(channelName);
    const { isUserAllowed } = await import('../auth/allow-from.js');
    if (isGeneral) {
      const ownerAllowed = await isUserAllowed('discord', args.agentId, args.authorId, args.principalId);
      if (ownerAllowed) return { allowed: true, reason: 'general_owner' };
      return {
        allowed: matchesDiscordPolicyUser(policy.extraGeneralUsers, args),
        reason: 'general_extra_user',
      };
    }

    const ownerAllowed = await isUserAllowed('discord', args.agentId, args.authorId, args.principalId);
    if (ownerAllowed) {
      return { allowed: true, reason: 'unbound_owner' };
    }

    return { allowed: true, reason: 'unbound_shared_readonly' };
  };

  const autoEnrollProjectRoomParticipant: ProjectRuntime['autoEnrollProjectRoomParticipant'] = async (args) => {
    if (args.platform !== 'discord') return false;
    if (isProjectMember(input.projectMemberships, args.project.projectId, args.principalId)) return false;
    if (args.principalId === args.project.ownerPrincipalId) return false;
    await input.projectMemberships.upsert({
      projectId: args.project.projectId,
      principalId: args.principalId,
      role: 'contribute',
      addedBy: args.addedBy,
    });
    const updatedProject = await shared.activateCollaborativeProject(args.project.projectId, `member_auto_join:${args.principalId}`);
    const background = await shared.buildProjectBackground(args.project.projectId, `member_auto_join:${args.principalId}`);
    const hubClient = input.getHubClient();
    if (hubClient) {
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

  const manageDiscordProjectMemberFromTool = async (
    args: ProjectMemberManageRequest,
    ctx: ToolContext,
  ): Promise<ToolResult> => {
    const executionContext = ctx.executionContext;
    if (!executionContext || !executionContext.principalId || !executionContext.authorId || !executionContext.agentId) {
      return { output: '', success: false, error: 'Missing principal or channel execution context.' };
    }
    const project = shared.resolveProjectForToolContext({
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
        output: [`Project ${project.displayName} (${project.slug}) members:`, ...(lines.length ? lines : ['- none'])].join('\n'),
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
      const updatedProject = await shared.reconcileProjectCollaborationMode(project.projectId, `member_removed:${resolved.principalId}`);
      const background = await shared.buildProjectBackground(project.projectId, `member_removed:${resolved.principalId}`);
      const hubClient = input.getHubClient();
      if (hubClient) {
        await syncProjectMembershipsToHub(hubClient, input.getNodeIdentity(), project.projectId, input.projectMemberships).catch(() => {});
      }
      await input.getProjectRoomNotifier().notify(project.projectId, `🧹 ${resolved.displayName} was removed from ${project.slug}.`);
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
    const updatedProject = await shared.reconcileProjectCollaborationMode(project.projectId, `member_added:${resolved.principalId}`);
    const background = await shared.buildProjectBackground(project.projectId, `member_added:${resolved.principalId}`);
    const hubClient = input.getHubClient();
    if (hubClient) {
      await syncProjectMembershipsToHub(hubClient, input.getNodeIdentity(), project.projectId, input.projectMemberships).catch(() => {});
    }
    await input.getProjectRoomNotifier().notify(project.projectId, `🎉 ${resolved.displayName} joined ${project.slug} as ${role}.`);
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
      : shared.resolveProjectForToolContext({ executionContext, sessionId: ctx.sessionId });
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
        project ? `Bound project: ${project.displayName} (${project.slug})` : 'Bound project: none',
        project ? `Project members:\n${membershipLines.join('\n') || '- none'}` : null,
      ].filter(Boolean).join('\n'),
      success: true,
      data: {
        inspection,
        projectId: project?.projectId,
        projectSlug: project?.slug,
      },
    };
  };

  return {
    autoEnrollProjectRoomParticipant,
    normalizeDiscordPolicyIdentity,
    buildAgentAccessMetadata,
    isDiscordInvocationAllowed,
    manageDiscordProjectMemberFromTool,
    manageDiscordRoomAccessFromTool,
    inspectDiscordRoomFromTool,
  };
}
