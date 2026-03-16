/**
 * Memory tools — memory_search, memory_get, memory_store.
 * Kernel tools (always available).
 */

import { writeFile, appendFile, mkdir } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Tool, ToolContext, ToolResult } from './tool.js';
import { HybridMemoryStore } from '../memory/hybrid.js';
import type { EmbeddingProvider } from '../memory/vector.js';
import {
  getDefaultMemoryWriteScope,
  resolveScopedPath,
  resolveVisibleMemoryScopes,
  resolveWritableMemoryScope,
  type MemoryScope,
} from '../memory/scopes.js';
import { getRuntimePaths } from '../core/paths.js';

function scopeLabel(scope: MemoryScope): string {
  return scope;
}

interface StoreDeps {
  workspaceRoot: string;
  embeddingProvider?: EmbeddingProvider;
}

/**
 * Create memory tools with scope-aware project/shared/private visibility.
 */
export function createMemoryTools(deps: StoreDeps): Tool[] {
  const storeCache = new Map<string, HybridMemoryStore>();

  async function getStore(root: string): Promise<HybridMemoryStore> {
    const existing = storeCache.get(root);
    if (existing) return existing;
    const store = new HybridMemoryStore(root, deps.embeddingProvider);
    await store.initialize();
    storeCache.set(root, store);
    return store;
  }

  async function getReadableScopes(ctx: ToolContext) {
    const executionContext = ctx.executionContext;
    if (!executionContext) {
      return resolveVisibleMemoryScopes(getRuntimePaths(), deps.workspaceRoot, {
        mode: 'edge',
        home: getRuntimePaths().home,
        nodeId: 'unknown',
        nodeName: 'unknown',
        agentId: ctx.agentId ?? 'main',
      }).readable;
    }
    return resolveVisibleMemoryScopes(getRuntimePaths(), deps.workspaceRoot, executionContext).readable;
  }

  // ─── memory_search ──────────────────────────────────────────────

  const memorySearchTool: Tool = {
    name: 'memory_search',
    description: 'Semantic search across visible memory scopes.',
    group: 'memory',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Search query' },
        limit: { type: 'number', description: 'Max results (default: 5)' },
        scope: {
          type: 'string',
          enum: ['global-private', 'project-private', 'project-shared'],
          description: 'Optional memory scope filter',
        },
      },
      required: ['query'],
    },

    async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
      const { query, limit, scope } = params as { query: string; limit?: number; scope?: MemoryScope };
      try {
        const readableScopes = (await getReadableScopes(ctx))
          .filter((entry) => !scope || entry.scope === scope);
        if (readableScopes.length === 0) {
          return { output: '(no readable memory scopes)', success: true };
        }

        const results = (await Promise.all(readableScopes.map(async (entry) => {
          const store = await getStore(entry.root);
          const snippets = await store.search(query, { limit: limit ?? 5 });
          return snippets.map((snippet) => ({
            ...snippet,
            path: `${entry.scope}:${snippet.path}`,
            score: snippet.score,
          }));
        }))).flat()
          .sort((a, b) => b.score - a.score)
          .slice(0, limit ?? 5);

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
    description: 'Read a specific memory file or line range from a visible scope.',
    group: 'memory',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the memory scope root' },
        start: { type: 'number', description: 'Start line (1-based, optional)' },
        end: { type: 'number', description: 'End line (1-based, inclusive, optional)' },
        scope: {
          type: 'string',
          enum: ['global-private', 'project-private', 'project-shared'],
          description: 'Optional memory scope to read from',
        },
      },
      required: ['path'],
    },

    async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
      const { path, start, end, scope } = params as { path: string; start?: number; end?: number; scope?: MemoryScope };
      try {
        const readableScopes = (await getReadableScopes(ctx))
          .filter((entry) => !scope || entry.scope === scope);
        const range = start !== undefined ? { start, end: end ?? start } : undefined;
        for (const entry of readableScopes) {
          const store = await getStore(entry.root);
          const content = await store.get(path, range);
          if (content) {
            return { output: content, success: true };
          }
        }
        return { output: '', success: true };
      } catch (err) {
        return { output: '', success: false, error: `memory_get failed: ${err}` };
      }
    },
  };

  // ─── memory_store ─────────────────────────────────────────────────

  const memoryStoreTool: Tool = {
    name: 'memory_store',
    description: 'Write or append content to a memory file in the selected scope.',
    group: 'memory',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'File path relative to the memory scope root' },
        content: { type: 'string', description: 'Content to write' },
        mode: { type: 'string', enum: ['write', 'append'], description: 'Write mode (default: append)' },
        scope: {
          type: 'string',
          enum: ['global-private', 'project-private', 'project-shared'],
          description: 'Optional target memory scope',
        },
      },
      required: ['path', 'content'],
    },

    async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
      const { path, content, mode, scope } = params as {
        path: string;
        content: string;
        mode?: string;
        scope?: MemoryScope;
      };

      const executionContext = ctx.executionContext;
      const targetScope = scope ?? getDefaultMemoryWriteScope(executionContext ?? {
        mode: 'edge',
        home: getRuntimePaths().home,
        nodeId: 'unknown',
        nodeName: 'unknown',
        agentId: ctx.agentId ?? 'main',
      });
      const resolved = resolveWritableMemoryScope(
        getRuntimePaths(),
        deps.workspaceRoot,
        executionContext ?? {
          mode: 'edge',
          home: getRuntimePaths().home,
          nodeId: 'unknown',
          nodeName: 'unknown',
          agentId: ctx.agentId ?? 'main',
        },
        targetScope,
      );
      if (!resolved) {
        return { output: '', success: false, error: `memory_store failed: scope ${targetScope} is not writable in this context` };
      }

      const fullPath = resolveScopedPath(resolved.root, path);
      try {
        await mkdir(dirname(fullPath), { recursive: true });
        if (mode === 'write') {
          await writeFile(fullPath, content, 'utf-8');
        } else {
          await appendFile(fullPath, content + '\n', 'utf-8');
        }
        const store = await getStore(resolved.root);
        await store.index(path);
        return { output: `Stored to ${scopeLabel(resolved.scope)}:${path}`, success: true };
      } catch (err) {
        return { output: '', success: false, error: `memory_store failed: ${err}` };
      }
    },
  };

  return [memorySearchTool, memoryGetTool, memoryStoreTool];
}
