import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { ProjectBranchRecord } from './types.js';

export class ProjectBranchRegistry {
  private branches = new Map<string, ProjectBranchRecord>();
  private loaded = false;

  constructor(
    private rootDir: string,
    private projectId: string,
  ) {}

  private get branchesFile(): string {
    return join(this.rootDir, 'branches.json');
  }

  async load(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    const rows = await this.readJsonFile<ProjectBranchRecord[]>(this.branchesFile, []);
    this.branches = new Map(rows.map((row) => [row.branchRecordId, row]));
    this.loaded = true;
  }

  list(): ProjectBranchRecord[] {
    return Array.from(this.branches.values()).sort((a, b) => a.nodeId.localeCompare(b.nodeId) || a.branchName.localeCompare(b.branchName));
  }

  findByNode(nodeId: string): ProjectBranchRecord[] {
    return this.list().filter((row) => row.nodeId === nodeId);
  }

  async register(input: {
    nodeId: string;
    branchName: string;
    baseBranch?: string;
    worktreeRoot?: string;
  }): Promise<ProjectBranchRecord> {
    await this.ensureLoaded();
    const existing = this.list().find((row) => row.nodeId === input.nodeId && row.branchName === input.branchName);
    const now = new Date().toISOString();
    const branch: ProjectBranchRecord = existing
      ? {
          ...existing,
          baseBranch: input.baseBranch ?? existing.baseBranch,
          worktreeRoot: input.worktreeRoot ?? existing.worktreeRoot,
          status: 'active',
          updatedAt: now,
        }
      : {
          branchRecordId: crypto.randomUUID(),
          projectId: this.projectId,
          nodeId: input.nodeId,
          branchName: input.branchName,
          baseBranch: input.baseBranch,
          worktreeRoot: input.worktreeRoot,
          status: 'active',
          createdAt: now,
          updatedAt: now,
        };
    this.branches.set(branch.branchRecordId, branch);
    await this.save();
    return branch;
  }

  async mark(branchRecordId: string, status: ProjectBranchRecord['status']): Promise<ProjectBranchRecord> {
    await this.ensureLoaded();
    const row = this.branches.get(branchRecordId);
    if (!row) throw new Error(`Branch record not found: ${branchRecordId}`);
    const updated = { ...row, status, updatedAt: new Date().toISOString() };
    this.branches.set(branchRecordId, updated);
    await this.save();
    return updated;
  }

  async markConflict(branchRecordId: string, conflictArtifactId: string, conflictSummary: string): Promise<ProjectBranchRecord> {
    await this.ensureLoaded();
    const row = this.branches.get(branchRecordId);
    if (!row) throw new Error(`Branch record not found: ${branchRecordId}`);
    const updated: ProjectBranchRecord = {
      ...row,
      status: 'conflict',
      conflictArtifactId,
      conflictSummary,
      updatedAt: new Date().toISOString(),
    };
    this.branches.set(branchRecordId, updated);
    await this.save();
    return updated;
  }

  async save(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    await writeFile(this.branchesFile, JSON.stringify(this.list(), null, 2) + '\n', 'utf-8');
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  private async readJsonFile<T>(path: string, fallback: T): Promise<T> {
    if (!existsSync(path)) return fallback;
    return JSON.parse(await readFile(path, 'utf-8')) as T;
  }
}
