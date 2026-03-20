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
import { createGitHubTools } from './tools/github.js';
import { createModelTool } from './tools/model.js';
import { imageTools } from './tools/image.js';
import { gitTools } from './tools/git.js';
import { officeTools } from './tools/office.js';
import { AgentLoop } from './core/agent-loop.js';
import { PromptBuilder } from './core/prompt.js';
import { ContextManager } from './core/context.js';
import { SessionManager, type Session } from './gateway/session.js';
import { Gateway } from './gateway/gateway.js';
import { SessionCompactor } from './gateway/compaction.js';
import { TakoHookSystem } from './hooks/hooks.js';
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
import { isUserAllowed, createAllowFromTools, loadAllowFrom, claimOwner } from './auth/allow-from.js';
import { checkTokenHealth } from './auth/storage.js';
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
import { initAudit } from './core/audit.js';
import { runAcp } from './cli/acp.js';
import { runExtensions } from './cli/extensions.js';
import { AcpxRuntime } from './acp/runtime.js';
import { resolveAcpConfig } from './acp/config.js';
import { createAcpTool } from './tools/acp.js';
import { AcpSessionManager, createAcpSessionTools } from './tools/acp-sessions.js';
import { initSecurity } from './core/security.js';
import { CacheManager } from './cache/manager.js';
import { setFsCacheManager } from './tools/fs.js';
import { setExecCacheManager } from './tools/exec.js';
import { setImageProvider } from './tools/image.js';
import { createProjectTools, type ProjectBootstrapRequest, type ProjectMemberManageRequest, type ProjectSyncRequest } from './tools/projects.js';
import { runSymphony } from './cli/symphony.js';
import { ExtensionRegistry } from './skills/extension-registry.js';
import { loadExtension, getSkillsWithExtension } from './skills/extension-loader.js';
import type { NetworkAdapter } from './skills/extensions.js';
import { getRuntimePaths, setRuntimePaths } from './core/paths.js';
import { parseNodeMode, type NodeMode } from './core/runtime-mode.js';
import { startHubServer } from './hub/server.js';
import { loadOrCreateNodeIdentity } from './core/node-identity.js';
import { runHubCli } from './cli/hub.js';
import { PrincipalRegistry } from './principals/registry.js';
import { runPrincipals } from './cli/principals.js';
import { runProjects } from './cli/projects.js';
import { runSharedSessions } from './cli/shared-sessions.js';
import { runNetwork } from './cli/network.js';
import { ProjectRegistry } from './projects/registry.js';
import { ProjectMembershipRegistry } from './projects/memberships.js';
import { ProjectBindingRegistry } from './projects/bindings.js';
import { getProjectRole, isProjectMember } from './projects/access.js';
import type { ProjectRole, Project } from './projects/types.js';
import { bootstrapProjectHome } from './projects/bootstrap.js';
import {
  defaultProjectArtifactsRoot,
  projectApprovalsRoot,
  projectBackgroundRoot,
  projectBranchesRoot,
  resolveProjectRoot,
} from './projects/root.js';
import { ProjectArtifactRegistry } from './projects/artifacts.js';
import { importArtifactEnvelope } from './projects/distribution.js';
import { ProjectApprovalRegistry } from './projects/approvals.js';
import { ProjectBackgroundRegistry } from './projects/background.js';
import { ProjectBranchRegistry } from './projects/branches.js';
import { getWorktreeRepoStatus } from './projects/patches.js';
import { ProjectWorktreeRegistry } from './projects/worktrees.js';
import { inferProjectBootstrapIntent } from './projects/bootstrap-intent.js';
import { SharedSessionRegistry, type SharedSession } from './sessions/shared.js';
import {
  createHubClientFromConfig,
  registerNodeWithHub,
  syncProjectMembershipsToHub,
  syncProjectToHub,
  syncAllProjectsToHub,
} from './network/sync.js';
import { TrustStore } from './network/trust.js';
import { NetworkSharedSessionStore, type NetworkSessionEvent } from './network/shared-sessions.js';
import { pollNetworkSessionEvents, sendNetworkSessionEvent } from './network/session-sync.js';
import { CapabilityRegistry } from './network/capabilities.js';
import { DelegationStore } from './network/delegation.js';
import { evaluateDelegationRequest } from './network/delegation-policy.js';
import { DelegationExecutor } from './network/delegation-executor.js';
import {
  buildExecutionContext,
  toAuditContext,
  toCommandContext,
  toSessionMetadata,
  type ExecutionContext,
} from './core/execution-context.js';

const VERSION = '0.0.1';

