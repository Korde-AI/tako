/**
 * Symphony types — shared interfaces for the orchestration system.
 */

// ─── Configuration ──────────────────────────────────────────────────

export interface SymphonyConfig {
  /** GitHub repo in owner/repo format. */
  repo: string;
  /** Filter issues by these labels. */
  labels?: string[];
  /** Exclude issues with these labels. */
  excludeLabels?: string[];
  /** Only process issues in these states. Default: ['open']. */
  activeStates?: string[];
  /** Poll interval in milliseconds. Default: 30000. */
  pollIntervalMs?: number;
  /** Max concurrent agents. Default: 5. */
  maxConcurrentAgents?: number;
  /** Max agent loop turns. Default: 20. */
  maxTurns?: number;
  /** Agent timeout in ms. Default: 3600000 (1h). */
  agentTimeoutMs?: number;
  /** Stall detection timeout in ms. Default: 300000 (5min). */
  stallTimeoutMs?: number;
  /** Max retry backoff in ms. Default: 300000 (5min). */
  maxRetryBackoffMs?: number;
  /** Workspace root directory. Default: <home>/symphony-workspaces. */
  workspaceRoot?: string;
  /** Path to WORKFLOW.md. Default: WORKFLOW.md in repo root. */
  workflowPath?: string;
}

// ─── GitHub Issue ───────────────────────────────────────────────────

export interface GitHubIssue {
  number: number;
  title: string;
  body: string;
  state: string;
  labels: string[];
  assignees: string[];
  url: string;
  createdAt: string;
  updatedAt: string;
}

// ─── Run status ─────────────────────────────────────────────────────

export type RunStatus =
  | 'preparing'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'timed_out'
  | 'stalled'
  | 'canceled';

// ─── Running agent ──────────────────────────────────────────────────

export interface RunningAgent {
  issueNumber: number;
  issueTitle: string;
  workspacePath: string;
  startedAt: number;
  status: RunStatus;
  attempt: number;
  lastActivityAt: number;
  pid?: number;
  error?: string;
  commits: string[];
  prUrl?: string;
}

// ─── Retry entry ────────────────────────────────────────────────────

export interface RetryEntry {
  issueNumber: number;
  attempt: number;
  dueAtMs: number;
  error?: string;
  timer?: ReturnType<typeof setTimeout>;
}

// ─── Orchestrator state ─────────────────────────────────────────────

export interface OrchestratorState {
  /** Currently running agents keyed by issue number. */
  running: Map<number, RunningAgent>;
  /** Issue numbers currently claimed (reserved). */
  claimed: Set<number>;
  /** Retry queue keyed by issue number. */
  retryQueue: Map<number, RetryEntry>;
  /** Recently completed runs keyed by issue number. */
  completed: Map<number, RunningAgent>;
  /** When the orchestrator started. */
  startedAt: number;
  /** Total runs dispatched. */
  totalRuns: number;
  /** Total successful runs. */
  totalSuccesses: number;
  /** Total failed runs. */
  totalFailures: number;
}

// ─── Workflow definition ────────────────────────────────────────────

export interface WorkflowDefinition {
  config: Record<string, unknown>;
  promptTemplate: string;
}
