import type { ProjectRole } from '../projects/types.js';

const ROLE_ORDER: Record<ProjectRole, number> = {
  read: 1,
  contribute: 2,
  write: 3,
  admin: 4,
};

export function isValidAuthorityCeiling(value: string): value is ProjectRole {
  return value in ROLE_ORDER;
}

export function isRoleWithinAuthorityCeiling(role: ProjectRole, ceiling: ProjectRole): boolean {
  return ROLE_ORDER[role] <= ROLE_ORDER[ceiling];
}

export function compareAuthorityRoles(left: ProjectRole, right: ProjectRole): number {
  return ROLE_ORDER[left] - ROLE_ORDER[right];
}
