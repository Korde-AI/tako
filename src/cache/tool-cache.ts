/**
 * Tool Execution Cache — caches command results keyed by SHA256(command+args+cwd).
 *
 * Features:
 * - Per-command TTL overrides (git status 10s, ls 30s, grep 15s, etc.)
 * - Blocklist for side-effect commands (test, build, make, etc.)
 * - Auto-invalidation on file writes in the same cwd
 */

import { createHash } from 'node:crypto';
import type { ToolCacheConfig } from '../config/schema.js';

// ─── Types ──────────────────────────────────────────────────────────

export interface ToolCacheEntry {
  output: string;
  success: boolean;
  error?: string;
  cachedAt: number;
  ttlMs: number;
  commandKey: string;
}

export interface ToolCacheStats {
  entries: number;
  hits: number;
  misses: number;
  blocked: number;
  evictions: number;
  hitRate: number;
}

// ─── Default TTL overrides by command prefix ────────────────────────

const DEFAULT_TTL_OVERRIDES: Record<string, number> = {
  'git status': 10,
  'git log': 15,
  'git diff': 10,
  'git branch': 15,
  'ls': 30,
  'find': 15,
  'fd': 15,
  'grep': 15,
  'rg': 15,
  'wc': 30,
  'cat': 60,
  'head': 60,
  'tail': 60,
  'file': 60,
  'which': 120,
  'type': 120,
};

// ─── Tool Execution Cache ───────────────────────────────────────────

export class ToolCache {
  private config: ToolCacheConfig;
  private cache = new Map<string, ToolCacheEntry>();
  private hits = 0;
  private misses = 0;
  private blocked = 0;
  private evictions = 0;

  constructor(config: ToolCacheConfig) {
    this.config = config;
  }

  /**
   * Build a cache key from command, args, and cwd.
   */
  static buildKey(command: string, cwd: string): string {
    return createHash('sha256')
      .update(`${command}\0${cwd}`)
      .digest('hex');
  }

  /**
   * Check if a command is blocklisted (should never be cached).
   */
  isBlocked(command: string): boolean {
    const trimmed = command.trim();
    return this.config.blocklist.some((pattern) =>
      trimmed.startsWith(pattern) || trimmed.includes(` && ${pattern}`) || trimmed.includes(`; ${pattern}`),
    );
  }

  /**
   * Get the TTL for a command in milliseconds.
   */
  getTtlMs(command: string): number {
    const trimmed = command.trim();
    const overrides = { ...DEFAULT_TTL_OVERRIDES, ...this.config.ttlOverrides };

    // Match longest prefix first
    let bestMatch = '';
    let bestTtl = this.config.defaultTtlSeconds;

    for (const [prefix, ttlSeconds] of Object.entries(overrides)) {
      if (trimmed.startsWith(prefix) && prefix.length > bestMatch.length) {
        bestMatch = prefix;
        bestTtl = ttlSeconds;
      }
    }

    return bestTtl * 1000;
  }

  /**
   * Get a cached result if valid, or null if stale/missing/blocked.
   */
  get(command: string, cwd: string): ToolCacheEntry | null {
    if (!this.config.enabled) return null;

    if (this.isBlocked(command)) {
      this.blocked++;
      return null;
    }

    const key = ToolCache.buildKey(command, cwd);
    const entry = this.cache.get(key);

    if (!entry) {
      this.misses++;
      return null;
    }

    // Check TTL
    if (Date.now() - entry.cachedAt > entry.ttlMs) {
      this.cache.delete(key);
      this.misses++;
      return null;
    }

    this.hits++;
    return entry;
  }

  /**
   * Store a command result in cache.
   */
  set(command: string, cwd: string, output: string, success: boolean, error?: string): void {
    if (!this.config.enabled) return;
    if (this.isBlocked(command)) return;

    const key = ToolCache.buildKey(command, cwd);
    const ttlMs = this.getTtlMs(command);

    this.cache.set(key, {
      output,
      success,
      error,
      cachedAt: Date.now(),
      ttlMs,
      commandKey: command.slice(0, 80),
    });
  }

  /**
   * Invalidate all cached commands for a given cwd (e.g. after file write).
   */
  invalidateCwd(cwd: string): void {
    // We can't reconstruct keys from cwd alone, so scan all entries
    for (const [key, entry] of this.cache) {
      // commandKey is the truncated command; we hash with cwd
      // Since we can't reverse the hash, mark all entries as expired by setting cachedAt to 0
      // Actually, let's just clear all — simpler and correct since writes affect the directory
    }
    // Clear all entries — writes can affect any command's output
    this.cache.clear();
  }

  /**
   * Clear the entire cache.
   */
  clear(): void {
    this.cache.clear();
  }

  /**
   * Run auto-clean: remove expired entries.
   */
  autoClean(): number {
    const now = Date.now();
    let cleaned = 0;
    for (const [key, entry] of this.cache) {
      if (now - entry.cachedAt > entry.ttlMs) {
        this.cache.delete(key);
        cleaned++;
        this.evictions++;
      }
    }
    return cleaned;
  }

  /**
   * Get cache statistics.
   */
  getStats(): ToolCacheStats {
    const total = this.hits + this.misses;
    return {
      entries: this.cache.size,
      hits: this.hits,
      misses: this.misses,
      blocked: this.blocked,
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
    this.blocked = 0;
    this.evictions = 0;
  }
}
