/**
 * Sub-agent orchestration — spawn, track, steer, and kill sub-agents.
 *
 * Supports two modes:
 * - "run" (one-shot): Execute a task, return result, clean up
 * - "session" (persistent): Persistent agent that can receive follow-up messages
 *
 * reference runtime-aligned features:
 * - Configurable timeout per spawn (default 5min for run, none for session)
 * - Completion announcements: push results to parent session
 * - Automatic cleanup: remove completed run-mode sessions after result retrieval
 * - Session key routing: agent:<id>:<mode>:<uuid> format
 * - Thread-bound persistence: session mode runs persist across restarts
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { AgentLoop } from '../core/agent-loop.js';
import type { SessionManager, Session } from '../gateway/session.js';
import type { AgentDescriptor } from './config.js';

/** Sub-agent run mode. */
export type SubAgentMode = 'run' | 'session';

/** Sub-agent status. */
export type SubAgentStatus = 'running' | 'completed' | 'failed' | 'killed' | 'timeout';

/** Options for spawning a sub-agent. */
export interface SpawnOptions {
  /** Task description / initial message. */
  task: string;
  /** Agent ID to use (defaults to parent's agent). */
  agentId?: string;
  /** Run mode: one-shot or persistent. */
  mode: SubAgentMode;
  /** Human-readable label for tracking. */
  label?: string;
  /** Model override. */
  model?: string;
  /** Timeout in milliseconds (default: 300_000 for run, 0 for session). */
  timeoutMs?: number;
  /** Whether to announce completion to the parent session. */
  announceCompletion?: boolean;
}

/** A tracked sub-agent run. */
export interface SubAgentRun {
  /** Unique run ID. */
  id: string;
  /** Parent session ID that spawned this run. */
  parentSessionId: string;
  /** Agent ID being used. */
  agentId: string;
  /** The session this sub-agent is using. */
  sessionId: string;
  /** Session key for routing. */
  sessionKey: string;
  /** Run mode. */
  mode: SubAgentMode;
  /** Human-readable label. */
  label: string;
  /** Current status. */
  status: SubAgentStatus;
  /** Task that was given. */
  task: string;
  /** Result text (populated on completion). */
  result?: string;
  /** Error message (populated on failure). */
  error?: string;
  /** When the run started. */
  startedAt: Date;
  /** When the run completed/failed. */
  completedAt?: Date;
  /** Timeout in milliseconds. */
  timeoutMs: number;
  /** Whether to announce completion to parent. */
  announceCompletion: boolean;
}

/** Completion event emitted when a sub-agent finishes. */
export interface SubAgentCompletionEvent {
  runId: string;
  parentSessionId: string;
  status: SubAgentStatus;
  result?: string;
  error?: string;
}

export type CompletionHandler = (event: SubAgentCompletionEvent) => void;

/** Default timeout: 5 minutes for run mode, 0 (no timeout) for session mode. */
const DEFAULT_RUN_TIMEOUT_MS = 300_000;

/** Serialized run entry for persistence. */
interface SerializedRun {
  id: string;
  parentSessionId: string;
  agentId: string;
  sessionId: string;
  sessionKey: string;
  mode: SubAgentMode;
  label: string;
  status: SubAgentStatus;
  task: string;
  startedAt: string;
  completedAt?: string;
}

/** Persisted runs file format. */
interface RunsFile {
  version: 1;
  runs: SerializedRun[];
}

function getRunsPath(): string {
  return join(homedir(), '.tako', 'subagents', 'runs.json');
}

export class SubAgentOrchestrator {
  private runs = new Map<string, SubAgentRun>();
  private sessions: SessionManager;
  private agentLoop: AgentLoop;
  private completionHandlers: CompletionHandler[] = [];
  private timeoutTimers = new Map<string, ReturnType<typeof setTimeout>>();

  constructor(sessions: SessionManager, agentLoop: AgentLoop) {
    this.sessions = sessions;
    this.agentLoop = agentLoop;
    // Load persisted runs on construction
    this.loadPersistedRuns().catch(() => {});
  }

  /** Load runs from ~/.tako/subagents/runs.json on startup. */
  private async loadPersistedRuns(): Promise<void> {
    const filePath = getRunsPath();
    if (!existsSync(filePath)) return;

    try {
      const raw = await readFile(filePath, 'utf-8');
      const data = JSON.parse(raw) as RunsFile;
      for (const sr of data.runs) {
        if (this.runs.has(sr.id)) continue;
        const run: SubAgentRun = {
          id: sr.id,
          parentSessionId: sr.parentSessionId,
          agentId: sr.agentId,
          sessionId: sr.sessionId,
          sessionKey: sr.sessionKey,
          mode: sr.mode,
          label: sr.label,
          status: sr.status,
          task: sr.task,
          startedAt: new Date(sr.startedAt),
          completedAt: sr.completedAt ? new Date(sr.completedAt) : undefined,
          timeoutMs: 0,
          announceCompletion: false,
        };
        this.runs.set(sr.id, run);
      }
      console.log(`[subagent] Loaded ${data.runs.length} persisted runs`);
    } catch {
      // Corrupted file — start fresh
    }
  }

