import type { Channel } from './channel.js';
import type { ChannelPlatform, ChannelPlatformRegistry } from './platforms.js';
import { DiscordChannel, type ButtonHandler, type InteractiveCommandHandler, type ModalSubmitHandler, type SelectMenuHandler, type SlashCommandHandler } from './discord.js';
import { TelegramChannel, type TelegramCommandHandler } from './telegram.js';
import { wireAgentDiscordRuntime, wireMainDiscordRuntime } from './discord-runtime.js';
import { wireTelegramRuntime } from './telegram-runtime.js';
import { createDiscordProjectCoordinator } from './discord-project-coordinator.js';
import { createDiscordDeliveryAdapter } from './discord-delivery-adapter.js';
import type { ChannelDeliveryRegistry } from '../core/channel-delivery.js';
import type { ChannelSetupController } from '../commands/channel-setup.js';
import type { ProjectChannelCoordinatorRegistry } from '../projects/channel-coordination.js';
import type { RoomClosedInput, RoomParticipantInput } from '../projects/room-lifecycle.js';

interface MainDiscordRuntimeHandlers {
  slashHandler: SlashCommandHandler;
  modelHandler: InteractiveCommandHandler;
}

interface AgentDescriptorLike {
  id: string;
  isMain: boolean;
  bindings: Record<string, any>;
}

interface AgentRegistryLike {
  list(): AgentDescriptorLike[];
  loadChannelConfig(agentId: string): Promise<Record<string, unknown> | null>;
}

interface ChannelRuntimeLifecycle {
  handleClosedRoom(input: RoomClosedInput): Promise<void>;
  handleRoomParticipant(input: RoomParticipantInput): Promise<void>;
}

interface RuntimeChannelsConfig {
  channels: {
    discord?: {
      token?: string;
      guilds?: string[];
    };
    telegram?: {
      token?: string;
      allowedUsers?: string[];
    };
  };
}

export interface ComposeChannelRuntimesInput {
  config: RuntimeChannelsConfig;
  agentRegistry: AgentRegistryLike;
  nativeCommandList: Array<{ name: string; description: string }>;
  mainDiscordHandlers?: MainDiscordRuntimeHandlers;
  createAgentDiscordSlashHandler: (input: {
    agentId: string;
    channel: DiscordChannel;
  }) => SlashCommandHandler;
  createTelegramCommandHandler: (input: {
    agentId: string;
    channel: TelegramChannel;
  }) => TelegramCommandHandler;
  projectRoomLifecycle: ChannelRuntimeLifecycle;
  projectChannelCoordinators: ProjectChannelCoordinatorRegistry;
  channelDeliveryRegistry: ChannelDeliveryRegistry;
  registerChannel: (channel: Channel) => void;
  channelSetupController?: ChannelSetupController;
  approvalButtonHandler?: ButtonHandler;
  platformRegistry?: ChannelPlatformRegistry;
}

export interface ComposeChannelRuntimesResult {
  discordChannel?: DiscordChannel;
  telegramChannel?: TelegramChannel;
  discordChannels: DiscordChannel[];
}

