/**
 * Memory tools — memory_search, memory_get, memory_store.
 * Kernel tools (always available).
 */

import { readFile, writeFile, appendFile, mkdir } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import type { Tool, ToolContext, ToolResult } from './tool.js';
import type { MemoryStore } from '../memory/store.js';

/**
 * Create memory tools bound to a MemoryStore instance.
 */
export function createMemoryTools(store: MemoryStore): Tool[] {
  // ─── memory_search ──────────────────────────────────────────────

  const memorySearchTool: Tool = {
    name: 'memory_search',
    description: 'Semantic search across indexed memory files.',
    group: 'memory',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results (default: 5)' },
      },
      required: ['query'],
    },

    async execute(params: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const { query, limit } = params as { query: string; limit?: number };
      try {
        const results = await store.search(query, { limit: limit ?? 5 });
        if (results.length === 0) {
          return { output: '(no results)', success: true };
        }
        const formatted = results.map(
          (r) => `[${r.path}:${r.range.start}-${r.range.end}] (score: ${r.score.toFixed(2)})\n${r.content}`,
        );
        return { output: formatted.join('\n---\n'), success: true };
      } catch (err) {
        return { output: '', success: false, error: `memory_search failed: ${err}` };
      }
    },
  };

  // ─── memory_get ───────────────────────────────────────────────────

  const memoryGetTool: Tool = {
    name: 'memory_get',
    description: 'Read a specific memory file or line range.',
    group: 'memory',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to workspace' },
        start: { type: 'number', description: 'Start line (1-based, optional)' },
        end: { type: 'number', description: 'End line (1-based, inclusive, optional)' },
      },
      required: ['path'],
    },

    async execute(params: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const { path, start, end } = params as { path: string; start?: number; end?: number };
      try {
        const range = start !== undefined ? { start, end: end ?? start } : undefined;
        const content = await store.get(path, range);
        return { output: content, success: true };
      } catch (err) {
        return { output: '', success: false, error: `memory_get failed: ${err}` };
      }
    },
  };

  // ─── memory_store ─────────────────────────────────────────────────

  const memoryStoreTool: Tool = {
    name: 'memory_store',
    description: 'Write or append content to a memory file.',
    group: 'memory',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to workspace' },
        content: { type: 'string', description: 'Content to write' },
        mode: { type: 'string', enum: ['write', 'append'], description: 'Write mode (default: append)' },
      },
      required: ['path', 'content'],
    },

    async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
      const { path, content, mode } = params as { path: string; content: string; mode?: string };
      const fullPath = resolve(ctx.workspaceRoot, path);
      try {
        await mkdir(dirname(fullPath), { recursive: true });
        if (mode === 'write') {
          await writeFile(fullPath, content, 'utf-8');
        } else {
          await appendFile(fullPath, content + '\n', 'utf-8');
        }
        // Re-index the file
        await store.index(path);
        return { output: `Stored to ${path}`, success: true };
      } catch (err) {
        return { output: '', success: false, error: `memory_store failed: ${err}` };
      }
    },
  };

  return [memorySearchTool, memoryGetTool, memoryStoreTool];
}
