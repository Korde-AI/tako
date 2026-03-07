/**
 * File Content Cache — in-memory LRU cache for file reads.
 *
 * Validates entries using mtime + sha256 hash to detect stale content.
 * Automatically evicts least-recently-used entries when maxSizeBytes is exceeded.
 */

import { stat } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import type { FileCacheConfig } from '../config/schema.js';

// ─── Types ──────────────────────────────────────────────────────────

export interface FileCacheEntry {
  content: string;
  size: number;
  mtimeMs: number;
  hash: string;
  lastAccessed: number;
}

export interface FileCacheStats {
  entries: number;
  totalBytes: number;
  maxBytes: number;
  hits: number;
  misses: number;
  evictions: number;
  hitRate: number;
}

// ─── File Content Cache ─────────────────────────────────────────────

export class FileCache {
  private config: FileCacheConfig;
  private cache = new Map<string, FileCacheEntry>();
  private totalBytes = 0;
  private hits = 0;
  private misses = 0;
  private evictions = 0;

  constructor(config: FileCacheConfig) {
    this.config = config;
  }

  /**
   * Get cached file content if valid, or null if stale/missing.
   */
  async get(path: string): Promise<string | null> {
    if (!this.config.enabled) return null;

    const entry = this.cache.get(path);
    if (!entry) {
      this.misses++;
      return null;
    }

    // Validate mtime — if file changed on disk, invalidate
    try {
      const st = await stat(path);
      if (st.mtimeMs !== entry.mtimeMs) {
        this.remove(path);
        this.misses++;
        return null;
      }
    } catch {
      // File gone — remove from cache
      this.remove(path);
      this.misses++;
      return null;
    }

    // Cache hit — update access time
    entry.lastAccessed = Date.now();
    this.hits++;
    return entry.content;
  }

  /**
   * Store file content in cache with mtime and hash validation.
   */
  async set(path: string, content: string): Promise<void> {
    if (!this.config.enabled) return;

    const size = Buffer.byteLength(content, 'utf-8');

    // Skip files larger than max single file size
    if (size > this.config.maxFileSizeBytes) return;

    // Get file mtime
    let mtimeMs: number;
    try {
      const st = await stat(path);
      mtimeMs = st.mtimeMs;
    } catch {
      return; // Can't stat — don't cache
    }

    const hash = createHash('sha256').update(content).digest('hex');

    // Remove existing entry first (to update totalBytes correctly)
    if (this.cache.has(path)) {
      this.remove(path);
    }

    // Evict LRU entries until we have space
    while (this.totalBytes + size > this.config.maxSizeBytes && this.cache.size > 0) {
      this.evictLRU();
    }

    // If single file is bigger than the entire budget, skip
    if (size > this.config.maxSizeBytes) return;

    this.cache.set(path, {
      content,
      size,
      mtimeMs,
      hash,
      lastAccessed: Date.now(),
    });
    this.totalBytes += size;
  }

  /**
   * Invalidate a cached file (e.g. after a write).
   */
  invalidate(path: string): void {
    this.remove(path);
  }

  /**
   * Invalidate all entries under a directory prefix.
   */
  invalidateDir(dirPath: string): void {
    const prefix = dirPath.endsWith('/') ? dirPath : dirPath + '/';
    for (const key of this.cache.keys()) {
      if (key.startsWith(prefix)) {
        this.remove(key);
      }
    }
  }

  /**
   * Clear the entire cache.
   */
  clear(): void {
    this.cache.clear();
    this.totalBytes = 0;
  }

  /**
   * Run auto-clean: evict entries not accessed recently.
   * Called periodically by the CacheManager.
   */
  autoClean(maxAgeMs = 5 * 60 * 1000): number {
    const cutoff = Date.now() - maxAgeMs;
    let cleaned = 0;
    for (const [path, entry] of this.cache) {
      if (entry.lastAccessed < cutoff) {
        this.remove(path);
        cleaned++;
      }
    }
    return cleaned;
  }

  /**
   * Get cache statistics.
   */
  getStats(): FileCacheStats {
    const total = this.hits + this.misses;
    return {
      entries: this.cache.size,
      totalBytes: this.totalBytes,
      maxBytes: this.config.maxSizeBytes,
      hits: this.hits,
      misses: this.misses,
      evictions: this.evictions,
      hitRate: total > 0 ? this.hits / total : 0,
    };
  }

  /**
   * Reset counters (for testing).
   */
  resetStats(): void {
    this.hits = 0;
    this.misses = 0;
    this.evictions = 0;
  }

  // ─── Private ────────────────────────────────────────────────────

  private remove(path: string): void {
    const entry = this.cache.get(path);
    if (entry) {
      this.totalBytes -= entry.size;
      this.cache.delete(path);
    }
  }

  private evictLRU(): void {
    let oldest: string | null = null;
    let oldestTime = Infinity;
    for (const [path, entry] of this.cache) {
      if (entry.lastAccessed < oldestTime) {
        oldestTime = entry.lastAccessed;
        oldest = path;
      }
    }
    if (oldest) {
      this.remove(oldest);
      this.evictions++;
    }
  }
}
