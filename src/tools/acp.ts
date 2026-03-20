/**
 * ACP one-shot tool — spawn an acpx session, run a single turn, close.
 *
 * Uses the AcpxRuntime for proper protocol-based communication
 * instead of raw shell execution.
 */

import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import type { AcpxRuntime } from '../acp/runtime.js';
import type { AcpRuntimeConfig } from '../acp/config.js';
import type { AcpRuntimeEvent } from '../acp/events.js';
import type { Tool, ToolContext, ToolResult } from './tool.js';

const execAsync = promisify(execCb);

// ─── Types ──────────────────────────────────────────────────────

/** Re-export config for backwards compatibility. */
export type { AcpRuntimeConfig as AcpConfig } from '../acp/config.js';

interface AcpSpawnParams {
  task: string;
  cwd?: string;
  model?: string;
  timeout?: number;
  agent?: string;
}

// ─── ACP Tool ───────────────────────────────────────────────────

/** Create the acp_spawn tool backed by AcpxRuntime. */
export function createAcpTool(config: AcpRuntimeConfig, runtime: AcpxRuntime): Tool[] {
  const acpSpawn: Tool = {
    name: 'acp_spawn',
    description:
      'Spawn an ACP coding agent session (Claude, Codex, etc.) to perform a task. ' +
      'Returns the agent output and list of files changed.',
    group: 'runtime',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Task description for the coding agent' },
        cwd: { type: 'string', description: 'Working directory (defaults to current)' },
        model: { type: 'string', description: 'Model override (not all agents support this)' },
        timeout: { type: 'number', description: 'Timeout in seconds (default: 600)' },
        agent: {
          type: 'string',
          description: `Agent to use (default: ${config.defaultAgent}). Options: ${config.allowedAgents.join(', ')}`,
        },
      },
      required: ['task'],
    },

    async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
      if (!config.enabled) {
        return { output: '', success: false, error: 'ACP integration is disabled' };
      }

      if (!runtime.isHealthy()) {
        return {
          output: '',
          success: false,
          error: 'ACP runtime (acpx) is not available. Ensure acpx is installed.',
        };
      }

      const { task, cwd, timeout, agent } = params as AcpSpawnParams;
      const workDir = cwd ?? ctx.workDir;
      const agentId = agent ?? config.defaultAgent;
      const timeoutMs = (timeout ?? config.timeoutSeconds) * 1000;

      // Validate agent
      if (!config.allowedAgents.includes(agentId)) {
        return {
          output: '',
          success: false,
          error: `Agent '${agentId}' is not allowed. Allowed: ${config.allowedAgents.join(', ')}`,
        };
      }

      // Generate a unique session name for this one-shot
      const sessionName = `tako-oneshot-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      try {
        // Get git status before to track changes
        const filesBefore = await getGitStatus(workDir);

        // Set up timeout abort
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), timeoutMs);

        try {
          // Ensure session
          const handle = await runtime.ensureSession({
            sessionKey: sessionName,
            agent: agentId,
            cwd: workDir,
            mode: 'oneshot',
          });

          // Run the turn and collect output
          let output = '';
          for await (const event of runtime.runTurn({
            handle,
            text: task,
            signal: controller.signal,
          })) {
            output += collectEventText(event);
          }

          // Close the session
          await runtime.close({ handle, reason: 'oneshot-complete' }).catch(() => {});

          // Detect file changes
          const filesChanged = await getFileChanges(workDir, filesBefore);

          const truncated =
            output.length > 50000
              ? output.slice(0, 50000) + '\n[... output truncated]'
              : output;

          return {
            output: truncated + filesChanged,
            success: true,
          };
        } finally {
          clearTimeout(timer);
        }
      } catch (err: unknown) {
        const e = err as Error;
        return {
          output: '',
          success: false,
          error: e.message ?? 'ACP command failed',
        };
      }
    },
  };

  return [acpSpawn];
}

// ─── Helpers ────────────────────────────────────────────────────

/** Collect text from a runtime event. */
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

async function getGitStatus(cwd: string): Promise<string> {
  try {
    const { stdout } = await execAsync('git status --porcelain', { cwd, timeout: 5000 });
    return stdout;
  } catch {
    return '';
  }
}

async function getFileChanges(cwd: string, filesBefore: string): Promise<string> {
  try {
    const { stdout: after } = await execAsync('git status --porcelain', { cwd, timeout: 5000 });
    const beforeSet = new Set(filesBefore.split('\n').filter(Boolean));
    const newChanges = after.split('\n').filter(Boolean).filter((l) => !beforeSet.has(l));
    if (newChanges.length > 0) {
      return '\n\nFiles changed:\n' + newChanges.join('\n');
    }
  } catch {
    // Not a git repo — skip
  }
  return '';
}
