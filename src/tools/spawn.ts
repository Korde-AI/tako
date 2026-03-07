/**
 * Spawn Agent tool — create ephemeral sub-agents for specific tasks.
 *
 * Wraps the SubAgentOrchestrator as a tool the model can invoke.
 */

import type { Tool, ToolContext, ToolResult } from './tool.js';
import type { SubAgentOrchestrator } from '../agents/subagent.js';

interface SpawnParams {
  task: string;
  model?: string;
  timeout?: number;
  label?: string;
  cwd?: string;
}

/** Create the spawn_agent tool with a reference to the orchestrator. */
export function createSpawnTool(orchestrator: SubAgentOrchestrator): Tool {
  return {
    name: 'spawn_agent',
    description: 'Spawn an ephemeral sub-agent to handle a specific task. The sub-agent runs in its own isolated session and returns its result when done.',
    group: 'agents',
    parameters: {
      type: 'object',
      properties: {
        task: { type: 'string', description: 'Task description for the sub-agent to work on' },
        model: { type: 'string', description: 'Model override (e.g. "anthropic/claude-sonnet-4-6")' },
        timeout: { type: 'number', description: 'Timeout in seconds (default: 600)' },
        label: { type: 'string', description: 'Human-readable label for tracking' },
        cwd: { type: 'string', description: 'Working directory for the sub-agent' },
      },
      required: ['task'],
    },

    async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
      const { task, model, timeout, label } = params as SpawnParams;

      try {
        const run = await orchestrator.spawn(ctx.sessionId, {
          task,
          agentId: ctx.agentId,
          mode: 'run',
          label,
          model,
          timeoutMs: timeout ? timeout * 1000 : undefined,
          announceCompletion: false, // we'll return the result directly
        });

        // Wait for completion (poll the run status)
        const maxWait = (timeout ?? 600) * 1000;
        const start = Date.now();

        while (run.status === 'running' && Date.now() - start < maxWait) {
          await new Promise((r) => setTimeout(r, 500));
        }

        if (run.status === 'completed') {
          return {
            output: run.result ?? '(no output)',
            success: true,
          };
        } else if (run.status === 'timeout') {
          return {
            output: `Sub-agent timed out after ${timeout ?? 600}s`,
            success: false,
            error: 'timeout',
          };
        } else {
          return {
            output: '',
            success: false,
            error: `Sub-agent ${run.status}: ${run.error ?? 'unknown error'}`,
          };
        }
      } catch (err) {
        return {
          output: '',
          success: false,
          error: `Failed to spawn agent: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}
