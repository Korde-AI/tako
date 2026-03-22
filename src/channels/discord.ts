/**
 * Discord channel adapter facade.
 *
 * Transport, inspection, room management, and interaction wiring live in
 * dedicated modules. This class holds runtime state and exposes the channel API.
 */

import type { Client } from 'discord.js';
import type { Channel, MessageHandler, OutboundMessage } from './channel.js';
import {
  type DiscordInteractionState,
  type ButtonHandler,
  type DiscordChannelOpts,
  type DiscordRecentMessage,
  type DiscordRoomInspection,
  type InteractiveCommandHandler,
  type ModalSubmitHandler,
  type RoomClosedHandler,
  type RoomParticipantHandler,
  type SelectMenuHandler,
  type SlashCommandHandler,
} from './discord-types.js';
import {
  addDiscordReaction,
  connectDiscordTransport,
  createDiscordClient,
  disconnectDiscordTransport,
  editDiscordMessage,
  removeDiscordReaction,
  sendDiscordMessage,
  sendDiscordMessageAndGetId,
  sendDiscordTyping,
  splitDiscordMessage,
} from './discord-transport.js';
import {
  createDiscordThread,
  createDiscordChannel,
  deleteDiscordChannel,
  editDiscordChannel,
  broadcastDiscordText,
  grantDiscordChannelAccess,
  archiveDiscordThread,
} from './discord-room-management.js';
import { fetchRecentDiscordMessages, inspectDiscordRoom } from './discord-inspection.js';
import {
  registerDiscordSkillCommands,
  registerDiscordSlashCommands,
} from './discord-slash-commands.js';
import {
  sendDiscordPatchApprovalRequest,
  sendDiscordPeerTaskApprovalRequest,
} from './discord-approval-delivery.js';
import type { SkillCommandSpec } from '../commands/skill-commands.js';

export {
  type DiscordChannelOpts,
  type DiscordRoomInspection,
  type DiscordRecentMessage,
  type SlashCommandHandler,
  type InteractiveCommandHandler,
  type ModalSubmitHandler,
  type SelectMenuHandler,
  type ButtonHandler,
  type RoomClosedHandler,
  type RoomParticipantHandler,
} from './discord-types.js';

