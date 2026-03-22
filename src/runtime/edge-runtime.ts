/**
 * Edge runtime composition and bootstrap.
 *
 * This module owns the long-lived edge process startup path. The CLI entrypoint
 * delegates here instead of embedding the runtime bootstrap inside src/index.ts.
 */
import { join, resolve } from 'node:path';
import { resolveConfig } from '../config/resolve.js';
import { writePidFile } from '../daemon/pid.js';
import { createMessageSurfaceResolver } from '../channels/surface-capabilities.js';
import { createBuiltinChannelPlatformRegistry, inferChannelPlatformFromChannelId, type ChannelPlatform } from '../channels/platforms.js';
import type { DiscordChannel } from '../channels/discord.js';
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
import { SessionManager } from '../gateway/session.js';
import { SessionCompactor } from '../gateway/compaction.js';
import { TakoHookSystem } from '../hooks/hooks.js';
import { createEmbeddingProvider } from '../memory/embeddings.js';
import { buildAgentSkillLoader, initializeSkillRuntime } from '../skills/runtime-loader.js';
import { bootstrapWorkspace, ensureDailyMemory } from '../core/bootstrap.js';
import { SandboxManager } from '../sandbox/sandbox.js';
import { AgentRegistry } from '../agents/registry.js';
import { resolveAgentForChannel } from '../agents/config.js';
import { SubAgentOrchestrator } from '../agents/subagent.js';
import { ThreadBindingManager } from '../core/thread-bindings.js';
import type { Channel } from '../channels/channel.js';
import { CommandRegistry } from '../commands/registry.js';
import { installFileLogger } from '../utils/logger.js';
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
import { registerKernelToolPacks, registerRuntimeToolPacks, registerSurfaceToolPacks } from '../core/tool-composition.js';
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
  type ExecutionContext,
} from '../core/execution-context.js';
import { createProjectCoordinationRuntime } from './project-coordination.js';
import { createApprovalRuntime } from './approval-runtime.js';
import { startNetworkRuntime } from './network-runtime.js';
import { createProjectRuntime } from './project-runtime.js';
import { createEdgeSessionRuntime } from './edge-session-runtime.js';
import { createEdgeChannelRuntime } from './edge-channel-runtime.js';
import { composeEdgeRuntimeChannels, createEdgeGateway } from './edge-channel-composition.js';
import { startEdgeLifecycle } from './edge-lifecycle.js';

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

  // Thread bindings (Discord thread → sub-agent session routing)
  const { homedir } = await import('node:os');
  const threadBindings = new ThreadBindingManager(
    getRuntimePaths().threadBindingsFile,
  );
  await threadBindings.load();
  const {
    resolvePrincipal,
    buildInboundExecutionContext,
    applyExecutionContextToSession,
    ensureSharedSession,
    sanitizeSessionMessages,
    getSession,
  } = createEdgeSessionRuntime({
    config,
    runtimePaths,
    sessions,
    principalRegistry,
    projectRegistry,
    projectMemberships,
    sharedSessionRegistry,
    networkSharedSessions,
    threadBindings,
    channelPlatforms,
    hooks,
    audit,
    getNodeIdentity,
    resolveAgentId: ({ platform, channelTarget, guildId, channelAgentId }) =>
      channelAgentId ?? resolveAgentForChannel(agentRegistry.list(), platform, channelTarget, guildId),
    onThreadAcpMessage: async ({ sessionKey, content, channelTarget, channel }) => {
      if (!sessionKey.includes(':acp:') || !acpRuntime?.isHealthy()) return false;
      const { handleAcpThreadMessage } = await import('../tools/agent-tools.js');
      return handleAcpThreadMessage(
        sessionKey,
        content,
        channelTarget,
        channel as DiscordChannel,
        acpRuntime,
      );
    },
    onSharedSessionParticipantJoined: async ({ shared, ctx }) => {
      await activateCollaborativeProject(shared.projectId, `participant_join:${ctx.principalId}`);
      const snapshot = await buildProjectBackground(shared.projectId, `participant_join:${ctx.principalId}`, shared);
      const collaborativeProject = projectRegistry.get(shared.projectId);
      const suppressLocalDiscordJoinNotice = ctx.platform === 'discord'
        && !!ctx.principalId
        && isProjectMember(projectMemberships, shared.projectId, ctx.principalId);
      if (collaborativeProject?.collaboration?.announceJoins !== false && !suppressLocalDiscordJoinNotice) {
        const who = ctx.principalName ?? ctx.authorName ?? ctx.principalId ?? 'unknown';
        if (!projectCoordinationRuntime) throw new Error('Project coordination runtime not initialized');
        await projectCoordinationRuntime.projectRoomNotifier.notify(shared.projectId, formatSharedSessionJoinNotice({
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
          fromPrincipalId: ctx.principalId ?? 'system',
          type: 'join',
          audience: 'specific-nodes',
          targetNodeIds: networkSession.participantNodeIds,
          payload: {
            summary: `${ctx.principalName ?? ctx.authorName ?? ctx.principalId} joined ${collaborativeProject?.slug ?? shared.projectId}`,
            metadata: {
              joinKind: 'principal_join',
              participantPrincipalId: ctx.principalId,
              participantPrincipalName: ctx.principalName ?? ctx.authorName,
              projectSlug: collaborativeProject?.slug,
            },
          },
          createdAt: new Date().toISOString(),
        }).catch(() => {});
      }
    },
  });

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

  // ─── Media storage ────────────────────────────────────────────────

  await initMediaStorage();

  // ─── Delivery queue ───────────────────────────────────────────────

  const deliveryQueue = new DeliveryQueue();
  await deliveryQueue.start();

  // ─── Initialize channels ──────────────────────────────────────────

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
  let shutdown: () => Promise<void> = async () => {
    throw new Error('Edge lifecycle not initialized');
  };
  const { wireChannel, createMessageQueueProcessor } = createEdgeChannelRuntime({
    config,
    audit,
    hooks,
    sessions,
    projectMemberships,
    commandRegistry,
    messageQueue,
    deliveryQueue,
    channelPlatforms,
    defaultModel,
    activeProcessingSessions,
    resolvePrincipal,
    buildInboundExecutionContext,
    applyExecutionContextToSession,
    sanitizeSessionMessages,
    getSession,
    resolveProject,
    buildAgentAccessMetadata,
    isDiscordInvocationAllowed,
    autoEnrollProjectRoomParticipant,
    sweepProjectRoomSignal,
    resolveInboundAgentId: ({ channel, channelType, channelTarget, guildId }) =>
      channel.agentId ?? resolveAgentForChannel(agentRegistry.list(), channelType, channelTarget, guildId),
    shouldThrottlePeerAgentMessage,
    getAgentLoop,
    persistInboundAttachments: persistAttachments,
    shutdown: async () => shutdown(),
    formatUserFacingAgentError,
  });
  messageQueueProcessor = createMessageQueueProcessor();
  const {
    channels,
    discordChannel,
    telegramChannel,
    discordChannels,
  } = await composeEdgeRuntimeChannels({
    config,
    version: VERSION,
    startTime,
    toolRegistry,
    embeddingProvider,
    agentRegistry,
    commandRegistry,
    principalRegistry,
    sessions,
    projectMemberships,
    projectRuntime: {
      resolveProject,
      buildAgentAccessMetadata,
      isDiscordInvocationAllowed,
      autoEnrollProjectRoomParticipant,
    },
    sessionRuntime: {
      buildInboundExecutionContext,
      ensureSharedSession,
      applyExecutionContextToSession,
    },
    hooks,
    promptBuilder,
    skillLoader,
    skillManifests,
    channelPlatforms,
    projectRoomLifecycle,
    projectChannelCoordinators,
    channelDeliveryRegistry,
    approvalButtonHandler,
    wireChannel,
    getAgentLoop,
    provider,
    defaultModel,
  });

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
  const gateway = createEdgeGateway({
    config,
    sessions,
    agentLoop,
    hooks,
    sandboxManager,
    retryQueue,
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
  const lifecycle = await startEdgeLifecycle({
    config,
    runtimePaths,
    version: VERSION,
    resolvedProviderLabel,
    embeddingProvider,
    channels,
    agentRegistry,
    toolRegistry,
    skillLoader,
    sessions,
    threadBindings,
    messageQueue,
    deliveryQueue,
    gateway,
    agentLoop,
    hooks,
    getActiveToolCount: () => toolRegistry.getActiveTools().length,
    stopHubHeartbeat: () => {
      stopHubHeartbeat?.();
      stopHubHeartbeat = null;
    },
    stopNetworkPolling: () => {
      stopNetworkPolling?.();
      stopNetworkPolling = null;
    },
    acpSessionManager,
    sandboxManager,
  });
  shutdown = lifecycle.shutdown;
}

// ─── tako start --daemon ─────────────────────────────────────────────

// ─── tako stop ──────────────────────────────────────────────────────

// ─── tako restart ───────────────────────────────────────────────────

// ─── tako tui ───────────────────────────────────────────────────────

// ─── tako dev ───────────────────────────────────────────────────────

// ─── tako doctor ─────────────────────────────────────────────────────
