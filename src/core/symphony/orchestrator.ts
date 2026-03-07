/**
 * Symphony Orchestrator — polls GitHub issues and dispatches agent workers.
 *
 * Implements the core Symphony loop:
 * 1. Poll → Reconcile → Dispatch → Monitor
 *
 * State is in-memory (no database required). Recovery is tracker-driven.
 */

import { execSync, spawn, type ChildProcess } from 'node:child_process';
import { join } from 'node:path';
import { mkdirSync, existsSync, writeFileSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import type {
  SymphonyConfig,
  GitHubIssue,
  RunningAgent,
  RetryEntry,
  OrchestratorState,
  RunStatus,
} from './types.js';
import { WorkspaceManager } from './workspace.js';
import { WorkflowLoader, slugify } from './workflow.js';
import type { WorkflowDefinition } from './types.js';

const MAX_RETRY_ATTEMPTS = 3;

/** Singleton Symphony orchestrator. */
let instance: SymphonyOrchestrator | null = null;

export class SymphonyOrchestrator {
  private config: SymphonyConfig;
  private state: OrchestratorState;
  private workspace: WorkspaceManager;
  private workflowLoader: WorkflowLoader;
  private workflow: WorkflowDefinition;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private processes = new Map<number, ChildProcess>();
  private historyDir: string;

  private constructor(config: SymphonyConfig) {
    this.config = config;
    this.state = {
      running: new Map(),
      claimed: new Set(),
      retryQueue: new Map(),
      completed: new Map(),
      startedAt: Date.now(),
      totalRuns: 0,
      totalSuccesses: 0,
      totalFailures: 0,
    };

    const root = config.workspaceRoot ?? join(homedir(), '.tako', 'symphony-workspaces');
    this.workspace = new WorkspaceManager(root, config.repo);
    this.workflowLoader = new WorkflowLoader();

    // Load WORKFLOW.md
    const workflowPath = config.workflowPath ?? 'WORKFLOW.md';
    this.workflow = this.workflowLoader.load(workflowPath);

    // Apply WORKFLOW.md config overrides
    this.applyWorkflowConfig();

    // Watch for hot-reload
    this.workflowLoader.watch(workflowPath, (def) => {
      this.workflow = def;
      this.applyWorkflowConfig();
    });

    // Ensure history directory exists
    this.historyDir = join(homedir(), '.tako', 'symphony', 'runs');
    mkdirSync(this.historyDir, { recursive: true });
  }

  /** Get or create the singleton orchestrator. */
  static getInstance(config?: SymphonyConfig): SymphonyOrchestrator | null {
    if (!instance && config) {
      instance = new SymphonyOrchestrator(config);
    }
    return instance;
  }

  /** Destroy the singleton (for testing or shutdown). */
  static destroyInstance(): void {
    if (instance) {
      instance.stop();
      instance = null;
    }
  }

  /** Apply WORKFLOW.md config to the runtime config. */
  private applyWorkflowConfig(): void {
    const wc = this.workflow.config;
    if (!wc || typeof wc !== 'object') return;

    const tracker = wc.tracker as Record<string, unknown> | undefined;
    if (tracker) {
      if (Array.isArray(tracker.labels)) this.config.labels = tracker.labels as string[];
      if (Array.isArray(tracker.active_states)) this.config.activeStates = tracker.active_states as string[];
      if (Array.isArray(tracker.exclude_labels)) this.config.excludeLabels = tracker.exclude_labels as string[];
    }

    const polling = wc.polling as Record<string, unknown> | undefined;
    if (polling?.interval_ms) this.config.pollIntervalMs = polling.interval_ms as number;

    const agent = wc.agent as Record<string, unknown> | undefined;
    if (agent) {
      if (agent.max_concurrent) this.config.maxConcurrentAgents = agent.max_concurrent as number;
      if (agent.max_turns) this.config.maxTurns = agent.max_turns as number;
      if (agent.timeout_ms) this.config.agentTimeoutMs = agent.timeout_ms as number;
      if (agent.stall_timeout_ms) this.config.stallTimeoutMs = agent.stall_timeout_ms as number;
    }

    const ws = wc.workspace as Record<string, unknown> | undefined;
    if (ws?.root) {
      const root = (ws.root as string).replace('~', homedir());
      this.config.workspaceRoot = root;
      this.workspace = new WorkspaceManager(root, this.config.repo);
    }
  }

  /** Start the polling loop. */
  start(): void {
    if (this.pollTimer) return; // Already running

    const intervalMs = this.config.pollIntervalMs ?? 30000;
    console.log(`[symphony] Starting — repo: ${this.config.repo}, interval: ${intervalMs}ms`);

    // Run first tick immediately
    void this.pollTick();

    this.pollTimer = setInterval(() => {
      void this.pollTick();
    }, intervalMs);
  }

  /** Stop polling, kill all agents. */
  stop(): void {
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }

    // Cancel all retry timers
    for (const entry of this.state.retryQueue.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    this.state.retryQueue.clear();

    // Kill all running processes
    for (const [issueNumber, proc] of this.processes) {
      try {
        proc.kill('SIGTERM');
      } catch {
        // Process may already be dead
      }
      const agent = this.state.running.get(issueNumber);
      if (agent) {
        agent.status = 'canceled';
        agent.lastActivityAt = Date.now();
        this.state.completed.set(issueNumber, agent);
      }
    }
    this.state.running.clear();
    this.state.claimed.clear();
    this.processes.clear();

    // Stop workflow watcher
    const workflowPath = this.config.workflowPath ?? 'WORKFLOW.md';
    this.workflowLoader.unwatch(workflowPath);

    console.log('[symphony] Stopped.');
  }

  /** Whether the orchestrator is currently running. */
  isRunning(): boolean {
    return this.pollTimer !== null;
  }

  /** Get current state for dashboard. */
  getState(): OrchestratorState {
    return this.state;
  }

  /** Get current config. */
  getConfig(): SymphonyConfig {
    return this.config;
  }

  /** One poll cycle: reconcile → fetch → dispatch. */
  async pollTick(): Promise<void> {
    try {
      await this.reconcile();
      const candidates = await this.fetchCandidateIssues();
      for (const issue of candidates) {
        if (this.canDispatch()) {
          await this.dispatchIssue(issue);
        }
      }
    } catch (err) {
      console.error('[symphony] Poll tick error:', (err as Error).message);
    }
  }

  /** Check running agents, detect stalls, update states. */
  async reconcile(): Promise<void> {
    const now = Date.now();
    const stallTimeout = this.config.stallTimeoutMs ?? 300000;
    const agentTimeout = this.config.agentTimeoutMs ?? 3600000;

    for (const [issueNumber, agent] of this.state.running) {
      // Check if process is still alive
      const proc = this.processes.get(issueNumber);
      if (proc && proc.exitCode !== null) {
        // Process exited
        const success = proc.exitCode === 0;
        this.handleWorkerExit(issueNumber, success, success ? undefined : `Exit code ${proc.exitCode}`);
        continue;
      }

      // Check for agent timeout
      if (now - agent.startedAt > agentTimeout) {
        agent.status = 'timed_out';
        agent.lastActivityAt = now;
        this.killProcess(issueNumber);
        this.handleWorkerExit(issueNumber, false, 'Agent timed out');
        continue;
      }

      // Check for stall
      if (now - agent.lastActivityAt > stallTimeout) {
        agent.status = 'stalled';
        console.log(`[symphony] Stall detected: issue #${issueNumber}`);
        this.killProcess(issueNumber);
        this.handleWorkerExit(issueNumber, false, 'Agent stalled — no activity');
      }
    }
  }

  /** Fetch candidate issues from GitHub. */
  async fetchCandidateIssues(): Promise<GitHubIssue[]> {
    const states = this.config.activeStates ?? ['open'];

    let cmd = `gh issue list --repo ${this.config.repo} --state ${states[0]}`;
    cmd += ' --json number,title,body,state,labels,assignees,url,createdAt,updatedAt --limit 50';

    if (this.config.labels?.length) {
      for (const label of this.config.labels) {
        cmd += ` --label "${label}"`;
      }
    }

    let result: string;
    try {
      result = execSync(cmd, { encoding: 'utf-8', timeout: 30000 });
    } catch (err) {
      console.error('[symphony] Failed to fetch issues:', (err as Error).message);
      return [];
    }

    let issues: GitHubIssue[];
    try {
      const raw = JSON.parse(result) as Array<{
        number: number;
        title: string;
        body: string;
        state: string;
        labels: Array<{ name: string }>;
        assignees: Array<{ login: string }>;
        url: string;
        createdAt: string;
        updatedAt: string;
      }>;
      issues = raw.map((r) => ({
        number: r.number,
        title: r.title,
        body: r.body ?? '',
        state: r.state,
        labels: r.labels.map((l) => l.name),
        assignees: r.assignees.map((a) => a.login),
        url: r.url,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }));
    } catch {
      return [];
    }

    // Filter out excluded labels, claimed issues, running issues, retrying issues
    return issues.filter((issue) => {
      if (this.state.claimed.has(issue.number)) return false;
      if (this.state.running.has(issue.number)) return false;
      if (this.state.retryQueue.has(issue.number)) return false;

      if (this.config.excludeLabels?.length) {
        if (issue.labels.some((l) => this.config.excludeLabels!.includes(l))) return false;
      }

      return true;
    });
  }

  /** Check if we can dispatch another agent. */
  private canDispatch(): boolean {
    const max = this.config.maxConcurrentAgents ?? 5;
    return this.state.running.size < max;
  }

  /** Create workspace and spawn agent for an issue. */
  async dispatchIssue(issue: GitHubIssue, attempt = 1): Promise<void> {
    this.state.claimed.add(issue.number);

    const agent: RunningAgent = {
      issueNumber: issue.number,
      issueTitle: issue.title,
      workspacePath: '',
      startedAt: Date.now(),
      status: 'preparing',
      attempt,
      lastActivityAt: Date.now(),
      commits: [],
    };

    try {
      // Create workspace
      const { path: wsPath } = await this.workspace.prepare(issue);
      agent.workspacePath = wsPath;

      // Run before_run hook
      const hooks = this.workflow.config.hooks as Record<string, string> | undefined;
      if (hooks?.before_run) {
        await this.workspace.runHook(hooks.before_run, wsPath, 60000);
      }

      // Build agent prompt
      const prompt = this.buildAgentPrompt(issue, attempt);

      // Spawn agent process
      agent.status = 'running';
      this.state.running.set(issue.number, agent);
      this.state.totalRuns++;

      const proc = this.spawnAgent(issue.number, prompt, wsPath);
      this.processes.set(issue.number, proc);
      agent.pid = proc.pid;

      console.log(`[symphony] Dispatched agent for #${issue.number}: ${issue.title} (attempt ${attempt})`);
    } catch (err) {
      agent.status = 'failed';
      agent.error = (err as Error).message;
      agent.lastActivityAt = Date.now();
      this.state.running.delete(issue.number);
      this.state.claimed.delete(issue.number);
      this.state.totalFailures++;
      console.error(`[symphony] Failed to dispatch #${issue.number}:`, (err as Error).message);
    }
  }

  /** Build the full agent prompt from WORKFLOW.md + issue context. */
  private buildAgentPrompt(issue: GitHubIssue, attempt: number): string {
    const rendered = this.workflowLoader.renderPrompt(
      this.workflow.promptTemplate,
      issue,
      attempt,
    );

    const context = [
      `# Issue #${issue.number}: ${issue.title}`,
      '',
      issue.body,
      '',
      `Labels: ${issue.labels.join(', ') || 'none'}`,
      `URL: ${issue.url}`,
      attempt > 1 ? `\nThis is retry attempt ${attempt}.` : '',
    ].join('\n');

    return rendered ? `${rendered}\n\n---\n\n${context}` : context;
  }

  /** Spawn a background agent process. */
  private spawnAgent(issueNumber: number, prompt: string, cwd: string): ChildProcess {
    // Write prompt to a temp file
    const promptFile = join(cwd, '.symphony-prompt.md');
    writeFileSync(promptFile, prompt, 'utf-8');

    // Spawn tako agent in the workspace
    const proc = spawn('tako', ['start', '--background'], {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
      env: {
        ...process.env,
        SYMPHONY_ISSUE: String(issueNumber),
        SYMPHONY_PROMPT_FILE: promptFile,
      },
    });

    // Send the prompt to stdin
    if (proc.stdin) {
      proc.stdin.write(prompt);
      proc.stdin.end();
    }

    // Track activity from stdout
    proc.stdout?.on('data', () => {
      const agent = this.state.running.get(issueNumber);
      if (agent) agent.lastActivityAt = Date.now();
    });

    // Handle exit
    proc.on('exit', (code) => {
      const success = code === 0;
      this.handleWorkerExit(issueNumber, success, success ? undefined : `Exit code ${code}`);
    });

    proc.on('error', (err) => {
      this.handleWorkerExit(issueNumber, false, err.message);
    });

    proc.unref();
    return proc;
  }

  /** Handle agent process exit. */
  handleWorkerExit(issueNumber: number, success: boolean, error?: string): void {
    const agent = this.state.running.get(issueNumber);
    if (!agent) return;

    this.processes.delete(issueNumber);
    this.state.running.delete(issueNumber);

    if (success) {
      agent.status = 'succeeded';
      agent.lastActivityAt = Date.now();
      this.state.totalSuccesses++;
      this.state.claimed.delete(issueNumber);

      // Try to detect PR URL from git log
      try {
        const prOutput = execSync(
          `gh pr list --repo ${this.config.repo} --head fix/${issueNumber}-* --json url --limit 1`,
          { encoding: 'utf-8', timeout: 10000 },
        );
        const prs = JSON.parse(prOutput) as Array<{ url: string }>;
        if (prs.length > 0) agent.prUrl = prs[0].url;
      } catch {
        // PR detection is best-effort
      }
    } else {
      agent.status = 'failed';
      agent.error = error;
      agent.lastActivityAt = Date.now();
      this.state.totalFailures++;

      // Schedule retry if under limit
      if (agent.attempt < MAX_RETRY_ATTEMPTS) {
        this.scheduleRetry(issueNumber, agent.attempt, error);
      } else {
        this.state.claimed.delete(issueNumber);
      }
    }

    this.state.completed.set(issueNumber, { ...agent });
    this.persistRun(agent);
  }

  /** Schedule a retry with exponential backoff. */
  scheduleRetry(issueNumber: number, currentAttempt: number, error?: string): void {
    const maxBackoff = this.config.maxRetryBackoffMs ?? 300000;
    const backoff = Math.min(1000 * Math.pow(2, currentAttempt), maxBackoff);
    const dueAtMs = Date.now() + backoff;

    const entry: RetryEntry = {
      issueNumber,
      attempt: currentAttempt + 1,
      dueAtMs,
      error,
    };

    entry.timer = setTimeout(async () => {
      this.state.retryQueue.delete(issueNumber);
      // Re-fetch issue to get latest state
      try {
        const result = execSync(
          `gh issue view ${issueNumber} --repo ${this.config.repo} --json number,title,body,state,labels,assignees,url,createdAt,updatedAt`,
          { encoding: 'utf-8', timeout: 10000 },
        );
        const raw = JSON.parse(result) as {
          number: number;
          title: string;
          body: string;
          state: string;
          labels: Array<{ name: string }>;
          assignees: Array<{ login: string }>;
          url: string;
          createdAt: string;
          updatedAt: string;
        };
        const issue: GitHubIssue = {
          ...raw,
          labels: raw.labels.map((l) => l.name),
          assignees: raw.assignees.map((a) => a.login),
          body: raw.body ?? '',
        };

        if (issue.state === 'open') {
          await this.dispatchIssue(issue, entry.attempt);
        } else {
          this.state.claimed.delete(issueNumber);
        }
      } catch (err) {
        console.error(`[symphony] Retry fetch failed for #${issueNumber}:`, (err as Error).message);
        this.state.claimed.delete(issueNumber);
      }
    }, backoff);

    this.state.retryQueue.set(issueNumber, entry);
    console.log(`[symphony] Scheduled retry for #${issueNumber} in ${backoff}ms (attempt ${entry.attempt})`);
  }

  /** Kill a running process. */
  private killProcess(issueNumber: number): void {
    const proc = this.processes.get(issueNumber);
    if (proc) {
      try {
        proc.kill('SIGTERM');
      } catch {
        // Process may already be dead
      }
    }
  }

  /** Persist a completed run to disk for history. */
  private persistRun(agent: RunningAgent): void {
    try {
      const filename = `${agent.issueNumber}-${Date.now()}.json`;
      const path = join(this.historyDir, filename);
      writeFileSync(path, JSON.stringify(agent, null, 2), 'utf-8');
    } catch {
      // History persistence is best-effort
    }
  }

  /** Check if a specific issue is eligible for dispatch. */
  isEligible(issue: GitHubIssue): boolean {
    if (this.state.claimed.has(issue.number)) return false;
    if (this.state.running.has(issue.number)) return false;
    if (this.state.retryQueue.has(issue.number)) return false;
    if (this.config.excludeLabels?.length) {
      if (issue.labels.some((l) => this.config.excludeLabels!.includes(l))) return false;
    }
    return true;
  }
}
