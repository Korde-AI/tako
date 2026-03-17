/**
 * Minimal cron scheduler for Tako.
 *
 * Design: thin JSON file + setInterval evaluator.
 * No dependencies beyond Node stdlib.
 *
 * Jobs persist at ~/.tako/cron/jobs.json.
 * Each tick checks which jobs are due and runs them.
 *
 * Two execution modes:
 *   - "system-event": inject text into the main session (processed on next agent turn)
 *   - "agent-turn":   run a dedicated agent turn in an isolated session
 *
 * Three schedule types:
 *   - "at":    one-shot at ISO timestamp
 *   - "every": recurring interval (ms)
 *   - "cron":  cron expression (minute hour dom month dow)
 */

import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getRuntimePaths } from './paths.js';

// ─── Types ──────────────────────────────────────────────────────────

export interface CronJob {
  id: string;
  name: string;
  enabled: boolean;
  schedule: CronSchedule;
  payload: CronPayload;
  delivery?: CronDelivery;
  createdAt: string;
  lastRunAt?: string;
  runCount: number;
  /** Delete after successful run (for one-shot jobs). */
  deleteAfterRun?: boolean;
}

export type CronSchedule =
  | { kind: 'at'; at: string }             // ISO-8601
  | { kind: 'every'; everyMs: number }      // interval
  | { kind: 'cron'; expr: string; tz?: string }; // cron expression

export type CronPayload =
  | { kind: 'system-event'; text: string }
  | { kind: 'agent-turn'; message: string; model?: string };

export interface CronDelivery {
  mode: 'none' | 'announce';
  channel?: string;
  to?: string;
}

export interface CronRunResult {
  jobId: string;
  jobName: string;
  startedAt: string;
  finishedAt: string;
  response: string;
  delivered: boolean;
}

// ─── Cron expression matcher ────────────────────────────────────────

/** Match a cron expression (min hour dom month dow) against a Date. */
function matchesCron(expr: string, date: Date, tz?: string): boolean {
  const d = tz ? new Date(date.toLocaleString('en-US', { timeZone: tz })) : date;
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;

  const fields = [d.getMinutes(), d.getHours(), d.getDate(), d.getMonth() + 1, d.getDay()];
  return parts.every((part, i) => matchField(part, fields[i]));
}

function matchField(pattern: string, value: number): boolean {
  if (pattern === '*') return true;

  for (const segment of pattern.split(',')) {
    // Range: 1-5
    if (segment.includes('-')) {
      const [lo, hi] = segment.split('-').map(Number);
      if (value >= lo && value <= hi) return true;
      continue;
    }
    // Step: */5
    if (segment.includes('/')) {
      const [base, step] = segment.split('/');
      const s = Number(step);
      if (base === '*' && value % s === 0) return true;
      continue;
    }
    // Exact
    if (Number(segment) === value) return true;
  }
  return false;
}

// ─── Scheduler ──────────────────────────────────────────────────────

export type AgentTurnRunner = (message: string, model?: string) => Promise<string>;
export type SystemEventHandler = (text: string) => void;
export type DeliveryHandler = (result: CronRunResult, delivery: CronDelivery) => void;

/** Max number of catch-up jobs to run immediately on startup. */
const MAX_CATCHUP_JOBS = 5;
/** Delay between staggered catch-up jobs in ms. */
const CATCHUP_STAGGER_MS = 30_000;

