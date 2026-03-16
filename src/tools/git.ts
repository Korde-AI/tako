/**
 * Git tool — git operations (status, diff, commit, log, etc.).
 * Core extension (available by default, can be disabled).
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Tool, ToolContext, ToolResult } from './tool.js';
import { getAllowedToolRoot } from './root-policy.js';

const execFileAsync = promisify(execFile);

interface GitParams {
  subcommand: string;
  args?: string[];
}

export const gitTool: Tool = {
  name: 'git',
  description: 'Run git operations (status, diff, commit, log, branch, etc.).',
  group: 'git',
  parameters: {
    type: 'object',
    properties: {
      subcommand: {
        type: 'string',
        description: 'Git subcommand (e.g. "status", "diff", "log", "commit")',
      },
      args: {
        type: 'array',
        items: { type: 'string' },
        description: 'Additional arguments',
      },
    },
    required: ['subcommand'],
  },

  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { subcommand, args } = params as GitParams;

    // Safety: block destructive operations
    const blocked = ['push --force', 'reset --hard', 'clean -f'];
    const fullCmd = [subcommand, ...(args ?? [])].join(' ');
    if (blocked.some((b) => fullCmd.includes(b))) {
      return { output: '', success: false, error: `Blocked destructive git operation: ${fullCmd}` };
    }

    const cwd = getAllowedToolRoot(ctx);
    try {
      const { stdout, stderr } = await execFileAsync('git', [subcommand, ...(args ?? [])], {
        cwd,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
      return { output: [stdout, stderr].filter(Boolean).join('\n'), success: true };
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      return {
        output: [e.stdout, e.stderr].filter(Boolean).join('\n'),
        success: false,
        error: e.message,
      };
    }
  },
};

/** All git tools. */
export const gitTools: Tool[] = [gitTool];
