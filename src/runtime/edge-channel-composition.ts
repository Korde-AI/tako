import { CLIChannel } from '../channels/cli.js';
import { TUIChannel } from '../channels/tui.js';
import { composeChannelRuntimes } from '../channels/runtime-composition.js';
import { createBuiltinChannelSetupAdapters } from '../channels/setup-adapters.js';
import { createTelegramCommandHandler } from '../channels/telegram-runtime.js';
import type { Channel } from '../channels/channel.js';
import type { ChannelPlatformRegistry } from '../channels/platforms.js';
import type { DiscordChannel } from '../channels/discord.js';
import type { TelegramChannel } from '../channels/telegram.js';
import { AnthropicProvider } from '../providers/anthropic.js';
import { OpenAIProvider } from '../providers/openai.js';
import { showModelPicker } from '../commands/model-picker.js';
import { createChannelSetupController } from '../commands/channel-setup.js';
import { getProjectRole, isProjectMember } from '../projects/access.js';
import type { ProjectMembershipRegistry } from '../projects/memberships.js';
import { resolveAgentForChannel } from '../agents/config.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { PrincipalRegistry } from '../principals/registry.js';
import type { SessionManager } from '../gateway/session.js';
import type { PromptBuilder } from '../core/prompt.js';
import { toCommandContext, toSessionMetadata } from '../core/execution-context.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { CommandRegistry } from '../commands/registry.js';
import type { ButtonHandler, InteractiveCommandHandler, SlashCommandHandler } from '../channels/discord.js';
import type { ProjectChannelCoordinatorRegistry } from '../projects/channel-coordination.js';
import type { ChannelDeliveryRegistry } from '../core/channel-delivery.js';
import type { SkillLoader } from '../skills/loader.js';
import { loadSkillRuntimeExtensions } from '../skills/runtime-extensions.js';
import type { TakoConfig } from '../config/schema.js';
import type { ProjectRuntime } from './project-runtime-types.js';
import type { EdgeSessionRuntime } from './edge-session-runtime.js';
import { Gateway } from '../gateway/gateway.js';
import type { Provider } from '../providers/provider.js';
import type { AgentLoop } from '../core/agent-loop.js';
import type { HookSystem } from '../hooks/types.js';

interface EdgeChannelCompositionInput {
  config: TakoConfig;
  version: string;
  startTime: number;
  toolRegistry: ToolRegistry;
  embeddingProvider: unknown;
  agentRegistry: AgentRegistry;
  commandRegistry: CommandRegistry;
  principalRegistry: PrincipalRegistry;
  sessions: SessionManager;
  projectMemberships: ProjectMembershipRegistry;
  projectRuntime: Pick<ProjectRuntime, 'resolveProject' | 'buildAgentAccessMetadata' | 'isDiscordInvocationAllowed' | 'autoEnrollProjectRoomParticipant'>;
  sessionRuntime: Pick<EdgeSessionRuntime, 'buildInboundExecutionContext' | 'ensureSharedSession' | 'applyExecutionContextToSession'>;
  hooks: HookSystem;
  promptBuilder: PromptBuilder;
  skillLoader: SkillLoader;
  skillManifests: Array<{ name: string; description?: string }>;
  channelPlatforms: ChannelPlatformRegistry;
  projectRoomLifecycle: {
    handleClosedRoom(input: {
      platform: string;
      agentId?: string;
      channelId: string;
      kind: 'channel' | 'thread';
      reason: 'deleted' | 'archived';
    }): Promise<void>;
    handleRoomParticipant(input: {
      platform: string;
      agentId?: string;
      channelId: string;
      threadId?: string;
      kind: 'channel' | 'thread';
      participantIds: string[];
      reason: 'channel_access_granted' | 'thread_member_added';
      metadata?: Record<string, unknown>;
    }): Promise<void>;
  };
  projectChannelCoordinators: ProjectChannelCoordinatorRegistry;
  channelDeliveryRegistry: ChannelDeliveryRegistry;
  approvalButtonHandler?: ButtonHandler;
  wireChannel(channel: Channel): void;
  getAgentLoop(agentId?: string): AgentLoop;
  provider: Provider;
  defaultModel: string;
}

export interface EdgeChannelCompositionResult {
  channels: Channel[];
  discordChannel?: DiscordChannel;
  telegramChannel?: TelegramChannel;
  discordChannels: DiscordChannel[];
  useTui: boolean;
}

