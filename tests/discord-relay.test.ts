import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { ProjectInvite } from '../src/network/invites.js';
import {
  matchesNodeHint,
  normalizeNodeHint,
  parseProjectInviteRelay,
  renderProjectInviteRelay,
  selectLatestMatchingRelayInvite,
} from '../src/network/discord-relay.js';

function makeInvite(): ProjectInvite {
  return {
    inviteId: 'invite-1',
    projectId: 'project-1',
    projectSlug: 'skilltree',
    hostNodeId: 'node-shu',
    hostNodeName: 'shuassitant',
    issuedByPrincipalId: 'principal-1',
    targetHint: 'jiaxinassistant',
    offeredRole: 'contribute',
    status: 'pending',
    createdAt: '2026-03-20T12:00:00.000Z',
  };
}

describe('discord relay invite helpers', () => {
  it('normalizes human-facing node hints', () => {
    assert.equal(normalizeNodeHint('@JiaxinAssistant'), 'jiaxinassistant');
    assert.equal(normalizeNodeHint('<@1234567890>'), '1234567890');
    assert.equal(matchesNodeHint('jiaxinassistant', ['@JiaxinAssistant', 'other']), true);
  });

  it('renders and parses a relay invite packet', () => {
    const text = renderProjectInviteRelay({
      kind: 'tako_project_invite_v1',
      invite: makeInvite(),
    });
    const parsed = parseProjectInviteRelay(text);
    assert.ok(parsed);
    assert.equal(parsed?.invite.inviteId, 'invite-1');
    assert.equal(parsed?.invite.targetHint, 'jiaxinassistant');
  });

  it('selects the latest matching relay invite from room messages', () => {
    const older = renderProjectInviteRelay({
      kind: 'tako_project_invite_v1',
      invite: { ...makeInvite(), inviteId: 'invite-old', createdAt: '2026-03-20T11:00:00.000Z' },
    });
    const newer = renderProjectInviteRelay({
      kind: 'tako_project_invite_v1',
      invite: { ...makeInvite(), inviteId: 'invite-new', createdAt: '2026-03-20T12:30:00.000Z' },
    });
    const selected = selectLatestMatchingRelayInvite([
      { authorId: 'a', content: older, timestamp: '2026-03-20T11:00:00.000Z' },
      { authorId: 'b', content: newer, timestamp: '2026-03-20T12:30:00.000Z' },
    ], (message) => message.invite.targetHint === 'jiaxinassistant');
    assert.equal(selected?.invite.inviteId, 'invite-new');
  });
});
