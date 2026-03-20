import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Project } from './types.js';

export class ProjectRegistry {
  private projects = new Map<string, Project>();
  private loaded = false;

  constructor(private rootDir: string) {}

  private get projectsFile(): string {
    return join(this.rootDir, 'projects.json');
  }

  async load(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    const projects = await this.readJsonFile<Project[]>(this.projectsFile, []);
    this.projects = new Map(projects.map((project) => [project.projectId, project]));
    this.loaded = true;
  }

  async save(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    await writeFile(this.projectsFile, JSON.stringify(this.list(), null, 2) + '\n', 'utf-8');
  }

  list(): Project[] {
    return Array.from(this.projects.values()).sort((a, b) => a.slug.localeCompare(b.slug));
  }

  get(projectId: string): Project | null {
    return this.projects.get(projectId) ?? null;
  }

  findBySlug(slug: string): Project | null {
    for (const project of this.projects.values()) {
      if (project.slug === slug) return project;
    }
    return null;
  }

  async create(input: {
    slug: string;
    displayName: string;
    ownerPrincipalId: string;
    workspaceRoot?: string;
    collaboration?: Project['collaboration'];
    description?: string;
    metadata?: Record<string, unknown>;
  }): Promise<Project> {
    await this.ensureLoaded();
    if (this.findBySlug(input.slug)) {
      throw new Error(`Project slug already exists: ${input.slug}`);
    }
    const now = new Date().toISOString();
    const project: Project = {
      projectId: crypto.randomUUID(),
      slug: input.slug,
      displayName: input.displayName,
      ownerPrincipalId: input.ownerPrincipalId,
      workspaceRoot: input.workspaceRoot,
      collaboration: input.collaboration,
      status: 'active',
      description: input.description,
      createdAt: now,
      updatedAt: now,
      metadata: input.metadata,
    };
    this.projects.set(project.projectId, project);
    await this.save();
    return project;
  }

  async importProject(project: Project): Promise<Project> {
    await this.ensureLoaded();
    const existingById = this.get(project.projectId);
    const existingBySlug = this.findBySlug(project.slug);
    if (existingBySlug && existingBySlug.projectId !== project.projectId) {
      throw new Error(`Project slug already exists: ${project.slug}`);
    }
    const now = new Date().toISOString();
    const normalized: Project = {
      ...project,
      createdAt: project.createdAt ?? now,
      updatedAt: now,
    };
    this.projects.set(normalized.projectId, existingById ? {
      ...existingById,
      ...normalized,
      projectId: existingById.projectId,
      updatedAt: now,
    } : normalized);
    await this.save();
    return this.projects.get(project.projectId)!;
  }

  async update(projectId: string, patch: Partial<Project>): Promise<Project> {
    await this.ensureLoaded();
    const existing = this.get(projectId);
    if (!existing) throw new Error(`Project not found: ${projectId}`);
    const updated: Project = {
      ...existing,
      ...patch,
      projectId: existing.projectId,
      slug: patch.slug ?? existing.slug,
      updatedAt: new Date().toISOString(),
    };
    if (updated.slug !== existing.slug) {
      const conflict = this.findBySlug(updated.slug);
      if (conflict && conflict.projectId !== projectId) {
        throw new Error(`Project slug already exists: ${updated.slug}`);
      }
    }
    this.projects.set(projectId, updated);
    await this.save();
    return updated;
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  private async readJsonFile<T>(path: string, fallback: T): Promise<T> {
    if (!existsSync(path)) return fallback;
    return JSON.parse(await readFile(path, 'utf-8')) as T;
  }
}