export class CronScheduler {
  private jobs: CronJob[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private jobsPath: string;
  private runLogPath: string;
  private agentTurnRunner: AgentTurnRunner | null = null;
  private systemEventHandler: SystemEventHandler | null = null;
  private deliveryHandler: DeliveryHandler | null = null;
  private tickIntervalMs = 60_000; // check every minute

  constructor(dir?: string) {
    const base = dir ?? getRuntimePaths().cronDir;
    this.jobsPath = join(base, 'jobs.json');
    this.runLogPath = join(base, 'runs');
  }

  /** Wire handlers. */
  setHandlers(opts: {
    agentTurn?: AgentTurnRunner;
    systemEvent?: SystemEventHandler;
    delivery?: DeliveryHandler;
  }): void {
    if (opts.agentTurn) this.agentTurnRunner = opts.agentTurn;
    if (opts.systemEvent) this.systemEventHandler = opts.systemEvent;
    if (opts.delivery) this.deliveryHandler = opts.delivery;
  }

  /** Load jobs from disk and start the tick loop. Stagger missed catch-up jobs. */
  async start(): Promise<void> {
    await this.load();

    // Catch-up: find all due jobs and stagger execution
    const now = new Date();
    const dueJobs = this.jobs.filter((j) => j.enabled && this.isDue(j, now));

    if (dueJobs.length > 0) {
      const immediate = dueJobs.slice(0, MAX_CATCHUP_JOBS);
      const staggered = dueJobs.slice(MAX_CATCHUP_JOBS);

      // Run first batch immediately
      for (const job of immediate) {
        try {
          await this.executeJob(job);
        } catch (err) {
          console.error(`[cron] Catch-up job ${job.id} (${job.name}) failed:`, err instanceof Error ? err.message : err);
        }
      }

      // Stagger remaining catch-up jobs
      if (staggered.length > 0) {
        console.log(`[cron] Staggering ${staggered.length} remaining catch-up jobs (${CATCHUP_STAGGER_MS}ms apart)`);
        for (let i = 0; i < staggered.length; i++) {
          const job = staggered[i];
          const delay = (i + 1) * CATCHUP_STAGGER_MS;
          setTimeout(async () => {
            try {
              await this.executeJob(job);
            } catch (err) {
              console.error(`[cron] Staggered catch-up job ${job.id} (${job.name}) failed:`, err instanceof Error ? err.message : err);
            }
          }, delay);
        }
      }
    }

    this.timer = setInterval(() => this.tick(), this.tickIntervalMs);
    const active = this.jobs.filter((j) => j.enabled).length;
    if (active > 0) {
      console.log(`[cron] Started — ${active} active job${active !== 1 ? 's' : ''}`);
    }
  }

  /** Stop the tick loop. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  // ─── CRUD ───────────────────────────────────────────────────────

  /** Add a new job. Returns the job. */
  async add(opts: Omit<CronJob, 'id' | 'createdAt' | 'runCount'>): Promise<CronJob> {
    const job: CronJob = {
      ...opts,
      id: randomUUID().slice(0, 8),
      createdAt: new Date().toISOString(),
      runCount: 0,
    };
    this.jobs.push(job);
    await this.save();
    return job;
  }

  /** Remove a job by ID. */
  async remove(id: string): Promise<boolean> {
    const before = this.jobs.length;
    this.jobs = this.jobs.filter((j) => j.id !== id);
    if (this.jobs.length < before) {
      await this.save();
      return true;
    }
    return false;
  }

  /** Update a job. */
  async update(id: string, patch: Partial<CronJob>): Promise<CronJob | null> {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) return null;
    Object.assign(job, patch, { id: job.id }); // never overwrite id
    await this.save();
    return job;
  }

  /** List all jobs. */
  list(includeDisabled = false): CronJob[] {
    return includeDisabled ? [...this.jobs] : this.jobs.filter((j) => j.enabled);
  }

  /** Get a specific job. */
  get(id: string): CronJob | null {
    return this.jobs.find((j) => j.id === id) ?? null;
  }

