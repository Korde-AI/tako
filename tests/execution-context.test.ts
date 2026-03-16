import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildExecutionContext,
  toAuditContext,
  toCommandContext,
  toSessionMetadata,
} from '../src/core/execution-context.js';

describe('execution context', () => {
  it('builds a full execution context and projects it consistently', () => {
    const ctx = buildExecutionContext({
      nodeIdentity: {
        nodeId: 'node-1',
        mode: 'edge',
        name: 'edge-main',
        createdAt: '2026-03-16T00:00:00.000Z',
        lastStartedAt: '2026-03-16T00:00:00.000Z',
        home: '/tmp/tako-edge-main',
      },
      home: '/tmp/tako-edge-main',
      agentId: 'main',
      sessionId: 'session-1',
      principal: {
        principalId: 'principal-1',
        type: 'human',
        displayName: 'shu',
        createdAt: '2026-03-16T00:00:00.000Z',
        updatedAt: '2026-03-16T00:00:00.000Z',
      },
      authorId: 'discord-user-1',
      authorName: 'shu',
      platform: 'discord',
      platformUserId: 'discord-user-1',
      channelId: 'discord:123',
      channelTarget: '123',
      threadId: '456',
      project: {
        projectId: 'project-1',
        slug: 'alpha',
        displayName: 'Alpha',
        ownerPrincipalId: 'principal-1',
        status: 'active',
        createdAt: '2026-03-16T00:00:00.000Z',
        updatedAt: '2026-03-16T00:00:00.000Z',
      },
      projectRole: 'admin',
      sharedSessionId: 'shared-1',
      ownerPrincipalId: 'principal-1',
      participantIds: ['principal-1', 'principal-2'],
      activeParticipantIds: ['principal-2', 'principal-1'],
    });

    assert.equal(ctx.principalId, 'principal-1');
    assert.equal(ctx.projectId, 'project-1');
    assert.equal(ctx.threadId, '456');

    const commandCtx = toCommandContext(ctx);
    assert.equal(commandCtx.principalName, 'shu');
    assert.equal(commandCtx.projectRole, 'admin');
    assert.equal(commandCtx.executionContext?.nodeId, 'node-1');
    assert.equal(commandCtx.sharedSessionId, 'shared-1');
    assert.equal(commandCtx.participantIds?.length, 2);

    const auditCtx = toAuditContext(ctx);
    assert.deepEqual(auditCtx, {
      agentId: 'main',
      sessionId: 'session-1',
      principalId: 'principal-1',
      principalName: 'shu',
      projectId: 'project-1',
      projectSlug: 'alpha',
      sharedSessionId: 'shared-1',
      participantIds: ['principal-1', 'principal-2'],
    });

    const metadata = toSessionMetadata(ctx);
    assert.equal(metadata['principalId'], 'principal-1');
    assert.equal(metadata['projectSlug'], 'alpha');
    assert.equal(metadata['threadId'], '456');
    assert.equal(metadata['sharedSessionId'], 'shared-1');
    assert.deepEqual(metadata['participantIds'], ['principal-1', 'principal-2']);
  });

  it('handles unbound solo contexts', () => {
    const ctx = buildExecutionContext({
      nodeIdentity: {
        nodeId: 'node-2',
        mode: 'edge',
        name: 'edge-solo',
        createdAt: '2026-03-16T00:00:00.000Z',
        lastStartedAt: '2026-03-16T00:00:00.000Z',
        home: '/tmp/tako-edge-solo',
      },
      home: '/tmp/tako-edge-solo',
      agentId: 'main',
      channelId: 'cli',
      channelTarget: 'cli',
      platform: 'cli',
    });

    const metadata = toSessionMetadata(ctx);
    assert.equal(metadata['agentId'], 'main');
    assert.equal(metadata['channelId'], 'cli');
    assert.equal(metadata['projectId'], undefined);
    assert.equal(toCommandContext(ctx).principalId, undefined);
    assert.equal(toAuditContext(ctx).sessionId, 'unknown');
  });
});
