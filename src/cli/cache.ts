/**
 * CLI: tako cache — view cache status and clear layers.
 *
 * Subcommands:
 *   tako cache status           — show stats for all cache layers
 *   tako cache clear             — clear all cache layers
 *   tako cache clear --layer=file — clear a specific layer
 */

import { resolveConfig } from '../config/resolve.js';
import { CacheManager, type CacheLayer } from '../cache/manager.js';

const VALID_LAYERS: CacheLayer[] = ['file', 'tool', 'symbols'];

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function formatPercent(n: number): string {
  return `${(n * 100).toFixed(1)}%`;
}

export async function runCache(args: string[]): Promise<void> {
  const sub = args[0] ?? 'status';

  const config = await resolveConfig();
  const manager = new CacheManager(config.cache);

  // Load persisted symbol index for status display
  if (sub === 'status') {
    await manager.loadSymbols();
  }

  switch (sub) {
    case 'status': {
      const status = manager.getStatus();
      console.log(`\nCache: ${status.enabled ? 'enabled' : 'disabled'}\n`);

      // File cache
      console.log('  File Content Cache:');
      console.log(`    Entries:    ${status.file.entries}`);
      console.log(`    Size:       ${formatBytes(status.file.totalBytes)} / ${formatBytes(status.file.maxBytes)}`);
      console.log(`    Hit rate:   ${formatPercent(status.file.hitRate)} (${status.file.hits} hits, ${status.file.misses} misses)`);
      console.log(`    Evictions:  ${status.file.evictions}`);

      // Tool cache
      console.log('\n  Tool Execution Cache:');
      console.log(`    Entries:    ${status.tool.entries}`);
      console.log(`    Hit rate:   ${formatPercent(status.tool.hitRate)} (${status.tool.hits} hits, ${status.tool.misses} misses)`);
      console.log(`    Blocked:    ${status.tool.blocked}`);
      console.log(`    Evictions:  ${status.tool.evictions}`);

      // Symbol index
      console.log('\n  Symbol Index Cache:');
      console.log(`    Files:      ${status.symbols.filesIndexed} / ${status.symbols.maxFiles}`);
      console.log(`    Symbols:    ${status.symbols.totalSymbols}`);
      console.log(`    Persisted:  ${status.symbols.lastPersisted ? new Date(status.symbols.lastPersisted).toISOString() : 'never'}`);

      console.log('');
      break;
    }

    case 'clear': {
      // Parse --layer=<name> flag
      const layerFlag = args.find((a) => a.startsWith('--layer='));
      const layerName = layerFlag?.split('=')[1];

      if (layerName) {
        if (!VALID_LAYERS.includes(layerName as CacheLayer)) {
          console.error(`Unknown cache layer: ${layerName}. Valid: ${VALID_LAYERS.join(', ')}`);
          process.exit(1);
        }
        manager.clear(layerName as CacheLayer);
        console.log(`Cleared ${layerName} cache.`);
      } else {
        manager.clear();
        console.log('Cleared all cache layers.');
      }
      break;
    }

    default:
      console.log('Usage: tako cache <status|clear> [--layer=file|tool|symbols]');
      break;
  }
}
