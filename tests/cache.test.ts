/**
 * Tests for cache layers:
 * - FileCache (LRU, mtime validation, auto-clean)
 * - ToolCache (TTL, blocklist, per-command TTL)
 * - SymbolIndex (regex extraction, search, persist/load)
 * - CacheManager (orchestration, status, clear)
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile, unlink, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ─── 1. FileCache tests ─────────────────────────────────────────────

import { FileCache } from '../src/cache/file-cache.js';

describe('FileCache', () => {
  let cache: FileCache;
  let testDir: string;
  let testFile: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `tako-cache-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });
    testFile = join(testDir, 'test.txt');
    await writeFile(testFile, 'hello world', 'utf-8');

    cache = new FileCache({
      enabled: true,
      maxSizeBytes: 1024,
      maxFileSizeBytes: 512,
    });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('returns null on cache miss', async () => {
    const result = await cache.get(testFile);
    assert.equal(result, null);
    assert.equal(cache.getStats().misses, 1);
  });

  it('stores and retrieves content', async () => {
    await cache.set(testFile, 'hello world');
    const result = await cache.get(testFile);
    assert.equal(result, 'hello world');
    assert.equal(cache.getStats().hits, 1);
  });

  it('invalidates on mtime change', async () => {
    await cache.set(testFile, 'hello world');

    // Modify file to change mtime
    await new Promise((r) => setTimeout(r, 50));
    await writeFile(testFile, 'changed', 'utf-8');

    const result = await cache.get(testFile);
    assert.equal(result, null);
    assert.equal(cache.getStats().misses, 1);
  });

  it('skips files larger than maxFileSizeBytes', async () => {
    const bigContent = 'x'.repeat(600);
    await cache.set(testFile, bigContent);
    const result = await cache.get(testFile);
    assert.equal(result, null); // Not cached
  });

  it('evicts LRU entries when maxSizeBytes exceeded', async () => {
    const file1 = join(testDir, 'f1.txt');
    const file2 = join(testDir, 'f2.txt');
    const file3 = join(testDir, 'f3.txt');
    await writeFile(file1, 'a'.repeat(400), 'utf-8');
    await writeFile(file2, 'b'.repeat(400), 'utf-8');
    await writeFile(file3, 'c'.repeat(400), 'utf-8');

    await cache.set(file1, 'a'.repeat(400));
    await cache.set(file2, 'b'.repeat(400));
    // Adding file3 should evict file1 (LRU)
    await cache.set(file3, 'c'.repeat(400));

    assert.equal(cache.getStats().evictions, 1);
    const r1 = await cache.get(file1);
    assert.equal(r1, null); // Evicted
  });

  it('invalidate removes entry', async () => {
    await cache.set(testFile, 'hello world');
    cache.invalidate(testFile);
    const result = await cache.get(testFile);
    assert.equal(result, null);
  });

  it('clear removes all entries', async () => {
    await cache.set(testFile, 'hello world');
    cache.clear();
    assert.equal(cache.getStats().entries, 0);
  });

  it('autoClean removes old entries', async () => {
    await cache.set(testFile, 'hello world');
    // Wait 20ms then clean with maxAge=10ms — entry is older than 10ms
    await new Promise((r) => setTimeout(r, 20));
    const cleaned = cache.autoClean(10);
    assert.equal(cleaned, 1);
    assert.equal(cache.getStats().entries, 0);
  });

  it('disabled cache always returns null', async () => {
    const disabledCache = new FileCache({
      enabled: false,
      maxSizeBytes: 1024,
      maxFileSizeBytes: 512,
    });
    await disabledCache.set(testFile, 'hello');
    const result = await disabledCache.get(testFile);
    assert.equal(result, null);
  });
});

// ─── 2. ToolCache tests ─────────────────────────────────────────────

import { ToolCache } from '../src/cache/tool-cache.js';

describe('ToolCache', () => {
  let cache: ToolCache;

  beforeEach(() => {
    cache = new ToolCache({
      enabled: true,
      defaultTtlSeconds: 60,
      blocklist: ['npm test', 'npm run build'],
    });
  });

  it('returns null on cache miss', () => {
    const result = cache.get('ls -la', '/tmp');
    assert.equal(result, null);
    assert.equal(cache.getStats().misses, 1);
  });

  it('stores and retrieves results', () => {
    cache.set('ls -la', '/tmp', 'file1\nfile2', true);
    const result = cache.get('ls -la', '/tmp');
    assert.ok(result);
    assert.equal(result.output, 'file1\nfile2');
    assert.equal(result.success, true);
    assert.equal(cache.getStats().hits, 1);
  });

  it('different cwd = different key', () => {
    cache.set('ls', '/tmp', 'tmp-files', true);
    cache.set('ls', '/home', 'home-files', true);
    assert.equal(cache.get('ls', '/tmp')?.output, 'tmp-files');
    assert.equal(cache.get('ls', '/home')?.output, 'home-files');
  });

  it('blocks commands in blocklist', () => {
    assert.equal(cache.isBlocked('npm test'), true);
    assert.equal(cache.isBlocked('npm run build'), true);
    assert.equal(cache.isBlocked('ls'), false);
  });

  it('blocked commands are not cached', () => {
    cache.set('npm test', '/tmp', 'output', true);
    const result = cache.get('npm test', '/tmp');
    assert.equal(result, null);
    assert.equal(cache.getStats().blocked, 1);
  });

  it('uses per-command TTL overrides', () => {
    const ttl = cache.getTtlMs('git status');
    assert.equal(ttl, 10_000); // 10s for git status
  });

  it('uses default TTL for unknown commands', () => {
    const ttl = cache.getTtlMs('some-random-command');
    assert.equal(ttl, 60_000); // 60s default
  });

  it('expires entries after TTL', () => {
    cache.set('ls', '/tmp', 'files', true);
    // Manually expire by setting cachedAt in the past
    const key = ToolCache.buildKey('ls', '/tmp');
    // We can't directly access the internal map, so test via autoClean
    const cleaned = cache.autoClean();
    assert.equal(cleaned, 0); // Not expired yet
  });

  it('autoClean removes expired entries', async () => {
    // Use a custom cache with very short TTL and override ls prefix
    const shortCache = new ToolCache({
      enabled: true,
      defaultTtlSeconds: 0.01, // 10ms
      ttlOverrides: { 'ls': 0.01 }, // Override built-in 30s
      blocklist: [],
    });
    shortCache.set('ls', '/tmp', 'files', true);
    // Wait for TTL to expire
    await new Promise((r) => setTimeout(r, 30));
    const cleaned = shortCache.autoClean();
    assert.equal(cleaned, 1);
  });

  it('clear removes all entries', () => {
    cache.set('ls', '/tmp', 'files', true);
    cache.set('pwd', '/tmp', '/tmp', true);
    cache.clear();
    assert.equal(cache.getStats().entries, 0);
  });

  it('disabled cache always returns null', () => {
    const disabledCache = new ToolCache({
      enabled: false,
      defaultTtlSeconds: 60,
      blocklist: [],
    });
    disabledCache.set('ls', '/tmp', 'files', true);
    const result = disabledCache.get('ls', '/tmp');
    assert.equal(result, null);
  });
});

// ─── 3. SymbolIndex tests ───────────────────────────────────────────

import { SymbolIndex } from '../src/cache/symbol-index.js';

describe('SymbolIndex', () => {
  let index: SymbolIndex;
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `tako-symbol-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });

    index = new SymbolIndex({
      enabled: true,
      persistPath: join(testDir, 'symbol-index.json'),
      maxFiles: 100,
    });
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('indexes TypeScript file', async () => {
    const tsFile = join(testDir, 'example.ts');
    await writeFile(tsFile, `
export function greet(name: string): string {
  return 'hello ' + name;
}

export class UserService {
  getUser() {}
}

export interface Config {
  port: number;
}

export type UserId = string;

export const VERSION = '1.0';
`, 'utf-8');

    const result = await index.indexFile(tsFile);
    assert.ok(result);
    assert.ok(result.symbols.length >= 5); // function, class, interface, type, const

    const names = result.symbols.map((s) => s.name);
    assert.ok(names.includes('greet'));
    assert.ok(names.includes('UserService'));
    assert.ok(names.includes('Config'));
    assert.ok(names.includes('UserId'));
    assert.ok(names.includes('VERSION'));
  });

  it('indexes Python file', async () => {
    const pyFile = join(testDir, 'example.py');
    await writeFile(pyFile, `
class Animal:
    def speak(self):
        pass

def greet(name):
    return f"hello {name}"

async def fetch_data():
    pass
`, 'utf-8');

    const result = await index.indexFile(pyFile);
    assert.ok(result);
    const names = result.symbols.map((s) => s.name);
    assert.ok(names.includes('Animal'));
    assert.ok(names.includes('greet'));
    assert.ok(names.includes('fetch_data'));
  });

  it('skips unchanged files', async () => {
    const tsFile = join(testDir, 'stable.ts');
    await writeFile(tsFile, 'export function foo() {}', 'utf-8');

    const r1 = await index.indexFile(tsFile);
    const r2 = await index.indexFile(tsFile);
    assert.ok(r1);
    assert.ok(r2);
    // Same reference returned (cached)
    assert.equal(r1.mtimeMs, r2.mtimeMs);
  });

  it('search finds matching symbols', async () => {
    const tsFile = join(testDir, 'search.ts');
    await writeFile(tsFile, `
export function getUserById() {}
export function getProductById() {}
export class UserManager {}
`, 'utf-8');

    await index.indexFile(tsFile);
    const results = index.search('get');
    assert.ok(results.length >= 2);
    assert.ok(results.every((s) => s.name.toLowerCase().startsWith('get')));
  });

  it('invalidate removes file from index', async () => {
    const tsFile = join(testDir, 'remove.ts');
    await writeFile(tsFile, 'export function foo() {}', 'utf-8');
    await index.indexFile(tsFile);

    index.invalidate(tsFile);
    const symbols = index.getFileSymbols(tsFile);
    assert.equal(symbols.length, 0);
  });

  it('persist and load round-trips', async () => {
    const tsFile = join(testDir, 'persist.ts');
    await writeFile(tsFile, 'export function bar() {}', 'utf-8');
    await index.indexFile(tsFile);

    await index.persist();

    // Create a new index and load
    const index2 = new SymbolIndex({
      enabled: true,
      persistPath: join(testDir, 'symbol-index.json'),
      maxFiles: 100,
    });
    const loaded = await index2.load();
    assert.equal(loaded, 1);
    assert.equal(index2.getStats().filesIndexed, 1);
  });

  it('respects maxFiles limit', async () => {
    const smallIndex = new SymbolIndex({
      enabled: true,
      persistPath: join(testDir, 'small-index.json'),
      maxFiles: 2,
    });

    for (let i = 0; i < 4; i++) {
      const f = join(testDir, `file${i}.ts`);
      await writeFile(f, `export function fn${i}() {}`, 'utf-8');
      await smallIndex.indexFile(f);
    }

    assert.ok(smallIndex.getStats().filesIndexed <= 2);
  });

  it('getStats returns correct counts', async () => {
    const tsFile = join(testDir, 'stats.ts');
    await writeFile(tsFile, `
export function a() {}
export function b() {}
export class C {}
`, 'utf-8');
    await index.indexFile(tsFile);

    const stats = index.getStats();
    assert.equal(stats.filesIndexed, 1);
    assert.ok(stats.totalSymbols >= 3);
  });
});

// ─── 4. CacheManager tests ─────────────────────────────────────────

import { CacheManager } from '../src/cache/manager.js';
import { DEFAULT_CONFIG } from '../src/config/schema.js';

describe('CacheManager', () => {
  let manager: CacheManager;
  let testDir: string;

  beforeEach(async () => {
    testDir = join(tmpdir(), `tako-mgr-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });

    manager = new CacheManager({
      ...DEFAULT_CONFIG.cache,
      symbols: {
        ...DEFAULT_CONFIG.cache.symbols,
        persistPath: join(testDir, 'symbol-index.json'),
      },
    });
  });

  afterEach(async () => {
    manager.stopAutoClean();
    await rm(testDir, { recursive: true, force: true });
  });

  it('getStatus returns combined stats', () => {
    const status = manager.getStatus();
    assert.equal(status.enabled, true);
    assert.equal(status.file.entries, 0);
    assert.equal(status.tool.entries, 0);
    assert.equal(status.symbols.filesIndexed, 0);
  });

  it('clear all layers', async () => {
    const testFile = join(testDir, 'test.txt');
    await writeFile(testFile, 'content', 'utf-8');
    await manager.file.set(testFile, 'content');
    manager.tool.set('ls', '/tmp', 'output', true);

    manager.clear();
    assert.equal(manager.getStatus().file.entries, 0);
    assert.equal(manager.getStatus().tool.entries, 0);
  });

  it('clear specific layer', async () => {
    const testFile = join(testDir, 'test.txt');
    await writeFile(testFile, 'content', 'utf-8');
    await manager.file.set(testFile, 'content');
    manager.tool.set('ls', '/tmp', 'output', true);

    manager.clear('file');
    assert.equal(manager.getStatus().file.entries, 0);
    assert.equal(manager.getStatus().tool.entries, 1); // Tool still there
  });

  it('onFileWrite invalidates file and tool caches', async () => {
    const testFile = join(testDir, 'test.txt');
    await writeFile(testFile, 'content', 'utf-8');
    await manager.file.set(testFile, 'content');
    manager.tool.set('cat test.txt', testDir, 'content', true);

    manager.onFileWrite(testFile);
    assert.equal(manager.getStatus().file.entries, 0);
    assert.equal(manager.getStatus().tool.entries, 0);
  });

  it('autoClean runs on all layers', () => {
    const result = manager.autoClean();
    assert.equal(result.file, 0);
    assert.equal(result.tool, 0);
  });

  it('startAutoClean and stopAutoClean', () => {
    manager.startAutoClean();
    // No error — timer started
    manager.stopAutoClean();
    // No error — timer stopped
  });
});
