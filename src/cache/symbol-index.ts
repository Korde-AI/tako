/**
 * AST/Symbol Index Cache — extracts and caches function/class/type symbols.
 *
 * Uses regex-based extraction for TypeScript/JavaScript and Python.
 * Persists index to disk for fast startup. Incremental indexing via mtime checks.
 */

import { readFile, writeFile, stat, mkdir } from 'node:fs/promises';
import { dirname, extname, resolve } from 'node:path';
import { readdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import type { SymbolCacheConfig } from '../config/schema.js';

// ─── Types ──────────────────────────────────────────────────────────

export type SymbolKind = 'function' | 'class' | 'interface' | 'type' | 'enum' | 'const' | 'variable' | 'method';

export interface SymbolEntry {
  name: string;
  kind: SymbolKind;
  file: string;
  line: number;
  exported: boolean;
}

export interface FileIndex {
  path: string;
  mtimeMs: number;
  symbols: SymbolEntry[];
}

export interface SymbolIndexStats {
  filesIndexed: number;
  totalSymbols: number;
  lastPersisted: number | null;
  maxFiles: number;
}

interface PersistedIndex {
  version: number;
  updatedAt: string;
  files: FileIndex[];
}

// ─── Regex patterns for symbol extraction ───────────────────────────

// TypeScript/JavaScript patterns
const TS_PATTERNS: Array<{ kind: SymbolKind; regex: RegExp; exported: boolean }> = [
  { kind: 'function', regex: /^export\s+(?:async\s+)?function\s+(\w+)/gm, exported: true },
  { kind: 'function', regex: /^(?:async\s+)?function\s+(\w+)/gm, exported: false },
  { kind: 'class', regex: /^export\s+(?:abstract\s+)?class\s+(\w+)/gm, exported: true },
  { kind: 'class', regex: /^(?:abstract\s+)?class\s+(\w+)/gm, exported: false },
  { kind: 'interface', regex: /^export\s+interface\s+(\w+)/gm, exported: true },
  { kind: 'interface', regex: /^interface\s+(\w+)/gm, exported: false },
  { kind: 'type', regex: /^export\s+type\s+(\w+)/gm, exported: true },
  { kind: 'type', regex: /^type\s+(\w+)/gm, exported: false },
  { kind: 'enum', regex: /^export\s+(?:const\s+)?enum\s+(\w+)/gm, exported: true },
  { kind: 'enum', regex: /^(?:const\s+)?enum\s+(\w+)/gm, exported: false },
  { kind: 'const', regex: /^export\s+const\s+(\w+)/gm, exported: true },
];

// Python patterns
const PY_PATTERNS: Array<{ kind: SymbolKind; regex: RegExp; exported: boolean }> = [
  { kind: 'function', regex: /^(?:async\s+)?def\s+(\w+)/gm, exported: true },
  { kind: 'class', regex: /^class\s+(\w+)/gm, exported: true },
];

// ─── Symbol Index Cache ─────────────────────────────────────────────

export class SymbolIndex {
  private config: SymbolCacheConfig;
  private index = new Map<string, FileIndex>();
  private lastPersisted: number | null = null;

  constructor(config: SymbolCacheConfig) {
    this.config = config;
  }

  /**
   * Index a single file, extracting symbols.
   * Returns null if the file is already indexed and unchanged.
   */
  async indexFile(filePath: string): Promise<FileIndex | null> {
    if (!this.config.enabled) return null;

    // Check mtime to skip unchanged files
    let mtimeMs: number;
    try {
      const st = await stat(filePath);
      mtimeMs = st.mtimeMs;
    } catch {
      // File gone — remove from index
      this.index.delete(filePath);
      return null;
    }

    const existing = this.index.get(filePath);
    if (existing && existing.mtimeMs === mtimeMs) {
      return existing; // Unchanged
    }

    // Read and parse
    let content: string;
    try {
      content = await readFile(filePath, 'utf-8');
    } catch {
      return null;
    }

    const ext = extname(filePath).toLowerCase();
    const symbols = this.extractSymbols(filePath, content, ext);

    const fileIndex: FileIndex = { path: filePath, mtimeMs, symbols };
    this.index.set(filePath, fileIndex);

    // Enforce max files limit
    if (this.index.size > this.config.maxFiles) {
      // Remove oldest entries (by insertion order — Map preserves insertion order)
      const excess = this.index.size - this.config.maxFiles;
      const keys = this.index.keys();
      for (let i = 0; i < excess; i++) {
        const { value } = keys.next();
        if (value) this.index.delete(value);
      }
    }

    return fileIndex;
  }

  /**
   * Index all supported files in a directory recursively.
   */
  async indexDirectory(dirPath: string, maxDepth = 5): Promise<number> {
    if (!this.config.enabled) return 0;

    let indexed = 0;
    await this.walkDir(dirPath, maxDepth, 0, async (filePath) => {
      if (this.index.size >= this.config.maxFiles) return;
      const ext = extname(filePath).toLowerCase();
      if (this.isSupportedExtension(ext)) {
        await this.indexFile(filePath);
        indexed++;
      }
    });
    return indexed;
  }

  /**
   * Search for symbols by name (prefix match).
   */
  search(query: string, limit = 20): SymbolEntry[] {
    const results: SymbolEntry[] = [];
    const lowerQuery = query.toLowerCase();

    for (const fileIndex of this.index.values()) {
      for (const sym of fileIndex.symbols) {
        if (sym.name.toLowerCase().startsWith(lowerQuery)) {
          results.push(sym);
          if (results.length >= limit) return results;
        }
      }
    }

    return results;
  }

  /**
   * Get all symbols for a specific file.
   */
  getFileSymbols(filePath: string): SymbolEntry[] {
    return this.index.get(filePath)?.symbols ?? [];
  }

  /**
   * Invalidate a file's symbol index (e.g. after edit).
   */
  invalidate(filePath: string): void {
    this.index.delete(filePath);
  }

  /**
   * Clear the entire index.
   */
  clear(): void {
    this.index.clear();
  }

  /**
   * Persist the index to disk.
   */
  async persist(): Promise<void> {
    const persistPath = this.resolvePath(this.config.persistPath);
    const data: PersistedIndex = {
      version: 1,
      updatedAt: new Date().toISOString(),
      files: Array.from(this.index.values()),
    };

    try {
      await mkdir(dirname(persistPath), { recursive: true });
      await writeFile(persistPath, JSON.stringify(data), 'utf-8');
      this.lastPersisted = Date.now();
    } catch (err) {
      console.error(`[symbol-index] Failed to persist: ${err}`);
    }
  }

  /**
   * Load the index from disk.
   */
  async load(): Promise<number> {
    const persistPath = this.resolvePath(this.config.persistPath);
    try {
      const raw = await readFile(persistPath, 'utf-8');
      const data = JSON.parse(raw) as PersistedIndex;
      if (data.version !== 1) return 0;

      for (const fileIndex of data.files) {
        this.index.set(fileIndex.path, fileIndex);
      }
      this.lastPersisted = Date.now();
      return data.files.length;
    } catch {
      return 0; // No persisted index
    }
  }

  /**
   * Get cache statistics.
   */
  getStats(): SymbolIndexStats {
    let totalSymbols = 0;
    for (const fileIndex of this.index.values()) {
      totalSymbols += fileIndex.symbols.length;
    }
    return {
      filesIndexed: this.index.size,
      totalSymbols,
      lastPersisted: this.lastPersisted,
      maxFiles: this.config.maxFiles,
    };
  }

  // ─── Private ────────────────────────────────────────────────────

  private extractSymbols(filePath: string, content: string, ext: string): SymbolEntry[] {
    const patterns = this.getPatternsForExt(ext);
    if (!patterns) return [];

    const lines = content.split('\n');
    const symbols: SymbolEntry[] = [];
    const seen = new Set<string>();

    for (const { kind, regex, exported } of patterns) {
      // Reset regex state
      regex.lastIndex = 0;
      let match: RegExpExecArray | null;
      while ((match = regex.exec(content)) !== null) {
        const name = match[1];
        const key = `${kind}:${name}:${exported}`;
        if (seen.has(key)) continue;
        seen.add(key);

        // Find line number
        const lineNum = content.slice(0, match.index).split('\n').length;
        symbols.push({ name, kind, file: filePath, line: lineNum, exported });
      }
    }

    return symbols;
  }

  private getPatternsForExt(ext: string): Array<{ kind: SymbolKind; regex: RegExp; exported: boolean }> | null {
    switch (ext) {
      case '.ts':
      case '.tsx':
      case '.js':
      case '.jsx':
      case '.mts':
      case '.mjs':
        return TS_PATTERNS;
      case '.py':
        return PY_PATTERNS;
      default:
        return null;
    }
  }

  private isSupportedExtension(ext: string): boolean {
    return ['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs', '.py'].includes(ext);
  }

  private resolvePath(p: string): string {
    if (p.startsWith('~/') || p === '~') {
      return resolve(homedir(), p.slice(2));
    }
    return resolve(p);
  }

  private async walkDir(
    dir: string,
    maxDepth: number,
    depth: number,
    callback: (path: string) => Promise<void>,
  ): Promise<void> {
    if (depth > maxDepth) return;

    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = resolve(dir, entry.name);

      // Skip common non-source directories
      if (entry.isDirectory()) {
        if (['node_modules', '.git', '.tako-build', 'dist', 'build', '.next', '__pycache__', '.venv'].includes(entry.name)) {
          continue;
        }
        await this.walkDir(fullPath, maxDepth, depth + 1, callback);
      } else if (entry.isFile()) {
        await callback(fullPath);
      }
    }
  }
}
