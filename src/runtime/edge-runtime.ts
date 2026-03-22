/**
 * Edge runtime composition and bootstrap.
 *
 * This module owns the long-lived edge process startup path. The CLI entrypoint
 * delegates here instead of embedding the runtime bootstrap inside src/index.ts.
 */
import { join, resolve } from 'node:path';
import { resolveConfig } from '../config/resolve.js';
import { writePidFile, removePidFile } from '../daemon/pid.js';
import { CLIChannel } from '../channels/cli.js';
import { TUIChannel } from '../channels/tui.js';
import { DiscordChannel } from '../channels/discord.js';
import { composeChannelRuntimes } from '../channels/runtime-composition.js';
import { createMessageSurfaceResolver } from '../channels/surface-capabilities.js';
import { TelegramChannel } from '../channels/telegram.js';
import { createBuiltinChannelPlatformRegistry, inferChannelPlatformFromChannelId, type ChannelPlatform } from '../channels/platforms.js';
import { createBuiltinChannelSetupAdapters } from '../channels/setup-adapters.js';
import { createTelegramCommandHandler } from '../channels/telegram-runtime.js';
import { AnthropicProvider } from '../providers/anthropic.js';
import { OpenAIProvider } from '../providers/openai.js';
import { LiteLLMProvider } from '../providers/litellm.js';
import { FailoverProvider } from '../providers/failover.js';
import { RetryQueue } from '../core/retry-queue.js';
import { MessageQueue, type QueuedMessage } from '../core/message-queue.js';
import { ToolRegistry } from '../tools/registry.js';
import { ToolPolicy } from '../tools/policy.js';
import { configureExecSafety } from '../tools/exec.js';
import { AgentLoop } from '../core/agent-loop.js';
import { PromptBuilder } from '../core/prompt.js';
import { ContextManager } from '../core/context.js';
import { SessionManager, type Session } from '../gateway/session.js';
import { Gateway } from '../gateway/gateway.js';
import { SessionCompactor } from '../gateway/compaction.js';
import { TakoHookSystem } from '../hooks/hooks.js';
import { createEmbeddingProvider } from '../memory/embeddings.js';
import { buildAgentSkillLoader, initializeSkillRuntime } from '../skills/runtime-loader.js';
import { loadSkillRuntimeExtensions } from '../skills/runtime-extensions.js';
import { bootstrapWorkspace, ensureDailyMemory } from '../core/bootstrap.js';
import { SandboxManager } from '../sandbox/sandbox.js';
import { AgentRegistry } from '../agents/registry.js';
import { resolveAgentForChannel } from '../agents/config.js';
import { SubAgentOrchestrator } from '../agents/subagent.js';
import { ThreadBindingManager } from '../core/thread-bindings.js';
import type { Channel, InboundMessage } from '../channels/channel.js';
import { CommandRegistry } from '../commands/registry.js';
import { showModelPicker } from '../commands/model-picker.js';
import { installFileLogger } from '../utils/logger.js';
import { createChannelSetupController } from '../commands/channel-setup.js';
import { isUserAllowed } from '../auth/allow-from.js';
import { checkTokenHealth } from '../auth/storage.js';
import { DeliveryQueue } from '../channels/delivery-queue.js';
import { initMediaStorage, persistAttachments } from '../media/storage.js';
import { initAudit } from '../core/audit.js';
import { PeerTaskApprovalRegistry } from '../core/peer-approvals.js';
import { resolveAcpConfig } from '../acp/config.js';
import { initSecurity } from '../core/security.js';
import { CacheManager } from '../cache/manager.js';
import { setFsCacheManager } from '../tools/fs.js';
import { setExecCacheManager } from '../tools/exec.js';
import { setImageProvider } from '../tools/image.js';
import { createProjectTools } from '../tools/projects.js';
import { getRuntimePaths } from '../core/paths.js';
import { parseNodeMode } from '../core/runtime-mode.js';
import { loadOrCreateNodeIdentity } from '../core/node-identity.js';
import { PrincipalRegistry } from '../principals/registry.js';
import { ProjectRegistry } from '../projects/registry.js';
import { ProjectMembershipRegistry } from '../projects/memberships.js';
import { ProjectBindingRegistry } from '../projects/bindings.js';
import { getProjectRole, isProjectMember } from '../projects/access.js';
import type { ProjectRole, Project } from '../projects/types.js';
import {
  defaultProjectArtifactsRoot,
  projectApprovalsRoot,
  projectBackgroundRoot,
  resolveProjectRoot,
} from '../projects/root.js';
import { ProjectArtifactRegistry } from '../projects/artifacts.js';
import { importArtifactEnvelope } from '../projects/distribution.js';
import { ProjectApprovalRegistry } from '../projects/approvals.js';
import { ProjectBackgroundRegistry } from '../projects/background.js';
import { ProjectChannelCoordinatorRegistry } from '../projects/channel-coordination.js';
import { registerKernelToolPacks, registerRuntimeToolPacks, registerSurfaceToolPacks, registerCronToolPack } from '../core/tool-composition.js';
import { ChannelDeliveryRegistry } from '../core/channel-delivery.js';
import { createAcpRuntimeBundle } from '../core/runners/acp-runner.js';
import { createPeerTaskRuntimeHandlers } from '../core/runners/peer-approval-runner.js';
import { configureRetryRunner } from '../core/runners/retry-runner.js';
import { SharedSessionRegistry, type SharedSession } from '../sessions/shared.js';
import {
  createHubClientFromConfig,
} from '../network/sync.js';
import { TrustStore } from '../network/trust.js';
import { NetworkSharedSessionStore, type NetworkSessionEvent } from '../network/shared-sessions.js';
import { sendNetworkSessionEvent } from '../network/session-sync.js';
import { CapabilityRegistry } from '../network/capabilities.js';
import { DelegationStore } from '../network/delegation.js';
import { evaluateDelegationRequest } from '../network/delegation-policy.js';
import { DelegationExecutor } from '../network/delegation-executor.js';
import {
  buildExecutionContext,
  toAuditContext,
  toCommandContext,
  toSessionMetadata,
  type ExecutionContext,
} from '../core/execution-context.js';
import { createProjectCoordinationRuntime } from './project-coordination.js';
import { createApprovalRuntime } from './approval-runtime.js';
import { startNetworkRuntime } from './network-runtime.js';
import { createProjectRuntime } from './project-runtime.js';

const VERSION = '0.0.1';

function formatUserFacingAgentError(err: unknown): string {
  const errMsg = err instanceof Error ? err.message : String(err);
  const lower = errMsg.toLowerCase();
  if (
    lower.includes('internal server error')
    || lower.includes('api_error')
    || lower.includes('[failover] all models in fallback chain failed')
    || lower.includes('http 500')
    || lower.includes('http 502')
    || lower.includes('http 503')
    || lower.includes('http 504')
  ) {
    return '⚠️ The model provider had a temporary failure. Tako will retry/fail over automatically when possible. Please try again in a moment.';
  }
  return `⚠️ Error: ${errMsg.slice(0, 500)}`;
}

