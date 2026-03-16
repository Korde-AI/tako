import { AuditLogger } from '../core/audit.js';
import type { HubMembershipSummary, HubNodeRecord, HubProjectRecord } from './types.js';
import type { NetworkSessionEvent, NetworkSharedSession } from '../network/shared-sessions.js';

export class HubAudit {
  constructor(private audit: AuditLogger, private hubNodeId: string) {}

  async logNodeRegistered(node: HubNodeRecord): Promise<void> {
    await this.audit.log({
      agentId: this.hubNodeId,
      sessionId: 'hub',
      event: 'agent_comms',
      action: 'node_registered',
      details: {
        nodeId: node.nodeId,
        mode: node.mode,
        name: node.name,
        status: node.status,
      },
      success: true,
    });
  }

  async logHeartbeat(nodeId: string, success: boolean): Promise<void> {
    await this.audit.log({
      agentId: this.hubNodeId,
      sessionId: 'hub',
      event: 'agent_comms',
      action: 'heartbeat',
      details: { nodeId },
      success,
    });
  }

  async logProjectRegistered(project: HubProjectRecord): Promise<void> {
    await this.audit.log({
      agentId: this.hubNodeId,
      sessionId: 'hub',
      event: 'agent_comms',
      action: 'project_registered',
      details: {
        projectId: project.projectId,
        slug: project.slug,
        hostNodeId: project.hostNodeId,
      },
      success: true,
    });
  }

  async logMembershipsUpdated(projectId: string, count: number, hostNodeId: string): Promise<void> {
    await this.audit.log({
      agentId: this.hubNodeId,
      sessionId: 'hub',
      event: 'agent_comms',
      action: 'project_memberships_updated',
      details: { projectId, count, hostNodeId },
      success: true,
    });
  }

  async logRouteLookup(projectIdOrSlug: string, route: { projectId: string; hostNodeId: string } | null): Promise<void> {
    await this.audit.log({
      agentId: this.hubNodeId,
      sessionId: 'hub',
      event: 'agent_comms',
      action: 'route_lookup',
      details: {
        query: projectIdOrSlug,
        route,
      },
      success: route !== null,
    });
  }

  async logRouteConflict(project: HubProjectRecord): Promise<void> {
    await this.audit.log({
      agentId: this.hubNodeId,
      sessionId: 'hub',
      event: 'permission_denied',
      action: 'project_host_conflict',
      details: {
        projectId: project.projectId,
        hostNodeId: project.hostNodeId,
      },
      success: false,
    });
  }

  async logNetworkSessionRegistered(session: NetworkSharedSession): Promise<void> {
    await this.audit.log({
      agentId: this.hubNodeId,
      sessionId: 'hub',
      event: 'agent_comms',
      action: 'network_session_registered',
      details: {
        networkSessionId: session.networkSessionId,
        projectId: session.projectId,
        hostNodeId: session.hostNodeId,
        participantNodeIds: session.participantNodeIds,
      },
      success: true,
    });
  }

  async logNetworkSessionEvent(event: NetworkSessionEvent, action: string, success: boolean, extra?: Record<string, unknown>): Promise<void> {
    await this.audit.log({
      agentId: this.hubNodeId,
      sessionId: 'hub',
      event: success ? 'agent_comms' : 'permission_denied',
      action,
      details: {
        networkSessionId: event.networkSessionId,
        eventId: event.eventId,
        fromNodeId: event.fromNodeId,
        projectId: event.projectId,
        ...extra,
      },
      success,
    });
  }
}
