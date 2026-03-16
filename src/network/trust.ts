import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ProjectRole } from '../projects/types.js';

export type TrustStatus = 'pending' | 'trusted' | 'revoked' | 'rejected';

export interface TrustRecord {
  trustId: string;
  remoteNodeId: string;
  remoteNodeName?: string;
  status: TrustStatus;
  authorityCeiling: ProjectRole;
  establishedAt?: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export class TrustStore {
  private records = new Map<string, TrustRecord>();
  private loaded = false;

  constructor(private filePath: string) {}

  async load(): Promise<void> {
    await mkdir(this.parentDir(), { recursive: true });
    const entries = await this.readJsonFile<TrustRecord[]>([]);
    this.records = new Map(entries.map((record) => [record.remoteNodeId, record]));
    this.loaded = true;
  }

  async save(): Promise<void> {
    await mkdir(this.parentDir(), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.list(), null, 2) + '\n', 'utf-8');
  }

  list(): TrustRecord[] {
    return Array.from(this.records.values()).sort((a, b) => a.remoteNodeId.localeCompare(b.remoteNodeId));
  }

  getByNodeId(remoteNodeId: string): TrustRecord | null {
    return this.records.get(remoteNodeId) ?? null;
  }

  async createPending(input: {
    remoteNodeId: string;
    remoteNodeName?: string;
    authorityCeiling: ProjectRole;
    metadata?: Record<string, unknown>;
  }): Promise<TrustRecord> {
    await this.ensureLoaded();
    const existing = this.getByNodeId(input.remoteNodeId);
    const now = new Date().toISOString();
    const record: TrustRecord = existing
      ? {
          ...existing,
          remoteNodeName: input.remoteNodeName ?? existing.remoteNodeName,
          authorityCeiling: input.authorityCeiling,
          status: existing.status === 'trusted' ? 'trusted' : 'pending',
          updatedAt: now,
          metadata: input.metadata ?? existing.metadata,
        }
      : {
          trustId: crypto.randomUUID(),
          remoteNodeId: input.remoteNodeId,
          remoteNodeName: input.remoteNodeName,
          status: 'pending',
          authorityCeiling: input.authorityCeiling,
          updatedAt: now,
          metadata: input.metadata,
        };
    this.records.set(input.remoteNodeId, record);
    await this.save();
    return record;
  }

  async markTrusted(remoteNodeId: string, authorityCeiling?: ProjectRole): Promise<TrustRecord | null> {
    await this.ensureLoaded();
    const existing = this.getByNodeId(remoteNodeId);
    if (!existing) return null;
    const now = new Date().toISOString();
    const updated: TrustRecord = {
      ...existing,
      status: 'trusted',
      authorityCeiling: authorityCeiling ?? existing.authorityCeiling,
      establishedAt: existing.establishedAt ?? now,
      updatedAt: now,
    };
    this.records.set(remoteNodeId, updated);
    await this.save();
    return updated;
  }

  async markRejected(remoteNodeId: string): Promise<TrustRecord | null> {
    return this.setStatus(remoteNodeId, 'rejected');
  }

  async revoke(remoteNodeId: string): Promise<TrustRecord | null> {
    return this.setStatus(remoteNodeId, 'revoked');
  }

  private async setStatus(remoteNodeId: string, status: TrustStatus): Promise<TrustRecord | null> {
    await this.ensureLoaded();
    const existing = this.getByNodeId(remoteNodeId);
    if (!existing) return null;
    const updated: TrustRecord = {
      ...existing,
      status,
      updatedAt: new Date().toISOString(),
    };
    this.records.set(remoteNodeId, updated);
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
