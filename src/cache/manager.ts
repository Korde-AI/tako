/**
 * Cache Manager — orchestrates all cache layers.
 *
 * Provides a unified interface for:
 * - Auto-clean intervals across all layers
 * - Combined status/stats
 * - Per-layer or global clear
 * - File write invalidation hooks
 */

import type { CacheConfig } from '../config/schema.js';
import { FileCache, type FileCacheStats } from './file-cache.js';
import { ToolCache, type ToolCacheStats } from './tool-cache.js';
import { SymbolIndex, type SymbolIndexStats } from './symbol-index.js';

// ─── Types ──────────────────────────────────────────────────────────

export type CacheLayer = 'file' | 'tool' | 'symbols';

export interface CacheStatus {
  enabled: boolean;
  file: FileCacheStats;
  tool: ToolCacheStats;
  symbols: SymbolIndexStats;
}

// ─── Cache Manager ──────────────────────────────────────────────────

export class CacheManager {
  readonly file: FileCache;
  readonly tool: ToolCache;
  readonly symbols: SymbolIndex;

  private config: CacheConfig;
  private cleanTimer: ReturnType<typeof setInterval> | null = null;

  constructor(config: CacheConfig) {
    this.config = config;
    this.file = new FileCache(config.file);
    this.tool = new ToolCache(config.tool);
    this.symbols = new SymbolIndex(config.symbols);
  }

  /**
   * Start the auto-clean interval.
   */
  startAutoClean(): void {
    if (!this.config.enabled) return;
    if (this.cleanTimer) return;

    this.cleanTimer = setInterval(() => {
      this.autoClean();
    }, this.config.autoCleanIntervalMs);

    // Don't block process exit
    if (this.cleanTimer.unref) {
      this.cleanTimer.unref();
    }
  }

  /**
   * Stop the auto-clean interval.
   */
  stopAutoClean(): void {
    if (this.cleanTimer) {
      clearInterval(this.cleanTimer);
      this.cleanTimer = null;
    }
  }

  /**
   * Run auto-clean on all layers.
   */
  autoClean(): { file: number; tool: number } {
    const fileCleaned = this.file.autoClean();
    const toolCleaned = this.tool.autoClean();

    if (fileCleaned > 0 || toolCleaned > 0) {
      console.log(`[cache] Auto-clean: ${fileCleaned} file entries, ${toolCleaned} tool entries evicted`);
    }

    return { file: fileCleaned, tool: toolCleaned };
  }

  /**
   * Clear a specific layer or all layers.
   */
  clear(layer?: CacheLayer): void {
    if (!layer || layer === 'file') this.file.clear();
    if (!layer || layer === 'tool') this.tool.clear();
    if (!layer || layer === 'symbols') this.symbols.clear();
  }

  /**
   * Get combined status from all layers.
   */
  getStatus(): CacheStatus {
    return {
      enabled: this.config.enabled,
      file: this.file.getStats(),
      tool: this.tool.getStats(),
      symbols: this.symbols.getStats(),
    };
  }

  /**
   * Notify all layers that a file was written/modified.
   * Invalidates file cache entry and marks tool cache as potentially stale.
   */
  onFileWrite(filePath: string): void {
    this.file.invalidate(filePath);
    this.symbols.invalidate(filePath);
    // Tool cache: invalidate all since file writes can affect any command output
    // (e.g. git status changes after file write)
    this.tool.clear();
  }

  /**
   * Persist symbol index to disk.
   */
  async persistSymbols(): Promise<void> {
    await this.symbols.persist();
  }

  /**
   * Load symbol index from disk.
   */
  async loadSymbols(): Promise<number> {
    return this.symbols.load();
  }

  /**
   * Dispose: stop timers, persist symbols.
   */
  async dispose(): Promise<void> {
    this.stopAutoClean();
    if (this.config.symbols.enabled) {
      await this.symbols.persist();
    }
  }
}
