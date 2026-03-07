/**
 * Vector search — embedding-based semantic search.
 */

import type { Snippet, SearchOpts } from './store.js';

export interface EmbeddingProvider {
  /** Generate embeddings for a list of texts. */
  embed(texts: string[]): Promise<number[][]>;
  /** Dimension of the embedding vectors. */
  dimensions: number;
}

interface VectorEntry {
  path: string;
  startLine: number;
  endLine: number;
  text: string;
  embedding: number[];
}

export class VectorStore {
  private entries: VectorEntry[] = [];
  private provider: EmbeddingProvider | null = null;

  constructor(provider?: EmbeddingProvider) {
    this.provider = provider ?? null;
  }

  /** Set the embedding provider. */
  setProvider(provider: EmbeddingProvider): void {
    this.provider = provider;
  }

  /** Index a text chunk with its location. */
  async index(path: string, startLine: number, endLine: number, text: string): Promise<void> {
    if (!this.provider) return;

    const [embedding] = await this.provider.embed([text]);
    this.entries.push({ path, startLine, endLine, text, embedding });
  }

  /** Search for similar text chunks. */
  async search(query: string, opts?: SearchOpts): Promise<Snippet[]> {
    if (!this.provider || this.entries.length === 0) return [];

    const [queryEmbedding] = await this.provider.embed([query]);
    const limit = opts?.limit ?? 5;
    const threshold = opts?.threshold ?? 0.0;

    // Cosine similarity search
    const scored = this.entries.map((entry) => ({
      entry,
      score: cosineSimilarity(queryEmbedding, entry.embedding),
    }));

    return scored
      .filter((s) => s.score >= threshold)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((s) => ({
        path: s.entry.path,
        range: { start: s.entry.startLine, end: s.entry.endLine },
        content: s.entry.text,
        score: s.score,
        source: 'vector' as const,
      }));
  }

  /** Clear all indexed entries. */
  clear(): void {
    this.entries = [];
  }
}

/** Compute cosine similarity between two vectors. */
function cosineSimilarity(a: number[], b: number[]): number {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  const denom = Math.sqrt(normA) * Math.sqrt(normB);
  return denom === 0 ? 0 : dot / denom;
}
