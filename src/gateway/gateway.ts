/**
 * Gateway — WebSocket server + control plane.
 *
 * Single long-lived daemon process that manages all client connections,
 * routes messages to the agent loop, and handles session lifecycle.
 * Streams agent responses back through WebSocket as chunks.
 */

import { WebSocketServer, WebSocket } from 'ws';
import { createServer, type Server as HttpServer } from 'node:http';
import { spawn as nodeSpawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GatewayConfig, HeartbeatConfig, SessionConfig, TakoConfig } from '../config/schema.js';
import type { Channel, MessageHandler } from '../channels/channel.js';
import type { ClientMessage, ServerMessage, GatewayEvent, EventHandler, SessionInfo } from './protocol.js';
import type { SessionManager } from './session.js';
import type { AgentLoop } from '../core/agent-loop.js';
import type { HookSystem } from '../hooks/types.js';
import type { SandboxManager } from '../sandbox/sandbox.js';
import { HeartbeatManager } from '../core/heartbeat.js';
import { SessionCompactor } from './compaction.js';
import type { ContextManager } from '../core/context.js';
import type { RetryQueue } from '../core/retry-queue.js';
import { ProgressTracker } from '../core/progress.js';
import type { Provider } from '../providers/provider.js';
import { GatewayLock } from './lock.js';
import { getRuntimePaths } from '../core/paths.js';

interface ConnectedClient {
  id: string;
  ws: WebSocket;
  authenticated: boolean;
  sessionId?: string;
}

export interface GatewayDeps {
  sessions: SessionManager;
  agentLoop?: AgentLoop;
  hooks?: HookSystem;
  sandboxManager?: SandboxManager;
  contextManager?: ContextManager;
  heartbeatConfig?: HeartbeatConfig;
  sessionConfig?: SessionConfig;
  workspaceRoot?: string;
  retryQueue?: RetryQueue;
  provider?: Provider;
}

export class Gateway {
  private config: GatewayConfig;
  private deps: GatewayDeps;
  private lock: GatewayLock;
  private handlers = new Map<string, Set<EventHandler>>();
  private clients = new Map<string, ConnectedClient>();
  private wss: WebSocketServer | null = null;
  private httpServer: HttpServer | null = null;
  private running = false;
  private heartbeatManager: HeartbeatManager | null = null;
  private compactor: SessionCompactor | null = null;
  private progressTracker: ProgressTracker | null = null;
  private statusInfo: { model: string; tools: number; skills: number; channels: string[] } | null = null;
  private dynamicChannels: Channel[] = [];
  private defaultMessageRouter: MessageHandler | null = null;

  constructor(config: GatewayConfig, deps: GatewayDeps) {
    this.config = config;
    this.deps = deps;
    this.lock = new GatewayLock(getRuntimePaths().runtimeDir);

    // Initialize heartbeat manager if config provided
    if (deps.heartbeatConfig && deps.workspaceRoot) {
      this.heartbeatManager = new HeartbeatManager(deps.heartbeatConfig, deps.workspaceRoot);
    }

    // Initialize session compactor if config provided
    if (deps.sessionConfig && deps.contextManager) {
      this.compactor = new SessionCompactor(
        deps.sessionConfig,
        deps.contextManager,
        deps.sessions,
        deps.provider,
        deps.hooks,
      );
    }

    // Initialize progress tracker if workspace root provided
    if (deps.workspaceRoot) {
      this.progressTracker = new ProgressTracker(deps.workspaceRoot);
    }
  }

  /** Get the heartbeat manager instance. */
  getHeartbeatManager(): HeartbeatManager | null {
    return this.heartbeatManager;
  }

  /** Get the session compactor instance. */
  getCompactor(): SessionCompactor | null {
    return this.compactor;
  }

  /** Get the progress tracker instance. */
  getProgressTracker(): ProgressTracker | null {
    return this.progressTracker;
  }

  /** Set the default message router for dynamic channels. */
  setMessageRouter(router: MessageHandler): void {
    this.defaultMessageRouter = router;
  }

  /** Dynamically register a channel adapter (called by skills via hooks). */
  async registerChannel(channel: Channel, messageRouter: MessageHandler): Promise<void> {
    channel.onMessage(messageRouter);
    await channel.connect();
    this.dynamicChannels.push(channel);
    console.log(`[gateway] Registered dynamic channel: ${channel.id}`);
  }

