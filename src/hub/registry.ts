import type { HubStateStore } from './state.js';
import type { HubMembershipSummary, HubNodeRecord, HubProjectRecord } from './types.js';
import { HubAudit } from './audit.js';

const ONLINE_WINDOW_MS = 60_000;

export class HubRegistry {
  constructor(
    private state: HubStateStore,
    private audit?: HubAudit,
  ) {}

  listNodes(): HubNodeRecord[] {
    return this.state.listNodes().map((node) => this.withDerivedStatus(node));
  }

  getNode(nodeId: string): HubNodeRecord | null {
    const node = this.state.getNode(nodeId);
    return node ? this.withDerivedStatus(node) : null;
  }

  listProjects(): HubProjectRecord[] {
    return this.state.listProjects();
  }

  getProject(projectIdOrSlug: string): HubProjectRecord | null {
    return this.state.getProject(projectIdOrSlug) ?? this.state.findProjectBySlug(projectIdOrSlug);
  }

  async registerNode(input: Omit<HubNodeRecord, 'registeredAt' | 'lastSeenAt' | 'status'> & { status?: HubNodeRecord['status'] }): Promise<HubNodeRecord> {
    const now = new Date().toISOString();
    const existing = this.state.getNode(input.nodeId);
    const node: HubNodeRecord = {
      ...existing,
      ...input,
      status: 'online',
      registeredAt: existing?.registeredAt ?? now,
      lastSeenAt: now,
      capabilities: input.capabilities ?? existing?.capabilities ?? {},
    };
    await this.state.upsertNode(node);
    await this.audit?.logNodeRegistered(node);
    return node;
  }

  async heartbeat(nodeId: string): Promise<HubNodeRecord | null> {
    const existing = this.state.getNode(nodeId);
    if (!existing) {
      await this.audit?.logHeartbeat(nodeId, false);
      return null;
    }
    const updated: HubNodeRecord = {
      ...existing,
      status: 'online',
      lastSeenAt: new Date().toISOString(),
    };
    await this.state.upsertNode(updated);
    await this.audit?.logHeartbeat(nodeId, true);
    return updated;
  }

  async registerProject(input: HubProjectRecord): Promise<HubProjectRecord> {
    const existing = this.state.getProject(input.projectId);
    if (existing && existing.hostNodeId !== input.hostNodeId) {
      await this.audit?.logRouteConflict(existing);
      throw new Error(`Project host conflict for ${input.projectId}: ${existing.hostNodeId} vs ${input.hostNodeId}`);
    }
    const updated: HubProjectRecord = {
      ...existing,
      ...input,
      updatedAt: input.updatedAt ?? new Date().toISOString(),
    };
    await this.state.upsertProject(updated);
    await this.audit?.logProjectRegistered(updated);
    return updated;
  }

  async updateProjectMembershipSummary(projectId: string, hostNodeId: string, rows: Array<Omit<HubMembershipSummary, 'projectId' | 'hostNodeId' | 'updatedAt'>>): Promise<void> {
    const project = this.state.getProject(projectId);
    if (!project) {
      throw new Error(`Unknown project: ${projectId}`);
    }
    if (project.hostNodeId !== hostNodeId) {
      throw new Error(`Host mismatch for ${projectId}: expected ${project.hostNodeId}, got ${hostNodeId}`);
    }
    const now = new Date().toISOString();
    const records: HubMembershipSummary[] = rows.map((row) => ({
      projectId,
      principalId: row.principalId,
      role: row.role,
      hostNodeId,
      updatedAt: now,
    }));
    await this.state.replaceMembershipsForProject(projectId, records);
    await this.audit?.logMembershipsUpdated(projectId, records.length, hostNodeId);
  }

  resolveProjectRoute(projectIdOrSlug: string): { hostNodeId: string; projectId: string } | null {
    const project = this.getProject(projectIdOrSlug);
    if (!project) return null;
    const route = this.state.getRoute(project.projectId);
    if (!route) return null;
    return { hostNodeId: route.hostNodeId, projectId: route.projectId };
  }

  async logRouteLookup(projectIdOrSlug: string, route: { hostNodeId: string; projectId: string } | null): Promise<void> {
    await this.audit?.logRouteLookup(projectIdOrSlug, route);
  }

  async logNetworkSessionRegistered(session: import('../network/shared-sessions.js').NetworkSharedSession): Promise<void> {
    await this.audit?.logNetworkSessionRegistered(session);
  }

  async logNetworkSessionEvent(
    event: import('../network/shared-sessions.js').NetworkSessionEvent,
    action: string,
    success: boolean,
    extra?: Record<string, unknown>,
  ): Promise<void> {
    await this.audit?.logNetworkSessionEvent(event, action, success, extra);
  }

  listMemberships(projectId?: string): HubMembershipSummary[] {
    return this.state.listMemberships(projectId);
  }

  getStatusSummary(): {
    nodeCount: number;
    onlineNodeCount: number;
    projectCount: number;
  } {
    const nodes = this.listNodes();
    return {
      nodeCount: nodes.length,
      onlineNodeCount: nodes.filter((node) => node.status === 'online').length,
      projectCount: this.state.listProjects().length,
    };
  }

  private withDerivedStatus(node: HubNodeRecord): HubNodeRecord {
    const delta = Date.now() - new Date(node.lastSeenAt).getTime();
    return {
      ...node,
      status: delta <= ONLINE_WINDOW_MS ? 'online' : 'offline',
    };
  }
}
