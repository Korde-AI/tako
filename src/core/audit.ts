/**
 * Audit Logging — records every significant agent action.
 *
 * Logs to <home>/audit/audit.jsonl with auto-rotation at 10MB.
 * Supports filtering by agent, event type, and tail queries.
 */

import { appendFile, stat, rename, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { getRuntimePaths } from './paths.js';

// ─── Types ──────────────────────────────────────────────────────────

export type AuditEvent =
  | 'agent_run'
  | 'tool_call'
  | 'file_modify'
  | 'message_received'
  | 'message_sent'
  | 'api_call'
  | 'browser_action'
  | 'auth_failure'
  | 'permission_denied'
  | 'cron_run'
  | 'agent_spawn'
  | 'agent_comms'
  | 'session_start';

export interface AuditEntry {
  timestamp: string;
  agentId: string;
  sessionId: string;
  principalId?: string;
  principalName?: string;
  projectId?: string;
  projectSlug?: string;
  sharedSessionId?: string;
  participantIds?: string[];
  event: AuditEvent;
  action: string;
  details: Record<string, unknown>;
  success: boolean;
}

export interface AuditConfig {
  /** Enable audit logging (default: true). */
  enabled: boolean;
  /** Max file size in MB before rotation (default: 10). */
  maxFileSizeMb: number;
  /** Retention period string, e.g. '30d' (default: '30d'). */
  retention: string;
}

export interface AuditQuery {
  tail?: number;
  agentId?: string;
  event?: AuditEvent;
  since?: Date;
}

// ─── Audit Logger ───────────────────────────────────────────────────

export class AuditLogger {
  private config: AuditConfig;
  private logDir: string;
  private logPath: string;
  private writeQueue: string[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(config: AuditConfig, logDir?: string) {
    this.config = config;
    this.logDir = logDir ?? getRuntimePaths().auditDir;
    this.logPath = join(this.logDir, 'audit.jsonl');
  }

  /**
   * Log an audit entry.
   */
  async log(entry: Omit<AuditEntry, 'timestamp'>): Promise<void> {
    if (!this.config.enabled) return;

    const full: AuditEntry = {
      ...entry,
      timestamp: new Date().toISOString(),
    };

    const line = JSON.stringify(full) + '\n';
    this.writeQueue.push(line);

    // Batch writes for efficiency
    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => this.flush(), 100);
    }
  }

  /**
   * Log a tool call event.
   */
  async logToolCall(
    agentId: string,
    sessionId: string,
    toolName: string,
    args: Record<string, unknown>,
    success: boolean,
    durationMs?: number,
    principal?: { principalId?: string; principalName?: string },
  ): Promise<void> {
    await this.log({
      agentId,
      sessionId,
      principalId: principal?.principalId,
      principalName: principal?.principalName,
      event: 'tool_call',
      action: toolName,
      details: {
        args: this.summarizeArgs(args),
        durationMs,
      },
      success,
    });
  }

  /**
   * Log an agent run event.
   */
  async logAgentRun(
    agentId: string,
    sessionId: string,
    model: string,
    tokensUsed: number,
    durationMs: number,
    success: boolean,
    principal?: { principalId?: string; principalName?: string },
  ): Promise<void> {
    await this.log({
      agentId,
      sessionId,
      principalId: principal?.principalId,
      principalName: principal?.principalName,
      event: 'agent_run',
      action: 'run',
      details: { model, tokensUsed, durationMs },
      success,
    });
  }

  /**
   * Log a file modification event.
   */
  async logFileModify(
    agentId: string,
    sessionId: string,
    filePath: string,
    action: 'create' | 'edit' | 'delete',
    success: boolean,
  ): Promise<void> {
    await this.log({
      agentId,
      sessionId,
      event: 'file_modify',
      action,
      details: { path: filePath },
      success,
    });
  }

  /**
   * Log a message sent event.
   */
  async logMessageSent(
    agentId: string,
    sessionId: string,
    channel: string,
    target: string,
    success: boolean,
    principal?: { principalId?: string; principalName?: string },
  ): Promise<void> {
    await this.log({
      agentId,
      sessionId,
      principalId: principal?.principalId,
      principalName: principal?.principalName,
      event: 'message_sent',
      action: 'send',
      details: { channel, target },
      success,
    });
  }

  /**
   * Log a security event.
   */
  async logSecurityEvent(
    agentId: string,
    sessionId: string,
    event: 'auth_failure' | 'permission_denied',
    action: string,
    details: Record<string, unknown>,
    principal?: { principalId?: string; principalName?: string },
  ): Promise<void> {
    await this.log({
      agentId,
      sessionId,
      principalId: principal?.principalId,
      principalName: principal?.principalName,
      event,
      action,
      details,
      success: false,
    });
  }

  /**
   * Query the audit log.
   */
  async query(opts: AuditQuery): Promise<AuditEntry[]> {
    const entries: AuditEntry[] = [];

    try {
      const raw = await readFile(this.logPath, 'utf-8');
      const lines = raw.trim().split('\n').filter(Boolean);

      for (const line of lines) {
        try {
          const entry = JSON.parse(line) as AuditEntry;

          // Apply filters
          if (opts.agentId && entry.agentId !== opts.agentId) continue;
          if (opts.event && entry.event !== opts.event) continue;
          if (opts.since && new Date(entry.timestamp) < opts.since) continue;

          entries.push(entry);
        } catch {
          // Skip corrupt lines
        }
      }
    } catch {
      // No log file yet
    }

    // Apply tail
    if (opts.tail && entries.length > opts.tail) {
      return entries.slice(-opts.tail);
    }

    return entries;
  }

  /**
   * Flush the write queue to disk.
   */
  async flush(): Promise<void> {
    this.flushTimer = null;
    if (this.writeQueue.length === 0) return;

    const batch = this.writeQueue.join('');
    this.writeQueue = [];

    try {
      await mkdir(this.logDir, { recursive: true });

      // Check file size for rotation
      await this.maybeRotate();

      await appendFile(this.logPath, batch, 'utf-8');
    } catch (err) {
      console.error(`[audit] Failed to write: ${err}`);
    }
  }

  /**
   * Rotate the log file if it exceeds maxFileSizeMb.
   */
  private async maybeRotate(): Promise<void> {
    if (!existsSync(this.logPath)) return;

    try {
      const st = await stat(this.logPath);
      const maxBytes = this.config.maxFileSizeMb * 1024 * 1024;

      if (st.size >= maxBytes) {
        const date = new Date().toISOString().split('T')[0];
        const rotatedPath = join(this.logDir, `audit-${date}.jsonl`);

        // If a rotated file for today already exists, add a counter
        let finalPath = rotatedPath;
        let counter = 1;
        while (existsSync(finalPath)) {
          finalPath = join(this.logDir, `audit-${date}-${counter}.jsonl`);
          counter++;
        }

        await rename(this.logPath, finalPath);
        console.log(`[audit] Rotated log → ${finalPath}`);
      }
    } catch {
      // Can't stat — file might not exist yet
    }
  }

  /**
   * Summarize tool arguments (truncate long values).
   */
  private summarizeArgs(args: Record<string, unknown>): Record<string, unknown> {
    const summary: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === 'string' && value.length > 200) {
        summary[key] = value.slice(0, 200) + '...';
      } else {
        summary[key] = value;
      }
    }
    return summary;
  }

  /**
   * Dispose: flush remaining entries.
   */
  async dispose(): Promise<void> {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
    }
    await this.flush();
  }
}

// ─── Singleton ──────────────────────────────────────────────────────

let globalAudit: AuditLogger | null = null;

/** Initialize the global audit logger. */
export function initAudit(config: AuditConfig): AuditLogger {
  globalAudit = new AuditLogger(config);
  return globalAudit;
}

/** Get the global audit logger (no-op if not initialized). */
export function getAudit(): AuditLogger | null {
  return globalAudit;
}