  /** Unregister and disconnect a dynamically loaded channel. */
  async unregisterChannel(channelId: string): Promise<void> {
    const idx = this.dynamicChannels.findIndex(c => c.id === channelId);
    if (idx !== -1) {
      const ch = this.dynamicChannels[idx];
      await ch.disconnect();
      this.dynamicChannels.splice(idx, 1);
      console.log(`[gateway] Unregistered dynamic channel: ${channelId}`);
    }
  }

  /** List all dynamic channels. */
  getDynamicChannels(): Channel[] {
    return [...this.dynamicChannels];
  }

  /** Start the WebSocket server. */
  async start(): Promise<void> {
    // Check gateway lock — prevent multiple daemons
    const acquired = await this.lock.acquire();
    if (!acquired) {
      const status = await this.lock.isLocked();
      const owner = status.pid ? ` (PID ${status.pid})` : '';
      throw new Error(
        `Another Tako daemon is already running for home ${getRuntimePaths().home}${owner}. ` +
        `Use 'tako stop' for that home before starting another instance, or choose a different --home.`,
      );
    }

    this.httpServer = createServer((req, res) => {
      if (req.url === '/healthz' || req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
        return;
      }
      // POST /restart — triggers graceful restart with optional note
      if (req.url === '/restart' && req.method === 'POST') {
        let body = '';
        req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
        req.on('end', () => {
          try {
            const { note, sessionKey, channelId, agentId } = body ? JSON.parse(body) : {} as { note?: string; sessionKey?: string; channelId?: string; agentId?: string };
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'restarting' }));
            // Save restart note for post-restart delivery
            this.scheduleRestart(note, sessionKey, channelId, agentId);
          } catch {
            res.writeHead(400);
            res.end('Invalid JSON');
          }
        });
        return;
      }
      res.writeHead(404);
      res.end();
    });
    this.wss = new WebSocketServer({ server: this.httpServer });

    this.wss.on('connection', (ws: WebSocket) => {
      const clientId = crypto.randomUUID();
      const client: ConnectedClient = {
        id: clientId,
        ws,
        authenticated: !this.config.authToken,
      };
      this.clients.set(clientId, client);
      this.emitEvent({ type: 'client_connected', clientId });

      ws.on('message', async (data: Buffer) => {
        try {
          const msg = JSON.parse(data.toString()) as ClientMessage;
          await this.handleClientMessage(client, msg);
        } catch (err) {
          this.sendToClient(client, {
            type: 'error',
            message: `Invalid message: ${err instanceof Error ? err.message : 'parse error'}`,
          });
        }
      });

      ws.on('close', () => {
        this.clients.delete(clientId);
        this.emitEvent({ type: 'client_disconnected', clientId });
      });

      ws.on('error', (err) => {
        console.error(`[gateway] Client ${clientId} error:`, err.message);
        this.clients.delete(clientId);
      });
    });

    return new Promise<void>((resolve) => {
      this.httpServer!.listen(this.config.port, this.config.bind, () => {
        this.running = true;
        if (this.deps.hooks) {
          this.deps.hooks.emit('gateway_start', {
            event: 'gateway_start',
            data: {
              bind: this.config.bind,
              port: this.config.port,
              gateway: this,
              registerChannel: (channel: Channel, router?: MessageHandler) => this.registerChannel(channel, router ?? this.defaultMessageRouter ?? (() => {})),
              unregisterChannel: (id: string) => this.unregisterChannel(id),
              config: this.config,
            },
            timestamp: Date.now(),
          });
        }
        console.log(`[gateway] ✦ Listening on ws://${this.config.bind}:${this.config.port}`);

        // Start heartbeat after gateway is up
        if (this.heartbeatManager && this.deps.agentLoop) {
          this.heartbeatManager.setDeps(this.deps.agentLoop, this.deps.sessions);
          this.heartbeatManager.start();
        }

        resolve();
      });
    });
  }

  /** Default drain timeout in ms before forcing exit. */
  static readonly DRAIN_TIMEOUT_MS = 25_000;

  /** Stop the gateway cleanly with a drain timeout. */
  async stop(drainTimeoutMs: number = Gateway.DRAIN_TIMEOUT_MS): Promise<void> {
    let drainTimedOut = false;

    // Set up a drain timeout — if shutdown takes too long, force exit with code 1
    const drainTimer = setTimeout(() => {
      drainTimedOut = true;
      console.error(`[gateway] Drain timeout (${drainTimeoutMs}ms) exceeded — forcing exit with code 1`);
      process.exit(1);
    }, drainTimeoutMs);

    try {
      for (const client of this.clients.values()) {
        client.ws.close(1001, 'Gateway shutting down');
      }
      this.clients.clear();

      if (this.wss) {
        await new Promise<void>((resolve) => {
          this.wss!.close(() => resolve());
        });
        this.wss = null;
      }

      if (this.httpServer) {
        await new Promise<void>((resolve) => {
          this.httpServer!.close(() => resolve());
        });
        this.httpServer = null;
      }

      // Disconnect dynamic channels
      for (const ch of this.dynamicChannels) {
        await ch.disconnect();
      }
      this.dynamicChannels = [];

      // Stop heartbeat
      if (this.heartbeatManager) {
        this.heartbeatManager.stop();
      }

      // Dispose retry queue timers
      if (this.deps.retryQueue) {
        this.deps.retryQueue.dispose();
      }

      this.running = false;

      // Release gateway lock
      await this.lock.release();

      if (this.deps.hooks) {
        await this.deps.hooks.emit('gateway_stop', {
          event: 'gateway_stop',
          data: {},
          timestamp: Date.now(),
        });
      }

      console.log('[gateway] Stopped');
    } finally {
      clearTimeout(drainTimer);
    }
  }

  isRunning(): boolean {
    return this.running;
  }

  getSessions(): SessionManager {
    return this.deps.sessions;
  }

  /** Set runtime status info for TUI clients requesting status. */
  setStatusInfo(info: { model: string; tools: number; skills: number; channels: string[] }): void {
    this.statusInfo = info;
  }

  setAgentLoop(agentLoop: AgentLoop): void {
    this.deps.agentLoop = agentLoop;

    // Wire heartbeat manager with the agent loop
    if (this.heartbeatManager) {
      this.heartbeatManager.setDeps(agentLoop, this.deps.sessions);
      // Start heartbeat if gateway is already running
      if (this.running) {
        this.heartbeatManager.start();
      }
    }
  }

  private async handleClientMessage(client: ConnectedClient, msg: ClientMessage): Promise<void> {
    if (msg.type === 'auth') {
      if (!this.config.authToken || msg.token === this.config.authToken) {
        client.authenticated = true;
        this.sendToClient(client, { type: 'auth_ok' });
      } else {
        this.sendToClient(client, { type: 'auth_error', reason: 'Invalid token' });
      }
      return;
    }

    if (msg.type === 'ping') {
      this.sendToClient(client, { type: 'pong' });
      return;
    }

    if (!client.authenticated) {
      this.sendToClient(client, { type: 'auth_error', reason: 'Not authenticated' });
      return;
    }

    switch (msg.type) {
      case 'session_create': {
        const session = this.deps.sessions.create({ name: msg.name });
        client.sessionId = session.id;
        this.emitEvent({ type: 'session_created', sessionId: session.id });
        this.sendToClient(client, {
          type: 'session_created',
          sessionId: session.id,
          name: session.name,
        });
        break;
      }

      case 'session_resume': {
        const session = this.deps.sessions.get(msg.sessionId);
        if (!session) {
          this.sendToClient(client, {
            type: 'error',
            message: `Session not found: ${msg.sessionId}`,
          });
          return;
        }
        client.sessionId = session.id;
        this.sendToClient(client, { type: 'auth_ok', sessionId: session.id });
        break;
      }

      case 'session_list': {
        const sessions = this.deps.sessions.list();
        const infos: SessionInfo[] = sessions.map((s) => ({
          id: s.id,
          name: s.name,
          createdAt: s.createdAt.toISOString(),
          lastActiveAt: s.lastActiveAt.toISOString(),
          messageCount: s.messages.length,
        }));
        this.sendToClient(client, { type: 'session_list', sessions: infos });
        break;
      }

      case 'chat': {
        await this.handleChat(client, msg.sessionId, msg.content);
        break;
      }

      case 'command': {
        // Route /commands from TUI clients through as chat messages
        const cmdSession = client.sessionId
          ? this.deps.sessions.get(client.sessionId)
          : null;
        if (cmdSession) {
          await this.handleChat(client, cmdSession.id, `/${msg.cmd}${msg.args ? ' ' + msg.args : ''}`);
        } else {
          this.sendToClient(client, { type: 'error', message: 'No active session for command' });
        }
        break;
      }

      case 'status': {
        this.sendToClient(client, {
          type: 'status_info',
          model: this.statusInfo?.model ?? 'unknown',
          tools: this.statusInfo?.tools ?? 0,
          skills: this.statusInfo?.skills ?? 0,
          uptime: process.uptime(),
          channels: this.statusInfo?.channels ?? [],
        });
        break;
      }
    }
  }

  /** Stream agent response chunks back through WebSocket. */
  private async handleChat(client: ConnectedClient, sessionId: string, content: string): Promise<void> {
    if (!this.deps.agentLoop) {
      this.sendToClient(client, {
        type: 'error',
        sessionId,
        message: 'Agent loop not configured',
      });
      return;
    }

    const session = this.deps.sessions.get(sessionId);
    if (!session) {
      this.sendToClient(client, {
        type: 'error',
        sessionId,
        message: `Session not found: ${sessionId}`,
      });
      return;
    }

    // Track last active channel for heartbeat delivery routing
    if (this.heartbeatManager) {
      this.heartbeatManager.setLastChannel(sessionId);
    }

    // Suppress typing during heartbeat runs
    const isHeartbeat = session.metadata.isHeartbeat === true;

    try {
      let fullResponse = '';
      for await (const chunk of this.deps.agentLoop.run(session, content)) {
        if (client.ws.readyState !== WebSocket.OPEN) break;

        fullResponse += chunk;

        // Don't stream during heartbeat — we need the full response to check HEARTBEAT_OK
        if (!isHeartbeat) {
          this.sendToClient(client, {
            type: 'chunk',
            sessionId,
            text: chunk,
          });
        }
      }

      // HEARTBEAT_OK contract: detect, strip, and conditionally suppress
      if (isHeartbeat) {
        const ackMaxChars = this.deps.heartbeatConfig?.ackMaxChars ?? 300;
        const trimmed = fullResponse.trim();
        const hasAck = trimmed.startsWith('HEARTBEAT_OK') || trimmed.endsWith('HEARTBEAT_OK');

        if (hasAck) {
          const cleaned = trimmed
            .replace(/^HEARTBEAT_OK\s*/i, '')
            .replace(/\s*HEARTBEAT_OK$/i, '')
            .trim();

          // Drop delivery if remaining content is short
          if (cleaned.length <= ackMaxChars) {
            this.sendToClient(client, { type: 'done', sessionId });
            return;
          }

          // Deliver the cleaned (stripped) response
          this.sendToClient(client, { type: 'chunk', sessionId, text: cleaned });
        } else {
          // No HEARTBEAT_OK = alert, deliver full response
          this.sendToClient(client, { type: 'chunk', sessionId, text: fullResponse });
        }
      }

      // Run compaction check after the turn
      if (this.compactor) {
        await this.compactor.checkAndCompact(session);
      }

      this.sendToClient(client, { type: 'done', sessionId });
    } catch (err) {
      this.sendToClient(client, {
        type: 'error',
        sessionId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  private sendToClient(client: ConnectedClient, msg: ServerMessage): void {
    if (client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(JSON.stringify(msg));
    }
  }

  emitEvent(event: GatewayEvent): void {
    const typeHandlers = this.handlers.get(event.type);
    if (typeHandlers) {
      for (const handler of typeHandlers) {
        handler(event);
      }
    }
  }

  on(eventType: string, handler: EventHandler): void {
    if (!this.handlers.has(eventType)) {
      this.handlers.set(eventType, new Set());
    }
    this.handlers.get(eventType)!.add(handler);
  }

  /**
   * Schedule a graceful restart.
   *
   * Behavior:
   * 1) Persist restart note for post-restart delivery.
   * 2) Spawn a detached `tako restart` equivalent via the current runtime
   *    (bun/node + current entrypoint), so relaunch is reliable and quick.
   * 3) Exit current process with SIGTERM as a fallback and to flush state.
   */
  private scheduleRestart(note?: string, sessionKey?: string, channelId?: string, agentId?: string): void {
    const restartFile = getRuntimePaths().restartNoteFile;
    const data = {
      note: note || 'Tako restarted.',
      sessionKey: sessionKey || null,
      channelId: channelId || null,
      agentId: agentId || null,
      timestamp: new Date().toISOString(),
    };

    // Write synchronously since we're about to restart
    writeFileSync(restartFile, JSON.stringify(data, null, 2));
    console.log('[gateway] Restarting...');

    try {
      const runtimeCmd = process.execPath;
      const entry = process.argv[1];
      if (entry) {
        const child = nodeSpawn(runtimeCmd, [entry, 'restart'], {
          detached: true,
          stdio: 'ignore',
          env: { ...process.env, TAKO_RESTART_REQUESTED: '1' },
        });
        child.unref();
      }
    } catch (err) {
      console.warn('[gateway] Failed to spawn detached restart helper:', err instanceof Error ? err.message : err);
    }

    // Let the helper pick up PID state, then terminate gracefully.
    setTimeout(() => process.kill(process.pid, 'SIGTERM'), 1200);
  }
}
