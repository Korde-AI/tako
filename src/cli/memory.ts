/**
 * CLI: tako memory — search and inspect memory.
 */

import { resolveConfig } from '../config/resolve.js';
import { HybridMemoryStore } from '../memory/hybrid.js';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { getRuntimePaths } from '../core/paths.js';
import {
  getProjectPrivateMemoryDir,
  getProjectSharedMemoryDir,
  getGlobalPrivateMemoryDir,
} from '../memory/scopes.js';

function getFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

async function countFiles(dir: string, ext: string): Promise<number> {
  let count = 0;
  try {
    const entries = await readdir(dir, { withFileTypes: true, recursive: true });
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith(ext)) {
        count++;
      }
    }
  } catch {
    // directory may not exist
  }
  return count;
}

export async function runMemory(args: string[]): Promise<void> {
  const subcommand = args[0] ?? 'status';
  const config = await resolveConfig();

  switch (subcommand) {
    case 'search': {
      const query = args.slice(1).join(' ');
      if (!query) {
        console.error('Usage: tako memory search <query>');
        console.error('  Example: tako memory search "API authentication"');
        process.exit(1);
      }

      const store = new HybridMemoryStore(config.memory.workspace);
      await store.initialize();

      const results = await store.search(query, { limit: 10 });

      if (results.length === 0) {
        console.log('No results found.');
        return;
      }

      console.log(`Found ${results.length} result(s):\n`);
      for (const snippet of results) {
        const score = ` (score: ${snippet.score.toFixed(3)})`;
        console.log(`  ${snippet.path}${score}`);
        if (snippet.range) {
          console.log(`    Lines: ${snippet.range.start}-${snippet.range.end}`);
        }
        const preview = snippet.content.slice(0, 200).replace(/\n/g, ' ');
        console.log(`    ${preview}${snippet.content.length > 200 ? '...' : ''}`);
        console.log();
      }
      break;
    }

    case 'inspect': {
      const projectId = getFlag(args, '--project');
      const principalId = getFlag(args, '--principal');
      const configPaths = getRuntimePaths();
      console.log('Memory Roots\n');
      console.log(`  global-private: ${getGlobalPrivateMemoryDir(config.memory.workspace)}`);
      if (projectId) {
        console.log(`  project-shared: ${getProjectSharedMemoryDir(configPaths, projectId)}`);
        if (principalId) {
          console.log(`  project-private: ${getProjectPrivateMemoryDir(configPaths, projectId, principalId)}`);
        }
      }
      break;
    }

    case 'status': {
      const workspace = config.memory.workspace;
      console.log('Memory Status\n');
      console.log(`  Workspace: ${workspace}`);

      const mdCount = await countFiles(workspace, '.md');
      console.log(`  Markdown files: ${mdCount}`);

      const memoryDir = join(workspace, 'memory');
      const memoryCount = await countFiles(memoryDir, '.md');
      console.log(`  Memory files: ${memoryCount}`);

      // Check for embeddings config
      if (config.memory.embeddings) {
        console.log(`  Embeddings: ${config.memory.embeddings.provider}${config.memory.embeddings.model ? ` (${config.memory.embeddings.model})` : ''}`);
      } else {
        console.log('  Embeddings: not configured (BM25-only search)');
      }
      break;
    }

    default:
      console.error(`Unknown memory subcommand: ${subcommand}`);
      console.error('Available: search, inspect, status');
      process.exit(1);
  }
}
