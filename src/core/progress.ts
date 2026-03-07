/**
 * Progress tracker — structured JSON log of what each session accomplished.
 *
 * Inspired by Anthropic's claude-progress.txt but using JSON (models are
 * less likely to corrupt JSON vs Markdown).
 *
 * The progress file lives in the agent workspace at `tako-progress.json`.
 * Each session appends an entry at the end. The agent reads it at session
 * start to understand what happened before.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface ProgressEntry {
  /** Session ID that created this entry */
  sessionId: string;
  /** ISO timestamp */
  timestamp: string;
  /** What features/tasks were worked on */
  featuresWorkedOn: string[];
  /** Files that were changed */
  filesChanged: string[];
  /** Key decisions made */
  decisionsMade: string[];
  /** Issues encountered or unresolved */
  blockers: string[];
  /** Recommended next steps */
  nextSteps: string[];
  /** Git commit hashes created during this session */
  commits: string[];
  /** Compaction count at time of writing (tracks how many compactions happened) */
  compactionCount: number;
}

export interface ProgressFile {
  version: 1;
  projectName: string;
  entries: ProgressEntry[];
}

export class ProgressTracker {
  private filePath: string;

  constructor(workspaceDir: string) {
    this.filePath = join(workspaceDir, 'tako-progress.json');
  }

  /** Read the progress file. Returns null if it doesn't exist. */
  async read(): Promise<ProgressFile | null> {
    if (!existsSync(this.filePath)) return null;
    try {
      const raw = await readFile(this.filePath, 'utf-8');
      return JSON.parse(raw) as ProgressFile;
    } catch {
      return null;
    }
  }

  /** Append a new progress entry. Creates the file if it doesn't exist. */
  async append(entry: ProgressEntry, projectName?: string): Promise<void> {
    let file = await this.read();
    if (!file) {
      file = { version: 1, projectName: projectName ?? 'tako', entries: [] };
    }

    // Keep last 20 entries to prevent unbounded growth
    if (file.entries.length >= 20) {
      file.entries = file.entries.slice(-19);
    }

    file.entries.push(entry);
    await writeFile(this.filePath, JSON.stringify(file, null, 2), 'utf-8');
  }

  /** Get the most recent N entries. */
  async getRecent(count: number = 5): Promise<ProgressEntry[]> {
    const file = await this.read();
    if (!file) return [];
    return file.entries.slice(-count);
  }

  /** Get a summary string suitable for injecting into context. */
  async getSummaryForContext(maxEntries: number = 3): Promise<string | null> {
    const entries = await this.getRecent(maxEntries);
    if (entries.length === 0) return null;

    const lines: string[] = ['## Recent Progress'];
    for (const entry of entries) {
      lines.push(`\n### Session ${entry.sessionId.slice(0, 8)} (${entry.timestamp})`);
      if (entry.featuresWorkedOn.length > 0) {
        lines.push(`**Worked on:** ${entry.featuresWorkedOn.join(', ')}`);
      }
      if (entry.filesChanged.length > 0) {
        lines.push(`**Files changed:** ${entry.filesChanged.join(', ')}`);
      }
      if (entry.decisionsMade.length > 0) {
        lines.push(`**Decisions:** ${entry.decisionsMade.join('; ')}`);
      }
      if (entry.blockers.length > 0) {
        lines.push(`**Blockers:** ${entry.blockers.join('; ')}`);
      }
      if (entry.nextSteps.length > 0) {
        lines.push(`**Next steps:** ${entry.nextSteps.join('; ')}`);
      }
      if (entry.commits.length > 0) {
        lines.push(`**Commits:** ${entry.commits.join(', ')}`);
      }
    }

    return lines.join('\n');
  }
}
