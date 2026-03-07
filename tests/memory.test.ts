/**
 * Tests for the memory subsystem:
 * - MarkdownIndexer
 * - VectorStore
 * - HybridMemoryStore
 * - Workspace bootstrap
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { MarkdownIndexer } from '../src/memory/markdown.js';
import { VectorStore, type EmbeddingProvider } from '../src/memory/vector.js';
import { HybridMemoryStore } from '../src/memory/hybrid.js';
import { bootstrapWorkspace, ensureDailyMemory, dailyMemoryPath } from '../src/core/bootstrap.js';

// ─── MarkdownIndexer ─────────────────────────────────────────────────

describe('MarkdownIndexer', () => {
  let tmpDir: string;
  let indexer: MarkdownIndexer;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'tako-test-'));
    await mkdir(join(tmpDir, 'memory'), { recursive: true });
    await writeFile(join(tmpDir, 'MEMORY.md'), '# Memory\n\nHello world\n\nTest content here.\n');
    await writeFile(join(tmpDir, 'memory', 'notes.md'), '# Notes\n\nSome notes about TypeScript.\n\nMore notes about Rust.\n');
    indexer = new MarkdownIndexer(tmpDir);
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('indexes a single file', async () => {
    await indexer.indexFile('MEMORY.md');
    const idx = indexer.getIndex();
    assert.ok(idx.has('MEMORY.md'));
    assert.ok(idx.get('MEMORY.md')!.content.includes('Hello world'));
  });

  it('indexes all markdown files', async () => {
    await indexer.indexAll();
    const idx = indexer.getIndex();
    assert.ok(idx.has('MEMORY.md'));
    assert.ok(idx.has('memory/notes.md'));
  });

  it('searches with BM25', async () => {
    await indexer.indexAll();
    const results = indexer.search('TypeScript');
    assert.ok(results.length > 0);
    assert.equal(results[0].path, 'memory/notes.md');
  });

  it('returns empty for no match', async () => {
    await indexer.indexAll();
    const results = indexer.search('xyznonexistent123');
    assert.equal(results.length, 0);
  });

  it('respects limit', async () => {
    await indexer.indexAll();
    const results = indexer.search('notes', 1);
    assert.ok(results.length <= 1);
  });

  it('gets a snippet by range', async () => {
    await indexer.indexAll();
    const snippet = indexer.getSnippet('MEMORY.md', { start: 1, end: 1 });
    assert.ok(snippet);
    assert.ok(snippet.content.includes('# Memory'));
  });
});

// ─── VectorStore ─────────────────────────────────────────────────────

describe('VectorStore', () => {
  /**
   * Fake embedding provider using word-overlap vectors.
   * Each dimension corresponds to a word; overlap creates cosine similarity.
   */
  const vocabulary = ['typescript', 'rust', 'fast', 'great', 'programming', 'alpha', 'beta', 'gamma', 'content', 'is'];
  const fakeProvider: EmbeddingProvider = {
    dimensions: vocabulary.length,
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map((t) => {
        const words = t.toLowerCase().split(/\s+/);
        return vocabulary.map((v) => (words.includes(v) ? 1.0 : 0.0));
      });
    },
  };

  it('returns empty when no provider', async () => {
    const store = new VectorStore();
    const results = await store.search('test');
    assert.equal(results.length, 0);
  });

  it('indexes and searches with provider', async () => {
    const store = new VectorStore(fakeProvider);
    await store.index('file.md', 1, 5, 'TypeScript is great');
    await store.index('file2.md', 1, 3, 'Rust is fast');
    const results = await store.search('TypeScript programming');
    assert.ok(results.length > 0, 'Expected at least one search result');
    assert.equal(results[0].source, 'vector');
    // TypeScript doc should rank higher for TypeScript query
    assert.equal(results[0].path, 'file.md');
  });

  it('respects limit', async () => {
    const store = new VectorStore(fakeProvider);
    await store.index('a.md', 1, 1, 'alpha');
    await store.index('b.md', 1, 1, 'beta');
    await store.index('c.md', 1, 1, 'gamma');
    const results = await store.search('alpha', { limit: 1 });
    assert.equal(results.length, 1);
  });

  it('clears entries', async () => {
    const store = new VectorStore(fakeProvider);
    await store.index('a.md', 1, 1, 'content');
    store.clear();
    const results = await store.search('content');
    assert.equal(results.length, 0);
  });
});

