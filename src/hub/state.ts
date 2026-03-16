import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { NodeIdentity } from '../core/node-identity.js';
import type { HubMembershipSummary, HubNodeRecord, HubProjectRecord, HubRouteRecord } from './types.js';

export interface HubRuntimeState {
  identity: NodeIdentity;
  bind: string;
  port: number;
  startedAt: number;
  store: HubStateStore;
}

export class HubStateStore {
  private nodes = new Map<string, HubNodeRecord>();
  private projects = new Map<string, HubProjectRecord>();
  private memberships: HubMembershipSummary[] = [];
  private routes = new Map<string, HubRouteRecord>();
  private loaded = false;

  constructor(private rootDir: string) {}

  get nodesFile(): string { return join(this.rootDir, 'nodes.json'); }
  get projectsFile(): string { return join(this.rootDir, 'projects.json'); }
  get membershipsFile(): string { return join(this.rootDir, 'memberships.json'); }
  get routesFile(): string { return join(this.rootDir, 'routes.json'); }

  async load(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    const nodes = await this.readJsonFile<HubNodeRecord[]>(this.nodesFile, []);
    const projects = await this.readJsonFile<HubProjectRecord[]>(this.projectsFile, []);
    const memberships = await this.readJsonFile<HubMembershipSummary[]>(this.membershipsFile, []);
    const routes = await this.readJsonFile<HubRouteRecord[]>(this.routesFile, []);
    this.nodes = new Map(nodes.map((node) => [node.nodeId, node]));
    this.projects = new Map(projects.map((project) => [project.projectId, project]));
    this.memberships = memberships;
    this.routes = new Map(routes.map((route) => [route.projectId, route]));
    this.loaded = true;
  }

  async save(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    await writeFile(this.nodesFile, JSON.stringify(this.listNodes(), null, 2) + '\n', 'utf-8');
    await writeFile(this.projectsFile, JSON.stringify(this.listProjects(), null, 2) + '\n', 'utf-8');
    await writeFile(this.membershipsFile, JSON.stringify(this.memberships, null, 2) + '\n', 'utf-8');
    await writeFile(this.routesFile, JSON.stringify(this.listRoutes(), null, 2) + '\n', 'utf-8');
  }

  listNodes(): HubNodeRecord[] {
    return Array.from(this.nodes.values()).sort((a, b) => a.name.localeCompare(b.name));
  }

  getNode(nodeId: string): HubNodeRecord | null {
    return this.nodes.get(nodeId) ?? null;
  }

  async upsertNode(node: HubNodeRecord): Promise<HubNodeRecord> {
    await this.ensureLoaded();
    this.nodes.set(node.nodeId, node);
    await this.save();
    return node;
  }

  listProjects(): HubProjectRecord[] {
    return Array.from(this.projects.values()).sort((a, b) => a.slug.localeCompare(b.slug));
  }

  getProject(projectId: string): HubProjectRecord | null {
    return this.projects.get(projectId) ?? null;
  }

  findProjectBySlug(slug: string): HubProjectRecord | null {
    for (const project of this.projects.values()) {
      if (project.slug === slug) return project;
    }
    return null;
  }

  async upsertProject(project: HubProjectRecord): Promise<HubProjectRecord> {
    await this.ensureLoaded();
    this.projects.set(project.projectId, project);
    this.routes.set(project.projectId, {
      projectId: project.projectId,
      hostNodeId: project.hostNodeId,
      updatedAt: project.updatedAt,
    });
    await this.save();
    return project;
  }

  listMemberships(projectId?: string): HubMembershipSummary[] {
    return this.memberships.filter((row) => !projectId || row.projectId === projectId);
  }

  async replaceMembershipsForProject(projectId: string, rows: HubMembershipSummary[]): Promise<void> {
    await this.ensureLoaded();
    this.memberships = this.memberships.filter((row) => row.projectId !== projectId).concat(rows);
    await this.save();
  }

  getRoute(projectId: string): HubRouteRecord | null {
    return this.routes.get(projectId) ?? null;
  }

  listRoutes(): HubRouteRecord[] {
    return Array.from(this.routes.values()).sort((a, b) => a.projectId.localeCompare(b.projectId));
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  private async readJsonFile<T>(path: string, fallback: T): Promise<T> {
    if (!existsSync(path)) return fallback;
    return JSON.parse(await readFile(path, 'utf-8')) as T;
  }
}

export async function createHubState(
  identity: NodeIdentity,
  bind: string,
  port: number,
  rootDir: string,
): Promise<HubRuntimeState> {
  const store = new HubStateStore(rootDir);
  await store.load();
  return {
    identity,
    bind,
    port,
    startedAt: Date.now(),
    store,
  };
}
