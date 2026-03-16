/**
 * Daemon management commands: start-daemon, stop, restart, status, tui-attach, dev.
 */

import { spawn as nodeSpawn, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import {
  writePidFile,
  removePidFile,
  getDaemonStatus,
  isProcessRunning,
  getPidPath,
} from './pid.js';
import { getRuntimeHome, getRuntimeMode } from '../core/paths.js';
import { readNodeIdentity } from '../core/node-identity.js';
import { ProjectRegistry } from '../projects/registry.js';
import { SharedSessionRegistry } from '../sessions/shared.js';
import { TrustStore } from '../network/trust.js';
import { InviteStore } from '../network/invites.js';
import { NetworkSharedSessionStore } from '../network/shared-sessions.js';
import { getRuntimePaths } from '../core/paths.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const INDEX_PATH = join(__dirname, '..', 'index.js');
/** Resolve to the source entry point for Bun (native TS) or compiled JS for Node. */
const SRC_INDEX_PATH = join(__dirname, '..', '..', 'src', 'index.ts');

const VERSION = '0.0.1';

/** Find the Bun binary, or null if not available. */
function findBun(): string | null {
  try {
    return execSync('which bun', { encoding: 'utf-8' }).trim() || null;
  } catch {
    return null;
  }
}

/** Check if we're running under Bun. */
function isBun(): boolean {
  return typeof (globalThis as any).Bun !== 'undefined';
}

/** Get the runtime command + entry point for spawning Tako. */
function getRuntimeArgs(): { cmd: string; args: string[] } {
  // If running under Bun, use Bun
  if (isBun()) {
    return { cmd: process.argv[0], args: [SRC_INDEX_PATH] };
  }
  // If Bun is available, prefer it
  const bun = findBun();
  if (bun) {
    return { cmd: bun, args: [SRC_INDEX_PATH] };
  }
  // Fallback to Node with compiled JS
  return { cmd: process.argv[0], args: [INDEX_PATH] };
}

/** Start Tako as a background daemon. */
export async function runStartDaemon(): Promise<void> {
  const status = await getDaemonStatus();
  if (status.running) {
    console.log(`Tako is already running (PID: ${status.info!.pid})`);
    console.log(`   Use 'tako tui' to attach the TUI`);
    console.log(`   Use 'tako restart' to restart`);
    return;
  }

  if (status.stale) {
    console.log(`Removing stale PID file (PID: ${status.info!.pid} is not running)...`);
    await removePidFile();
  }

  console.log('Starting Tako in background...');

  const rt = getRuntimeArgs();
  const bind = process.env['TAKO_GATEWAY_BIND'] ?? '127.0.0.1';
  const port = process.env['TAKO_GATEWAY_PORT']
    ? Number.parseInt(process.env['TAKO_GATEWAY_PORT'], 10)
    : 18790;
  const child = nodeSpawn(rt.cmd, [...rt.args, 'start', '--background'], {
    // Thread the current home/mode into the child daemon.
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, TAKO_HOME: getRuntimeHome(), TAKO_MODE: getRuntimeMode() },
  });

  child.unref();

  if (child.pid) {
    const identity = await readNodeIdentity();
    await writePidFile({
      pid: child.pid,
      startedAt: new Date().toISOString(),
      port,
      bind,
      mode: getRuntimeMode(),
      home: getRuntimeHome(),
      nodeId: identity?.nodeId,
    });

    console.log(`Tako started (PID: ${child.pid})`);
    console.log(`   Gateway: ws://${bind}:${port}`);
    console.log(`   PID file: ${getPidPath()}`);
    console.log('');
    console.log('Commands:');
    console.log('   tako tui        Attach TUI');
    console.log('   tako status     Check status');
    console.log('   tako stop       Stop daemon');
    console.log('   tako restart    Restart daemon');
  } else {
    console.error('Failed to start Tako daemon');
  }

  process.exit(0);
}

/** Stop the Tako daemon. */
export async function runStop(): Promise<void> {
  const status = await getDaemonStatus();

  if (!status.info) {
    console.log('Tako is not running (no PID file found)');
    return;
  }

  if (status.stale) {
    console.log(`Cleaning up stale PID file (PID: ${status.info.pid} was not running)`);
    await removePidFile();
    return;
  }

  console.log(`Stopping Tako (PID: ${status.info.pid})...`);

  try {
    process.kill(status.info.pid, 'SIGTERM');

    // Wait for process to exit (max 5 seconds)
    let attempts = 0;
    while (isProcessRunning(status.info.pid) && attempts < 50) {
      await new Promise((r) => setTimeout(r, 100));
      attempts++;
    }

    if (isProcessRunning(status.info.pid)) {
      console.log('Process did not exit gracefully, sending SIGKILL...');
      process.kill(status.info.pid, 'SIGKILL');
    }

    await removePidFile();
    console.log('Tako stopped.');
  } catch (err) {
    console.error(`Failed to stop: ${err instanceof Error ? err.message : err}`);
    await removePidFile();
  }
}

