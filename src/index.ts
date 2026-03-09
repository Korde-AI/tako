#!/usr/bin/env bun
/**
 * Tako 🐙 — Agent-as-CPU OS: minimal core + pluggable skill arms.
 *
 * CLI entry point with subcommands:
 *   tako              Start interactive agent (alias for `tako start`)
 *   tako start        Start the agent in foreground (default)
 *   tako start -d     Start as background daemon
 *   tako stop         Stop the daemon
 *   tako restart      Restart the daemon
 *   tako status       Show daemon & runtime status
 *   tako tui          Attach TUI to running daemon
 *   tako dev          Development mode (watch + auto-restart)
 *   tako onboard      Interactive first-time setup wizard
 *   tako doctor       Run health checks
 *   tako models       Model management (list, set, auth, status)
 *   tako channels     Channel management (list, add, remove, status)
 *   tako skills list  List discovered skills
 *   tako skills install <name>  Install a skill from the ecosystem
 *   tako skills info <name>     Show skill details
 *   tako agents       Agent management (list, add, remove, info)
 *   tako sessions     Session management (list, history)
 *   tako version      Print version
 *   tako help         Show help
 */

import { join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { resolveConfig, hasConfig } from './config/resolve.js';
import { runOnboard } from './onboard/onboard.js';
import { runModels } from './onboard/models.js';
import { runChannels } from './onboard/channels.js';
import { runStartDaemon, runStop, runRestart, runStatus, runTui, runDev } from './daemon/commands.js';
import { writePidFile, removePidFile } from './daemon/pid.js';
import { CLIChannel } from './channels/cli.js';
import { TUIChannel } from './channels/tui.js';
import { DiscordChannel } from './channels/discord.js';
import { TelegramChannel } from './channels/telegram.js';
import { AnthropicProvider } from './providers/anthropic.js';
import { OpenAIProvider } from './providers/openai.js';
import { LiteLLMProvider } from './providers/litellm.js';
import { FailoverProvider } from './providers/failover.js';
import { RetryQueue } from './core/retry-queue.js';
import { MessageQueue, type QueuedMessage } from './core/message-queue.js';
import { ToolRegistry } from './tools/registry.js';
import { ToolPolicy } from './tools/policy.js';
import { configureExecSafety } from './tools/exec.js';
import { fsTools } from './tools/fs.js';
import { searchTools } from './tools/search.js';
import { execTools } from './tools/exec.js';
import { webTools } from './tools/web.js';
import { createModelTool } from './tools/model.js';
import { imageTools } from './tools/image.js';
import { gitTools } from './tools/git.js';
import { AgentLoop } from './core/agent-loop.js';
import { PromptBuilder } from './core/prompt.js';
import { ContextManager } from './core/context.js';
import { SessionManager, type Session } from './gateway/session.js';
import { Gateway } from './gateway/gateway.js';
import { SessionCompactor } from './gateway/compaction.js';
import { TakoHookSystem } from './hooks/hooks.js';
import { HybridMemoryStore } from './memory/hybrid.js';
import { createEmbeddingProvider } from './memory/embeddings.js';
import { createMemoryTools } from './tools/memory.js';
import { createSessionTools } from './tools/session.js';
import { createBrowserTools } from './tools/browser.js';
import { SkillLoader } from './skills/loader.js';
import { loadChannelFromSkill } from './skills/channel-loader.js';
import { bootstrapWorkspace, ensureDailyMemory } from './core/bootstrap.js';
import { Doctor } from './doctor/doctor.js';
import { checkConfig } from './doctor/checks/config.js';
import { checkProviders } from './doctor/checks/providers.js';
import { checkChannels } from './doctor/checks/channels.js';
import { checkMemory } from './doctor/checks/memory.js';
import { checkSessions } from './doctor/checks/sessions.js';
import { checkPermissions } from './doctor/checks/permissions.js';
import { checkBrowser } from './doctor/checks/browser.js';
import { SandboxManager } from './sandbox/sandbox.js';
import { DockerContainer } from './sandbox/container.js';
import { AgentRegistry } from './agents/registry.js';
import { resolveAgentForChannel } from './agents/config.js';
import { SubAgentOrchestrator } from './agents/subagent.js';
import { createAgentTools } from './tools/agent-tools.js';
import { createMessageTools } from './tools/message.js';
import { ThreadBindingManager } from './core/thread-bindings.js';
import type { Channel, InboundMessage } from './channels/channel.js';
import { CommandRegistry } from './commands/registry.js';
import { buildSkillCommands, type SkillCommandSpec } from './commands/skill-commands.js';
import { showModelPicker } from './commands/model-picker.js';
import { installFileLogger } from './utils/logger.js';
import { createIntrospectTools } from './tools/introspect.js';
import {
  handleSetupCommand,
  handleAgentSelect,
  handleChannelTypeButton,
  handleModalSubmit,
} from './commands/channel-setup.js';
import { isUserAllowed, createAllowFromTools } from './auth/allow-from.js';
import { DeliveryQueue } from './channels/delivery-queue.js';
import { initMediaStorage, persistAttachments } from './media/storage.js';
import { runConfig } from './cli/config.js';
import { runCron } from './cli/cron.js';
import { runMemory } from './cli/memory.js';
import { runLogs } from './cli/logs.js';
import { runMessage } from './cli/message.js';
import { runUpdate } from './cli/update.js';
import { runService } from './cli/service.js';
import { runCache } from './cli/cache.js';
import { runAudit } from './cli/audit.js';
import { runAcp } from './cli/acp.js';
import { runExtensions } from './cli/extensions.js';
import { initSecurity } from './core/security.js';
import { CacheManager } from './cache/manager.js';
import { setFsCacheManager } from './tools/fs.js';
import { setExecCacheManager } from './tools/exec.js';
import { setImageProvider } from './tools/image.js';
import { runSymphony } from './cli/symphony.js';
import { ExtensionRegistry } from './skills/extension-registry.js';
import { loadExtension, getSkillsWithExtension } from './skills/extension-loader.js';
import type { NetworkAdapter } from './skills/extensions.js';

const VERSION = '0.0.1';

async function main(): Promise<void> {
  // Prevent crashes from killing the entire process
  process.on('uncaughtException', (error) => {
    console.error('[tako] Uncaught exception:', error.message);
    console.error(error.stack);
    // Don't exit — let the process continue serving other requests
  });

  process.on('unhandledRejection', (reason) => {
    console.error('[tako] Unhandled rejection:', reason);
    // Don't exit — log and continue
  });

  const args = process.argv.slice(2);
  const command = args[0] ?? 'start';

  switch (command) {
    case 'start':
      // If no config exists, prompt to run onboard first
      if (!hasConfig()) {
        console.log('No tako.json found. Run `tako onboard` to set up Tako first.\n');
        await runOnboard();
        return;
      }
      // Daemon mode: fork to background
      if (args.includes('--daemon') || args.includes('-d')) {
        await runStartDaemon();
      } else if (args.includes('--background')) {
        // Internal: forked child runs the actual server
        await runStart();
      } else {
        await runStart();
      }
      break;
    case 'stop':
      await runStop();
      break;
    case 'restart':
      await runRestart();
      break;
    case 'tui':
    case 'chat':
      await runTui();
      break;
    case 'dev':
      await runDev();
      break;
    case 'onboard':
    case 'setup':
    case 'configure':
      await runOnboard();
      break;
    case 'models':
      await runModels(args.slice(1));
      break;
    case 'channels':
      await runChannels(args.slice(1));
      break;
    case 'mod':
    case 'mods':
      await runMod(args.slice(1));
      break;
    case 'doctor':
      await runDoctor(args.slice(1));
      break;
    case 'skills':
      await runSkills(args.slice(1));
      break;
    case 'sandbox':
      await runSandbox(args.slice(1));
      break;
    case 'agents':
      await runAgents(args.slice(1));
      break;
    case 'sessions':
      await runSessions(args.slice(1));
      break;
    case 'extensions':
      await runExtensions(args.slice(1));
      break;
    case 'symphony':
      await runSymphony(args.slice(1));
      break;
    case 'status':
      await runStatus();
      break;
    case 'nuke':
      await runNuke(args.slice(1));
      break;
    case 'config':
      await runConfig(args.slice(1));
      break;
    case 'cache':
      await runCache(args.slice(1));
      break;
    case 'audit':
      await runAudit(args.slice(1));
      break;
    case 'acp':
      await runAcp(args.slice(1));
      break;
    case 'cron':
      await runCron(args.slice(1));
      break;
    case 'memory':
      await runMemory(args.slice(1));
      break;
    case 'logs':
    case 'log':
      await runLogs(args.slice(1));
      break;
    case 'message':
    case 'msg':
      await runMessage(args.slice(1));
      break;
    case 'update':
      await runUpdate(args.slice(1));
      break;
    case 'service':
      await runService(args.slice(1));
      break;
    case 'version':
    case '--version':
    case '-v':
      console.log(`tako v${VERSION}`);
      break;
    case 'help':
    case '--help':
    case '-h':
      printHelp();
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      process.exit(1);
  }
}

function printHelp(): void {
  console.log(`Tako 🐙 — Agent-as-CPU OS

Usage: tako [command] [options]

Commands:
  start              Start Tako (foreground, default)
  start -d           Start Tako as background daemon
  stop               Stop the daemon
  restart            Restart the daemon
  status             Show daemon status & runtime info
  tui                Attach TUI to running daemon
  dev                Development mode (watch + auto-restart)
  onboard            Interactive first-time setup wizard

  config file        Print active config file path
  config get <path>  Get config value by dot path
  config set <p> <v> Set config value by dot path
  config unset <p>   Remove config value
  config validate    Validate config against schema

  models list        List available models
  models set <model> Set active model
  models auth login  Interactive provider auth
  models status      Show current model & provider
  models refresh     Re-fetch models from providers
  models fallbacks   Show/set fallback model chain
  models aliases     Manage model aliases

  channels list      List configured channels
  channels add       Add a channel (discord, telegram)
  channels remove    Remove a channel
  channels status    Show channel connection status

  agents list        List all configured agents
  agents add <name>  Create a new agent with workspace
  agents remove <n>  Remove an agent
  agents info <name> Show agent details
  agents bind        Bind agent to a channel
  agents unbind      Unbind agent from a channel
  agents bindings    List all agent-channel bindings
  agents set-identity Update agent display name/emoji

  sessions list      List all active sessions
  sessions history   Show session history
  sessions inspect   Show full session metadata
  sessions compact   Compact a session
  sessions clear     Archive a session

  cron list          List all cron jobs
  cron add           Add a scheduled job
  cron remove <id>   Remove a cron job
  cron enable/disable Toggle a cron job
  cron run <id>      Run a job immediately
  cron runs          Show cron run history

  memory search <q>  Search memory files
  memory status      Show memory index status

  logs               View today's log (--lines N, --follow, --grep)

  message send       Send message to a channel
  message broadcast  Broadcast to all channels

  acp list           List ACP sessions
  acp logs <id>      Show ACP session logs
  acp exec <a> <p>   One-shot ACP run (pi/claude/codex/opencode/gemini/kimi)
  acp send <a> <p>   Persistent ACP session send

  skills list        List discovered skills
  skills install <n> Install a skill
  skills info <name> Show skill details
  skills check       Check skill readiness
  skills audit <n>   Security audit a skill

  symphony start     Start project orchestrator
  symphony stop      Stop orchestrator
  symphony status    Show orchestrator dashboard
  symphony history   Show completed runs
  symphony config    Show current config

  sandbox status     Show sandbox status
  sandbox explain <t> Explain tool permissions
  sandbox cleanup    Remove sandbox containers

  update check       Check for new version
  update install     Self-update via npm

  service install    Install systemd user service
  service uninstall  Remove systemd user service
  service start      Start systemd service
  service stop       Stop systemd service
  service restart    Restart systemd service
  service status     Show service status
  service logs       Show service logs

  doctor             Run health checks
  version            Print version
  help               Show this help

Daemon examples:
  tako start -d                     Start as background daemon
  tako tui                          Attach TUI to running daemon
  tako stop                         Stop the daemon
  tako restart                      Restart the daemon
  tako dev                          Watch mode for development

Auth examples:
  tako models auth login --provider anthropic    API key or setup-token
  tako models auth login --provider openai       API key or OAuth
  tako models auth login --provider openai-codex OAuth flow
  tako models auth status                        Check all providers
  tako models auth logout --provider anthropic   Remove stored auth

Config resolution:
  1. --config <path> (explicit override)
  2. ~/.tako/tako.json (user home)

Examples:
  tako onboard                      First-time setup
  tako                              Start interactive agent
  tako models set anthropic/claude-opus-4-6
  tako channels add discord
  tako doctor                       Check system health
`);
}

// ─── tako start ──────────────────────────────────────────────────────

async function runStart(): Promise<void> {
  // Install file logger early so all console output is captured
  installFileLogger();

  const config = await resolveConfig();

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

  // Thread bindings (Discord thread → sub-agent session routing)
  const { homedir } = await import('node:os');
  const threadBindings = new ThreadBindingManager(
    join(homedir(), '.tako', 'thread-bindings.json'),
  );
  await threadBindings.load();

  // Memory
  const embeddingProvider = createEmbeddingProvider(config.memory.embeddings);
  const memoryStore = new HybridMemoryStore(config.memory.workspace, embeddingProvider ?? undefined);
  await memoryStore.initialize();

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
      provider = new AnthropicProvider();
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
        provider = new AnthropicProvider();
        resolvedProviderLabel = `anthropic (fallback — litellm misconfigured)`;
      }
      break;
    default:
      provider = new AnthropicProvider();
      resolvedProviderLabel = `anthropic (fallback — unknown provider '${providerName}')`;
  }

  // Wrap provider in FailoverProvider for automatic fallback
  const fallbackChain = [config.providers.primary, ...(config.providers.fallback ?? [])];
  const providerMap = new Map<string, import('./providers/provider.js').Provider>();
  providerMap.set(providerName, provider);

  // Create additional provider instances for fallback models
  for (const ref of fallbackChain) {
    const [pid] = ref.split('/');
    if (!providerMap.has(pid)) {
      switch (pid) {
        case 'anthropic':
          providerMap.set(pid, new AnthropicProvider());
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
    maxTimeout: config.tools.exec?.timeout ?? 120_000,
    defaultTimeout: 30_000,
    maxOutputSize: config.tools.exec?.maxOutputSize ?? 1024 * 1024,
  });

  // Tool registry
  const toolRegistry = new ToolRegistry();
  toolRegistry.setProfile(config.tools.profile);
  toolRegistry.setDenyList(config.tools.deny);
  if (config.tools.allow) toolRegistry.setAllowList(config.tools.allow);
  toolRegistry.setToolPolicy(toolPolicy);

  // Register kernel tools
  toolRegistry.registerAll(fsTools);
  toolRegistry.registerAll(searchTools);
  toolRegistry.registerAll(execTools);
  toolRegistry.registerAll(webTools);
  toolRegistry.registerAll(createBrowserTools({
    enabled: config.tools.browser?.enabled ?? true,
    headless: config.tools.browser?.headless ?? true,
    idleTimeoutMs: config.tools.browser?.idleTimeoutMs ?? 300_000,
  }));
  toolRegistry.registerAll(imageTools);
  toolRegistry.registerAll(gitTools);
  toolRegistry.registerAll(createMemoryTools(memoryStore));
  toolRegistry.registerAll(createSessionTools(sessions));
  toolRegistry.registerAll(createAllowFromTools());

  // Symphony tools (project orchestration)
  const { symphonyTools } = await import('./tools/symphony.js');
  toolRegistry.registerAll(symphonyTools);

  // System tools (restart, etc.)
  const { registerSystemTools } = await import('./tools/system-tools.js');
  registerSystemTools(toolRegistry, {
    gatewayPort: config.gateway.port,
    gatewayBind: config.gateway.bind,
  });

  // ─── Agent registry ────────────────────────────────────────────────

  const agentRegistry = new AgentRegistry(config.agents, config.providers.primary);
  await agentRegistry.loadDynamic();
  await agentRegistry.initialize();

  // Enable per-agent session persistence (each agent stores sessions in its own dir)
  const agentSessionDirs = new Map<string, string>();
  for (const agent of agentRegistry.list()) {
    agentSessionDirs.set(agent.id, agent.sessionDir);
  }
  await sessions.enablePersistence(agentSessionDirs);

  // Load skills — dirs come from config (already resolved/expanded)
  const skillLoader = new SkillLoader(config.skills.dirs);
  const skillManifests = await skillLoader.discover();
  for (const manifest of skillManifests) {
    const loaded = await skillLoader.load(manifest);
    skillLoader.registerTools(loaded, toolRegistry);
    skillLoader.registerHooks(loaded, hooks);
    promptBuilder.addSkillInstructions(loaded.instructions);
  }

  // Build initial skill command specs (used by agent-loop dispatch + channel slash registration)
  const skillCommandSpecs: SkillCommandSpec[] = buildSkillCommands(skillLoader.getAll());

  // Hot reload — re-register tools, hooks, AND slash commands on skill changes
  skillLoader.startWatching(async (reloadedSkills) => {
    for (const skill of reloadedSkills) {
      skillLoader.registerTools(skill, toolRegistry);
      skillLoader.registerHooks(skill, hooks);
    }
    console.log(`[tako] Skills reloaded: ${reloadedSkills.length} skills`);

    // Re-build and re-register skill commands with Discord
    try {
      const rebuiltSpecs = buildSkillCommands(reloadedSkills);
      skillCommandSpecs.splice(0, skillCommandSpecs.length, ...rebuiltSpecs);

      for (const dc of discordChannels) {
        await dc.registerSkillCommands(skillCommandSpecs, async (commandName, channelId, author, guildId) => {
          const agentId = dc.agentId ?? resolveAgentForChannel(agentRegistry.list(), 'discord', channelId);
          return handleSlashCommand(commandName, channelId, author, agentId, dc);
        });
      }
      if (discordChannels.length > 0) {
        console.log(`[tako] Re-registered ${skillCommandSpecs.length} skill commands with Discord (${discordChannels.length} bot(s))`);
      }
    } catch (err) {
      console.error('[tako] Failed to re-register skill commands:', err instanceof Error ? err.message : err);
    }
  });

  // Retry queue for failed messages (all fallbacks exhausted)
  const retryQueue = new RetryQueue(config.retryQueue);

  // Message queue for batching rapid inbound messages
  // The processor callback is wired after the agent loop is created (see below).
  let messageQueueProcessor: ((sessionId: string, messages: QueuedMessage[]) => Promise<void>) | null = null;
  const messageQueue = new MessageQueue(config.queue, async (sessionId, messages) => {
    if (messageQueueProcessor) await messageQueueProcessor(sessionId, messages);
  });

  // Typing indicators + reaction feedback
  const { TypingManager } = await import('./core/typing.js');
  const { ReactionManager } = await import('./core/reactions.js');
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
    { provider: failoverProvider, toolRegistry, promptBuilder, contextManager, hooks, skillLoader, skillCommandSpecs, model: config.providers.primary, workspaceRoot: config.memory.workspace, retryQueue, typingManager, reactionManager, streamingConfig: config.agent.streaming, compactor: sessionCompactor },
    {
      timeout: config.agent.timeout,
      ...(config.agent.maxOutputChars != null && { maxOutputChars: config.agent.maxOutputChars }),
      ...(config.agent.maxTurns != null && { maxTurns: config.agent.maxTurns }),
      ...(config.agent.maxToolCalls != null && { maxToolCalls: config.agent.maxToolCalls }),
      ...(config.agent.maxTokens != null && { maxTokens: config.agent.maxTokens }),
    },
  );

  // Set retry runner — re-invokes agent loop for a session
  retryQueue.setRunner(async (sessionId, userMessage) => {
    const session = sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found for retry`);
    let result = '';
    for await (const chunk of agentLoop.run(session, userMessage)) {
      result += chunk;
    }
    return result;
  });

  // Per-agent loops: each agent gets its own PromptBuilder (workspace) but shares
  // the same provider (auth), toolRegistry, contextManager, and hooks.
  // Agents with per-agent skill dirs get their own SkillLoader; otherwise they
  // share the global skillLoader and skillCommandSpecs.
  const agentLoops = new Map<string, AgentLoop>();
  // Track per-agent skill command specs for channel slash-command registration.
  const agentSkillCommandSpecsMap = new Map<string, SkillCommandSpec[]>();
  for (const agent of agentRegistry.list()) {
    if (agent.isMain) continue;
    const agentPromptBuilder = new PromptBuilder(agent.workspace);
    agentPromptBuilder.setSandboxInfo(config.sandbox.mode, config.sandbox.workspaceAccess);
    const agentModel = agent.model ?? config.providers.primary;

    // Build per-agent skill loader when agent has extra skill dirs
    let agentSkillLoader = skillLoader;
    let agentSkillCommandSpecs = skillCommandSpecs;
    if (agent.skills?.dirs && agent.skills.dirs.length > 0) {
      const agentSkillDirs = [...config.skills.dirs, ...agent.skills.dirs];
      agentSkillLoader = new SkillLoader(agentSkillDirs);
      const agentSkillManifests = await agentSkillLoader.discover();
      for (const manifest of agentSkillManifests) {
        const loaded = await agentSkillLoader.load(manifest);
        agentSkillLoader.registerTools(loaded, toolRegistry);
        agentSkillLoader.registerHooks(loaded, hooks);
      }
      agentSkillCommandSpecs = buildSkillCommands(agentSkillLoader.getAll());
      console.log(`[tako] Agent "${agent.id}" using ${agentSkillDirs.length} skill dir(s), ${agentSkillCommandSpecs.length} skill command(s)`);
    }
    // Store per-agent specs so channel setup below can use them
    agentSkillCommandSpecsMap.set(agent.id, agentSkillCommandSpecs);

    const loop = new AgentLoop(
      {
        provider: failoverProvider,
        toolRegistry,
        promptBuilder: agentPromptBuilder,
        contextManager,
        hooks,
        skillLoader: agentSkillLoader,
        skillCommandSpecs: agentSkillCommandSpecs,
        model: agentModel,
        workspaceRoot: agent.workspace,
        agentId: agent.id,
        agentRole: agent.role,
        retryQueue,
        typingManager,
        reactionManager,
        streamingConfig: config.agent.streaming,
        compactor: sessionCompactor,
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

  // Register set_model tool
  toolRegistry.register(createModelTool({
    setModel: (ref) => {
      agentLoop.setModel(ref);
      config.providers.primary = ref;
      import('./config/resolve.js').then(m => m.patchConfig({ providers: { primary: ref } })).catch(() => {});
    },
    getModel: () => agentLoop.getModel(),
  }));

  // ─── Sub-agent orchestrator ────────────────────────────────────────

  const subAgentOrchestrator = new SubAgentOrchestrator(sessions, agentLoop);

  // Notify parent sessions when sub-agents complete — deliver through channels
  subAgentOrchestrator.onCompletion(async (event) => {
    const parentSession = sessions.get(event.parentSessionId);
    if (!parentSession) return;

    const statusEmoji = event.status === 'completed' ? '👍' : event.status === 'timeout' ? '⏱' : '❌';
    const label = event.runId.slice(0, 8);
    const summary = event.status === 'completed'
      ? (event.result ?? '').slice(0, 1000)
      : (event.error ?? 'Unknown error');
    const announcement = `${statusEmoji} Sub-agent \`${label}\` ${event.status}\n\n${summary}`;

    // Add to session messages
    sessions.addMessage(event.parentSessionId, {
      role: 'system',
      content: announcement,
    });

    // Deliver through the channel that created this session
    const channelType = parentSession.metadata.channelType as string | undefined;
    const channelTarget = parentSession.metadata.channelTarget as string | undefined;
    if (channelType && channelTarget) {
      const channel = channels.find((ch) => ch.id === channelType);
      if (channel) {
        try {
          await channel.send({ content: announcement, target: channelTarget });
        } catch (err) {
          console.error(`[subagent] Failed to deliver completion to ${channelType}: ${err instanceof Error ? err.message : err}`);
        }
      }
    }

    // Also output to CLI/TUI if that's the parent channel
    if (!channelType || channelType === 'cli' || channelType === 'tui') {
      console.log(`\n${announcement}\n`);
    }
  });

  // Register agent tools (agents_list, sessions_spawn, sessions_history, subagents)
  toolRegistry.registerAll(createAgentTools({
    registry: agentRegistry,
    orchestrator: subAgentOrchestrator,
    sessions,
    threadBindings,
  }));

  // ─── Command registry ────────────────────────────────────────────

  const startTime = Date.now();
  const defaultModel = config.providers.primary;
  const commandRegistry = new CommandRegistry({
    getModel: () => agentLoop.getModel(),
    setModel: (ref: string) => {
      agentLoop.setModel(ref);
      config.providers.primary = ref;
      // Persist to tako.json so it survives restart
      import('./config/resolve.js').then(m => m.patchConfig({ providers: { primary: ref } })).catch(() => {});
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
        },
      );

      if (!result.success) {
        return result.error ? `ACP error: ${result.error}` : 'ACP command failed.';
      }
      return result.output || 'ACP command executed.';
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

  function getSession(msg: InboundMessage, channel?: Channel) {
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
      const session = sessions.getOrCreate(binding.sessionKey, {
        name: `${binding.agentId}/thread:${channelTarget}`,
        metadata: {
          agentId: binding.agentId,
          channelType,
          channelTarget,
          authorId: msg.author.id,
          threadBinding: true,
        },
      });
      // Attach runtime-only ref (not persisted)
      session.metadata.channelRef = channel;
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
        agentId, channelType, channelTarget, authorId: msg.author.id,
        ...(msg.threadId ? { threadId: msg.threadId } : {}),
      },
    });
    // Attach runtime-only ref (not persisted — stripped in appendToJSONL)
    session.metadata.channelRef = channel;
    return session;
  }

  function wireChannel(channel: Channel) {
    deliveryQueue.registerChannel(channel);
    channel.onMessage(async (msg: InboundMessage) => {
      try {
      const inboundText = typeof msg.content === 'string' ? msg.content : '';
      await hooks.emit('message_received', {
        event: 'message_received',
        data: { channelId: msg.channelId, authorId: msg.author.id, content: msg.content },
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
          const allowed = await isUserAllowed(aclChannel, aclAgentId, msg.author.id);
          if (!allowed) return; // silently ignore
        }
      }

      const session = getSession(msg, channel);

      // Update per-message runtime metadata used by typing/reactions/rate-limits
      session.metadata.channelId = msg.channelId;
      session.metadata.channelRef = channel;
      session.metadata.channelTarget = msg.channelId.includes(':')
        ? msg.channelId.split(':').slice(1).join(':')
        : msg.channelId;
      session.metadata.authorId = msg.author.id;
      session.metadata.authorName = msg.author.name;
      session.metadata.messageId = msg.id;

      // Extract platform-specific target for typing/reactions
      const target = session.metadata.channelTarget as string;

      // ─── First-time channel intro (only on genuine first contact, not restarts) ──
      // Track introduced channels persistently so we never re-intro after restart.
      if ((session as any).isNew && channel.id !== 'cli' && channel.id !== 'tui') {
        const introKey = `${channel.agentId ?? 'main'}:${msg.channelId}`;
        if (!introducedChannels.has(introKey)) {
          introducedChannels.add(introKey);
          saveIntroducedChannels();
          const agentName = channel.agentId ?? 'Tako';
          const intro = `👋 **${agentName}** is now active in this channel! Type \`/help\` for commands, or just @mention me to chat.`;
          try {
            await channel.send({ target, content: intro });
          } catch { /* may fail if no send permission */ }
        }
      }

      // ─── Slash command handling (local, no LLM) ──────────────────
      if (inboundText.trim().startsWith('/')) {
        const channelType = msg.channelId.split(':')[0] ?? 'cli';
        const channelTarget = msg.channelId.includes(':')
          ? msg.channelId.split(':').slice(1).join(':')
          : msg.channelId;
        const agentId = channel.agentId ?? resolveAgentForChannel(agentRegistry.list(), channelType, channelTarget);

        // reference runtime-like command reactions: received -> processing -> done/failed
        if (channel.addReaction) channel.addReaction(target, msg.id, '👋').catch(() => {});
        if (channel.addReaction) channel.addReaction(target, msg.id, '🧐').catch(() => {});
        if (channel.removeReaction) channel.removeReaction(target, msg.id, '👋').catch(() => {});

        try {
          const cmdResult = await commandRegistry.handle(inboundText, {
            channelId: msg.channelId,
            authorId: msg.author.id,
            authorName: msg.author.name,
            session,
            agentId,
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
        const queued = messageQueue.enqueue(session.id, {
          content: inboundText,
          channelId: msg.channelId,
          authorId: msg.author.id,
          timestamp: Date.now(),
          messageId: msg.id,
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
          response = `⚠️ Error: ${errMsg.slice(0, 500)}`;
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
          data: { channelId: msg.channelId, content: response },
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

    // Prepend sender context for merged messages
    const userMessage = merged;

    let response = '';
    let hadError = false;
    try {
      for await (const chunk of activeLoop.run(session, userMessage)) {
        response += chunk;
      }
    } catch (err) {
      hadError = true;
      const errMsg = err instanceof Error ? err.message : String(err);
      console.error(`[message-queue] Error processing batch for session ${sessionId}: ${errMsg}`);
      if (!response) response = `⚠️ Error: ${errMsg.slice(0, 500)}`;
    }

    // Send response through the channel
    if (channelRef && target && response.trim()) {
      const lastMsgId = messages[messages.length - 1]?.messageId;
      try {
        await channelRef.send({ target, content: response.trim(), replyTo: lastMsgId });
      } catch (sendErr) {
        console.error(`[message-queue] Send error:`, sendErr instanceof Error ? sendErr.message : sendErr);
      }

      // Queue reaction lifecycle: ⏳ -> ✅/⚠️
      if (lastMsgId) {
        if (channelRef.removeReaction) channelRef.removeReaction(target, lastMsgId, '💭').catch(() => {});
        if (channelRef.addReaction) channelRef.addReaction(target, lastMsgId, hadError ? '😅' : '👍').catch(() => {});
      }
    }

    sessions.markSessionDirty(sessionId);
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
  let telegramChannel: TelegramChannel | undefined;

  // Track which channels have received an intro (persistent across restarts)
  const introFilePath = join(homedir(), '.tako', 'introduced-channels.json');
  const introducedChannels = new Set<string>();
  try {
    const raw = readFileSync(introFilePath, 'utf-8');
    const arr = JSON.parse(raw);
    if (Array.isArray(arr)) arr.forEach((k: string) => introducedChannels.add(k));
  } catch { /* no file yet */ }
  function saveIntroducedChannels(): void {
    try {
      writeFileSync(introFilePath, JSON.stringify([...introducedChannels]), 'utf-8');
    } catch { /* non-critical */ }
  }

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

  const isSkillSlashCommand = (name: string): boolean => skillCommandSpecs.some((s) => s.name === name);

  const handleSlashCommand = async (
    commandName: string,
    channelId: string,
    author: { id: string; name: string },
    agentId: string,
    boundChannel: Channel,
  ): Promise<string | null> => {
    const channelKey = `discord:${channelId}`;
    const sessionKey = `agent:${agentId}:${channelKey}`;
    const session = sessions.getOrCreate(sessionKey, {
      name: `${agentId}/${channelKey}/${author.name}`,
      metadata: { agentId, channelType: 'discord', channelTarget: channelId, authorId: author.id },
    });

    const cmdResult = await commandRegistry.handle('/' + commandName, {
      channelId: channelKey,
      authorId: author.id,
      authorName: author.name,
      session,
      agentId,
    });
    if (cmdResult !== null) return cmdResult;

    // If this slash command came from a user-invocable skill, run it through AgentLoop
    if (!isSkillSlashCommand(commandName)) return null;

    const activeLoop = getAgentLoop(agentId);
    activeLoop.setChannel(boundChannel);
    let response = '';
    for await (const chunk of activeLoop.run(session, `/${commandName}`)) {
      response += chunk;
    }
    return response || 'Done.';
  };

  // Build native command list from the command registry
  const nativeCommandList = [
    ...commandRegistry.list(),
    { name: 'setup', description: 'Configure agent channels (Discord/Telegram)' },
  ];

  if (config.channels.discord?.token) {
    discordChannel = new DiscordChannel({
      token: config.channels.discord.token,
      guilds: config.channels.discord.guilds,
    });

    // Register native Discord slash commands
    discordChannel.setSlashCommands(nativeCommandList, async (commandName, channelId, author, guildId) => {
      const agentId = resolveAgentForChannel(agentRegistry.list(), 'discord', channelId);
      return handleSlashCommand(commandName, channelId, author, agentId, discordChannel!);
    });

    // Merge user-invocable skills into slash commands before connect (single registration on ready)
    await discordChannel.registerSkillCommands(skillCommandSpecs, async (commandName, channelId, author, guildId) => {
      const agentId = resolveAgentForChannel(agentRegistry.list(), 'discord', channelId);
      return handleSlashCommand(commandName, channelId, author, agentId, discordChannel!);
    });

    // Register interactive model picker for Discord /model command
    discordChannel.setInteractiveHandler('model', async (interaction) => {
      // Build provider → models map from all known providers
      const providerModelsMap: Record<string, string[]> = {};

      // Anthropic models (always available)
      const anthropicProvider = new AnthropicProvider();
      providerModelsMap['anthropic'] = anthropicProvider.models().map((m) => m.id);

      // OpenAI models (always available)
      const openaiProvider = new OpenAIProvider();
      providerModelsMap['openai'] = openaiProvider.models().map((m) => m.id);

      // LiteLLM models (from config or active provider)
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
          import('./config/resolve.js').then(m => m.patchConfig({ providers: { primary: ref } })).catch(() => {});
        },
        getDefaultModel: () => defaultModel,
        getProviders: () => providers,
        getModelsForProvider: (p: string) => providerModelsMap[p] ?? [],
      });

      return true;
    });

    // Register interactive /setup command for channel configuration
    const setupDeps = {
      listAgents: () => agentRegistry.list().map((a) => ({ id: a.id, description: a.description })),
      saveChannelConfig: (agentId: string, channelType: string, cfg: Record<string, unknown>) =>
        agentRegistry.saveChannelConfig(agentId, channelType, cfg),
    };

    discordChannel.setInteractiveHandler('setup', async (interaction) => {
      await handleSetupCommand(interaction, setupDeps);
      return true;
    });

    discordChannel.onSelectMenu(async (interaction) => {
      if (interaction.customId === 'setup_agent_select') {
        await handleAgentSelect(interaction);
        return true;
      }
      return false;
    });

    discordChannel.onButton(async (interaction) => {
      if (interaction.customId.startsWith('setup_type_') || interaction.customId === 'setup_cancel') {
        await handleChannelTypeButton(interaction);
        return true;
      }
      return false;
    });

    discordChannel.onModalSubmit(async (interaction) => {
      if (interaction.customId.startsWith('setup_modal_')) {
        await handleModalSubmit(interaction, setupDeps);
        return true;
      }
      return false;
    });

    discordChannels.push(discordChannel);
    channels.push(discordChannel);
    wireChannel(discordChannel);
  }

  if (config.channels.telegram?.token) {
    telegramChannel = new TelegramChannel({
      token: config.channels.telegram.token,
      allowedUsers: config.channels.telegram.allowedUsers,
    });

    // Register native Telegram command handlers
    telegramChannel.setCommands(nativeCommandList, async (commandName, chatId, author) => {
      const channelKey = `telegram:${chatId}`;
      const agentId = resolveAgentForChannel(agentRegistry.list(), 'telegram', chatId);
      const sessionKey = `agent:${agentId}:${channelKey}`;
      const session = sessions.getOrCreate(sessionKey, {
        name: `${agentId}/${channelKey}/${author.name}`,
        metadata: { agentId, channelType: 'telegram', channelTarget: chatId, authorId: author.id },
      });

      return commandRegistry.handle('/' + commandName, {
        channelId: channelKey,
        authorId: author.id,
        authorName: author.name,
        session,
        agentId,
      });
    });

    channels.push(telegramChannel);
    wireChannel(telegramChannel);
  }

  // ─── Per-agent channel setup ─────────────────────────────────────
  // Scan all non-main agents for channels.json and create separate
  // Discord/Telegram client instances bound to each agent.
  for (const agent of agentRegistry.list()) {
    if (agent.isMain) continue;
    const channelConfig = await agentRegistry.loadChannelConfig(agent.id);
    if (!channelConfig) continue;

    // Discord
    const discord = channelConfig.discord as Record<string, unknown> | undefined;
    if (discord?.enabled && discord?.token) {
      const agentDiscord = new DiscordChannel({
        token: discord.token as string,
        guilds: discord.guilds as string[] | undefined,
      });
      agentDiscord.agentId = agent.id;

      // Register slash commands for this agent's bot too
      agentDiscord.setSlashCommands(nativeCommandList, async (commandName, channelId, author, guildId) => {
        return handleSlashCommand(commandName, channelId, author, agent.id, agentDiscord);
      });

      // Merge user-invocable skill commands before connect (use agent-specific specs if available)
      const agentSpecificSkillSpecs = agentSkillCommandSpecsMap.get(agent.id) ?? skillCommandSpecs;
      await agentDiscord.registerSkillCommands(agentSpecificSkillSpecs, async (commandName, channelId, author, guildId) => {
        return handleSlashCommand(commandName, channelId, author, agent.id, agentDiscord);
      });

      discordChannels.push(agentDiscord);
      channels.push(agentDiscord);
      wireChannel(agentDiscord);
      console.log(`[tako] Agent "${agent.id}" Discord channel configured`);
    }

    // Telegram
    const telegram = channelConfig.telegram as Record<string, unknown> | undefined;
    if (telegram?.enabled && telegram?.token) {
      const agentTelegram = new TelegramChannel({
        token: telegram.token as string,
        allowedUsers: telegram.allowedUsers as string[] | undefined,
      });
      agentTelegram.agentId = agent.id;

      // Register commands for this agent's Telegram bot
      agentTelegram.setCommands(nativeCommandList, async (commandName, chatId, author) => {
        const channelKey = `telegram:${chatId}`;
        const sessionKey = `agent:${agent.id}:${channelKey}`;
        const session = sessions.getOrCreate(sessionKey, {
          name: `${agent.id}/${channelKey}/${author.name}`,
          metadata: { agentId: agent.id, channelType: 'telegram', channelTarget: chatId, authorId: author.id },
        });

        return commandRegistry.handle('/' + commandName, {
          channelId: channelKey,
          authorId: author.id,
          authorName: author.name,
          session,
          agentId: agent.id,
        });
      });

      channels.push(agentTelegram);
      wireChannel(agentTelegram);
      console.log(`[tako] Agent "${agent.id}" Telegram channel configured`);
    }
  }

  // ─── Skill-provided channels ─────────────────────────────────────
  // Load and register channels provided by skills (plugin pattern).
  const loadedSkills = skillLoader.getAll();
  for (const skill of loadedSkills) {
    if (skill.manifest.hasChannel) {
      const channelConfig = config.skillChannels?.[skill.manifest.name] ?? {};
      const channel = await loadChannelFromSkill(skill, channelConfig);
      if (channel) {
        channels.push(channel);
        wireChannel(channel);
        console.log(`[tako] Loaded skill channel: ${channel.id} (from skill: ${skill.manifest.name})`);
      }
    }
  }

  // ─── Skill extensions (unified subsystem plugins) ──────────────────
  const extensionRegistry = new ExtensionRegistry();

  // Load provider extensions
  for (const skill of getSkillsWithExtension(loadedSkills, 'provider')) {
    const providerConfig = config.skillExtensions?.[skill.manifest.name]?.provider ?? {};
    const provider = await loadExtension<import('./providers/provider.js').Provider>(skill, 'provider', providerConfig);
    if (provider) {
      extensionRegistry.register('provider', skill.manifest.name, provider);
    }
  }

  // Load memory extensions
  for (const skill of getSkillsWithExtension(loadedSkills, 'memory')) {
    const memConfig = config.skillExtensions?.[skill.manifest.name]?.memory ?? {};
    const memStore = await loadExtension<import('./memory/store.js').MemoryStore>(skill, 'memory', memConfig);
    if (memStore) {
      extensionRegistry.register('memory', skill.manifest.name, memStore);
    }
  }

  // Load channel extensions (via unified loader — supplements legacy hasChannel)
  for (const skill of getSkillsWithExtension(loadedSkills, 'channel')) {
    if (skill.manifest.hasChannel) continue; // Already loaded above via legacy path
    const chConfig = config.skillExtensions?.[skill.manifest.name]?.channel ?? {};
    const channel = await loadExtension<Channel>(skill, 'channel', chConfig);
    if (channel) {
      extensionRegistry.register('channel', skill.manifest.name, channel);
      channels.push(channel);
      wireChannel(channel);
      console.log(`[tako] Loaded extension channel: ${channel.id} (from skill: ${skill.manifest.name})`);
    }
  }

  // Load network extensions
  for (const skill of getSkillsWithExtension(loadedSkills, 'network')) {
    const netConfig = config.skillExtensions?.[skill.manifest.name]?.network ?? {};
    const adapter = await loadExtension<NetworkAdapter>(skill, 'network', netConfig);
    if (adapter) {
      extensionRegistry.register('network', skill.manifest.name, adapter);
    }
  }

  // Register message tools with per-agent channel resolution.
  // Each agent gets its own Discord/Telegram channel instance so messages
  // are sent from the correct bot identity (codecode vs takotako vs pmpm).
  toolRegistry.registerAll(createMessageTools({
    resolveDiscord: (agentId?: string) => {
      if (agentId) {
        const agentCh = discordChannels.find((ch) => ch.agentId === agentId);
        if (agentCh) return agentCh;
      }
      return discordChannel;
    },
    resolveTelegram: (agentId?: string) => {
      // Telegram: find agent-specific channel if registered
      const agentTgChannel = channels.find(
        (ch) => ch.id === 'telegram' && (ch as { agentId?: string }).agentId === agentId,
      ) as TelegramChannel | undefined;
      return agentTgChannel ?? telegramChannel;
    },
  }));

  // Register introspection tools (tako_status, tako_config, tako_logs, session_transcript)
  toolRegistry.registerAll(createIntrospectTools({
    config,
    sessions,
    startTime,
    channels,
    agentIds: agentRegistry.list().map((a: any) => a.id),
    skillCount: skillManifests.length,
    version: VERSION,
  }));

  // ─── Start Gateway ────────────────────────────────────────────────

  // Allow env override for gateway bind (needed for Docker: bind 0.0.0.0 inside container)
  if (process.env['TAKO_GATEWAY_BIND']) {
    config.gateway.bind = process.env['TAKO_GATEWAY_BIND'];
  }
  if (process.env['TAKO_GATEWAY_PORT']) {
    config.gateway.port = parseInt(process.env['TAKO_GATEWAY_PORT'], 10);
  }

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

      // Re-register skill commands with Discord after reload
      if (discordChannels.length > 0) {
        try {
          const loadedAfterReload = skillLoader.getAll();
          const rebuiltSpecs = buildSkillCommands(loadedAfterReload);
          skillCommandSpecs.splice(0, skillCommandSpecs.length, ...rebuiltSpecs);

          for (const dc of discordChannels) {
            await dc.registerSkillCommands(skillCommandSpecs, async (commandName, channelId, author, guildId) => {
              const agentId = dc.agentId ?? resolveAgentForChannel(agentRegistry.list(), 'discord', channelId);
              return handleSlashCommand(commandName, channelId, author, agentId, dc);
            });
          }
          console.log(`[tako] Re-registered ${skillCommandSpecs.length} skill commands with Discord (${discordChannels.length} bot(s))`);
        } catch (err) {
          console.error('[tako] Failed to re-register commands:', err instanceof Error ? err.message : err);
        }
      }

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

  const { CronScheduler } = await import('./core/cron.js');
  const { createCronTools } = await import('./tools/cron-tools.js');
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

  toolRegistry.registerAll(createCronTools(cronScheduler));
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
    messageQueue.clear();
    await threadBindings.save();
    cronScheduler.stop();
    skillLoader.stopWatching();
    deliveryQueue.stop();
    for (const ch of channels) {
      await ch.disconnect().catch(() => {});
    }
    await gateway.stop();
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

  // Log startup — don't broadcast to channels (too noisy on restarts)
  console.log(`🐙 Tako online — model: ${config.providers.primary}`);

  // Deliver restart note if one exists (from a prior system_restart call)
  try {
    const { readFileSync, unlinkSync } = await import('node:fs');
    const { homedir } = await import('node:os');
    const restartNotePath = join(homedir(), '.tako', 'restart-note.json');
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

async function runNuke(args: string[]): Promise<void> {
  const { homedir } = await import('node:os');
  const { rm, readdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  const readline = await import('node:readline');

  const takoDir = join(homedir(), '.tako');

  console.log('');
  console.log('  ⚠️  ⚠️  ⚠️   TAKO NUKE   ⚠️  ⚠️  ⚠️');
  console.log('');
  console.log('  This will PERMANENTLY DELETE:');
  console.log('');

  // Show what exists
  const targets: { name: string; path: string; description: string }[] = [];

  const checks = [
    { name: 'Config', path: join(takoDir, 'tako.json'), description: 'tako.json (provider, channel, agent config)' },
    { name: 'Auth', path: join(takoDir, 'auth'), description: 'auth/ (API keys, OAuth tokens)' },
    { name: 'Workspace', path: join(takoDir, 'workspace'), description: 'workspace/ (SOUL.md, AGENTS.md, memory, files)' },
    { name: 'Agents', path: join(takoDir, 'agents'), description: 'agents/ (all agent configs and state)' },
    { name: 'Sessions', path: join(takoDir, 'sessions'), description: 'sessions/ (conversation history)' },
    { name: 'Mods', path: join(takoDir, 'mods'), description: 'mods/ (installed mods and their workspaces)' },
    { name: 'Cron', path: join(takoDir, 'cron'), description: 'cron/ (scheduled jobs)' },
    { name: 'PID', path: join(takoDir, 'tako.pid'), description: 'tako.pid (daemon PID file)' },
  ];

  const { existsSync } = await import('node:fs');
  for (const check of checks) {
    if (existsSync(check.path)) {
      targets.push(check);
      console.log(`    ✗  ${check.description}`);
    }
  }

  if (targets.length === 0) {
    console.log('    (nothing found — ~/.tako/ is already clean)');
    return;
  }

  console.log('');
  console.log(`  Location: ${takoDir}`);
  console.log('');

  // Triple confirmation
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q: string): Promise<string> => new Promise((res) => rl.question(q, res));

  const answer1 = await ask('  Type "nuke" to confirm: ');
  if (answer1.trim().toLowerCase() !== 'nuke') {
    console.log('  Cancelled.');
    rl.close();
    return;
  }

  const answer2 = await ask('  Are you SURE? This cannot be undone. Type "yes i am sure": ');
  if (answer2.trim().toLowerCase() !== 'yes i am sure') {
    console.log('  Cancelled.');
    rl.close();
    return;
  }

  rl.close();

  console.log('');
  console.log('  Nuking...');

  // Stop daemon first if running
  try {
    const { getDaemonStatus, removePidFile } = await import('./daemon/pid.js');
    const status = await getDaemonStatus();
    if (status.running && status.info) {
      console.log(`  Stopping daemon (PID: ${status.info.pid})...`);
      process.kill(status.info.pid, 'SIGTERM');
      await new Promise((r) => setTimeout(r, 2000));
    }
    await removePidFile();
  } catch { /* not running */ }

  // Delete everything
  for (const target of targets) {
    try {
      await rm(target.path, { recursive: true, force: true });
      console.log(`  ✓  Deleted ${target.name}`);
    } catch (err) {
      console.error(`  ✗  Failed to delete ${target.name}: ${err instanceof Error ? err.message : err}`);
    }
  }

  console.log('');
  console.log('  🐙 Tako has been reset to factory defaults.');
  console.log('  Run `tako onboard` to set up again.');
  console.log('');
}

async function runMod(args: string[]): Promise<void> {
  const { ModManager } = await import('./mods/mod.js');
  const mods = new ModManager();
  const sub = args[0];

  switch (sub) {
    case 'list':
    case 'ls': {
      const all = await mods.list();
      const active = await mods.getActive();
      console.log(`Active: ${active}\n`);
      if (all.length === 0) {
        console.log('No mods installed.');
        console.log('  tako mod create <name> "description"    Create a new mod');
        console.log('  tako mod install <path|git-url>         Install a mod');
      } else {
        for (const mod of all) {
          const marker = mod.isActive ? ' ← active' : '';
          console.log(`  ${mod.name} v${mod.manifest.version}${marker}`);
          if (mod.manifest.description) console.log(`    ${mod.manifest.description}`);
          if (mod.manifest.author) console.log(`    by ${mod.manifest.author}`);
        }
      }
      break;
    }
    case 'use':
    case 'switch': {
      const name = args[1];
      if (!name) {
        console.log('Usage: tako mod use <name|main>');
        process.exit(1);
      }
      const result = await mods.use(name);
      console.log(result.message);
      if (!result.success) process.exit(1);
      break;
    }
    case 'install':
    case 'add': {
      const source = args[1];
      if (!source) {
        console.log('Usage: tako mod install <path|git-url>');
        process.exit(1);
      }
      const result = source.includes('://') || source.endsWith('.git')
        ? await mods.installFromGit(source)
        : await mods.install(source);
      console.log(result.message);
      if (!result.success) process.exit(1);
      break;
    }
    case 'create':
    case 'new': {
      const name = args[1];
      const desc = args.slice(2).join(' ') || 'A Tako mod';
      if (!name) {
        console.log('Usage: tako mod create <name> [description]');
        process.exit(1);
      }
      const result = await mods.create(name, desc);
      console.log(result.message);
      break;
    }
    case 'remove':
    case 'rm': {
      const name = args[1];
      if (!name) {
        console.log('Usage: tako mod remove <name>');
        process.exit(1);
      }
      const result = await mods.remove(name);
      console.log(result.message);
      if (!result.success) process.exit(1);
      break;
    }
    case 'info': {
      const name = args[1] ?? await mods.getActive();
      const all = await mods.list();
      const mod = all.find((m) => m.name === name);
      if (!mod) {
        console.log(`Mod "${name}" not found.`);
        process.exit(1);
      }
      console.log(`${mod.manifest.name} v${mod.manifest.version}`);
      if (mod.manifest.description) console.log(`Description: ${mod.manifest.description}`);
      if (mod.manifest.author) console.log(`Author: ${mod.manifest.author}`);
      if (mod.manifest.source) console.log(`Source: ${mod.manifest.source}`);
      if (mod.manifest.tags?.length) console.log(`Tags: ${mod.manifest.tags.join(', ')}`);
      console.log(`Path: ${mod.path}`);
      console.log(`Active: ${mod.isActive}`);
      if (mod.config.provider) console.log(`Provider: ${mod.config.provider}`);
      break;
    }
    default:
      console.log('Tako Mod Hub 🐙\n');
      console.log('Usage: tako mod <command>\n');
      console.log('Commands:');
      console.log('  list                      List installed mods');
      console.log('  use <name|main>           Switch to a mod (or back to main)');
      console.log('  install <path|git-url>    Install a mod from local dir or git');
      console.log('  create <name> [desc]      Create a new empty mod');
      console.log('  remove <name>             Remove an installed mod');
      console.log('  info [name]               Show mod details');
      console.log('');
      console.log('Mods are stored at: ~/.tako/mods/');
      console.log('');
      console.log('A mod packages: identity (SOUL.md), skills, workspace templates,');
      console.log('and config overrides — everything except your API keys and bot tokens.');
      console.log('');
      console.log('⚠️  After switching mods, restart Tako and reconnect channels if needed.');
      break;
  }
}

async function runDoctor(args: string[]): Promise<void> {
  const config = await resolveConfig();
  const doctor = new Doctor();

  doctor.addCheck(checkConfig);
  doctor.addCheck(checkProviders);
  doctor.addCheck(checkChannels);
  doctor.addCheck(checkMemory);
  doctor.addCheck(checkSessions);
  doctor.addCheck(checkPermissions);
  doctor.addCheck(checkBrowser);

  console.log('Tako Doctor — running health checks...\n');
  const results = await doctor.run(config, {
    autoRepair: args.includes('--yes') || args.includes('-y'),
    deep: args.includes('--deep'),
  });
  doctor.printResults(results);

  const hasErrors = results.some((r) => r.status === 'error');
  process.exit(hasErrors ? 1 : 0);
}

// ─── tako skills ─────────────────────────────────────────────────────

async function runSkills(args: string[]): Promise<void> {
  const subcommand = args[0];

  if (!subcommand || subcommand === 'list') {
    await skillsList();
  } else if (subcommand === 'install') {
    const name = args[1];
    if (!name) {
      console.error('Usage: tako skills install <name>');
      console.error('  Example: tako skills install vercel-labs/agent-skills@find-skills');
      process.exit(1);
    }
    await skillsInstall(name);
  } else if (subcommand === 'info') {
    const name = args[1];
    if (!name) {
      console.error('Usage: tako skills info <name>');
      process.exit(1);
    }
    await skillsInfo(name);
  } else if (subcommand === 'check') {
    await skillsCheck();
  } else if (subcommand === 'audit') {
    const name = args[1];
    if (!name) {
      console.error('Usage: tako skills audit <name>');
      process.exit(1);
    }
    await skillsAudit(name);
  } else if (subcommand === 'search') {
    const query = args.slice(1).join(' ');
    if (!query) {
      console.error('Usage: tako skills search <query>');
      process.exit(1);
    }
    const { SkillMarketplace } = await import('./skills/marketplace.js');
    const marketplace = new SkillMarketplace();
    const results = await marketplace.search(query);
    if (results.length === 0) {
      console.log('No skills found matching your query.');
      return;
    }
    console.log(`Found ${results.length} skill(s):\n`);
    for (const r of results) {
      console.log(`  ${r.fullName} (${r.stars} stars)`);
      console.log(`    ${r.description || '(no description)'}`);
      console.log(`    Install: tako skills install ${r.fullName}`);
      console.log();
    }
  } else if (subcommand === 'update') {
    const name = args[1];
    const { SkillMarketplace } = await import('./skills/marketplace.js');
    const marketplace = new SkillMarketplace();
    const updated = await marketplace.update(name);
    console.log(`Updated ${updated.length} skill(s):`);
    for (const s of updated) {
      console.log(`  ${s.name} → ${s.version ?? 'latest'}`);
    }
  } else if (subcommand === 'remove' || subcommand === 'rm') {
    const name = args[1];
    if (!name) {
      console.error('Usage: tako skills remove <name>');
      process.exit(1);
    }
    const { SkillMarketplace } = await import('./skills/marketplace.js');
    const marketplace = new SkillMarketplace();
    const removed = await marketplace.remove(name);
    if (removed) {
      console.log(`Removed skill: ${name}`);
    } else {
      console.error(`Skill not found: ${name}`);
      process.exit(1);
    }
  } else {
    console.error(`Unknown skills subcommand: ${subcommand}`);
    console.error('Available: list, install, search, update, remove, info, check, audit');
    process.exit(1);
  }
}

async function skillsList(): Promise<void> {
  const config = await resolveConfig();
  const loader = new SkillLoader(config.skills.dirs);
  const manifests = await loader.discover();

  if (manifests.length === 0) {
    console.log('No skills installed.');
    console.log('\nInstall skills with: tako skills install <name>');
    console.log('Browse available skills at: https://skills.sh/');
    return;
  }

  console.log(`Discovered ${manifests.length} skill(s):\n`);
  for (const m of manifests) {
    const triggers = m.triggers
      ? m.triggers.map((t) => t.type === 'keyword' ? t.value : t.type).join(', ')
      : 'always';
    console.log(`  ${m.name} (v${m.version})`);
    console.log(`    ${m.description.slice(0, 80)}${m.description.length > 80 ? '...' : ''}`);
    console.log(`    Triggers: ${triggers}`);
    console.log(`    Path: ${m.rootDir}`);
    console.log();
  }
}

async function skillsInstall(nameOrRef: string): Promise<void> {
  const { execSync } = await import('node:child_process');
  console.log(`Installing skill: ${nameOrRef}...`);
  try {
    execSync(`npx skills add ${nameOrRef} -y`, { stdio: 'inherit', cwd: process.cwd() });
    console.log('\nSkill installed. Run `tako skills list` to verify.');
  } catch {
    console.error('\nFailed to install skill. Make sure `npx skills` is available.');
    console.error('You can also manually create a skill directory in ./skills/ with a SKILL.md file.');
    process.exit(1);
  }
}

async function skillsInfo(name: string): Promise<void> {
  const config = await resolveConfig();
  const loader = new SkillLoader(config.skills.dirs);
  const manifests = await loader.discover();
  const manifest = manifests.find((m) => m.name === name);

  if (!manifest) {
    console.error(`Skill not found: ${name}`);
    console.error(`Available skills: ${manifests.map((m) => m.name).join(', ') || 'none'}`);
    process.exit(1);
  }

  const loaded = await loader.load(manifest);

  console.log(`Skill: ${manifest.name}`);
  console.log(`Version: ${manifest.version}`);
  if (manifest.author) console.log(`Author: ${manifest.author}`);
  console.log(`Description: ${manifest.description}`);
  console.log(`Path: ${manifest.rootDir}`);
  console.log(`SKILL.md: ${manifest.skillPath}`);

  if (manifest.triggers && manifest.triggers.length > 0) {
    console.log(`\nTriggers:`);
    for (const t of manifest.triggers) {
      console.log(`  - ${t.type}${t.value ? `: ${t.value}` : ''}`);
    }
  }

  if (loaded.tools.length > 0) {
    console.log(`\nTools (${loaded.tools.length}):`);
    for (const t of loaded.tools) {
      console.log(`  - ${t.name}: ${t.description}`);
    }
  }

  const preview = loaded.instructions.slice(0, 500);
  console.log(`\nInstructions (${loaded.instructions.length} chars):`);
  console.log(preview + (loaded.instructions.length > 500 ? '\n  ...' : ''));
}

async function skillsCheck(): Promise<void> {
  const config = await resolveConfig();
  const loader = new SkillLoader(config.skills.dirs);
  const manifests = await loader.discover();

  if (manifests.length === 0) {
    console.log('No skills discovered.');
    return;
  }

  console.log(`Checking ${manifests.length} skill(s):\n`);
  let ready = 0;
  let failed = 0;

  for (const m of manifests) {
    try {
      const loaded = await loader.load(m);
      console.log(`  ✓ ${m.name} (v${m.version}) — ${loaded.tools.length} tool(s)`);
      ready++;
    } catch (err) {
      console.log(`  ✗ ${m.name} (v${m.version}) — ${err instanceof Error ? err.message : 'load failed'}`);
      failed++;
    }
  }

  console.log(`\n${ready} ready, ${failed} failed`);
}

async function skillsAudit(name: string): Promise<void> {
  const config = await resolveConfig();
  const loader = new SkillLoader(config.skills.dirs);
  const manifests = await loader.discover();
  const manifest = manifests.find((m) => m.name === name);

  if (!manifest) {
    console.error(`Skill not found: ${name}`);
    console.error(`Available skills: ${manifests.map((m) => m.name).join(', ') || 'none'}`);
    process.exit(1);
  }

  const loaded = await loader.load(manifest);

  console.log(`Security Audit: ${manifest.name} (v${manifest.version})\n`);
  console.log(`Author: ${manifest.author ?? 'unknown'}`);
  console.log(`Path: ${manifest.rootDir}`);

  // Tools analysis
  console.log(`\nTools (${loaded.tools.length}):`);
  for (const t of loaded.tools) {
    const params = t.parameters ? Object.keys(t.parameters.properties ?? {}).join(', ') : 'none';
    console.log(`  ${t.name}: ${t.description}`);
    console.log(`    Parameters: ${params}`);
  }

  // Triggers analysis
  if (manifest.triggers && manifest.triggers.length > 0) {
    console.log(`\nTriggers (${manifest.triggers.length}):`);
    for (const t of manifest.triggers) {
      console.log(`  - ${t.type}${t.value ? `: ${t.value}` : ''}`);
    }
  } else {
    console.log('\nTriggers: always active (no triggers defined)');
  }

  // Instruction size
  console.log(`\nInstruction size: ${loaded.instructions.length} chars`);

  // Warnings
  const warnings: string[] = [];
  if (!manifest.author) warnings.push('No author specified');
  if (!manifest.triggers || manifest.triggers.length === 0) warnings.push('Always active (no trigger gating)');
  if (loaded.instructions.length > 10000) warnings.push(`Large instructions (${loaded.instructions.length} chars may impact context)`);
  if (loaded.tools.length > 5) warnings.push(`Many tools (${loaded.tools.length}) — consider splitting`);

  if (warnings.length > 0) {
    console.log(`\nWarnings:`);
    for (const w of warnings) {
      console.log(`  ⚠ ${w}`);
    }
  } else {
    console.log('\nNo warnings.');
  }
}

// ─── tako sandbox ────────────────────────────────────────────────────

async function runSandbox(args: string[]): Promise<void> {
  const subcommand = args[0] ?? 'status';
  const config = await resolveConfig();

  switch (subcommand) {
    case 'status': {
      const manager = new SandboxManager(config.sandbox);
      const status = await manager.getStatus();

      console.log('Tako Sandbox Status\n');
      console.log(`Mode: ${status.mode}`);
      console.log(`Docker: ${status.dockerAvailable ? 'available' : 'NOT available'}`);
      console.log(`Scope: ${config.sandbox.scope}`);
      console.log(`Workspace access: ${config.sandbox.workspaceAccess}`);
      console.log(`Image: ${config.sandbox.docker?.image ?? 'tako-sandbox:bookworm-slim'}`);
      console.log(`Network: ${config.sandbox.docker?.network ?? 'none'}`);

      if (status.dockerAvailable) {
        const containers = await DockerContainer.listSandboxContainers();
        if (containers.length > 0) {
          console.log(`\nActive sandbox containers (${containers.length}):`);
          for (const c of containers) {
            console.log(`  ${c.id} ${c.name} (${c.running ? 'running' : 'stopped'})`);
          }
        } else {
          console.log('\nNo active sandbox containers.');
        }
      }

      // Exec policy
      if (config.tools.exec) {
        console.log(`\nExec policy:`);
        console.log(`  Security: ${config.tools.exec.security}`);
        if (config.tools.exec.allowlist) {
          console.log(`  Allowlist: ${config.tools.exec.allowlist.length} patterns`);
        }
        if (config.tools.exec.timeout) {
          console.log(`  Timeout: ${config.tools.exec.timeout}ms`);
        }
      } else {
        console.log(`\nExec policy: full (no restrictions)`);
      }
      break;
    }

    case 'explain': {
      const toolName = args[1];
      if (!toolName) {
        console.error('Usage: tako sandbox explain <tool-name>');
        console.error('  Example: tako sandbox explain exec');
        process.exit(1);
      }

      // Sandbox explanation
      const manager = new SandboxManager(config.sandbox);
      console.log(manager.explain(toolName, true));
      console.log();

      // Tool policy explanation
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
      console.log('Tool Policy:');
      console.log(toolPolicy.explain(toolName, config.sandbox.mode !== 'off'));
      break;
    }

    case 'cleanup': {
      const dockerOk = await DockerContainer.isDockerAvailable();
      if (!dockerOk) {
        console.log('Docker is not available. Nothing to clean up.');
        return;
      }
      const count = await DockerContainer.cleanupAll();
      console.log(`Removed ${count} sandbox container(s).`);
      break;
    }

    default:
      console.error(`Unknown sandbox subcommand: ${subcommand}`);
      console.error('Available: status, explain <tool>, cleanup');
      process.exit(1);
  }
}

// ─── tako agents ─────────────────────────────────────────────────────

async function runAgents(args: string[]): Promise<void> {
  const config = await resolveConfig();
  const registry = new AgentRegistry(config.agents, config.providers.primary);
  await registry.loadDynamic();

  const subcommand = args[0] ?? 'list';

  switch (subcommand) {
    case 'list': {
      const showBindings = args.includes('--bindings');
      const agents = registry.list();

      if (agents.length === 0) {
        console.log('No agents configured (only default "main" agent).');
        return;
      }

      console.log(`Agents (${agents.length}):\n`);
      for (const agent of agents) {
        console.log(`  ${agent.id}${agent.isMain ? ' (main)' : ''}`);
        console.log(`    Workspace: ${agent.workspace}`);
        console.log(`    Model: ${agent.model}`);
        if (agent.description) console.log(`    Description: ${agent.description}`);
        if (agent.canSpawn.length > 0) console.log(`    Can spawn: ${agent.canSpawn.join(', ')}`);
        if (showBindings && Object.keys(agent.bindings).length > 0) {
          console.log(`    Bindings: ${JSON.stringify(agent.bindings)}`);
        }
        console.log();
      }
      break;
    }

    case 'add': {
      const nameArg = args[1];
      const hasFlags = args.some((a) => a.startsWith('--'));
      const isInteractive = !nameArg && !hasFlags;

      let agentName: string;
      let workspace: string | undefined;
      let model: string | undefined;
      let description: string | undefined;
      let discordChannels: string[] | undefined;
      let telegramUsers: string[] | undefined;

      if (isInteractive) {
        // ─── Interactive wizard ────────────────────────────────────
        const p = await import('@clack/prompts');

        p.intro('Tako 🐙 — New Agent Setup');

        const nameResult = await p.text({
          message: 'Agent name (lowercase, hyphens ok)',
          placeholder: 'code-agent',
          validate: (v) => {
            if (!v) return 'Name is required';
            if (!/^[a-z][a-z0-9-]*$/.test(v)) return 'Use lowercase letters, numbers, and hyphens';
            if (v === 'main') return '"main" is reserved';
            if (registry.has(v)) return `Agent "${v}" already exists`;
            return undefined;
          },
        });
        if (p.isCancel(nameResult)) { p.cancel('Cancelled.'); return; }
        agentName = nameResult;

        const descResult = await p.text({
          message: 'Description (what does this agent do?)',
          placeholder: 'Handles code review and refactoring tasks',
        });
        if (p.isCancel(descResult)) { p.cancel('Cancelled.'); return; }
        description = descResult || undefined;

        const wsResult = await p.text({
          message: 'Workspace path',
          placeholder: `~/.tako/workspace-${agentName}`,
          defaultValue: `~/.tako/workspace-${agentName}`,
        });
        if (p.isCancel(wsResult)) { p.cancel('Cancelled.'); return; }
        workspace = wsResult || `~/.tako/workspace-${agentName}`;

        const modelResult = await p.select({
          message: 'Model',
          options: [
            { value: '', label: `Inherit from main (${config.providers.primary})`, hint: 'recommended' },
            { value: 'anthropic/claude-sonnet-4-6', label: 'claude-sonnet-4-6', hint: 'fast, balanced' },
            { value: 'anthropic/claude-opus-4-6', label: 'claude-opus-4-6', hint: 'powerful, slower' },
            { value: 'anthropic/claude-haiku-4-5', label: 'claude-haiku-4-5', hint: 'fastest, cheapest' },
          ],
        });
        if (p.isCancel(modelResult)) { p.cancel('Cancelled.'); return; }
        model = modelResult || undefined;

        // Channel bindings
        const bindResult = await p.confirm({
          message: 'Set up channel bindings? (route specific channels to this agent)',
          initialValue: false,
        });
        if (p.isCancel(bindResult)) { p.cancel('Cancelled.'); return; }

        if (bindResult) {
          if (config.channels.discord?.token) {
            const dcResult = await p.text({
              message: 'Discord channel names (comma-separated, or empty to skip)',
              placeholder: 'coding, code-review',
            });
            if (p.isCancel(dcResult)) { p.cancel('Cancelled.'); return; }
            if (dcResult) {
              discordChannels = dcResult.split(',').map((s) => s.trim()).filter(Boolean);
            }
          }

          if (config.channels.telegram?.token) {
            const tgResult = await p.text({
              message: 'Telegram user IDs to route (comma-separated, or empty to skip)',
              placeholder: '123456789',
            });
            if (p.isCancel(tgResult)) { p.cancel('Cancelled.'); return; }
            if (tgResult) {
              telegramUsers = tgResult.split(',').map((s) => s.trim()).filter(Boolean);
            }
          }
        }

        // Confirmation
        p.note([
          `Name:        ${agentName}`,
          `Description: ${description || '(none)'}`,
          `Workspace:   ${workspace}`,
          `Model:       ${model || `inherit (${config.providers.primary})`}`,
          discordChannels ? `Discord:     ${discordChannels.join(', ')}` : null,
          telegramUsers ? `Telegram:    ${telegramUsers.join(', ')}` : null,
        ].filter(Boolean).join('\n'), 'New Agent');

        const confirmResult = await p.confirm({ message: 'Create this agent?', initialValue: true });
        if (p.isCancel(confirmResult) || !confirmResult) { p.cancel('Cancelled.'); return; }
      } else {
        // ─── Non-interactive (flags) ──────────────────────────────
        if (!nameArg) {
          console.error('Usage: tako agents add <name> [--workspace <path>] [--model <model>] [--description <desc>]');
          console.error('       tako agents add  (interactive wizard)');
          process.exit(1);
        }
        agentName = nameArg;

        const workspaceIdx = args.indexOf('--workspace');
        const modelIdx = args.indexOf('--model');
        const descIdx = args.indexOf('--description');
        const discordIdx = args.indexOf('--discord-channels');
        const telegramIdx = args.indexOf('--telegram-users');

        workspace = workspaceIdx >= 0 ? args[workspaceIdx + 1] : undefined;
        model = modelIdx >= 0 ? args[modelIdx + 1] : undefined;
        description = descIdx >= 0 ? args[descIdx + 1] : undefined;
        if (discordIdx >= 0 && args[discordIdx + 1]) {
          discordChannels = args[discordIdx + 1].split(',').map((s) => s.trim());
        }
        if (telegramIdx >= 0 && args[telegramIdx + 1]) {
          telegramUsers = args[telegramIdx + 1].split(',').map((s) => s.trim());
        }
      }

      // Build bindings
      const bindings: import('./config/schema.js').AgentBindings = {};
      if (discordChannels && discordChannels.length > 0) {
        bindings.discord = { channels: discordChannels };
      }
      if (telegramUsers && telegramUsers.length > 0) {
        bindings.telegram = { users: telegramUsers };
      }

      try {
        const agent = await registry.add({
          id: agentName,
          workspace,
          model: model ? { primary: model } : undefined,
          description,
          bindings: Object.keys(bindings).length > 0 ? bindings : undefined,
        });

        console.log(`\nAgent created: ${agent.id}`);
        console.log(`  Workspace:   ${agent.workspace}`);
        console.log(`  State dir:   ${agent.stateDir}`);
        console.log(`  Sessions:    ${agent.sessionDir}`);
        console.log(`  Model:       ${agent.model}`);
        if (agent.description) console.log(`  Description: ${agent.description}`);
        if (Object.keys(agent.bindings).length > 0) {
          console.log(`  Bindings:    ${JSON.stringify(agent.bindings)}`);
        }
        console.log(`\nWorkspace files created:`);
        console.log(`  AGENTS.md    — Operating instructions`);
        console.log(`  SOUL.md      — Personality & values`);
        console.log(`  IDENTITY.md  — Name, capabilities`);
        console.log(`  USER.md      — User profile (empty)`);
        console.log(`  TOOLS.md     — Tool learnings (empty)`);
        console.log(`  HEARTBEAT.md — Status update behavior`);
        console.log(`  BOOTSTRAP.md — First-run ritual`);
        console.log(`  memory/MEMORY.md — Long-term memory`);
      } catch (err) {
        console.error(`Failed to create agent: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
      break;
    }

    case 'remove': {
      const name = args[1];
      if (!name) {
        console.error('Usage: tako agents remove <name>');
        process.exit(1);
      }

      try {
        const removed = await registry.remove(name);
        if (removed) {
          console.log(`Agent removed: ${name}`);
          console.log('Note: agent workspace was preserved (only state directory was removed).');
        } else {
          console.error(`Agent not found: ${name}`);
          process.exit(1);
        }
      } catch (err) {
        console.error(`Failed to remove agent: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
      break;
    }

    case 'info': {
      const name = args[1];
      if (!name) {
        console.error('Usage: tako agents info <name>');
        process.exit(1);
      }

      const info = registry.info(name);
      if (!info) {
        console.error(`Agent not found: ${name}`);
        console.error(`Available agents: ${registry.list().map((a) => a.id).join(', ')}`);
        process.exit(1);
      }

      console.log(`Agent: ${info.id}`);
      console.log(JSON.stringify(info, null, 2));
      break;
    }

    case 'bind': {
      const agentId = args[1];
      const channel = args.includes('--channel') ? args[args.indexOf('--channel') + 1] : undefined;
      const target = args.includes('--target') ? args[args.indexOf('--target') + 1] : undefined;

      if (!agentId || !channel || !target) {
        console.error('Usage: tako agents bind <agentId> --channel <discord|telegram> --target <channelId>');
        process.exit(1);
      }

      const agent = registry.get(agentId);
      if (!agent) {
        console.error(`Agent not found: ${agentId}`);
        process.exit(1);
      }

      // Update bindings
      const bindings = { ...agent.bindings };
      if (channel === 'discord') {
        const existing = bindings.discord?.channels ?? [];
        if (!existing.includes(target)) {
          bindings.discord = { channels: [...existing, target] };
        }
      } else if (channel === 'telegram') {
        const existing = bindings.telegram?.users ?? [];
        if (!existing.includes(target)) {
          bindings.telegram = { users: [...existing, target] };
        }
      } else {
        console.error(`Unknown channel type: ${channel}. Use "discord" or "telegram".`);
        process.exit(1);
      }

      // Persist to agent.json
      const agentJsonPath = join(homedir(), '.tako', 'agents', agentId, 'agent.json');
      if (existsSync(agentJsonPath)) {
        const raw = await readFile(agentJsonPath, 'utf-8');
        const entry = JSON.parse(raw);
        entry.bindings = bindings;
        await writeFile(agentJsonPath, JSON.stringify(entry, null, 2), 'utf-8');
      }

      console.log(`Bound ${channel}/${target} → agent ${agentId}`);
      break;
    }

    case 'unbind': {
      const agentId = args[1];
      const channel = args.includes('--channel') ? args[args.indexOf('--channel') + 1] : undefined;
      const target = args.includes('--target') ? args[args.indexOf('--target') + 1] : undefined;

      if (!agentId || !channel || !target) {
        console.error('Usage: tako agents unbind <agentId> --channel <discord|telegram> --target <channelId>');
        process.exit(1);
      }

      const agent = registry.get(agentId);
      if (!agent) {
        console.error(`Agent not found: ${agentId}`);
        process.exit(1);
      }

      const bindings = { ...agent.bindings };
      if (channel === 'discord' && bindings.discord) {
        bindings.discord.channels = bindings.discord.channels.filter((c) => c !== target);
      } else if (channel === 'telegram' && bindings.telegram) {
        bindings.telegram.users = (bindings.telegram.users ?? []).filter((u) => u !== target);
      }

      const agentJsonPath = join(homedir(), '.tako', 'agents', agentId, 'agent.json');
      if (existsSync(agentJsonPath)) {
        const raw = await readFile(agentJsonPath, 'utf-8');
        const entry = JSON.parse(raw);
        entry.bindings = bindings;
        await writeFile(agentJsonPath, JSON.stringify(entry, null, 2), 'utf-8');
      }

      console.log(`Unbound ${channel}/${target} from agent ${agentId}`);
      break;
    }

    case 'bindings': {
      const agents = registry.list();
      let hasBindings = false;

      console.log('Agent Bindings:\n');
      for (const agent of agents) {
        const b = agent.bindings;
        if (!b || (Object.keys(b).length === 0)) continue;

        hasBindings = true;
        console.log(`  ${agent.id}:`);
        if (b.discord?.channels?.length) {
          console.log(`    Discord: ${b.discord.channels.join(', ')}`);
        }
        if (b.telegram?.users?.length) {
          console.log(`    Telegram users: ${b.telegram.users.join(', ')}`);
        }
        if (b.telegram?.groups?.length) {
          console.log(`    Telegram groups: ${b.telegram.groups.join(', ')}`);
        }
        if (b.cli) {
          console.log(`    CLI: bound`);
        }
        console.log();
      }

      if (!hasBindings) {
        console.log('  No bindings configured.');
        console.log('\n  Add bindings with: tako agents bind <agentId> --channel discord --target <channelId>');
      }
      break;
    }

    case 'set-identity': {
      const agentId = args[1];
      if (!agentId) {
        console.error('Usage: tako agents set-identity <agentId> --name <name> [--emoji <emoji>]');
        process.exit(1);
      }

      const agent = registry.get(agentId);
      if (!agent) {
        console.error(`Agent not found: ${agentId}`);
        process.exit(1);
      }

      const nameArg = args.includes('--name') ? args[args.indexOf('--name') + 1] : undefined;
      const emojiArg = args.includes('--emoji') ? args[args.indexOf('--emoji') + 1] : undefined;

      if (!nameArg && !emojiArg) {
        console.error('Provide at least --name or --emoji');
        process.exit(1);
      }

      const agentJsonPath = join(homedir(), '.tako', 'agents', agentId, 'agent.json');
      let entry: Record<string, unknown> = {};
      if (existsSync(agentJsonPath)) {
        const raw = await readFile(agentJsonPath, 'utf-8');
        entry = JSON.parse(raw);
      }

      if (nameArg) entry.displayName = nameArg;
      if (emojiArg) entry.emoji = emojiArg;

      await writeFile(agentJsonPath, JSON.stringify(entry, null, 2), 'utf-8');
      console.log(`Updated identity for agent ${agentId}:`);
      if (nameArg) console.log(`  Name: ${nameArg}`);
      if (emojiArg) console.log(`  Emoji: ${emojiArg}`);
      break;
    }

    default:
      console.error(`Unknown agents subcommand: ${subcommand}`);
      console.error('Available: list, add, remove, info, bind, unbind, bindings, set-identity');
      process.exit(1);
  }
}

// ─── tako sessions ──────────────────────────────────────────────────

async function runSessions(args: string[]): Promise<void> {
  const config = await resolveConfig();
  const sessions = new SessionManager();
  const agentRegistry = new AgentRegistry(config.agents, config.providers.primary);
  await agentRegistry.loadDynamic();
  const agentSessionDirs = new Map<string, string>();
  for (const agent of agentRegistry.list()) {
    agentSessionDirs.set(agent.id, agent.sessionDir);
  }
  await sessions.enablePersistence(agentSessionDirs);

  const subcommand = args[0] ?? 'list';

  switch (subcommand) {
    case 'list': {
      const agentFilter = args.includes('--agent') ? args[args.indexOf('--agent') + 1] : undefined;
      let allSessions = sessions.list();

      if (agentFilter) {
        allSessions = allSessions.filter(
          (s) => (s.metadata.agentId ?? 'main') === agentFilter,
        );
      }

      // Sort by most recent
      allSessions.sort((a, b) => b.lastActiveAt.getTime() - a.lastActiveAt.getTime());

      if (allSessions.length === 0) {
        console.log('No sessions found.');
        sessions.stopPersistence();
        return;
      }

      console.log(`Sessions (${allSessions.length}):\n`);
      for (const s of allSessions.slice(0, 50)) {
        const agentId = s.metadata.agentId ?? 'main';
        const isSubAgent = s.metadata.isSubAgent ? ' [sub-agent]' : '';
        console.log(`  ${s.id.slice(0, 8)}  ${s.name}  (${agentId}${isSubAgent})`);
        console.log(`    Messages: ${s.messages.length}  Last active: ${s.lastActiveAt.toISOString()}`);
      }
      break;
    }

    case 'history': {
      const sessionId = args[1];
      if (!sessionId) {
        console.error('Usage: tako sessions history <session-id> [--limit <n>]');
        process.exit(1);
      }

      // Support partial session ID match
      let session = sessions.get(sessionId);
      if (!session) {
        const match = sessions.list().find((s) => s.id.startsWith(sessionId));
        if (match) session = match;
      }

      if (!session) {
        console.error(`Session not found: ${sessionId}`);
        sessions.stopPersistence();
        process.exit(1);
      }

      const limitIdx = args.indexOf('--limit');
      const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1] ?? '20', 10) : 20;

      const messages = session.messages.slice(-limit);
      console.log(`Session: ${session.name} (${session.id})`);
      console.log(`Total messages: ${session.messages.length}\n`);

      for (const msg of messages) {
        const content = typeof msg.content === 'string'
          ? msg.content.slice(0, 200)
          : '[complex content]';
        console.log(`  [${msg.role}] ${content}`);
      }
      break;
    }

    case 'inspect': {
      const sessionId = args[1];
      if (!sessionId) {
        console.error('Usage: tako sessions inspect <session-id>');
        process.exit(1);
      }

      let session = sessions.get(sessionId);
      if (!session) {
        const match = sessions.list().find((s) => s.id.startsWith(sessionId));
        if (match) session = match;
      }

      if (!session) {
        console.error(`Session not found: ${sessionId}`);
        sessions.stopPersistence();
        process.exit(1);
      }

      console.log(`Session: ${session.name}`);
      console.log(`  ID:          ${session.id}`);
      console.log(`  Created:     ${session.createdAt.toISOString()}`);
      console.log(`  Last active: ${session.lastActiveAt.toISOString()}`);
      console.log(`  Messages:    ${session.messages.length}`);
      console.log(`  Agent:       ${session.metadata.agentId ?? 'main'}`);
      if (session.metadata.isSubAgent) console.log(`  Sub-agent:   yes`);
      if (Object.keys(session.metadata).length > 0) {
        console.log(`  Metadata:    ${JSON.stringify(session.metadata, null, 2)}`);
      }

      // Show last 10 messages
      const recent = session.messages.slice(-10);
      if (recent.length > 0) {
        console.log(`\nRecent messages (last ${recent.length}):\n`);
        for (const msg of recent) {
          const content = typeof msg.content === 'string'
            ? msg.content.slice(0, 300)
            : '[complex content]';
          console.log(`  [${msg.role}] ${content}`);
        }
      }
      break;
    }

    case 'compact': {
      const sessionId = args[1];
      if (!sessionId) {
        console.error('Usage: tako sessions compact <session-id>');
        process.exit(1);
      }

      console.log('Session compaction requires the daemon to be running.');
      console.log('Use the /compact command inside an active session instead.');
      console.log('Or start Tako and the auto-compaction will handle it based on your config.');
      break;
    }

    case 'clear': {
      const sessionId = args[1];
      if (!sessionId) {
        console.error('Usage: tako sessions clear <session-id>');
        process.exit(1);
      }

      let session = sessions.get(sessionId);
      if (!session) {
        const match = sessions.list().find((s) => s.id.startsWith(sessionId));
        if (match) session = match;
      }

      if (!session) {
        console.error(`Session not found: ${sessionId}`);
        sessions.stopPersistence();
        process.exit(1);
      }

      // Archive by renaming the session file
      const agentId = (session.metadata.agentId as string) ?? 'main';
      const agentDir = agentSessionDirs.get(agentId);
      if (agentDir) {
        const sessionFile = join(agentDir, `${session.id}.jsonl`);
        const archiveFile = join(agentDir, `${session.id}.jsonl.archived`);
        if (existsSync(sessionFile)) {
          await rename(sessionFile, archiveFile);
          console.log(`Session ${session.id.slice(0, 8)} archived.`);
          console.log(`  File moved to: ${archiveFile}`);
        } else {
          console.log('Session file not found on disk (may be in-memory only).');
        }
      }
      break;
    }

    default:
      console.error(`Unknown sessions subcommand: ${subcommand}`);
      console.error('Available: list, history, inspect, compact, clear');
      process.exit(1);
  }

  sessions.stopPersistence();
}

// ─── tako status ─────────────────────────────────────────────────────

// ─── Entry ───────────────────────────────────────────────────────────

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
