import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, normalize, resolve } from 'node:path';
import type { ProjectWorktree } from './types.js';

export class ProjectWorktreeRegistry {
  private worktrees = new Map<string, ProjectWorktree>();
  private loaded = false;

  constructor(
    private rootDir: string,
    private projectId: string,
  ) {}

  private get manifestFile(): string {
    return join(this.rootDir, 'worktrees.json');
  }

  async load(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    const rows = await this.readJsonFile<ProjectWorktree[]>(this.manifestFile, []);
    this.worktrees = new Map(rows.map((worktree) => [worktree.worktreeId, worktree]));
    this.loaded = true;
  }

  async save(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    await writeFile(this.manifestFile, JSON.stringify(this.list(), null, 2) + '\n', 'utf-8');
  }

  list(): ProjectWorktree[] {
    return Array.from(this.worktrees.values()).sort((a, b) => a.nodeId.localeCompare(b.nodeId));
  }

  listByNode(nodeId: string): ProjectWorktree[] {
    return this.list().filter((worktree) => worktree.nodeId === nodeId);
  }

  get(worktreeId: string): ProjectWorktree | null {
    return this.worktrees.get(worktreeId) ?? null;
  }

  findByNode(nodeId: string): ProjectWorktree | null {
    return this.list().find((worktree) => worktree.nodeId === nodeId) ?? null;
  }

  async register(input: {
    nodeId: string;
    root: string;
    label?: string;
    ownerPrincipalId?: string;
    metadata?: Record<string, unknown>;
  }): Promise<ProjectWorktree> {
    await this.ensureLoaded();
    const now = new Date().toISOString();
    const existing = this.findByNode(input.nodeId);
    const worktree: ProjectWorktree = existing
      ? {
          ...existing,
          root: normalize(resolve(input.root)),
          label: input.label ?? existing.label,
          ownerPrincipalId: input.ownerPrincipalId ?? existing.ownerPrincipalId,
          status: 'active',
          updatedAt: now,
          metadata: input.metadata ?? existing.metadata,
        }
      : {
          worktreeId: crypto.randomUUID(),
          projectId: this.projectId,
          nodeId: input.nodeId,
          root: normalize(resolve(input.root)),
          label: input.label,
          ownerPrincipalId: input.ownerPrincipalId,
          status: 'active',
          createdAt: now,
          updatedAt: now,
          metadata: input.metadata,
        };
    this.worktrees.set(worktree.worktreeId, worktree);
    await mkdir(worktree.root, { recursive: true });
    await this.save();
    return worktree;
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  private async readJsonFile<T>(path: string, fallback: T): Promise<T> {
    if (!existsSync(path)) return fallback;
    return JSON.parse(await readFile(path, 'utf-8')) as T;
  }
}