/** Restart the Tako daemon. */
export async function runRestart(): Promise<void> {
  const status = await getDaemonStatus();
  if (status.running) {
    await runStop();
    await new Promise((r) => setTimeout(r, 1000));
  }
  await runStartDaemon();
}

/** Show daemon status + runtime config info. */
export async function runStatus(args: string[] = []): Promise<void> {
  const daemonStatus = await getDaemonStatus();
  const json = args.includes('--json');
  const paths = getRuntimePaths();
  const identity = await readNodeIdentity();
  const projects = new ProjectRegistry(paths.projectsDir);
  const sharedSessions = new SharedSessionRegistry(paths.sharedSessionsDir);
  const trusts = new TrustStore(paths.trustFile);
  const invites = new InviteStore(paths.invitesFile);
  const networkSessions = new NetworkSharedSessionStore(paths.networkSessionsFile, paths.networkEventsFile);
  await Promise.all([projects.load(), sharedSessions.load(), trusts.load(), invites.load(), networkSessions.load()]);
  await invites.expirePending();

  const summary = {
    version: VERSION,
    mode: getRuntimeMode(),
    home: getRuntimeHome(),
    daemon: daemonStatus.running && daemonStatus.info ? {
      running: true,
      pid: daemonStatus.info.pid,
      bind: daemonStatus.info.bind,
      port: daemonStatus.info.port,
      startedAt: daemonStatus.info.startedAt,
      nodeId: daemonStatus.info.nodeId ?? identity?.nodeId ?? null,
    } : {
      running: false,
      stale: daemonStatus.stale,
    },
    paths: {
      pidFile: getPidPath(),
      configFile: paths.configFile,
      workspaceDir: paths.workspaceDir,
    },
    node: identity ?? null,
    collaboration: {
      projectCount: projects.list().length,
      sharedSessionCount: sharedSessions.list().length,
      networkSessionCount: networkSessions.list().length,
      trustCount: trusts.list().length,
      trustedCount: trusts.list().filter((record) => record.status === 'trusted').length,
      pendingInviteCount: invites.listPending().length,
    },
  };

  if (json) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }

  console.log(`Tako v${VERSION}\n`);
  console.log(`Mode: ${summary.mode}`);
  console.log(`Home: ${summary.home}`);

  // Daemon info
  if (daemonStatus.running && daemonStatus.info) {
    const uptimeMs = Date.now() - new Date(daemonStatus.info.startedAt).getTime();
    const uptimeSec = Math.floor(uptimeMs / 1000);
    const uptimeMin = Math.floor(uptimeSec / 60);
    const uptimeHr = Math.floor(uptimeMin / 60);
    const uptimeStr = uptimeHr > 0
      ? `${uptimeHr}h ${uptimeMin % 60}m`
      : uptimeMin > 0
        ? `${uptimeMin}m ${uptimeSec % 60}s`
        : `${uptimeSec}s`;

    console.log(`Daemon: RUNNING (PID: ${daemonStatus.info.pid}, uptime: ${uptimeStr})`);
    console.log(`Gateway: ws://${daemonStatus.info.bind}:${daemonStatus.info.port}`);
    if (summary.node?.nodeId) {
      console.log(`Node ID: ${summary.node.nodeId}`);
    }
  } else {
    if (daemonStatus.stale) {
      await removePidFile();
    }
    console.log(`Daemon: NOT RUNNING`);
  }

  console.log(`PID file: ${getPidPath()}`);
  console.log(`Projects: ${summary.collaboration.projectCount}`);
  console.log(`Shared sessions: ${summary.collaboration.sharedSessionCount}`);
  console.log(`Network sessions: ${summary.collaboration.networkSessionCount}`);
  console.log(`Trusts: ${summary.collaboration.trustCount} (${summary.collaboration.trustedCount} trusted)`);
  console.log(`Pending invites: ${summary.collaboration.pendingInviteCount}`);

  // Try to load config for additional info
  try {
    const { resolveConfig } = await import('../config/resolve.js');
    const config = await resolveConfig();

    console.log();
    const configDisplay = daemonStatus.info?.configPath ?? config._configPath ?? resolve('tako.json');
    console.log(`Config: ${configDisplay}`);
    console.log(`Workspace: ${config.memory.workspace}`);
    console.log(`Provider: ${config.providers.primary}`);
    console.log(`Tool profile: ${config.tools.profile}`);
    console.log(`Sandbox: ${config.sandbox.mode}${config.sandbox.mode !== 'off' ? ` (scope: ${config.sandbox.scope}, workspace: ${config.sandbox.workspaceAccess})` : ''}`);
    console.log(`Gateway config: ws://${config.gateway.bind}:${config.gateway.port}`);

    const { SkillLoader } = await import('../skills/loader.js');
    const loader = new SkillLoader(config.skills.dirs);
    const manifests = await loader.discover();
    console.log(`Skills: ${manifests.length} discovered`);

    const { AgentRegistry } = await import('../agents/registry.js');
    const agentReg = new AgentRegistry(config.agents, config.providers.primary);
    await agentReg.loadDynamic();
    console.log(`Agents: ${agentReg.list().length} (${agentReg.list().map((a: any) => a.id).join(', ')})`);

    const channels: string[] = ['cli'];
    if (config.channels.discord?.token) channels.push('discord');
    if (config.channels.telegram?.token) channels.push('telegram');
    console.log(`Channels: ${channels.join(', ')}`);

    const hasAnthropicKey = !!(process.env['ANTHROPIC_API_KEY'] || process.env['OPENCLAW_LIVE_ANTHROPIC_KEY']);
    const hasEmbeddings = !!(process.env['OPENAI_API_KEY'] || process.env['VOYAGE_API_KEY']);
    console.log(`\nAPI Keys:`);
    console.log(`  Anthropic: ${hasAnthropicKey ? 'configured' : 'missing'}`);
    console.log(`  Embeddings: ${hasEmbeddings ? 'configured' : 'not set (BM25-only search)'}`);
  } catch {
    // Config not available — just show daemon status
  }
}

