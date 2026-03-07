/**
 * Filesystem tools — read, write, edit, apply_patch.
 * Kernel tools (always available).
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import type { Tool, ToolContext, ToolResult } from './tool.js';
import type { CacheManager } from '../cache/manager.js';

// ─── Cache integration ──────────────────────────────────────────────

let cacheManager: CacheManager | null = null;

/** Wire the cache manager into filesystem tools. */
export function setFsCacheManager(manager: CacheManager): void {
  cacheManager = manager;
}

// ─── read ───────────────────────────────────────────────────────────

interface ReadParams {
  path: string;
  start?: number;
  end?: number;
}

export const readTool: Tool = {
  name: 'read',
  description: 'Read a file from disk. Optionally specify start/end line numbers.',
  group: 'fs',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path (absolute or relative to workDir)' },
      start: { type: 'number', description: 'Start line (1-based, optional)' },
      end: { type: 'number', description: 'End line (1-based, inclusive, optional)' },
    },
    required: ['path'],
  },

  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { path, start, end } = params as ReadParams;
    const fullPath = resolve(ctx.workDir, path);
    try {
      // Check file cache first
      let content: string;
      const cached = cacheManager ? await cacheManager.file.get(fullPath) : null;
      if (cached !== null) {
        content = cached;
      } else {
        content = await readFile(fullPath, 'utf-8');
        // Store in cache for future reads
        if (cacheManager) await cacheManager.file.set(fullPath, content);
      }
      if (start !== undefined || end !== undefined) {
        const lines = content.split('\n');
        const s = (start ?? 1) - 1;
        const e = end ?? lines.length;
        const slice = lines.slice(s, e);
        return { output: slice.map((l, i) => `${s + i + 1}\t${l}`).join('\n'), success: true };
      }
      return { output: content, success: true };
    } catch (err) {
      return { output: '', success: false, error: `Failed to read ${path}: ${err}` };
    }
  },
};

// ─── write ──────────────────────────────────────────────────────────

interface WriteParams {
  path: string;
  content: string;
}

export const writeTool: Tool = {
  name: 'write',
  description: 'Write content to a file, creating it if necessary.',
  group: 'fs',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path' },
      content: { type: 'string', description: 'File content to write' },
    },
    required: ['path', 'content'],
  },

  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { path, content } = params as WriteParams;
    const fullPath = resolve(ctx.workDir, path);
    try {
      await writeFile(fullPath, content, 'utf-8');
      // Invalidate cache on write
      cacheManager?.onFileWrite(fullPath);
      return { output: `Wrote ${content.length} bytes to ${path}`, success: true };
    } catch (err) {
      return { output: '', success: false, error: `Failed to write ${path}: ${err}` };
    }
  },
};

// ─── edit ───────────────────────────────────────────────────────────

interface EditParams {
  path: string;
  old_string: string;
  new_string: string;
}

export const editTool: Tool = {
  name: 'edit',
  description: 'Replace an exact string in a file with a new string.',
  group: 'fs',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path' },
      old_string: { type: 'string', description: 'Exact text to find and replace' },
      new_string: { type: 'string', description: 'Replacement text' },
    },
    required: ['path', 'old_string', 'new_string'],
  },

  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { path, old_string, new_string } = params as EditParams;
    const fullPath = resolve(ctx.workDir, path);
    try {
      const content = await readFile(fullPath, 'utf-8');
      if (!content.includes(old_string)) {
        return { output: '', success: false, error: 'old_string not found in file' };
      }
      const updated = content.replace(old_string, new_string);
      await writeFile(fullPath, updated, 'utf-8');
      // Invalidate cache on edit
      cacheManager?.onFileWrite(fullPath);
      return { output: `Edited ${path}`, success: true };
    } catch (err) {
      return { output: '', success: false, error: `Failed to edit ${path}: ${err}` };
    }
  },
};

// ─── apply_patch ────────────────────────────────────────────────────

interface ApplyPatchParams {
  path: string;
  patch: string;
}

