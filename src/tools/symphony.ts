/**
 * Symphony tools — agent-invocable tools for project orchestration.
 *
 * - symphony_start: Start the orchestrator
 * - symphony_stop: Stop the orchestrator
 * - symphony_status: Show dashboard
 * - symphony_history: Show recent completed runs
 */

import type { Tool, ToolContext, ToolResult } from './tool.js';
import { SymphonyOrchestrator } from '../core/symphony/orchestrator.js';
import { formatStatus, formatHistory } from '../core/symphony/status.js';
import type { SymphonyConfig } from '../core/symphony/types.js';

function parseIntervalMs(interval: string): number {
  const match = interval.match(/^(\d+)(ms|s|m|h)?$/);
  if (!match) return 30000;
  const [, num, unit] = match;
  const n = parseInt(num, 10);
  switch (unit) {
    case 'ms': return n;
    case 's': return n * 1000;
    case 'm': return n * 60000;
    case 'h': return n * 3600000;
    default: return n * 1000; // default to seconds
  }
}

const symphonyStartTool: Tool = {
  name: 'symphony_start',
  description: 'Start Symphony project orchestrator — polls GitHub issues and spawns agents to implement them.',
  parameters: {
    type: 'object',
    properties: {
      repo: {
        type: 'string',
        description: 'GitHub repo in owner/repo format',
      },
      labels: {
        type: 'string',
        description: 'Comma-separated label filter (e.g. "bug,feature")',
      },
      interval: {
        type: 'string',
        description: 'Poll interval (e.g. "30s", "5m"). Default: 30s',
        default: '30s',
      },
      max_agents: {
        type: 'number',
        description: 'Max concurrent agents. Default: 5',
        default: 5,
      },
    },
    required: ['repo'],
  },

  async execute(params: unknown, _ctx: ToolContext): Promise<ToolResult> {
    const { repo, labels, interval, max_agents } = params as {
      repo: string;
      labels?: string;
      interval?: string;
      max_agents?: number;
    };

    // Check if already running
    const existing = SymphonyOrchestrator.getInstance();
    if (existing?.isRunning()) {
      return {
        output: 'Symphony is already running. Use symphony_stop first.',
        success: false,
      };
    }

    const config: SymphonyConfig = {
      repo,
      labels: labels ? labels.split(',').map((l) => l.trim()) : undefined,
      pollIntervalMs: interval ? parseIntervalMs(interval) : 30000,
      maxConcurrentAgents: max_agents ?? 5,
    };

    const orchestrator = SymphonyOrchestrator.getInstance(config);
    if (!orchestrator) {
      return { output: 'Failed to create orchestrator.', success: false };
    }

    orchestrator.start();

    return {
      output: `🎵 Symphony started!\n  Repo: ${repo}\n  Labels: ${labels ?? 'all'}\n  Interval: ${interval ?? '30s'}\n  Max agents: ${max_agents ?? 5}`,
      success: true,
    };
  },
};

const symphonyStopTool: Tool = {
  name: 'symphony_stop',
  description: 'Stop the Symphony orchestrator and all running agents.',
  parameters: {
    type: 'object',
    properties: {},
  },

  async execute(_params: unknown, _ctx: ToolContext): Promise<ToolResult> {
    const orchestrator = SymphonyOrchestrator.getInstance();
    if (!orchestrator?.isRunning()) {
      return { output: 'Symphony is not running.', success: false };
    }

    SymphonyOrchestrator.destroyInstance();
    return { output: '🎵 Symphony stopped.', success: true };
  },
};

const symphonyStatusTool: Tool = {
  name: 'symphony_status',
  description: 'Show Symphony dashboard — running agents, retry queue, history.',
  parameters: {
    type: 'object',
    properties: {},
  },

  async execute(_params: unknown, _ctx: ToolContext): Promise<ToolResult> {
    const orchestrator = SymphonyOrchestrator.getInstance();
    if (!orchestrator) {
      return { output: 'Symphony is not running. Start with symphony_start.', success: false };
    }

    const dashboard = formatStatus(orchestrator.getState(), orchestrator.getConfig());
    return { output: dashboard, success: true };
  },
};

const symphonyHistoryTool: Tool = {
  name: 'symphony_history',
  description: 'Show recent completed Symphony runs.',
  parameters: {
    type: 'object',
    properties: {
      limit: {
        type: 'number',
        description: 'Max number of entries to show. Default: 20',
        default: 20,
      },
    },
  },

  async execute(params: unknown, _ctx: ToolContext): Promise<ToolResult> {
    const { limit } = params as { limit?: number };
    const orchestrator = SymphonyOrchestrator.getInstance();
    if (!orchestrator) {
      return { output: 'Symphony is not running. Start with symphony_start.', success: false };
    }

    const completed = Array.from(orchestrator.getState().completed.values());
    const output = formatHistory(completed, limit ?? 20);
    return { output, success: true };
  },
};

/** All Symphony tools for registration. */
export const symphonyTools: Tool[] = [
  symphonyStartTool,
  symphonyStopTool,
  symphonyStatusTool,
  symphonyHistoryTool,
];