// ─── HybridMemoryStore ──────────────────────────────────────────────

describe('HybridMemoryStore', () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'tako-hybrid-'));
    await mkdir(join(tmpDir, 'memory'), { recursive: true });
    await writeFile(join(tmpDir, 'MEMORY.md'), '# Memory\n\nImportant fact: Tako uses TypeScript.\n');
    await writeFile(join(tmpDir, 'memory', 'log.md'), '# Log\n\nEntry 1: Started project.\nEntry 2: Added memory system.\n');
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('initializes and indexes workspace files', async () => {
    const store = new HybridMemoryStore(tmpDir);
    await store.initialize();
    const results = await store.search('TypeScript');
    assert.ok(results.length > 0);
  });

  it('search returns results sorted by score', async () => {
    const store = new HybridMemoryStore(tmpDir);
    await store.initialize();
    const results = await store.search('memory');
    assert.ok(results.length > 0);
    for (let i = 1; i < results.length; i++) {
      assert.ok(results[i - 1].score >= results[i].score);
    }
  });

  it('get returns file content', async () => {
    const store = new HybridMemoryStore(tmpDir);
    const content = await store.get('MEMORY.md');
    assert.ok(content.includes('Important fact'));
  });

  it('get with range returns line subset', async () => {
    const store = new HybridMemoryStore(tmpDir);
    const content = await store.get('memory/log.md', { start: 3, end: 3 });
    assert.ok(content.includes('Entry 1'));
  });

  it('get returns empty for missing file (graceful)', async () => {
    const store = new HybridMemoryStore(tmpDir);
    const content = await store.get('nonexistent.md');
    assert.equal(content, '');
  });

  it('index adds a new file to the store', async () => {
    const store = new HybridMemoryStore(tmpDir);
    await store.initialize();

    // Write a new file and index it
    await writeFile(join(tmpDir, 'memory', 'new.md'), '# New\n\nRust is blazing fast.\n');
    await store.index('memory/new.md');

    const results = await store.search('Rust blazing');
    assert.ok(results.length > 0);
  });
});

// ─── Bootstrap ───────────────────────────────────────────────────────

describe('bootstrapWorkspace', () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'tako-bootstrap-'));
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('creates workspace structure from scratch', async () => {
    const wsPath = join(tmpDir, 'workspace');
    await bootstrapWorkspace(wsPath);

    // Check directories exist
    const memoryStat = await stat(join(wsPath, 'memory'));
    assert.ok(memoryStat.isDirectory());

    // Check default files exist
    const soul = await readFile(join(wsPath, 'SOUL.md'), 'utf-8');
    assert.ok(soul.includes('Tako'));

    const identity = await readFile(join(wsPath, 'IDENTITY.md'), 'utf-8');
    assert.ok(identity.includes('Agent OS'));

    const memory = await readFile(join(wsPath, 'memory', 'MEMORY.md'), 'utf-8');
    assert.ok(memory.includes('Memory'));
  });

  it('does not overwrite existing files', async () => {
    const wsPath = join(tmpDir, 'workspace2');
    await mkdir(wsPath, { recursive: true });
    await writeFile(join(wsPath, 'SOUL.md'), 'Custom soul content');

    await bootstrapWorkspace(wsPath);

    const soul = await readFile(join(wsPath, 'SOUL.md'), 'utf-8');
    assert.equal(soul, 'Custom soul content');
  });
});

describe('ensureDailyMemory', () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'tako-daily-'));
    await mkdir(join(tmpDir, 'memory'), { recursive: true });
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('creates today daily log file', async () => {
    const relPath = await ensureDailyMemory(tmpDir);
    const expectedPath = dailyMemoryPath();
    assert.equal(relPath, expectedPath);

    const content = await readFile(join(tmpDir, relPath), 'utf-8');
    assert.ok(content.includes('Daily Log'));
  });

  it('does not overwrite existing daily log', async () => {
    const relPath = dailyMemoryPath();
    await writeFile(join(tmpDir, relPath), 'Existing log entry');

    await ensureDailyMemory(tmpDir);

    const content = await readFile(join(tmpDir, relPath), 'utf-8');
    assert.equal(content, 'Existing log entry');
  });
});