export const applyPatchTool: Tool = {
  name: 'apply_patch',
  description: 'Apply a unified diff patch to a file.',
  group: 'fs',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path' },
      patch: { type: 'string', description: 'Unified diff patch content' },
    },
    required: ['path', 'patch'],
  },

  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { path, patch } = params as ApplyPatchParams;
    const fullPath = resolve(ctx.workDir, path);
    try {
      // Read existing file (may not exist for new files)
      let content: string;
      try {
        content = await readFile(fullPath, 'utf-8');
      } catch {
        content = '';
      }

      const lines = content.split('\n');
      const result = applyUnifiedDiff(lines, patch);
      if (!result.success) {
        return { output: '', success: false, error: result.error };
      }

      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, result.lines.join('\n'), 'utf-8');
      return { output: `Patched ${path} (${result.hunksApplied} hunks applied)`, success: true };
    } catch (err) {
      return { output: '', success: false, error: `Failed to apply patch to ${path}: ${err}` };
    }
  },
};

// ─── Unified diff parser + applier ──────────────────────────────────

interface HunkHeader {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
}

interface DiffResult {
  success: boolean;
  lines: string[];
  hunksApplied: number;
  error?: string;
}

function parseHunkHeader(line: string): HunkHeader | null {
  const match = line.match(/^@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/);
  if (!match) return null;
  return {
    oldStart: parseInt(match[1], 10),
    oldCount: match[2] !== undefined ? parseInt(match[2], 10) : 1,
    newStart: parseInt(match[3], 10),
    newCount: match[4] !== undefined ? parseInt(match[4], 10) : 1,
  };
}

function applyUnifiedDiff(originalLines: string[], patch: string): DiffResult {
  const patchLines = patch.split('\n');
  const result = [...originalLines];
  let hunksApplied = 0;
  let offset = 0; // Track line number shifts from previous hunks

  let i = 0;
  while (i < patchLines.length) {
    // Skip file headers (--- and +++)
    if (patchLines[i].startsWith('---') || patchLines[i].startsWith('+++')) {
      i++;
      continue;
    }

    // Find hunk header
    const header = parseHunkHeader(patchLines[i]);
    if (!header) {
      i++;
      continue;
    }
    i++;

    // Collect hunk lines
    const removals: number[] = [];
    const additions: string[] = [];
    let contextCount = 0;
    let linePos = header.oldStart - 1 + offset;

    const hunkLines: Array<{ type: ' ' | '+' | '-'; text: string }> = [];
    while (i < patchLines.length && !patchLines[i].startsWith('@@')) {
      const line = patchLines[i];
      if (line.startsWith('+')) {
        hunkLines.push({ type: '+', text: line.slice(1) });
      } else if (line.startsWith('-')) {
        hunkLines.push({ type: '-', text: line.slice(1) });
      } else if (line.startsWith(' ') || line === '') {
        hunkLines.push({ type: ' ', text: line.slice(1) });
      } else {
        // Not a diff line — stop this hunk
        break;
      }
      i++;
    }

    // Apply hunk: walk through and do removals/additions
    let pos = header.oldStart - 1 + offset;
    const newLines: string[] = [];
    let oldIdx = 0;

    // Copy lines before this hunk
    for (let j = 0; j < pos && j < result.length; j++) {
      newLines.push(result[j]);
    }

    // Apply hunk changes
    let srcPos = pos;
    for (const hl of hunkLines) {
      if (hl.type === ' ') {
        // Context line — copy from source
        if (srcPos < result.length) {
          newLines.push(result[srcPos]);
        }
        srcPos++;
      } else if (hl.type === '-') {
        // Remove line — skip in source
        srcPos++;
      } else if (hl.type === '+') {
        // Add line
        newLines.push(hl.text);
      }
    }

    // Copy remaining lines after hunk
    for (let j = srcPos; j < result.length; j++) {
      newLines.push(result[j]);
    }

    // Replace result
    result.length = 0;
    result.push(...newLines);
    offset += (header.newCount - header.oldCount);
    hunksApplied++;
  }

  if (hunksApplied === 0) {
    return { success: false, lines: originalLines, hunksApplied: 0, error: 'No hunks found in patch' };
  }

  return { success: true, lines: result, hunksApplied };
}

/** All filesystem tools. */
export const fsTools: Tool[] = [readTool, writeTool, editTool, applyPatchTool];
