import type { NodeIdentity } from '../core/node-identity.js';
import type { HubMembershipSummary, HubNodeRecord, HubProjectRecord } from '../hub/types.js';
import type { NetworkSessionEvent, NetworkSharedSession } from './shared-sessions.js';

export class EdgeHubClient {
  constructor(private hubBaseUrl: string) {
    this.hubBaseUrl = normalizeHubBaseUrl(hubBaseUrl);
  }

  async registerNode(input: {
    identity: NodeIdentity;
    address?: string;
    capabilities?: HubNodeRecord['capabilities'];
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    await this.post('/register/node', {
      nodeId: input.identity.nodeId,
      mode: input.identity.mode,
      name: input.identity.name,
      bind: input.identity.bind,
      port: input.identity.port,
      homeHint: input.identity.home,
      address: input.address,
      capabilities: input.capabilities,
      metadata: input.metadata,
    });
  }

  async heartbeat(nodeId: string): Promise<void> {
    await this.post('/heartbeat', { nodeId });
  }

  async registerProject(project: HubProjectRecord): Promise<void> {
    await this.post('/register/project', project);
  }

  async registerProjectMemberships(projectId: string, hostNodeId: string, memberships: Array<Pick<HubMembershipSummary, 'principalId' | 'role'>>): Promise<void> {
    await this.post('/register/project-memberships', { projectId, hostNodeId, memberships });
  }

  async lookupRoute(projectIdOrSlug: string): Promise<{ hostNodeId: string; projectId: string } | null> {
    const response = await fetch(new URL(`/routes/${encodeURIComponent(projectIdOrSlug)}`, this.hubBaseUrl));
    if (response.status === 404) return null;
    if (!response.ok) {
      throw new Error(`Hub request failed (${response.status}): ${await response.text()}`);
    }
    return await response.json() as { hostNodeId: string; projectId: string };
  }

  async registerNetworkSession(input: {
    networkSessionId?: string;
    projectId: string;
    projectSlug?: string;
    hostNodeId: string;
    collaboration?: NetworkSharedSession['collaboration'];
    participantNodeIds: string[];
  }): Promise<NetworkSharedSession> {
    return await this.postJson('/sessions/register', input);
  }

  async sendSessionEvent(event: NetworkSessionEvent): Promise<void> {
    await this.post('/sessions/event', { event });
  }

  async fetchPendingSessionEvents(nodeId: string): Promise<NetworkSessionEvent[]> {
    const response = await fetch(new URL(`/sessions/pending/${encodeURIComponent(nodeId)}`, this.hubBaseUrl));
    if (!response.ok) {
      throw new Error(`Hub request failed (${response.status}): ${await response.text()}`);
    }
    return await response.json() as NetworkSessionEvent[];
  }

  async ackSessionEvent(nodeId: string, eventId: string): Promise<void> {
    await this.post('/sessions/ack', { nodeId, eventId });
  }

  private async post(path: string, body: unknown): Promise<void> {
    const response = await fetch(new URL(path, this.hubBaseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`Hub request failed (${response.status}): ${await response.text()}`);
    }
  }

  private async postJson<T>(path: string, body: unknown): Promise<T> {
    const response = await fetch(new URL(path, this.hubBaseUrl), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      throw new Error(`Hub request failed (${response.status}): ${await response.text()}`);
    }
    return await response.json() as T;
  }
}

export function normalizeHubBaseUrl(input: string): string {
  const trimmed = input.trim();
  if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/+$/, '');
  return `http://${trimmed.replace(/\/+$/, '')}`;
}
