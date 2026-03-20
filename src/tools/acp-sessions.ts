/**
 * Persistent ACP Sessions — manage long-running acpx sessions.
 *
 * Unlike the one-shot `acp_spawn`, persistent sessions allow:
 * - Sending follow-up messages to an ongoing conversation
 * - Checking status and retrieving output
 * - Listing and killing sessions
 *
 * Uses AcpxRuntime for proper protocol-based communication.
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  AcpxRuntime,
  AcpRuntimeHandle,
} from '../acp/runtime.js';
import type { AcpRuntimeConfig } from '../acp/config.js';
import type { AcpRuntimeEvent } from '../acp/events.js';
import type { Tool, ToolContext, ToolResult } from './tool.js';
import { getRuntimePaths } from '../core/paths.js';

// ─── Types ──────────────────────────────────────────────────────

export interface AcpSession {
  id: string;
  agent: string;
  cwd: string;
  status: 'running' | 'completed' | 'failed' | 'timeout';
  startedAt: number;
  label?: string;
  agentId: string;
  handle: AcpRuntimeHandle;
  messages: Array<{ role: 'user' | 'assistant'; content: string; timestamp: number }>;
}

// ─── Session Manager ────────────────────────────────────────────

function getSessionsDir(): string {
  return getRuntimePaths().acpDir;
}

function getSessionsFile(): string {
  return join(getSessionsDir(), 'sessions.json');
}

export class AcpSessionManager {
  private sessions = new Map<string, AcpSession>();
  private config: AcpRuntimeConfig;
  private runtime: AcpxRuntime;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: AcpRuntimeConfig, runtime: AcpxRuntime) {
    this.config = config;
    this.runtime = runtime;
  }

  /** Start periodic cleanup of timed-out sessions. */
  startCleanup(intervalMs = 30_000): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => void this.cleanupStale(), intervalMs);
    this.cleanupTimer.unref();
  }

  /** Stop the cleanup timer. */
  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Start a new persistent ACP session.
   */
  async start(
    task: string,
    agentId: string,
    opts?: { cwd?: string; agent?: string; label?: string },
  ): Promise<AcpSession> {
    const cwd = opts?.cwd ?? this.config.cwd;
    const agent = opts?.agent ?? this.config.defaultAgent;
    const sessionName = `tako-${agent}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    // Ensure session via runtime
    const handle = await this.runtime.ensureSession({
      sessionKey: sessionName,
      agent,
      cwd,
      mode: 'persistent',
    });

    const session: AcpSession = {
      id: sessionName,
      agent,
      cwd,
      status: 'running',
      startedAt: Date.now(),
      label: opts?.label ?? task.slice(0, 80),
      agentId,
      handle,
      messages: [{ role: 'user', content: task, timestamp: Date.now() }],
    };

    this.sessions.set(sessionName, session);

    // Run the initial turn in the background
    void this.runTurnBackground(session, task);

    await this.persistMetadata();
    return session;
  }

  /**
   * Send a follow-up message to a running session.
   */
  async send(
    sessionId: string,
    message: string,
  ): Promise<{ success: boolean; output?: string; error?: string }> {
    const session = this.sessions.get(sessionId);
    if (!session) return { success: false, error: `Session ${sessionId} not found` };
    if (session.status !== 'running') {
      return { success: false, error: `Session ${sessionId} is ${session.status}` };
    }

    session.messages.push({ role: 'user', content: message, timestamp: Date.now() });

    // Run the turn and collect output
    try {
      let output = '';
      for await (const event of this.runtime.runTurn({
        handle: session.handle,
        text: message,
      })) {
        output += collectEventText(event);
      }

      session.messages.push({
        role: 'assistant',
        content: output,
        timestamp: Date.now(),
      });

      await this.persistMetadata();
      return { success: true, output };
    } catch (err: unknown) {
      session.status = 'failed';
      await this.persistMetadata();
      return { success: false, error: (err as Error).message };
    }
  }

  /**
   * Get the status of a session via the acpx runtime.
   */
  async getStatus(sessionId: string): Promise<{
    session: AcpSession | null;
    runtimeStatus: string;
  }> {
    const session = this.sessions.get(sessionId);
    if (!session) return { session: null, runtimeStatus: '' };

    try {
      const status = await this.runtime.getStatus({ handle: session.handle });
      return { session: { ...session }, runtimeStatus: status.summary };
    } catch {
      return { session: { ...session }, runtimeStatus: 'status unavailable' };
    }
  }

  /**
   * List all tracked sessions.
   */
  list(): AcpSession[] {
    return Array.from(this.sessions.values()).map((s) => ({ ...s }));
  }

  /**
   * Cancel and close a running session.
   */
  async kill(sessionId: string): Promise<boolean> {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    if (session.status === 'running') {
      try {
        await this.runtime.cancel({ handle: session.handle, reason: 'user-kill' });
      } catch {
        // Best-effort cancel
      }
      try {
        await this.runtime.close({ handle: session.handle, reason: 'user-kill' });
      } catch {
        // Best-effort close
      }
      session.status = 'completed';
    }

    await this.persistMetadata();
    return true;
  }

  /**
   * Get full message log for a session.
   */
  getLogs(sessionId: string): string {
    const session = this.sessions.get(sessionId);
    if (!session) return '';

    return session.messages
      .map((msg) => {
        const ts = new Date(msg.timestamp).toISOString();
        const contentStr =
          msg.content == null
            ? ''
            : typeof msg.content === 'string'
              ? msg.content
              : JSON.stringify(msg.content);
        return `[${ts}] ${msg.role}: ${contentStr}`;
      })
      .join('\n');
  }

  /**
   * Clean up all sessions on shutdown.
   */
  async shutdown(): Promise<void> {
    this.stopCleanup();
    for (const [id] of this.sessions) {
      await this.kill(id);
    }
  }

  /**
   * Load persisted session metadata (for display, not process resumption).
   */
  static async loadPersistedSessions(): Promise<AcpSession[]> {
    try {
      const raw = await readFile(getSessionsFile(), 'utf-8');
      return JSON.parse(raw) as AcpSession[];
    } catch {
      return [];
    }
  }

  // ─── Private ────────────────────────────────────────────────

  private async runTurnBackground(session: AcpSession, text: string): Promise<void> {
    try {
      let output = '';
      for await (const event of this.runtime.runTurn({
        handle: session.handle,
        text,
      })) {
        output += collectEventText(event);
      }

      session.messages.push({
        role: 'assistant',
        content: output,
        timestamp: Date.now(),
      });
    } catch {
      session.status = 'failed';
    }
    await this.persistMetadata();
  }

  private async cleanupStale(): Promise<void> {
    const timeoutMs = this.config.timeoutSeconds * 1000;
    const now = Date.now();

    for (const [id, session] of this.sessions) {
      if (session.status !== 'running') continue;
      if (now - session.startedAt > timeoutMs) {
        try {
          await this.runtime.cancel({ handle: session.handle, reason: 'timeout' });
          await this.runtime.close({ handle: session.handle, reason: 'timeout' });
        } catch {
          // Best-effort cleanup
        }
        session.status = 'timeout';
        console.log(`[acp] Session ${id} timed out after ${this.config.timeoutSeconds}s`);
      }
    }
  }

  private async persistMetadata(): Promise<void> {
    try {
      await mkdir(getSessionsDir(), { recursive: true });
      const sessions = this.list();
      await writeFile(getSessionsFile(), JSON.stringify(sessions, null, 2), 'utf-8');
    } catch {
      // Best-effort persistence
    }
  }
}

// ─── Tools ──────────────────────────────────────────────────────

/** Create persistent ACP session tools. */
export function createAcpSessionTools(manager: AcpSessionManager): Tool[] {
  const sessionStart: Tool = {
    name: 'acp_session_start',
    description: 'Start a persistent ACP coding agent session. Returns session ID for follow-up messages.',
    group: 'runtime',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Initial task for the coding agent' },
        cwd: { type: 'string', description: 'Working directory (defaults to current)' },
        agent: { type: 'string', description: 'Agent to use (claude, codex, pi, etc.)' },
        label: { type: 'string', description: 'Short label for this session' },
      },
      required: ['task'],
    },
    async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
      const { task, cwd, agent, label } = params as {
        task: string; cwd?: string; agent?: string; label?: string;
      };
      try {
        const session = await manager.start(task, ctx.agentId ?? 'unknown', {
          cwd: cwd ?? ctx.workDir,
          agent,
          label,
        });
        return {
          output: `ACP session started.\nSession ID: ${session.id}\nAgent: ${session.agent}\nLabel: ${session.label}`,
          success: true,
          data: { sessionId: session.id },
        };
      } catch (err: unknown) {
        return {
          output: '',
          success: false,
          error: (err as Error).message ?? 'Failed to start ACP session',
        };
      }
    },
  };

  const sessionSend: Tool = {
    name: 'acp_session_send',
    description: 'Send a follow-up message to a running ACP session.',
    group: 'runtime',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'ACP session ID' },
        message: { type: 'string', description: 'Message to send' },
      },
      required: ['sessionId', 'message'],
    },
    async execute(params: unknown): Promise<ToolResult> {
      const { sessionId, message } = params as { sessionId: string; message: string };
      const result = await manager.send(sessionId, message);
      if (!result.success) {
        return { output: '', success: false, error: result.error };
      }
      const truncated = result.output && result.output.length > 5000
        ? result.output.slice(0, 5000) + '\n[... truncated]'
        : result.output ?? '';
      return { output: `Message sent to session ${sessionId}\n\n${truncated}`, success: true };
    },
  };

  const sessionStatus: Tool = {
    name: 'acp_session_status',
    description: 'Check the status and latest output of an ACP session.',
    group: 'runtime',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'ACP session ID (omit for all sessions)' },
      },
    },
    async execute(params: unknown): Promise<ToolResult> {
      const { sessionId } = params as { sessionId?: string };

      if (sessionId) {
        const { session, runtimeStatus } = await manager.getStatus(sessionId);
        if (!session) {
          return { output: '', success: false, error: `Session ${sessionId} not found` };
        }
        const lines = [
          `Session: ${session.id}`,
          `Status: ${session.status}`,
          `Agent: ${session.agent}`,
          `Label: ${session.label ?? '(none)'}`,
          `Started: ${new Date(session.startedAt).toISOString()}`,
          `Messages: ${session.messages.length}`,
          `Runtime: ${runtimeStatus}`,
        ];
        return { output: lines.join('\n'), success: true };
      }

      // List all
      const sessions = manager.list();
      if (sessions.length === 0) {
        return { output: 'No active ACP sessions.', success: true };
      }
      const lines = sessions.map((s) =>
        `${s.id} [${s.status}] ${s.agent} — ${s.label ?? '(no label)'} (${s.messages.length} msgs)`,
      );
      return { output: lines.join('\n'), success: true };
    },
  };

  const sessionList: Tool = {
    name: 'acp_session_list',
    description: 'List all active ACP sessions.',
    group: 'runtime',
    parameters: { type: 'object', properties: {} },
    async execute(): Promise<ToolResult> {
      const sessions = manager.list();
      if (sessions.length === 0) {
        return { output: 'No active ACP sessions.', success: true };
      }
      const lines = sessions.map((s) => {
        const elapsed = Math.round((Date.now() - s.startedAt) / 1000);
        return `${s.id}  ${s.status.padEnd(10)} ${s.agent.padEnd(8)} ${elapsed}s  ${s.label ?? ''}`;
      });
      return {
        output: `ID        Status     Agent    Elapsed  Label\n${lines.join('\n')}`,
        success: true,
      };
    },
  };

  const sessionKill: Tool = {
    name: 'acp_session_kill',
    description: 'Terminate a running ACP session.',
    group: 'runtime',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'ACP session ID to kill' },
      },
      required: ['sessionId'],
    },
    async execute(params: unknown): Promise<ToolResult> {
      const { sessionId } = params as { sessionId: string };
      const killed = await manager.kill(sessionId);
      if (!killed) {
        return { output: '', success: false, error: `Session ${sessionId} not found` };
      }
      return { output: `Session ${sessionId} terminated.`, success: true };
    },
  };

  return [sessionStart, sessionSend, sessionStatus, sessionList, sessionKill];
}

// ─── Helpers ────────────────────────────────────────────────────

function collectEventText(event: AcpRuntimeEvent): string {
  switch (event.type) {
    case 'text_delta':
      return event.text;
    case 'tool_call':
      return `\n[tool: ${event.text}]\n`;
    case 'error':
      return `\n[error: ${event.message}]\n`;
    default:
      return '';
  }
}
