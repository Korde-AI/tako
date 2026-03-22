import type { ButtonHandler } from '../channels/discord.js';
import type { PrincipalRegistry } from '../principals/registry.js';
import type { ChannelDeliveryRegistry } from '../core/channel-delivery.js';
import { createApprovalActionResolver } from '../core/approval-actions.js';
import { ProjectApprovalRegistry } from '../projects/approvals.js';
import { projectApprovalsRoot } from '../projects/root.js';
import type { PeerTaskApprovalRegistry } from '../core/peer-approvals.js';
import type { TakoPaths } from '../core/paths.js';
import type { createPeerTaskRuntimeHandlers } from '../core/runners/peer-approval-runner.js';
import type { AuditLogger } from '../core/audit.js';

interface ApprovalRuntimeInput {
  peerTaskApprovals: PeerTaskApprovalRegistry;
  runtimePaths: TakoPaths;
  notifyProjectRooms: (projectId: string, content: string) => Promise<void>;
  resumePeerTaskApproval: ReturnType<typeof createPeerTaskRuntimeHandlers>['resumePeerTaskApproval'];
  audit: AuditLogger;
  principalRegistry: PrincipalRegistry;
  channelDeliveryRegistry: ChannelDeliveryRegistry;
}

export function createApprovalRuntime(input: ApprovalRuntimeInput) {
  const approvalActionResolver = createApprovalActionResolver({
    peerTaskApprovals: input.peerTaskApprovals,
    createProjectApprovalRegistry: (projectId) =>
      new ProjectApprovalRegistry(projectApprovalsRoot(input.runtimePaths, projectId), projectId),
    notifyProjectRooms: input.notifyProjectRooms,
    resumePeerTaskApproval: input.resumePeerTaskApproval,
    audit: input.audit,
  });

  const approvalButtonHandler: ButtonHandler = async (interaction) => {
    const deliveryAdapter = input.channelDeliveryRegistry.get('discord');
    const approvalAction = deliveryAdapter?.parseApprovalAction?.(interaction.customId) ?? null;
    if (!approvalAction) return false;
    const principal = await input.principalRegistry.getOrCreateHuman({
      displayName: interaction.user.displayName || interaction.user.username,
      platform: 'discord',
      platformUserId: interaction.user.id,
    });
    const result = await approvalActionResolver.resolve(approvalAction, {
      displayName: principal.displayName,
      principalId: principal.principalId,
      userId: interaction.user.id,
    }, interaction.message.content);
    if (!result.handled) return false;
    if ('reply' in result) {
      await interaction.reply({ content: result.reply, flags: 64 }).catch(() => {});
      return true;
    }
    await interaction.update({
      content: result.updateMessage,
      components: [],
    }).catch(async () => {
      await interaction.reply({ content: result.fallbackReply, flags: 64 }).catch(() => {});
    });
    return true;
  };

  return {
    approvalActionResolver,
    approvalButtonHandler,
  };
}
