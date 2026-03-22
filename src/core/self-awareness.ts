/**
 * Self-awareness — generates a concise repo structure map.
 *
 * Scans the project directory tree and produces a `tree`-like output
 * that the agent can reference to understand its own codebase.
 * Skips noise directories (node_modules, .git, dist, etc.).
 */

import { readdir, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

/** Directories to always skip when scanning. */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.tako-build',
  'dist',
  '.next',
  '.turbo',
  '.cache',
  '.DS_Store',
  'coverage',
  '__pycache__',
  '.venv',
  'venv',
]);

/** Max depth to scan (prevents runaway recursion). */
const MAX_DEPTH = 6;

/** Max total entries to include in the map. */
const MAX_ENTRIES = 200;

interface TreeEntry {
  /** Path relative to the project root */
  path: string;
  /** Whether this is a directory */
  isDir: boolean;
  /** Depth in the tree */
  depth: number;
  /** File size in bytes (0 for directories) */
  size: number;
}

/**
 * Check if the given path is a git repository root.
 */
export async function isGitRepo(dirPath: string): Promise<boolean> {
  try {
    const s = await stat(join(dirPath, '.git'));
    return s.isDirectory();
  } catch {
    return false;
  }
}

/**
 * Scan a directory tree and return a flat list of entries.
 */
async function scanTree(
  rootDir: string,
  currentDir: string,
  depth: number,
  entries: TreeEntry[],
): Promise<void> {
  if (depth > MAX_DEPTH || entries.length >= MAX_ENTRIES) return;

  let items: string[];
  try {
    items = await readdir(currentDir);
  } catch {
    return;
  }

  // Sort: directories first, then alphabetical
  const dirEntries: Array<{ name: string; isDir: boolean; size: number }> = [];
  for (const name of items) {
    if (SKIP_DIRS.has(name) || name.startsWith('.')) continue;
    try {
      const fullPath = join(currentDir, name);
      const s = await stat(fullPath);
      dirEntries.push({ name, isDir: s.isDirectory(), size: s.size });
    } catch {
      // Skip entries we can't stat
    }
  }

  dirEntries.sort((a, b) => {
    if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  for (const entry of dirEntries) {
    if (entries.length >= MAX_ENTRIES) break;

    const fullPath = join(currentDir, entry.name);
    const relPath = relative(rootDir, fullPath);

    entries.push({
      path: relPath,
      isDir: entry.isDir,
      depth,
      size: entry.size,
    });

    if (entry.isDir) {
      await scanTree(rootDir, fullPath, depth + 1, entries);
    }
  }
}

/**
 * Format file size for display.
 */
function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}K`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}M`;
}

/**
 * Generate a concise repo structure map as a tree-formatted string.
 *
 * @param projectDir - The project root to scan
 * @returns A formatted tree string, or empty string if not a git repo
 */
export async function generateRepoMap(projectDir: string): Promise<string> {
  if (!(await isGitRepo(projectDir))) return '';

  const entries: TreeEntry[] = [];
  await scanTree(projectDir, projectDir, 0, entries);

  if (entries.length === 0) return '';

  const lines: string[] = ['# Repo Structure', ''];
  lines.push('```');

  for (const entry of entries) {
    const indent = '  '.repeat(entry.depth);
    const suffix = entry.isDir ? '/' : ` (${formatSize(entry.size)})`;
    lines.push(`${indent}${entry.path.split('/').pop()}${suffix}`);
  }

  if (entries.length >= MAX_ENTRIES) {
    lines.push('  ... (truncated)');
  }

  lines.push('```');

  return lines.join('\n');
}
