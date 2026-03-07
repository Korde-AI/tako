/**
 * Search tools — glob_search, content_search.
 * Kernel tools (always available).
 */

import { glob } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Tool, ToolContext, ToolResult } from './tool.js';

const execFileAsync = promisify(execFile);

// ─── glob_search ────────────────────────────────────────────────────

interface GlobParams {
  pattern: string;
  path?: string;
}

export const globSearchTool: Tool = {
  name: 'glob_search',
  description: 'Find files matching a glob pattern.',
  group: 'search',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern (e.g. "**/*.ts")' },
      path: { type: 'string', description: 'Base directory (optional, defaults to workDir)' },
    },
    required: ['pattern'],
  },

  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { pattern, path } = params as GlobParams;
    const basePath = resolve(ctx.workDir, path ?? '.');
    try {
      const matches: string[] = [];
      for await (const entry of glob(pattern, { cwd: basePath })) {
        matches.push(entry);
      }
      return { output: matches.join('\n') || '(no matches)', success: true };
    } catch (err) {
      return { output: '', success: false, error: `glob_search failed: ${err}` };
    }
  },
};

// ─── content_search ─────────────────────────────────────────────────

interface ContentSearchParams {
  pattern: string;
  path?: string;
  glob?: string;
}

export const contentSearchTool: Tool = {
  name: 'content_search',
  description: 'Search file contents using a regex pattern (like grep/ripgrep).',
  group: 'search',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern to search for' },
      path: { type: 'string', description: 'Directory to search in (optional)' },
      glob: { type: 'string', description: 'File glob filter (optional, e.g. "*.ts")' },
    },
    required: ['pattern'],
  },

  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { pattern, path, glob: fileGlob } = params as ContentSearchParams;
    const searchPath = resolve(ctx.workDir, path ?? '.');
    try {
      // Try ripgrep first, fall back to grep
      const args = ['-n', '--color=never'];
      if (fileGlob) args.push('--glob', fileGlob);
      args.push(pattern, searchPath);

      const { stdout } = await execFileAsync('rg', args, { maxBuffer: 1024 * 1024 });
      return { output: stdout || '(no matches)', success: true };
    } catch {
      // rg not found or no matches (exit code 1)
      try {
        const { stdout } = await execFileAsync('grep', ['-rn', pattern, searchPath], {
          maxBuffer: 1024 * 1024,
        });
        return { output: stdout || '(no matches)', success: true };
      } catch {
        return { output: '(no matches)', success: true };
      }
    }
  },
};

/** All search tools. */
export const searchTools: Tool[] = [globSearchTool, contentSearchTool];
