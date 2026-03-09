/**
 * Persistent ACP Sessions — spawn and interact with long-running
 * Claude Code or Codex sessions via stdin/stdout pipes.
 *
 * Unlike the one-shot `acp_spawn`, persistent sessions allow:
 * - Sending follow-up messages to an ongoing conversation
 * - Checking status and retrieving output
 * - Listing and killing sessions
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type { Tool, ToolContext, ToolResult } from './tool.js';
import type { AcpConfig } from './acp.js';

// ─── Types ──────────────────────────────────────────────────────────

export interface AcpSession {
  id: string;
  backend: 'claude' | 'codex';
  pid: number;
  cwd: string;
  status: 'running' | 'completed' | 'failed' | 'timeout';
  startedAt: number;
  label?: string;
  agentId: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string; timestamp: number }>;
}

interface SessionProcess {
  session: AcpSession;
  process: ChildProcess;
  outputBuffer: string;
  lastActivity: number;
}

// ─── Session Manager ────────────────────────────────────────────────

const SESSIONS_DIR = join(homedir(), '.tako', 'acp');
const SESSIONS_FILE = join(SESSIONS_DIR, 'sessions.json');

export class AcpSessionManager {
  private processes = new Map<string, SessionProcess>();
  private config: AcpConfig;
  private cleanupTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: AcpConfig) {
    this.config = config;
  }

  /** Start periodic cleanup of timed-out sessions. */
  startCleanup(intervalMs = 30_000): void {
    if (this.cleanupTimer) return;
    this.cleanupTimer = setInterval(() => this.cleanupStale(), intervalMs);
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
    opts?: { cwd?: string; model?: string; label?: string },
  ): Promise<AcpSession> {
    const id = randomUUID().slice(0, 8);
    const cwd = opts?.cwd ?? process.cwd();
    const backend = this.config.backend;

    // Build command args for interactive mode
    let command: string;
    let args: string[];

    if (backend === 'claude') {
      command = 'claude';
      args = ['--dangerously-skip-permissions'];
      if (opts?.model) {
        args.push('--model', opts.model);
      }
    } else {
      command = 'codex';
      args = ['--quiet', '-a', 'full-auto'];
    }

    const child = spawn(command, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    const session: AcpSession = {
      id,
      backend,
      pid: child.pid ?? 0,
      cwd,
      status: 'running',
      startedAt: Date.now(),
      label: opts?.label ?? task.slice(0, 80),
      agentId,
      messages: [{ role: 'user', content: task, timestamp: Date.now() }],
    };

    const sp: SessionProcess = {
      session,
      process: child,
      outputBuffer: '',
      lastActivity: Date.now(),
    };

    // Buffer stdout
    child.stdout?.on('data', (data: Buffer) => {
      sp.outputBuffer += data.toString();
      sp.lastActivity = Date.now();
    });

    // Buffer stderr
    child.stderr?.on('data', (data: Buffer) => {
      sp.outputBuffer += data.toString();
      sp.lastActivity = Date.now();
    });

    // Handle exit
    child.on('exit', (code) => {
      session.status = code === 0 ? 'completed' : 'failed';
      if (sp.outputBuffer.length > 0) {
        session.messages.push({
          role: 'assistant',
          content: sp.outputBuffer,
          timestamp: Date.now(),
        });
      }
      this.persistMetadata();
    });

    child.on('error', () => {
      session.status = 'failed';
      this.persistMetadata();
    });

    this.processes.set(id, sp);

    // Send the initial task via stdin
    child.stdin?.write(task + '\n');

    await this.persistMetadata();
    return session;
  }

  /**
   * Send a follow-up message to a running session.
   */
  async send(sessionId: string, message: string): Promise<{ success: boolean; error?: string }> {
    const sp = this.processes.get(sessionId);
    if (!sp) return { success: false, error: `Session ${sessionId} not found` };
    if (sp.session.status !== 'running') {
      return { success: false, error: `Session ${sessionId} is ${sp.session.status}` };
    }

    // Capture any output since last message as assistant response
    if (sp.outputBuffer.length > 0) {
      sp.session.messages.push({
        role: 'assistant',
        content: sp.outputBuffer,
        timestamp: Date.now(),
      });
      sp.outputBuffer = '';
    }

    // Send the new message
    sp.session.messages.push({ role: 'user', content: message, timestamp: Date.now() });
    sp.process.stdin?.write(message + '\n');
    sp.lastActivity = Date.now();

    await this.persistMetadata();
    return { success: true };
  }

  /**
   * Get the status and latest output of a session.
   */
  getStatus(sessionId: string): {
    session: AcpSession | null;
    latestOutput: string;
  } {
    const sp = this.processes.get(sessionId);
    if (!sp) return { session: null, latestOutput: '' };

    return {
      session: { ...sp.session },
      latestOutput: sp.outputBuffer,
    };
  }

  /**
   * List all tracked sessions (running and completed).
   */
  list(): AcpSession[] {
    return Array.from(this.processes.values()).map((sp) => ({ ...sp.session }));
  }

  /**
   * Kill a running session.
   */
  async kill(sessionId: string): Promise<boolean> {
    const sp = this.processes.get(sessionId);
    if (!sp) return false;

    if (sp.session.status === 'running') {
      sp.process.kill('SIGTERM');
      // Give it 3s to exit gracefully, then force kill
      setTimeout(() => {
        if (sp.session.status === 'running') {
          sp.process.kill('SIGKILL');
          sp.session.status = 'failed';
        }
      }, 3000).unref();
      sp.session.status = 'completed';
    }

    await this.persistMetadata();
    return true;
  }

  /**
   * Get full output log for a session.
   */
  getLogs(sessionId: string): string {
    const sp = this.processes.get(sessionId);
    if (!sp) return '';

    const lines: string[] = [];
    for (const msg of sp.session.messages) {
      const ts = new Date(msg.timestamp).toISOString();
      const contentStr = msg.content == null
        ? ''
        : typeof msg.content === 'string'
          ? msg.content
          : JSON.stringify(msg.content);
      lines.push(`[${ts}] ${msg.role}: ${contentStr}`);
    }
    // Append any unbuffered output
    if (sp.outputBuffer.length > 0) {
      lines.push(`[pending output] ${sp.outputBuffer}`);
    }
    return lines.join('\n');
  }

  /**
   * Kill sessions that have exceeded the timeout.
   */
  private cleanupStale(): void {
    const timeoutMs = this.config.defaultTimeout * 1000;
    const now = Date.now();

    for (const [id, sp] of this.processes) {
      if (sp.session.status !== 'running') continue;
      if (now - sp.session.startedAt > timeoutMs) {
        sp.process.kill('SIGTERM');
        sp.session.status = 'timeout';
        console.log(`[acp] Session ${id} timed out after ${this.config.defaultTimeout}s`);
      }
    }
  }

  /**
   * Persist session metadata to disk.
   */
  private async persistMetadata(): Promise<void> {
    try {
      await mkdir(SESSIONS_DIR, { recursive: true });
      const sessions = this.list();
      await writeFile(SESSIONS_FILE, JSON.stringify(sessions, null, 2), 'utf-8');
    } catch {
      // Best-effort persistence
    }
  }

  /**
   * Load persisted session metadata (for display, not process resumption).
   */
  static async loadPersistedSessions(): Promise<AcpSession[]> {
    try {
      const raw = await readFile(SESSIONS_FILE, 'utf-8');
      return JSON.parse(raw) as AcpSession[];
    } catch {
      return [];
    }
  }

  /**
   * Clean up all sessions on shutdown.
   */
  async shutdown(): Promise<void> {
    this.stopCleanup();
    for (const [id] of this.processes) {
      await this.kill(id);
    }
  }
}