export async function runEdgeRuntime(): Promise<void> {
  // Install file logger early so all console output is captured
  installFileLogger();
  const runtimeMode = parseNodeMode(process.env['TAKO_MODE']);
  const runtimePaths = getRuntimePaths();
  console.log(`[tako] mode=${runtimeMode} home=${runtimePaths.home}${process.env['TAKO_HUB'] ? ` hub=${process.env['TAKO_HUB']}` : ''}`);

  const config = await resolveConfig();
  if (process.env['TAKO_HUB']) {
    config.network = { ...config.network, enabled: true, hub: process.env['TAKO_HUB'] };
  }
  const audit = initAudit(config.audit);
  const hubClient = createHubClientFromConfig(config);
  let stopHubHeartbeat: (() => void) | null = null;
  let stopNetworkPolling: (() => void) | null = null;

  // Bootstrap workspace
  await bootstrapWorkspace(config.memory.workspace);
  await ensureDailyMemory(config.memory.workspace);

  // Initialize security modules
  initSecurity(config.security, config.memory.workspace);

  // Initialize cache
  const cacheManager = new CacheManager(config.cache);
  cacheManager.startAutoClean();
  setFsCacheManager(cacheManager);
  setExecCacheManager(cacheManager);

  // Initialize subsystems
  const hooks = new TakoHookSystem();
  const sessions = new SessionManager();
  const principalRegistry = new PrincipalRegistry(runtimePaths.principalsDir);
  const projectRegistry = new ProjectRegistry(runtimePaths.projectsDir);
  const projectMemberships = new ProjectMembershipRegistry(runtimePaths.projectsDir);
  const projectBindings = new ProjectBindingRegistry(runtimePaths.projectsDir);
  const sharedSessionRegistry = new SharedSessionRegistry(runtimePaths.sharedSessionsDir);
  const peerTaskApprovals = new PeerTaskApprovalRegistry(runtimePaths.peerTaskApprovalsFile);
  const trustStore = new TrustStore(runtimePaths.trustFile);
  const networkSharedSessions = new NetworkSharedSessionStore(runtimePaths.networkSessionsFile, runtimePaths.networkEventsFile);
  const capabilityRegistry = new CapabilityRegistry(runtimePaths.capabilitiesFile);
  const delegationStore = new DelegationStore(runtimePaths.delegationRequestsFile, runtimePaths.delegationResultsFile);
  const delegationExecutor = new DelegationExecutor();
  let nodeIdentity: Awaited<ReturnType<typeof loadOrCreateNodeIdentity>> | null = null;
  await principalRegistry.load();
  await projectRegistry.load();
  await projectMemberships.load();
  await projectBindings.load();
  await sharedSessionRegistry.load();
  await peerTaskApprovals.load();
  await trustStore.load();
  await networkSharedSessions.load();
  await capabilityRegistry.load();
  await delegationStore.load();
  const channelPlatforms = createBuiltinChannelPlatformRegistry();
  const projectChannelCoordinators = new ProjectChannelCoordinatorRegistry();
  const channelDeliveryRegistry = new ChannelDeliveryRegistry();

  const resolvePrincipal = async (msg: InboundMessage) => {
    const platform = inferChannelPlatformFromChannelId(msg.channelId, channelPlatforms);
    const username = typeof msg.author.meta?.username === 'string' ? msg.author.meta.username : undefined;
    const principal = await principalRegistry.getOrCreateHuman({
      displayName: msg.author.name,
      platform,
      platformUserId: msg.author.id,
      username,
      metadata: {
        channelId: msg.channelId,
      },
    });
    msg.author.principalId = principal.principalId;
    msg.author.meta = {
      ...msg.author.meta,
      principalId: principal.principalId,
      principalName: principal.displayName,
    };
    return principal;
  };
  const peerAgentLoopWindow = new Map<string, number[]>();
  const shouldThrottlePeerAgentMessage = (input: {
    targetAgentId: string;
    authorId: string;
    channelId: string;
    isBot: boolean;
  }): boolean => {
    if (!input.isBot) return false;
    const key = `${input.targetAgentId}:${input.channelId}:${input.authorId}`;
    const now = Date.now();
    const recent = (peerAgentLoopWindow.get(key) ?? []).filter((ts) => now - ts < 90_000);
    recent.push(now);
    peerAgentLoopWindow.set(key, recent);
    return recent.length > 4;
  };

  const getNodeIdentity = () => {
    if (!nodeIdentity) throw new Error('Node identity not initialized');
    return nodeIdentity;
  };
  let projectCoordinationRuntime: import('./project-coordination.js').ProjectCoordinationRuntime | null = null;
  let getAgentBaseRole = (_agentId: string): string => 'admin';
  const {
    resolveProject,
    buildProjectBackground,
    activateCollaborativeProject,
    autoEnrollProjectRoomParticipant,
    sweepProjectRoomSignal,
    normalizeDiscordPolicyIdentity,
    buildAgentAccessMetadata,
    isDiscordInvocationAllowed,
    manageDiscordProjectMemberFromTool,
    syncDiscordProjectFromTool,
    closeDiscordProjectFromTool,
    manageDiscordRoomAccessFromTool,
    inspectDiscordRoomFromTool,
    manageProjectNetworkFromTool,
    bootstrapDiscordProjectFromTool,
    notifyPatchApprovalReview,
    formatSharedSessionJoinNotice,
  } = createProjectRuntime({
    config,
    runtimePaths,
    sessions,
    principalRegistry,
    projectRegistry,
    projectMemberships,
    projectBindings,
    projectChannelCoordinators,
    channelDeliveryRegistry,
    trustStore,
    networkSharedSessions,
    getHubClient: () => hubClient,
    getNodeIdentity,
    getProjectRoomNotifier: () => {
      if (!projectCoordinationRuntime) throw new Error('Project coordination runtime not initialized');
      return projectCoordinationRuntime.projectRoomNotifier;
    },
    getDiscordProjectSupport: () => {
      if (!projectCoordinationRuntime) throw new Error('Project coordination runtime not initialized');
      return projectCoordinationRuntime.discordProjectSupport;
    },
    getAgentBaseRole: (agentId) => getAgentBaseRole(agentId),
  });

  const buildInboundExecutionContext = (input: {
    agentId: string;
    sessionId?: string;
    principal?: Awaited<ReturnType<typeof principalRegistry.getOrCreateHuman>> | null;
    authorId: string;
    authorName: string;
    platform: ChannelPlatform;
    channelId: string;
    channelTarget: string;
    threadId?: string;
    project?: Project | null;
    projectRole?: ProjectRole | null;
    metadata?: Record<string, unknown>;
  }): ExecutionContext => {
    const projectRoot = input.project ? resolveProjectRoot(runtimePaths, input.project) : undefined;
    return buildExecutionContext({
      nodeIdentity: getNodeIdentity(),
      home: runtimePaths.home,
      agentId: input.agentId,
      workspaceRoot: config.memory.workspace,
      projectRoot,
      allowedToolRoot: projectRoot ?? config.memory.workspace,
      sessionId: input.sessionId,
      principal: input.principal,
      authorId: input.authorId,
      authorName: input.authorName,
      platform: input.platform,
      platformUserId: input.authorId,
      channelId: input.channelId,
      channelTarget: input.channelTarget,
      threadId: input.threadId,
      project: input.project ?? null,
      projectRole: input.projectRole ?? null,
      metadata: input.metadata,
    });
  };

  const applyExecutionContextToSession = (session: Session, ctx: ExecutionContext, channel?: Channel): void => {
    const networkSession = (ctx.sharedSessionId ? networkSharedSessions.findBySharedSessionId(ctx.sharedSessionId) : null)
      ?? networkSharedSessions.findByLocalSessionId(session.id)
      ?? (ctx.projectId
        ? networkSharedSessions.findByProject(ctx.projectId).find((candidate) => candidate.participantNodeIds.includes(getNodeIdentity().nodeId)) ?? null
        : null);
    if (networkSession) {
      void networkSharedSessions.bindLocalSession({
        networkSessionId: networkSession.networkSessionId,
        nodeId: getNodeIdentity().nodeId,
        localSessionId: session.id,
        sharedSessionId: ctx.sharedSessionId,
      }).catch(() => {});
      ctx.networkSessionId = networkSession.networkSessionId;
      ctx.hostNodeId = networkSession.hostNodeId;
      ctx.participantNodeIds = networkSession.participantNodeIds;
    }
    Object.assign(session.metadata, toSessionMetadata(ctx), {
      executionContext: ctx,
      ...(channel ? { channelRef: channel } : {}),
    });
  };

  const ensureSharedSession = async (input: {
    session: Session;
    ctx: ExecutionContext;
  }): Promise<SharedSession | null> => {
    if (!input.ctx.projectId || !input.ctx.principalId || !input.ctx.channelTarget || !input.ctx.platform) {
      return null;
    }

    let shared = sharedSessionRegistry.findBySessionId(input.session.id);
    if (!shared) {
      shared = sharedSessionRegistry.findByBinding({
        projectId: input.ctx.projectId,
        platform: input.ctx.platform,
        channelTarget: input.ctx.channelTarget,
        threadId: input.ctx.threadId,
        agentId: input.ctx.agentId,
      });
    }
    const project = projectRegistry.get(input.ctx.projectId);
    const collaborationMode = project?.collaboration?.mode ?? 'single-user';
    let participantJoined = false;
    if (!shared) {
      if (collaborationMode !== 'collaborative' && (!project || input.ctx.principalId === project.ownerPrincipalId)) {
        return null;
      }
      shared = await sharedSessionRegistry.create({
        sessionId: input.session.id,
        agentId: input.ctx.agentId,
        projectId: input.ctx.projectId,
        projectSlug: input.ctx.projectSlug,
        ownerPrincipalId: input.ctx.principalId,
        initialParticipantId: input.ctx.principalId,
        binding: {
          platform: input.ctx.platform,
          channelId: input.ctx.channelId ?? `${input.ctx.platform}:${input.ctx.channelTarget}`,
          channelTarget: input.ctx.channelTarget,
          threadId: input.ctx.threadId,
        },
      });
      audit.log({
        ...toAuditContext({
          ...input.ctx,
          sharedSessionId: shared.sharedSessionId,
          participantIds: shared.participantIds,
        }),
        event: 'session_start',
        action: 'shared_session_create',
        details: {
          ownerPrincipalId: shared.ownerPrincipalId,
        },
        success: true,
      }).catch(() => {});
      participantJoined = true;
    } else {
      participantJoined = !shared.participantIds.includes(input.ctx.principalId);
      await sharedSessionRegistry.touchParticipant(shared.sharedSessionId, input.ctx.principalId);
    }
    if (participantJoined) {
      await activateCollaborativeProject(input.ctx.projectId, `participant_join:${input.ctx.principalId}`);
    }
    shared = await sharedSessionRegistry.setActiveParticipant(shared.sharedSessionId, input.ctx.principalId);
    if (participantJoined) {
      const snapshot = await buildProjectBackground(shared.projectId, `participant_join:${input.ctx.principalId}`, shared);
      const collaborativeProject = projectRegistry.get(shared.projectId);
      const suppressLocalDiscordJoinNotice = input.ctx.platform === 'discord'
        && isProjectMember(projectMemberships, shared.projectId, input.ctx.principalId);
      if (collaborativeProject?.collaboration?.announceJoins !== false && !suppressLocalDiscordJoinNotice) {
        const who = input.ctx.principalName ?? input.ctx.authorName ?? input.ctx.principalId;
        await projectRoomNotifier.notify(shared.projectId, formatSharedSessionJoinNotice({
          displayName: who,
          projectSlug: collaborativeProject?.slug ?? shared.projectId,
          snapshotSummary: snapshot?.summary,
        }));
      }
      const networkSession = networkSharedSessions.findByProject(shared.projectId)
        .find((candidate) => candidate.participantNodeIds.includes(getNodeIdentity().nodeId)) ?? null;
      if (hubClient && nodeIdentity && networkSession?.participantNodeIds.length) {
        await sendNetworkSessionEvent(hubClient, networkSharedSessions, trustStore, {
          eventId: crypto.randomUUID(),
          networkSessionId: networkSession.networkSessionId,
          projectId: shared.projectId,
          fromNodeId: nodeIdentity.nodeId,
          fromPrincipalId: input.ctx.principalId,
          type: 'join',
          audience: 'specific-nodes',
          targetNodeIds: networkSession.participantNodeIds,
          payload: {
            summary: `${input.ctx.principalName ?? input.ctx.authorName ?? input.ctx.principalId} joined ${collaborativeProject?.slug ?? shared.projectId}`,
            metadata: {
              joinKind: 'principal_join',
              participantPrincipalId: input.ctx.principalId,
              participantPrincipalName: input.ctx.principalName ?? input.ctx.authorName,
              projectSlug: collaborativeProject?.slug,
            },
          },
          createdAt: new Date().toISOString(),
        }).catch(() => {});
      }
    }
    return shared;
  };

  // Thread bindings (Discord thread → sub-agent session routing)
  const { homedir } = await import('node:os');
  const threadBindings = new ThreadBindingManager(
    getRuntimePaths().threadBindingsFile,
  );
  await threadBindings.load();

  // Memory
  const embeddingProvider = createEmbeddingProvider(config.memory.embeddings);
  const promptBuilder = new PromptBuilder(config.memory.workspace);
  promptBuilder.setSandboxInfo(config.sandbox.mode, config.sandbox.workspaceAccess);
  const contextManager = new ContextManager({
    compactionThreshold: Math.max(
      0.5,
      Math.min(0.95, (config.session.compaction.thresholdPercent ?? 80) / 100),
    ),
    pruning: config.pruning
      ? {
          enabled: config.pruning.enabled,
          mode: config.pruning.mode,
          toolResultTtlMs: config.pruning.toolResultTtlMs,
          maxToolResultChars: config.pruning.maxToolResultChars,
          startAt: config.pruning.startAt,
          aggressiveAt: config.pruning.aggressiveAt,
        }
      : undefined,
  });

  // Provider
  const [providerName] = config.providers.primary.split('/');
  let provider;
  let resolvedProviderLabel = config.providers.primary;
  switch (providerName) {
    case 'anthropic':
      provider = new AnthropicProvider(config.providers.anthropic?.setupToken ?? config.providers.anthropic?.apiKey, undefined, config.providers.anthropic?.baseUrl);
      break;
    case 'openai':
      provider = new OpenAIProvider();
      break;
    case 'litellm':
      if (config.providers.litellm?.baseUrl) {
        provider = LiteLLMProvider.fromConfig(config.providers.litellm);
      } else {
        console.error('[litellm] ✗ No LiteLLM endpoint configured!');
        console.error('[litellm]   Your primary model is litellm/* but no baseUrl is set.');
        console.error('[litellm]   Run `tako onboard` and configure LiteLLM, or switch provider.');
        console.error('[litellm]   Falling back to Anthropic provider.');
        provider = new AnthropicProvider(config.providers.anthropic?.setupToken ?? config.providers.anthropic?.apiKey, undefined, config.providers.anthropic?.baseUrl);
        resolvedProviderLabel = `anthropic (fallback — litellm misconfigured)`;
      }
      break;
    default:
      provider = new AnthropicProvider(config.providers.anthropic?.setupToken ?? config.providers.anthropic?.apiKey, undefined, config.providers.anthropic?.baseUrl);
      resolvedProviderLabel = `anthropic (fallback — unknown provider '${providerName}')`;
  }

  // Wrap provider in FailoverProvider for automatic fallback
  const fallbackChain = [config.providers.primary, ...(config.providers.fallback ?? [])];
  const providerMap = new Map<string, import('../providers/provider.js').Provider>();
  providerMap.set(providerName, provider);

  // Create additional provider instances for fallback models
  for (const ref of fallbackChain) {
    const [pid] = ref.split('/');
    if (!providerMap.has(pid)) {
      switch (pid) {
        case 'anthropic':
          providerMap.set(pid, new AnthropicProvider(config.providers.anthropic?.setupToken ?? config.providers.anthropic?.apiKey, undefined, config.providers.anthropic?.baseUrl));
          break;
        case 'openai':
          providerMap.set(pid, new OpenAIProvider());
          break;
        case 'litellm':
          if (config.providers.litellm?.baseUrl) {
            providerMap.set(pid, LiteLLMProvider.fromConfig(config.providers.litellm));
          }
          break;
      }
    }
  }

  const failoverProvider = new FailoverProvider({
    providers: providerMap,
    chain: fallbackChain,
    cooldownMs: (config.providers.cooldownSeconds ?? 60) * 1000,
  });

  // Wire image tool to use the active provider for vision API
  setImageProvider(failoverProvider, config.providers.primary);

  // Token health check (non-blocking — warn only)
  checkTokenHealth(providerName).then((health) => {
    if (!health.valid) {
      console.warn(`[tako] ⚠ ${providerName} auth check failed: ${health.error}`);
      console.warn(`[tako]   Run \`tako models auth login --provider ${providerName}\` to fix.`);
    }
  }).catch(() => { /* ignore — non-critical */ });

  // Sandbox manager
  const sandboxManager = new SandboxManager(config.sandbox);
  const sandboxActive = config.sandbox.mode !== 'off';
  if (sandboxActive) {
    const dockerOk = await sandboxManager.checkDocker();
    if (!dockerOk) {
      console.warn('[tako] Warning: Sandbox enabled but Docker is not available. Falling back to host execution.');
    }
  }

  // Tool policy
  const toolPolicy = new ToolPolicy({
    profile: config.tools.profile,
    allow: config.tools.allow,
    deny: config.tools.deny,
    sandbox: config.tools.sandbox,
    exec: config.tools.exec ? {
      security: config.tools.exec.security,
      allowlist: config.tools.exec.allowlist,
      timeout: config.tools.exec.timeout,
      maxOutputSize: config.tools.exec.maxOutputSize,
    } : undefined,
  });

  // Exec safety
  configureExecSafety({
    workspaceRoot: config.memory.workspace,
    workDir: process.cwd(),
    // Allow long-running ACP/bootstrap commands by default (up to 5 min)
    maxTimeout: config.tools.exec?.timeout ?? 300_000,
    defaultTimeout: 120_000,
    maxOutputSize: config.tools.exec?.maxOutputSize ?? 1024 * 1024,
  });

  // Tool registry
  const toolRegistry = new ToolRegistry();
  toolRegistry.setProfile(config.tools.profile);
  toolRegistry.setDenyList(config.tools.deny);
  if (config.tools.allow) toolRegistry.setAllowList(config.tools.allow);
  toolRegistry.setToolPolicy(toolPolicy);

  // Register kernel tool packs
  registerKernelToolPacks({
    toolRegistry,
    config,
    embeddingProvider: embeddingProvider ?? undefined,
    sessions,
    projectTools: {
    bootstrapFromPrompt: bootstrapDiscordProjectFromTool,
    manageMember: manageDiscordProjectMemberFromTool,
    syncProject: syncDiscordProjectFromTool,
    closeProject: closeDiscordProjectFromTool,
    manageNetwork: manageProjectNetworkFromTool,
    },
    discordRoomTools: {
      manageAccess: manageDiscordRoomAccessFromTool,
      inspectRoom: inspectDiscordRoomFromTool,
    },
  });

  // ACP runtime (acpx-backed coding agent sessions)
  const acpConfig = resolveAcpConfig(
    {
      enabled: config.tools.acp?.enabled ?? true,
      permissionMode: config.tools.acp?.permissionMode ?? 'approve-reads',
      defaultAgent: config.tools.acp?.defaultAgent ?? 'claude',
      timeoutSeconds: config.tools.acp?.timeoutSeconds ?? 600,
    },
    config.memory.workspace,
  );
  const acpRuntimeBundle = createAcpRuntimeBundle(acpConfig);
  const acpAvailable = await acpRuntimeBundle.probe();
  const { acpRuntime, acpSessionManager } = acpRuntimeBundle;
  console.log(`[acp] Runtime: ${acpAvailable ? 'available' : 'unavailable'}`);

  // Inject ACP knowledge into ALL agent prompts
  promptBuilder.setAcpConfig({
    enabled: acpAvailable && acpConfig.enabled,
    allowedAgents: acpConfig.allowedAgents,
    defaultAgent: acpConfig.defaultAgent,
  });

  // Old standalone ACP tools removed — sessions_spawn(runtime="acp") replaces them.
  // AcpSessionManager kept for CLI `tako acp` commands only.
  acpSessionManager.startCleanup();

  // Symphony tools (project orchestration)
  const { symphonyTools } = await import('../tools/symphony.js');
  toolRegistry.registerAll(symphonyTools);

  // System tools (restart, etc.)
  const { registerSystemTools } = await import('../tools/system-tools.js');
  registerSystemTools(toolRegistry, {
    gatewayPort: config.gateway.port,
    gatewayBind: config.gateway.bind,
  });

  // ─── Agent registry ────────────────────────────────────────────────

  const agentRegistry = new AgentRegistry(config.agents, config.providers.primary);
  await agentRegistry.loadDynamic();
  await agentRegistry.initialize();
  getAgentBaseRole = (agentId: string) => agentRegistry.get(agentId)?.role ?? 'admin';

  // Enable per-agent session persistence (each agent stores sessions in its own dir)
  const agentSessionDirs = new Map<string, string>();
  for (const agent of agentRegistry.list()) {
    agentSessionDirs.set(agent.id, agent.sessionDir);
  }
  await sessions.enablePersistence(agentSessionDirs);

  // Load skills — dirs come from config (already resolved/expanded)
  const { skillLoader, skillManifests } = await initializeSkillRuntime({
    skillDirs: config.skills.dirs,
    toolRegistry,
    hooks,
    addSkillInstructions: (instructions) => promptBuilder.addSkillInstructions(instructions),
  });

  // Retry queue for failed messages (all fallbacks exhausted)
  const retryQueue = new RetryQueue(config.retryQueue);

  // Track active processing sessions to detect concurrent runs.
  // If a session is already being processed, new messages get a "busy" reply
  // rather than silently piling up for potentially hours.
  const activeProcessingSessions = new Set<string>();

  // Message queue for batching rapid inbound messages
  // The processor callback is wired after the agent loop is created (see below).
  let messageQueueProcessor: ((sessionId: string, messages: QueuedMessage[]) => Promise<void>) | null = null;
  const messageQueue = new MessageQueue(config.queue, async (sessionId, messages) => {
    if (messageQueueProcessor) await messageQueueProcessor(sessionId, messages);
  });
  const {
    resumePeerTaskApproval,
    handleSharedAccessToolAuthorization,
  } = createPeerTaskRuntimeHandlers({
    sessions,
    toolRegistry,
    peerTaskApprovals,
    audit,
    workspaceRoot: config.memory.workspace,
    activeProcessingSessions,
    getAgentLoop,
    getChannelDeliveryRegistry: () => channelDeliveryRegistry,
    formatUserFacingAgentError,
  });

  // Typing indicators + reaction feedback
  const { TypingManager } = await import('../core/typing.js');
  const { ReactionManager } = await import('../core/reactions.js');
  const typingManager = new TypingManager(config.typing ?? { enabled: true, intervalMs: 5000 });
  const reactionManager = new ReactionManager(config.reactions ?? { enabled: true });

  // Session compactor — auto-compresses context when it grows too large.
  // Shared across all agent loops so every agent benefits from compaction.
  const sessionCompactor = new SessionCompactor(
    config.session,
    contextManager,
    sessions,
    failoverProvider,
    hooks,
  );

  // Agent loop with skill loader for dynamic injection
  const agentLoop = new AgentLoop(
    { provider: failoverProvider, toolRegistry, promptBuilder, contextManager, hooks, skillLoader, model: config.providers.primary, workspaceRoot: config.memory.workspace, retryQueue, typingManager, reactionManager, streamingConfig: config.agent.streaming, compactor: sessionCompactor, handleSharedAccessToolAuthorization },
    {
      timeout: config.agent.timeout,
      ...(config.agent.maxOutputChars != null && { maxOutputChars: config.agent.maxOutputChars }),
      ...(config.agent.maxTurns != null && { maxTurns: config.agent.maxTurns }),
      ...(config.agent.maxToolCalls != null && { maxToolCalls: config.agent.maxToolCalls }),
      ...(config.agent.maxTokens != null && { maxTokens: config.agent.maxTokens }),
    },
  );

  // Set retry runner — re-invokes agent loop for a session
  configureRetryRunner({
    retryQueue,
    sessions,
    runSession: (session, userMessage) => agentLoop.run(session, userMessage),
  });

  // Per-agent loops: each agent gets its own PromptBuilder (workspace) but shares
  // the same provider (auth), toolRegistry, contextManager, and hooks.
  // Agents with per-agent skill dirs get their own SkillLoader; otherwise they
  // share the global skillLoader.
  const agentLoops = new Map<string, AgentLoop>();
  for (const agent of agentRegistry.list()) {
    if (agent.isMain) continue;
    const agentPromptBuilder = new PromptBuilder(agent.workspace);
    agentPromptBuilder.setSandboxInfo(config.sandbox.mode, config.sandbox.workspaceAccess);
    agentPromptBuilder.setAcpConfig({
      enabled: acpAvailable && acpConfig.enabled,
      allowedAgents: acpConfig.allowedAgents,
      defaultAgent: acpConfig.defaultAgent,
    });
    const agentModel = agent.model ?? config.providers.primary;

    // Build per-agent skill loader when agent has extra skill dirs
    const agentSkillLoader = await buildAgentSkillLoader({
      baseSkillLoader: skillLoader,
      baseSkillDirs: config.skills.dirs,
      extraSkillDirs: agent.skills?.dirs,
      toolRegistry,
      hooks,
      agentId: agent.id,
      log: (message) => console.log(message),
    });

    const loop = new AgentLoop(
      {
        provider: failoverProvider,
        toolRegistry,
        promptBuilder: agentPromptBuilder,
        contextManager,
        hooks,
        skillLoader: agentSkillLoader,
        model: agentModel,
        workspaceRoot: agent.workspace,
        agentId: agent.id,
        agentRole: agent.role,
        retryQueue,
        typingManager,
        reactionManager,
        streamingConfig: config.agent.streaming,
        compactor: sessionCompactor,
        handleSharedAccessToolAuthorization,
      },
      {
        timeout: config.agent.timeout,
        ...(config.agent.maxOutputChars != null && { maxOutputChars: config.agent.maxOutputChars }),
        ...(config.agent.maxTurns != null && { maxTurns: config.agent.maxTurns }),
        ...(config.agent.maxToolCalls != null && { maxToolCalls: config.agent.maxToolCalls }),
        ...(config.agent.maxTokens != null && { maxTokens: config.agent.maxTokens }),
      },
    );
    agentLoops.set(agent.id, loop);
  }

  /** Get the correct AgentLoop for a given agentId. */
  function getAgentLoop(agentId?: string): AgentLoop {
    if (agentId && agentLoops.has(agentId)) return agentLoops.get(agentId)!;
    return agentLoop;
  }

  // ─── Sub-agent orchestrator ────────────────────────────────────────

  const subAgentOrchestrator = new SubAgentOrchestrator(sessions, agentLoop);

  // Notify parent sessions when sub-agents complete — deliver through channels
  subAgentOrchestrator.onCompletion(async (event) => {
    const parentSession = sessions.get(event.parentSessionId);
    if (!parentSession) return;

    const statusEmoji = event.status === 'completed' ? '👍' : event.status === 'timeout' ? '⏱' : '❌';
    const label = event.runId.slice(0, 8);
    const cleanResult = (event.result ?? '').trim();
    const safeResult = (cleanResult && cleanResult !== '[Calling tools]')
      ? cleanResult
      : 'Completed with no text output (check session history/tool results).';
    const summary = event.status === 'completed'
      ? safeResult.slice(0, 1000)
      : (event.error ?? 'Unknown error');
    const announcement = `${statusEmoji} Sub-agent \`${label}\` ${event.status}\n\n${summary}`;

    // Add to session messages
    sessions.addMessage(event.parentSessionId, {
      role: 'system',
      content: announcement,
    });

    // Deliver through the originating channel/thread.
    const channelType = event.announceChannelType || parentSession.metadata.channelType as string | undefined;
    const channelTarget = event.announceChannelTarget || parentSession.metadata.channelTarget as string | undefined;
    if (channelType && channelTarget) {
      const parentAgentId = (parentSession.metadata.agentId as string | undefined) ?? 'main';
      const channel = channels.find((ch) => ch.id === channelType && ((ch.agentId ?? 'main') === parentAgentId))
        ?? channels.find((ch) => ch.id === channelType);

      const isLikelyDiscordSnowflake = /^\d{16,22}$/.test(channelTarget);
      if (channel && (channelType !== 'discord' || isLikelyDiscordSnowflake)) {
        try {
          await channel.send({ content: announcement, target: channelTarget });
        } catch (err) {
          console.error(`[subagent] Failed to deliver completion to ${channelType}:${channelTarget}: ${err instanceof Error ? err.message : err}`);
        }
      } else if (channelType === 'discord' && !isLikelyDiscordSnowflake) {
        console.warn(`[subagent] Skipping invalid Discord target for completion: ${channelTarget}`);
      }
    }

    // Also output to CLI/TUI if that's the parent channel
    if (!channelType || channelType === 'cli' || channelType === 'tui') {
      console.log(`\n${announcement}\n`);
    }
  });

  registerRuntimeToolPacks({
    toolRegistry,
    modelTool: {
      setModel: (ref) => {
        agentLoop.setModel(ref);
        config.providers.primary = ref;
        import('../config/resolve.js').then(m => m.patchConfig({ providers: { primary: ref } })).catch(() => {});
      },
      getModel: () => agentLoop.getModel(),
    },
    agentTools: {
      registry: agentRegistry,
      orchestrator: subAgentOrchestrator,
      sessions,
      threadBindings,
      acpRuntime,
      acpConfig,
    },
  });

  // ─── Command registry ────────────────────────────────────────────

  const startTime = Date.now();
  const defaultModel = config.providers.primary;
  const commandRegistry = new CommandRegistry({
    getModel: () => agentLoop.getModel(),
    setModel: (ref: string) => {
      agentLoop.setModel(ref);
      config.providers.primary = ref;
      // Persist to tako.json so it survives restart
      import('../config/resolve.js').then(m => m.patchConfig({ providers: { primary: ref } })).catch(() => {});
    },
    getDefaultModel: () => defaultModel,
    getFallbackModels: () => config.providers.fallback ?? [],
    listAgents: () => agentRegistry.list().map((a: any) => ({
      id: a.id,
      description: a.description,
      role: a.role,
    })),
    compactSession: (sessionId: string, keepLast?: number) => sessions.compact(sessionId, keepLast),
    resetSession: (sessionId: string) => sessions.resetSession(sessionId),
    estimateTokens: (session) => contextManager.estimateTokens(session.messages),
    startTime,
    getWorkspaceRoot: () => config.memory.workspace,
    getSessionCount: () => sessions.list().length,
    getChannelNames: () => channels.map(ch => ch.id),
    getSkillCount: () => skillManifests.length,
    getToolCount: () => toolRegistry.getActiveTools().length,
    getQueueMode: () => messageQueue.getConfig().mode,
    setQueueMode: (mode: 'off' | 'collect' | 'debounce') => messageQueue.setMode(mode),
    getQueueStatus: () => messageQueue.status(),
    runAcpCommand: async (args, ctx) => {
      const tool = toolRegistry.getTool('acp_router');
      if (!tool) {
        return [
          'ACP router tool is not loaded.',
          'Ensure the `acp` skill is installed/enabled, then retry `/acp help`.',
        ].join('\n');
      }

      const channelType = ctx.channelId.includes(':') ? ctx.channelId.split(':')[0] : ctx.channelId;
      const channelTarget = ctx.channelId.includes(':') ? ctx.channelId.split(':').slice(1).join(':') : ctx.channelId;
      const result = await tool.execute(
        { input: args },
        {
          sessionId: ctx.session.id,
          workDir: config.memory.workspace,
          workspaceRoot: config.memory.workspace,
          agentId: ctx.agentId,
          channelType,
          channelTarget,
          executionContext: ctx.executionContext,
        },
      );

      if (!result.success) {
        return result.error ? `ACP error: ${result.error}` : 'ACP command failed.';
      }
      return result.output || 'ACP command executed.';
    },
    getProjectBackground: async (projectId) => {
      const registry = new ProjectBackgroundRegistry(projectBackgroundRoot(runtimePaths, projectId));
      await registry.load();
      return registry.get()?.summary ?? null;
    },
    listPatchApprovals: async (projectId) => {
      const registry = new ProjectApprovalRegistry(projectApprovalsRoot(runtimePaths, projectId), projectId);
      await registry.load();
      return registry.list().map((row) => ({
        approvalId: row.approvalId,
        artifactName: row.artifactName,
        status: row.status,
      }));
    },
    resolvePatchApproval: async (projectId, approvalId, decision, reviewedByPrincipalId, reason) => {
      const registry = new ProjectApprovalRegistry(projectApprovalsRoot(runtimePaths, projectId), projectId);
      await registry.load();
      const resolved = await registry.resolve(approvalId, decision, reviewedByPrincipalId, reason);
      await projectRoomNotifier.notify(projectId, `[patch ${decision}] ${resolved.artifactName} (${resolved.approvalId})`);
      return {
        approvalId: resolved.approvalId,
        artifactName: resolved.artifactName,
        status: resolved.status,
      };
    },
  });

  // Best-effort repair for malformed persisted messages so one bad entry
  // never poisons a whole session.
  function sanitizeSessionMessages(session: Session): number {
    let fixed = 0;
    const cleaned: any[] = [];
    for (const m of session.messages as any[]) {
      if (!m || typeof m !== 'object') { fixed++; continue; }
      if (typeof m.role !== 'string') { fixed++; continue; }
      if (!('content' in m) || m.content == null) {
        cleaned.push({ ...m, content: '' });
        fixed++;
        continue;
      }
      cleaned.push(m);
    }
    if (fixed > 0) {
      session.messages = cleaned as any;
    }
    return fixed;
  }

  // ─── Multi-channel routing ────────────────────────────────────────

  async function getSession(
    msg: InboundMessage,
    channel?: Channel,
    resolvedProject?: { project: Project } | null,
    accessMetadata?: Record<string, unknown>,
  ): Promise<ReturnType<typeof sessions.getOrCreate> | null> {
    // If the channel has a bound agentId, use it directly; otherwise resolve from bindings
    const channelType = msg.channelId.split(':')[0] ?? 'cli';
    const channelTarget = msg.channelId.includes(':')
      ? msg.channelId.split(':').slice(1).join(':')
      : msg.channelId;

    // Check thread bindings first — if this message is in a bound thread,
    // route to the sub-agent session instead of normal routing.
    const binding = threadBindings.getBinding(channelTarget);
    if (binding) {
      threadBindings.touch(channelTarget);

      // ACP session routing: if bound to an ACP session, route through acpx runtime
      if (binding.sessionKey.includes(':acp:') && acpRuntime?.isHealthy()) {
        const { handleAcpThreadMessage } = await import('../tools/agent-tools.js');
        const discordCh = channel as DiscordChannel;
        const handled = await handleAcpThreadMessage(
          binding.sessionKey,
          msg.content,
          channelTarget,
          discordCh,
          acpRuntime,
        );
        if (handled) return null; // Handled by ACP, skip normal routing
      }

      const session = sessions.getOrCreate(binding.sessionKey, {
        name: `${binding.agentId}/thread:${channelTarget}`,
        metadata: {
          ...toSessionMetadata(buildInboundExecutionContext({
            agentId: binding.agentId,
            sessionId: undefined,
            principal: principalRegistry.get(msg.author.principalId ?? '') ?? null,
            authorId: msg.author.id,
            authorName: msg.author.name,
            platform: channelType as ChannelPlatform,
            channelId: msg.channelId,
            channelTarget,
            project: resolvedProject?.project ?? null,
            threadId: msg.threadId,
            metadata: { ...(accessMetadata ?? msg.author.meta ?? {}) },
          })),
          threadBinding: true,
        },
      });
      let ctx = buildInboundExecutionContext({
        agentId: binding.agentId,
        sessionId: session.id,
        principal: principalRegistry.get(msg.author.principalId ?? '') ?? null,
        authorId: msg.author.id,
        authorName: msg.author.name,
        platform: channelType as ChannelPlatform,
        channelId: msg.channelId,
        channelTarget,
        project: resolvedProject?.project ?? null,
        threadId: msg.threadId,
        metadata: { ...(accessMetadata ?? msg.author.meta ?? {}) },
      });
      const shared = await ensureSharedSession({ session, ctx });
      if (shared) {
        ctx = {
          ...ctx,
          sharedSessionId: shared.sharedSessionId,
          ownerPrincipalId: shared.ownerPrincipalId,
          participantIds: shared.participantIds,
          activeParticipantIds: shared.activeParticipantIds,
        };
      }
      applyExecutionContextToSession(session, ctx, channel);
      if (session.isNew) {
        await hooks.emit('session_start', {
          event: 'session_start',
          sessionId: session.id,
        data: {
          ...toAuditContext(ctx),
          channelType,
          channelTarget,
          authorId: msg.author.id,
        },
        timestamp: Date.now(),
      });
      }
      return session;
    }

    const guildId = msg.author.meta?.guildId as string | undefined;
    const agentId = channel?.agentId ?? resolveAgentForChannel(agentRegistry.list(), channelType, channelTarget, guildId);

    // Build structured session key matching reference runtime's format:
    //   agent:<agentId>:<platform>:<type>:<target>
    let key: string;
    const chatType = msg.author.meta?.chatType as string | undefined;

    if (channelType === 'discord') {
      const guildId = msg.author.meta?.guildId;
      if (guildId) {
        key = `agent:${agentId}:discord:channel:${channelTarget}`;
      } else {
        // No guild = DM
        key = `agent:${agentId}:discord:dm:${msg.author.id}`;
      }
    } else if (channelType === 'telegram') {
      if (chatType === 'private') {
        key = `agent:${agentId}:telegram:dm:${channelTarget}`;
      } else {
        key = `agent:${agentId}:telegram:group:${channelTarget}`;
      }
      // Telegram topic: separate session per forum topic
      if (msg.threadId) {
        key += `:topic:${msg.threadId}`;
      }
    } else if (channelType === 'cli') {
      key = `agent:${agentId}:cli:main`;
    } else {
      key = `agent:${agentId}:${msg.channelId}`;
    }

    const session = sessions.getOrCreate(key, {
      name: `${agentId}/${msg.channelId}/${msg.author.name}`,
      metadata: {
        ...toSessionMetadata(buildInboundExecutionContext({
          agentId,
          principal: principalRegistry.get(msg.author.principalId ?? '') ?? null,
          authorId: msg.author.id,
          authorName: msg.author.name,
          platform: channelType as ChannelPlatform,
          channelId: msg.channelId,
          channelTarget,
          threadId: msg.threadId,
          project: resolvedProject?.project ?? null,
          metadata: { ...(accessMetadata ?? msg.author.meta ?? {}) },
        })),
      },
    });
    let ctx = buildInboundExecutionContext({
      agentId,
      sessionId: session.id,
      principal: principalRegistry.get(msg.author.principalId ?? '') ?? null,
      authorId: msg.author.id,
      authorName: msg.author.name,
      platform: channelType as ChannelPlatform,
      channelId: msg.channelId,
      channelTarget,
      threadId: msg.threadId,
      project: resolvedProject?.project ?? null,
      metadata: { ...(accessMetadata ?? msg.author.meta ?? {}) },
    });
    const shared = await ensureSharedSession({ session, ctx });
    if (shared) {
      ctx = {
        ...ctx,
        sharedSessionId: shared.sharedSessionId,
        ownerPrincipalId: shared.ownerPrincipalId,
        participantIds: shared.participantIds,
        activeParticipantIds: shared.activeParticipantIds,
      };
    }
    applyExecutionContextToSession(session, ctx, channel);
    if (session.isNew) {
      await hooks.emit('session_start', {
        event: 'session_start',
        sessionId: session.id,
        data: {
          ...toAuditContext(ctx),
          channelType,
          channelTarget,
          authorId: msg.author.id,
        },
        timestamp: Date.now(),
      });
    }
    return session;
  }

  function wireChannel(channel: Channel) {
    deliveryQueue.registerChannel(channel);
    channel.onMessage(async (msg: InboundMessage) => {
      try {
      const principal = await resolvePrincipal(msg);
      const channelType = inferChannelPlatformFromChannelId(msg.channelId, channelPlatforms, channel.id);
      const channelTarget = msg.channelId.includes(':')
        ? msg.channelId.split(':').slice(1).join(':')
        : msg.channelId;
      const projectChannelTarget = (msg.author.meta?.parentChannelId as string | undefined) ?? channelTarget;
      const guildId = msg.author.meta?.guildId as string | undefined;
      const inboundAgentId = channel.agentId ?? resolveAgentForChannel(agentRegistry.list(), channelType, channelTarget, guildId);
      const isBotOrigin = msg.author.meta?.isBot === true;
      if (shouldThrottlePeerAgentMessage({
        targetAgentId: inboundAgentId,
        authorId: msg.author.id,
        channelId: msg.channelId,
        isBot: isBotOrigin,
      })) {
        console.warn(`[discord-peer-loop] throttled bot-authored message agent=${inboundAgentId} author=${msg.author.id} channel=${msg.channelId}`);
        return;
      }
      const resolvedProject = resolveProject({
        platform: channelType,
        channelTarget: projectChannelTarget,
        threadId: msg.threadId,
        agentId: inboundAgentId,
      });
      if (channelType === 'discord') {
        const discordPolicy = await isDiscordInvocationAllowed({
          agentId: inboundAgentId,
          authorId: msg.author.id,
          authorName: msg.author.name,
          username: typeof msg.author.meta?.username === 'string' ? msg.author.meta.username : undefined,
          principalId: principal.principalId,
          channelName: typeof msg.author.meta?.channelName === 'string' ? msg.author.meta.channelName : undefined,
          parentChannelName: typeof msg.author.meta?.parentChannelName === 'string' ? msg.author.meta.parentChannelName : undefined,
          project: resolvedProject?.project ?? null,
        });
        if (!discordPolicy.allowed) {
          console.log(
            `[discord-auth] blocked message agent=${inboundAgentId} user=${msg.author.id} principal=${principal.principalId} ` +
            `channel=${msg.channelId} name=${String(msg.author.meta?.channelName ?? '')} ` +
            `parent=${String(msg.author.meta?.parentChannelName ?? '')} reason=${discordPolicy.reason}`,
          );
          return;
        }
      }
      const projectRole = resolvedProject
        ? getProjectRole(projectMemberships, resolvedProject.project.projectId, principal.principalId) ?? undefined
        : undefined;
      const accessMetadata = await buildAgentAccessMetadata({
        platform: channelType,
        agentId: inboundAgentId,
        authorId: msg.author.id,
        principalId: principal.principalId,
        project: resolvedProject?.project ?? null,
        metadata: { ...(msg.author.meta ?? {}) },
      });
      const inboundContext = buildInboundExecutionContext({
        agentId: inboundAgentId,
        principal,
        authorId: msg.author.id,
        authorName: msg.author.name,
        platform: channelType,
        channelId: msg.channelId,
        channelTarget,
        threadId: msg.threadId,
        project: resolvedProject?.project ?? null,
        projectRole: projectRole ?? null,
        metadata: accessMetadata,
      });
      const inboundText = typeof msg.content === 'string' ? msg.content : '';
      await hooks.emit('message_received', {
        event: 'message_received',
        data: {
          ...toAuditContext(inboundContext),
          channelId: msg.channelId,
          authorId: msg.author.id,
          content: msg.content,
        },
        timestamp: Date.now(),
      });

      if (channel.id === 'cli' && (inboundText === '/quit' || inboundText === '/exit')) {
        await shutdown();
        process.exit(0);
      }

      // ─── AllowFrom ACL check ─────────────────────────────────────
      const aclAgentId = channel.agentId ?? 'main';
      const aclChannel = channel.id;
      if (aclChannel !== 'cli' && aclChannel !== 'tui') {
        // Always let /claim through — it needs to reach the command registry
        // even when the bot is unclaimed (open mode) or when the user isn't on the allowlist yet.
        const isClaimCommand = inboundText.trim().toLowerCase() === '/claim';
        if (!isClaimCommand) {
          const allowSharedReadonly = resolvedProject != null;
          const allowed = allowSharedReadonly
            ? true
            : await isUserAllowed(aclChannel, aclAgentId, msg.author.id, principal.principalId);
          if (!allowed) return; // silently ignore
        }
      }

      if (resolvedProject && !isProjectMember(projectMemberships, resolvedProject.project.projectId, principal.principalId)) {
        const enrolled = await autoEnrollProjectRoomParticipant({
          project: resolvedProject.project,
          principalId: principal.principalId,
          principalName: principal.displayName,
          platformUserId: msg.author.id,
          platform: channelType,
          addedBy: resolvedProject.project.ownerPrincipalId,
        });
        if (enrolled) {
          resolvedProject.project = projectRegistry.get(resolvedProject.project.projectId) ?? resolvedProject.project;
        } else {
        audit.log({
          ...toAuditContext(inboundContext),
          event: 'permission_denied',
          action: 'project_membership',
          details: { channelId: msg.channelId, authorId: msg.author.id },
          success: false,
        }).catch(() => {});
        return;
        }
      }

      const session = await getSession(msg, channel, resolvedProject, accessMetadata);

      // ACP thread routing: if getSession returned null, the message was handled by ACP runtime
      if (!session) return;

      // Update per-message runtime metadata used by typing/reactions/rate-limits
      const sessionContext = (
        session.metadata.executionContext as ExecutionContext | undefined
      ) ?? {
        ...inboundContext,
        sessionId: session.id,
      };
      applyExecutionContextToSession(session, sessionContext, channel);
      session.metadata.messageId = msg.id;

      if (resolvedProject && inboundText.trim()) {
        await sweepProjectRoomSignal({
          project: resolvedProject.project,
          principalId: principal.principalId,
          principalName: principal.displayName,
          text: inboundText,
        }).catch(() => {});
      }

      // Extract platform-specific target for typing/reactions
      const target = session.metadata.channelTarget as string;

      // Activation intro message intentionally disabled.

      // ─── Slash command handling (local, no LLM) ──────────────────
      if (inboundText.trim().startsWith('/')) {
        const channelType = msg.channelId.split(':')[0] ?? 'cli';
        const channelTarget = msg.channelId.includes(':')
          ? msg.channelId.split(':').slice(1).join(':')
          : msg.channelId;

        // reference runtime-like command reactions: received -> processing -> done/failed
        if (channel.addReaction) channel.addReaction(target, msg.id, '👋').catch(() => {});
        if (channel.addReaction) channel.addReaction(target, msg.id, '🧐').catch(() => {});
        if (channel.removeReaction) channel.removeReaction(target, msg.id, '👋').catch(() => {});

        try {
          const cmdResult = await commandRegistry.handle(inboundText, {
            ...toCommandContext(sessionContext),
            session,
          });

          if (cmdResult) {
            if (channel.id === 'cli') {
              process.stdout.write(cmdResult + '\n');
            } else {
              await channel.send({ target, content: cmdResult, replyTo: msg.id });
            }
            if (channel.removeReaction) channel.removeReaction(target, msg.id, '🧐').catch(() => {});
            if (channel.addReaction) channel.addReaction(target, msg.id, '👍').catch(() => {});
            return;
          }

          // Unknown command (not handled by registry)
          if (channel.removeReaction) channel.removeReaction(target, msg.id, '🧐').catch(() => {});
          if (channel.addReaction) channel.addReaction(target, msg.id, '🤷').catch(() => {});
        } catch (err) {
          if (channel.removeReaction) channel.removeReaction(target, msg.id, '🧐').catch(() => {});
          if (channel.addReaction) channel.addReaction(target, msg.id, '😅').catch(() => {});
          throw err;
        }
      }

      // ─── Message queue: collect/debounce rapid messages ─────────
      if (messageQueue.getConfig().mode !== 'off' && channel.id !== 'cli' && channel.id !== 'tui') {
        const queuedAttachments = msg.attachments?.length
          ? await persistAttachments(msg.attachments)
          : undefined;

        const queued = messageQueue.enqueue(session.id, {
          content: inboundText,
          channelId: msg.channelId,
          authorId: msg.author.id,
          principalId: principal.principalId,
          principalName: principal.displayName,
          timestamp: Date.now(),
          messageId: msg.id,
          attachments: queuedAttachments,
        });
        if (queued) {
          // Immediate feedback while waiting for queue flush
          if (channel.sendTyping) channel.sendTyping(target).catch(() => {});
          if (channel.addReaction) channel.addReaction(target, msg.id, '💭').catch(() => {});
          return; // message was queued, will be batch-processed later
        }
      }

      // ─── Typing indicator setup ──────────────────────────────────
      const typingMode = config.agent.typingMode ?? 'instant';
      const typingIntervalMs = (config.agent.typingIntervalSeconds ?? 6) * 1000;
      let typingInterval: ReturnType<typeof setInterval> | null = null;

      if (typingMode === 'instant' && channel.sendTyping) {
        channel.sendTyping(target).catch(() => {});
        typingInterval = setInterval(() => {
          channel.sendTyping!(target).catch(() => {});
        }, typingIntervalMs);
      }

      // ─── Reaction feedback: react with 🤔 while processing ──────
      if (channel.addReaction) {
        channel.addReaction(target, msg.id, '🧐').catch(() => {});
      }

      let response = '';
      let hadError = false;

      // Prepend sender context so the agent knows who it's talking to
      const senderPrefix = channel.id !== 'cli' && msg.author?.name
        ? `[From: ${msg.author.name}]\n`
        : '';
      const userMessage = senderPrefix + inboundText;

      // Use the correct agent loop — per-agent loops have their own PromptBuilder
      // (workspace/identity) but share the same provider (auth/API keys).
      const activeLoop = getAgentLoop(channel.agentId ?? session.metadata?.agentId as string | undefined);
      const repaired = sanitizeSessionMessages(session);
      if (repaired > 0) {
        console.warn(`[session] Repaired ${repaired} malformed message(s) in ${session.id}`);
      }

      try {
        // Set active channel for typing/reactions
        activeLoop.setChannel(channel);

        // Persist inbound media attachments locally
        const attachments = msg.attachments?.length
          ? await persistAttachments(msg.attachments)
          : msg.attachments;

        for await (const chunk of activeLoop.run(session, userMessage, attachments)) {
          if (channel.id === 'cli') {
            process.stdout.write(chunk);
          }
          response += chunk;
        }
      } catch (err) {
        hadError = true;
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[tako] Error: ${errMsg}`);

        // Auto-fallback: if model not found (404), try fallback chain or reset to default
        const is404 = errMsg.includes('404') || errMsg.includes('not_found');
        if (is404 && !response) {
          const currentModel = activeLoop.getModel();
          const fallbacks = config.providers.fallback ?? [];
          const nextFallback = fallbacks.find(f => f !== currentModel);
          if (nextFallback) {
            activeLoop.setModel(nextFallback);
            response = `⚠️ Model \`${currentModel}\` not found. Auto-switched to fallback: \`${nextFallback}\`\n\nPlease resend your message, or use \`/model default\` to reset.`;
          } else {
            activeLoop.setModel(defaultModel);
            response = `⚠️ Model \`${currentModel}\` not found. Reset to default: \`${defaultModel}\`\n\nPlease resend your message.`;
          }
        } else if (!response) {
          response = formatUserFacingAgentError(err);
        }
      }

      // ─── Send remaining text, then clean up ──────
      if (typingInterval) {
        clearInterval(typingInterval);
        typingInterval = null;
      }

      if (channel.id === 'cli') {
        if (response && !response.endsWith('\n')) {
          process.stdout.write('\n');
        }
      } else if (channel.id === 'tui') {
        if (response) {
          await channel.send({ target: msg.channelId, content: response, replyTo: msg.id });
        }
      } else if (response.trim()) {
        hooks.emit('message_sending', {
          event: 'message_sending',
          data: {
            channelId: msg.channelId,
            sessionId: session.id,
            agentId: session.metadata.agentId,
            content: response,
            principalId: session.metadata.principalId,
            principalName: session.metadata.principalName,
            projectId: session.metadata.projectId,
            projectSlug: session.metadata.projectSlug,
            sharedSessionId: session.metadata.sharedSessionId,
            networkSessionId: session.metadata.networkSessionId,
            hostNodeId: session.metadata.hostNodeId,
            participantNodeIds: session.metadata.participantNodeIds,
            participantIds: session.metadata.participantIds,
            target,
          },
          timestamp: Date.now(),
        }).catch(() => {});

        const outMsg = { target, content: response.trim(), replyTo: msg.id };
        try {
          await channel.send(outMsg);
        } catch (sendErr) {
          await deliveryQueue.enqueue(channel.id, outMsg, sendErr instanceof Error ? sendErr.message : String(sendErr));
        }
      } else {
        // Empty response — fallback
        console.error(`[${channel.id}] Empty response for: "${inboundText.slice(0, 50)}" (session ${session.id}, msgs: ${session.messages.length})`);
        const fallbackMsg = { target, content: '🤔 I processed your message but had nothing to say. Try rephrasing?', replyTo: msg.id };
        try {
          await channel.send(fallbackMsg);
        } catch (sendErr) {
          await deliveryQueue.enqueue(channel.id, fallbackMsg, sendErr instanceof Error ? sendErr.message : String(sendErr));
        }
      }

      // ─── Persist session to disk (agent loop pushes directly to session.messages) ──
      sessions.markSessionDirty(session.id);

      // ─── Reaction cleanup AFTER messages are sent ──────
      if (channel.removeReaction) {
        channel.removeReaction(target, msg.id, '🧐').catch(() => {});
      }
      if (channel.addReaction) {
        channel.addReaction(target, msg.id, hadError ? '😅' : '👍').catch(() => {});
      }
      } catch (outerErr) {
        // Per-message error isolation: log and continue, don't kill the process
        const errMsg = outerErr instanceof Error ? outerErr.message : String(outerErr);
        console.error(`[tako] Error processing message in ${channel.id}: ${errMsg}`);
        if (outerErr instanceof Error && outerErr.stack) {
          console.error(outerErr.stack);
        }
        // Try to send error reaction if possible
        if (channel.addReaction) {
          channel.addReaction(
            msg.channelId.includes(':') ? msg.channelId.split(':').slice(1).join(':') : msg.channelId,
            msg.id,
            '😅',
          ).catch(() => {});
        }
      }
    });
  }

  // ─── Message queue processor ────────────────────────────────────
  // Wire the processor callback now that wireChannel, sessions, and agentLoop exist.
  messageQueueProcessor = async (sessionId: string, messages: QueuedMessage[]) => {
    try {
    const session = sessions.get(sessionId);
    if (!session) {
      console.warn(`[message-queue] Session ${sessionId} not found, dropping ${messages.length} messages`);
      return;
    }

    const merged = MessageQueue.mergeMessages(messages);
    if (!merged.trim()) {
      console.warn(`[message-queue] Empty/invalid batch for session ${sessionId}, skipping`);
      return;
    }

    const channelRef = session.metadata?.channelRef as Channel | undefined;
    if (!channelRef) {
      console.warn(`[message-queue] No channel ref for session ${sessionId}, processing without channel`);
    }

    // ─── Concurrent run guard ────────────────────────────────────────
    // If this session is already being processed (e.g. stuck in a long tool loop),
    // don't silently queue the message — tell the user we're still working and
    // re-enqueue so we don't lose the message entirely.
    if (activeProcessingSessions.has(sessionId)) {
      console.warn(`[message-queue] Session ${sessionId} already processing — sending busy notice`);
      const target = (session.metadata?.channelTarget as string) ?? '';
      const lastMsgId = messages[messages.length - 1]?.messageId;
      if (channelRef && target) {
        await channelRef.send({
          target,
          content: '⏳ Still working on a previous task — your message has been queued and I\'ll get to it right after.',
          replyTo: lastMsgId,
        }).catch(() => {});
      }
      // Re-enqueue with a short delay so it gets processed once the current run finishes
      setTimeout(() => {
        for (const m of messages) messageQueue.enqueue(sessionId, m);
      }, 5_000);
      return;
    }

    activeProcessingSessions.add(sessionId);

    const activeLoop = getAgentLoop(session.metadata?.agentId as string | undefined);
    const repaired = sanitizeSessionMessages(session);
    if (repaired > 0) {
      console.warn(`[message-queue] Repaired ${repaired} malformed message(s) in ${session.id}`);
    }

    // Ensure loop has channel reference + latest message metadata for typing/reactions
    if (channelRef) {
      activeLoop.setChannel(channelRef);
      session.metadata.channelRef = channelRef;
    }
    const lastMsgId = messages[messages.length - 1]?.messageId;
    if (lastMsgId) {
      session.metadata.messageId = lastMsgId;
    }

    // Determine target for sending response
    const channelTarget = (session.metadata?.channelTarget as string) ?? '';
    const target = channelTarget;

    // Per-turn hard timeout — if the agent loop runs longer than this, abort it
    // so new inbound messages aren't blocked for hours.
    const TURN_TIMEOUT_MS = (config.agent?.turnTimeoutSeconds ?? 300) * 1000;

    const userMessage = merged;
    const mergedAttachments = messages.flatMap((m) => m.attachments ?? []);
    let response = '';
    let hadError = false;

    try {
      // Race the agent loop against a hard timeout
      const loopPromise = (async () => {
        for await (const chunk of activeLoop.run(session, userMessage, mergedAttachments)) {
          response += chunk;
        }
      })();

      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Turn timeout after ${TURN_TIMEOUT_MS / 1000}s`)), TURN_TIMEOUT_MS),
      );

      await Promise.race([loopPromise, timeoutPromise]);
    } catch (err) {
      hadError = true;
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[message-queue] Error processing batch for session ${sessionId}: ${errMsg}`);
      if (!response) response = formatUserFacingAgentError(err);
    } finally {
      activeProcessingSessions.delete(sessionId);
    }

    // Send response through the channel
    if (channelRef && target && response.trim()) {
      const replyMsgId = messages[messages.length - 1]?.messageId;
      try {
        await channelRef.send({ target, content: response.trim(), replyTo: replyMsgId });
      } catch (sendErr) {
        console.error(`[message-queue] Send error:`, sendErr instanceof Error ? sendErr.message : sendErr);
      }

      // Queue reaction lifecycle: 💭 -> ✅/⚠️
      if (replyMsgId) {
        if (channelRef.removeReaction) channelRef.removeReaction(target, replyMsgId, '💭').catch(() => {});
        if (channelRef.addReaction) channelRef.addReaction(target, replyMsgId, hadError ? '😅' : '👍').catch(() => {});
      }
    }

    sessions.markSessionDirty(sessionId);
    } catch (err) {
      console.error(`[message-queue] Unhandled processor error for session ${sessionId}:`, err instanceof Error ? err.message : err);
    }
  };

  // ─── Media storage ────────────────────────────────────────────────

  await initMediaStorage();

  // ─── Delivery queue ───────────────────────────────────────────────

  const deliveryQueue = new DeliveryQueue();
  await deliveryQueue.start();

  // ─── Initialize channels ──────────────────────────────────────────

  const channels: Channel[] = [];
  let discordChannel: DiscordChannel | undefined;
  const discordChannels: DiscordChannel[] = [];
  projectCoordinationRuntime = createProjectCoordinationRuntime({
    projectBindings,
    projectRegistry,
    sessions,
    principalRegistry,
    projectChannelCoordinators,
    buildProjectBackground: async (projectId, reason) => buildProjectBackground(projectId, reason),
    autoEnrollProjectRoomParticipant,
    normalizeDiscordPolicyIdentity,
  });
  const {
    projectRoomLifecycle,
    projectRoomNotifier,
  } = projectCoordinationRuntime;
  const {
    approvalButtonHandler,
  } = createApprovalRuntime({
    peerTaskApprovals,
    runtimePaths,
    notifyProjectRooms: projectRoomNotifier.notify,
    resumePeerTaskApproval,
    audit,
    principalRegistry,
    channelDeliveryRegistry,
  });
  let telegramChannel: TelegramChannel | undefined;

  const useTui = process.argv.includes('--tui') && process.stdout.isTTY;

  // Build available models list from config (primary + fallbacks + litellm + provider models)
  const availableModels = [config.providers.primary];
  if (config.providers.fallback) {
    for (const fb of config.providers.fallback) {
      if (!availableModels.includes(fb)) availableModels.push(fb);
    }
  }
  if (config.providers.litellm?.models) {
    for (const m of config.providers.litellm.models) {
      const ref = `litellm/${m}`;
      if (!availableModels.includes(ref)) availableModels.push(ref);
    }
  }
  // Add known provider models from registered providers
  for (const prov of [provider]) {
    for (const m of prov.models()) {
      const ref = `${m.provider}/${m.id}`;
      if (!availableModels.includes(ref)) availableModels.push(ref);
    }
  }

  if (useTui) {
    const tui = new TUIChannel({
      version: VERSION,
      model: config.providers.primary,
      toolCount: toolRegistry.getAllTools().length,
      skillCount: skillManifests.length,
      toolProfile: config.tools.profile,
      memoryStatus: embeddingProvider ? 'hybrid' : 'BM25-only',
      availableModels,
      agents: agentRegistry.list().map((a: any) => ({
        id: a.id,
        description: a.description,
        role: a.role,
        isMain: a.isMain,
      })),
      onModelSwitch: (modelRef: string) => {
        // Update the agent loop's model at runtime
        agentLoop.setModel(modelRef);
        config.providers.primary = modelRef;
      },
      onAgentSwitch: (agentId: string) => {
        const agent = agentRegistry.get(agentId);
        if (agent) {
          // Switch workspace — prompt builder reads SOUL.md, AGENTS.md, etc. from here
          promptBuilder.setWorkspace(agent.workspace);
          // Switch model if agent has a different one
          if (agent.model && agent.model !== agentLoop.getModel()) {
            agentLoop.setModel(agent.model);
          }
          // Update working dir for tools
          if (agent.workspace) {
            promptBuilder.setWorkingDir(agent.workspace);
          }
          console.log(`[tako] Switched to agent: ${agentId} (role=${agent.role}, workspace=${agent.workspace})`);
        }
      },
    });
    channels.push(tui);
    wireChannel(tui);

    // Hook tool calls to show in TUI with proper colors
    hooks.on('before_tool_call', (event: any) => {
      const tuiBridge = (globalThis as any).__takoTui;
      if (tuiBridge) {
        tuiBridge.addMessage({
          id: crypto.randomUUID(),
          role: 'tool',
          content: `Running...`,
          toolName: event.data.toolName,
          timestamp: new Date().toISOString(),
        });
      }
    });

    hooks.on('after_tool_call', (event: any) => {
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
    const cli = new CLIChannel(config.channels.cli);
    channels.push(cli);
    wireChannel(cli);
  }

  // If other channels exist, don't let CLI stdin close kill the process
  if (config.channels.discord?.token || config.channels.telegram?.token) {
    process.env['TAKO_KEEP_ALIVE'] = '1';
  }

  hooks.on('message_received', (event: any) => {
    audit.log({
      agentId: String(event.data.agentId ?? 'main'),
      sessionId: String(event.sessionId ?? 'unknown'),
      principalId: event.data.principalId as string | undefined,
      principalName: event.data.principalName as string | undefined,
      projectId: event.data.projectId as string | undefined,
      projectSlug: event.data.projectSlug as string | undefined,
      event: 'message_received',
      action: 'receive',
      details: {
        channelId: event.data.channelId,
        authorId: event.data.authorId,
      },
      success: true,
    }).catch(() => {});
  });

  hooks.on('session_start', (event: any) => {
    audit.log({
      agentId: String(event.data.agentId ?? 'main'),
      sessionId: String(event.sessionId ?? 'unknown'),
      principalId: event.data.principalId as string | undefined,
      principalName: event.data.principalName as string | undefined,
      projectId: event.data.projectId as string | undefined,
      projectSlug: event.data.projectSlug as string | undefined,
      event: 'session_start',
      action: 'create',
      details: {
        channelType: event.data.channelType,
        channelTarget: event.data.channelTarget,
        authorId: event.data.authorId,
      },
      success: true,
    }).catch(() => {});
  });

  hooks.on('message_sending', (event: any) => {
    audit.log({
      agentId: String(event.data.agentId ?? 'main'),
      sessionId: String(event.data.sessionId ?? 'unknown'),
      principalId: event.data.principalId as string | undefined,
      principalName: event.data.principalName as string | undefined,
      projectId: event.data.projectId as string | undefined,
      projectSlug: event.data.projectSlug as string | undefined,
      sharedSessionId: event.data.sharedSessionId as string | undefined,
      participantIds: event.data.participantIds as string[] | undefined,
      event: 'message_sent',
      action: 'send',
      details: {
        channelId: event.data.channelId,
        target: event.data.target,
      },
      success: true,
    }).catch(() => {});

    const networkSessionId = event.data.networkSessionId as string | undefined;
    const participantNodeIds = event.data.participantNodeIds as string[] | undefined;
    if (hubClient && identity && networkSessionId && participantNodeIds?.length) {
      const outboundEvent: NetworkSessionEvent = {
        eventId: crypto.randomUUID(),
        networkSessionId,
        projectId: String(event.data.projectId ?? ''),
        fromNodeId: identity.nodeId,
        fromPrincipalId: String(event.data.principalId ?? 'system'),
        type: 'message',
        audience: 'session-participants',
        targetNodeIds: participantNodeIds,
        payload: {
          text: typeof event.data.content === 'string' ? event.data.content : undefined,
          metadata: {
            channelId: event.data.channelId,
            projectSlug: event.data.projectSlug,
            sharedSessionId: event.data.sharedSessionId,
          },
        },
        createdAt: new Date().toISOString(),
      };
      void sendNetworkSessionEvent(hubClient, networkSharedSessions, trustStore, outboundEvent).catch((err) => {
        audit.log({
          agentId: String(event.data.agentId ?? 'main'),
          sessionId: String(event.data.sessionId ?? 'unknown'),
          principalId: event.data.principalId as string | undefined,
          principalName: event.data.principalName as string | undefined,
          projectId: event.data.projectId as string | undefined,
          projectSlug: event.data.projectSlug as string | undefined,
          sharedSessionId: event.data.sharedSessionId as string | undefined,
          participantIds: event.data.participantIds as string[] | undefined,
          event: 'permission_denied',
          action: 'network_session_send',
          details: {
            networkSessionId,
            participantNodeIds,
            error: err instanceof Error ? err.message : String(err),
          },
          success: false,
        }).catch(() => {});
      });
    }
  });

  hooks.on('after_tool_call', (event: any) => {
    const result = event.data.result ?? {};
    const params = event.data.params && typeof event.data.params === 'object'
      ? event.data.params as Record<string, unknown>
      : {};
    const peerApprovalId = typeof event.data.peerApprovalId === 'string'
      ? event.data.peerApprovalId
      : undefined;
    audit.log({
      agentId: String(event.data.agentId ?? 'main'),
      sessionId: String(event.sessionId ?? 'unknown'),
      principalId: event.data.principalId as string | undefined,
      principalName: event.data.principalName as string | undefined,
      projectId: event.data.projectId as string | undefined,
      projectSlug: event.data.projectSlug as string | undefined,
      sharedSessionId: event.data.sharedSessionId as string | undefined,
      participantIds: event.data.participantIds as string[] | undefined,
      event: 'tool_call',
      action: String(event.data.toolName ?? 'unknown'),
      details: params,
      success: Boolean(result.success),
    }).catch(() => {});
    if (peerApprovalId) {
      audit.log({
        agentId: String(event.data.agentId ?? 'main'),
        sessionId: String(event.sessionId ?? 'unknown'),
        principalId: event.data.principalId as string | undefined,
        principalName: event.data.principalName as string | undefined,
        projectId: event.data.projectId as string | undefined,
        projectSlug: event.data.projectSlug as string | undefined,
        sharedSessionId: event.data.sharedSessionId as string | undefined,
        participantIds: event.data.participantIds as string[] | undefined,
        event: 'agent_comms',
        action: 'peer_task_execute_approved',
        details: {
          approvalId: peerApprovalId,
          toolName: String(event.data.toolName ?? 'unknown'),
          params,
        },
        success: Boolean(result.success),
      }).catch(() => {});
    }
    if (event.data.denied) {
      audit.log({
        agentId: String(event.data.agentId ?? 'main'),
        sessionId: String(event.sessionId ?? 'unknown'),
        principalId: event.data.principalId as string | undefined,
        principalName: event.data.principalName as string | undefined,
        projectId: event.data.projectId as string | undefined,
        projectSlug: event.data.projectSlug as string | undefined,
        sharedSessionId: event.data.sharedSessionId as string | undefined,
        participantIds: event.data.participantIds as string[] | undefined,
        event: 'permission_denied',
        action: String(event.data.toolName ?? 'unknown'),
        details: {
          denialType: event.data.denialType,
          allowedToolRoot: event.data.allowedToolRoot,
          attemptedPath: event.data.attemptedPath,
          params,
          error: result.error,
          approvalId: peerApprovalId,
        },
        success: false,
      }).catch(() => {});
    }
  });

  hooks.on('agent_end', (event: any) => {
    audit.log({
      agentId: String(event.data.agentId ?? 'main'),
      sessionId: String(event.sessionId ?? 'unknown'),
      principalId: event.data.principalId as string | undefined,
      principalName: event.data.principalName as string | undefined,
      projectId: event.data.projectId as string | undefined,
      projectSlug: event.data.projectSlug as string | undefined,
      sharedSessionId: event.data.sharedSessionId as string | undefined,
      participantIds: event.data.participantIds as string[] | undefined,
      event: 'agent_run',
      action: 'run',
      details: { model: event.data.model ?? 'unknown', turns: event.data.turns ?? 0 },
      success: true,
    }).catch(() => {});
  });

  const handleSlashCommand = async (
    commandName: string,
    channelId: string,
    author: { id: string; name: string; meta?: Record<string, unknown> },
    agentId: string,
    boundChannel: Channel,
    guildId?: string,
  ): Promise<string | null> => {
      const principal = await principalRegistry.getOrCreateHuman({
      displayName: author.name,
      platform: 'discord',
      platformUserId: author.id,
      metadata: { channelId: `discord:${channelId}` },
    });
    const projectChannelTarget = channelId;
    const resolvedProject = resolveProject({
      platform: 'discord',
      channelTarget: projectChannelTarget,
      agentId,
    });
    const discordPolicy = await isDiscordInvocationAllowed({
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
      ? getProjectRole(projectMemberships, resolvedProject.project.projectId, principal.principalId) ?? undefined
      : undefined;
    const accessMetadata = await buildAgentAccessMetadata({
      platform: 'discord',
      agentId,
      authorId: author.id,
      principalId: principal.principalId,
      project: resolvedProject?.project ?? null,
      metadata: guildId ? { guildId } : undefined,
    });
    const channelKey = `discord:${channelId}`;
    const sessionKey = `agent:${agentId}:${channelKey}`;
    const session = sessions.getOrCreate(sessionKey, {
      name: `${agentId}/${channelKey}/${author.name}`,
      metadata: toSessionMetadata(buildInboundExecutionContext({
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
    let executionContext = buildInboundExecutionContext({
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
    const shared = await ensureSharedSession({ session, ctx: executionContext });
    if (shared) {
      executionContext = {
        ...executionContext,
        sharedSessionId: shared.sharedSessionId,
        ownerPrincipalId: shared.ownerPrincipalId,
        participantIds: shared.participantIds,
        activeParticipantIds: shared.activeParticipantIds,
      };
    }
    applyExecutionContextToSession(session, executionContext, boundChannel);

    if (resolvedProject && !isProjectMember(projectMemberships, resolvedProject.project.projectId, principal.principalId)) {
      const enrolled = await autoEnrollProjectRoomParticipant({
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

    const cmdResult = await commandRegistry.handle('/' + commandName, {
      ...toCommandContext(executionContext),
      session,
    });
    if (cmdResult !== null) return cmdResult;
    return null;
  };

  // Build native command list from the command registry
  const nativeCommandList = [
    ...commandRegistry.list(),
    { name: 'setup', description: 'Configure agent channels (Discord/Telegram)' },
  ];
  const mainDiscordSlashHandler = async (
    commandName: string,
    channelId: string,
    author: { id: string; name: string; meta?: Record<string, unknown> },
    guildId?: string,
  ) => {
    const agentId = resolveAgentForChannel(agentRegistry.list(), 'discord', channelId);
    return handleSlashCommand(commandName, channelId, author, agentId, discordChannel!, guildId);
  };

  const mainDiscordModelHandler = async (interaction: Parameters<typeof showModelPicker>[0]) => {
    const providerModelsMap: Record<string, string[]> = {};

    const anthropicProvider = new AnthropicProvider(
      config.providers.anthropic?.setupToken ?? config.providers.anthropic?.apiKey,
      undefined,
      config.providers.anthropic?.baseUrl,
    );
    providerModelsMap['anthropic'] = anthropicProvider.models().map((m) => m.id);

    const openaiProvider = new OpenAIProvider();
    providerModelsMap['openai'] = openaiProvider.models().map((m) => m.id);

    if (config.providers.litellm?.baseUrl) {
      const litellmModels = config.providers.litellm.models ?? [];
      if (litellmModels.length > 0) {
        providerModelsMap['litellm'] = litellmModels;
      } else if (provider.id === 'litellm') {
        providerModelsMap['litellm'] = provider.models().map((m) => m.id);
      }
    }

    const providers = Object.keys(providerModelsMap);
    if (providers.length === 0) return false;

    await showModelPicker(interaction, {
      getModel: () => agentLoop.getModel(),
      setModel: (ref: string) => {
        agentLoop.setModel(ref);
        config.providers.primary = ref;
        import('../config/resolve.js').then(m => m.patchConfig({ providers: { primary: ref } })).catch(() => {});
      },
      getDefaultModel: () => defaultModel,
      getProviders: () => providers,
      getModelsForProvider: (p: string) => providerModelsMap[p] ?? [],
    });

    return true;
  };

  const channelSetupController = createChannelSetupController({
    deps: {
      listAgents: () => agentRegistry.list().map((a) => ({ id: a.id, description: a.description })),
      saveChannelConfig: (agentId: string, channelType: string, cfg: Record<string, unknown>) =>
        agentRegistry.saveChannelConfig(agentId, channelType, cfg),
    },
    adapters: createBuiltinChannelSetupAdapters(channelPlatforms),
  });

  const composedChannels = await composeChannelRuntimes({
    config,
    agentRegistry,
    nativeCommandList,
    mainDiscordHandlers: config.channels.discord?.token ? {
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
        principalRegistry,
        sessions,
        commandRegistry,
        resolveProject,
        getProjectRole: (projectId, principalId) => getProjectRole(projectMemberships, projectId, principalId),
        buildAgentAccessMetadata,
        buildInboundExecutionContext,
        toSessionMetadata,
        ensureSharedSession,
        applyExecutionContextToSession,
        toCommandContext,
        isProjectMember: (projectId, principalId) => isProjectMember(projectMemberships, projectId, principalId),
      },
    }),
    projectRoomLifecycle,
    projectChannelCoordinators,
    channelDeliveryRegistry,
    registerChannel: (channel) => {
      channels.push(channel);
      wireChannel(channel);
    },
    channelSetupController,
    approvalButtonHandler,
    platformRegistry: channelPlatforms,
  });
  discordChannel = composedChannels.discordChannel;
  telegramChannel = composedChannels.telegramChannel;
  discordChannels.push(...composedChannels.discordChannels.filter((channel) => !discordChannels.includes(channel)));

  // ─── Skill runtime extensions ─────────────────────────────────────
  const loadedSkills = skillLoader.getAll();
  await loadSkillRuntimeExtensions({
    loadedSkills,
    skillChannelsConfig: config.skillChannels,
    skillExtensionsConfig: config.skillExtensions,
    registerChannel: (channel, source) => {
      channelPlatforms.register({
        id: channel.id,
        displayName: source,
      });
      channels.push(channel);
      wireChannel(channel);
      console.log(`[tako] Loaded ${source}: ${channel.id}`);
    },
  });

  const messageSurfaceResolver = createMessageSurfaceResolver({
    channels,
    discordChannels,
    discordFallback: discordChannel,
    telegramFallback: telegramChannel,
  });

  registerSurfaceToolPacks({
    toolRegistry,
    messageTools: {
      resolveSurface: messageSurfaceResolver.resolveMessageSurface,
    },
    introspectTools: {
      config,
      sessions,
      startTime,
      channels,
      agentIds: agentRegistry.list().map((a: any) => a.id),
      skillCount: skillManifests.length,
      version: VERSION,
    },
  });

  // ─── Start Gateway ────────────────────────────────────────────────

  // Allow env override for gateway bind (needed for Docker: bind 0.0.0.0 inside container)
  if (process.env['TAKO_GATEWAY_BIND']) {
    config.gateway.bind = process.env['TAKO_GATEWAY_BIND'];
  }
  if (process.env['TAKO_GATEWAY_PORT']) {
    config.gateway.port = parseInt(process.env['TAKO_GATEWAY_PORT'], 10);
  }
  nodeIdentity = await loadOrCreateNodeIdentity({
    mode: 'edge',
    home: runtimePaths.home,
    bind: config.gateway.bind,
    port: config.gateway.port,
    hub: config.network?.hub,
  });
  const identity = nodeIdentity;
  await principalRegistry.seedReservedPrincipal({
    type: 'local-agent',
    displayName: identity.name,
    metadata: { nodeId: identity.nodeId, mode: 'edge' },
  });
  await principalRegistry.seedReservedPrincipal({
    type: 'system',
    displayName: 'system',
    metadata: { nodeId: identity.nodeId, mode: 'edge' },
  });
  console.log(`[tako] node=${identity.nodeId} bind=${config.gateway.bind} port=${config.gateway.port}${config.network?.hub ? ` hub=${config.network.hub}` : ''}`);

  const gateway = new Gateway(config.gateway, {
    sessions,
    agentLoop,
    hooks,
    sandboxManager,
    retryQueue,
    sessionConfig: config.session,
    contextManager,
    provider: failoverProvider,
  });
  await gateway.start();
  const handleNetworkSessionEvent = async (event: NetworkSessionEvent) => {
    if (!hubClient) return;

    if (event.type === 'delegation_request' && event.payload.delegationRequest) {
      const request = event.payload.delegationRequest;
      await delegationStore.saveIncomingRequest(request);
      const trust = trustStore.getByNodeId(request.fromNodeId);
      const capability = capabilityRegistry.get(request.capabilityId);
      const project = projectRegistry.get(request.projectId);
      const verdict = evaluateDelegationRequest({
        trust,
        capability,
        projectId: request.projectId,
        remoteProjectRole: null,
      });
      const ctx = buildExecutionContext({
        nodeIdentity: identity,
        home: runtimePaths.home,
        agentId: 'main',
        workspaceRoot: config.memory.workspace,
        projectRoot: project ? resolveProjectRoot(runtimePaths, project) : undefined,
        allowedToolRoot: project ? resolveProjectRoot(runtimePaths, project) : config.memory.workspace,
        project,
        metadata: {
          delegationRequestId: request.requestId,
        },
      });
      const result = verdict.allowed
        ? await delegationExecutor.execute(request, ctx)
        : {
            requestId: request.requestId,
            projectId: request.projectId,
            fromNodeId: request.fromNodeId,
            toNodeId: request.toNodeId,
            status: 'denied' as const,
            summary: `Delegation denied: ${verdict.reason}`,
            error: verdict.reason,
            createdAt: new Date().toISOString(),
          };
      await delegationStore.saveResult(result);
      audit.log({
        agentId: 'main',
        sessionId: event.networkSessionId,
        projectId: request.projectId,
        event: verdict.allowed ? 'agent_comms' : 'permission_denied',
        action: verdict.allowed ? 'delegation_execute' : 'delegation_deny',
        details: {
          requestId: request.requestId,
          capabilityId: request.capabilityId,
          fromNodeId: request.fromNodeId,
          reason: verdict.reason,
        },
        success: verdict.allowed,
      }).catch(() => {});
      const responseEvent: NetworkSessionEvent = {
        eventId: crypto.randomUUID(),
        networkSessionId: event.networkSessionId,
        projectId: request.projectId,
        fromNodeId: identity.nodeId,
        fromPrincipalId: 'system',
        type: 'delegation_result',
        audience: 'specific-nodes',
        targetNodeIds: [request.fromNodeId],
        payload: {
          delegationResult: result,
          summary: result.summary,
          metadata: {
            requestId: request.requestId,
            capabilityId: request.capabilityId,
          },
        },
        createdAt: new Date().toISOString(),
      };
      await sendNetworkSessionEvent(hubClient, networkSharedSessions, trustStore, responseEvent);
      return;
    }

    if (event.type === 'delegation_result' && event.payload.delegationResult) {
      const result = event.payload.delegationResult;
      await delegationStore.saveResult(result);
      const networkSession = networkSharedSessions.get(event.networkSessionId);
      const localBinding = networkSession?.localSessionBindings.find((binding) => binding.nodeId === identity.nodeId);
      if (localBinding && sessions.get(localBinding.localSessionId)) {
        sessions.addMessage(localBinding.localSessionId, {
          role: 'assistant',
          name: `delegation:${event.fromNodeId}`,
          content: `[delegation ${result.status}] ${result.summary}`,
        });
      }
      audit.log({
        agentId: 'main',
        sessionId: event.networkSessionId,
        projectId: result.projectId,
        event: 'agent_comms',
        action: 'delegation_result_received',
        details: {
          requestId: result.requestId,
          fromNodeId: event.fromNodeId,
          status: result.status,
        },
        success: result.status === 'ok',
      }).catch(() => {});
      await projectRoomNotifier.notify(result.projectId, `[#${event.fromNodeId}] delegation ${result.status}: ${result.summary}`);
      return;
    }

    if (event.type === 'join' && event.projectId) {
      const existing = networkSharedSessions.get(event.networkSessionId);
      if (existing) {
        await networkSharedSessions.upsertSession({
          ...existing,
          participantNodeIds: Array.from(new Set([...(existing.participantNodeIds ?? []), event.fromNodeId])),
          participantPrincipalIds: Array.from(new Set([
            ...(existing.participantPrincipalIds ?? []),
            ...(typeof event.payload.metadata?.participantPrincipalId === 'string'
              ? [event.payload.metadata.participantPrincipalId]
              : []),
          ])),
        });
      }
      await activateCollaborativeProject(
        event.projectId,
        `network_join:${String(event.payload.metadata?.joinKind ?? 'join')}:${event.fromNodeId}`,
      );
      const snapshot = await buildProjectBackground(
        event.projectId,
        `network_join:${String(event.payload.metadata?.joinKind ?? 'join')}:${event.fromNodeId}`,
      );
      const who = typeof event.payload.metadata?.participantPrincipalName === 'string'
        ? event.payload.metadata.participantPrincipalName
        : typeof event.payload.metadata?.nodeName === 'string'
          ? event.payload.metadata.nodeName
          : event.fromNodeId;
      const lines = [`[network join] ${who} joined ${event.payload.metadata?.projectSlug ?? event.projectId}`];
      if (snapshot?.summary) lines.push('', snapshot.summary);
      await projectRoomNotifier.notify(event.projectId, lines.join('\n'));
      return;
    }

    if (event.type === 'artifact_publish' && event.payload.artifactEnvelope) {
      const project = projectRegistry.get(event.projectId);
      if (!project) {
        return;
      }
      const artifacts = new ProjectArtifactRegistry(defaultProjectArtifactsRoot(runtimePaths, project.projectId), project.projectId);
      await artifacts.load();
      const artifact = await importArtifactEnvelope(artifacts, event.payload.artifactEnvelope);
      if (artifact.kind === 'patch' && project.collaboration?.patchRequiresApproval) {
        const approvals = new ProjectApprovalRegistry(projectApprovalsRoot(runtimePaths, project.projectId), project.projectId);
        await approvals.load();
        const existingApproval = approvals.findPendingByArtifact(artifact.artifactId);
        const sourceBranch = typeof artifact.metadata?.repo === 'object' && artifact.metadata?.repo && typeof (artifact.metadata.repo as Record<string, unknown>).branch === 'string'
          ? String((artifact.metadata.repo as Record<string, unknown>).branch)
          : undefined;
        if (!existingApproval) {
          const createdApproval = await approvals.create({
            artifactId: artifact.artifactId,
            artifactName: artifact.name,
            requestedByNodeId: event.fromNodeId,
            requestedByPrincipalId: event.fromPrincipalId,
            sourceBranch,
          });
          await notifyPatchApprovalReview({
            projectId: project.projectId,
            approvalId: createdApproval.approvalId,
            artifactName: createdApproval.artifactName,
            requestedByNodeId: createdApproval.requestedByNodeId,
            requestedByPrincipalId: createdApproval.requestedByPrincipalId,
            sourceBranch: createdApproval.sourceBranch,
          });
        }
      }
      await buildProjectBackground(project.projectId, `artifact_sync:${artifact.artifactId}`);
      audit.log({
        agentId: 'main',
        sessionId: event.networkSessionId,
        projectId: project.projectId,
        projectSlug: project.slug,
        event: 'agent_comms',
        action: 'artifact_sync_receive',
        details: {
          artifactId: artifact.artifactId,
          artifactName: artifact.name,
          artifactKind: artifact.kind,
          fromNodeId: event.fromNodeId,
        },
        success: true,
      }).catch(() => {});
      const pendingApproval = artifact.kind === 'patch' && project.collaboration?.patchRequiresApproval
        ? await (async () => {
            const approvals = new ProjectApprovalRegistry(projectApprovalsRoot(runtimePaths, project.projectId), project.projectId);
            await approvals.load();
            return approvals.findPendingByArtifact(artifact.artifactId);
          })()
        : null;
      const patchHint = artifact.kind === 'patch' && pendingApproval
        ? `\nReview in Discord: /patches or /patchapprove ${pendingApproval.approvalId}`
        : '';
      await projectRoomNotifier.notify(project.projectId, `[#${event.fromNodeId}] synced ${artifact.kind} artifact: ${artifact.name}${patchHint}`);
      return;
    }

    if (event.type === 'message' && event.payload.text && event.projectId) {
      await buildProjectBackground(event.projectId, `network_message:${event.fromNodeId}`);
      await projectRoomNotifier.notify(event.projectId, `[#${event.fromNodeId}] ${event.payload.text}`);
    }
  };

  const networkRuntime = await startNetworkRuntime({
    hubClient,
    config,
    identity,
    capabilityRegistry,
    projectRegistry,
    projectMemberships,
    networkSharedSessions,
    sessions,
    onEvent: handleNetworkSessionEvent,
  });
  stopHubHeartbeat = networkRuntime.stopHubHeartbeat;
  stopNetworkPolling = networkRuntime.stopNetworkPolling;

  // Set status info for TUI clients
  gateway.setStatusInfo({
    model: config.providers.primary,
    tools: toolRegistry.getActiveTools().length,
    skills: skillManifests.length,
    channels: channels.map((c) => c.id),
  });

  // Write PID file for daemon management
  await writePidFile({
    pid: process.pid,
    startedAt: new Date().toISOString(),
    port: config.gateway.port,
    bind: config.gateway.bind,
    mode: 'edge',
    home: runtimePaths.home,
    nodeId: identity.nodeId,
    configPath: config._configPath,
  });

  // ─── SIGUSR1 — Graceful config reload ──────────────────────────

  process.on('SIGUSR1', async () => {
    console.log('[tako] Received SIGUSR1 — reloading config...');
    try {
      const newConfig = await resolveConfig();
      // Update model
      if (newConfig.providers.primary !== config.providers.primary) {
        agentLoop.setModel(newConfig.providers.primary);
        config.providers.primary = newConfig.providers.primary;
        console.log(`[tako] Model updated to: ${newConfig.providers.primary}`);
      }
      // Update tool profile
      if (newConfig.tools.profile !== config.tools.profile) {
        toolRegistry.setProfile(newConfig.tools.profile);
        config.tools.profile = newConfig.tools.profile;
        console.log(`[tako] Tool profile updated to: ${newConfig.tools.profile}`);
      }
      // Reload skills
      const newManifests = await skillLoader.discover();
      for (const manifest of newManifests) {
        const loaded = await skillLoader.load(manifest);
        skillLoader.registerTools(loaded, toolRegistry);
        skillLoader.registerHooks(loaded, hooks);
      }
      console.log(`[tako] Config reload complete. Skills: ${newManifests.length}`);

      // Update gateway status info
      gateway.setStatusInfo({
        model: config.providers.primary,
        tools: toolRegistry.getActiveTools().length,
        skills: newManifests.length,
        channels: channels.map((c) => c.id),
      });
    } catch (err) {
      console.error('[tako] Config reload failed:', err instanceof Error ? err.message : err);
    }
  });

  // ─── Cron Scheduler ────────────────────────────────────────────────

  const { CronScheduler } = await import('../core/cron.js');
  const cronScheduler = new CronScheduler();

  cronScheduler.setHandlers({
    agentTurn: async (message: string, model?: string) => {
      const cronSession = sessions.create({ name: 'cron', metadata: { isCron: true } });
      let response = '';
      for await (const chunk of agentLoop.run(cronSession, message)) {
        response += chunk;
      }
      return response;
    },
    systemEvent: (text: string) => {
      // Inject into main session
      const mainSession = sessions.get('main') ?? sessions.create({ name: 'main' });
      sessions.addMessage(mainSession.id, { role: 'system', content: text });
    },
    delivery: (result, delivery) => {
      if (delivery.mode === 'announce' && delivery.channel) {
        const ch = channels.find((c) => c.id === delivery.channel || c.id.startsWith(delivery.channel!));
        if (ch) {
          ch.send({ target: delivery.to ?? '', content: `📋 **${result.jobName}**\n${result.response.slice(0, 1500)}` });
        }
      }
    },
  });

  registerCronToolPack({
    toolRegistry,
    cronScheduler,
  });
  await cronScheduler.start();

  // ─── Session idle sweep ──────────────────────────────────────────
  // Every 2 minutes, check for sessions idle > 24h and archive them.
  // Files stay on disk — only removed from active maps.

  const idleSweepTimer = setInterval(async () => {
    const expired = sessions.sweepIdle();
    let archivedCount = 0;
    for (const session of expired) {
      // Only auto-expire sub-agent sessions and ACP sessions.
      // Never end user-initiated channel sessions (discord/telegram/cli) —
      // those persist indefinitely and get compressed when context grows large.
      const isSubAgent = session.metadata.isSubAgent as boolean | undefined;
      const isAcp = session.metadata.isAcp as boolean | undefined;
      if (!isSubAgent && !isAcp) {
        continue; // skip — user session, leave it alive
      }

      const channelType = session.metadata.channelType as string | undefined;
      const target = session.metadata.channelTarget as string | undefined;
      if (channelType && target) {
        const channel = channels.find((ch) => ch.id === channelType);
        if (channel) {
          await channel.send({
            target,
            content: '⚙️ Session ended automatically after 24h of inactivity.',
          }).catch(() => {});
        }
      }
      sessions.archiveSession(session.id);
      archivedCount++;
    }
    if (archivedCount > 0) {
      console.log(`[tako] Archived ${archivedCount} idle sub-agent/ACP session(s)`);
    }

    // Sweep expired thread bindings (24h idle)
    const expiredBindings = threadBindings.sweepExpired();
    for (const binding of expiredBindings) {
      const discordCh = channels.find((ch) => ch.id === 'discord');
      if (discordCh) {
        await discordCh.send({
          target: binding.threadId,
          content: '⚙️ Session ended automatically after 24h of inactivity. Messages here will no longer be routed.',
        }).catch(() => {});

        // Archive the thread
        if ('archiveThread' in discordCh && typeof (discordCh as any).archiveThread === 'function') {
          await (discordCh as any).archiveThread(binding.threadId).catch(() => {});
        }
      }
    }
    if (expiredBindings.length > 0) {
      await threadBindings.save();
      console.log(`[tako] Swept ${expiredBindings.length} expired thread binding(s)`);
    }
  }, 120_000);

  // ─── Daily 4 AM session rotation ──────────────────────────────────
  // Start fresh sessions every day at 4:00 AM local time.
  // Old session files stay on disk for history.

  let rotationTimeout: ReturnType<typeof setTimeout> | null = null;

  function scheduleNextRotation() {
    const now = new Date();
    const next4am = new Date(now);
    next4am.setHours(4, 0, 0, 0);
    if (next4am <= now) {
      next4am.setDate(next4am.getDate() + 1);
    }
    const delay = next4am.getTime() - now.getTime();
    console.log(`[tako] Next session rotation at 4:00 AM (in ${Math.round(delay / 60000)}min)`);

    rotationTimeout = setTimeout(async () => {
      console.log('[tako] Running daily 4 AM session rotation...');
      try {
        const result = await sessions.rotateAllSessions();
        console.log(`[tako] Rotated: ${result.archived.length} archived, ${result.created.length} created`);
      } catch (err) {
        console.error('[tako] Rotation error:', err instanceof Error ? err.message : err);
      }
      scheduleNextRotation();
    }, delay);
  }
  scheduleNextRotation();

  // ─── Shutdown ─────────────────────────────────────────────────────

  const blockingIds = new Set(['cli', 'tui']);

  async function shutdown() {
    console.log('\n[tako] Shutting down...');

    // Log shutdown — don't broadcast to channels (too noisy on restarts)
    console.log('⚙️ Tako going offline.');

    clearInterval(idleSweepTimer);
    if (rotationTimeout) clearTimeout(rotationTimeout);
    stopHubHeartbeat?.();
    stopHubHeartbeat = null;
    stopNetworkPolling?.();
    stopNetworkPolling = null;
    messageQueue.clear();
    await threadBindings.save();
    cronScheduler.stop();
    skillLoader.stopWatching();
    deliveryQueue.stop();
    for (const ch of channels) {
      await ch.disconnect().catch(() => {});
    }
    await gateway.stop();
    await acpSessionManager.shutdown();
    await sandboxManager.shutdown();
    await sessions.shutdown();
    await removePidFile();
  }

  process.on('SIGINT', async () => { await shutdown(); process.exit(0); });
  process.on('SIGTERM', async () => { await shutdown(); process.exit(0); });

  // ─── Print startup banner ─────────────────────────────────────────

  const embeddingStatus = embeddingProvider ? 'vector+BM25' : 'BM25-only';
  const channelNames = channels.map((c) => c.id).join(', ');
  const loadedSkillNames = skillLoader.getAll().map((s) => s.manifest.name);

  // TUI has its own header — skip the text banner
  if (!useTui) {
    console.log(`Tako 🐙 v${VERSION}`);
    console.log(`Provider: ${resolvedProviderLabel}`);
    console.log(`Tools: ${toolRegistry.getActiveTools().length} active (profile: ${config.tools.profile})`);
    console.log(`Memory: ${embeddingStatus}`);
    console.log(`Skills: ${loadedSkillNames.length} loaded (${loadedSkillNames.join(', ') || 'none'})`);
    console.log(`Channels: ${channelNames}`);
    console.log(`Sandbox: ${config.sandbox.mode}${config.sandbox.mode !== 'off' ? ` (scope: ${config.sandbox.scope}, workspace: ${config.sandbox.workspaceAccess})` : ''}`);
    console.log(`Agents: ${agentRegistry.list().length} registered (${agentRegistry.list().map((a) => a.id).join(', ')})`);
    console.log(`Gateway: ws://${config.gateway.bind}:${config.gateway.port}`);
    console.log('Type /quit to exit.\n');
  }

  // Connect channels (CLI/TUI last since they block on input)
  for (const ch of channels) {
    if (!blockingIds.has(ch.id)) {
      try {
        await ch.connect();
      } catch (err) {
        console.error(`[${ch.id}] ✗ Failed to connect: ${err instanceof Error ? err.message : err}`);
        console.error(`[${ch.id}]   Check your token/config with \`tako onboard\``);
      }
    }
  }
  // Helper: send a system message to all connected non-blocking channels
  async function broadcastToChannels(text: string, includeAgentChannels = false): Promise<void> {
    for (const ch of channels) {
      if (blockingIds.has(ch.id)) continue;
      if (!includeAgentChannels && ch.agentId) continue;
      try {
        if (ch.broadcast) {
          await ch.broadcast(text);
        }
      } catch { /* channel may not be connected yet */ }
    }
  }

  // Wait a moment for channels to fully connect (Discord ClientReady, etc.)
  const hasExternalChannels = channels.some((ch) => !blockingIds.has(ch.id));
  if (hasExternalChannels) {
    await new Promise((r) => setTimeout(r, 2000));
  }

  // Activation intro broadcast intentionally disabled.

  // Log startup — don't broadcast to channels (too noisy on restarts)
  console.log(`🐙 Tako online — model: ${config.providers.primary}`);

  // Deliver restart note if one exists (from a prior system_restart call)
  try {
    const { readFileSync, unlinkSync } = await import('node:fs');
    const restartNotePath = getRuntimePaths().restartNoteFile;
    const raw = readFileSync(restartNotePath, 'utf-8');
    const restartNote = JSON.parse(raw) as { note: string; sessionKey?: string; channelId?: string; agentId?: string; timestamp: string };
    unlinkSync(restartNotePath);

    const noteText = `⚙️ ${restartNote.note}`;
    console.log(`[tako] Post-restart: ${restartNote.note}`);

    // Deliver to the originating channel if we know it, otherwise broadcast
    let delivered = false;
    if (restartNote.channelId) {
      // Find the agent's channel that can send to this specific channel
      const targetAgentId = restartNote.agentId || 'main';
      const agentChannel = channels.find((ch) => ch.agentId === targetAgentId && !blockingIds.has(ch.id))
        ?? channels.find((ch) => !blockingIds.has(ch.id));
      if (agentChannel?.sendToChannel) {
        try {
          await agentChannel.sendToChannel(restartNote.channelId, noteText);
          delivered = true;
        } catch (err) {
          console.warn('[tako] Failed to deliver restart note to originating channel:', err);
        }
      }
    }
    if (!delivered) {
      // Fallback: broadcast to all channels
      await broadcastToChannels(noteText);
    }
  } catch { /* no restart note, normal boot */ }

  // Connect the blocking channel (CLI or TUI) last
  const blockingChannel = channels.find((ch) => blockingIds.has(ch.id));
  if (blockingChannel) {
    await blockingChannel.connect();
  }
}

// ─── tako start --daemon ─────────────────────────────────────────────

// ─── tako stop ──────────────────────────────────────────────────────

// ─── tako restart ───────────────────────────────────────────────────

// ─── tako tui ───────────────────────────────────────────────────────

// ─── tako dev ───────────────────────────────────────────────────────

// ─── tako doctor ─────────────────────────────────────────────────────
