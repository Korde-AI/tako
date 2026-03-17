/**
 * Discord channel adapter.
 *
 * Connects to Discord via bot token using discord.js.
 * Listens for messages, converts them to InboundMessage,
 * and sends responses back to the appropriate channel.
 */

import {
  Client,
  GatewayIntentBits,
  Events,
  ChannelType,
  PermissionFlagsBits,
  Partials,
  REST,
  Routes,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  type Message as DiscordMessage,
  type TextChannel,
  type GuildChannelCreateOptions,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
  type ButtonInteraction,
} from 'discord.js';
import type { Channel, InboundMessage, OutboundMessage, MessageHandler } from './channel.js';
import { withRetry, DISCORD_RETRY } from './retry.js';
import type { SkillCommandSpec } from '../commands/skill-commands.js';
import { scanSecrets } from '../core/security.js';

const MAX_DISCORD_MESSAGE_LENGTH = 2000;

/** Mask a name for privacy: keep first 2 and last 3 chars, replace middle with ***. */
function maskName(name: string): string {
  if (name.length <= 5) return name[0] + '***' + name[name.length - 1];
  return name.slice(0, 2) + '***' + name.slice(-3);
}

function normalizeDiscordChannelId(channelId: string): string {
  return channelId.startsWith('discord:') ? channelId.slice('discord:'.length) : channelId;
}

/** Handler for native slash command interactions. */
export type SlashCommandHandler = (
  commandName: string,
  channelId: string,
  author: { id: string; name: string; meta?: Record<string, unknown> },
  guildId?: string,
) => Promise<string | null>;

/**
 * Interactive command handler — receives the raw ChatInputCommandInteraction
 * and can reply with embeds/components. Returns true if handled, false to
 * fall through to the text-based slash command handler.
 */
export type InteractiveCommandHandler = (
  interaction: ChatInputCommandInteraction,
) => Promise<boolean>;

/** Handler for modal submit interactions. */
export type ModalSubmitHandler = (interaction: ModalSubmitInteraction) => Promise<boolean>;

/** Handler for string select menu interactions. */
export type SelectMenuHandler = (interaction: StringSelectMenuInteraction) => Promise<boolean>;

/** Handler for button interactions. */
export type ButtonHandler = (interaction: ButtonInteraction) => Promise<boolean>;
export type RoomClosedHandler = (input: {
  channelId: string;
  guildId?: string;
  kind: 'channel' | 'thread';
  reason: 'deleted' | 'archived';
}) => Promise<void>;

export interface DiscordChannelOpts {
  token: string;
  guilds?: string[];
  /** Channel/guild IDs where this bot may respond without explicit @mention. */
  allowUnmentionedChannels?: string[];
}

export class DiscordChannel implements Channel {
  id = 'discord';
  agentId?: string;
  private token: string;
  private guilds?: Set<string>;
  private allowUnmentionedChannels?: Set<string>;
  private client: Client | null = null;
  private handlers: MessageHandler[] = [];
  private slashCommandHandler: SlashCommandHandler | null = null;
  private interactiveHandlers = new Map<string, InteractiveCommandHandler>();
  private modalHandlers: ModalSubmitHandler[] = [];
  private selectMenuHandlers: SelectMenuHandler[] = [];
  private buttonHandlers: ButtonHandler[] = [];
  private roomClosedHandlers: RoomClosedHandler[] = [];
  private nativeCommands: Array<{ name: string; description: string }> = [];
  private previousSkillNames?: Set<string>;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 5000;

  constructor(opts: DiscordChannelOpts) {
    this.token = opts.token;
    this.guilds = opts.guilds ? new Set(opts.guilds) : undefined;
    this.allowUnmentionedChannels = opts.allowUnmentionedChannels
      ? new Set(opts.allowUnmentionedChannels)
      : undefined;
  }