  /** Persist all runs to ~/.tako/subagents/runs.json. */
  private async saveRuns(): Promise<void> {
    const filePath = getRunsPath();
    const dir = join(filePath, '..');
    await mkdir(dir, { recursive: true });

    const serialized: SerializedRun[] = [];
    for (const run of this.runs.values()) {
      serialized.push({
        id: run.id,
        parentSessionId: run.parentSessionId,
        agentId: run.agentId,
        sessionId: run.sessionId,
        sessionKey: run.sessionKey,
        mode: run.mode,
        label: run.label,
        status: run.status,
        task: run.task,
        startedAt: run.startedAt.toISOString(),
        completedAt: run.completedAt?.toISOString(),
      });
    }

    const data: RunsFile = { version: 1, runs: serialized };
    await writeFile(filePath, JSON.stringify(data, null, 2) + '\n', 'utf-8');
  }

  /** Register a handler for sub-agent completion events. */
  onCompletion(handler: CompletionHandler): void {
    this.completionHandlers.push(handler);
  }

  /**
   * Spawn a sub-agent.
   * In "run" mode, executes the task and returns the result.
   * In "session" mode, starts the session and returns immediately.
   */
  async spawn(
    parentSessionId: string,
    opts: SpawnOptions,
    _agent?: AgentDescriptor,
  ): Promise<SubAgentRun> {
    const runId = crypto.randomUUID();
    const agentId = opts.agentId ?? 'main';

    // Build session key: agent:<id>:<mode>:<uuid>
    const sessionKey = `agent:${agentId}:${opts.mode}:${runId}`;

    // Determine timeout
    const timeoutMs = opts.timeoutMs ??
      (opts.mode === 'run' ? DEFAULT_RUN_TIMEOUT_MS : 0);

    // Create a new session for the sub-agent with proper key routing
    const session = this.sessions.getOrCreate(sessionKey, {
      name: `subagent:${opts.label ?? agentId}:${runId.slice(0, 8)}`,
      metadata: {
        parentSessionId,
        agentId,
        mode: opts.mode,
        label: opts.label,
        isSubAgent: true,
        sessionKey,
        // Thread-bound: session mode persists across restarts
        persistent: opts.mode === 'session',
      },
    });

    const run: SubAgentRun = {
      id: runId,
      parentSessionId,
      agentId,
      sessionId: session.id,
      sessionKey,
      mode: opts.mode,
      label: opts.label ?? `${agentId}:${runId.slice(0, 8)}`,
      status: 'running',
      task: opts.task,
      startedAt: new Date(),
      timeoutMs,
      announceCompletion: opts.announceCompletion ?? true,
    };

    this.runs.set(runId, run);
    this.saveRuns().catch(() => {});

    // Set up timeout if configured
    if (timeoutMs > 0) {
      const timer = setTimeout(() => {
        if (run.status === 'running') {
          run.status = 'timeout';
          run.error = `Timed out after ${timeoutMs}ms`;
          run.completedAt = new Date();
          this.timeoutTimers.delete(runId);
          this.emitCompletion(run);
        }
      }, timeoutMs);
      this.timeoutTimers.set(runId, timer);
    }

    // Execute the run
    this.executeRun(run, session).catch((err) => {
      run.status = 'failed';
      run.error = err instanceof Error ? err.message : String(err);
      run.completedAt = new Date();
      this.clearTimeout(runId);
      this.emitCompletion(run);
    });

    return run;
  }

  /** Execute a sub-agent run. */
  private async executeRun(run: SubAgentRun, session: Session): Promise<void> {
    let result = '';

    try {
      for await (const chunk of this.agentLoop.run(session, run.task)) {
        // Check if we've been killed or timed out while running
        if (run.status === 'killed' || run.status === 'timeout') return;
        result += chunk;
      }

      // Don't overwrite if already killed/timed out
      if (run.status !== 'running') return;

      run.result = result;
      run.status = 'completed';
      run.completedAt = new Date();
    } catch (err) {
      if (run.status !== 'running') return;
      run.status = 'failed';
      run.error = err instanceof Error ? err.message : String(err);
      run.completedAt = new Date();
    }

    this.clearTimeout(run.id);

    // Automatic cleanup for completed run-mode sessions
    if (run.mode === 'run') {
      session.metadata.completed = true;
    }

    this.emitCompletion(run);
  }

