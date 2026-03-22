import { compareAuthorityRoles, isRoleWithinAuthorityCeiling, isValidAuthorityCeiling } from '../network/authority.js';
import {
  matchesNodeHint,
  normalizeNodeHint,
  renderProjectInviteRelay,
  selectLatestMatchingRelayInvite,
} from '../network/discord-relay.js';
import { InviteStore, type ProjectInvite } from '../network/invites.js';
import { TrustStore } from '../network/trust.js';
import { getProjectRole } from '../projects/access.js';
import { DiscordChannel } from '../channels/discord.js';
import type { ProjectNetworkManageRequest } from '../tools/projects.js';
import type { ToolContext, ToolResult } from '../tools/tool.js';
import type { ProjectRuntime, ProjectRuntimeShared } from './project-runtime-types.js';

export function createProjectNetworkRuntime(shared: ProjectRuntimeShared): Pick<ProjectRuntime, 'manageProjectNetworkFromTool'> {
  const { input } = shared;

  const isCurrentNodeHint = (hint: string, executionContext?: any): boolean => matchesNodeHint(hint, [
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
      const project = shared.resolveProjectForToolContext({
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
      const role = args.role ?? 'contribute';
      const ceiling = args.ceiling ?? role;
      const sharedDocs = await shared.collectInviteSharedDocsSnapshot(project);
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
        const relayPacket = renderProjectInviteRelay({ kind: 'tako_project_invite_v1', invite });
        await discordChannel.send({
          target: channelTarget,
          content: [`📨 Invite prepared for ${targetHint}.`, `Project: ${project.displayName} (${project.slug})`, `Role: ${role}`, '', relayPacket].join('\n'),
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
      const desiredCeiling = args.ceiling ?? invite.offeredRole;
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
      const localProject = await shared.ensureAcceptedProjectWorkspaceAtRuntime({ invite, executionContext });
      const session = ctx.sessionId ? input.sessions.get(ctx.sessionId) : undefined;
      if (session) {
        session.metadata.recentProjectId = invite.projectId;
        session.metadata.recentProjectSlug = invite.projectSlug;
        if (executionContext.channelTarget) {
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

  return { manageProjectNetworkFromTool };
}
