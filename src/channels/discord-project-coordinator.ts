import type { DiscordChannel } from './discord.js';
import type { ProjectBinding } from '../projects/types.js';
import type {
  ProjectChannelCoordinator,
  ProjectRoomBootstrapRequest,
  ProjectRoomBootstrapResult,
  ProjectRoomInspection,
} from '../projects/channel-coordination.js';

interface DiscordProjectCoordinatorDeps {
  channels: DiscordChannel[];
  fallback?: DiscordChannel | null;
}

export function createDiscordProjectCoordinator(
  deps: DiscordProjectCoordinatorDeps,
): ProjectChannelCoordinator {
  const resolveChannel = (agentId?: string): DiscordChannel | undefined => {
    if (agentId) {
      const exact = deps.channels.find((channel) => channel.agentId === agentId);
      if (exact) return exact;
    }
    return deps.fallback ?? deps.channels[0];
  };

  return {
    platform: 'discord',

    async notifyBindings(bindings: ProjectBinding[], content: string): Promise<void> {
      for (const binding of bindings) {
        const target = binding.threadId ?? binding.channelTarget;
        const channel = resolveChannel(binding.agentId);
        if (!channel) continue;
        await channel.send({
          target,
          content,
        }).catch(() => {});
      }
    },

    async inspectRoom(input: { agentId?: string; channelId: string }): Promise<ProjectRoomInspection> {
      const channel = resolveChannel(input.agentId);
      if (!channel) throw new Error('Discord channel adapter not available.');
      const inspection = await channel.inspectRoom(input.channelId);
      return {
        ...inspection,
        members: inspection.members.map((member) => ({
          ...member,
          mention: `<@${member.userId}>`,
        })),
      };
    },

    async grantRoomAccess(input: { agentId?: string; channelId: string; userId: string }): Promise<void> {
      const channel = resolveChannel(input.agentId);
      if (!channel) throw new Error('Discord channel adapter not available.');
      await channel.grantChannelAccess(input.channelId, input.userId);
    },

    async bootstrapProjectRoom(input: ProjectRoomBootstrapRequest): Promise<ProjectRoomBootstrapResult> {
      const channel = resolveChannel(input.agentId);
      if (!channel) throw new Error('Discord channel adapter not available.');

      let channelTarget = input.currentChannelTarget;
      let threadId = input.currentThreadId;
      let createdChannel: { id: string; name: string } | null = null;
      let createdThread: { id: string; name: string } | null = null;

      if (input.destination === 'channel') {
        createdChannel = await channel.createChannel(input.guildId, input.slug, {
          topic: input.description.slice(0, 1024),
          privateUserId: input.ownerUserId,
        });
        channelTarget = createdChannel.id;
        threadId = undefined;
      } else if (input.destination === 'thread' && !input.currentThreadId) {
        createdThread = await channel.createThread(
          input.parentChannelId ?? input.currentChannelTarget,
          input.displayName.slice(0, 90),
        );
        channelTarget = input.parentChannelId ?? input.currentChannelTarget;
        threadId = createdThread.id;
      } else if (input.parentChannelId && input.currentThreadId) {
        channelTarget = input.parentChannelId;
        threadId = input.currentThreadId;
      }

      return {
        channelTarget,
        threadId,
        createdChannel,
        createdThread,
      };
    },
  };
}
