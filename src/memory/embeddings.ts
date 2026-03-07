/**
 * Embedding providers for vector search.
 *
 * Pluggable providers that generate embeddings for text chunks.
 * Used by VectorStore for semantic memory search.
 */

import type { EmbeddingProvider } from './vector.js';

/**
 * OpenAI-compatible embedding provider.
 * Works with OpenAI API, Azure OpenAI, and any compatible endpoint.
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  dimensions = 1536; // text-embedding-3-small default
  private apiKey: string;
  private model: string;
  private baseUrl: string;

  constructor(opts?: { apiKey?: string; model?: string; baseUrl?: string }) {
    this.apiKey = opts?.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    this.model = opts?.model ?? 'text-embedding-3-small';
    this.baseUrl = opts?.baseUrl ?? 'https://api.openai.com/v1';

    // Set dimensions based on model
    if (this.model === 'text-embedding-3-large') {
      this.dimensions = 3072;
    } else if (this.model === 'text-embedding-ada-002') {
      this.dimensions = 1536;
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!this.apiKey) {
      throw new Error('OpenAI API key required for embeddings. Set OPENAI_API_KEY.');
    }

    const response = await fetch(`${this.baseUrl}/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        input: texts,
        model: this.model,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`OpenAI embeddings failed (${response.status}): ${err}`);
    }

    const data = (await response.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
    };

    // Sort by index to ensure correct order
    return data.data
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  }
}

/**
 * Anthropic Voyage embedding provider.
 * Uses the Voyage AI API (recommended by Anthropic for embeddings).
 */
export class VoyageEmbeddingProvider implements EmbeddingProvider {
  dimensions = 1024; // voyage-3-lite default
  private apiKey: string;
  private model: string;

  constructor(opts?: { apiKey?: string; model?: string }) {
    this.apiKey = opts?.apiKey ?? process.env.VOYAGE_API_KEY ?? '';
    this.model = opts?.model ?? 'voyage-3-lite';

    if (this.model === 'voyage-3') {
      this.dimensions = 1024;
    }
  }

  async embed(texts: string[]): Promise<number[][]> {
    if (!this.apiKey) {
      throw new Error('Voyage API key required. Set VOYAGE_API_KEY.');
    }

    const response = await fetch('https://api.voyageai.com/v1/embeddings', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        input: texts,
        model: this.model,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      throw new Error(`Voyage embeddings failed (${response.status}): ${err}`);
    }

    const data = (await response.json()) as {
      data: Array<{ embedding: number[]; index: number }>;
    };

    return data.data
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding);
  }
}

/**
 * Create an embedding provider based on config.
 * Returns null if no provider can be configured (BM25-only fallback).
 */
export function createEmbeddingProvider(config?: {
  provider?: string;
  model?: string;
}): EmbeddingProvider | null {
  if (!config?.provider) {
    // Auto-detect from available API keys
    if (process.env.OPENAI_API_KEY) {
      return new OpenAIEmbeddingProvider();
    }
    if (process.env.VOYAGE_API_KEY) {
      return new VoyageEmbeddingProvider();
    }
    return null;
  }

  switch (config.provider) {
    case 'openai':
      return new OpenAIEmbeddingProvider({ model: config.model });
    case 'voyage':
      return new VoyageEmbeddingProvider({ model: config.model });
    default:
      return null;
  }
}
