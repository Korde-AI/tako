/**
 * Hybrid search — fuses BM25 (keyword) + vector (semantic) results.
 *
 * Falls back gracefully: if no embedding provider is configured,
 * search uses BM25 only. If workspace files are missing, returns
 * empty results instead of throwing.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MemoryStore, Snippet, SearchOpts, LineRange } from './store.js';
import { MarkdownIndexer } from './markdown.js';
import { VectorStore, type EmbeddingProvider } from './vector.js';

/** Target chunk size in characters (~100 tokens). */
const CHUNK_TARGET_CHARS = 400;
/** Overlap between chunks in characters (~20 tokens). */
const CHUNK_OVERLAP_CHARS = 80;

export class HybridMemoryStore implements MemoryStore {
  private workspacePath: string;
  private markdownIndexer: MarkdownIndexer;
  private vectorStore: VectorStore;
  private initialized = false;

  constructor(workspacePath: string, embeddingProvider?: EmbeddingProvider) {
    this.workspacePath = workspacePath;
    this.markdownIndexer = new MarkdownIndexer(workspacePath);
    this.vectorStore = new VectorStore(embeddingProvider);
  }

  /** Set (or replace) the embedding provider. */
  setEmbeddingProvider(provider: EmbeddingProvider): void {
    this.vectorStore.setProvider(provider);
  }

  /**
   * Initialize the memory store — index all workspace .md files.
   * Safe to call multiple times (no-ops after first init).
   */
  async initialize(): Promise<void> {
    if (this.initialized) return;
    try {
      await this.markdownIndexer.indexAll();
      // Index chunks into vector store for files already in the markdown index
      for (const [path, entry] of this.markdownIndexer.getIndex()) {
        await this.indexChunks(path, entry.content);
      }
      this.initialized = true;
    } catch {
      // Workspace may not exist yet — that's okay
      this.initialized = true;
    }
  }

  async search(query: string, opts?: SearchOpts): Promise<Snippet[]> {
    await this.initialize();
    const limit = opts?.limit ?? 5;

    // Run both searches in parallel
    const [bm25Results, vectorResults] = await Promise.all([
      Promise.resolve(this.markdownIndexer.search(query, limit * 2)),
      this.vectorStore.search(query, { ...opts, limit: limit * 2 }).catch(() => []),
    ]);

    // If only BM25 results, return them directly
    if (vectorResults.length === 0) {
      return bm25Results.slice(0, limit);
    }

    // Reciprocal Rank Fusion (RRF) to merge results
    const k = 60; // RRF constant
    const scores = new Map<string, { snippet: Snippet; score: number }>();

    for (let i = 0; i < bm25Results.length; i++) {
      const r = bm25Results[i];
      const key = `${r.path}:${r.range.start}`;
      const existing = scores.get(key);
      const rrfScore = 1 / (k + i + 1);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scores.set(key, { snippet: { ...r, source: 'hybrid' }, score: rrfScore });
      }
    }

    for (let i = 0; i < vectorResults.length; i++) {
      const r = vectorResults[i];
      const key = `${r.path}:${r.range.start}`;
      const existing = scores.get(key);
      const rrfScore = 1 / (k + i + 1);
      if (existing) {
        existing.score += rrfScore;
      } else {
        scores.set(key, { snippet: { ...r, source: 'hybrid' }, score: rrfScore });
      }
    }

    return Array.from(scores.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => ({ ...s.snippet, score: s.score }));
  }

  /** Graceful get — returns empty string for missing files instead of throwing. */
  async get(path: string, range?: LineRange): Promise<string> {
    const fullPath = join(this.workspacePath, path);
    try {
      const content = await readFile(fullPath, 'utf-8');
      if (!range) return content;
      const lines = content.split('\n');
      return lines.slice(range.start - 1, range.end).join('\n');
    } catch {
      return '';
    }
  }

  async index(path: string): Promise<void> {
    await this.markdownIndexer.indexFile(path);

    const entry = this.markdownIndexer.getIndex().get(path);
    if (entry) {
      await this.indexChunks(path, entry.content);
    }
  }

  /** Full reindex of the workspace. */
  async reindexAll(): Promise<void> {
    await this.markdownIndexer.indexAll();
    this.vectorStore.clear();
    for (const [path, entry] of this.markdownIndexer.getIndex()) {
      await this.indexChunks(path, entry.content);
    }
  }

  /**
   * Chunk text with overlap and index into the vector store.
   * Uses sliding window approach for better context preservation.
   */
  private async indexChunks(path: string, content: string): Promise<void> {
    const lines = content.split('\n');

    // For short files, index as a single chunk
    if (content.length <= CHUNK_TARGET_CHARS * 1.5) {
      await this.vectorStore.index(path, 1, lines.length, content);
      return;
    }

    // Sliding window chunking with overlap
    let charOffset = 0;
    let lineOffset = 1;

    while (charOffset < content.length) {
      const chunkEnd = Math.min(charOffset + CHUNK_TARGET_CHARS, content.length);
      let chunk = content.slice(charOffset, chunkEnd);

      // Try to break at a paragraph boundary
      const lastParagraph = chunk.lastIndexOf('\n\n');
      if (lastParagraph > CHUNK_TARGET_CHARS * 0.3) {
        chunk = chunk.slice(0, lastParagraph);
      }

      const chunkLines = chunk.split('\n').length;
      await this.vectorStore.index(path, lineOffset, lineOffset + chunkLines - 1, chunk);

      // Advance with overlap
      const advance = Math.max(chunk.length - CHUNK_OVERLAP_CHARS, CHUNK_OVERLAP_CHARS);
      charOffset += advance;

      // Recalculate line offset
      const advancedText = content.slice(0, charOffset);
      lineOffset = advancedText.split('\n').length;
    }
  }
}