  async connect(): Promise<void> {
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.MessageContent,
      ],
      // Partials required for DM support — discord.js won't emit
      // MessageCreate for DMs without Channel + Message partials
      partials: [Partials.Channel, Partials.Message],
    });

    this.client.on(Events.MessageCreate, async (message: DiscordMessage) => {
      if (message.author.bot) return;
      if (this.guilds && message.guild && !this.guilds.has(message.guild.id)) return;

      // ─── Mention-based routing ─────────────────────────────────────
      // In guild channels, default to explicit @mention unless this channel
      // (or guild) is allowlisted for auto-active routing.
      // DMs always go through regardless.
      const myBotId = this.client?.user?.id;
      if (myBotId && message.guild) {
        const explicitMention = message.content.includes(`<@${myBotId}>`) || message.content.includes(`<@!${myBotId}>`);
        if (!explicitMention) {
          const channelId = message.channelId;
          const guildId = message.guild.id;
          const autoActive = this.allowUnmentionedChannels?.has(channelId)
            || this.allowUnmentionedChannels?.has(guildId)
            || false;
          if (!autoActive) {
            return; // Not explicitly addressed to this bot
          }
        }
      }

      const inbound = this.convertInbound(message);
      for (const handler of this.handlers) {
        try {
          await handler(inbound);
        } catch (err) {
          console.error('[discord] Handler error:', err instanceof Error ? err.message : err);
        }
      }
    });

    this.client.on(Events.ChannelDelete, async (channel) => {
      const kind = channel.isThread() ? 'thread' : 'channel';
      for (const handler of this.roomClosedHandlers) {
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

    this.client.on(Events.ThreadUpdate, async (oldThread, newThread) => {
      if (!oldThread.archived && newThread.archived) {
        for (const handler of this.roomClosedHandlers) {
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

    // Handle native slash command interactions
    this.client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isChatInputCommand()) return;

      const cmdInteraction = interaction as ChatInputCommandInteraction;

      // Check interactive handlers first (model picker, etc.)
      const interactiveHandler = this.interactiveHandlers.get(cmdInteraction.commandName);
      if (interactiveHandler) {
        try {
          const handled = await interactiveHandler(cmdInteraction);
          if (handled) return;
        } catch (err) {
          console.error('[discord] Interactive handler error:', err instanceof Error ? err.message : err);
          if (!cmdInteraction.replied && !cmdInteraction.deferred) {
            await cmdInteraction.reply({ content: 'Something went wrong.', ephemeral: true });
          }
          return;
        }
      }

      // Fall through to text-based slash command handler
      if (!this.slashCommandHandler) {
        await cmdInteraction.reply({ content: 'Commands not ready yet.', ephemeral: true });
        return;
      }

      // Defer reply in case handler takes a moment
      try {
        await cmdInteraction.deferReply();

        const author = {
          id: cmdInteraction.user.id,
          name: cmdInteraction.user.displayName || cmdInteraction.user.username,
          meta: {
            discriminator: cmdInteraction.user.discriminator,
            guildId: cmdInteraction.guild?.id,
            guildName: cmdInteraction.guild?.name,
          },
        };

        const channelId = cmdInteraction.channelId;
        const result = await this.slashCommandHandler(
          cmdInteraction.commandName,
          channelId,
          author,
          cmdInteraction.guild?.id,
        );

        await cmdInteraction.editReply({ content: result || 'Done.' });
      } catch (err) {
        console.error('[discord] Slash command handler error:', err instanceof Error ? err.stack || err.message : err);
        try {
          if (cmdInteraction.deferred || cmdInteraction.replied) {
            await cmdInteraction.editReply({ content: 'Command failed. Check Tako logs for the exact error.' });
          } else {
            await cmdInteraction.reply({ content: 'Command failed. Check Tako logs for the exact error.', ephemeral: true });
          }
        } catch {
          // Ignore secondary Discord API failures; the original error is logged above.
        }
      }
    });

    // Handle modal submit interactions
    this.client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isModalSubmit()) return;
      for (const handler of this.modalHandlers) {
        try {
          const handled = await handler(interaction as ModalSubmitInteraction);
          if (handled) return;
        } catch (err) {
          console.error('[discord] Modal handler error:', err instanceof Error ? err.message : err);
          if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: 'Something went wrong.', flags: 64 }).catch(() => {});
          }
          return;
        }
      }
    });

    // Handle string select menu interactions
    this.client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isStringSelectMenu()) return;
      for (const handler of this.selectMenuHandlers) {
        try {
          const handled = await handler(interaction as StringSelectMenuInteraction);
          if (handled) return;
        } catch (err) {
          console.error('[discord] Select menu handler error:', err instanceof Error ? err.message : err);
          if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: 'Something went wrong.', flags: 64 }).catch(() => {});
          }
          return;
        }
      }
    });

    // Handle button interactions
    this.client.on(Events.InteractionCreate, async (interaction) => {
      if (!interaction.isButton()) return;
      for (const handler of this.buttonHandlers) {
        try {
          const handled = await handler(interaction as ButtonInteraction);
          if (handled) return;
        } catch (err) {
          console.error('[discord] Button handler error:', err instanceof Error ? err.message : err);
          if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({ content: 'Something went wrong.', flags: 64 }).catch(() => {});
          }
          return;
        }
      }
    });

    this.client.on(Events.ClientReady, async (c) => {
      this.reconnectAttempts = 0;
      console.log(`[discord] ✦ Connected as ${maskName(c.user.tag)}`);

      // Register native slash commands per guild (instant, no 1-hour delay)
      if (this.nativeCommands.length > 0) {
        await this.registerSlashCommands(c.user.id);
      }
    });

    // When bot joins a new guild, introduce itself
    this.client.on(Events.GuildCreate, async (guild) => {
      console.log(`[discord] Joined guild: ${guild.name} (${guild.id})`);
      const agentName = this.agentId ?? 'Tako';
      const intro = [
        `👋 **${agentName}** just joined **${guild.name}**!`,
        '',
        `I'm an AI assistant powered by Tako 🐙. Here's how to talk to me:`,
        `• **Mention me** — \`@${this.client?.user?.displayName ?? agentName}\` followed by your message`,
        `• **DM me** — send a direct message for private conversations`,
        '',
        `**Commands:**`,
        `• \`/help\` — see available commands`,
        `• \`/status\` — check my current status`,
        `• \`/model\` — view or switch the AI model`,
        `• \`/new\` — start a fresh conversation`,
        '',
        `Ready to help! 🐙`,
      ].join('\n');

      // Send to system channel or first text channel
      const target = guild.systemChannel
        ?? guild.channels.cache.find(
          (ch): ch is import('discord.js').TextChannel =>
            ch.type === ChannelType.GuildText &&
            ch.permissionsFor(guild.members.me!)?.has('SendMessages') === true,
        );
      if (target && 'send' in target) {
        try {
          await (target as import('discord.js').TextChannel).send(intro);
        } catch (err) {
          console.error(`[discord] Failed to send intro to ${guild.name}:`, (err as Error).message);
        }
      }
    });

    this.client.on(Events.Error, (err) => {
      console.error('[discord] Client error:', err.message);
    });

    this.client.on(Events.ShardDisconnect, () => {
      console.warn('[discord] Disconnected, will attempt reconnect...');
      this.attemptReconnect();
    });

    await this.client.login(this.token);
  }

  async disconnect(): Promise<void> {
    if (this.client) {
      this.client.removeAllListeners();
      await this.client.destroy();
      this.client = null;
      console.log('[discord] Disconnected');
    }
  }

  async send(msg: OutboundMessage): Promise<void> {
    if (!this.client) throw new Error('[discord] Not connected');

    const channel = await this.client.channels.fetch(msg.target);
    if (!channel || !channel.isTextBased()) {
      throw new Error(`[discord] Cannot send to channel ${msg.target}`);
    }

    // Scan for secrets before sending
    const safeContent = scanSecrets(msg.content);

    const sendable = channel as unknown as { send: (opts: Record<string, unknown>) => Promise<unknown> };
    await this.sendChunks(sendable, safeContent, msg.replyTo, msg.attachments);
  }

  /** Send message chunks to a text-based channel with retry. */
  private async sendChunks(
    channel: { send: (opts: Record<string, unknown>) => Promise<unknown> },
    content: string,
    replyTo?: string,
    attachments?: import('./channel.js').Attachment[],
  ): Promise<void> {
    const chunks = this.splitMessage(content);
    for (let i = 0; i < chunks.length; i++) {
      const isLast = i === chunks.length - 1;

      // Build discord.js file attachment objects (only on last chunk)
      const files = isLast && attachments?.length
        ? attachments.map((a) => {
            if (a.data) {
              return { attachment: a.data, name: a.filename ?? 'file' };
            }
            if (a.url) {
              return { attachment: a.url, name: a.filename ?? 'file' };
            }
            return null;
          }).filter(Boolean)
        : [];

      const opts: Record<string, unknown> = {
        content: chunks[i],
        ...(i === 0 && replyTo ? { reply: { messageReference: replyTo } } : {}),
        ...(files.length ? { files } : {}),
      };
      await withRetry(
        () => channel.send(opts) as Promise<unknown>,
        DISCORD_RETRY,
        `send chunk ${i + 1}/${chunks.length}`,
      );
    }
  }

  async sendAndGetId(msg: OutboundMessage): Promise<string> {
    if (!this.client) throw new Error('[discord] Not connected');

    const channel = await this.client.channels.fetch(msg.target);
    if (!channel || !channel.isTextBased()) {
      throw new Error(`[discord] Cannot send to channel ${msg.target}`);
    }

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

  async editMessage(chatId: string, messageId: string, content: string): Promise<void> {
    if (!this.client) throw new Error('[discord] Not connected');

    const channel = await this.client.channels.fetch(chatId);
    if (!channel || !channel.isTextBased()) {
      throw new Error(`[discord] Cannot edit in channel ${chatId}`);
    }

    const textChannel = channel as unknown as {
      messages: { fetch: (id: string) => Promise<{ edit: (opts: Record<string, unknown>) => Promise<unknown> }> };
    };
    const message = await textChannel.messages.fetch(messageId);
    await withRetry(
      () => message.edit({ content }),
      DISCORD_RETRY,
      'editMessage',
    );
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  private convertInbound(message: DiscordMessage): InboundMessage {
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
          discriminator: message.author.discriminator,
          guildId: message.guild?.id,
          guildName: message.guild?.name,
          parentChannelId: maybeThread?.parentId ?? undefined,
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
      threadId: maybeThread?.id ?? undefined,
    };
  }

  private splitMessage(content: string): string[] {
    if (content.length <= MAX_DISCORD_MESSAGE_LENGTH) return [content];

    const chunks: string[] = [];
    let remaining = content;

    while (remaining.length > 0) {
      if (remaining.length <= MAX_DISCORD_MESSAGE_LENGTH) {
        chunks.push(remaining);
        break;
      }

      let splitAt = remaining.lastIndexOf('\n', MAX_DISCORD_MESSAGE_LENGTH);
      if (splitAt === -1 || splitAt < MAX_DISCORD_MESSAGE_LENGTH / 2) {
        splitAt = remaining.lastIndexOf(' ', MAX_DISCORD_MESSAGE_LENGTH);
      }
      if (splitAt === -1 || splitAt < MAX_DISCORD_MESSAGE_LENGTH / 2) {
        splitAt = MAX_DISCORD_MESSAGE_LENGTH;
      }

      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trimStart();
    }

    return chunks;
  }

  /** Get the underlying discord.js Client (for advanced operations). */
  getClient(): Client | null {
    return this.client;
  }

  /** Create a text channel in a guild. */
  async createChannel(
    guildId: string,
    name: string,
    opts?: { topic?: string; parentId?: string; privateUserId?: string },
  ): Promise<{ id: string; name: string }> {
    if (!this.client) throw new Error('[discord] Not connected');

    const guild = await this.client.guilds.fetch(guildId);
    const createOpts: GuildChannelCreateOptions = {
      name,
      type: ChannelType.GuildText,
      ...(opts?.topic ? { topic: opts.topic } : {}),
      ...(opts?.parentId ? { parent: opts.parentId } : {}),
      ...(opts?.privateUserId
        ? {
            permissionOverwrites: [
              {
                id: guild.roles.everyone.id,
                deny: [PermissionFlagsBits.ViewChannel],
              },
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

  /** Broadcast a system message to all guild system/general channels. */
  async broadcast(text: string): Promise<void> {
    if (!this.client) return;
    try {
      const guilds = this.guilds
        ? [...this.guilds].map(id => this.client!.guilds.cache.get(id)).filter(Boolean)
        : [...this.client.guilds.cache.values()];

      for (const guild of guilds) {
        if (!guild) continue;
        // Find the first text channel the bot can send to
        const target = guild.systemChannel
          ?? guild.channels.cache.find(
            (ch): ch is import('discord.js').TextChannel =>
              ch.type === ChannelType.GuildText &&
              ch.permissionsFor(guild.members.me!)?.has('SendMessages') === true,
          );
        if (target && 'send' in target) {
          await (target as import('discord.js').TextChannel).send(text);
        }
      }
    } catch (err) {
      console.error('[discord] Broadcast failed:', (err as Error).message);
    }
  }

  /** Delete a channel by ID. */
  async deleteChannel(channelId: string): Promise<void> {
    if (!this.client) throw new Error('[discord] Not connected');

    const channel = await this.client.channels.fetch(channelId);
    if (!channel) throw new Error(`[discord] Channel not found: ${channelId}`);
    if ('delete' in channel && typeof channel.delete === 'function') {
      await channel.delete();
    } else {
      throw new Error(`[discord] Cannot delete channel ${channelId}`);
    }
  }

  /** Edit a channel (name, topic). */
  async editChannel(
    channelId: string,
    opts: { name?: string; topic?: string },
  ): Promise<void> {
    if (!this.client) throw new Error('[discord] Not connected');

    const channel = await this.client.channels.fetch(channelId);
    if (!channel) throw new Error(`[discord] Channel not found: ${channelId}`);
    if ('edit' in channel && typeof channel.edit === 'function') {
      await (channel as TextChannel).edit(opts);
    } else {
      throw new Error(`[discord] Cannot edit channel ${channelId}`);
    }
  }

  /** Send a message to a specific channel by ID. */
  async sendToChannel(channelId: string, content: string): Promise<string> {
    if (!this.client) throw new Error('[discord] Not connected');

    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      throw new Error(`[discord] Cannot send to channel ${channelId}`);
    }

    const sendable = channel as { send: (opts: Record<string, unknown>) => Promise<{ id: string }> };
    const chunks = this.splitMessage(content);
    let lastMessageId = '';

    for (const chunk of chunks) {
      const msg = await sendable.send({ content: chunk });
      lastMessageId = msg.id;
    }

    return lastMessageId;
  }

  async sendPatchApprovalRequest(input: {
    channelId: string;
    projectId: string;
    projectSlug?: string;
    approvalId: string;
    artifactName: string;
    requestedByNodeId?: string;
    requestedByPrincipalId?: string;
    sourceBranch?: string;
    targetBranch?: string;
    conflictSummary?: string;
  }): Promise<string> {
    if (!this.client) throw new Error('[discord] Not connected');

    const channel = await this.client.channels.fetch(input.channelId);
    if (!channel || !channel.isTextBased()) {
      throw new Error(`[discord] Cannot send to channel ${input.channelId}`);
    }

    const sendable = channel as { send: (opts: Record<string, unknown>) => Promise<{ id: string }> };
    const lines = [
      `Patch review required for **${input.projectSlug ?? input.projectId}**`,
      `Artifact: \`${input.artifactName}\``,
      `Approval: \`${input.approvalId}\``,
      input.requestedByNodeId ? `From node: \`${input.requestedByNodeId}\`` : null,
      input.requestedByPrincipalId ? `From principal: \`${input.requestedByPrincipalId}\`` : null,
      input.sourceBranch ? `Source branch: \`${input.sourceBranch}\`` : null,
      input.targetBranch ? `Target branch: \`${input.targetBranch}\`` : null,
      input.conflictSummary ? `Conflict: ${input.conflictSummary}` : null,
      '',
      'Use the buttons below or `/patchapprove` and `/patchdeny`.',
    ].filter(Boolean).join('\n');

    const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
      new ButtonBuilder()
        .setCustomId(`patchapprove:${input.projectId}:${input.approvalId}`)
        .setLabel('Approve Patch')
        .setStyle(ButtonStyle.Success),
      new ButtonBuilder()
        .setCustomId(`patchdeny:${input.projectId}:${input.approvalId}`)
        .setLabel('Deny Patch')
        .setStyle(ButtonStyle.Danger),
    );

    const msg = await sendable.send({
      content: lines,
      components: [row],
    });
    return msg.id;
  }

  /** Create a thread in a channel. */
  async createThread(
    channelId: string,
    name: string,
    opts?: { messageId?: string },
  ): Promise<{ id: string; name: string }> {
    if (!this.client) throw new Error('[discord] Not connected');

    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      throw new Error(`[discord] Cannot create thread in ${channelId}`);
    }

    const textChannel = channel as TextChannel;

    if (opts?.messageId) {
      const message = await textChannel.messages.fetch(opts.messageId);
      const thread = await message.startThread({ name });
      return { id: thread.id, name: thread.name };
    } else {
      const thread = await textChannel.threads.create({ name });
      return { id: thread.id, name: thread.name };
    }
  }

  /** React to a message with an emoji. */
  async react(channelId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.client) throw new Error('[discord] Not connected');

    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      throw new Error(`[discord] Cannot react in channel ${channelId}`);
    }

    const textChannel = channel as TextChannel;
    const message = await textChannel.messages.fetch(messageId);
    await message.react(emoji);
  }

  async sendTyping(channelId: string): Promise<void> {
    if (!this.client) return;
    channelId = normalizeDiscordChannelId(channelId);

    // Discord channel IDs are snowflakes — numeric strings of 17-20 digits.
    // Guard against internal Tako UUIDs or other non-snowflake IDs being passed in
    // (e.g. from cron sessions that don't have a real Discord channel bound).
    if (!/^\d{17,20}$/.test(channelId)) return;

    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel && channel.isTextBased() && 'sendTyping' in channel) {
        await (channel as TextChannel).sendTyping();
      }
    } catch (err) {
      console.error('[discord] sendTyping error:', err instanceof Error ? err.message : err);
    }
  }

  async addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.client) return;
    channelId = normalizeDiscordChannelId(channelId);

    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel && channel.isTextBased()) {
        const message = await (channel as TextChannel).messages.fetch(messageId);
        await message.react(emoji);
      }
    } catch (err) {
      console.error('[discord] addReaction error:', err instanceof Error ? err.message : err);
    }
  }

  async removeReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.client) return;
    channelId = normalizeDiscordChannelId(channelId);

    try {
      const channel = await this.client.channels.fetch(channelId);
      if (channel && channel.isTextBased()) {
        const message = await (channel as TextChannel).messages.fetch(messageId);
        const botUser = this.client.user;
        if (botUser) {
          await message.reactions.resolve(emoji)?.users.remove(botUser.id);
        }
      }
    } catch (err) {
      console.error('[discord] removeReaction error:', err instanceof Error ? err.message : err);
    }
  }

  /** Set native slash commands and their handler. Call before connect(). */
  setSlashCommands(
    commands: Array<{ name: string; description: string }>,
    handler: SlashCommandHandler,
  ): void {
    this.nativeCommands = commands;
    this.slashCommandHandler = handler;
  }

  /**
   * Register an interactive handler for a specific slash command.
   * Interactive handlers receive the raw ChatInputCommandInteraction and can
   * reply with embeds, components, and collectors. They run before the
   * text-based handler; if they return true the interaction is consumed.
   */
  setInteractiveHandler(commandName: string, handler: InteractiveCommandHandler): void {
    this.interactiveHandlers.set(commandName, handler);
  }

  /**
   * Register skill commands as Discord slash commands.
   * Merges skill specs with existing native commands, re-registers with Discord API.
   * Call after connect() when skills are loaded.
   */
  async registerSkillCommands(
    specs: SkillCommandSpec[],
    handler: SlashCommandHandler,
  ): Promise<void> {
    // Rebuild command list: keep non-skill native commands, then add all skill specs
    // This ensures no duplicates accumulate across hot-reloads
    const skillNames = new Set(specs.map((s) => s.name));
    const coreCommands = this.nativeCommands.filter((c) => !skillNames.has(c.name) && !this.previousSkillNames?.has(c.name));
    const skillCommands = specs.map((s) => ({ name: s.name, description: s.description }));

    // Deduplicate: if a core command has the same name as a skill, skill wins
    const coreFiltered = coreCommands.filter((c) => !skillNames.has(c.name));
    this.nativeCommands = [...coreFiltered, ...skillCommands];
    this.previousSkillNames = skillNames;
    this.slashCommandHandler = handler;

    // Re-register with Discord API if already connected
    const clientId = this.client?.user?.id;
    if (clientId) {
      await this.registerSlashCommands(clientId);
    }
  }

  /** Register a handler for modal submit interactions. */
  onModalSubmit(handler: ModalSubmitHandler): void {
    this.modalHandlers.push(handler);
  }

  /** Register a handler for string select menu interactions. */
  onSelectMenu(handler: SelectMenuHandler): void {
    this.selectMenuHandlers.push(handler);
  }

  /** Register a handler for button interactions. */
  onButton(handler: ButtonHandler): void {
    this.buttonHandlers.push(handler);
  }

  onRoomClosed(handler: RoomClosedHandler): void {
    this.roomClosedHandlers.push(handler);
  }

  /** Register slash commands with Discord API per guild (instant update). */
  private async registerSlashCommands(clientId: string): Promise<void> {
    const rest = new REST({ version: '10' }).setToken(this.token);
    // Deduplicate by command name (last wins) to avoid accidental duplicates
    const deduped = new Map<string, { name: string; description: string }>();
    for (const cmd of this.nativeCommands) {
      deduped.set(cmd.name, { name: cmd.name, description: cmd.description });
    }
    const body = Array.from(deduped.values());

    const MAX_SLASH_COMMANDS = 25;
    const registerBody = body.length > MAX_SLASH_COMMANDS
      ? body.slice(0, MAX_SLASH_COMMANDS)
      : body;

    if (body.length > MAX_SLASH_COMMANDS) {
      console.warn(`[discord] Slash command limit is ${MAX_SLASH_COMMANDS}; truncating ${body.length} -> ${registerBody.length}`);
    }

    if (this.guilds && this.guilds.size > 0) {
      // Register per-guild for instant updates
      for (const guildId of this.guilds) {
        try {
          await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: registerBody });
          console.log(`[discord] ✦ Registered ${registerBody.length} slash commands for guild ${guildId}`);
        } catch (err) {
          console.error(`[discord] Failed to register commands for guild ${guildId}:`, err instanceof Error ? err.message : err);
        }
      }

      // Keep global commands in sync so DMs also get slash commands
      // (global propagation can take longer than guild commands)
      try {
        await rest.put(Routes.applicationCommands(clientId), { body: registerBody });
        console.log(`[discord] ✦ Synced ${registerBody.length} global slash commands for DM support`);
      } catch (err) {
        console.warn('[discord] Could not sync global slash commands:', err instanceof Error ? err.message : err);
      }
    } else {
      // No guild whitelist — discover guilds from cache and register per-guild
      const client = this.client;
      if (client) {
        const guilds = client.guilds.cache;
        if (guilds.size > 0) {
          for (const [guildId] of guilds) {
            try {
              await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: registerBody });
              console.log(`[discord] ✦ Registered ${registerBody.length} slash commands for guild ${guildId}`);
            } catch (err) {
              console.error(`[discord] Failed to register commands for guild ${guildId}:`, err instanceof Error ? err.message : err);
            }
          }

          // Keep global commands in sync so DMs also get slash commands
          // (global propagation can take longer than guild commands)
          try {
            await rest.put(Routes.applicationCommands(clientId), { body: registerBody });
            console.log(`[discord] ✦ Synced ${registerBody.length} global slash commands for DM support`);
          } catch (err) {
            console.warn('[discord] Could not sync global slash commands:', err instanceof Error ? err.message : err);
          }
        } else {
          // Fallback: register globally (takes up to 1 hour to propagate)
          try {
            await rest.put(Routes.applicationCommands(clientId), { body: registerBody });
            console.log(`[discord] ✦ Registered ${registerBody.length} slash commands globally`);
          } catch (err) {
            console.error('[discord] Failed to register global commands:', err instanceof Error ? err.message : err);
          }
        }
      }
    }
  }

  /** Archive a Discord thread by ID. */
  async archiveThread(threadId: string): Promise<void> {
    if (!this.client) return;

    try {
      const channel = await this.client.channels.fetch(threadId);
      if (channel?.isThread()) {
        await channel.setArchived(true);
      }
    } catch (err) {
      console.error('[discord] archiveThread error:', err instanceof Error ? err.message : err);
    }
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[discord] Max reconnection attempts reached — scheduling final retry in 5 minutes');
      setTimeout(async () => {
        try {
          if (this.client) {
            this.reconnectAttempts = 0;
            await this.client.login(this.token);
            console.log('[discord] Final retry succeeded');
          }
        } catch (err) {
          console.error('[discord] Final reconnection failed:', err instanceof Error ? err.message : err);
          console.error('[discord] CRITICAL: Discord channel is offline. Process will continue for other channels.');
        }
      }, 5 * 60 * 1000);
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    console.log(`[discord] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    setTimeout(async () => {
      try {
        if (this.client) {
          await this.client.login(this.token);
        }
      } catch (err) {
        console.error('[discord] Reconnection failed:', err instanceof Error ? err.message : err);
        this.attemptReconnect();
      }
    }, delay);
  }
}
