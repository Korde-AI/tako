/**
 * CLI: tako symphony — project orchestration commands.
 */

import { SymphonyOrchestrator } from '../core/symphony/orchestrator.js';
import { formatStatus, formatHistory } from '../core/symphony/status.js';
import type { SymphonyConfig } from '../core/symphony/types.js';

function parseIntervalMs(interval: string): number {
  const match = interval.match(/^(\d+)(ms|s|m|h)?$/);
  if (!match) return 30000;
  const [, num, unit] = match;
  const n = parseInt(num, 10);
  switch (unit) {
    case 'ms': return n;
    case 's': return n * 1000;
    case 'm': return n * 60000;
    case 'h': return n * 3600000;
    default: return n * 1000;
  }
}

function parseFlag(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  if (idx === -1 || idx + 1 >= args.length) return undefined;
  return args[idx + 1];
}

export async function runSymphony(args: string[]): Promise<void> {
  const subcommand = args[0] ?? 'status';

  switch (subcommand) {
    case 'start': {
      const repo = parseFlag(args, '--repo');
      if (!repo) {
        console.error('Usage: tako symphony start --repo owner/repo [--labels bug,feature] [--interval 30s] [--max-agents 5]');
        process.exit(1);
      }

      const existing = SymphonyOrchestrator.getInstance();
      if (existing?.isRunning()) {
        console.log('Symphony is already running. Use `tako symphony stop` first.');
        return;
      }

      const labels = parseFlag(args, '--labels');
      const interval = parseFlag(args, '--interval');
      const maxAgents = parseFlag(args, '--max-agents');

      const config: SymphonyConfig = {
        repo,
        labels: labels ? labels.split(',').map((l) => l.trim()) : undefined,
        pollIntervalMs: interval ? parseIntervalMs(interval) : 30000,
        maxConcurrentAgents: maxAgents ? parseInt(maxAgents, 10) : 5,
      };

      const orchestrator = SymphonyOrchestrator.getInstance(config);
      if (!orchestrator) {
        console.error('Failed to create orchestrator.');
        process.exit(1);
      }

      orchestrator.start();
      console.log(`🎵 Symphony started — monitoring ${repo}`);
      console.log(`  Labels: ${labels ?? 'all'}`);
      console.log(`  Interval: ${interval ?? '30s'}`);
      console.log(`  Max agents: ${maxAgents ?? '5'}`);

      // Keep process alive
      process.on('SIGINT', () => {
        SymphonyOrchestrator.destroyInstance();
        process.exit(0);
      });
      process.on('SIGTERM', () => {
        SymphonyOrchestrator.destroyInstance();
        process.exit(0);
      });
      break;
    }

    case 'stop': {
      const orchestrator = SymphonyOrchestrator.getInstance();
      if (!orchestrator?.isRunning()) {
        console.log('Symphony is not running.');
        return;
      }
      SymphonyOrchestrator.destroyInstance();
      console.log('🎵 Symphony stopped.');
      break;
    }

    case 'status': {
      const orchestrator = SymphonyOrchestrator.getInstance();
      if (!orchestrator) {
        console.log('Symphony is not running. Start with: tako symphony start --repo owner/repo');
        return;
      }
      console.log(formatStatus(orchestrator.getState(), orchestrator.getConfig()));
      break;
    }

    case 'history': {
      const orchestrator = SymphonyOrchestrator.getInstance();
      if (!orchestrator) {
        console.log('Symphony is not running.');
        return;
      }
      const completed = Array.from(orchestrator.getState().completed.values());
      console.log(formatHistory(completed));
      break;
    }

    case 'config': {
      const orchestrator = SymphonyOrchestrator.getInstance();
      if (!orchestrator) {
        console.log('Symphony is not running.');
        return;
      }
      console.log(JSON.stringify(orchestrator.getConfig(), null, 2));
      break;
    }

    default:
      console.log(`Unknown symphony command: ${subcommand}`);
      console.log('Usage: tako symphony <start|stop|status|history|config>');
      process.exit(1);
  }
}
