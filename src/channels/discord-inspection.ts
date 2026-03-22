import { PermissionFlagsBits, type Client, type GuildBasedChannel, type TextChannel } from 'discord.js';
import { isThreadLike, normalizeDiscordChannelId, type DiscordRecentMessage, type DiscordRoomInspection } from './discord-types.js';

export async function inspectDiscordRoom(client: Client | null, channelId: string): Promise<DiscordRoomInspection> {
  if (!client) throw new Error('[discord] Not connected');
  channelId = normalizeDiscordChannelId(channelId);

  const channel = await client.channels.fetch(channelId);
  if (!channel) throw new Error(`[discord] Channel not found: ${channelId}`);

  if (channel.isDMBased()) {
    return {
      channelId: channel.id,
      channelName: 'name' in channel ? (channel as { name?: string }).name : undefined,
      kind: 'dm',
      private: true,
      members: [],
      notes: ['DM membership is not enumerable from the Discord room inspection path.'],
    };
  }

  const members = new Map<string, {
    userId: string;
    username?: string;
    displayName?: string;
    source: 'thread_member' | 'permission_overwrite';
  }>();
  const addMember = (entry: {
    userId: string;
    username?: string;
    displayName?: string;
    source: 'thread_member' | 'permission_overwrite';
  }) => {
    const existing = members.get(entry.userId);
    members.set(entry.userId, existing ? {
      ...existing,
      username: existing.username ?? entry.username,
      displayName: existing.displayName ?? entry.displayName,
      source: existing.source === 'thread_member' ? existing.source : entry.source,
    } : entry);
  };

  const notes: string[] = [];
  const guildChannel = channel as GuildBasedChannel;
  let isPrivate = false;

  if ('permissionOverwrites' in guildChannel) {
    for (const overwrite of guildChannel.permissionOverwrites.cache.values()) {
      if (overwrite.type !== 1) continue;
      if (
        overwrite.allow.has(PermissionFlagsBits.ViewChannel)
        || overwrite.allow.has(PermissionFlagsBits.SendMessages)
        || overwrite.allow.has(PermissionFlagsBits.ReadMessageHistory)
      ) {
        isPrivate = true;
        const member = await guildChannel.guild.members.fetch(overwrite.id).catch(() => null);
        addMember({
          userId: overwrite.id,
          username: member?.user.username,
          displayName: member?.displayName ?? member?.user.displayName,
          source: 'permission_overwrite',
        });
      }
    }
  }

  if (isThreadLike(channel)) {
    const threadMembers = await channel.members.fetch().catch(() => null);
    if (threadMembers && threadMembers.size > 0) {
      for (const threadMember of threadMembers.values()) {
        addMember({
          userId: threadMember.id,
          username: threadMember.user?.username,
          displayName: threadMember.user?.displayName,
          source: 'thread_member',
        });
      }
    } else {
      notes.push('Thread member list was not available from the Discord API at inspection time.');
    }
  } else if (!isPrivate) {
    notes.push('This appears to be a public or role-visible channel. Exact visible membership is not enumerable here, so only explicit per-user access grants are listed.');
  }

  if (members.size === 0 && isPrivate) {
    notes.push('No explicit per-user access grants were found. Access may still come from roles or category-level permissions.');
  }

  return {
    guildId: 'guildId' in guildChannel ? guildChannel.guildId ?? undefined : undefined,
    guildName: 'guild' in guildChannel ? guildChannel.guild?.name : undefined,
    channelId: guildChannel.id,
    channelName: 'name' in guildChannel ? (guildChannel as { name?: string }).name : undefined,
    kind: isThreadLike(channel) ? 'thread' : 'channel',
    private: isPrivate || isThreadLike(channel),
    members: Array.from(members.values()).sort((a, b) =>
      (a.displayName ?? a.username ?? a.userId).localeCompare(b.displayName ?? b.username ?? b.userId)),
    notes,
  };
}

export async function fetchRecentDiscordMessages(client: Client | null, channelId: string, limit = 20): Promise<DiscordRecentMessage[]> {
  if (!client) throw new Error('[discord] Not connected');
  channelId = normalizeDiscordChannelId(channelId);
  const channel = await client.channels.fetch(channelId);
  if (!channel || !channel.isTextBased()) {
    throw new Error(`[discord] Cannot inspect message history for channel ${channelId}`);
  }
  const textChannel = channel as TextChannel;
  const messages = await textChannel.messages.fetch({ limit });
  return Array.from(messages.values())
    .map((message) => ({
      id: message.id,
      authorId: message.author.id,
      authorName: message.author.displayName || message.author.username,
      username: message.author.username,
      isBot: message.author.bot,
      content: message.content,
      timestamp: message.createdAt.toISOString(),
    }))
    .sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}
