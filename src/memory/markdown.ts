/**
 * Markdown file indexer — reads and indexes .md files for BM25 search.
 *
 * Implements proper BM25 scoring with:
 * - TF-IDF weighting (not just TF)
 * - Document length normalization
 * - Temporal decay for dated files (daily logs get recency boost)
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { Snippet, LineRange } from './store.js';

export interface IndexEntry {
  path: string;
  content: string;
  lines: string[];
  modifiedAt: Date;
  /** Word count for BM25 length normalization */
  wordCount: number;
}

/** BM25 tuning parameters */
const BM25_K1 = 1.2; // Term frequency saturation
const BM25_B = 0.75; // Length normalization factor

/** Temporal decay half-life in days */
const DECAY_HALF_LIFE_DAYS = 30;

/** Files that never decay (evergreen) */
const EVERGREEN_PATTERNS = ['MEMORY.md', 'SOUL.md', 'IDENTITY.md', 'AGENTS.md', 'TOOLS.md', 'USER.md'];

export class MarkdownIndexer {
  private workspacePath: string;
  private index = new Map<string, IndexEntry>();
  /** Document frequency: how many documents contain each term */
  private docFreq = new Map<string, number>();
  /** Average document length (in words) */
  private avgDocLength = 0;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
  }

  /** Index a single file and rebuild IDF stats. */
  async indexFile(relativePath: string): Promise<void> {
    const fullPath = join(this.workspacePath, relativePath);
    try {
      const content = await readFile(fullPath, 'utf-8');
      const fileStat = await stat(fullPath);
      const words = tokenize(content);
      this.index.set(relativePath, {
        path: relativePath,
        content,
        lines: content.split('\n'),
        modifiedAt: fileStat.mtime,
        wordCount: words.length,
      });
      // Rebuild IDF stats to include the new/updated file
      this.rebuildStats();
    } catch {
      // File not found or unreadable — skip
    }
  }

  /** Scan workspace and index all .md files, then rebuild IDF stats. */
  async indexAll(): Promise<void> {
    await this.scanDir('.');
    this.rebuildStats();
  }

  /** Rebuild document frequency and average length stats after indexing. */
  private rebuildStats(): void {
    this.docFreq.clear();
    let totalWords = 0;

    for (const [, entry] of this.index) {
      totalWords += entry.wordCount;
      // Count unique terms per document
      const seen = new Set<string>();
      for (const word of tokenize(entry.content)) {
        if (!seen.has(word)) {
          seen.add(word);
          this.docFreq.set(word, (this.docFreq.get(word) ?? 0) + 1);
        }
      }
    }

    this.avgDocLength = this.index.size > 0 ? totalWords / this.index.size : 1;
  }

  private async scanDir(dir: string): Promise<void> {
    const fullDir = join(this.workspacePath, dir);
    try {
      const entries = await readdir(fullDir, { withFileTypes: true });
      for (const entry of entries) {
        const relPath = join(dir, entry.name);
        if (entry.isDirectory() && !entry.name.startsWith('.')) {
          await this.scanDir(relPath);
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          await this.indexFile(relPath);
        }
      }
    } catch {
      // Directory not found — skip
    }
  }

  /** Get a snippet from a file. */
  getSnippet(path: string, range: LineRange): Snippet | null {
    const entry = this.index.get(path);
    if (!entry) return null;
    const lines = entry.lines.slice(range.start - 1, range.end);
    return {
      path,
      range,
      content: lines.join('\n'),
      score: 1.0,
      source: 'bm25',
    };
  }

  /**
   * BM25 search with IDF weighting and temporal decay.
   * Returns scored snippets sorted by relevance.
   */
  search(query: string, limit: number = 5): Snippet[] {
    const terms = tokenize(query);
    if (terms.length === 0) return [];

    const N = this.index.size;
    const results: Snippet[] = [];
    const now = Date.now();

    for (const [path, entry] of this.index) {
      const docWords = tokenize(entry.content);
      const docLength = docWords.length;

      // Count term frequencies in this document
      const tf = new Map<string, number>();
      for (const word of docWords) {
        tf.set(word, (tf.get(word) ?? 0) + 1);
      }

      // BM25 score
      let score = 0;
      for (const term of terms) {
        const termFreq = tf.get(term) ?? 0;
        if (termFreq === 0) continue;

        // IDF: log((N - df + 0.5) / (df + 0.5) + 1)
        const df = this.docFreq.get(term) ?? 0;
        const idf = Math.log((N - df + 0.5) / (df + 0.5) + 1);

        // BM25 TF component with length normalization
        const tfNorm = (termFreq * (BM25_K1 + 1)) /
          (termFreq + BM25_K1 * (1 - BM25_B + BM25_B * (docLength / this.avgDocLength)));

        score += idf * tfNorm;
      }

      if (score <= 0) continue;

      // Apply temporal decay for dated files (daily logs)
      score *= temporalDecay(path, entry.modifiedAt, now);

      // Find the best matching snippet region
      const snippet = this.findBestSnippet(entry, terms);

      results.push({
        path,
        range: snippet.range,
        content: snippet.content,
        score,
        source: 'bm25',
      });
    }

    return results.sort((a, b) => b.score - a.score).slice(0, limit);
  }

  /**
   * Find the region of the document with the highest term density.
   * Returns a ~500 char snippet centered on the best matching area.
   */
  private findBestSnippet(entry: IndexEntry, terms: string[]): { range: LineRange; content: string } {
    const lines = entry.lines;
    if (lines.length <= 15) {
      return {
        range: { start: 1, end: lines.length },
        content: entry.content.slice(0, 700),
      };
    }

    // Score each line by term hits
    let bestStart = 0;
    let bestScore = 0;
    const windowSize = Math.min(10, lines.length);

    for (let i = 0; i <= lines.length - windowSize; i++) {
      let windowScore = 0;
      for (let j = i; j < i + windowSize; j++) {
        const lineWords = tokenize(lines[j]);
        for (const term of terms) {
          if (lineWords.includes(term)) windowScore++;
        }
      }
      if (windowScore > bestScore) {
        bestScore = windowScore;
        bestStart = i;
      }
    }

    const snippetLines = lines.slice(bestStart, bestStart + windowSize);
    return {
      range: { start: bestStart + 1, end: bestStart + windowSize },
      content: snippetLines.join('\n').slice(0, 700),
    };
  }

  /** Get all indexed entries. */
  getIndex(): Map<string, IndexEntry> {
    return this.index;
  }
}

