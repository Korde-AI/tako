/**
 * ACP/Codex Integration tool — spawn Claude Code or Codex sessions.
 *
 * Internally shells out to `claude` or `codex` CLI with appropriate flags.
 * Returns summary + list of files changed.
 */

import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { Tool, ToolContext, ToolResult } from './tool.js';

const execAsync = promisify(execCb);

// ─── Types ──────────────────────────────────────────────────────────

export interface AcpConfig {
  /** Enable ACP integration (default: true). */
  enabled: boolean;
  /** Backend to use: 'claude' (Claude Code) or 'codex' (OpenAI Codex). */
  backend: 'claude' | 'codex';
  /** Default timeout in seconds (default: 600). */
  defaultTimeout: number;
}

interface AcpSpawnParams {
  task: string;
  cwd?: string;
  model?: string;
  timeout?: number;
}

// ─── ACP Tool ───────────────────────────────────────────────────────

/** Create the acp_spawn tool. */
export function createAcpTool(config: AcpConfig): Tool[] {
  const acpSpawn: Tool = {
    name: 'acp_spawn',
    description: 'Spawn a Claude Code or Codex session to perform a coding task. Returns the output and list of files changed.',
    group: 'runtime',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Task description for the coding agent' },
        cwd: { type: 'string', description: 'Working directory (defaults to current)' },
        model: { type: 'string', description: 'Model override' },
        timeout: { type: 'number', description: 'Timeout in seconds (default: 600)' },
      },
      required: ['task'],
    },

    async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
      if (!config.enabled) {
        return { output: '', success: false, error: 'ACP integration is disabled' };
      }

      const { task, cwd, model, timeout } = params as AcpSpawnParams;
      const workDir = cwd ?? ctx.workDir;
      const timeoutMs = (timeout ?? config.defaultTimeout) * 1000;

      try {
        // Build command based on backend
        let command: string;
        if (config.backend === 'claude') {
          command = `claude --dangerously-skip-permissions -p ${JSON.stringify(task)}`;
          if (model) command += ` --model ${model}`;
        } else {
          command = `codex --quiet -a full-auto ${JSON.stringify(task)}`;
        }

        // Get git status before to track changes
        let filesBefore: string;
        try {
          const { stdout } = await execAsync('git status --porcelain', {
            cwd: workDir,
            timeout: 5000,
          });
          filesBefore = stdout;
        } catch {
          filesBefore = '';
        }

        // Execute the ACP command
        const { stdout, stderr } = await execAsync(command, {
          cwd: workDir,
          timeout: timeoutMs,
          maxBuffer: 10 * 1024 * 1024, // 10MB output buffer
        });

        // Get git status after to detect changes
        let filesChanged = '';
        try {
          const { stdout: after } = await execAsync('git status --porcelain', {
            cwd: workDir,
            timeout: 5000,
          });
          // Find new/changed lines
          const beforeSet = new Set(filesBefore.split('\n').filter(Boolean));
          const newChanges = after.split('\n').filter(Boolean).filter((l) => !beforeSet.has(l));
          if (newChanges.length > 0) {
            filesChanged = '\n\nFiles changed:\n' + newChanges.join('\n');
          }
        } catch {
          // Not a git repo — skip
        }

        const output = [stdout, stderr].filter(Boolean).join('\n');
        const truncated = output.length > 50000
          ? output.slice(0, 50000) + '\n[... output truncated]'
          : output;

        return {
          output: truncated + filesChanged,
          success: true,
        };
      } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string; message?: string };
        const output = [e.stdout, e.stderr].filter(Boolean).join('\n');
        return {
          output: output || '',
          success: false,
          error: e.message ?? 'ACP command failed',
        };
      }
    },
  };

  return [acpSpawn];
}
