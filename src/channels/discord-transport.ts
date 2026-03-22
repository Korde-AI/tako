import {
  ChannelType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
  type Message as DiscordMessage,
  type TextChannel,
} from 'discord.js';
import type { InboundMessage, OutboundMessage } from './channel.js';
import { withRetry, DISCORD_RETRY } from './retry.js';
import {
  MAX_DISCORD_MESSAGE_LENGTH,
  isThreadLike,
  maskName,
  normalizeDiscordChannelId,
  type DiscordChannelOpts,
  type DiscordInteractionState,
  type DiscordMessageHandlerState,
} from './discord-types.js';
import { wireDiscordInteractionHandlers } from './discord-interactions.js';
import { scanSecrets } from '../core/security.js';

export interface DiscordTransportState extends DiscordMessageHandlerState {
  token: string;
  guilds?: Set<string>;
  allowUnmentionedChannels?: Set<string>;
  interactionState: DiscordInteractionState;
  agentId?: string;
  reconnectAttempts: number;
  maxReconnectAttempts: number;
  reconnectDelay: number;
}

export function createDiscordClient(_opts: DiscordChannelOpts): Client {
  return new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.MessageContent,
    ],
    partials: [Partials.Channel, Partials.Message],
  });
}

export function splitDiscordMessage(content: string): string[] {
  if (content.length <= MAX_DISCORD_MESSAGE_LENGTH) return [content];
  const chunks: string[] = [];
  let current = '';
  for (const line of content.split('\n')) {
    if ((current + line + '\n').length > MAX_DISCORD_MESSAGE_LENGTH) {
      if (current) chunks.push(current.trimEnd());
      current = line + '\n';
    } else {
      current += line + '\n';
    }
  }
  if (current) chunks.push(current.trimEnd());
  return chunks.length > 0 ? chunks : [''];
}

export function convertDiscordInbound(message: DiscordMessage): InboundMessage {
  const maybeThread = 'isThread' in message.channel && typeof message.channel.isThread === 'function' && message.channel.isThread()
    ? message.channel
    : null;
  return {
    id: message.id,
    channelId: `discord:${message.channelId}`,
    author: {
      id: message.author.id,
      name: message.author.displayName || message.author.username,
      meta: {
        isBot: message.author.bot,
        botId: message.author.bot ? message.author.id : undefined,
        username: message.author.username,
        discriminator: message.author.discriminator,
        guildId: message.guild?.id,
        guildName: message.guild?.name,
        channelName: 'name' in message.channel ? message.channel.name ?? undefined : undefined,
        parentChannelId: maybeThread?.parentId ?? undefined,
        parentChannelName: maybeThread?.parent?.isTextBased?.() && 'name' in maybeThread.parent
          ? (maybeThread.parent as { name?: string }).name ?? undefined
          : undefined,
      },
    },
    content: message.content,
    attachments: message.attachments.map((a) => ({
      type: (a.contentType?.startsWith('image/') ? 'image'
        : a.contentType?.startsWith('audio/') ? 'audio'
        : a.contentType?.startsWith('video/') ? 'video'
        : 'file') as 'image' | 'file' | 'audio' | 'video',
      url: a.url,
      filename: a.name ?? undefined,
      mimeType: a.contentType ?? undefined,
    })),
    timestamp: message.createdAt.toISOString(),
    raw: message,
    threadId: maybeThread?.id,
  };
}

