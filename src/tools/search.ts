/**
 * Search tools — glob_search, content_search.
 * Kernel tools (always available).
 *
 * Performance notes:
 * - glob_search uses `fd` (fast alternative to `find`) with Node glob fallback
 * - content_search uses `rg` (ripgrep, fast alternative to `grep`) with grep fallback
 * - Both tools respect .gitignore by default (fd and rg skip ignored files)
 *
 * fd usage tips (for exec tool):
 *   fd <name>               — find files by name
 *   fd -e ts                — find by extension
 *   fd -t f <pattern>       — files only
 *   fd -t d <pattern>       — directories only
 *   fd --no-ignore <pattern>— include .gitignore'd files
 *
 * rg usage tips (for exec tool):
 *   rg <pattern>            — search recursively
 *   rg -l <pattern>         — list matching files only
 *   rg -t ts <pattern>      — filter by file type
 *   rg --no-ignore <pattern>— include .gitignore'd files
 *   rg -A 3 -B 3 <pattern>  — show 3 lines of context
 */

import { glob } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Tool, ToolContext, ToolResult } from './tool.js';
import { resolveSubdirWithinAllowedRoot } from './root-policy.js';

const execFileAsync = promisify(execFile);

// ─── glob_search ────────────────────────────────────────────────────

interface GlobParams {
  pattern: string;
  path?: string;
}

export const globSearchTool: Tool = {
  name: 'glob_search',
  description: [
    'Find files matching a glob pattern.',
    'Uses `fd` (fast-find) when available, falls back to Node glob.',
    'fd respects .gitignore and is significantly faster than find on large repos.',
    'For advanced use, call fd directly via exec: `fd -e ts` (by extension), `fd -t d` (dirs only), `fd --no-ignore` (include ignored files).',
  ].join(' '),
  group: 'search',
  parameters: {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern (e.g. "**/*.ts") or fd-style name pattern' },
      path: { type: 'string', description: 'Base directory (optional, defaults to workDir)' },
    },
    required: ['pattern'],
  },

  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { pattern, path } = params as GlobParams;
    const resolved = resolveSubdirWithinAllowedRoot(ctx, path);
    if (!resolved.ok) {
      return { output: '', success: false, error: resolved.error };
    }
    const basePath = resolved.fullPath;

    // Try fd first (much faster than Node glob on large repos)
    try {
      // Convert glob pattern to fd-compatible pattern
      // fd doesn't use ** globs — pass the basename portion as a regex
      const fdPattern = pattern.replace(/\*\*\//g, '').replace(/\*/g, '.*');
      const { stdout } = await execFileAsync(
        'fd',
        ['--color=never', '--full-path', fdPattern, basePath],
        { maxBuffer: 2 * 1024 * 1024 },
      );
      return { output: stdout.trim() || '(no matches)', success: true };
    } catch {
      // fd not found — fall back to Node glob
      try {
        const matches: string[] = [];
        for await (const entry of glob(pattern, { cwd: basePath })) {
          matches.push(entry);
        }
        return { output: matches.join('\n') || '(no matches)', success: true };
      } catch (err) {
        return { output: '', success: false, error: `glob_search failed: ${err}` };
      }
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
  description: [
    'Search file contents using a regex pattern (like grep/ripgrep).',
    'Uses `rg` (ripgrep) when available — significantly faster than grep on large repos.',
    'rg respects .gitignore by default and supports full Rust regex syntax.',
    'For advanced use, call rg directly via exec:',
    '`rg -l <pattern>` (list files only),',
    '`rg -t ts <pattern>` (filter by file type),',
    '`rg -A 3 -B 3 <pattern>` (show context lines),',
    '`rg --no-ignore <pattern>` (include .gitignore\'d files).',
    'Falls back to grep if rg is not installed.',
  ].join(' '),
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
    const resolved = resolveSubdirWithinAllowedRoot(ctx, path);
    if (!resolved.ok) {
      return { output: '', success: false, error: resolved.error };
    }
    const searchPath = resolved.fullPath;
    try {
      // Use ripgrep — fast, respects .gitignore, full regex support
      const args = ['-n', '--color=never'];
      if (fileGlob) args.push('--glob', fileGlob);
      args.push(pattern, searchPath);

      const { stdout } = await execFileAsync('rg', args, { maxBuffer: 2 * 1024 * 1024 });
      return { output: stdout || '(no matches)', success: true };
    } catch {
      // rg not found or no matches (exit code 1 = no matches, which is not an error)
      try {
        const grepArgs = ['-rn', '--color=never', pattern, searchPath];
        if (fileGlob) grepArgs.splice(2, 0, '--include', fileGlob);
        const { stdout } = await execFileAsync('grep', grepArgs, {
          maxBuffer: 2 * 1024 * 1024,
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
