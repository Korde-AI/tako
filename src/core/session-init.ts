/**
 * Session init protocol — ensures agents start each session productively.
 *
 * After compaction or on a fresh session, injects a structured init sequence
 * that tells the agent to:
 * 1. Read progress file for recent work
 * 2. Check git log for recent commits
 * 3. Run basic health check
 * 4. Pick ONE task to work on
 *
 * This prevents the agent from wasting tokens figuring out context.
 */

import type { ProgressTracker } from './progress.js';

export interface SessionInitConfig {
  /** Enable session init protocol (default: true) */
  enabled: boolean;
  /** Include git log summary (default: true) */
  includeGitLog: boolean;
  /** Number of recent progress entries to include (default: 3) */
  progressEntries: number;
  /** Custom init instructions (appended to default) */
  customInstructions?: string;
}

const DEFAULT_CONFIG: SessionInitConfig = {
  enabled: true,
  includeGitLog: true,
  progressEntries: 3,
};

/**
 * Build the session init prompt to inject after compaction or on new session.
 * This is injected as a system message so the agent follows the protocol.
 */
export function buildSessionInitPrompt(config?: Partial<SessionInitConfig>): string {
  const cfg = { ...DEFAULT_CONFIG, ...config };

  const lines: string[] = [
    '## Session Init Protocol',
    '',
    'You are resuming work on an ongoing project. Before doing anything else:',
    '',
    '1. **Read progress**: Check `tako-progress.json` for what previous sessions accomplished.',
    '2. **Check git**: Run `git log --oneline -10` to see recent commits.',
    '3. **Health check**: Verify the project is in a working state (build passes, no broken tests).',
    '4. **Pick ONE task**: Choose the highest-priority incomplete task and work on it.',
    '',
    '### Work Rules',
    '- Work on **one feature/task at a time**. Complete it, test it, commit it, then move on.',
    '- **Commit frequently** with descriptive messages.',
    '- Before declaring a task done, **verify it works** (run tests, check output).',
    '- At the end of your work session, **update tako-progress.json** with what you did.',
    '- Leave the codebase in a **clean, working state** — no half-implemented features.',
    '',
    '### Do NOT',
    '- Try to implement everything at once.',
    '- Declare the project "done" without verifying all tasks.',
    '- Leave uncommitted changes.',
    '- Skip testing.',
  ];

  if (cfg.customInstructions) {
    lines.push('', '### Additional Instructions', cfg.customInstructions);
  }

  return lines.join('\n');
}

/**
 * Build the full init context including progress summary.
 * Called when a session starts fresh or after compaction.
 */
export async function buildSessionInitContext(
  progressTracker: ProgressTracker,
  config?: Partial<SessionInitConfig>,
): Promise<string> {
  const cfg = { ...DEFAULT_CONFIG, ...config };
  const parts: string[] = [];

  // Add init protocol
  parts.push(buildSessionInitPrompt(cfg));

  // Add progress summary if available
  const summary = await progressTracker.getSummaryForContext(cfg.progressEntries);
  if (summary) {
    parts.push('', summary);
  }

  return parts.join('\n');
}
