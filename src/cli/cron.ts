/**
 * CLI: tako cron — manage scheduled jobs.
 */

import { CronScheduler, type CronSchedule, type CronPayload } from '../core/cron.js';

/**
 * Parse a schedule string into a CronSchedule.
 * Supports:
 *   - Cron expression (5 fields): "0 8 * * *"
 *   - Interval: "every 30m", "every 1h"
 *   - One-shot: "at 2026-03-07T10:00:00Z"
 */
function parseSchedule(raw: string): CronSchedule {
  // Cron expression (5 space-separated fields)
  const cronParts = raw.trim().split(/\s+/);
  if (cronParts.length === 5 && /^[\d*,\-/]+$/.test(cronParts[0])) {
    return { kind: 'cron', expr: raw.trim() };
  }

  // "every Nm/Nh/Ns"
  const everyMatch = raw.match(/^every\s+(\d+)(s|m|h)$/i);
  if (everyMatch) {
    const n = parseInt(everyMatch[1], 10);
    const unit = everyMatch[2].toLowerCase();
    const ms = unit === 'h' ? n * 3600_000 : unit === 'm' ? n * 60_000 : n * 1000;
    return { kind: 'every', everyMs: ms };
  }

  // "at <ISO>"
  const atMatch = raw.match(/^at\s+(.+)$/i);
  if (atMatch) {
    return { kind: 'at', at: new Date(atMatch[1]).toISOString() };
  }

  // Default: treat as cron expression
  return { kind: 'cron', expr: raw.trim() };
}

function formatSchedule(sched: CronSchedule): string {
  switch (sched.kind) {
    case 'cron': return `cron: ${sched.expr}${sched.tz ? ` (${sched.tz})` : ''}`;
    case 'every': {
      const ms = sched.everyMs;
      if (ms >= 3600_000) return `every ${ms / 3600_000}h`;
      if (ms >= 60_000) return `every ${ms / 60_000}m`;
      return `every ${ms / 1000}s`;
    }
    case 'at': return `at ${sched.at}`;
  }
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

export async function runCron(args: string[]): Promise<void> {
  const subcommand = args[0] ?? 'list';
  const scheduler = new CronScheduler();

  // Load persisted jobs (start() would also start the timer, so we call load via a workaround)
  // We need jobs loaded but NOT the timer running. Use a temporary approach:
  // instantiate and load manually.

  switch (subcommand) {
    case 'list': {
      await scheduler.start();
      scheduler.stop(); // stop timer immediately, we just wanted to load

      const jobs = scheduler.list(true); // include disabled
      if (jobs.length === 0) {
        console.log('No cron jobs configured.');
        console.log('\nAdd one with: tako cron add --name "Daily report" --schedule "0 8 * * *" --task "Generate daily report"');
        return;
      }

      console.log(`Cron jobs (${jobs.length}):\n`);
      for (const job of jobs) {
        const status = job.enabled ? '✓' : '✗';
        console.log(`  ${status} ${job.id}  ${job.name}`);
        console.log(`    Schedule: ${formatSchedule(job.schedule)}`);
        console.log(`    Runs: ${job.runCount}${job.lastRunAt ? `  Last: ${job.lastRunAt}` : ''}`);
        console.log();
      }
      break;
    }

    case 'add': {
      const name = getArg(args, '--name');
      const scheduleStr = getArg(args, '--schedule');
      const task = getArg(args, '--task');
      const agent = getArg(args, '--agent') ?? 'main';

      if (!name || !scheduleStr || !task) {
        console.error('Usage: tako cron add --name <name> --schedule <schedule> --task <message>');
        console.error('');
        console.error('Schedule formats:');
        console.error('  Cron:     "0 8 * * *"       (8 AM daily)');
        console.error('  Interval: "every 30m"       (every 30 minutes)');
        console.error('  One-shot: "at 2026-03-07T10:00:00Z"');
        console.error('');
        console.error('Options:');
        console.error('  --agent <id>     Agent to run the task (default: main)');
        process.exit(1);
      }

      const schedule = parseSchedule(scheduleStr);
      const payload: CronPayload = { kind: 'agent-turn', message: task };

      await scheduler.start();
      scheduler.stop();

      const job = await scheduler.add({
        name,
        enabled: true,
        schedule,
        payload,
      });

      console.log(`Created cron job: ${job.id}`);
      console.log(`  Name: ${job.name}`);
      console.log(`  Schedule: ${formatSchedule(job.schedule)}`);
      console.log(`  Task: ${task}`);
      break;
    }

    case 'remove': {
      const jobId = args[1];
      if (!jobId) {
        console.error('Usage: tako cron remove <jobId>');
        process.exit(1);
      }

      await scheduler.start();
      scheduler.stop();

      const removed = await scheduler.remove(jobId);
      if (removed) {
        console.log(`Removed cron job: ${jobId}`);
      } else {
        console.error(`Cron job not found: ${jobId}`);
        process.exit(1);
      }
      break;
    }

    case 'enable':
    case 'disable': {
      const jobId = args[1];
      if (!jobId) {
        console.error(`Usage: tako cron ${subcommand} <jobId>`);
        process.exit(1);
      }

      await scheduler.start();
      scheduler.stop();

      const enabled = subcommand === 'enable';
      const updated = await scheduler.update(jobId, { enabled });
      if (updated) {
        console.log(`${enabled ? 'Enabled' : 'Disabled'} cron job: ${jobId} (${updated.name})`);
      } else {
        console.error(`Cron job not found: ${jobId}`);
        process.exit(1);
      }
      break;
    }

    case 'run': {
      const jobId = args[1];
      if (!jobId) {
        console.error('Usage: tako cron run <jobId>');
        process.exit(1);
      }

      await scheduler.start();
      scheduler.stop();

      const job = scheduler.get(jobId);
      if (!job) {
        console.error(`Cron job not found: ${jobId}`);
        process.exit(1);
      }

      console.log(`Job "${job.name}" exists but immediate execution requires the daemon.`);
      console.log('Start Tako first: tako start');
      console.log('The daemon will execute jobs with the agent loop wired up.');
      break;
    }

    case 'runs':
    case 'logs': {
      const jobId = args[1];

      await scheduler.start();
      scheduler.stop();

      const runs = await scheduler.getRunHistory(jobId, 50);

      if (runs.length === 0) {
        console.log(jobId ? `No runs found for job: ${jobId}` : 'No cron run history found.');
        return;
      }

      console.log(`Cron runs (${runs.length}):\n`);
      for (const run of runs) {
        console.log(`  ${run.jobId}  ${run.jobName}`);
        console.log(`    Started: ${run.startedAt}  Finished: ${run.finishedAt}`);
        console.log(`    Delivered: ${run.delivered ? 'yes' : 'no'}`);
        console.log();
      }
      break;
    }

    default:
      console.error(`Unknown cron subcommand: ${subcommand}`);
      console.error('Available: list, add, remove, enable, disable, run, runs');
      process.exit(1);
  }
}
