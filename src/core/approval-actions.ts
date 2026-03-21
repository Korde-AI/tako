import type { AuditLogger } from './audit.js';
import type { ChannelApprovalAction } from './channel-delivery.js';
import type { PeerTaskApproval, PeerTaskApprovalRegistry } from './peer-approvals.js';
import { ProjectApprovalRegistry } from '../projects/approvals.js';

export interface ApprovalActionActor {
  displayName: string;
  principalId: string;
  userId: string;
}

export type ApprovalActionResolution =
  | {
      handled: false;
    }
  | {
      handled: true;
      reply: string;
    }
  | {
      handled: true;
      updateMessage: string;
      fallbackReply: string;
    };

interface ApprovalActionResolverDeps {
  peerTaskApprovals: PeerTaskApprovalRegistry;
  createProjectApprovalRegistry: (projectId: string) => ProjectApprovalRegistry;
  notifyProjectRooms: (projectId: string, content: string) => Promise<void>;
  resumePeerTaskApproval: (approval: PeerTaskApproval) => Promise<void>;
  audit: AuditLogger;
}

export function createApprovalActionResolver(deps: ApprovalActionResolverDeps) {
  const resolve = async (
    action: ChannelApprovalAction | null,
    actor: ApprovalActionActor,
    originalMessageContent: string,
  ): Promise<ApprovalActionResolution> => {
    if (!action) return { handled: false };
    if (action.kind === 'malformed') {
      return { handled: true, reply: action.message };
    }

    if (action.kind === 'patch') {
      const approvals = deps.createProjectApprovalRegistry(action.projectId);
      await approvals.load();
      const existing = approvals.get(action.approvalId);
      if (!existing) {
        return { handled: true, reply: `Approval not found: ${action.approvalId}` };
      }
      const resolved = await approvals.resolve(
        action.approvalId,
        action.decision,
        actor.principalId,
        `Resolved in channel by ${actor.displayName}`,
      );
      await deps.notifyProjectRooms(
        action.projectId,
        `[patch ${resolved.status}] ${resolved.artifactName} (${resolved.approvalId}) by ${actor.displayName}`,
      );
      return {
        handled: true,
        updateMessage: `${originalMessageContent}\n\nResolved: **${resolved.status}** by ${actor.displayName}`,
        fallbackReply: `Resolved ${resolved.artifactName}: ${resolved.status}`,
      };
    }

    const existing = deps.peerTaskApprovals.get(action.approvalId);
    if (!existing) {
      return { handled: true, reply: `Approval not found: ${action.approvalId}` };
    }
    const ownerAllowed = existing.ownerUserIds.includes(actor.userId)
      || existing.ownerPrincipalIds.includes(actor.principalId);
    if (!ownerAllowed) {
      return { handled: true, reply: 'Only the owning human can approve this task.' };
    }
    if (existing.status !== 'pending') {
      return { handled: true, reply: `Approval ${action.approvalId} is already ${existing.status}.` };
    }
    const resolved = await deps.peerTaskApprovals.resolve(
      action.approvalId,
      action.decision,
      {
        reviewedByPrincipalId: actor.principalId,
        reviewedByUserId: actor.userId,
        decisionReason: `Resolved in channel by ${actor.displayName}`,
      },
    );
    deps.audit.log({
      agentId: resolved.agentId,
      sessionId: resolved.sessionId,
      principalId: resolved.requesterPrincipalId,
      principalName: resolved.requesterPrincipalName,
      projectId: resolved.projectId,
      projectSlug: resolved.projectSlug,
      event: 'agent_comms',
      action: resolved.status === 'approved' ? 'peer_task_approval_approved' : 'peer_task_approval_denied',
      details: {
        approvalId: resolved.approvalId,
        toolName: resolved.toolName,
        reviewedByPrincipalId: actor.principalId,
        reviewedByUserId: actor.userId,
      },
      success: resolved.status === 'approved',
    }).catch(() => {});
    if (resolved.status === 'approved') {
      await deps.resumePeerTaskApproval(resolved);
    }
    return {
      handled: true,
      updateMessage: `${originalMessageContent}\n\nResolved: **${resolved.status}** by ${actor.displayName}`,
      fallbackReply: `Resolved peer task ${resolved.approvalId}: ${resolved.status}`,
    };
  };

  return {
    resolve,
  };
}