/** Attach TUI to running daemon via gateway WebSocket. */
export async function runTui(): Promise<void> {
  const status = await getDaemonStatus();

  if (!status.running || !status.info) {
    if (status.stale) {
      await removePidFile();
    }
    console.log('Tako is not running for the current home. Start it first:');
    console.log('  tako start -d           Start as daemon');
    console.log('  tako start              Start in foreground');
    process.exit(1);
  }
  const bind = status.info.bind;
  const port = status.info.port;

  const { default: WebSocket } = await import('ws');
  const wsUrl = `ws://${bind}:${port}`;

  console.log(`Connecting to Tako at ${wsUrl}...`);

  const ws = new WebSocket(wsUrl);

  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Connection timeout')), 5000);
    ws.on('open', () => { clearTimeout(timeout); resolve(); });
    ws.on('error', (err) => { clearTimeout(timeout); reject(err); });
  });

  // Create a session
  ws.send(JSON.stringify({ type: 'session_create', name: `tui-${Date.now()}` }));

  // Wait for session creation
  const sessionId = await new Promise<string>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Session creation timeout')), 5000);
    const handler = (data: Buffer) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'session_created') {
        clearTimeout(timeout);
        ws.off('message', handler);
        resolve(msg.sessionId);
      } else if (msg.type === 'error') {
        clearTimeout(timeout);
        ws.off('message', handler);
        reject(new Error(msg.message));
      }
    };
    ws.on('message', handler);
  });

  // Get status info
  ws.send(JSON.stringify({ type: 'status' }));

  let statusModel = 'unknown';
  let statusTools = 0;
  let statusSkills = 0;

  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, 1000);
    const handler = (data: Buffer) => {
      const msg = JSON.parse(data.toString());
      if (msg.type === 'status_info') {
        statusModel = msg.model;
        statusTools = msg.tools;
        statusSkills = msg.skills;
        clearTimeout(timeout);
        ws.off('message', handler);
        resolve();
      }
    };
    ws.on('message', handler);
  });

  // Render TUI connected to the gateway
  const { TUIChannel } = await import('../channels/tui.js');
  const tui = new TUIChannel({
    version: VERSION,
    model: statusModel,
    toolCount: statusTools,
    skillCount: statusSkills,
    toolProfile: 'remote',
    memoryStatus: 'connected',
  });

  // Wire TUI messages to WebSocket
  tui.onMessage(async (msg) => {
    ws.send(JSON.stringify({ type: 'chat', sessionId, content: msg.content }));
  });

  // Wire WebSocket responses back to TUI
  let responseBuffer = '';
  ws.on('message', (data: Buffer) => {
    const msg = JSON.parse(data.toString());
    switch (msg.type) {
      case 'chunk':
      case 'text_delta':
        responseBuffer += msg.text ?? msg.content ?? '';
        break;
      case 'text_done':
        responseBuffer = msg.content;
        break;
      case 'tool_call':
      case 'tool_start': {
        const tuiBridge = (globalThis as any).__takoTui;
        if (tuiBridge) {
          tuiBridge.addMessage({
            id: crypto.randomUUID(),
            role: 'tool',
            content: `Running...`,
            toolName: msg.name,
            timestamp: new Date().toISOString(),
          });
        }
        break;
      }
      case 'tool_result':
      case 'tool_end': {
        const tuiBridge = (globalThis as any).__takoTui;
        if (tuiBridge) {
          const result = (msg.result ?? '').slice(0, 200);
          tuiBridge.addMessage({
            id: crypto.randomUUID(),
            role: 'tool',
            content: `[done] ${result}${result.length >= 200 ? '...' : ''}`,
            toolName: msg.name,
            timestamp: new Date().toISOString(),
          });
        }
        break;
      }
      case 'done':
        if (responseBuffer) {
          tui.send({ target: 'tui', content: responseBuffer }).catch(() => {});
          responseBuffer = '';
        }
        break;
      case 'error':
        if (msg.message) {
          tui.send({ target: 'tui', content: `Error: ${msg.message}` }).catch(() => {});
        }
        responseBuffer = '';
        break;
    }
  });

  ws.on('close', () => {
    console.log('\nDisconnected from Tako daemon.');
    process.exit(0);
  });

  ws.on('error', (err) => {
    console.error('\nWebSocket error:', err.message);
    process.exit(1);
  });

  // Connect TUI (blocks until user quits)
  await tui.connect();

  // Detach cleanly — don't stop the daemon
  ws.close();
}

