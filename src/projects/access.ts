import type { ProjectRole } from './types.js';
import { ProjectMembershipRegistry } from './memberships.js';

const ROLE_ORDER: Record<ProjectRole, number> = {
  read: 1,
  contribute: 2,
  write: 3,
  admin: 4,
};

export function getProjectRole(
  memberships: ProjectMembershipRegistry,
  projectId: string,
  principalId: string,
): ProjectRole | null {
  return memberships.get(projectId, principalId)?.role ?? null;
}

export function isProjectMember(
  memberships: ProjectMembershipRegistry,
  projectId: string,
  principalId: string,
): boolean {
  return memberships.get(projectId, principalId) !== null;
}

export function requireProjectRole(
  memberships: ProjectMembershipRegistry,
  projectId: string,
  principalId: string,
  minimumRole: ProjectRole,
): boolean {
  const current = getProjectRole(memberships, projectId, principalId);
  if (!current) return false;
  return ROLE_ORDER[current] >= ROLE_ORDER[minimumRole];
}
