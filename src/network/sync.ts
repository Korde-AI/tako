import type { TakoConfig } from '../config/schema.js';
import type { NodeIdentity } from '../core/node-identity.js';
import type { Project } from '../projects/types.js';
import type { ProjectMembershipRegistry } from '../projects/memberships.js';
import type { ProjectRegistry } from '../projects/registry.js';
import { resolveProjectRoot } from '../projects/root.js';
import { getRuntimePaths } from '../core/paths.js';
import { EdgeHubClient } from './edge-client.js';
import type { HubMembershipSummary, HubProjectRecord } from '../hub/types.js';
import type { CapabilityRegistry } from './capabilities.js';

export function createHubClientFromConfig(config: TakoConfig): EdgeHubClient | null {
  if (!config.network?.hub) return null;
  if (config.network.enabled === false) return null;
  return new EdgeHubClient(config.network.hub);
}

export function toHubProjectRecord(
  project: Project,
  nodeId: string,
  memberships: ProjectMembershipRegistry,
): HubProjectRecord {
  return {
    projectId: project.projectId,
    slug: project.slug,
    displayName: project.displayName,
    ownerPrincipalId: project.ownerPrincipalId,
    hostNodeId: nodeId,
    status: project.status,
    workspaceRootHint: resolveProjectRoot(getRuntimePaths(), project),
    memberCount: memberships.listByProject(project.projectId).length,
    updatedAt: project.updatedAt,
    metadata: project.metadata,
  };
}

export function toHubMembershipSummaries(
  projectId: string,
  hostNodeId: string,
  memberships: ProjectMembershipRegistry,
): Array<Pick<HubMembershipSummary, 'principalId' | 'role'>> {
  return memberships.listByProject(projectId).map((membership) => ({
    principalId: membership.principalId,
    role: membership.role,
  }));
}

export async function registerNodeWithHub(
  client: EdgeHubClient,
  identity: NodeIdentity,
  capabilityRegistry?: CapabilityRegistry,
): Promise<void> {
  await client.registerNode({
    identity,
    capabilities: {
      projects: true,
      sharedSessions: true,
      localTools: true,
    },
    metadata: capabilityRegistry ? {
      delegationCapabilities: capabilityRegistry.listEnabled().map((capability) => ({
        capabilityId: capability.capabilityId,
        minRole: capability.minRole,
        category: capability.category,
      })),
    } : undefined,
  });
}

export async function syncProjectToHub(
  client: EdgeHubClient,
  identity: NodeIdentity,
  project: Project,
  memberships: ProjectMembershipRegistry,
): Promise<void> {
  await client.registerProject(toHubProjectRecord(project, identity.nodeId, memberships));
}

export async function syncProjectMembershipsToHub(
  client: EdgeHubClient,
  identity: NodeIdentity,
  projectId: string,
  memberships: ProjectMembershipRegistry,
): Promise<void> {
  await client.registerProjectMemberships(
    projectId,
    identity.nodeId,
    toHubMembershipSummaries(projectId, identity.nodeId, memberships),
  );
}

export async function syncAllProjectsToHub(
  client: EdgeHubClient,
  identity: NodeIdentity,
  projects: ProjectRegistry,
  memberships: ProjectMembershipRegistry,
): Promise<void> {
  for (const project of projects.list()) {
    await syncProjectToHub(client, identity, project, memberships);
    await syncProjectMembershipsToHub(client, identity, project.projectId, memberships);
  }
}
