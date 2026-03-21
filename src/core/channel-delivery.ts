import type { ProjectBinding } from '../projects/types.js';

export interface PatchApprovalNotice {
  projectId: string;
  projectSlug?: string;
  approvalId: string;
  artifactName: string;
  requestedByNodeId?: string;
  requestedByPrincipalId?: string;
  sourceBranch?: string;
  targetBranch?: string;
  conflictSummary?: string;
}

export interface PeerTaskApprovalNotice {
  channelId: string;
  approvalId: string;
  agentId: string;
  requesterName?: string;
  requesterIsBot?: boolean;
  toolName: string;
  toolArgsPreview?: string;
  ownerMentions?: string[];
  projectSlug?: string;
}

export type ChannelApprovalAction =
  | {
      handled: true;
      kind: 'patch';
      decision: 'approved' | 'denied';
      projectId: string;
      approvalId: string;
    }
  | {
      handled: true;
      kind: 'peer';
      decision: 'approved' | 'denied';
      approvalId: string;
    }
  | {
      handled: true;
      kind: 'malformed';
      message: string;
    };

export interface ChannelDeliveryAdapter {
  readonly platform: ProjectBinding['platform'];
  sendPatchApproval(bindings: ProjectBinding[], input: PatchApprovalNotice): Promise<void>;
  sendPeerTaskApproval(input: PeerTaskApprovalNotice & { agentIdHint?: string }): Promise<void>;
  parseApprovalAction?(customId: string): ChannelApprovalAction | null;
}

export class ChannelDeliveryRegistry {
  private adapters = new Map<ProjectBinding['platform'], ChannelDeliveryAdapter>();

  register(adapter: ChannelDeliveryAdapter): void {
    this.adapters.set(adapter.platform, adapter);
  }

  get(platform: ProjectBinding['platform']): ChannelDeliveryAdapter | undefined {
    return this.adapters.get(platform);
  }
}
