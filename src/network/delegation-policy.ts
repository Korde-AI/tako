import type { DelegationCapability } from './capabilities.js';
import type { TrustRecord } from './trust.js';
import { compareAuthorityRoles } from './authority.js';
import type { ProjectRole } from '../projects/types.js';

export function evaluateDelegationRequest(input: {
  trust: TrustRecord | null;
  capability: DelegationCapability | null;
  projectId?: string;
  remoteProjectRole?: ProjectRole | null;
}): { allowed: boolean; reason?: string } {
  if (!input.trust || input.trust.status !== 'trusted') {
    return { allowed: false, reason: 'untrusted_node' };
  }
  if (!input.capability) {
    return { allowed: false, reason: 'unknown_capability' };
  }
  if (!input.capability.enabled) {
    return { allowed: false, reason: 'capability_disabled' };
  }
  if (input.capability.requiresProject && !input.projectId) {
    return { allowed: false, reason: 'project_required' };
  }
  if (compareAuthorityRoles(input.capability.minRole, input.trust.authorityCeiling) > 0) {
    return { allowed: false, reason: 'trust_ceiling_too_low' };
  }
  if (input.remoteProjectRole && compareAuthorityRoles(input.capability.minRole, input.remoteProjectRole) > 0) {
    return { allowed: false, reason: 'project_role_too_low' };
  }
  return { allowed: true };
}