/** Tokenize text into lowercase words. */
function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
}

/**
 * Compute temporal decay multiplier for a file.
 * Evergreen files (MEMORY.md, SOUL.md, etc.) never decay.
 * Dated daily files (YYYY-MM-DD.md) decay exponentially.
 */
function temporalDecay(path: string, modifiedAt: Date, now: number): number {
  // Check if file is evergreen
  for (const pattern of EVERGREEN_PATTERNS) {
    if (path.endsWith(pattern)) return 1.0;
  }

  // Try to extract date from filename (memory/YYYY-MM-DD.md)
  const dateMatch = path.match(/(\d{4}-\d{2}-\d{2})\.md$/);
  let fileDate: Date;
  if (dateMatch) {
    fileDate = new Date(dateMatch[1]);
    if (isNaN(fileDate.getTime())) fileDate = modifiedAt;
  } else {
    // Non-dated file — use modification time with gentle decay
    fileDate = modifiedAt;
  }

  const ageInDays = (now - fileDate.getTime()) / (1000 * 60 * 60 * 24);
  if (ageInDays <= 0) return 1.0;

  // Exponential decay: score * e^(-lambda * age)
  // lambda = ln(2) / halfLife
  const lambda = Math.LN2 / DECAY_HALF_LIFE_DAYS;
  return Math.exp(-lambda * ageInDays);
}
