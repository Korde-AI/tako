import type { DiscordChannel } from './discord.js';
import type { ChannelApprovalAction, ChannelDeliveryAdapter, PatchApprovalNotice, PeerTaskApprovalNotice } from '../core/channel-delivery.js';
import type { ProjectBinding } from '../projects/types.js';

interface DiscordDeliveryAdapterDeps {
  channels: DiscordChannel[];
  fallback?: DiscordChannel | null;
}

export function createDiscordDeliveryAdapter(
  deps: DiscordDeliveryAdapterDeps,
): ChannelDeliveryAdapter {
  const resolveChannel = (agentId?: string): DiscordChannel | undefined => {
    if (agentId) {
      const exact = deps.channels.find((channel) => channel.agentId === agentId);
      if (exact) return exact;
    }
    return deps.fallback ?? deps.channels[0];
  };

  return {
    platform: 'discord',

    parseApprovalAction(customId: string): ChannelApprovalAction | null {
      if (customId.startsWith('patchapprove:') || customId.startsWith('patchdeny:')) {
        const [action, projectId, approvalId] = customId.split(':');
        if (!projectId || !approvalId) {
          return { handled: true, kind: 'malformed', message: 'Malformed patch approval action.' };
        }
        return {
          handled: true,
          kind: 'patch',
          decision: action === 'patchapprove' ? 'approved' : 'denied',
          projectId,
          approvalId,
        };
      }
      if (customId.startsWith('peerapprove:') || customId.startsWith('peerdeny:')) {
        const [action, approvalId] = customId.split(':');
        if (!approvalId) {
          return { handled: true, kind: 'malformed', message: 'Malformed peer approval action.' };
        }
        return {
          handled: true,
          kind: 'peer',
          decision: action === 'peerapprove' ? 'approved' : 'denied',
          approvalId,
        };
      }
      return null;
    },

    async sendPatchApproval(bindings: ProjectBinding[], input: PatchApprovalNotice): Promise<void> {
      for (const binding of bindings) {
        const channel = resolveChannel(binding.agentId);
        if (!channel) continue;
        const target = binding.threadId ?? binding.channelTarget;
        await channel.sendPatchApprovalRequest({
          channelId: target,
          projectId: input.projectId,
          projectSlug: input.projectSlug,
          approvalId: input.approvalId,
          artifactName: input.artifactName,
          requestedByNodeId: input.requestedByNodeId,
          requestedByPrincipalId: input.requestedByPrincipalId,
          sourceBranch: input.sourceBranch,
          targetBranch: input.targetBranch,
          conflictSummary: input.conflictSummary,
        }).catch(() => {});
      }
    },

    async sendPeerTaskApproval(input: PeerTaskApprovalNotice & { agentIdHint?: string }): Promise<void> {
      const channel = resolveChannel(input.agentIdHint);
      if (!channel) return;
      await channel.sendPeerTaskApprovalRequest({
        channelId: input.channelId,
        approvalId: input.approvalId,
        agentId: input.agentId,
        requesterName: input.requesterName,
        requesterIsBot: input.requesterIsBot,
        toolName: input.toolName,
        toolArgsPreview: input.toolArgsPreview,
        ownerMentions: input.ownerMentions,
        projectSlug: input.projectSlug,
      }).catch(() => {});
    },
  };
}
