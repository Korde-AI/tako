import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { NetworkSessionEvent, NetworkSharedSession } from '../network/shared-sessions.js';

interface PendingRelayEvent {
  nodeId: string;
  event: NetworkSessionEvent;
}

export class HubRelay {
  private sessions = new Map<string, NetworkSharedSession>();
  private pending: PendingRelayEvent[] = [];
  private loaded = false;

  constructor(
    private sessionsFile: string,
    private pendingFile: string,
  ) {}

  async load(): Promise<void> {
    await mkdir(dirname(this.sessionsFile), { recursive: true });
    this.sessions = new Map(
      (await this.readJsonFile<NetworkSharedSession[]>(this.sessionsFile, []))
        .map((session) => [session.networkSessionId, session]),
    );
    this.pending = await this.readJsonFile<PendingRelayEvent[]>(this.pendingFile, []);
    this.loaded = true;
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.sessionsFile), { recursive: true });
    await writeFile(this.sessionsFile, JSON.stringify(this.listSessions(), null, 2) + '\n', 'utf-8');
    await writeFile(this.pendingFile, JSON.stringify(this.pending, null, 2) + '\n', 'utf-8');
  }

  listSessions(): NetworkSharedSession[] {
    return Array.from(this.sessions.values()).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  getSession(networkSessionId: string): NetworkSharedSession | null {
    return this.sessions.get(networkSessionId) ?? null;
  }

  async createOrJoinSession(input: {
    networkSessionId?: string;
    projectId: string;
    projectSlug?: string;
    hostNodeId: string;
    collaboration?: NetworkSharedSession['collaboration'];
    participantNodeIds: string[];
  }): Promise<NetworkSharedSession> {
    await this.ensureLoaded();
    const now = new Date().toISOString();
    const existing = input.networkSessionId ? this.getSession(input.networkSessionId) : null;
    const session: NetworkSharedSession = existing
      ? {
          ...existing,
          participantNodeIds: Array.from(new Set([...existing.participantNodeIds, ...input.participantNodeIds])),
          updatedAt: now,
        }
      : {
          networkSessionId: input.networkSessionId ?? crypto.randomUUID(),
          projectId: input.projectId,
          projectSlug: input.projectSlug,
          hostNodeId: input.hostNodeId,
          collaboration: input.collaboration,
          participantNodeIds: Array.from(new Set(input.participantNodeIds)),
          participantPrincipalIds: [],
          localSessionBindings: [],
          createdAt: now,
          updatedAt: now,
          lastEventAt: now,
          status: 'active',
        };
    this.sessions.set(session.networkSessionId, session);
    await this.save();
    return session;
  }

  async enqueueEvent(event: NetworkSessionEvent): Promise<void> {
    await this.ensureLoaded();
    const session = this.getSession(event.networkSessionId);
    if (!session) throw new Error(`Unknown network session: ${event.networkSessionId}`);
    const targets = resolveTargets(session, event).filter((nodeId) => nodeId !== event.fromNodeId);
    this.pending = this.pending.filter((entry) => !targets.includes(entry.nodeId) || entry.event.eventId !== event.eventId);
    for (const nodeId of targets) {
      this.pending.push({ nodeId, event });
    }
    session.lastEventAt = event.createdAt;
    session.updatedAt = new Date().toISOString();
    this.sessions.set(session.networkSessionId, session);
    await this.save();
  }

  async fetchPending(nodeId: string): Promise<NetworkSessionEvent[]> {
    await this.ensureLoaded();
    return this.pending.filter((entry) => entry.nodeId === nodeId).map((entry) => entry.event);
  }

  async ackEvent(nodeId: string, eventId: string): Promise<boolean> {
    await this.ensureLoaded();
    const before = this.pending.length;
    this.pending = this.pending.filter((entry) => !(entry.nodeId === nodeId && entry.event.eventId === eventId));
    const changed = before !== this.pending.length;
    if (changed) await this.save();
    return changed;
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  private async readJsonFile<T>(path: string, fallback: T): Promise<T> {
    if (!existsSync(path)) return fallback;
    return JSON.parse(await readFile(path, 'utf-8')) as T;
  }
}

function resolveTargets(session: NetworkSharedSession, event: NetworkSessionEvent): string[] {
  if (event.audience === 'specific-nodes') return event.targetNodeIds ?? [];
  return session.participantNodeIds;
}