export class DiscordChannel implements Channel {
  id = 'discord';
  agentId?: string;
  private token: string;
  private guilds?: Set<string>;
  private allowUnmentionedChannels?: Set<string>;
  private client: Client | null = null;
  private handlers: MessageHandler[] = [];
  private interactionState: DiscordInteractionState = {
    slashCommandHandler: null,
    interactiveHandlers: new Map<string, InteractiveCommandHandler>(),
    modalHandlers: [],
    selectMenuHandlers: [],
    buttonHandlers: [],
    nativeCommands: [],
    previousSkillNames: undefined,
  };
  private roomClosedHandlers: RoomClosedHandler[] = [];
  private roomParticipantHandlers: RoomParticipantHandler[] = [];
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
    this.client = createDiscordClient({
      token: this.token,
      guilds: this.guilds ? [...this.guilds] : undefined,
      allowUnmentionedChannels: this.allowUnmentionedChannels ? [...this.allowUnmentionedChannels] : undefined,
    });
    await connectDiscordTransport(this.client, {
      token: this.token,
      guilds: this.guilds,
      allowUnmentionedChannels: this.allowUnmentionedChannels,
      handlers: this.handlers,
      roomClosedHandlers: this.roomClosedHandlers,
      roomParticipantHandlers: this.roomParticipantHandlers,
      interactionState: this.interactionState,
      agentId: this.agentId,
      reconnectAttempts: this.reconnectAttempts,
      maxReconnectAttempts: this.maxReconnectAttempts,
      reconnectDelay: this.reconnectDelay,
    }, async (clientId) => {
      await this.registerSlashCommands(clientId);
    }, () => {
      this.attemptReconnect();
    });
  }

  async disconnect(): Promise<void> {
    await disconnectDiscordTransport(this.client);
    this.client = null;
  }

  async send(msg: OutboundMessage): Promise<void> {
    await sendDiscordMessage(this.client, msg);
  }

  async sendAndGetId(msg: OutboundMessage): Promise<string> {
    return sendDiscordMessageAndGetId(this.client, msg);
  }

  async editMessage(chatId: string, messageId: string, content: string): Promise<void> {
    await editDiscordMessage(this.client, chatId, messageId, content);
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  getClient(): Client | null {
    return this.client;
  }

  async createChannel(
    guildId: string,
    name: string,
    opts?: { topic?: string; parentId?: string; privateUserId?: string },
  ): Promise<{ id: string; name: string }> {
    return createDiscordChannel(this.client, guildId, name, opts);
  }

  async broadcast(text: string): Promise<void> {
    await broadcastDiscordText(this.client, this.guilds, text);
  }

  async deleteChannel(channelId: string): Promise<void> {
    await deleteDiscordChannel(this.client, channelId);
  }

  async editChannel(channelId: string, opts: { name?: string; topic?: string }): Promise<void> {
    await editDiscordChannel(this.client, channelId, opts);
  }

  async grantChannelAccess(channelId: string, userId: string): Promise<void> {
    await grantDiscordChannelAccess(this.client, channelId, userId);
  }

  async inspectRoom(channelId: string): Promise<DiscordRoomInspection> {
    return inspectDiscordRoom(this.client, channelId);
  }

  async fetchRecentMessages(channelId: string, limit = 20): Promise<DiscordRecentMessage[]> {
    return fetchRecentDiscordMessages(this.client, channelId, limit);
  }

  async sendToChannel(channelId: string, content: string): Promise<string> {
    if (!this.client) throw new Error('[discord] Not connected');
    const channel = await this.client.channels.fetch(channelId);
    if (!channel || !channel.isTextBased()) {
      throw new Error(`[discord] Cannot send to channel ${channelId}`);
    }
    const sendable = channel as { send: (opts: Record<string, unknown>) => Promise<{ id: string }> };
    const chunks = splitDiscordMessage(content);
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
    return sendDiscordPatchApprovalRequest(this.client, input);
  }

  async sendPeerTaskApprovalRequest(input: {
    channelId: string;
    approvalId: string;
    agentId: string;
    requesterName?: string;
    requesterIsBot?: boolean;
    toolName: string;
    toolArgsPreview?: string;
    ownerMentions?: string[];
    projectSlug?: string;
  }): Promise<string> {
    return sendDiscordPeerTaskApprovalRequest(this.client, input);
  }

  async createThread(
    channelId: string,
    name: string,
    opts?: { messageId?: string },
  ): Promise<{ id: string; name: string }> {
    return createDiscordThread(this.client, channelId, name, opts);
  }

  async react(channelId: string, messageId: string, emoji: string): Promise<void> {
    await addDiscordReaction(this.client, channelId, messageId, emoji);
  }

  async sendTyping(channelId: string): Promise<void> {
    await sendDiscordTyping(this.client, channelId);
  }

  async addReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    await addDiscordReaction(this.client, channelId, messageId, emoji);
  }

  async removeReaction(channelId: string, messageId: string, emoji: string): Promise<void> {
    await removeDiscordReaction(this.client, channelId, messageId, emoji);
  }

  setSlashCommands(commands: Array<{ name: string; description: string }>, handler: SlashCommandHandler): void {
    this.interactionState.nativeCommands = commands;
    this.interactionState.slashCommandHandler = handler;
  }

  setInteractiveHandler(commandName: string, handler: InteractiveCommandHandler): void {
    this.interactionState.interactiveHandlers.set(commandName, handler);
  }

  async registerSkillCommands(specs: SkillCommandSpec[], handler: SlashCommandHandler): Promise<void> {
    await registerDiscordSkillCommands(this.interactionState, this.client, specs, handler, async (clientId) => {
      await this.registerSlashCommands(clientId);
    });
  }

  onModalSubmit(handler: ModalSubmitHandler): void {
    this.interactionState.modalHandlers.push(handler);
  }

  onSelectMenu(handler: SelectMenuHandler): void {
    this.interactionState.selectMenuHandlers.push(handler);
  }

  onButton(handler: ButtonHandler): void {
    this.interactionState.buttonHandlers.push(handler);
  }

  onRoomClosed(handler: RoomClosedHandler): void {
    this.roomClosedHandlers.push(handler);
  }

  onRoomParticipant(handler: RoomParticipantHandler): void {
    this.roomParticipantHandlers.push(handler);
  }

  private async registerSlashCommands(clientId: string): Promise<void> {
    await registerDiscordSlashCommands(this.client, this.token, this.guilds, this.interactionState.nativeCommands, clientId);
  }

  async archiveThread(threadId: string): Promise<void> {
    await archiveDiscordThread(this.client, threadId);
  }

  private attemptReconnect(): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[discord] Max reconnection attempts reached - scheduling final retry in 5 minutes');
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