// ─── Tools ──────────────────────────────────────────────────────────

/** Create persistent ACP session tools. */
export function createAcpSessionTools(manager: AcpSessionManager): Tool[] {
  const sessionStart: Tool = {
    name: 'acp_session_start',
    description: 'Start a persistent Claude Code session. Returns session ID for follow-up messages.',
    group: 'runtime',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Initial task for the coding agent' },
        cwd: { type: 'string', description: 'Working directory (defaults to current)' },
        model: { type: 'string', description: 'Model override' },
        label: { type: 'string', description: 'Short label for this session' },
      },
      required: ['task'],
    },
    async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
      const { task, cwd, model, label } = params as {
        task: string; cwd?: string; model?: string; label?: string;
      };

      try {
        const session = await manager.start(task, ctx.agentId ?? 'unknown', {
          cwd: cwd ?? ctx.workDir,
          model,
          label,
        });
        return {
          output: `ACP session started.\nSession ID: ${session.id}\nPID: ${session.pid}\nBackend: ${session.backend}\nLabel: ${session.label}`,
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
      return { output: `Message sent to session ${sessionId}`, success: true };
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
        const { session, latestOutput } = manager.getStatus(sessionId);
        if (!session) {
          return { output: '', success: false, error: `Session ${sessionId} not found` };
        }
        const lines = [
          `Session: ${session.id}`,
          `Status: ${session.status}`,
          `Backend: ${session.backend}`,
          `PID: ${session.pid}`,
          `Label: ${session.label ?? '(none)'}`,
          `Started: ${new Date(session.startedAt).toISOString()}`,
          `Messages: ${session.messages.length}`,
        ];
        if (latestOutput) {
          const truncated = latestOutput.length > 5000
            ? latestOutput.slice(-5000) + '\n[... truncated]'
            : latestOutput;
          lines.push('', 'Latest output:', truncated);
        }
        return { output: lines.join('\n'), success: true };
      }

      // List all
      const sessions = manager.list();
      if (sessions.length === 0) {
        return { output: 'No active ACP sessions.', success: true };
      }
      const lines = sessions.map((s) =>
        `${s.id} [${s.status}] ${s.backend} — ${s.label ?? '(no label)'} (${s.messages.length} msgs)`,
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
        return `${s.id}  ${s.status.padEnd(10)} ${s.backend.padEnd(6)} ${elapsed}s  ${s.label ?? ''}`;
      });
      return { output: `ID        Status     Backend Elapsed  Label\n${lines.join('\n')}`, success: true };
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