  /** Send a follow-up message to a persistent sub-agent session. */
  async sendMessage(runId: string, message: string): Promise<string> {
    const run = this.runs.get(runId);
    if (!run) throw new Error(`Sub-agent run not found: ${runId}`);
    if (run.mode !== 'session') throw new Error(`Cannot send messages to one-shot runs`);
    if (run.status !== 'completed' && run.status !== 'running') {
      throw new Error(`Sub-agent is ${run.status}, cannot send message`);
    }

    const session = this.sessions.get(run.sessionId);
    if (!session) throw new Error(`Session not found: ${run.sessionId}`);

    run.status = 'running';
    let result = '';

    for await (const chunk of this.agentLoop.run(session, message)) {
      result += chunk;
    }

    run.status = 'completed';
    run.result = result;
    return result;
  }

  /** List all sub-agent runs, optionally filtered by parent session. */
  listRuns(parentSessionId?: string): SubAgentRun[] {
    const all = Array.from(this.runs.values());
    if (parentSessionId) {
      return all.filter((r) => r.parentSessionId === parentSessionId);
    }
    return all;
  }

  /** Get a specific run. */
  getRun(runId: string): SubAgentRun | undefined {
    return this.runs.get(runId);
  }

  /** Kill a running sub-agent. */
  kill(runId: string): boolean {
    const run = this.runs.get(runId);
    if (!run) return false;
    if (run.status !== 'running') return false;

    run.status = 'killed';
    run.completedAt = new Date();
    this.clearTimeout(runId);
    this.emitCompletion(run);
    return true;
  }

  /** Steer a sub-agent by sending it additional instructions. */
  async steer(runId: string, message: string): Promise<string> {
    return this.sendMessage(runId, message);
  }

  /**
   * Clean up completed run-mode sessions.
   * Removes run records and their sessions after results have been retrieved.
   */
  cleanup(): number {
    let cleaned = 0;
    for (const [runId, run] of this.runs) {
      if (
        run.mode === 'run' &&
        (run.status === 'completed' || run.status === 'failed' || run.status === 'timeout')
      ) {
        // Delete the session
        this.sessions.delete(run.sessionId);
        this.runs.delete(runId);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      console.log(`[subagent] Cleaned up ${cleaned} completed run-mode sessions`);
    }
    return cleaned;
  }

  /** Restore thread-bound sessions from persisted session data on restart. */
  restorePersistedSessions(): number {
    let restored = 0;
    for (const session of this.sessions.list()) {
      if (
        session.metadata.isSubAgent &&
        session.metadata.persistent &&
        session.metadata.sessionKey &&
        !session.metadata.completed
      ) {
        const key = session.metadata.sessionKey as string;
        // Parse the session key: agent:<id>:<mode>:<uuid>
        const parts = key.split(':');
        if (parts.length >= 4) {
          const runId = parts[3];
          if (!this.runs.has(runId)) {
            const run: SubAgentRun = {
              id: runId,
              parentSessionId: session.metadata.parentSessionId as string ?? '',
              agentId: parts[1],
              sessionId: session.id,
              sessionKey: key,
              mode: parts[2] as SubAgentMode,
              label: session.metadata.label as string ?? session.name,
              status: 'completed',
              task: '',
              startedAt: session.createdAt,
              completedAt: session.lastActiveAt,
              timeoutMs: 0,
              announceCompletion: false,
            };
            this.runs.set(runId, run);
            restored++;
          }
        }
      }
    }
    if (restored > 0) {
      console.log(`[subagent] Restored ${restored} persisted thread-bound sessions`);
    }
    return restored;
  }

  private clearTimeout(runId: string): void {
    const timer = this.timeoutTimers.get(runId);
    if (timer) {
      clearTimeout(timer);
      this.timeoutTimers.delete(runId);
    }
  }

  private emitCompletion(run: SubAgentRun): void {
    this.saveRuns().catch(() => {});

    const event: SubAgentCompletionEvent = {
      runId: run.id,
      parentSessionId: run.parentSessionId,
      status: run.status,
      result: run.result,
      error: run.error,
    };

    // Announce completion to parent session if configured
    if (run.announceCompletion && run.parentSessionId) {
      this.announceToParent(run);
    }

    for (const handler of this.completionHandlers) {
      try {
        handler(event);
      } catch {
        // Don't let handler errors crash the orchestrator
      }
    }
  }

  /** Push completion announcement to the parent session. */
  private announceToParent(run: SubAgentRun): void {
    const parentSession = this.sessions.get(run.parentSessionId);
    if (!parentSession) return;

    const statusEmoji = run.status === 'completed' ? '✓' : run.status === 'timeout' ? '⏱' : '✗';
    const summary = run.status === 'completed'
      ? (run.result ?? '').slice(0, 500)
      : run.error ?? 'Unknown error';

    const announcement = `[sub-agent ${statusEmoji}] ${run.label} (${run.status}): ${summary}`;

    parentSession.messages.push({
      role: 'system',
      content: announcement,
    });
    parentSession.lastActiveAt = new Date();
  }
}
