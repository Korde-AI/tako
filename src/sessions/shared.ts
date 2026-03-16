import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

export interface SharedSessionBinding {
  platform: string;
  channelId: string;
  channelTarget: string;
  threadId?: string;
}

export interface SharedSession {
  sharedSessionId: string;
  sessionId: string;
  agentId: string;
  projectId: string;
  projectSlug?: string;
  ownerPrincipalId: string;
  participantIds: string[];
  activeParticipantIds: string[];
  channelBindings: SharedSessionBinding[];
  createdAt: string;
  updatedAt: string;
  lastActiveAt: string;
}

export class SharedSessionRegistry {
  private sessions = new Map<string, SharedSession>();
  private loaded = false;

  constructor(private rootDir: string) {}

  private get storageFile(): string {
    return join(this.rootDir, 'shared-sessions.json');
  }

  async load(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    const data = await this.readJsonFile<SharedSession[]>(this.storageFile, []);
    this.sessions = new Map(data.map((session) => [session.sharedSessionId, session]));
    this.loaded = true;
  }

  async save(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    await writeFile(this.storageFile, JSON.stringify(this.list(), null, 2) + '\n', 'utf-8');
  }

  list(): SharedSession[] {
    return Array.from(this.sessions.values()).sort((a, b) =>
      a.lastActiveAt.localeCompare(b.lastActiveAt),
    );
  }

  get(sharedSessionId: string): SharedSession | null {
    return this.sessions.get(sharedSessionId) ?? null;
  }

  findBySessionId(sessionId: string): SharedSession | null {
    return this.list().find((session) => session.sessionId === sessionId) ?? null;
  }

  findByBinding(input: {
    projectId: string;
    platform: string;
    channelTarget: string;
    threadId?: string;
    agentId: string;
  }): SharedSession | null {
    const matches = this.list().filter((session) =>
      session.projectId === input.projectId
      && session.agentId === input.agentId
      && session.channelBindings.some((binding) => {
        if (binding.platform !== input.platform) return false;
        if (binding.channelTarget !== input.channelTarget) return false;
        if (binding.threadId && binding.threadId !== input.threadId) return false;
        return true;
      }));
    if (matches.length === 0) return null;
    matches.sort((a, b) => {
      const aExactThread = a.channelBindings.some((binding) => binding.threadId && binding.threadId === input.threadId);
      const bExactThread = b.channelBindings.some((binding) => binding.threadId && binding.threadId === input.threadId);
      return Number(bExactThread) - Number(aExactThread);
    });
    return matches[0] ?? null;
  }

  async create(input: {
    sessionId: string;
    agentId: string;
    projectId: string;
    projectSlug?: string;
    ownerPrincipalId: string;
    initialParticipantId: string;
    binding: SharedSessionBinding;
  }): Promise<SharedSession> {
    await this.ensureLoaded();
    const now = new Date().toISOString();
    const session: SharedSession = {
      sharedSessionId: crypto.randomUUID(),
      sessionId: input.sessionId,
      agentId: input.agentId,
      projectId: input.projectId,
      projectSlug: input.projectSlug,
      ownerPrincipalId: input.ownerPrincipalId,
      participantIds: [input.initialParticipantId],
      activeParticipantIds: [input.initialParticipantId],
      channelBindings: [input.binding],
      createdAt: now,
      updatedAt: now,
      lastActiveAt: now,
    };
    this.sessions.set(session.sharedSessionId, session);
    await this.save();
    return session;
  }

  async touchParticipant(sharedSessionId: string, principalId: string): Promise<SharedSession> {
    await this.ensureLoaded();
    const session = this.require(sharedSessionId);
    if (!session.participantIds.includes(principalId)) {
      session.participantIds = [...session.participantIds, principalId];
    }
    session.updatedAt = new Date().toISOString();
    session.lastActiveAt = session.updatedAt;
    this.sessions.set(sharedSessionId, session);
    await this.save();
    return session;
  }

  async setActiveParticipant(sharedSessionId: string, principalId: string): Promise<SharedSession> {
    await this.ensureLoaded();
    const session = this.require(sharedSessionId);
    if (!session.participantIds.includes(principalId)) {
      session.participantIds = [...session.participantIds, principalId];
    }
    const active = session.activeParticipantIds.filter((id) => id !== principalId);
    active.push(principalId);
    session.activeParticipantIds = active;
    session.updatedAt = new Date().toISOString();
    session.lastActiveAt = session.updatedAt;
    this.sessions.set(sharedSessionId, session);
    await this.save();
    return session;
  }

  private require(sharedSessionId: string): SharedSession {
    const session = this.sessions.get(sharedSessionId);
    if (!session) throw new Error(`Shared session not found: ${sharedSessionId}`);
    return session;
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  private async readJsonFile<T>(path: string, fallback: T): Promise<T> {
    if (!existsSync(path)) return fallback;
    return JSON.parse(await readFile(path, 'utf-8')) as T;
  }
}

