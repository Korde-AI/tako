import type { SessionManager } from '../gateway/session.js';
import type { ProjectBindingRegistry } from './bindings.js';
import type { ProjectRegistry } from './registry.js';
import type { Project } from './types.js';
import type { ChannelPlatform } from '../channels/platforms.js';

export interface RoomClosedInput {
  platform: ChannelPlatform;
  channelId: string;
  kind: 'channel' | 'thread';
  reason: 'deleted' | 'archived';
  agentId?: string;
}

export interface RoomParticipantInput {
  platform: ChannelPlatform;
  agentId?: string;
  channelId: string;
  threadId?: string;
  kind: 'channel' | 'thread';
  participantIds: string[];
  reason: string;
  metadata?: Record<string, unknown>;
}

export interface ResolvedRoomParticipant {
  principalId: string;
  principalName?: string;
  platformUserId?: string;
  platform: ChannelPlatform;
}

export interface ProjectRoomLifecycleDeps {
  projectBindings: ProjectBindingRegistry;
  projectRegistry: ProjectRegistry;
  sessions: SessionManager;
  buildProjectBackground: (projectId: string, reason: string) => Promise<unknown>;
  resolveParticipantPrincipals: (input: RoomParticipantInput) => Promise<ResolvedRoomParticipant[]>;
  autoEnrollProjectRoomParticipant: (input: {
    project: Project;
    principalId: string;
    principalName?: string;
    platformUserId?: string;
    platform: ChannelPlatform;
    addedBy: string;
  }) => Promise<boolean>;
}

export function createProjectRoomLifecycle(deps: ProjectRoomLifecycleDeps) {
  const handleClosedRoom = async (input: RoomClosedInput): Promise<void> => {
    const deactivated = await deps.projectBindings.deactivateMatching({
      platform: input.platform,
      channelTarget: input.kind === 'channel' ? input.channelId : undefined,
      threadId: input.kind === 'thread' ? input.channelId : undefined,
      agentId: input.agentId,
      reason: `${input.platform}_${input.kind}_${input.reason}`,
    });
    if (deactivated.length === 0) return;

    for (const binding of deactivated) {
      const project = deps.projectRegistry.get(binding.projectId);
      if (project) {
        await deps.projectRegistry.update(project.projectId, {
          metadata: {
            ...(project.metadata ?? {}),
            roomState: 'pending_rebind',
            pendingRoomReason: `${input.platform}_${input.kind}_${input.reason}`,
            pendingRoomAt: new Date().toISOString(),
            pendingRoomBindingId: binding.bindingId,
          },
        });
      }

      for (const session of deps.sessions.list()) {
        const samePlatform = session.metadata?.channelType === input.platform;
        const sameChannel = session.metadata?.channelTarget === binding.channelTarget;
        const sameThread = binding.threadId
          ? session.metadata?.threadId === binding.threadId || session.metadata?.channelTarget === binding.threadId
          : true;
        const sameProject = session.metadata?.projectId === binding.projectId;
        if (samePlatform && sameChannel && sameThread && sameProject) {
          deps.sessions.archiveSession(session.id);
        }
      }

      await deps.buildProjectBackground(binding.projectId, `room_closed:${input.platform}_${input.kind}_${input.reason}`);
    }
  };

  const handleRoomParticipant = async (input: RoomParticipantInput): Promise<void> => {
    const parentChannelId = typeof input.metadata?.['parentChannelId'] === 'string'
      ? input.metadata['parentChannelId']
      : undefined;
    const binding = deps.projectBindings.resolve({
      platform: input.platform,
      channelTarget: input.kind === 'channel' ? input.channelId : parentChannelId,
      threadId: input.threadId ?? (input.kind === 'thread' ? input.channelId : undefined),
      agentId: input.agentId,
    }) ?? deps.projectBindings.resolve({
      platform: input.platform,
      channelTarget: input.kind === 'channel' ? input.channelId : parentChannelId,
      agentId: input.agentId,
    });
    if (!binding) return;
    const project = deps.projectRegistry.get(binding.projectId);
    if (!project || project.status === 'closed') return;

    for (const participant of await deps.resolveParticipantPrincipals(input)) {
      await deps.autoEnrollProjectRoomParticipant({
        project,
        principalId: participant.principalId,
        principalName: participant.principalName,
        platformUserId: participant.platformUserId,
        platform: participant.platform,
        addedBy: project.ownerPrincipalId,
      });
    }
  };

  return {
    handleClosedRoom,
    handleRoomParticipant,
  };
}
