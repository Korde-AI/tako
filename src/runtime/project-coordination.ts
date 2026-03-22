import { createDiscordProjectSupport } from '../channels/discord-project-support.js';
import type { ProjectBindingRegistry } from '../projects/bindings.js';
import type { ProjectRegistry } from '../projects/registry.js';
import type { SessionManager } from '../gateway/session.js';
import type { PrincipalRegistry } from '../principals/registry.js';
import type { ProjectChannelCoordinatorRegistry } from '../projects/channel-coordination.js';
import { createProjectRoomLifecycle } from '../projects/room-lifecycle.js';
import { createProjectRoomNotifier } from '../projects/room-notifier.js';
import type { ToolContext } from '../tools/tool.js';
import type { ProjectBackgroundSnapshot } from '../projects/types.js';

interface ProjectCoordinationRuntimeInput {
  projectBindings: ProjectBindingRegistry;
  projectRegistry: ProjectRegistry;
  sessions: SessionManager;
  principalRegistry: PrincipalRegistry;
  projectChannelCoordinators: ProjectChannelCoordinatorRegistry;
  buildProjectBackground: (projectId: string, reason: string) => Promise<ProjectBackgroundSnapshot | null>;
  autoEnrollProjectRoomParticipant: Parameters<typeof createProjectRoomLifecycle>[0]['autoEnrollProjectRoomParticipant'];
  normalizeDiscordPolicyIdentity: (value?: string | null) => string | null;
}

export interface ProjectCoordinationRuntime {
  projectRoomLifecycle: ReturnType<typeof createProjectRoomLifecycle>;
  projectRoomNotifier: ReturnType<typeof createProjectRoomNotifier>;
  inspectCurrentDiscordProjectRoom(ctx: ToolContext): Promise<import('../projects/channel-coordination.js').ProjectRoomInspection | null>;
  discordProjectSupport: {
    resolvePrincipalIdentity(identity: string): {
      principalId: string;
      displayName: string;
      userId?: string;
      username?: string;
    } | null;
    resolvePrincipalIdentityFromRoom(
      identity: string,
      ctx: ToolContext,
    ): Promise<{
      principalId: string;
      displayName: string;
      userId?: string;
      username?: string;
    } | null>;
  };
}

export function createProjectCoordinationRuntime(input: ProjectCoordinationRuntimeInput): ProjectCoordinationRuntime {
  const projectRoomLifecycle = createProjectRoomLifecycle({
    projectBindings: input.projectBindings,
    projectRegistry: input.projectRegistry,
    sessions: input.sessions,
    buildProjectBackground: async (projectId, reason) => input.buildProjectBackground(projectId, reason),
    resolveParticipantPrincipals: async (event) => {
      const participants = [];
      for (const participantId of event.participantIds) {
        const principal = input.principalRegistry.findByPlatform(event.platform, participantId);
        if (!principal) continue;
        participants.push({
          principalId: principal.principalId,
          principalName: principal.displayName,
          platformUserId: participantId,
          platform: event.platform,
        });
      }
      return participants;
    },
    autoEnrollProjectRoomParticipant: input.autoEnrollProjectRoomParticipant,
  });

  const projectRoomNotifier = createProjectRoomNotifier({
    projectBindings: input.projectBindings,
    projectChannelCoordinators: input.projectChannelCoordinators,
  });

  const inspectCurrentDiscordProjectRoom = async (ctx: ToolContext) => {
    const executionContext = ctx.executionContext;
    if (ctx.channelType !== 'discord' || !executionContext?.agentId) return null;
    const metadata = executionContext.metadata ?? {};
    const channelId = typeof metadata['parentChannelId'] === 'string'
      ? metadata['parentChannelId']
      : executionContext.channelTarget;
    if (!channelId) return null;
    const coordinator = input.projectChannelCoordinators.get('discord');
    if (!coordinator) return null;
    return coordinator.inspectRoom({
      agentId: executionContext.agentId,
      channelId,
    }).catch(() => null);
  };

  const discordProjectSupport = createDiscordProjectSupport({
    principalRegistry: input.principalRegistry,
    normalizeIdentity: input.normalizeDiscordPolicyIdentity,
    inspectCurrentRoom: inspectCurrentDiscordProjectRoom,
  });

  return {
    projectRoomLifecycle,
    projectRoomNotifier,
    inspectCurrentDiscordProjectRoom,
    discordProjectSupport,
  };
}
