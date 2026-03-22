import {
  ChannelType,
  PermissionFlagsBits,
  type Client,
  type GuildChannelCreateOptions,
  type TextChannel,
} from 'discord.js';
import { normalizeDiscordChannelId } from './discord-types.js';

export async function createDiscordChannel(
  client: Client | null,
  guildId: string,
  name: string,
  opts?: { topic?: string; parentId?: string; privateUserId?: string },
): Promise<{ id: string; name: string }> {
  if (!client) throw new Error('[discord] Not connected');
  const guild = await client.guilds.fetch(guildId);
  const createOpts: GuildChannelCreateOptions = {
    name,
    type: ChannelType.GuildText,
    ...(opts?.topic ? { topic: opts.topic } : {}),
    ...(opts?.parentId ? { parent: opts.parentId } : {}),
    ...(opts?.privateUserId
      ? {
          permissionOverwrites: [
            { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
            {
              id: opts.privateUserId,
              allow: [
                PermissionFlagsBits.ViewChannel,
                PermissionFlagsBits.SendMessages,
                PermissionFlagsBits.ReadMessageHistory,
              ],
            },
            ...(guild.members.me
              ? [{
                  id: guild.members.me.id,
                  allow: [
                    PermissionFlagsBits.ViewChannel,
                    PermissionFlagsBits.SendMessages,
                    PermissionFlagsBits.ReadMessageHistory,
                    PermissionFlagsBits.ManageChannels,
                    PermissionFlagsBits.CreatePublicThreads,
                    PermissionFlagsBits.CreatePrivateThreads,
                    PermissionFlagsBits.SendMessagesInThreads,
                  ],
                }]
              : []),
          ],
        }
      : {}),
  };
  const channel = await guild.channels.create(createOpts);
  return { id: channel.id, name: channel.name };
}

export async function broadcastDiscordText(client: Client | null, guilds: Set<string> | undefined, text: string): Promise<void> {
  if (!client) return;
  try {
    const guildList = guilds
      ? [...guilds].map((id) => client.guilds.cache.get(id)).filter(Boolean)
      : [...client.guilds.cache.values()];
    for (const guild of guildList) {
      if (!guild) continue;
      const target = guild.systemChannel
        ?? guild.channels.cache.find((ch): ch is TextChannel => ch.type === ChannelType.GuildText && ch.permissionsFor(guild.members.me!)?.has('SendMessages') === true);
      if (target && 'send' in target) {
        await target.send(text);
      }
    }
  } catch (err) {
    console.error('[discord] Broadcast failed:', (err as Error).message);
  }
}

export async function deleteDiscordChannel(client: Client | null, channelId: string): Promise<void> {
  if (!client) throw new Error('[discord] Not connected');
  const channel = await client.channels.fetch(channelId);
  if (!channel) throw new Error(`[discord] Channel not found: ${channelId}`);
  if ('delete' in channel && typeof channel.delete === 'function') {
    await channel.delete();
    return;
  }
  throw new Error(`[discord] Cannot delete channel ${channelId}`);
}

export async function editDiscordChannel(client: Client | null, channelId: string, opts: { name?: string; topic?: string }): Promise<void> {
  if (!client) throw new Error('[discord] Not connected');
  const channel = await client.channels.fetch(channelId);
  if (!channel) throw new Error(`[discord] Channel not found: ${channelId}`);
  if ('edit' in channel && typeof channel.edit === 'function') {
    await (channel as TextChannel).edit(opts);
    return;
  }
  throw new Error(`[discord] Cannot edit channel ${channelId}`);
}

export async function grantDiscordChannelAccess(client: Client | null, channelId: string, userId: string): Promise<void> {
  if (!client) throw new Error('[discord] Not connected');
  channelId = normalizeDiscordChannelId(channelId);
  const channel = await client.channels.fetch(channelId);
  if (!channel || !('guild' in channel) || !('permissionOverwrites' in channel)) {
    throw new Error(`[discord] Cannot manage access for channel ${channelId}`);
  }
  const guild = channel.guild;
  const member = await guild.members.fetch(userId).catch(() => null);
  if (!member) {
    throw new Error(`Discord user ${userId} is not in guild ${guild.id}`);
  }
  await channel.permissionOverwrites.edit(userId, {
    ViewChannel: true,
    SendMessages: true,
    ReadMessageHistory: true,
  });
}

export async function createDiscordThread(
  client: Client | null,
  channelId: string,
  name: string,
  opts?: { messageId?: string },
): Promise<{ id: string; name: string }> {
  if (!client) throw new Error('[discord] Not connected');
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased()) throw new Error(`[discord] Cannot create thread in ${channelId}`);
  const textChannel = channel as TextChannel;
  if (opts?.messageId) {
    const message = await textChannel.messages.fetch(opts.messageId);
    const thread = await message.startThread({ name });
    return { id: thread.id, name: thread.name };
  }
  const thread = await textChannel.threads.create({ name });
  return { id: thread.id, name: thread.name };
}

export async function archiveDiscordThread(client: Client | null, threadId: string): Promise<void> {
  if (!client) return;
  try {
    const channel = await client.channels.fetch(threadId);
    if (channel?.isThread()) {
      await channel.setArchived(true);
    }
  } catch (err) {
    console.error('[discord] archiveThread error:', err instanceof Error ? err.message : err);
  }
}