export async function connectDiscordTransport(
  client: Client,
  state: DiscordTransportState,
  registerSlashCommands: (clientId: string) => Promise<void>,
  attemptReconnect: () => void,
): Promise<void> {
  client.on(Events.MessageCreate, async (message: DiscordMessage) => {
    const myBotId = client.user?.id;
    if (myBotId && message.author.id === myBotId) return;
    if (state.guilds && message.guild && !state.guilds.has(message.guild.id)) return;

    if (myBotId && message.guild) {
      const explicitMention = message.content.includes(`<@${myBotId}>`) || message.content.includes(`<@!${myBotId}>`);
      if (message.author.bot && !explicitMention) {
        return;
      }
      if (!explicitMention) {
        const channelId = message.channelId;
        const guildId = message.guild.id;
        const autoActive = state.allowUnmentionedChannels?.has(channelId)
          || state.allowUnmentionedChannels?.has(guildId)
          || false;
        if (!autoActive) return;
      }
    }

    const inbound = convertDiscordInbound(message);
    for (const handler of state.handlers) {
      try {
        await handler(inbound);
      } catch (err) {
        console.error('[discord] Handler error:', err instanceof Error ? err.message : err);
      }
    }
  });

  client.on(Events.ChannelDelete, async (channel) => {
    const kind = channel.isThread() ? 'thread' : 'channel';
    for (const handler of state.roomClosedHandlers) {
      try {
        await handler({
          channelId: channel.id,
          guildId: 'guildId' in channel ? channel.guildId ?? undefined : undefined,
          kind,
          reason: 'deleted',
        });
      } catch (err) {
        console.error('[discord] Room-closed handler error:', err instanceof Error ? err.message : err);
      }
    }
  });

  client.on(Events.ThreadUpdate, async (oldThread, newThread) => {
    if (!oldThread.archived && newThread.archived) {
      for (const handler of state.roomClosedHandlers) {
        try {
          await handler({
            channelId: newThread.id,
            guildId: newThread.guildId ?? undefined,
            kind: 'thread',
            reason: 'archived',
          });
        } catch (err) {
          console.error('[discord] Room-closed handler error:', err instanceof Error ? err.message : err);
        }
      }
    }
  });

  client.on(Events.ChannelUpdate, async (oldChannel, newChannel) => {
    if (!('permissionOverwrites' in oldChannel) || !('permissionOverwrites' in newChannel)) return;
    const before = new Set(
      Array.from(oldChannel.permissionOverwrites.cache.values())
        .filter((overwrite) => overwrite.type === 1 && overwrite.allow.has('ViewChannel'))
        .map((overwrite) => overwrite.id),
    );
    const added = Array.from(newChannel.permissionOverwrites.cache.values())
      .filter((overwrite) => overwrite.type === 1 && overwrite.allow.has('ViewChannel'))
      .map((overwrite) => overwrite.id)
      .filter((id) => !before.has(id));
    if (added.length === 0) return;
    for (const handler of state.roomParticipantHandlers) {
      try {
        const parentChannelId = 'parentId' in newChannel
          ? newChannel.parentId ?? undefined
          : undefined;
        await handler({
          channelId: newChannel.id,
          guildId: 'guildId' in newChannel ? newChannel.guildId ?? undefined : undefined,
          parentChannelId,
          kind: newChannel.isThread() ? 'thread' : 'channel',
          userIds: added,
          reason: 'channel_access_granted',
        });
      } catch (err) {
        console.error('[discord] Room-participant handler error:', err instanceof Error ? err.message : err);
      }
    }
  });

  client.on(Events.ThreadMembersUpdate as any, async (...args: any[]) => {
    const addedMembers = args[2];
    if (!addedMembers?.size) return;
    const thread = args[3] ?? args[0]?.first?.()?.thread ?? null;
    const channelId = thread?.id;
    if (!channelId) return;
    const userIds = Array.from(addedMembers.values()).map((member: any) => String(member.id)).filter(Boolean);
    if (userIds.length === 0) return;
    for (const handler of state.roomParticipantHandlers) {
      try {
        await handler({
          channelId,
          guildId: thread.guildId ?? undefined,
          parentChannelId: thread.parentId ?? undefined,
          kind: 'thread',
          userIds,
          reason: 'thread_member_added',
        });
      } catch (err) {
        console.error('[discord] Room-participant handler error:', err instanceof Error ? err.message : err);
      }
    }
  });

  wireDiscordInteractionHandlers(client, state.interactionState, registerSlashCommands);

  client.on(Events.ClientReady, async (c) => {
    state.reconnectAttempts = 0;
    console.log(`[discord] ✦ Connected as ${maskName(c.user.tag)}`);
    if (state.interactionState.nativeCommands.length > 0) {
      await registerSlashCommands(c.user.id);
    }
  });

  client.on(Events.GuildCreate, async (guild) => {
    console.log(`[discord] Joined guild: ${guild.name} (${guild.id})`);
    const agentName = state.agentId ?? 'Tako';
    const intro = [
      `👋 **${agentName}** just joined **${guild.name}**!`,
      '',
      `I'm an AI assistant powered by Tako. Here's how to talk to me:`,
      `• **Mention me** - \`@${client.user?.displayName ?? agentName}\` followed by your message`,
      `• **DM me** - send a direct message for private conversations`,
      '',
      '**Commands:**',
      '• `/help` - see available commands',
      '• `/status` - check my current status',
      '• `/model` - view or switch the AI model',
      '• `/new` - start a fresh conversation',
      '',
      'Ready to help.',
    ].join('\n');

    const target = guild.systemChannel
      ?? guild.channels.cache.find(
        (ch): ch is TextChannel => ch.type === ChannelType.GuildText && ch.permissionsFor(guild.members.me!)?.has('SendMessages') === true,
      );
    if (target && 'send' in target) {
      try {
        await target.send(intro);
      } catch (err) {
        console.error(`[discord] Failed to send intro to ${guild.name}:`, (err as Error).message);
      }
    }
  });

  client.on(Events.Error, (err) => {
    console.error('[discord] Client error:', err.message);
  });

  client.on(Events.ShardDisconnect, () => {
    console.warn('[discord] Disconnected, will attempt reconnect...');
    attemptReconnect();
  });

  await client.login(state.token);
}

export async function disconnectDiscordTransport(client: Client | null): Promise<void> {
  if (!client) return;
  client.removeAllListeners();
  await client.destroy();
  console.log('[discord] Disconnected');
}

