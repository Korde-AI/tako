import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectMembership, ProjectRole } from './types.js';

export class ProjectMembershipRegistry {
  private memberships = new Map<string, ProjectMembership>();
  private loaded = false;

  constructor(private rootDir: string) {}

  private get membershipsFile(): string {
    return join(this.rootDir, 'memberships.json');
  }

  private key(projectId: string, principalId: string): string {
    return `${projectId}:${principalId}`;
  }

  async load(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    const memberships = await this.readJsonFile<ProjectMembership[]>(this.membershipsFile, []);
    this.memberships = new Map(memberships.map((m) => [this.key(m.projectId, m.principalId), m]));
    this.loaded = true;
  }

  async save(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    await writeFile(this.membershipsFile, JSON.stringify(this.list(), null, 2) + '\n', 'utf-8');
  }

  list(): ProjectMembership[] {
    return Array.from(this.memberships.values()).sort((a, b) =>
      this.key(a.projectId, a.principalId).localeCompare(this.key(b.projectId, b.principalId)));
  }

  listByProject(projectId: string): ProjectMembership[] {
    return this.list().filter((m) => m.projectId === projectId);
  }

  listByPrincipal(principalId: string): ProjectMembership[] {
    return this.list().filter((m) => m.principalId === principalId);
  }

  get(projectId: string, principalId: string): ProjectMembership | null {
    return this.memberships.get(this.key(projectId, principalId)) ?? null;
  }

  async upsert(input: {
    projectId: string;
    principalId: string;
    role: ProjectRole;
    addedBy: string;
  }): Promise<ProjectMembership> {
    await this.ensureLoaded();
    const existing = this.get(input.projectId, input.principalId);
    const now = new Date().toISOString();
    const membership: ProjectMembership = existing
      ? {
          ...existing,
          role: input.role,
          updatedAt: now,
        }
      : {
          projectId: input.projectId,
          principalId: input.principalId,
          role: input.role,
          addedBy: input.addedBy,
          addedAt: now,
          updatedAt: now,
        };
    this.memberships.set(this.key(input.projectId, input.principalId), membership);
    await this.save();
    return membership;
  }

  async remove(projectId: string, principalId: string): Promise<boolean> {
    await this.ensureLoaded();
    const deleted = this.memberships.delete(this.key(projectId, principalId));
    if (deleted) await this.save();
    return deleted;
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  private async readJsonFile<T>(path: string, fallback: T): Promise<T> {
    if (!existsSync(path)) return fallback;
    return JSON.parse(await readFile(path, 'utf-8')) as T;
  }
}