export async function composeChannelRuntimes(
  input: ComposeChannelRuntimesInput,
): Promise<ComposeChannelRuntimesResult> {
  let discordChannel: DiscordChannel | undefined;
  let telegramChannel: TelegramChannel | undefined;
  const discordChannels: DiscordChannel[] = [];

  const registerRuntimeChannel = (channel: Channel): void => {
    input.platformRegistry?.register({
      id: channel.id,
      displayName: channel.id,
      supportsProjectBindings: true,
    });
    input.registerChannel(channel);
  };

  const toRoomClosedInput = (platform: ChannelPlatform, event: {
    channelId: string;
    kind: 'channel' | 'thread';
    reason: 'deleted' | 'archived';
  }, agentId?: string): RoomClosedInput => ({
    platform,
    agentId,
    channelId: event.channelId,
    kind: event.kind,
    reason: event.reason,
  });

  const toRoomParticipantInput = (platform: ChannelPlatform, event: {
    channelId: string;
    guildId?: string;
    parentChannelId?: string;
    kind: 'channel' | 'thread';
    userIds: string[];
    reason: 'channel_access_granted' | 'thread_member_added';
  }, agentId?: string): RoomParticipantInput => ({
    platform,
    agentId,
    channelId: event.channelId,
    threadId: event.kind === 'thread' ? event.channelId : undefined,
    kind: event.kind,
    participantIds: event.userIds,
    reason: event.reason,
    metadata: {
      ...(event.guildId ? { guildId: event.guildId } : {}),
      ...(event.parentChannelId ? { parentChannelId: event.parentChannelId } : {}),
    },
  });

  if (input.config.channels.discord?.token) {
    discordChannel = new DiscordChannel({
      token: input.config.channels.discord.token,
      guilds: input.config.channels.discord.guilds,
    });

    const selectMenuHandler: SelectMenuHandler = async (interaction) =>
      input.channelSetupController
        ? input.channelSetupController.handleAgentSelect(interaction)
        : false;

    const buttonHandler: ButtonHandler = async (interaction) => {
      if (input.channelSetupController && await input.channelSetupController.handleButton(interaction)) {
        return true;
      }
      return input.approvalButtonHandler ? input.approvalButtonHandler(interaction) : false;
    };

    const modalSubmitHandler: ModalSubmitHandler = async (interaction) =>
      input.channelSetupController
        ? input.channelSetupController.handleModalSubmit(interaction)
        : false;

    const setupHandler: InteractiveCommandHandler = async (interaction) => {
      if (!input.channelSetupController) return false;
      await input.channelSetupController.handleSetupCommand(interaction);
      return true;
    };

    if (input.mainDiscordHandlers) {
      wireMainDiscordRuntime({
        channel: discordChannel,
        nativeCommandList: input.nativeCommandList,
        slashHandler: input.mainDiscordHandlers.slashHandler,
        modelHandler: input.mainDiscordHandlers.modelHandler,
        setupHandler,
        roomClosedHandler: async (event) => {
          await input.projectRoomLifecycle.handleClosedRoom(toRoomClosedInput('discord', event));
        },
        roomParticipantHandler: async (event) => {
          await input.projectRoomLifecycle.handleRoomParticipant(toRoomParticipantInput('discord', event, discordChannel?.agentId));
        },
        selectMenuHandler,
        buttonHandler,
        modalSubmitHandler,
      });
    }

    discordChannels.push(discordChannel);
    registerRuntimeChannel(discordChannel);
  }

  if (input.config.channels.telegram?.token) {
    telegramChannel = new TelegramChannel({
      token: input.config.channels.telegram.token,
      allowedUsers: input.config.channels.telegram.allowedUsers,
    });

    wireTelegramRuntime({
      channel: telegramChannel,
      nativeCommandList: input.nativeCommandList,
      commandHandler: input.createTelegramCommandHandler({
        agentId: 'main',
        channel: telegramChannel,
      }),
    });

    registerRuntimeChannel(telegramChannel);
  }

  for (const agent of input.agentRegistry.list()) {
    if (agent.isMain) continue;
    const channelConfig = await input.agentRegistry.loadChannelConfig(agent.id);
    if (!channelConfig) continue;

    const discord = channelConfig.discord as Record<string, unknown> | undefined;
    if (discord?.enabled && discord?.token) {
      const agentDiscord = new DiscordChannel({
        token: discord.token as string,
        guilds: discord.guilds as string[] | undefined,
        allowUnmentionedChannels: agent.bindings.discord?.channels,
      });
      agentDiscord.agentId = agent.id;

      wireAgentDiscordRuntime({
        channel: agentDiscord,
        nativeCommandList: input.nativeCommandList,
        slashHandler: input.createAgentDiscordSlashHandler({
          agentId: agent.id,
          channel: agentDiscord,
        }),
        roomClosedHandler: async (event) => {
          await input.projectRoomLifecycle.handleClosedRoom(toRoomClosedInput('discord', event, agent.id));
        },
        roomParticipantHandler: async (event) => {
          await input.projectRoomLifecycle.handleRoomParticipant(toRoomParticipantInput('discord', event, agent.id));
        },
      });

      discordChannels.push(agentDiscord);
      registerRuntimeChannel(agentDiscord);
      console.log(`[tako] Agent "${agent.id}" Discord channel configured`);
    }

    const telegram = channelConfig.telegram as Record<string, unknown> | undefined;
    if (telegram?.enabled && telegram?.token) {
      const agentTelegram = new TelegramChannel({
        token: telegram.token as string,
        allowedUsers: telegram.allowedUsers as string[] | undefined,
      });
      agentTelegram.agentId = agent.id;

      wireTelegramRuntime({
        channel: agentTelegram,
        nativeCommandList: input.nativeCommandList,
        commandHandler: input.createTelegramCommandHandler({
          agentId: agent.id,
          channel: agentTelegram,
        }),
      });

      registerRuntimeChannel(agentTelegram);
      console.log(`[tako] Agent "${agent.id}" Telegram channel configured`);
    }
  }

  if (discordChannel || discordChannels.length > 0) {
    input.projectChannelCoordinators.register(createDiscordProjectCoordinator({
      channels: discordChannels,
      fallback: discordChannel ?? null,
    }));
    input.channelDeliveryRegistry.register(createDiscordDeliveryAdapter({
      channels: discordChannels,
      fallback: discordChannel ?? null,
    }));
  }

  return {
    discordChannel,
    telegramChannel,
    discordChannels,
  };
}
