/**
 * Workspace manager — create, prepare, and clean per-issue workspaces.
 */

import { execSync } from 'node:child_process';
import { join } from 'node:path';
import { mkdirSync, existsSync, rmSync } from 'node:fs';
import type { GitHubIssue } from './types.js';
import { slugify } from './workflow.js';

export class WorkspaceManager {
  constructor(
    private root: string,
    private repo: string,
  ) {}

  /** Get workspace path for an issue. */
  getPath(issueNumber: number, issueTitle?: string): string {
    const repoName = this.repo.replace('/', '-');
    const titleSlug = issueTitle ? slugify(issueTitle) : '';
    const dirName = titleSlug
      ? `issue-${issueNumber}-${titleSlug}`
      : `issue-${issueNumber}`;
    return join(this.root, repoName, dirName);
  }

  /**
   * Create workspace directory and clone the repo.
   * Uses git worktree if a local clone already exists, otherwise clones fresh.
   */
  async prepare(issue: GitHubIssue): Promise<{ path: string; created: boolean }> {
    const wsPath = this.getPath(issue.number, issue.title);

    if (existsSync(wsPath)) {
      return { path: wsPath, created: false };
    }

    mkdirSync(wsPath, { recursive: true });

    // Check if we have a base clone we can worktree from
    const repoName = this.repo.replace('/', '-');
    const baseClone = join(this.root, repoName, '.base');

    if (existsSync(join(baseClone, '.git'))) {
      // Update base and create worktree
      try {
        execSync('git fetch origin', { cwd: baseClone, stdio: 'pipe' });
      } catch {
        // Fetch may fail if offline — continue with stale base
      }
      const branch = `fix/${issue.number}-${slugify(issue.title)}`;
      // Remove the empty dir so worktree can create it
      rmSync(wsPath, { recursive: true, force: true });
      execSync(
        `git worktree add "${wsPath}" -b "${branch}" origin/HEAD`,
        { cwd: baseClone, stdio: 'pipe' },
      );
    } else {
      // No base clone — do a fresh clone
      mkdirSync(join(this.root, repoName), { recursive: true });
      execSync(
        `gh repo clone ${this.repo} "${baseClone}" -- --bare`,
        { stdio: 'pipe' },
      );
      const branch = `fix/${issue.number}-${slugify(issue.title)}`;
      rmSync(wsPath, { recursive: true, force: true });
      execSync(
        `git worktree add "${wsPath}" -b "${branch}" HEAD`,
        { cwd: baseClone, stdio: 'pipe' },
      );
    }

    return { path: wsPath, created: true };
  }

  /** Run a lifecycle hook script in the workspace. */
  async runHook(hookScript: string, cwd: string, timeoutMs: number): Promise<void> {
    if (!hookScript.trim()) return;
    execSync(hookScript, {
      cwd,
      stdio: 'pipe',
      timeout: timeoutMs,
      shell: '/bin/bash',
    });
  }

  /** Clean up a workspace by removing the worktree. */
  async cleanup(issueNumber: number, issueTitle?: string): Promise<void> {
    const wsPath = this.getPath(issueNumber, issueTitle);
    if (!existsSync(wsPath)) return;

    // Try to remove git worktree first
    const repoName = this.repo.replace('/', '-');
    const baseClone = join(this.root, repoName, '.base');
    if (existsSync(baseClone)) {
      try {
        execSync(`git worktree remove "${wsPath}" --force`, {
          cwd: baseClone,
          stdio: 'pipe',
        });
        return;
      } catch {
        // Fall through to manual removal
      }
    }

    rmSync(wsPath, { recursive: true, force: true });
  }
}
