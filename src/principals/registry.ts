import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type {
  Principal,
  PrincipalAuthorityLevel,
  PrincipalPlatform,
  PrincipalPlatformMapping,
} from './types.js';

interface PrincipalRegistryData {
  principals: Principal[];
  mappings: PrincipalPlatformMapping[];
}

interface GetOrCreateHumanInput {
  displayName: string;
  platform: PrincipalPlatform;
  platformUserId: string;
  username?: string;
  authorityLevel?: PrincipalAuthorityLevel;
  metadata?: Record<string, unknown>;
}

export class PrincipalRegistry {
  private principals = new Map<string, Principal>();
  private mappings = new Map<string, PrincipalPlatformMapping>();
  private loaded = false;

  constructor(private rootDir: string) {}

  private get principalsFile(): string {
    return join(this.rootDir, 'principals.json');
  }

  private get mappingsFile(): string {
    return join(this.rootDir, 'mappings.json');
  }

  private mappingKey(platform: string, platformUserId: string): string {
    return `${platform}:${platformUserId}`;
  }

  async load(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    const principals = await this.readJsonFile<Principal[]>(this.principalsFile, []);
    const mappings = await this.readJsonFile<PrincipalPlatformMapping[]>(this.mappingsFile, []);
    this.principals = new Map(principals.map((principal) => [principal.principalId, principal]));
    this.mappings = new Map(mappings.map((mapping) => [this.mappingKey(mapping.platform, mapping.platformUserId), mapping]));
    this.loaded = true;
  }

  async save(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    await writeFile(this.principalsFile, JSON.stringify(this.list(), null, 2) + '\n', 'utf-8');
    await writeFile(this.mappingsFile, JSON.stringify(this.listMappings(), null, 2) + '\n', 'utf-8');
  }

  list(): Principal[] {
    return Array.from(this.principals.values()).sort((a, b) => a.displayName.localeCompare(b.displayName));
  }

  listMappings(): PrincipalPlatformMapping[] {
    return Array.from(this.mappings.values()).sort((a, b) => this.mappingKey(a.platform, a.platformUserId).localeCompare(this.mappingKey(b.platform, b.platformUserId)));
  }

  get(principalId: string): Principal | null {
    return this.principals.get(principalId) ?? null;
  }

  findByPlatform(platform: PrincipalPlatform, platformUserId: string): Principal | null {
    const mapping = this.mappings.get(this.mappingKey(platform, platformUserId));
    if (!mapping) return null;
    return this.principals.get(mapping.principalId) ?? null;
  }

  async getOrCreateHuman(input: GetOrCreateHumanInput): Promise<Principal> {
    await this.ensureLoaded();
    const existing = this.findByPlatform(input.platform, input.platformUserId);
    const now = new Date().toISOString();

    if (existing) {
      const updated: Principal = {
        ...existing,
        displayName: input.displayName || existing.displayName,
        updatedAt: now,
        lastSeenAt: now,
        authorityLevel: input.authorityLevel ?? existing.authorityLevel,
        metadata: { ...existing.metadata, ...input.metadata },
      };
      this.principals.set(updated.principalId, updated);
      const mappingKey = this.mappingKey(input.platform, input.platformUserId);
      const existingMapping = this.mappings.get(mappingKey);
      if (existingMapping) {
        this.mappings.set(mappingKey, {
          ...existingMapping,
          username: input.username ?? existingMapping.username,
          displayName: input.displayName ?? existingMapping.displayName,
          lastSeenAt: now,
        });
      }
      await this.save();
      return updated;
    }

    const principal: Principal = {
      principalId: crypto.randomUUID(),
      type: 'human',
      displayName: input.displayName,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
      authorityLevel: input.authorityLevel,
      metadata: input.metadata,
    };
    const mapping: PrincipalPlatformMapping = {
      principalId: principal.principalId,
      platform: input.platform,
      platformUserId: input.platformUserId,
      username: input.username,
      displayName: input.displayName,
      linkedAt: now,
      lastSeenAt: now,
    };
    this.principals.set(principal.principalId, principal);
    this.mappings.set(this.mappingKey(input.platform, input.platformUserId), mapping);
    await this.save();
    return principal;
  }

  async seedReservedPrincipal(input: {
    type: 'local-agent' | 'system';
    displayName: string;
    metadata?: Record<string, unknown>;
  }): Promise<Principal> {
    await this.ensureLoaded();
    const existing = this.list().find((principal) =>
      principal.type === input.type && principal.displayName === input.displayName);
    if (existing) return existing;
    const now = new Date().toISOString();
    const principal: Principal = {
      principalId: crypto.randomUUID(),
      type: input.type,
      displayName: input.displayName,
      createdAt: now,
      updatedAt: now,
      lastSeenAt: now,
      metadata: input.metadata,
    };
    this.principals.set(principal.principalId, principal);
    await this.save();
    return principal;
  }

  async touch(principalId: string): Promise<void> {
    await this.ensureLoaded();
    const principal = this.principals.get(principalId);
    if (!principal) return;
    const now = new Date().toISOString();
    this.principals.set(principalId, {
      ...principal,
      updatedAt: now,
      lastSeenAt: now,
    });
    await this.save();
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) {
      await this.load();
    }
  }

  private async readJsonFile<T>(path: string, fallback: T): Promise<T> {
    if (!existsSync(path)) return fallback;
    const raw = await readFile(path, 'utf-8');
    return JSON.parse(raw) as T;
  }
}