  /** Run a job immediately (bypass schedule). */
  async run(id: string): Promise<CronRunResult | null> {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) return null;
    return this.executeJob(job);
  }

  // ─── Tick ───────────────────────────────────────────────────────

  private async tick(): Promise<void> {
    const now = new Date();

    for (const job of this.jobs) {
      if (!job.enabled) continue;
      if (!this.isDue(job, now)) continue;

      try {
        await this.executeJob(job);
      } catch (err) {
        console.error(`[cron] Job ${job.id} (${job.name}) failed:`, err instanceof Error ? err.message : err);
      }
    }
  }

  /** Check if a job is due to run. */
  private isDue(job: CronJob, now: Date): boolean {
    const sched = job.schedule;

    switch (sched.kind) {
      case 'at': {
        const target = new Date(sched.at);
        // Due if target is in the past and hasn't run yet
        return now >= target && job.runCount === 0;
      }
      case 'every': {
        if (!job.lastRunAt) return true;
        const elapsed = now.getTime() - new Date(job.lastRunAt).getTime();
        return elapsed >= sched.everyMs;
      }
      case 'cron': {
        // Only match on the current minute (avoid double-fire)
        if (job.lastRunAt) {
          const lastRun = new Date(job.lastRunAt);
          const sameMinute =
            lastRun.getFullYear() === now.getFullYear() &&
            lastRun.getMonth() === now.getMonth() &&
            lastRun.getDate() === now.getDate() &&
            lastRun.getHours() === now.getHours() &&
            lastRun.getMinutes() === now.getMinutes();
          if (sameMinute) return false;
        }
        return matchesCron(sched.expr, now, sched.tz);
      }
    }
  }

  /** Execute a job. */
  private async executeJob(job: CronJob): Promise<CronRunResult> {
    const startedAt = new Date().toISOString();
    let response = '';

    if (job.payload.kind === 'system-event') {
      this.systemEventHandler?.(job.payload.text);
      response = '[system event injected]';
    } else if (job.payload.kind === 'agent-turn') {
      if (this.agentTurnRunner) {
        response = await this.agentTurnRunner(job.payload.message, job.payload.model);
      } else {
        response = '[no agent runner configured]';
      }
    }

    const result: CronRunResult = {
      jobId: job.id,
      jobName: job.name,
      startedAt,
      finishedAt: new Date().toISOString(),
      response,
      delivered: false,
    };

    // Update job state
    job.lastRunAt = result.finishedAt;
    job.runCount++;

    // Deliver
    if (job.delivery && job.delivery.mode !== 'none' && this.deliveryHandler) {
      this.deliveryHandler(result, job.delivery);
      result.delivered = true;
    }

    // Persist run result to disk
    await this.saveRunResult(result);

    // One-shot cleanup
    if (job.deleteAfterRun) {
      this.jobs = this.jobs.filter((j) => j.id !== job.id);
    }

    await this.save();
    return result;
  }

  /** Get run history for a specific job or all jobs. */
  async getRunHistory(jobId?: string, limit = 50): Promise<CronRunResult[]> {
    const { readdir } = await import('node:fs/promises');
    const results: CronRunResult[] = [];

    try {
      await mkdir(this.runLogPath, { recursive: true });
      const files = await readdir(this.runLogPath);
      const jsonFiles = files.filter((f) => f.endsWith('.json')).sort().slice(-limit * 2);

      for (const file of jsonFiles) {
        try {
          const raw = await readFile(join(this.runLogPath, file), 'utf-8');
          const run = JSON.parse(raw) as CronRunResult;
          if (!jobId || run.jobId === jobId) {
            results.push(run);
          }
        } catch {
          // skip corrupt files
        }
      }
    } catch {
      // runs dir doesn't exist yet
    }

    return results.slice(-limit);
  }

  // ─── Persistence ────────────────────────────────────────────────

  /** Save a run result to disk. */
  private async saveRunResult(result: CronRunResult): Promise<void> {
    try {
      await mkdir(this.runLogPath, { recursive: true });
      const filename = `${result.startedAt.replace(/[:.]/g, '-')}_${result.jobId}.json`;
      await writeFile(
        join(this.runLogPath, filename),
        JSON.stringify(result, null, 2),
        'utf-8',
      );
    } catch (err) {
      console.error(`[cron] Failed to save run result: ${err}`);
    }
  }

  private async load(): Promise<void> {
    try {
      const data = await readFile(this.jobsPath, 'utf-8');
      this.jobs = JSON.parse(data) as CronJob[];
    } catch {
      this.jobs = [];
    }
  }

  private async save(): Promise<void> {
    await mkdir(join(this.jobsPath, '..'), { recursive: true });
    await writeFile(this.jobsPath, JSON.stringify(this.jobs, null, 2));
  }
}
