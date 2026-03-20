export interface HubNodeRecord {
  nodeId: string;
  mode: 'edge' | 'hub';
  name: string;
  address?: string;
  bind?: string;
  port?: number;
  homeHint?: string;
  status: 'online' | 'offline' | 'unknown';
  capabilities: {
    projects?: boolean;
    sharedSessions?: boolean;
    localTools?: boolean;
  };
  registeredAt: string;
  lastSeenAt: string;
  metadata?: Record<string, unknown>;
}

export interface HubProjectRecord {
  projectId: string;
  slug: string;
  displayName: string;
  ownerPrincipalId: string;
  hostNodeId: string;
  status: 'active' | 'archived' | 'closed';
  workspaceRootHint?: string;
  memberCount?: number;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface HubMembershipSummary {
  projectId: string;
  principalId: string;
  role: 'read' | 'contribute' | 'write' | 'admin';
  hostNodeId: string;
  updatedAt: string;
}

export interface HubRouteRecord {
  projectId: string;
  hostNodeId: string;
  updatedAt: string;
}
