/**
 * Symphony status — formatted dashboard output.
 */

import type { OrchestratorState, RunningAgent, SymphonyConfig } from './types.js';

/** Format a duration in ms to a human-readable string. */
function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const remainMinutes = minutes % 60;
  return remainMinutes > 0 ? `${hours}h ${remainMinutes}m` : `${hours}h`;
}

/** Format relative time (e.g. "3m ago"). */
function formatAgo(timestampMs: number): string {
  const delta = Date.now() - timestampMs;
  return `${formatDuration(delta)} ago`;
}

/** Truncate a string to a max length, appending ellipsis. */
function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max - 1) + '…';
}

/** Status emoji for a run status. */
function statusEmoji(status: string): string {
  switch (status) {
    case 'preparing': return '🔧';
    case 'running': return '🔄';
    case 'succeeded': return '✅';
    case 'failed': return '❌';
    case 'timed_out': return '⏱';
    case 'stalled': return '⚠️';
    case 'canceled': return '🚫';
    default: return '❓';
  }
}

/** Format the full Symphony dashboard. */
export function formatStatus(state: OrchestratorState, config: SymphonyConfig): string {
  const lines: string[] = [];
  const maxAgents = config.maxConcurrentAgents ?? 5;
  const interval = formatDuration(config.pollIntervalMs ?? 30000);
  const uptime = formatDuration(Date.now() - state.startedAt);

  lines.push('🎵 Symphony — Project Orchestrator');
  lines.push('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
  lines.push(`Repo: ${config.repo} | Polling: ${interval} | Max agents: ${maxAgents}`);
  lines.push(`Uptime: ${uptime} | Runs: ${state.totalRuns} | ✅ ${state.totalSuccesses} | ❌ ${state.totalFailures}`);
  lines.push('');

  // Running agents
  const running = Array.from(state.running.values());
  lines.push(`Running (${running.length}/${maxAgents}):`);
  if (running.length === 0) {
    lines.push('  (none)');
  } else {
    for (const agent of running) {
      lines.push(formatRunLine(agent));
    }
  }
  lines.push('');

  // Retry queue
  const retries = Array.from(state.retryQueue.values());
  if (retries.length > 0) {
    lines.push(`Retry Queue (${retries.length}):`);
    for (const entry of retries) {
      const dueIn = Math.max(0, entry.dueAtMs - Date.now());
      lines.push(`  #${entry.issueNumber}  ⏳ Due in ${formatDuration(dueIn)}  attempt ${entry.attempt}`);
    }
    lines.push('');
  }

  // Recent completions
  const completed = Array.from(state.completed.values());
  if (completed.length > 0) {
    lines.push(`Recent (${completed.length}):`);
    for (const agent of completed.slice(-10)) {
      lines.push(formatCompletedLine(agent));
    }
  }

  return lines.join('\n');
}

/** Format a single running agent line. */
function formatRunLine(agent: RunningAgent): string {
  const elapsed = formatDuration(Date.now() - agent.startedAt);
  const title = truncate(agent.issueTitle, 24);
  const emoji = statusEmoji(agent.status);
  const status = agent.status.charAt(0).toUpperCase() + agent.status.slice(1);
  return `  #${agent.issueNumber} ${title.padEnd(26)} ${emoji} ${status.padEnd(10)} ${elapsed.padStart(5)}  attempt ${agent.attempt}`;
}

/** Format a single completed agent line. */
function formatCompletedLine(agent: RunningAgent): string {
  const title = truncate(agent.issueTitle, 24);
  const emoji = statusEmoji(agent.status);
  const ago = formatAgo(agent.lastActivityAt);
  const pr = agent.prUrl ? `  PR: ${agent.prUrl}` : '';
  const err = agent.error ? `  Error: ${truncate(agent.error, 40)}` : '';
  return `  #${agent.issueNumber} ${title.padEnd(26)} ${emoji} ${ago}${pr}${err}`;
}

/** Format a single run summary. */
export function formatRunSummary(agent: RunningAgent): string {
  const elapsed = formatDuration(Date.now() - agent.startedAt);
  const emoji = statusEmoji(agent.status);
  const lines = [
    `${emoji} Issue #${agent.issueNumber}: ${agent.issueTitle}`,
    `  Status: ${agent.status} | Elapsed: ${elapsed} | Attempt: ${agent.attempt}`,
    `  Workspace: ${agent.workspacePath}`,
  ];
  if (agent.commits.length > 0) {
    lines.push(`  Commits: ${agent.commits.join(', ')}`);
  }
  if (agent.prUrl) {
    lines.push(`  PR: ${agent.prUrl}`);
  }
  if (agent.error) {
    lines.push(`  Error: ${agent.error}`);
  }
  return lines.join('\n');
}

/** Format run history. */
export function formatHistory(completed: RunningAgent[], limit = 20): string {
  if (completed.length === 0) return 'No completed runs yet.';

  const lines = ['🎵 Symphony — Run History', '━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━', ''];
  const entries = completed.slice(-limit);
  for (const agent of entries) {
    lines.push(formatCompletedLine(agent));
  }
  return lines.join('\n');
}
