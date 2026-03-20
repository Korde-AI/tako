/**
 * Self-introspection tools — runtime state, config, logs, transcripts.
 *
 * Kernel tools (group: 'sessions') that let the agent inspect its own
 * runtime without reaching for shell commands.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Tool, ToolContext, ToolResult } from './tool.js';
import type { SessionManager } from '../gateway/session.js';
import type { TakoConfig } from '../config/schema.js';
import { getLogDir } from '../utils/logger.js';
import { getRuntimePaths } from '../core/paths.js';

// ─── Helpers ───────────────────────────────────────────────────────

/** Mask a string value — keep first 4 and last 4 chars, replace the middle. */
function maskSecret(val: string): string {
  if (val.length <= 12) return '****';
  return val.slice(0, 4) + '****' + val.slice(-4);
}

/** Deep-clone an object and mask any keys that look like secrets. */
function maskConfig(obj: unknown): unknown {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'string') return obj;
  if (Array.isArray(obj)) return obj.map(maskConfig);
  if (typeof obj !== 'object') return obj;

  const result: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
    const lower = key.toLowerCase();
    if (
      (lower.includes('token') || lower.includes('key') || lower.includes('secret') || lower.includes('password')) &&
      typeof val === 'string' && val.length > 0
    ) {
      result[key] = maskSecret(val);
    } else {
      result[key] = maskConfig(val);
    }
  }
  return result;
}

/** Resolve a dot-path like 'providers.primary' on an object. */
function getByPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const seg of path.split('.')) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[seg];
  }
  return cur;
}

// ─── Factory ───────────────────────────────────────────────────────

export interface IntrospectOpts {
  config: TakoConfig;
  sessions: SessionManager;
  startTime: number;
  channels: { id: string }[];
  agentIds: string[];
  skillCount: number;
  version: string;
}

export function createIntrospectTools(opts: IntrospectOpts): Tool[] {
  const { config, sessions, startTime, channels, agentIds, skillCount, version } = opts;

  // ── tako_status ────────────────────────────────────────────────

  const takoStatus: Tool = {
    name: 'tako_status',
    description: 'Show Tako runtime status: uptime, model, connected channels, active sessions, agents, skills.',
    group: 'sessions',
    parameters: { type: 'object', properties: {} },

    async execute(_params: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const uptimeMs = Date.now() - startTime;
      const uptimeSec = Math.floor(uptimeMs / 1000);
      const hours = Math.floor(uptimeSec / 3600);
      const mins = Math.floor((uptimeSec % 3600) / 60);
      const secs = uptimeSec % 60;
      const uptime = `${hours}h ${mins}m ${secs}s`;

      const activeSessions = sessions.list();

      const status = {
        version,
        uptime,
        uptimeMs,
        model: config.providers.primary,
        channels: channels.map((c) => c.id),
        activeSessions: activeSessions.length,
        agents: agentIds,
        skills: skillCount,
        configPath: config._configPath ?? 'tako.json',
      };

      return { output: JSON.stringify(status, null, 2), success: true };
    },
  };

  // ── tako_config ────────────────────────────────────────────────

  const takoConfig: Tool = {
    name: 'tako_config',
    description: 'Read Tako configuration with API keys/tokens masked. Optionally pass a dot-path (e.g. "providers.primary") to read a specific section.',
    group: 'sessions',
    parameters: {
      type: 'object',
      properties: {
        path: {
          type: 'string',
          description: 'Dot-path to a config section (e.g. "providers.primary", "channels.discord"). Omit for full config.',
        },
      },
    },

    async execute(params: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const { path } = (params ?? {}) as { path?: string };

      // Deep-clone to avoid mutating runtime config
      const safeConfig = JSON.parse(JSON.stringify(config));
      // Remove internal fields
      delete safeConfig._configPath;

      const masked = maskConfig(safeConfig);

      if (path) {
        const section = getByPath(masked, path);
        if (section === undefined) {
          return { output: `No config found at path: ${path}`, success: false };
        }
        return {
          output: typeof section === 'string' ? section : JSON.stringify(section, null, 2),
          success: true,
        };
      }

      return { output: JSON.stringify(masked, null, 2), success: true };
    },
  };

  // ── tako_logs ──────────────────────────────────────────────────

  const takoLogs: Tool = {
    name: 'tako_logs',
    description: 'Read lines from the Tako log file (~/.tako/logs/tako-YYYY-MM-DD.log). Supports line count and grep filter.',
    group: 'sessions',
    parameters: {
      type: 'object',
      properties: {
        date: {
          type: 'string',
          description: 'Date in YYYY-MM-DD format. Defaults to today.',
        },
        lines: {
          type: 'number',
          description: 'Number of most recent lines to return (default: 50).',
          default: 50,
        },
        grep: {
          type: 'string',
          description: 'Case-insensitive substring filter applied to each line.',
        },
      },
    },

    async execute(params: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const { date, lines = 50, grep } = (params ?? {}) as {
        date?: string;
        lines?: number;
        grep?: string;
      };

      const logDate = date ? new Date(date + 'T00:00:00') : new Date();
      const dateStr = logDate.toISOString().slice(0, 10);
      const logFile = join(getLogDir(), `tako-${dateStr}.log`);

      let content: string;
      try {
        content = await readFile(logFile, 'utf-8');
      } catch {
        return { output: `No log file found for ${dateStr}`, success: false };
      }

      let allLines = content.split('\n').filter(Boolean);

      if (grep) {
        const lower = grep.toLowerCase();
        allLines = allLines.filter((l) => l.toLowerCase().includes(lower));
      }

      const selected = allLines.slice(-lines);

      return {
        output: JSON.stringify({
          file: logFile,
          totalLines: allLines.length,
          returned: selected.length,
          lines: selected,
        }, null, 2),
        success: true,
      };
    },
  };

  // ── session_transcript ─────────────────────────────────────────

  const sessionTranscript: Tool = {
    name: 'session_transcript',
    description: 'Read the raw JSONL transcript of a session by ID. Returns the file contents from disk.',
    group: 'sessions',
    parameters: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'Session UUID. Reads the corresponding .jsonl file.',
        },
        lines: {
          type: 'number',
          description: 'Max lines to return from the end of the file (default: 100).',
          default: 100,
        },
      },
      required: ['sessionId'],
    },

    async execute(params: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const { sessionId, lines = 100 } = params as { sessionId: string; lines?: number };

      // Try to find the file in any agent session dir
      const session = sessions.get(sessionId);
      const agentId = (session?.metadata.agentId as string) ?? 'main';
      const filePath = join(getRuntimePaths().agentsDir, agentId, 'sessions', `${sessionId}.jsonl`);

      let content: string;
      try {
        content = await readFile(filePath, 'utf-8');
      } catch {
        return { output: `Transcript not found: ${filePath}`, success: false };
      }

      const allLines = content.split('\n').filter(Boolean);
      const selected = allLines.slice(-lines);

      return {
        output: JSON.stringify({
          sessionId,
          file: filePath,
          totalLines: allLines.length,
          returned: selected.length,
          lines: selected.map((l) => {
            try { return JSON.parse(l); } catch { return l; }
          }),
        }, null, 2),
        success: true,
      };
    },
  };

  return [takoStatus, takoConfig, takoLogs, sessionTranscript];
}
