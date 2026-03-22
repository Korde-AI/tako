import type { Attachment, Channel } from './channel.js';
import type { DiscordChannel } from './discord.js';
import type { TelegramChannel } from './telegram.js';

export type MessageSurfacePlatform = 'discord' | 'telegram';

export interface MessageSurfaceSendInput {
  target: string;
  content: string;
  attachments?: Attachment[];
}

export interface MessageSurfaceCreateChannelInput {
  guildId: string;
  name: string;
  topic?: string;
  parentId?: string;
  privateUserId?: string;
}

export interface MessageSurfaceEditChannelInput {
  channelId: string;
  name?: string;
  topic?: string;
}

export interface MessageSurfaceCreateThreadInput {
  channelId: string;
  name: string;
  messageId?: string;
}

export interface MessageSurfaceReactionInput {
  channelId: string;
  messageId: string;
  emoji: string;
}

export interface MessageSurface {
  platform: MessageSurfacePlatform;
  send(input: MessageSurfaceSendInput): Promise<{ messageId?: string }>;
  createChannel?(input: MessageSurfaceCreateChannelInput): Promise<{ id: string; name: string }>;
  editChannel?(input: MessageSurfaceEditChannelInput): Promise<void>;
  deleteChannel?(channelId: string): Promise<void>;
  createThread?(input: MessageSurfaceCreateThreadInput): Promise<{ id: string; name: string }>;
  react?(input: MessageSurfaceReactionInput): Promise<void>;
}

interface MessageSurfaceResolverDeps {
  channels: Channel[];
  discordChannels: DiscordChannel[];
  discordFallback?: DiscordChannel;
  telegramFallback?: TelegramChannel;
}

function resolveTelegramChannel(deps: MessageSurfaceResolverDeps, agentId?: string): TelegramChannel | undefined {
  const agentChannel = deps.channels.find(
    (channel) => channel.id === 'telegram' && (channel as { agentId?: string }).agentId === agentId,
  ) as TelegramChannel | undefined;
  return agentChannel ?? deps.telegramFallback;
}

function resolveDiscordChannel(deps: MessageSurfaceResolverDeps, agentId?: string): DiscordChannel | undefined {
  if (agentId) {
    const agentChannel = deps.discordChannels.find((channel) => channel.agentId === agentId);
    if (agentChannel) return agentChannel;
  }
  return deps.discordFallback;
}

function createDiscordMessageSurface(channel: DiscordChannel): MessageSurface {
  return {
    platform: 'discord',
    async send(input) {
      if (input.attachments && input.attachments.length > 0) {
        const messageId = await channel.sendAndGetId?.({
          target: input.target,
          content: input.content,
          attachments: input.attachments,
        });
        return { messageId };
      }
      const messageId = await channel.sendToChannel?.(input.target, input.content);
      return { messageId: typeof messageId === 'string' ? messageId : undefined };
    },
    async createChannel(input) {
      const created = await channel.createChannel(input.guildId, input.name, {
        topic: input.topic,
        parentId: input.parentId,
        privateUserId: input.privateUserId,
      });
      return { id: created.id, name: created.name };
    },
    async editChannel(input) {
      await channel.editChannel(input.channelId, {
        name: input.name,
        topic: input.topic,
      });
    },
    async deleteChannel(channelId) {
      await channel.deleteChannel(channelId);
    },
    async createThread(input) {
      const created = await channel.createThread(input.channelId, input.name, {
        messageId: input.messageId,
      });
      return { id: created.id, name: created.name };
    },
    async react(input) {
      await channel.react(input.channelId, input.messageId, input.emoji);
    },
  };
}

function createTelegramMessageSurface(channel: TelegramChannel): MessageSurface {
  return {
    platform: 'telegram',
    async send(input) {
      if (input.attachments && input.attachments.length > 0) {
        throw new Error('media attachments are currently supported for Discord only');
      }
      const messageId = await channel.sendToChat(input.target, input.content);
      return { messageId };
    },
  };
}

export function createMessageSurfaceResolver(deps: MessageSurfaceResolverDeps) {
  const resolveMessageSurface = (
    platform: MessageSurfacePlatform,
    agentId?: string,
  ): MessageSurface | undefined => {
    if (platform === 'discord') {
      const channel = resolveDiscordChannel(deps, agentId);
      return channel ? createDiscordMessageSurface(channel) : undefined;
    }
    const channel = resolveTelegramChannel(deps, agentId);
    return channel ? createTelegramMessageSurface(channel) : undefined;
  };

  return {
    resolveMessageSurface,
  };
}
