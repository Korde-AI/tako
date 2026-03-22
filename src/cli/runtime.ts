import { hasConfig } from '../config/resolve.js';
import { runOnboard } from '../onboard/onboard.js';
import { runModels } from '../onboard/models.js';
import { runChannels } from '../onboard/channels.js';
import { runStartDaemon, runStop, runRestart, runStatus, runTui, runDev } from '../daemon/commands.js';
import { runConfig } from './config.js';
import { runCron } from './cron.js';
import { runMemory } from './memory.js';
import { runLogs } from './logs.js';
import { runMessage } from './message.js';
import { runNuke } from './nuke.js';
import { runMod } from './mods.js';
import { runDoctor } from './doctor.js';
import { runSkills } from './skills.js';
import { runSandbox } from './sandbox.js';
import { runAgents } from './agents.js';
import { runSessions } from './sessions.js';
import { runUpdate } from './update.js';
import { runService } from './service.js';
import { runCache } from './cache.js';
import { runAudit } from './audit.js';
import { runAcp } from './acp.js';
import { runExtensions } from './extensions.js';
import { runSymphony } from './symphony.js';
import { runHubCli } from './hub.js';
import { runPrincipals } from './principals.js';
import { runProjects } from './projects.js';
import { runSharedSessions } from './shared-sessions.js';
import { runNetwork } from './network.js';
import { setRuntimePaths } from '../core/paths.js';
import { parseNodeMode, type NodeMode } from '../core/runtime-mode.js';
import { startHubServer } from '../hub/server.js';

export interface ParseGlobalOptionsResult {
  args: string[];
  home?: string;
  mode?: NodeMode;
  hub?: string;
  port?: number;
  bind?: string;
}

export interface CliRuntimeHandlers {
  runEdgeRuntime(): Promise<void>;
}

export interface RunCliRuntimeInput {
  argv: string[];
  version: string;
  handlers: CliRuntimeHandlers;
}

export function parseGlobalOptions(argv: string[]): ParseGlobalOptionsResult {
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

export function printHelp(version: string): void {
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
  tako version                      Print version (${version})
`);
}

export async function runCliRuntime(input: RunCliRuntimeInput): Promise<void> {
  process.on('uncaughtException', (error) => {
    console.error('[tako] Uncaught exception:', error.message);
    console.error(error.stack);
  });

  process.on('unhandledRejection', (reason) => {
    console.error('[tako] Unhandled rejection:', reason);
  });

  const parsed = parseGlobalOptions(input.argv);
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
      if (!hasConfig()) {
        console.log('No tako.json found. Run `tako onboard` to set up Tako first.\n');
        await runOnboard();
        return;
      }
      if (args.includes('--daemon') || args.includes('-d')) {
        await runStartDaemon();
      } else if (args.includes('--background')) {
        await input.handlers.runEdgeRuntime();
      } else {
        await input.handlers.runEdgeRuntime();
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
      console.log(`tako v${input.version}`);
      break;
    case 'help':
    case '--help':
    case '-h':
      printHelp(input.version);
      break;
    default:
      console.error(`Unknown command: ${command}`);
      printHelp(input.version);
      process.exit(1);
  }
}
