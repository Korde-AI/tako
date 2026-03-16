import { copyFile, mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { basename, dirname, join, normalize } from 'node:path';
import type { ProjectArtifact } from './types.js';

export class ProjectArtifactRegistry {
  private artifacts = new Map<string, ProjectArtifact>();
  private loaded = false;

  constructor(
    private rootDir: string,
    private projectId: string,
  ) {}

  private get manifestFile(): string {
    return join(this.rootDir, 'artifacts.json');
  }

  async load(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    const rows = await this.readJsonFile<ProjectArtifact[]>(this.manifestFile, []);
    this.artifacts = new Map(rows.map((artifact) => [artifact.artifactId, artifact]));
    this.loaded = true;
  }

  async save(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    await writeFile(this.manifestFile, JSON.stringify(this.list(), null, 2) + '\n', 'utf-8');
  }

  list(): ProjectArtifact[] {
    return Array.from(this.artifacts.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  get(artifactId: string): ProjectArtifact | null {
    return this.artifacts.get(artifactId) ?? null;
  }

  async publish(input: {
    sourcePath: string;
    name?: string;
    kind?: ProjectArtifact['kind'];
    publishedByPrincipalId: string;
    sourceNodeId?: string;
    description?: string;
    metadata?: Record<string, unknown>;
  }): Promise<ProjectArtifact> {
    await this.ensureLoaded();
    const createdAt = new Date().toISOString();
    const artifactId = crypto.randomUUID();
    const safeName = sanitizeArtifactName(input.name ?? basename(input.sourcePath));
    const relativePath = normalize(join('shared', `${artifactId}-${safeName}`));
    const destination = join(this.rootDir, relativePath);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(input.sourcePath, destination);
    const size = (await stat(destination)).size;
    const artifact: ProjectArtifact = {
      artifactId,
      projectId: this.projectId,
      name: input.name ?? safeName,
      relativePath,
      publishedByPrincipalId: input.publishedByPrincipalId,
      sourceNodeId: input.sourceNodeId,
      scope: 'shared',
      kind: input.kind ?? 'file',
      sizeBytes: size,
      description: input.description,
      createdAt,
      updatedAt: createdAt,
      metadata: input.metadata,
    };
    this.artifacts.set(artifactId, artifact);
    await this.save();
    return artifact;
  }

  async importShared(input: {
    artifact: ProjectArtifact;
    contentBase64: string;
  }): Promise<ProjectArtifact> {
    await this.ensureLoaded();
    const destination = this.resolvePath(input.artifact);
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, Buffer.from(input.contentBase64, 'base64'));
    const size = (await stat(destination)).size;
    const artifact: ProjectArtifact = {
      ...input.artifact,
      projectId: this.projectId,
      scope: 'shared',
      sizeBytes: size,
      updatedAt: new Date().toISOString(),
    };
    this.artifacts.set(artifact.artifactId, artifact);
    await this.save();
    return artifact;
  }

  resolvePath(artifact: ProjectArtifact): string {
    return join(this.rootDir, artifact.relativePath);
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  private async readJsonFile<T>(path: string, fallback: T): Promise<T> {
    if (!existsSync(path)) return fallback;
    return JSON.parse(await readFile(path, 'utf-8')) as T;
  }
}

function sanitizeArtifactName(name: string): string {
  return name
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80) || 'artifact';
}