export async function sendDiscordMessage(client: Client | null, msg: OutboundMessage): Promise<void> {
  if (!client) throw new Error('[discord] Not connected');
  const channel = await client.channels.fetch(msg.target);
  if (!channel || !channel.isTextBased()) throw new Error(`[discord] Cannot send to channel ${msg.target}`);
  const safeContent = scanSecrets(msg.content);
  const sendable = channel as unknown as { send: (opts: Record<string, unknown>) => Promise<unknown> };
  await sendDiscordChunks(sendable, safeContent, msg.replyTo, msg.attachments);
}

export async function sendDiscordChunks(
  channel: { send: (opts: Record<string, unknown>) => Promise<unknown> },
  content: string,
  replyTo?: string,
  attachments?: import('./channel.js').Attachment[],
): Promise<void> {
  const chunks = splitDiscordMessage(content);
  for (let i = 0; i < chunks.length; i++) {
    const isLast = i === chunks.length - 1;
    const files = isLast && attachments?.length
      ? attachments.map((a) => {
          if (a.data) return { attachment: a.data, name: a.filename ?? 'file' };
          if (a.url) return { attachment: a.url, name: a.filename ?? 'file' };
          return null;
        }).filter(Boolean)
      : [];
    const opts: Record<string, unknown> = {
      content: chunks[i],
      ...(i === 0 && replyTo ? { reply: { messageReference: replyTo } } : {}),
      ...(files.length ? { files } : {}),
    };
    await withRetry(() => channel.send(opts) as Promise<unknown>, DISCORD_RETRY, `send chunk ${i + 1}/${chunks.length}`);
  }
}

export async function sendDiscordMessageAndGetId(client: Client | null, msg: OutboundMessage): Promise<string> {
  if (!client) throw new Error('[discord] Not connected');
  const channel = await client.channels.fetch(msg.target);
  if (!channel || !channel.isTextBased()) throw new Error(`[discord] Cannot send to channel ${msg.target}`);
  const files = msg.attachments?.length
    ? msg.attachments.map((a) => {
        if (a.data) return { attachment: a.data, name: a.filename ?? 'file' };
        if (a.url) return { attachment: a.url, name: a.filename ?? 'file' };
        return null;
      }).filter(Boolean)
    : [];
  const sendable = channel as unknown as { send: (opts: Record<string, unknown>) => Promise<{ id: string }> };
  const sent = await withRetry(
    () => sendable.send({
      content: msg.content,
      ...(msg.replyTo ? { reply: { messageReference: msg.replyTo } } : {}),
      ...(files.length ? { files } : {}),
    }),
    DISCORD_RETRY,
    'sendAndGetId',
  );
  return (sent as { id: string }).id;
}

export async function editDiscordMessage(client: Client | null, chatId: string, messageId: string, content: string): Promise<void> {
  if (!client) throw new Error('[discord] Not connected');
  const channel = await client.channels.fetch(chatId);
  if (!channel || !channel.isTextBased()) throw new Error(`[discord] Cannot edit in channel ${chatId}`);
  const textChannel = channel as unknown as {
    messages: { fetch: (id: string) => Promise<{ edit: (opts: Record<string, unknown>) => Promise<unknown> }> };
  };
  const message = await textChannel.messages.fetch(messageId);
  await withRetry(() => message.edit({ content }), DISCORD_RETRY, 'editMessage');
}

export async function sendDiscordTyping(client: Client | null, channelId: string): Promise<void> {
  if (!client) return;
  channelId = normalizeDiscordChannelId(channelId);
  if (!/^\d{17,20}$/.test(channelId)) return;
  try {
    const channel = await client.channels.fetch(channelId);
    if (channel && channel.isTextBased() && 'sendTyping' in channel) {
      await (channel as TextChannel).sendTyping();
    }
  } catch (err) {
    console.error('[discord] sendTyping error:', err instanceof Error ? err.message : err);
  }
}

export async function addDiscordReaction(client: Client | null, channelId: string, messageId: string, emoji: string): Promise<void> {
  if (!client) return;
  channelId = normalizeDiscordChannelId(channelId);
  try {
    const channel = await client.channels.fetch(channelId);
    if (channel && channel.isTextBased()) {
      const message = await (channel as TextChannel).messages.fetch(messageId);
      await message.react(emoji);
    }
  } catch (err) {
    console.error('[discord] addReaction error:', err instanceof Error ? err.message : err);
  }
}

export async function removeDiscordReaction(client: Client | null, channelId: string, messageId: string, emoji: string): Promise<void> {
  if (!client) return;
  channelId = normalizeDiscordChannelId(channelId);
  try {
    const channel = await client.channels.fetch(channelId);
    if (channel && channel.isTextBased()) {
      const message = await (channel as TextChannel).messages.fetch(messageId);
      const botUser = client.user;
      if (botUser) {
        await message.reactions.resolve(emoji)?.users.remove(botUser.id);
      }
    }
  } catch (err) {
    console.error('[discord] removeReaction error:', err instanceof Error ? err.message : err);
  }
}