function parseGlobalOptions(argv: string[]): {
  args: string[];
  home?: string;
  mode?: NodeMode;
  hub?: string;
  port?: number;
  bind?: string;
} {
  const args: string[] = [];
  let home: string | undefined;
  let mode: NodeMode | undefined;
  let hub: string | undefined;
  let port: number | undefined;
  let bind: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--home') {
      home = argv[i + 1];
      i++;
      continue;
    }
    if (arg === '--mode') {
      mode = parseNodeMode(argv[i + 1]);
      i++;
      continue;
    }
    if (arg === '--hub') {
      hub = argv[i + 1];
      args.push(arg, argv[i + 1] ?? '');
      i++;
      continue;
    }
    if (arg === '--port') {
      const raw = argv[i + 1];
      const parsedPort = raw ? Number.parseInt(raw, 10) : Number.NaN;
      if (!Number.isFinite(parsedPort) || parsedPort < 1 || parsedPort > 65535) {
        throw new Error(`Invalid --port value: ${raw ?? '(missing)'}`);
      }
      port = parsedPort;
      i++;
      continue;
    }
    if (arg === '--bind') {
      bind = argv[i + 1];
      i++;
      continue;
    }
    args.push(arg);
  }

  return { args, home, mode, hub, port, bind };
}

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

  const parsed = parseGlobalOptions(process.argv.slice(2));
  const args = parsed.args;
  const command = args[0] ?? 'start';
  const implicitMode = command === 'hub' ? 'hub' : 'edge';
  const mode = parsed.mode ?? implicitMode;
  const paths = setRuntimePaths({ home: parsed.home, mode });
  if (parsed.hub) {
    process.env['TAKO_HUB'] = parsed.hub;
  }
  if (parsed.bind) {
    process.env['TAKO_GATEWAY_BIND'] = parsed.bind;
  }
  if (parsed.port != null) {
    process.env['TAKO_GATEWAY_PORT'] = String(parsed.port);
  }

  switch (command) {
    case 'start':
      if (mode === 'hub') {
        await startHubServer({
          home: paths.home,
          bind: parsed.bind ?? process.env['TAKO_GATEWAY_BIND'] ?? '127.0.0.1',
          port: parsed.port ?? (process.env['TAKO_GATEWAY_PORT'] ? Number.parseInt(process.env['TAKO_GATEWAY_PORT'], 10) : undefined),
        });
        break;
      }
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
    case 'hub':
      if ((args[1] ?? 'start') !== 'start') {
        await runHubCli(args.slice(1));
        break;
      }
      await startHubServer({
        home: paths.home,
        bind: parsed.bind ?? process.env['TAKO_GATEWAY_BIND'] ?? '127.0.0.1',
        port: parsed.port ?? (process.env['TAKO_GATEWAY_PORT'] ? Number.parseInt(process.env['TAKO_GATEWAY_PORT'], 10) : undefined),
      });
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
    case 'principals':
      await runPrincipals(args.slice(1));
      break;
    case 'projects':
      await runProjects(args.slice(1));
      break;
    case 'shared-sessions':
      await runSharedSessions(args.slice(1));
      break;
    case 'network':
      await runNetwork(args.slice(1));
      break;
    case 'extensions':
      await runExtensions(args.slice(1));
      break;
    case 'symphony':
      await runSymphony(args.slice(1));
      break;
    case 'status':
      await runStatus(args.slice(1));
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

  network trust list               List trusted or pending remote nodes
  network trust revoke <nodeId>    Revoke trust for a remote node
  network invite list              List project invites
  network invite create ...        Create a project invite for a remote edge
  network invite import <file>     Import an invite onto this edge
  network invite accept <id>       Accept an imported invite
  network invite reject <id>       Reject an imported invite

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
  2. <home>/tako.json (selected installation home)

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
  await trustStore.load();
  await networkSharedSessions.load();
  await capabilityRegistry.load();
  await delegationStore.load();

  const resolvePrincipal = async (msg: InboundMessage) => {
    const platform = (msg.channelId.split(':')[0] ?? 'cli') as 'discord' | 'telegram' | 'cli';
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

  const resolveProject = (input: {
    platform: 'discord' | 'telegram' | 'cli';
    channelTarget: string;
    threadId?: string;
    agentId?: string;
  }) => {
    const binding = projectBindings.resolve(input);
    if (!binding) return null;
    const project = projectRegistry.get(binding.projectId);
    if (!project) return null;
    return { binding, project };
  };

  const handleClosedProjectRoom = async (input: {
    platform: 'discord';
    channelId: string;
    kind: 'channel' | 'thread';
    reason: 'deleted' | 'archived';
    agentId?: string;
  }): Promise<void> => {
    const deactivated = await projectBindings.deactivateMatching({
      platform: input.platform,
      channelTarget: input.kind === 'channel' ? input.channelId : undefined,
      threadId: input.kind === 'thread' ? input.channelId : undefined,
      agentId: input.agentId,
      reason: `${input.platform}_${input.kind}_${input.reason}`,
    });
    if (deactivated.length === 0) return;

    for (const binding of deactivated) {
      const project = projectRegistry.get(binding.projectId);
      if (project) {
        await projectRegistry.update(project.projectId, {
          metadata: {
            ...(project.metadata ?? {}),
            roomState: 'pending_rebind',
            pendingRoomReason: `${input.platform}_${input.kind}_${input.reason}`,
            pendingRoomAt: new Date().toISOString(),
            pendingRoomBindingId: binding.bindingId,
          },
        });
      }

      for (const session of sessions.list()) {
        const samePlatform = session.metadata?.channelType === input.platform;
        const sameChannel = session.metadata?.channelTarget === binding.channelTarget;
        const sameThread = binding.threadId
          ? session.metadata?.threadId === binding.threadId || session.metadata?.channelTarget === binding.threadId
          : true;
        const sameProject = session.metadata?.projectId === binding.projectId;
        if (samePlatform && sameChannel && sameThread && sameProject) {
          sessions.archiveSession(session.id);
        }
      }

      await buildProjectBackground(binding.projectId, `room_closed:${input.platform}_${input.kind}_${input.reason}`);
    }
  };

  const notifyBoundDiscordChannels = async (projectId: string, content: string): Promise<void> => {
    const discordBindings = projectBindings.list().filter((binding) => binding.projectId === projectId && binding.platform === 'discord');
    if (discordBindings.length === 0) return;
    for (const binding of discordBindings) {
      const discordTarget = binding.threadId ?? binding.channelTarget;
      const discordInstance = discordChannels.find((channel) => channel.agentId === binding.agentId)
        ?? discordChannel
        ?? discordChannels[0];
      if (!discordInstance) continue;
      await discordInstance.send({
        target: discordTarget,
        content,
      }).catch(() => {});
    }
  };

  const notifyPatchApprovalReview = async (input: {
    projectId: string;
    approvalId: string;
    artifactName: string;
    requestedByNodeId?: string;
    requestedByPrincipalId?: string;
    sourceBranch?: string;
    targetBranch?: string;
    conflictSummary?: string;
  }): Promise<void> => {
    const project = projectRegistry.get(input.projectId);
    const discordBindings = projectBindings.list().filter((binding) => binding.projectId === input.projectId && binding.platform === 'discord');
    if (discordBindings.length === 0) return;
    for (const binding of discordBindings) {
      const discordTarget = binding.threadId ?? binding.channelTarget;
      const discordInstance = discordChannels.find((channel) => channel.agentId === binding.agentId)
        ?? discordChannel
        ?? discordChannels[0];
      if (!discordInstance) continue;
      await discordInstance.sendPatchApprovalRequest({
        channelId: discordTarget,
        projectId: input.projectId,
        projectSlug: project?.slug,
        approvalId: input.approvalId,
        artifactName: input.artifactName,
        requestedByNodeId: input.requestedByNodeId,
        requestedByPrincipalId: input.requestedByPrincipalId,
        sourceBranch: input.sourceBranch,
        targetBranch: input.targetBranch,
        conflictSummary: input.conflictSummary,
      }).catch(() => {});
    }
  };

  const getNodeIdentity = () => {
    if (!nodeIdentity) throw new Error('Node identity not initialized');
    return nodeIdentity;
  };

  const buildProjectBackground = async (
    projectId: string,
    reason: string,
    shared?: SharedSession | null,
  ) => {
    const project = projectRegistry.get(projectId);
    if (!project) return null;
    const artifactRegistry = new ProjectArtifactRegistry(defaultProjectArtifactsRoot(runtimePaths, projectId), projectId);
    const worktreeRegistry = new ProjectWorktreeRegistry(join(getRuntimePaths().projectsDir, projectId, 'worktrees'), projectId);
    const branchRegistry = new ProjectBranchRegistry(projectBranchesRoot(runtimePaths, projectId), projectId);
    const backgroundRegistry = new ProjectBackgroundRegistry(projectBackgroundRoot(runtimePaths, projectId));
    await Promise.all([artifactRegistry.load(), worktreeRegistry.load(), branchRegistry.load(), backgroundRegistry.load()]);
    const branches = branchRegistry.list();
    const members = projectMemberships.listByProject(projectId).map((membership) => ({
      principalId: membership.principalId,
      displayName: principalRegistry.get(membership.principalId)?.displayName,
      role: membership.role,
    }));
    const worktrees = await Promise.all(worktreeRegistry.list().map(async (worktree) => {
      const repo = await getWorktreeRepoStatus(worktree.root);
      const branch = branches.find((row) => row.nodeId === worktree.nodeId && row.status === 'active');
      return {
        ...worktree,
        branch: branch?.branchName ?? repo.branch,
        dirty: repo.dirty,
      };
    }));
    const networkSession = networkSharedSessions.findByProject(projectId).find((candidate) => candidate.participantNodeIds.includes(getNodeIdentity().nodeId)) ?? null;
    const snapshot = await backgroundRegistry.buildAndSave({
      project,
      reason,
      sharedSession: shared ?? null,
      networkSession,
      members,
      artifacts: artifactRegistry.list(),
      worktrees,
    });
    for (const session of sessions.list()) {
      if (session.metadata?.projectId === projectId) {
        session.metadata.projectBackgroundSummary = snapshot.summary;
      }
    }
    return snapshot;
  };

  const activateCollaborativeProject = async (projectId: string, reason: string): Promise<Project | null> => {
    const project = projectRegistry.get(projectId);
    if (!project) return null;
    const memberCount = projectMemberships.listByProject(projectId).length;
    if (memberCount <= 1) return project;
    if (project.collaboration?.mode === 'collaborative') return project;
    const updated = await projectRegistry.update(projectId, {
      collaboration: {
        ...(project.collaboration ?? {}),
        mode: 'collaborative',
        announceJoins: true,
        autoArtifactSync: project.collaboration?.autoArtifactSync ?? true,
      },
      metadata: {
        ...(project.metadata ?? {}),
        collaborationActivatedAt: new Date().toISOString(),
        collaborationActivatedReason: reason,
      },
    });
    if (hubClient && nodeIdentity) {
      await syncProjectToHub(hubClient, nodeIdentity, updated, projectMemberships).catch(() => {});
    }
    return updated;
  };

  const autoEnrollCollaborativePrincipal = async (input: {
    project: Project;
    principalId: string;
    principalName?: string;
    platform: 'discord' | 'telegram' | 'cli';
    addedBy: string;
  }): Promise<boolean> => {
    if (input.project.collaboration?.mode !== 'collaborative') return false;
    if (input.platform !== 'discord') return false;
    if (isProjectMember(projectMemberships, input.project.projectId, input.principalId)) return false;
    if (input.principalId === input.project.ownerPrincipalId) return false;
    await projectMemberships.upsert({
      projectId: input.project.projectId,
      principalId: input.principalId,
      role: 'contribute',
      addedBy: input.addedBy,
    });
    await buildProjectBackground(input.project.projectId, `member_auto_join:${input.principalId}`);
    if (hubClient && nodeIdentity) {
      await syncProjectMembershipsToHub(hubClient, nodeIdentity, input.project.projectId, projectMemberships).catch(() => {});
    }
    const who = input.principalName ?? input.principalId;
    await notifyBoundDiscordChannels(
      input.project.projectId,
      `[member] ${who} joined ${input.project.slug} as contributor`,
    );
    return true;
  };

  const ensureDiscordBootstrapOwnership = async (
    agentId: string,
    authorId: string,
    principalId?: string,
  ): Promise<boolean> => {
    const acl = await loadAllowFrom('discord', agentId);
    if (acl.mode === 'open' && acl.claimed !== true) {
      const claimed = await claimOwner('discord', agentId, authorId, principalId);
      return claimed.success;
    }
    if (acl.mode !== 'allowlist' || acl.claimed !== true) return false;
    const ownerPrincipalId = acl.allowedPrincipalIds?.[0];
    if (ownerPrincipalId && principalId) return ownerPrincipalId === principalId;
    const ownerUserId = acl.allowedUserIds[0];
    return ownerUserId === authorId;
  };

  const normalizeDiscordPolicyIdentity = (value?: string | null): string | null => {
    if (!value) return null;
    const normalized = value.trim().replace(/^@+/, '').toLowerCase();
    return normalized.length > 0 ? normalized : null;
  };

  const matchesDiscordPolicyUser = (
    configured: string[] | undefined,
    input: { authorId: string; authorName?: string; username?: string; principalId?: string },
  ): boolean => {
    if (!configured?.length) return false;
    const candidates = new Set<string>();
    const add = (value?: string | null) => {
      const normalized = normalizeDiscordPolicyIdentity(value);
      if (normalized) candidates.add(normalized);
    };
    add(input.authorId);
    add(input.authorName);
    add(input.username);
    add(input.principalId);
    return configured.some((value) => {
      const normalized = normalizeDiscordPolicyIdentity(value);
      return normalized ? candidates.has(normalized) : false;
    });
  };

  const isDiscordInvocationAllowed = async (input: {
    agentId: string;
    authorId: string;
    authorName?: string;
    username?: string;
    principalId?: string;
    channelName?: string;
    parentChannelName?: string;
    project?: Project | null;
  }): Promise<{ allowed: boolean; reason: string }> => {
    const policy = config.channels.discord?.authPolicy;
    if (!policy?.enabled) return { allowed: true, reason: 'policy_disabled' };

    if (input.project) {
      if (input.principalId && isProjectMember(projectMemberships, input.project.projectId, input.principalId)) {
        return { allowed: true, reason: 'project_member' };
      }
      return {
        allowed: input.project.collaboration?.mode === 'collaborative',
        reason: input.project.collaboration?.mode === 'collaborative'
          ? 'project_collaborative_auto_enroll'
          : 'project_membership_required',
      };
    }

    const generalChannels = (policy.generalChannels ?? ['general']).map((name) => name.trim().toLowerCase()).filter(Boolean);
    const channelName = (input.parentChannelName ?? input.channelName ?? '').trim().toLowerCase();
    const isGeneral = channelName.length > 0 && generalChannels.includes(channelName);
    if (isGeneral) {
      const ownerAllowed = await isUserAllowed('discord', input.agentId, input.authorId, input.principalId);
      if (ownerAllowed) return { allowed: true, reason: 'general_owner' };
      return {
        allowed: matchesDiscordPolicyUser(policy.extraGeneralUsers, input),
        reason: 'general_extra_user',
      };
    }

    return {
      allowed: policy.ignoreUnboundChannels !== false ? false : true,
      reason: policy.ignoreUnboundChannels !== false ? 'unbound_channel_ignored' : 'unbound_channel_allowed',
    };
  };

  const resolveDiscordPrincipalIdentity = (identity: string): { principalId: string; displayName: string; userId?: string; username?: string } | null => {
    const normalized = normalizeDiscordPolicyIdentity(identity);
    if (!normalized) return null;
    const mappings = principalRegistry.listMappings().filter((mapping) => mapping.platform === 'discord');
    for (const mapping of mappings) {
      const principal = principalRegistry.get(mapping.principalId);
      const candidates = new Set<string>();
      const add = (value?: string | null) => {
        const candidate = normalizeDiscordPolicyIdentity(value);
        if (candidate) candidates.add(candidate);
      };
      add(mapping.platformUserId);
      add(mapping.username);
      add(mapping.displayName);
      add(mapping.principalId);
      add(principal?.displayName);
      for (const alias of principal?.aliases ?? []) add(alias);
      if (candidates.has(normalized)) {
        return {
          principalId: mapping.principalId,
          displayName: principal?.displayName ?? mapping.displayName ?? mapping.username ?? mapping.platformUserId,
          userId: mapping.platformUserId,
          username: mapping.username,
        };
      }
    }
    return null;
  };

  const manageDiscordProjectMemberFromTool = async (
    input: ProjectMemberManageRequest,
    ctx: import('./tools/tool.js').ToolContext,
  ): Promise<import('./tools/tool.js').ToolResult> => {
    const executionContext = ctx.executionContext;
    if (!executionContext?.projectId) {
      return { output: 'This action requires an active project room or explicit project slug.', success: false, error: 'missing_project_context' };
    }
    if (!executionContext.principalId || !executionContext.authorId || !executionContext.agentId) {
      return { output: '', success: false, error: 'Missing principal or channel execution context.' };
    }
    const project = input.projectSlug
      ? projectRegistry.findBySlug(input.projectSlug)
      : projectRegistry.get(executionContext.projectId);
    if (!project) {
      return { output: '', success: false, error: `Project not found${input.projectSlug ? `: ${input.projectSlug}` : ''}.` };
    }

    const actorRole = getProjectRole(projectMemberships, project.projectId, executionContext.principalId);
    const isOwner = project.ownerPrincipalId === executionContext.principalId;
    const isAdmin = actorRole === 'admin';
    if (!isOwner && !isAdmin) {
      return {
        output: 'Only the project owner or an admin can manage project members.',
        success: false,
        error: 'owner_or_admin_required',
      };
    }

    if (input.action === 'list') {
      const memberships = projectMemberships.listByProject(project.projectId);
      const lines = memberships.map((membership) => {
        const principal = principalRegistry.get(membership.principalId);
        return `- ${principal?.displayName ?? membership.principalId} (${membership.role})`;
      });
      return {
        output: [
          `Project ${project.displayName} (${project.slug}) members:`,
          ...(lines.length ? lines : ['- none']),
        ].join('\n'),
        success: true,
        data: memberships,
      };
    }

    const targetIdentity = input.targetIdentity?.trim();
    if (!targetIdentity) {
      return { output: 'targetIdentity is required to add a project member.', success: false, error: 'missing_target_identity' };
    }
    const resolved = resolveDiscordPrincipalIdentity(targetIdentity);
    if (!resolved) {
      return {
        output: `Could not resolve Discord user or principal: ${targetIdentity}`,
        success: false,
        error: 'target_not_found',
      };
    }
    const role: ProjectRole = input.role ?? 'contribute';
    await projectMemberships.upsert({
      projectId: project.projectId,
      principalId: resolved.principalId,
      role,
      addedBy: executionContext.principalId,
    });
    const updatedProject = await activateCollaborativeProject(project.projectId, `member_added:${resolved.principalId}`);
    const background = await buildProjectBackground(project.projectId, `member_added:${resolved.principalId}`);
    if (hubClient && nodeIdentity) {
      await syncProjectMembershipsToHub(hubClient, nodeIdentity, project.projectId, projectMemberships).catch(() => {});
    }
    await notifyBoundDiscordChannels(
      project.projectId,
      `[member] ${resolved.displayName} added to ${project.slug} as ${role}`,
    );
    return {
      output: [
        `Added ${resolved.displayName} to ${project.displayName} (${project.slug}) as ${role}.`,
        updatedProject?.collaboration?.mode === 'collaborative'
          ? 'Project mode: collaborative.'
          : 'Project mode remains single-user until more than one member exists.',
        background ? `Background: ${background.summary.split('\n')[0]}` : null,
      ].filter(Boolean).join('\n'),
      success: true,
      data: {
        projectId: project.projectId,
        principalId: resolved.principalId,
        role,
      },
    };
  };

  const syncDiscordProjectFromTool = async (
    input: ProjectSyncRequest,
    ctx: import('./tools/tool.js').ToolContext,
  ): Promise<import('./tools/tool.js').ToolResult> => {
    const executionContext = ctx.executionContext;
    if (!executionContext?.projectId) {
      return { output: 'This action requires an active project room or explicit project slug.', success: false, error: 'missing_project_context' };
    }
    if (!executionContext.principalId) {
      return { output: '', success: false, error: 'Missing principal execution context.' };
    }
    const project = input.projectSlug
      ? projectRegistry.findBySlug(input.projectSlug)
      : projectRegistry.get(executionContext.projectId);
    if (!project) {
      return { output: '', success: false, error: `Project not found${input.projectSlug ? `: ${input.projectSlug}` : ''}.` };
    }
    if (!isProjectMember(projectMemberships, project.projectId, executionContext.principalId)) {
      return { output: 'Only project members can sync project state.', success: false, error: 'project_membership_required' };
    }

    const projectRoot = resolveProjectRoot(runtimePaths, project);
    const statusPath = join(projectRoot, 'STATUS.md');
    const update = input.update?.trim();
    if (update) {
      const prior = existsSync(statusPath) ? await readFile(statusPath, 'utf-8') : '# STATUS\n';
      const stamp = new Date().toISOString();
      const appended = `${prior.trimEnd()}\n\n## Sync Notes\n- ${stamp} — ${update}\n`;
      await writeFile(statusPath, appended, 'utf-8');
    }

    const background = await buildProjectBackground(project.projectId, update ? 'project_sync:update' : 'project_sync');
    const summaryLine = background?.summary.split('\n')[0] ?? `Project ${project.displayName} (${project.slug})`;
    const announce = [
      `[sync] ${summaryLine}`,
      update ? `Update: ${update}` : null,
    ].filter(Boolean).join('\n');
    await notifyBoundDiscordChannels(project.projectId, announce);

    return {
      output: [
        `Synced ${project.displayName} (${project.slug}).`,
        update ? 'STATUS.md updated.' : null,
        background ? `Background: ${summaryLine}` : null,
      ].filter(Boolean).join('\n'),
      success: true,
      data: {
        projectId: project.projectId,
        projectSlug: project.slug,
        statusPath,
      },
    };
  };

  const bootstrapDiscordProjectFromTool = async (
    input: ProjectBootstrapRequest,
    ctx: import('./tools/tool.js').ToolContext,
  ): Promise<import('./tools/tool.js').ToolResult> => {
    if (ctx.channelType !== 'discord') {
      return { output: '', success: false, error: 'project_bootstrap currently supports Discord only.' };
    }
    if (!(ctx.channel instanceof DiscordChannel)) {
      return { output: '', success: false, error: 'Discord channel adapter not available in tool context.' };
    }
    const executionContext = ctx.executionContext;
    if (!executionContext?.principalId || !executionContext.authorId || !executionContext.agentId) {
      return { output: '', success: false, error: 'Missing principal or channel execution context.' };
    }

    const prompt = input.prompt?.trim();
    if (!prompt) return { output: '', success: false, error: 'prompt is required.' };

    const intent = inferProjectBootstrapIntent(prompt);
    const destination = input.destination && input.destination !== 'auto'
      ? input.destination
      : intent.destination;
    const projectType = intent.projectType;
    const displayName = input.displayName?.trim() || intent.displayName;
    const slug = input.slug?.trim() || intent.slug;
    const description = input.description?.trim() || intent.description;

    const isOwner = await ensureDiscordBootstrapOwnership(executionContext.agentId, executionContext.authorId, executionContext.principalId);
    const currentProjectId = executionContext.projectId;
    const existingRole = currentProjectId
      ? getProjectRole(projectMemberships, currentProjectId, executionContext.principalId)
      : null;
    const isAdmin = existingRole === 'admin';
    if (!isOwner && !isAdmin) {
      return {
        output: 'Project bootstrap is restricted to the claimed owner or a project admin in this Discord context.',
        success: false,
        error: 'owner_or_admin_required',
      };
    }

    const existing = projectRegistry.findBySlug(slug);
    const project = existing ?? await projectRegistry.create({
      slug,
      displayName,
      ownerPrincipalId: executionContext.principalId,
      description,
      collaboration: {
        mode: 'single-user',
        autoArtifactSync: false,
        patchRequiresApproval: true,
        announceJoins: false,
      },
      metadata: {
        createdFrom: 'discord-tool-bootstrap',
        requestedInChannel: executionContext.channelId,
        projectType,
      },
    });
    if (!existing) {
      await bootstrapProjectHome(runtimePaths.projectsDir, project);
    }
    await projectMemberships.upsert({
      projectId: project.projectId,
      principalId: executionContext.principalId,
      role: 'admin',
      addedBy: executionContext.principalId,
    });

    const metadata = executionContext.metadata ?? {};
    const currentChannelTarget = ctx.channelTarget ?? executionContext.channelTarget ?? '';
    const currentThreadId = executionContext.threadId;
    const parentChannelId = typeof metadata['parentChannelId'] === 'string' ? metadata['parentChannelId'] : undefined;
    const guildId = typeof metadata['guildId'] === 'string' ? metadata['guildId'] : undefined;

    let boundChannelTarget = currentChannelTarget;
    let boundThreadId: string | undefined = currentThreadId;
    let createdChannel: { id: string; name: string } | null = null;
    let createdThread: { id: string; name: string } | null = null;

    if (destination === 'channel') {
      if (!guildId) {
        return {
          output: 'Cannot create a Discord channel here because no guild context is available. Ask to use the current channel instead.',
          success: false,
          error: 'missing_guild_context',
        };
      }
      createdChannel = await ctx.channel.createChannel(guildId, slug, {
        topic: description.slice(0, 1024),
        privateUserId: executionContext.authorId,
      });
      boundChannelTarget = createdChannel.id;
      boundThreadId = undefined;
    } else if (destination === 'thread' && !currentThreadId) {
      const threadName = project.displayName.slice(0, 90);
      createdThread = await ctx.channel.createThread(parentChannelId ?? currentChannelTarget, threadName);
      boundChannelTarget = parentChannelId ?? currentChannelTarget;
      boundThreadId = createdThread.id;
    } else if (parentChannelId && currentThreadId) {
      boundChannelTarget = parentChannelId;
      boundThreadId = currentThreadId;
    }

    await projectBindings.bind({
      projectId: project.projectId,
      platform: 'discord',
      channelTarget: boundChannelTarget,
      threadId: boundThreadId,
      agentId: executionContext.agentId,
    });

    if (project.metadata?.['roomState'] === 'pending_rebind') {
      await projectRegistry.update(project.projectId, {
        metadata: {
          ...(project.metadata ?? {}),
          roomState: 'active',
          pendingRoomReason: null,
          pendingRoomAt: null,
          pendingRoomBindingId: null,
        },
      });
    }

    const worktreeRegistry = new ProjectWorktreeRegistry(join(getRuntimePaths().projectsDir, project.projectId, 'worktrees'), project.projectId);
    await worktreeRegistry.load();
    const projectRoot = resolveProjectRoot(runtimePaths, project);
    await worktreeRegistry.register({
      nodeId: getNodeIdentity().nodeId,
      root: projectRoot,
      label: 'owner-default',
      ownerPrincipalId: executionContext.principalId,
    });

    const statusPath = join(projectRoot, 'STATUS.md');
    const projectDocPath = join(projectRoot, 'PROJECT.md');
    const noticePath = join(projectRoot, 'NOTICE.md');
    const modeLabel = project.collaboration?.mode ?? 'single-user';
    const templateSectionsByType: Record<string, string[]> = {
      programming: [
        '## Engineering Focus',
        '- Repo / codebase',
        '- Milestone tasks',
        '- Bugs / blockers',
        '- Review and merge plan',
      ],
      design: [
        '## Design Focus',
        '- Product goals',
        '- User flows',
        '- Screens / assets',
        '- Review checkpoints',
      ],
      research: [
        '## Research Focus',
        '- Research question',
        '- Sources / papers',
        '- Findings',
        '- Open questions',
      ],
      general: [
        '## Project Focus',
        '- Goal',
        '- Workstreams',
        '- Risks',
        '- Next review',
      ],
    };
    const templateSection = templateSectionsByType[projectType] ?? templateSectionsByType.general;
    if (!existsSync(projectDocPath)) {
      const projectDoc = [
        `# ${project.displayName}`,
        '',
        `- Slug: \`${project.slug}\``,
        `- Type: \`${projectType}\``,
        `- Owner principal: \`${project.ownerPrincipalId}\``,
        `- Mode: \`${modeLabel}\``,
        project.description ? '' : null,
        project.description ? '## Description' : null,
        project.description ?? null,
        '',
        ...templateSection,
      ].filter(Boolean).join('\n');
      await writeFile(projectDocPath, `${projectDoc}\n`, 'utf-8');
    }
    if (!existsSync(statusPath)) {
      const statusDoc = [
        `# STATUS`,
        '',
        `Project: ${project.displayName} (\`${project.slug}\`)`,
        `Type: ${projectType}`,
        `Mode: ${modeLabel}`,
        '',
        '## Current Goal',
        '- Define the immediate next milestone.',
        '',
        '## In Progress',
        '- Project room initialized.',
        '',
        '## Done',
        `- Project created by ${executionContext.principalName ?? executionContext.principalId}.`,
        '',
        '## Blockers',
        '- None recorded yet.',
        '',
        '## Next Actions',
        '- Add collaborators if needed.',
        '- Update this file as work progresses.',
        '',
        ...templateSection,
      ].join('\n');
      await writeFile(statusPath, `${statusDoc}\n`, 'utf-8');
    }
    if (!existsSync(noticePath)) {
      const noticeDoc = [
        `# Notice`,
        '',
        `${project.displayName} was initialized as a private ${projectType} project room.`,
        `This room starts in \`${modeLabel}\` mode and becomes collaborative after another member is added.`,
        '',
        '## Workspace',
        `- Local workspace: \`${projectRoot}\``,
        '- Shared starter docs: `PROJECT.md`, `STATUS.md`',
      ].join('\n');
      await writeFile(noticePath, `${noticeDoc}\n`, 'utf-8');
    }

    const background = await buildProjectBackground(project.projectId, existing ? 'discord_tool_rebind' : 'discord_tool_bootstrap');
    if (hubClient && nodeIdentity) {
      await syncProjectToHub(hubClient, nodeIdentity, project, projectMemberships).catch(() => {});
      await syncProjectMembershipsToHub(hubClient, nodeIdentity, project.projectId, projectMemberships).catch(() => {});
    }

    if (createdThread || createdChannel) {
      await ctx.channel.send({
        target: createdThread?.id ?? createdChannel!.id,
        content: [
          `Project room initialized for **${project.displayName}**.`,
          `Type: \`${projectType}\``,
          `Mode: \`${modeLabel}\``,
          `Workspace: \`${projectRoot}\``,
          `Starter docs created: \`PROJECT.md\`, \`STATUS.md\`, \`NOTICE.md\``,
          '',
          'This room is private to the owner until another member is added.',
          '',
          'Intro:',
          project.description || description,
          '',
          background?.summary ?? '',
        ].join('\n\n'),
      }).catch(() => {});
    }

    return {
      output: [
        existing ? `Bound existing project ${project.displayName} (${project.slug}).` : `Created project ${project.displayName} (${project.slug}).`,
        createdChannel ? `Opened channel: ${createdChannel.id}` : null,
        createdThread ? `Opened thread: ${createdThread.id}` : null,
        !createdChannel && !createdThread ? (boundThreadId ? `Bound current thread: ${boundThreadId}` : 'Bound current channel.') : null,
        `Type: ${projectType}`,
        `Workspace: ${projectRoot}`,
        'Starter docs: PROJECT.md, STATUS.md, NOTICE.md',
        background ? `Background: ${background.summary.split('\n')[0]}` : null,
      ].filter(Boolean).join('\n'),
      success: true,
      data: {
        projectId: project.projectId,
        projectSlug: project.slug,
        channelId: createdChannel?.id ?? boundChannelTarget,
        threadId: createdThread?.id ?? boundThreadId,
      },
    };
  };

  const buildInboundExecutionContext = (input: {
    agentId: string;
    sessionId?: string;
    principal?: Awaited<ReturnType<typeof principalRegistry.getOrCreateHuman>> | null;
    authorId: string;
    authorName: string;
    platform: 'discord' | 'telegram' | 'cli';
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
      if (collaborativeProject?.collaboration?.announceJoins !== false) {
        const who = input.ctx.principalName ?? input.ctx.authorName ?? input.ctx.principalId;
        const lines = [`[join] ${who} joined ${collaborativeProject?.slug ?? shared.projectId}`];
        if (snapshot?.summary) lines.push('', snapshot.summary);
        await notifyBoundDiscordChannels(shared.projectId, lines.join('\n'));
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
  const providerMap = new Map<string, import('./providers/provider.js').Provider>();
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

  // Register kernel tools
  toolRegistry.registerAll(fsTools);
  toolRegistry.registerAll(searchTools);
  toolRegistry.registerAll(execTools);
  toolRegistry.registerAll(webTools);
  toolRegistry.registerAll(createGitHubTools());
  toolRegistry.registerAll(createBrowserTools({
    enabled: config.tools.browser?.enabled ?? true,
    headless: config.tools.browser?.headless ?? true,
    idleTimeoutMs: config.tools.browser?.idleTimeoutMs ?? 300_000,
  }));
  toolRegistry.registerAll(imageTools);
  toolRegistry.registerAll(gitTools);
  toolRegistry.registerAll(officeTools);
  toolRegistry.registerAll(createMemoryTools({
    workspaceRoot: config.memory.workspace,
    embeddingProvider: embeddingProvider ?? undefined,
  }));
  toolRegistry.registerAll(createSessionTools(sessions));
  toolRegistry.registerAll(createAllowFromTools());
  toolRegistry.registerAll(createProjectTools({
    bootstrapFromPrompt: bootstrapDiscordProjectFromTool,
    manageMember: manageDiscordProjectMemberFromTool,
    syncProject: syncDiscordProjectFromTool,
  }));

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
  const acpRuntime = new AcpxRuntime(acpConfig);
  await acpRuntime.probeAvailability();
  const acpAvailable = acpRuntime.isHealthy();
  console.log(`[acp] Runtime: ${acpAvailable ? 'available' : 'unavailable'}`);

  // Inject ACP knowledge into ALL agent prompts
  promptBuilder.setAcpConfig({
    enabled: acpAvailable && acpConfig.enabled,
    allowedAgents: acpConfig.allowedAgents,
    defaultAgent: acpConfig.defaultAgent,
  });

  // Old standalone ACP tools removed — sessions_spawn(runtime="acp") replaces them.
  // AcpSessionManager kept for CLI `tako acp` commands only.
  const acpSessionManager = new AcpSessionManager(acpConfig, acpRuntime);
  acpSessionManager.startCleanup();

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
          return handleSlashCommand(commandName, channelId, author, agentId, dc, guildId);
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
    agentPromptBuilder.setAcpConfig({
      enabled: acpAvailable && acpConfig.enabled,
      allowedAgents: acpConfig.allowedAgents,
      defaultAgent: acpConfig.defaultAgent,
    });
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

  // Register agent tools (agents_list, sessions_spawn, sessions_history, subagents)
  toolRegistry.registerAll(createAgentTools({
    registry: agentRegistry,
    orchestrator: subAgentOrchestrator,
    sessions,
    threadBindings,
    acpRuntime,
    acpConfig,
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
      await notifyBoundDiscordChannels(projectId, `[patch ${decision}] ${resolved.artifactName} (${resolved.approvalId})`);
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
        const { handleAcpThreadMessage } = await import('./tools/agent-tools.js');
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
            platform: channelType as 'discord' | 'telegram' | 'cli',
            channelId: msg.channelId,
            channelTarget,
            project: resolvedProject?.project ?? null,
            threadId: msg.threadId,
            metadata: { ...(msg.author.meta ?? {}) },
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
        platform: channelType as 'discord' | 'telegram' | 'cli',
        channelId: msg.channelId,
        channelTarget,
        project: resolvedProject?.project ?? null,
        threadId: msg.threadId,
        metadata: { ...(msg.author.meta ?? {}) },
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
          platform: channelType as 'discord' | 'telegram' | 'cli',
          channelId: msg.channelId,
          channelTarget,
          threadId: msg.threadId,
          project: resolvedProject?.project ?? null,
          metadata: { ...(msg.author.meta ?? {}) },
        })),
      },
    });
    let ctx = buildInboundExecutionContext({
      agentId,
      sessionId: session.id,
      principal: principalRegistry.get(msg.author.principalId ?? '') ?? null,
      authorId: msg.author.id,
      authorName: msg.author.name,
      platform: channelType as 'discord' | 'telegram' | 'cli',
      channelId: msg.channelId,
      channelTarget,
      threadId: msg.threadId,
      project: resolvedProject?.project ?? null,
      metadata: { ...(msg.author.meta ?? {}) },
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
      const channelType = msg.channelId.split(':')[0] ?? channel.id ?? 'cli';
      const channelTarget = msg.channelId.includes(':')
        ? msg.channelId.split(':').slice(1).join(':')
        : msg.channelId;
      const projectChannelTarget = (msg.author.meta?.parentChannelId as string | undefined) ?? channelTarget;
      const guildId = msg.author.meta?.guildId as string | undefined;
      const inboundAgentId = channel.agentId ?? resolveAgentForChannel(agentRegistry.list(), channelType, channelTarget, guildId);
      const resolvedProject = resolveProject({
        platform: channelType as 'discord' | 'telegram' | 'cli',
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
      const inboundContext = buildInboundExecutionContext({
        agentId: inboundAgentId,
        principal,
        authorId: msg.author.id,
        authorName: msg.author.name,
        platform: channelType as 'discord' | 'telegram' | 'cli',
        channelId: msg.channelId,
        channelTarget,
        threadId: msg.threadId,
        project: resolvedProject?.project ?? null,
        projectRole: projectRole ?? null,
        metadata: { ...(msg.author.meta ?? {}) },
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
          const allowed = await isUserAllowed(aclChannel, aclAgentId, msg.author.id, principal.principalId);
          if (!allowed) return; // silently ignore
        }
      }

      if (resolvedProject && !isProjectMember(projectMemberships, resolvedProject.project.projectId, principal.principalId)) {
        const enrolled = await autoEnrollCollaborativePrincipal({
          project: resolvedProject.project,
          principalId: principal.principalId,
          principalName: principal.displayName,
          platform: channelType as 'discord' | 'telegram' | 'cli',
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

      const session = await getSession(msg, channel, resolvedProject);

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

      // Extract platform-specific target for typing/reactions
      const target = session.metadata.channelTarget as string;

      // Activation intro message intentionally disabled.

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
  let telegramChannel: TelegramChannel | undefined;

  // Track which channels have received an intro (persistent across restarts)
  const introFilePath = getRuntimePaths().introducedChannelsFile;
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

  const isSkillSlashCommand = (name: string): boolean => skillCommandSpecs.some((s) => s.name === name);

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
        metadata: guildId ? { guildId } : undefined,
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
      metadata: guildId ? { guildId } : undefined,
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
      const enrolled = await autoEnrollCollaborativePrincipal({
        project: resolvedProject.project,
        principalId: principal.principalId,
        principalName: principal.displayName,
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
      return handleSlashCommand(commandName, channelId, author, agentId, discordChannel!, guildId);
    });

    // Merge user-invocable skills into slash commands before connect (single registration on ready)
    await discordChannel.registerSkillCommands(skillCommandSpecs, async (commandName, channelId, author, guildId) => {
      const agentId = resolveAgentForChannel(agentRegistry.list(), 'discord', channelId);
      return handleSlashCommand(commandName, channelId, author, agentId, discordChannel!, guildId);
    });

    // Register interactive model picker for Discord /model command
    discordChannel.setInteractiveHandler('model', async (interaction) => {
      // Build provider → models map from all known providers
      const providerModelsMap: Record<string, string[]> = {};

      // Anthropic models (always available)
      const anthropicProvider = new AnthropicProvider(config.providers.anthropic?.setupToken ?? config.providers.anthropic?.apiKey, undefined, config.providers.anthropic?.baseUrl);
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

    discordChannel.onRoomClosed(async (event) => {
      await handleClosedProjectRoom({
        platform: 'discord',
        channelId: event.channelId,
        kind: event.kind,
        reason: event.reason,
      });
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
      if (interaction.customId.startsWith('patchapprove:') || interaction.customId.startsWith('patchdeny:')) {
        const [action, projectId, approvalId] = interaction.customId.split(':');
        if (!projectId || !approvalId) {
          await interaction.reply({ content: 'Malformed patch approval action.', flags: 64 }).catch(() => {});
          return true;
        }
        const principal = await principalRegistry.getOrCreateHuman({
          displayName: interaction.user.displayName || interaction.user.username,
          platform: 'discord',
          platformUserId: interaction.user.id,
        });
        const approvals = new ProjectApprovalRegistry(projectApprovalsRoot(runtimePaths, projectId), projectId);
        await approvals.load();
        const existing = approvals.get(approvalId);
        if (!existing) {
          await interaction.reply({ content: `Approval not found: ${approvalId}`, flags: 64 }).catch(() => {});
          return true;
        }
        const resolved = await approvals.resolve(
          approvalId,
          action === 'patchapprove' ? 'approved' : 'denied',
          principal.principalId,
          `Resolved in Discord by ${principal.displayName}`,
        );
        await interaction.update({
          content: `${interaction.message.content}\n\nResolved: **${resolved.status}** by ${principal.displayName}`,
          components: [],
        }).catch(async () => {
          await interaction.reply({ content: `Resolved ${resolved.artifactName}: ${resolved.status}`, flags: 64 }).catch(() => {});
        });
        await notifyBoundDiscordChannels(projectId, `[patch ${resolved.status}] ${resolved.artifactName} (${resolved.approvalId}) by ${principal.displayName}`);
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
      const principal = await principalRegistry.getOrCreateHuman({
        displayName: author.name,
        platform: 'telegram',
        platformUserId: author.id,
        username: typeof author.meta?.username === 'string' ? author.meta.username : undefined,
        metadata: { channelId: `telegram:${chatId}` },
      });
      const channelKey = `telegram:${chatId}`;
      const agentId = resolveAgentForChannel(agentRegistry.list(), 'telegram', chatId);
      const resolvedProject = resolveProject({
        platform: 'telegram',
        channelTarget: chatId,
        agentId,
      });
      const projectRole = resolvedProject
        ? getProjectRole(projectMemberships, resolvedProject.project.projectId, principal.principalId) ?? undefined
        : undefined;
      const sessionKey = `agent:${agentId}:${channelKey}`;
      const session = sessions.getOrCreate(sessionKey, {
        name: `${agentId}/${channelKey}/${author.name}`,
        metadata: toSessionMetadata(buildInboundExecutionContext({
          agentId,
          principal,
          authorId: author.id,
          authorName: author.name,
          platform: 'telegram',
          channelId: channelKey,
          channelTarget: chatId,
          project: resolvedProject?.project ?? null,
          projectRole: projectRole ?? null,
          metadata: { ...(author.meta ?? {}) },
        })),
      });
      let executionContext = buildInboundExecutionContext({
        agentId,
        sessionId: session.id,
        principal,
        authorId: author.id,
        authorName: author.name,
        platform: 'telegram',
        channelId: channelKey,
        channelTarget: chatId,
        project: resolvedProject?.project ?? null,
        projectRole: projectRole ?? null,
        metadata: { ...(author.meta ?? {}) },
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
      applyExecutionContextToSession(session, executionContext, telegramChannel ?? undefined);

      if (resolvedProject && !isProjectMember(projectMemberships, resolvedProject.project.projectId, principal.principalId)) {
        return 'You are not a member of this project.';
      }

      return commandRegistry.handle('/' + commandName, {
        ...toCommandContext(executionContext),
        session,
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
        allowUnmentionedChannels: agent.bindings.discord?.channels,
      });
      agentDiscord.agentId = agent.id;

      // Register slash commands for this agent's bot too
      agentDiscord.setSlashCommands(nativeCommandList, async (commandName, channelId, author, guildId) => {
        return handleSlashCommand(commandName, channelId, author, agent.id, agentDiscord, guildId);
      });

      // Merge user-invocable skill commands before connect (use agent-specific specs if available)
      const agentSpecificSkillSpecs = agentSkillCommandSpecsMap.get(agent.id) ?? skillCommandSpecs;
      await agentDiscord.registerSkillCommands(agentSpecificSkillSpecs, async (commandName, channelId, author, guildId) => {
        return handleSlashCommand(commandName, channelId, author, agent.id, agentDiscord, guildId);
      });

      agentDiscord.onRoomClosed(async (event) => {
        await handleClosedProjectRoom({
          platform: 'discord',
          channelId: event.channelId,
          kind: event.kind,
          reason: event.reason,
          agentId: agent.id,
        });
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
        const principal = await principalRegistry.getOrCreateHuman({
          displayName: author.name,
          platform: 'telegram',
          platformUserId: author.id,
          username: typeof author.meta?.username === 'string' ? author.meta.username : undefined,
          metadata: { channelId: `telegram:${chatId}` },
        });
        const channelKey = `telegram:${chatId}`;
        const resolvedProject = resolveProject({
          platform: 'telegram',
          channelTarget: chatId,
          agentId: agent.id,
        });
        const projectRole = resolvedProject
          ? getProjectRole(projectMemberships, resolvedProject.project.projectId, principal.principalId) ?? undefined
          : undefined;
        const sessionKey = `agent:${agent.id}:${channelKey}`;
        const session = sessions.getOrCreate(sessionKey, {
          name: `${agent.id}/${channelKey}/${author.name}`,
          metadata: toSessionMetadata(buildInboundExecutionContext({
            agentId: agent.id,
            principal,
            authorId: author.id,
            authorName: author.name,
            platform: 'telegram',
            channelId: channelKey,
            channelTarget: chatId,
            project: resolvedProject?.project ?? null,
            projectRole: projectRole ?? null,
            metadata: { ...(author.meta ?? {}) },
          })),
        });
        let executionContext = buildInboundExecutionContext({
          agentId: agent.id,
          sessionId: session.id,
          principal,
          authorId: author.id,
          authorName: author.name,
          platform: 'telegram',
          channelId: channelKey,
          channelTarget: chatId,
          project: resolvedProject?.project ?? null,
          projectRole: projectRole ?? null,
          metadata: { ...(author.meta ?? {}) },
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
        applyExecutionContextToSession(session, executionContext, agentTelegram);

        if (resolvedProject && !isProjectMember(projectMemberships, resolvedProject.project.projectId, principal.principalId)) {
          return 'You are not a member of this project.';
        }

        return commandRegistry.handle('/' + commandName, {
          ...toCommandContext(executionContext),
          session,
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

  if (hubClient) {
    try {
      await registerNodeWithHub(hubClient, identity, capabilityRegistry);
      await syncAllProjectsToHub(hubClient, identity, projectRegistry, projectMemberships);
    } catch (err) {
      console.warn(`[network] Failed to sync edge to hub ${config.network?.hub}: ${err instanceof Error ? err.message : String(err)}`);
    }
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

  if (hubClient) {
    const heartbeatSeconds = Math.max(5, config.network?.heartbeatSeconds ?? 30);
    const timer = setInterval(() => {
      void hubClient.heartbeat(identity.nodeId).catch((err) => {
        console.warn(`[network] Hub heartbeat failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, heartbeatSeconds * 1000);
    stopHubHeartbeat = () => clearInterval(timer);

    const pollTimer = setInterval(() => {
      void pollNetworkSessionEvents(hubClient, networkSharedSessions, identity.nodeId, {
        sessions,
        onEvent: async (event) => {
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
            await notifyBoundDiscordChannels(result.projectId, `[#${event.fromNodeId}] delegation ${result.status}: ${result.summary}`);
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
            await notifyBoundDiscordChannels(event.projectId, lines.join('\n'));
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
            await notifyBoundDiscordChannels(project.projectId, `[#${event.fromNodeId}] synced ${artifact.kind} artifact: ${artifact.name}${patchHint}`);
            return;
          }

          if (event.type === 'message' && event.payload.text && event.projectId) {
            await buildProjectBackground(event.projectId, `network_message:${event.fromNodeId}`);
            await notifyBoundDiscordChannels(event.projectId, `[#${event.fromNodeId}] ${event.payload.text}`);
          }
        },
      }).catch((err) => {
        console.warn(`[network] Session poll failed: ${err instanceof Error ? err.message : String(err)}`);
      });
    }, heartbeatSeconds * 1000);
    stopNetworkPolling = () => clearInterval(pollTimer);
  }

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

      // Re-register skill commands with Discord after reload
      if (discordChannels.length > 0) {
        try {
          const loadedAfterReload = skillLoader.getAll();
          const rebuiltSpecs = buildSkillCommands(loadedAfterReload);
          skillCommandSpecs.splice(0, skillCommandSpecs.length, ...rebuiltSpecs);

          for (const dc of discordChannels) {
            await dc.registerSkillCommands(skillCommandSpecs, async (commandName, channelId, author, guildId) => {
              const agentId = dc.agentId ?? resolveAgentForChannel(agentRegistry.list(), 'discord', channelId);
              return handleSlashCommand(commandName, channelId, author, agentId, dc, guildId);
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
      const agentJsonPath = join(getRuntimePaths().agentsDir, agentId, 'agent.json');
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

      const agentJsonPath = join(getRuntimePaths().agentsDir, agentId, 'agent.json');
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

      const agentJsonPath = join(getRuntimePaths().agentsDir, agentId, 'agent.json');
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
