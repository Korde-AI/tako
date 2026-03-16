import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ProjectRole } from '../projects/types.js';

export type InviteStatus = 'pending' | 'accepted' | 'rejected' | 'expired' | 'revoked';

export interface ProjectInvite {
  inviteId: string;
  projectId: string;
  projectSlug: string;
  hostNodeId: string;
  hostNodeName?: string;
  issuedByPrincipalId: string;
  targetNodeId?: string;
  targetHint?: string;
  offeredRole: ProjectRole;
  status: InviteStatus;
  createdAt: string;
  expiresAt?: string;
  respondedAt?: string;
  metadata?: Record<string, unknown>;
}

export class InviteStore {
  private invites = new Map<string, ProjectInvite>();
  private loaded = false;

  constructor(private filePath: string) {}

  async load(): Promise<void> {
    await mkdir(this.parentDir(), { recursive: true });
    const entries = await this.readJsonFile<ProjectInvite[]>([]);
    this.invites = new Map(entries.map((invite) => [invite.inviteId, invite]));
    this.loaded = true;
    await this.expirePending();
  }

  async save(): Promise<void> {
    await mkdir(this.parentDir(), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.list(), null, 2) + '\n', 'utf-8');
  }

  list(): ProjectInvite[] {
    return Array.from(this.invites.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  listPending(): ProjectInvite[] {
    return this.list().filter((invite) => invite.status === 'pending');
  }

  get(inviteId: string): ProjectInvite | null {
    return this.invites.get(inviteId) ?? null;
  }

  async create(input: Omit<ProjectInvite, 'inviteId' | 'status' | 'createdAt'>): Promise<ProjectInvite> {
    await this.ensureLoaded();
    const invite: ProjectInvite = {
      ...input,
      inviteId: crypto.randomUUID(),
      status: 'pending',
      createdAt: new Date().toISOString(),
    };
    this.invites.set(invite.inviteId, invite);
    await this.save();
    return invite;
  }

  async importInvite(invite: ProjectInvite): Promise<ProjectInvite> {
    await this.ensureLoaded();
    this.invites.set(invite.inviteId, invite);
    await this.save();
    return invite;
  }

  async markAccepted(inviteId: string): Promise<ProjectInvite | null> {
    return this.setStatus(inviteId, 'accepted');
  }

  async markRejected(inviteId: string): Promise<ProjectInvite | null> {
    return this.setStatus(inviteId, 'rejected');
  }

  async markRevoked(inviteId: string): Promise<ProjectInvite | null> {
    return this.setStatus(inviteId, 'revoked');
  }

  async expirePending(now = new Date()): Promise<number> {
    await this.ensureLoaded();
    let changed = 0;
    for (const invite of this.invites.values()) {
      if (invite.status !== 'pending' || !invite.expiresAt) continue;
      if (new Date(invite.expiresAt).getTime() > now.getTime()) continue;
      this.invites.set(invite.inviteId, {
        ...invite,
        status: 'expired',
        respondedAt: now.toISOString(),
      });
      changed++;
    }
    if (changed > 0) await this.save();
    return changed;
  }

  private async setStatus(inviteId: string, status: Exclude<InviteStatus, 'pending'>): Promise<ProjectInvite | null> {
    await this.ensureLoaded();
    const existing = this.get(inviteId);
    if (!existing) return null;
    const updated: ProjectInvite = {
      ...existing,
      status,
      respondedAt: new Date().toISOString(),
    };
    this.invites.set(inviteId, updated);
    await this.save();
    return updated;
  }

  private parentDir(): string {
    return dirname(this.filePath);
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  private async readJsonFile<T>(fallback: T): Promise<T> {
    if (!existsSync(this.filePath)) return fallback;
    return JSON.parse(await readFile(this.filePath, 'utf-8')) as T;
  }
}