export async function composeEdgeRuntimeChannels(input: EdgeChannelCompositionInput): Promise<EdgeChannelCompositionResult> {
  const channels: Channel[] = [];
  const discordChannels: DiscordChannel[] = [];
  let discordChannel: DiscordChannel | undefined;
  let telegramChannel: TelegramChannel | undefined;
  const useTui = process.argv.includes('--tui') && process.stdout.isTTY;

  const handleSlashCommand = async (
    commandName: string,
    channelId: string,
    author: { id: string; name: string; meta?: Record<string, unknown> },
    agentId: string,
    boundChannel: Channel,
    guildId?: string,
  ): Promise<string | null> => {
    const principal = await input.principalRegistry.getOrCreateHuman({
      displayName: author.name,
      platform: 'discord',
      platformUserId: author.id,
      metadata: { channelId: `discord:${channelId}` },
    });
    const resolvedProject = input.projectRuntime.resolveProject({
      platform: 'discord',
      channelTarget: channelId,
      agentId,
    });
    const discordPolicy = await input.projectRuntime.isDiscordInvocationAllowed({
      agentId,
      authorId: author.id,
      authorName: author.name,
      username: typeof author.meta?.username === 'string' ? author.meta.username : undefined,
      principalId: principal.principalId,
      channelName: typeof author.meta?.channelName === 'string' ? author.meta.channelName : undefined,
      project: resolvedProject?.project ?? null,
    });
    if (!discordPolicy.allowed) {
      console.log(
        `[discord-auth] blocked slash command agent=${agentId} user=${author.id} principal=${principal.principalId} ` +
        `channel=${channelId} name=${String(author.meta?.channelName ?? '')} reason=${discordPolicy.reason}`,
      );
      return null;
    }
    const projectRole = resolvedProject
      ? getProjectRole(input.projectMemberships, resolvedProject.project.projectId, principal.principalId) ?? undefined
      : undefined;
    const accessMetadata = await input.projectRuntime.buildAgentAccessMetadata({
      platform: 'discord',
      agentId,
      authorId: author.id,
      principalId: principal.principalId,
      project: resolvedProject?.project ?? null,
      metadata: guildId ? { guildId } : undefined,
    });
    const channelKey = `discord:${channelId}`;
    const sessionKey = `agent:${agentId}:${channelKey}`;
    const session = input.sessions.getOrCreate(sessionKey, {
      name: `${agentId}/${channelKey}/${author.name}`,
      metadata: toSessionMetadata(input.sessionRuntime.buildInboundExecutionContext({
        agentId,
        principal,
        authorId: author.id,
        authorName: author.name,
        platform: 'discord',
        channelId: channelKey,
        channelTarget: channelId,
        project: resolvedProject?.project ?? null,
        projectRole: projectRole ?? null,
        metadata: accessMetadata,
      })),
    });
    let executionContext = input.sessionRuntime.buildInboundExecutionContext({
      agentId,
      sessionId: session.id,
      principal,
      authorId: author.id,
      authorName: author.name,
      platform: 'discord',
      channelId: channelKey,
      channelTarget: channelId,
      project: resolvedProject?.project ?? null,
      projectRole: projectRole ?? null,
      metadata: accessMetadata,
    });
    const shared = await input.sessionRuntime.ensureSharedSession({ session, ctx: executionContext });
    if (shared) {
      executionContext = {
        ...executionContext,
        sharedSessionId: shared.sharedSessionId,
        ownerPrincipalId: shared.ownerPrincipalId,
        participantIds: shared.participantIds,
        activeParticipantIds: shared.activeParticipantIds,
      };
    }
    input.sessionRuntime.applyExecutionContextToSession(session, executionContext, boundChannel);

    if (resolvedProject && !isProjectMember(input.projectMemberships, resolvedProject.project.projectId, principal.principalId)) {
      const enrolled = await input.projectRuntime.autoEnrollProjectRoomParticipant({
        project: resolvedProject.project,
        principalId: principal.principalId,
        principalName: principal.displayName,
        platformUserId: author.id,
        platform: 'discord',
        addedBy: resolvedProject.project.ownerPrincipalId,
      });
      if (!enrolled) {
        return 'You are not a member of this project.';
      }
    }

    const cmdResult = await input.commandRegistry.handle('/' + commandName, {
      ...toCommandContext(executionContext),
      session,
    });
    return cmdResult !== null ? cmdResult : null;
  };

  const nativeCommandList = [
    ...input.commandRegistry.list(),
    { name: 'setup', description: 'Configure agent channels (Discord/Telegram)' },
  ];

  const mainDiscordSlashHandler: SlashCommandHandler = async (commandName, channelId, author, guildId) => {
    const agentId = resolveAgentForChannel(input.agentRegistry.list(), 'discord', channelId);
    return handleSlashCommand(commandName, channelId, author, agentId, discordChannel!, guildId);
  };

  const mainDiscordModelHandler: InteractiveCommandHandler = async (interaction) => {
    const providerModelsMap: Record<string, string[]> = {};
    const anthropicProvider = new AnthropicProvider(
      input.config.providers.anthropic?.setupToken ?? input.config.providers.anthropic?.apiKey,
      undefined,
      input.config.providers.anthropic?.baseUrl,
    );
    providerModelsMap['anthropic'] = anthropicProvider.models().map((m) => m.id);

    const openaiProvider = new OpenAIProvider();
    providerModelsMap['openai'] = openaiProvider.models().map((m) => m.id);

    if (input.config.providers.litellm?.baseUrl) {
      const litellmModels = input.config.providers.litellm.models ?? [];
      if (litellmModels.length > 0) {
        providerModelsMap['litellm'] = litellmModels;
      } else if (input.provider.id === 'litellm') {
        providerModelsMap['litellm'] = input.provider.models().map((m) => m.id);
      }
    }

    const providers = Object.keys(providerModelsMap);
    if (providers.length === 0) return false;

    const mainLoop = input.getAgentLoop();
    await showModelPicker(interaction, {
      getModel: () => mainLoop.getModel(),
      setModel: (ref: string) => {
        mainLoop.setModel(ref);
        input.config.providers.primary = ref;
        import('../config/resolve.js').then((m) => m.patchConfig({ providers: { primary: ref } })).catch(() => {});
      },
      getDefaultModel: () => input.defaultModel,
      getProviders: () => providers,
      getModelsForProvider: (providerName: string) => providerModelsMap[providerName] ?? [],
    });

    return true;
  };

  const channelSetupController = createChannelSetupController({
    deps: {
      listAgents: () => input.agentRegistry.list().map((agent) => ({ id: agent.id, description: agent.description })),
      saveChannelConfig: (agentId: string, channelType: string, cfg: Record<string, unknown>) =>
        input.agentRegistry.saveChannelConfig(agentId, channelType, cfg),
    },
    adapters: createBuiltinChannelSetupAdapters(input.channelPlatforms),
  });

  const availableModels = [input.config.providers.primary];
  if (input.config.providers.fallback) {
    for (const fallback of input.config.providers.fallback) {
      if (!availableModels.includes(fallback)) availableModels.push(fallback);
    }
  }
  if (input.config.providers.litellm?.models) {
    for (const model of input.config.providers.litellm.models) {
      const ref = `litellm/${model}`;
      if (!availableModels.includes(ref)) availableModels.push(ref);
    }
  }
  for (const model of input.provider.models()) {
    const ref = `${model.provider}/${model.id}`;
    if (!availableModels.includes(ref)) availableModels.push(ref);
  }

  if (useTui) {
    const mainLoop = input.getAgentLoop();
    const tui = new TUIChannel({
      version: input.version,
      model: input.config.providers.primary,
      toolCount: input.toolRegistry.getAllTools().length,
      skillCount: input.skillManifests.length,
      toolProfile: input.config.tools.profile,
      memoryStatus: input.embeddingProvider ? 'hybrid' : 'BM25-only',
      availableModels,
      agents: input.agentRegistry.list().map((agent: any) => ({
        id: agent.id,
        description: agent.description,
        role: agent.role,
        isMain: agent.isMain,
      })),
      onModelSwitch: (modelRef: string) => {
        mainLoop.setModel(modelRef);
        input.config.providers.primary = modelRef;
      },
      onAgentSwitch: (agentId: string) => {
        const agent = input.agentRegistry.get(agentId);
        if (!agent) return;
        input.promptBuilder.setWorkspace(agent.workspace);
        if (agent.model && agent.model !== mainLoop.getModel()) {
          mainLoop.setModel(agent.model);
        }
        if (agent.workspace) {
          input.promptBuilder.setWorkingDir(agent.workspace);
        }
        console.log(`[tako] Switched to agent: ${agentId} (role=${agent.role}, workspace=${agent.workspace})`);
      },
    });
    channels.push(tui);
    input.wireChannel(tui);

    input.hooks.on('before_tool_call', (event: any) => {
      const tuiBridge = (globalThis as any).__takoTui;
      if (tuiBridge) {
        tuiBridge.addMessage({
          id: crypto.randomUUID(),
          role: 'tool',
          content: 'Running...',
          toolName: event.data.toolName,
          timestamp: new Date().toISOString(),
        });
      }
    });

    input.hooks.on('after_tool_call', (event: any) => {
      const tuiBridge = (globalThis as any).__takoTui;
      if (tuiBridge) {
        const result = event.data.result;
        const output = result.output?.slice(0, 200) ?? '';
        const icon = result.success ? '[✓]' : '[✗]';
        tuiBridge.addMessage({
          id: crypto.randomUUID(),
          role: 'tool',
          content: `${icon} ${output}${output.length >= 200 ? '...' : ''}`,
          toolName: event.data.toolName,
          timestamp: new Date().toISOString(),
        });
      }
    });
  } else {
    const cli = new CLIChannel(input.config.channels.cli);
    channels.push(cli);
    input.wireChannel(cli);
  }

  const composedChannels = await composeChannelRuntimes({
    config: input.config,
    agentRegistry: input.agentRegistry,
    nativeCommandList,
    mainDiscordHandlers: input.config.channels.discord?.token ? {
      slashHandler: mainDiscordSlashHandler,
      modelHandler: mainDiscordModelHandler,
    } : undefined,
    createAgentDiscordSlashHandler: ({ agentId, channel }) =>
      async (commandName, channelId, author, guildId) =>
        handleSlashCommand(commandName, channelId, author, agentId, channel, guildId),
    createTelegramCommandHandler: ({ agentId, channel }) => createTelegramCommandHandler({
      agentId,
      channel,
      deps: {
        principalRegistry: input.principalRegistry as never,
        sessions: input.sessions,
        commandRegistry: input.commandRegistry as never,
        resolveProject: input.projectRuntime.resolveProject,
        getProjectRole: (projectId, principalId) => getProjectRole(input.projectMemberships, projectId, principalId),
        buildAgentAccessMetadata: input.projectRuntime.buildAgentAccessMetadata,
        buildInboundExecutionContext: input.sessionRuntime.buildInboundExecutionContext,
        toSessionMetadata,
        ensureSharedSession: input.sessionRuntime.ensureSharedSession,
        applyExecutionContextToSession: input.sessionRuntime.applyExecutionContextToSession,
        toCommandContext,
        isProjectMember: (projectId, principalId) => isProjectMember(input.projectMemberships, projectId, principalId),
      },
    }),
    projectRoomLifecycle: input.projectRoomLifecycle,
    projectChannelCoordinators: input.projectChannelCoordinators,
    channelDeliveryRegistry: input.channelDeliveryRegistry,
    registerChannel: (channel) => {
      channels.push(channel);
      input.wireChannel(channel);
    },
    channelSetupController,
    approvalButtonHandler: input.approvalButtonHandler,
    platformRegistry: input.channelPlatforms,
  });
  discordChannel = composedChannels.discordChannel;
  telegramChannel = composedChannels.telegramChannel;
  discordChannels.push(...composedChannels.discordChannels.filter((channel) => !discordChannels.includes(channel)));

  const loadedSkills = input.skillLoader.getAll();
  await loadSkillRuntimeExtensions({
    loadedSkills,
    skillChannelsConfig: input.config.skillChannels,
    skillExtensionsConfig: input.config.skillExtensions,
    registerChannel: (channel, source) => {
      input.channelPlatforms.register({
        id: channel.id,
        displayName: source,
      });
      channels.push(channel);
      input.wireChannel(channel);
      console.log(`[tako] Loaded ${source}: ${channel.id}`);
    },
  });

  return {
    channels,
    discordChannel,
    telegramChannel,
    discordChannels,
    useTui,
  };
}

export function createEdgeGateway(input: {
  config: TakoConfig;
  sessions: SessionManager;
  agentLoop: AgentLoop;
  hooks: HookSystem;
  sandboxManager: { shutdown(): Promise<void> };
  retryQueue: unknown;
  contextManager: unknown;
  provider: Provider;
}): Gateway {
  return new Gateway(input.config.gateway, {
    sessions: input.sessions,
    agentLoop: input.agentLoop,
    hooks: input.hooks,
    sandboxManager: input.sandboxManager as never,
    retryQueue: input.retryQueue as never,
    sessionConfig: input.config.session,
    contextManager: input.contextManager as never,
    provider: input.provider,
  });
}
