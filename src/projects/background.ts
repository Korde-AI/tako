import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { NetworkSharedSession } from '../network/shared-sessions.js';
import type { SharedSession } from '../sessions/shared.js';
import type { Project, ProjectArtifact, ProjectBackgroundSnapshot, ProjectWorktree } from './types.js';

export class ProjectBackgroundRegistry {
  private loaded = false;
  private snapshot: ProjectBackgroundSnapshot | null = null;

  constructor(private rootDir: string) {}

  private get snapshotFile(): string {
    return join(this.rootDir, 'background.json');
  }

  async load(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    this.snapshot = await this.readJsonFile<ProjectBackgroundSnapshot | null>(this.snapshotFile, null);
    this.loaded = true;
  }

  get(): ProjectBackgroundSnapshot | null {
    return this.snapshot;
  }

  async save(snapshot: ProjectBackgroundSnapshot): Promise<ProjectBackgroundSnapshot> {
    await this.ensureLoaded();
    this.snapshot = snapshot;
    await writeFile(this.snapshotFile, JSON.stringify(snapshot, null, 2) + '\n', 'utf-8');
    return snapshot;
  }

  async buildAndSave(input: {
    project: Project;
    reason: string;
    sharedSession?: SharedSession | null;
    networkSession?: NetworkSharedSession | null;
    artifacts: ProjectArtifact[];
    worktrees: Array<ProjectWorktree & { branch?: string; dirty?: boolean }>;
  }): Promise<ProjectBackgroundSnapshot> {
    const participantIds = input.sharedSession?.participantIds ?? [];
    const activeParticipantIds = input.sharedSession?.activeParticipantIds ?? [];
    const summary = [
      `Project ${input.project.displayName} (${input.project.slug})`,
      `Reason: ${input.reason}`,
      `Participants: ${participantIds.length}`,
      input.networkSession ? `Participant nodes: ${input.networkSession.participantNodeIds.join(', ')}` : null,
      input.artifacts.length > 0
        ? `Recent artifacts: ${input.artifacts.slice(0, 5).map((artifact) => `${artifact.name} [${artifact.kind}]`).join(', ')}`
        : 'Recent artifacts: none',
      input.worktrees.length > 0
        ? `Worktrees: ${input.worktrees.map((worktree) => `${worktree.nodeId}${worktree.branch ? `:${worktree.branch}` : ''}${worktree.dirty ? '*' : ''}`).join(', ')}`
        : 'Worktrees: none',
    ].filter(Boolean).join('\n');
    return await this.save({
      projectId: input.project.projectId,
      projectSlug: input.project.slug,
      generatedAt: new Date().toISOString(),
      reason: input.reason,
      participantCount: participantIds.length,
      participantIds,
      activeParticipantIds,
      participantNodeIds: input.networkSession?.participantNodeIds,
      recentArtifacts: input.artifacts.slice(0, 10).map((artifact) => ({
        artifactId: artifact.artifactId,
        name: artifact.name,
        kind: artifact.kind,
        sourceNodeId: artifact.sourceNodeId,
        createdAt: artifact.createdAt,
      })),
      worktrees: input.worktrees.map((worktree) => ({
        nodeId: worktree.nodeId,
        root: worktree.root,
        label: worktree.label,
        branch: worktree.branch,
        dirty: worktree.dirty,
      })),
      summary,
    });
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  private async readJsonFile<T>(path: string, fallback: T): Promise<T> {
    if (!existsSync(path)) return fallback;
    return JSON.parse(await readFile(path, 'utf-8')) as T;
  }
}
