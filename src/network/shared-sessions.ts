import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { DelegationRequest, DelegationResult } from './delegation.js';
import type { ProjectArtifactEnvelope } from '../projects/distribution.js';

export interface NetworkLocalSessionBinding {
  nodeId: string;
  localSessionId: string;
  sharedSessionId?: string;
}

export interface NetworkSharedSession {
  networkSessionId: string;
  projectId: string;
  projectSlug?: string;
  hostNodeId: string;
  collaboration?: {
    autoArtifactSync?: boolean;
  };
  participantNodeIds: string[];
  participantPrincipalIds: string[];
  localSessionBindings: NetworkLocalSessionBinding[];
  createdAt: string;
  updatedAt: string;
  lastEventAt: string;
  status: 'active' | 'paused' | 'closed';
}

export interface NetworkSessionEvent {
  eventId: string;
  networkSessionId: string;
  projectId: string;
  fromNodeId: string;
  fromPrincipalId: string;
  type: 'message' | 'join' | 'leave' | 'system' | 'delegation_request' | 'delegation_result' | 'artifact_publish';
  audience: 'project-members' | 'session-participants' | 'specific-nodes';
  targetNodeIds?: string[];
  payload: {
    text?: string;
    summary?: string;
    delegationRequest?: DelegationRequest;
    delegationResult?: DelegationResult;
    artifactEnvelope?: ProjectArtifactEnvelope;
    metadata?: Record<string, unknown>;
  };
  createdAt: string;
}

interface StoredNetworkEvent {
  direction: 'sent' | 'received';
  event: NetworkSessionEvent;
}

export class NetworkSharedSessionStore {
  private sessions = new Map<string, NetworkSharedSession>();
  private events: StoredNetworkEvent[] = [];
  private loaded = false;

  constructor(
    private sessionsFile: string,
    private eventsFile: string,
  ) {}

  async load(): Promise<void> {
    await mkdir(dirname(this.sessionsFile), { recursive: true });
    this.sessions = new Map(
      (await this.readJsonFile<NetworkSharedSession[]>(this.sessionsFile, []))
        .map((session) => [session.networkSessionId, session]),
    );
    this.events = await this.readJsonFile<StoredNetworkEvent[]>(this.eventsFile, []);
    this.loaded = true;
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.sessionsFile), { recursive: true });
    await writeFile(this.sessionsFile, JSON.stringify(this.list(), null, 2) + '\n', 'utf-8');
    await writeFile(this.eventsFile, JSON.stringify(this.events, null, 2) + '\n', 'utf-8');
  }

  list(): NetworkSharedSession[] {
    return Array.from(this.sessions.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  listEvents(networkSessionId?: string): StoredNetworkEvent[] {
    return this.events.filter((entry) => !networkSessionId || entry.event.networkSessionId === networkSessionId);
  }

  get(networkSessionId: string): NetworkSharedSession | null {
    return this.sessions.get(networkSessionId) ?? null;
  }

  findByProject(projectId: string): NetworkSharedSession[] {
    return this.list().filter((session) => session.projectId === projectId);
  }

  findByLocalSessionId(localSessionId: string): NetworkSharedSession | null {
    return this.list().find((session) =>
      session.localSessionBindings.some((binding) => binding.localSessionId === localSessionId)) ?? null;
  }

  findBySharedSessionId(sharedSessionId: string): NetworkSharedSession | null {
    return this.list().find((session) =>
      session.localSessionBindings.some((binding) => binding.sharedSessionId === sharedSessionId)) ?? null;
  }

  async upsertSession(input: NetworkSharedSession): Promise<NetworkSharedSession> {
    await this.ensureLoaded();
    const existing = this.get(input.networkSessionId);
    const session: NetworkSharedSession = existing
      ? {
          ...existing,
          ...input,
          participantNodeIds: Array.from(new Set([...(existing.participantNodeIds ?? []), ...(input.participantNodeIds ?? [])])),
          participantPrincipalIds: Array.from(new Set([...(existing.participantPrincipalIds ?? []), ...(input.participantPrincipalIds ?? [])])),
          localSessionBindings: mergeBindings(existing.localSessionBindings, input.localSessionBindings),
          updatedAt: new Date().toISOString(),
          lastEventAt: input.lastEventAt ?? existing.lastEventAt,
        }
      : input;
    this.sessions.set(session.networkSessionId, session);
    await this.save();
    return session;
  }

  async create(input: {
    projectId: string;
    projectSlug?: string;
    hostNodeId: string;
    collaboration?: NetworkSharedSession['collaboration'];
    participantNodeIds: string[];
    participantPrincipalIds?: string[];
    localSessionBindings?: NetworkLocalSessionBinding[];
  }): Promise<NetworkSharedSession> {
    await this.ensureLoaded();
    const now = new Date().toISOString();
    const session: NetworkSharedSession = {
      networkSessionId: crypto.randomUUID(),
      projectId: input.projectId,
      projectSlug: input.projectSlug,
      hostNodeId: input.hostNodeId,
      collaboration: input.collaboration,
      participantNodeIds: Array.from(new Set(input.participantNodeIds)),
      participantPrincipalIds: Array.from(new Set(input.participantPrincipalIds ?? [])),
      localSessionBindings: input.localSessionBindings ?? [],
      createdAt: now,
      updatedAt: now,
      lastEventAt: now,
      status: 'active',
    };
    this.sessions.set(session.networkSessionId, session);
    await this.save();
    return session;
  }

  async bindLocalSession(input: {
    networkSessionId: string;
    nodeId: string;
    localSessionId: string;
    sharedSessionId?: string;
  }): Promise<NetworkSharedSession> {
    await this.ensureLoaded();
    const session = this.require(input.networkSessionId);
    session.localSessionBindings = mergeBindings(session.localSessionBindings, [input]);
    session.updatedAt = new Date().toISOString();
    this.sessions.set(session.networkSessionId, session);
    await this.save();
    return session;
  }

  async appendEvent(event: NetworkSessionEvent, direction: 'sent' | 'received'): Promise<void> {
    await this.ensureLoaded();
    if (this.events.some((entry) => entry.event.eventId === event.eventId)) return;
    this.events.push({ direction, event });
    const session = this.get(event.networkSessionId);
    if (session) {
      session.lastEventAt = event.createdAt;
      session.updatedAt = new Date().toISOString();
      this.sessions.set(session.networkSessionId, session);
    }
    await this.save();
  }

  private require(networkSessionId: string): NetworkSharedSession {
    const session = this.get(networkSessionId);
    if (!session) throw new Error(`Network session not found: ${networkSessionId}`);
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

function mergeBindings(
  current: NetworkLocalSessionBinding[],
  incoming: NetworkLocalSessionBinding[],
): NetworkLocalSessionBinding[] {
  const map = new Map<string, NetworkLocalSessionBinding>();
  for (const binding of [...current, ...incoming]) {
    map.set(`${binding.nodeId}:${binding.localSessionId}:${binding.sharedSessionId ?? ''}`, binding);
  }
  return Array.from(map.values());
}