/** Development mode with watch + auto-restart. */
export async function runDev(): Promise<void> {
  console.log('Tako dev mode — watching for changes...\n');

  // With Bun, no build step needed — it runs TS natively
  const useBun = isBun() || !!findBun();

  if (!useBun) {
    // Node fallback: build first
    console.log('[dev] Building...');
    try {
      execSync('npm run build', { stdio: 'inherit', cwd: process.cwd() });
    } catch {
      console.error('[dev] Initial build failed. Fix errors and try again.');
      process.exit(1);
    }
    console.log('[dev] Build complete.\n');
  } else {
    console.log('[dev] Using Bun — no build step needed.\n');
  }

  // Start tsc --watch in background for type-checking (even with Bun)
  const tsc = nodeSpawn('npx', ['tsc', '--watch', '--preserveWatchOutput', '--noEmit'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    cwd: process.cwd(),
  });

  let serverProcess: ReturnType<typeof nodeSpawn> | null = null;
  let restartTimer: ReturnType<typeof setTimeout> | null = null;
  let restarting = false;

  function startServer() {
    if (serverProcess) {
      serverProcess.kill('SIGTERM');
      serverProcess = null;
    }

    const rt = getRuntimeArgs();
    console.log(`[dev] Starting Tako via ${rt.cmd}...`);
    serverProcess = nodeSpawn(rt.cmd, [...rt.args, 'start', '--tui'], {
      stdio: 'inherit',
      cwd: process.cwd(),
      env: { ...process.env },
    });

    serverProcess.on('exit', (code) => {
      if (!restarting) {
        console.log(`[dev] Tako exited (code: ${code})`);
      }
    });
  }

  function scheduleRestart() {
    if (restartTimer) clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      restarting = true;
      console.log('\n[dev] Changes detected — restarting...');
      startServer();
      restarting = false;
    }, 500);
  }

  // Watch tsc output for successful compilation
  tsc.stdout?.on('data', (data: Buffer) => {
    const text = data.toString();
    process.stdout.write(text);
    if (text.includes('Found 0 errors')) {
      scheduleRestart();
    }
  });
  tsc.stderr?.on('data', (data: Buffer) => {
    process.stderr.write(data.toString());
  });

  // Initial start
  startServer();

  // Clean shutdown
  process.on('SIGINT', () => {
    console.log('\n[dev] Shutting down...');
    tsc.kill();
    serverProcess?.kill();
    process.exit(0);
  });
  process.on('SIGTERM', () => {
    tsc.kill();
    serverProcess?.kill();
    process.exit(0);
  });

  // Keep alive
  await new Promise(() => {});
}
