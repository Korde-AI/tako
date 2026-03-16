import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { evaluateDelegationRequest } from '../src/network/delegation-policy.js';
import type { DelegationCapability } from '../src/network/capabilities.js';
import type { TrustRecord } from '../src/network/trust.js';

const capability: DelegationCapability = {
  capabilityId: 'run_tests',
  name: 'Run Tests',
  description: 'Run tests',
  category: 'test',
  requiresProject: true,
  minRole: 'write',
  enabled: true,
};

const trust: TrustRecord = {
  trustId: 'trust-1',
  remoteNodeId: 'edge-a',
  status: 'trusted',
  authorityCeiling: 'contribute',
  updatedAt: new Date().toISOString(),
};

describe('delegation policy', () => {
  it('denies untrusted nodes', () => {
    assert.equal(evaluateDelegationRequest({
      trust: null,
      capability,
      projectId: 'project-1',
      remoteProjectRole: null,
    }).allowed, false);
  });

  it('denies when capability exceeds trust ceiling', () => {
    const result = evaluateDelegationRequest({
      trust,
      capability,
      projectId: 'project-1',
      remoteProjectRole: null,
    });
    assert.equal(result.allowed, false);
    assert.equal(result.reason, 'trust_ceiling_too_low');
  });

  it('allows enabled capability within trust ceiling', () => {
    const result = evaluateDelegationRequest({
      trust: { ...trust, authorityCeiling: 'admin' },
      capability: { ...capability, minRole: 'contribute' },
      projectId: 'project-1',
      remoteProjectRole: null,
    });
    assert.equal(result.allowed, true);
  });
});
