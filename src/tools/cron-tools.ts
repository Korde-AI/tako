/**
 * Cron management tools — let the agent schedule its own tasks.
 *
 * Tools: cron_list, cron_add, cron_remove, cron_run
 */

import type { Tool, ToolResult } from './tool.js';
import type { CronScheduler, CronSchedule, CronPayload, CronDelivery } from '../core/cron.js';

export function createCronTools(scheduler: CronScheduler): Tool[] {
  return [
    {
      name: 'cron_list',
      description: 'List scheduled cron jobs. Returns all active jobs with their schedule, payload, and last run info.',
      parameters: {
        type: 'object' as const,
        properties: {
          includeDisabled: {
            type: 'boolean' as const,
            description: 'Include disabled jobs (default: false)',
          },
        },
      },
      execute: async (params: Record<string, unknown>): Promise<ToolResult> => {
        const jobs = scheduler.list(!!params.includeDisabled);
        if (jobs.length === 0) {
          return { output: 'No cron jobs configured.', success: true };
        }
        const summary = jobs.map((j) => ({
          id: j.id,
          name: j.name,
          enabled: j.enabled,
          schedule: j.schedule,
          payload: j.payload.kind,
          lastRun: j.lastRunAt ?? 'never',
          runCount: j.runCount,
        }));
        return { output: JSON.stringify(summary, null, 2), success: true };
      },
    },
    {
      name: 'cron_add',
      description: `Add a scheduled job. Schedule kinds: "at" (one-shot ISO timestamp), "every" (interval ms), "cron" (cron expression). Payload kinds: "system-event" (inject text) or "agent-turn" (run agent). Example: { "name": "Morning brief", "schedule": { "kind": "cron", "expr": "0 7 * * *" }, "payload": { "kind": "agent-turn", "message": "Summarize overnight updates" } }`,
      parameters: {
        type: 'object' as const,
        properties: {
          name: { type: 'string' as const, description: 'Job name' },
          schedule: {
            type: 'object' as const,
            description: 'Schedule: { kind: "at"|"every"|"cron", at?: "ISO", everyMs?: number, expr?: "min hr dom mon dow", tz?: "TZ" }',
          },
          payload: {
            type: 'object' as const,
            description: 'Payload: { kind: "system-event"|"agent-turn", text?: string, message?: string, model?: string }',
          },
          delivery: {
            type: 'object' as const,
            description: 'Delivery: { mode: "none"|"announce", channel?: string, to?: string }',
          },
          deleteAfterRun: {
            type: 'boolean' as const,
            description: 'Delete job after first successful run (for one-shot jobs)',
          },
        },
        required: ['name', 'schedule', 'payload'] as const,
      },
      execute: async (params: Record<string, unknown>): Promise<ToolResult> => {
        try {
          const job = await scheduler.add({
            name: params.name as string,
            enabled: true,
            schedule: params.schedule as CronSchedule,
            payload: params.payload as CronPayload,
            delivery: (params.delivery as CronDelivery) ?? { mode: 'none' },
            deleteAfterRun: !!params.deleteAfterRun,
          });
          return { output: `Job created: ${job.id} (${job.name})`, success: true };
        } catch (err) {
          return { output: `Failed to create job: ${err instanceof Error ? err.message : err}`, success: false };
        }
      },
    },
    {
      name: 'cron_remove',
      description: 'Remove a scheduled cron job by ID.',
      parameters: {
        type: 'object' as const,
        properties: {
          id: { type: 'string' as const, description: 'Job ID to remove' },
        },
        required: ['id'] as const,
      },
      execute: async (params: Record<string, unknown>): Promise<ToolResult> => {
        const removed = await scheduler.remove(params.id as string);
        return { output: removed ? `Job ${params.id} removed.` : `Job ${params.id} not found.`, success: true };
      },
    },
    {
      name: 'cron_run',
      description: 'Run a cron job immediately (bypass its schedule).',
      parameters: {
        type: 'object' as const,
        properties: {
          id: { type: 'string' as const, description: 'Job ID to run' },
        },
        required: ['id'] as const,
      },
      execute: async (params: Record<string, unknown>): Promise<ToolResult> => {
        const result = await scheduler.run(params.id as string);
        if (!result) return { output: `Job ${params.id} not found.`, success: false };
        return {
          output: `Job ${result.jobName} ran.\nStarted: ${result.startedAt}\nFinished: ${result.finishedAt}\nDelivered: ${result.delivered}\nResponse: ${result.response.slice(0, 500)}`,
          success: true,
        };
      },
    },
  ];
}
