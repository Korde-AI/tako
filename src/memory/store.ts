/**
 * MemoryStore — persistence + recall trait.
 *
 * Markdown files are the source of truth. The store provides semantic
 * search (vector + BM25 hybrid), direct file reads, and indexing.
 *
 * Memory hierarchy:
 * - `MEMORY.md` — curated long-term memory (always in context)
 * - `memory/YYYY-MM-DD.md` — daily append-only logs (accessed on-demand)
 * - Workspace files — SOUL.md, IDENTITY.md, etc. (indexed for search)
 *
 * @example
 * ```typescript
 * const store = new HybridMemoryStore('/workspace');
 * await store.initialize();
 * const results = await store.search('TypeScript patterns', { limit: 5 });
 * const content = await store.get('MEMORY.md');
 * ```
 */

// ─── Types ──────────────────────────────────────────────────────────

/** A search result snippet with content, location, and relevance score. */
export interface Snippet {
  /** File path relative to workspace root */
  path: string;
  /** Line range this snippet covers */
  range: LineRange;
  /** The text content of the snippet */
  content: string;
  /** Relevance score (higher = more relevant, scale depends on source) */
  score: number;
  /** Which search method produced this result */
  source?: 'vector' | 'bm25' | 'hybrid';
}

/** Options for memory search. */
export interface SearchOpts {
  /** Maximum number of results to return (default: 10) */
  limit?: number;
  /** Minimum relevance threshold — results below this are excluded */
  threshold?: number;
  /** Restrict search to files matching these paths or glob patterns */
  paths?: string[];
  /** Include only files modified after this date */
  since?: Date;
}

/** A 1-based inclusive line range within a file. */
export interface LineRange {
  /** 1-based start line */
  start: number;
  /** 1-based end line (inclusive) */
  end: number;
}

// ─── MemoryStore interface ──────────────────────────────────────────

/**
 * MemoryStore — the persistence and recall trait.
 *
 * Implementations provide hybrid search (BM25 keyword + vector semantic)
 * over the agent's markdown-based memory. The agent loop uses this for
 * memory_search, memory_get, and memory_store tools.
 *
 * Built-in implementation:
 * - {@link HybridMemoryStore} — BM25 + vector search with RRF fusion
 */
export interface MemoryStore {
  /**
   * Search across indexed memory files using hybrid retrieval.
   * Returns snippets ranked by relevance (BM25 + vector + temporal decay).
   *
   * @param query - Natural language search query
   * @param opts - Search options (limit, threshold, path filters)
   * @returns Ranked array of matching snippets
   */
  search(query: string, opts?: SearchOpts): Promise<Snippet[]>;

  /**
   * Read a specific file or line range from the workspace.
   * Returns empty string for missing files (graceful degradation).
   *
   * @param path - File path relative to workspace root
   * @param range - Optional line range to extract
   * @returns File content (or line range subset)
   */
  get(path: string, range?: LineRange): Promise<string>;

  /**
   * Index (or re-index) a file for search.
   * Updates both BM25 and vector indexes.
   *
   * @param path - File path relative to workspace root
   */
  index(path: string): Promise<void>;
}
