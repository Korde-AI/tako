import type {
  AnyThreadChannel,
  ButtonInteraction,
  ChatInputCommandInteraction,
  ModalSubmitInteraction,
  StringSelectMenuInteraction,
} from 'discord.js';
import type { MessageHandler } from './channel.js';

export const MAX_DISCORD_MESSAGE_LENGTH = 2000;

export function maskName(name: string): string {
  if (name.length <= 5) return name[0] + '***' + name[name.length - 1];
  return name.slice(0, 2) + '***' + name.slice(-3);
}

export function normalizeDiscordChannelId(channelId: string): string {
  return channelId.startsWith('discord:') ? channelId.slice('discord:'.length) : channelId;
}

export function isThreadLike(channel: unknown): channel is AnyThreadChannel {
  return !!channel
    && typeof channel === 'object'
    && 'isThread' in channel
    && typeof (channel as { isThread: () => boolean }).isThread === 'function'
    && (channel as { isThread: () => boolean }).isThread();
}

export type SlashCommandHandler = (
  commandName: string,
  channelId: string,
  author: { id: string; name: string; meta?: Record<string, unknown> },
  guildId?: string,
) => Promise<string | null>;

export type InteractiveCommandHandler = (
  interaction: ChatInputCommandInteraction,
) => Promise<boolean>;

export type ModalSubmitHandler = (interaction: ModalSubmitInteraction) => Promise<boolean>;
export type SelectMenuHandler = (interaction: StringSelectMenuInteraction) => Promise<boolean>;
export type ButtonHandler = (interaction: ButtonInteraction) => Promise<boolean>;
export type RoomClosedHandler = (input: {
  channelId: string;
  guildId?: string;
  kind: 'channel' | 'thread';
  reason: 'deleted' | 'archived';
}) => Promise<void>;
export type RoomParticipantHandler = (input: {
  channelId: string;
  guildId?: string;
  parentChannelId?: string;
  kind: 'channel' | 'thread';
  userIds: string[];
  reason: 'channel_access_granted' | 'thread_member_added';
}) => Promise<void>;

export interface DiscordRoomInspection {
  guildId?: string;
  guildName?: string;
  channelId: string;
  channelName?: string;
  kind: 'channel' | 'thread' | 'dm';
  private: boolean;
  members: Array<{
    userId: string;
    username?: string;
    displayName?: string;
    source: 'thread_member' | 'permission_overwrite';
  }>;
  notes: string[];
}

export interface DiscordRecentMessage {
  id: string;
  authorId: string;
  authorName?: string;
  username?: string;
  isBot: boolean;
  content: string;
  timestamp: string;
}

export interface DiscordChannelOpts {
  token: string;
  guilds?: string[];
  allowUnmentionedChannels?: string[];
}

export interface DiscordMessageHandlerState {
  handlers: MessageHandler[];
  roomClosedHandlers: RoomClosedHandler[];
  roomParticipantHandlers: RoomParticipantHandler[];
}

export interface DiscordInteractionState {
  slashCommandHandler: SlashCommandHandler | null;
  interactiveHandlers: Map<string, InteractiveCommandHandler>;
  modalHandlers: ModalSubmitHandler[];
  selectMenuHandlers: SelectMenuHandler[];
  buttonHandlers: ButtonHandler[];
  nativeCommands: Array<{ name: string; description: string }>;
  previousSkillNames?: Set<string>;
}
