import type { NodeIdentity } from './node-identity.js';
import type { Principal, PrincipalType } from '../principals/types.js';
import type { Project, ProjectRole } from '../projects/types.js';

export interface ExecutionContext {
  mode: 'edge' | 'hub';
  home: string;
  nodeId: string;
  nodeName: string;
  agentId: string;
  workspaceRoot?: string;
  projectRoot?: string;
  allowedToolRoot?: string;
  sessionId?: string;
  principalId?: string;
  principalName?: string;
  principalType?: PrincipalType;
  authorId?: string;
  authorName?: string;
  platform?: string;
  platformUserId?: string;
  channelId?: string;
  channelTarget?: string;
  threadId?: string;
  projectId?: string;
  projectSlug?: string;
  projectRole?: ProjectRole;
  sharedSessionId?: string;
  networkSessionId?: string;
  hostNodeId?: string;
  participantNodeIds?: string[];
  ownerPrincipalId?: string;
  participantIds?: string[];
  activeParticipantIds?: string[];
  metadata?: Record<string, unknown>;
}

export interface ExecutionContextInput {
  nodeIdentity: NodeIdentity;
  home: string;
  agentId: string;
  workspaceRoot?: string;
  projectRoot?: string;
  allowedToolRoot?: string;
  sessionId?: string;
  principal?: Principal | null;
  authorId?: string;
  authorName?: string;
  platform?: string;
  platformUserId?: string;
  channelId?: string;
  channelTarget?: string;
  threadId?: string;
  project?: Project | null;
  projectRole?: ProjectRole | null;
  sharedSessionId?: string;
  networkSessionId?: string;
  hostNodeId?: string;
  participantNodeIds?: string[];
  ownerPrincipalId?: string;
  participantIds?: string[];
  activeParticipantIds?: string[];
  metadata?: Record<string, unknown>;
}

export function buildExecutionContext(input: ExecutionContextInput): ExecutionContext {
  return {
    mode: input.nodeIdentity.mode,
    home: input.home,
    nodeId: input.nodeIdentity.nodeId,
    nodeName: input.nodeIdentity.name,
    agentId: input.agentId,
    workspaceRoot: input.workspaceRoot,
    projectRoot: input.projectRoot,
    allowedToolRoot: input.allowedToolRoot,
    sessionId: input.sessionId,
    principalId: input.principal?.principalId,
    principalName: input.principal?.displayName,
    principalType: input.principal?.type,
    authorId: input.authorId,
    authorName: input.authorName,
    platform: input.platform,
    platformUserId: input.platformUserId ?? input.authorId,
    channelId: input.channelId,
    channelTarget: input.channelTarget,
    threadId: input.threadId,
    projectId: input.project?.projectId,
    projectSlug: input.project?.slug,
    projectRole: input.projectRole ?? undefined,
    sharedSessionId: input.sharedSessionId,
    networkSessionId: input.networkSessionId,
    hostNodeId: input.hostNodeId,
    participantNodeIds: input.participantNodeIds,
    ownerPrincipalId: input.ownerPrincipalId,
    participantIds: input.participantIds,
    activeParticipantIds: input.activeParticipantIds,
    metadata: input.metadata,
  };
}

export function toSessionMetadata(ctx: ExecutionContext): Record<string, unknown> {
  return {
    agentId: ctx.agentId,
    ...(ctx.channelId ? { channelId: ctx.channelId } : {}),
    ...(ctx.channelTarget ? { channelTarget: ctx.channelTarget } : {}),
    ...(ctx.platform ? { channelType: ctx.platform, platform: ctx.platform } : {}),
    ...(ctx.platformUserId ? { platformUserId: ctx.platformUserId } : {}),
    ...(ctx.authorId ? { authorId: ctx.authorId } : {}),
    ...(ctx.authorName ? { authorName: ctx.authorName } : {}),
    ...(ctx.principalId ? { principalId: ctx.principalId } : {}),
    ...(ctx.principalName ? { principalName: ctx.principalName } : {}),
    ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
    ...(ctx.projectSlug ? { projectSlug: ctx.projectSlug } : {}),
    ...(ctx.projectRole ? { projectRole: ctx.projectRole } : {}),
    ...(ctx.workspaceRoot ? { workspaceRoot: ctx.workspaceRoot } : {}),
    ...(ctx.projectRoot ? { projectRoot: ctx.projectRoot } : {}),
    ...(ctx.allowedToolRoot ? { allowedToolRoot: ctx.allowedToolRoot } : {}),
    ...(ctx.sharedSessionId ? { sharedSessionId: ctx.sharedSessionId } : {}),
    ...(ctx.networkSessionId ? { networkSessionId: ctx.networkSessionId } : {}),
    ...(ctx.hostNodeId ? { hostNodeId: ctx.hostNodeId } : {}),
    ...(ctx.participantNodeIds ? { participantNodeIds: ctx.participantNodeIds } : {}),
    ...(ctx.ownerPrincipalId ? { ownerPrincipalId: ctx.ownerPrincipalId } : {}),
    ...(ctx.participantIds ? { participantIds: ctx.participantIds } : {}),
    ...(ctx.activeParticipantIds ? { activeParticipantIds: ctx.activeParticipantIds } : {}),
    ...(ctx.threadId ? { threadId: ctx.threadId } : {}),
  };
}

export function toCommandContext(ctx: ExecutionContext): {
  channelId: string;
  authorId: string;
  authorName: string;
  principalId?: string;
  principalName?: string;
  projectId?: string;
  projectSlug?: string;
  projectRole?: string;
  sharedSessionId?: string;
  networkSessionId?: string;
  hostNodeId?: string;
  participantNodeIds?: string[];
  ownerPrincipalId?: string;
  participantIds?: string[];
  activeParticipantIds?: string[];
  agentId: string;
  executionContext: ExecutionContext;
} {
  return {
    channelId: ctx.channelId ?? '',
    authorId: ctx.authorId ?? '',
    authorName: ctx.authorName ?? ctx.principalName ?? '',
    principalId: ctx.principalId,
    principalName: ctx.principalName,
    projectId: ctx.projectId,
    projectSlug: ctx.projectSlug,
    projectRole: ctx.projectRole,
    sharedSessionId: ctx.sharedSessionId,
    networkSessionId: ctx.networkSessionId,
    hostNodeId: ctx.hostNodeId,
    participantNodeIds: ctx.participantNodeIds,
    ownerPrincipalId: ctx.ownerPrincipalId,
    participantIds: ctx.participantIds,
    activeParticipantIds: ctx.activeParticipantIds,
    agentId: ctx.agentId,
    executionContext: ctx,
  };
}

export function toAuditContext(ctx: ExecutionContext): {
  agentId: string;
  sessionId: string;
  principalId?: string;
  principalName?: string;
  projectId?: string;
  projectSlug?: string;
  sharedSessionId?: string;
  networkSessionId?: string;
  hostNodeId?: string;
  participantNodeIds?: string[];
  participantIds?: string[];
} {
  return {
    agentId: ctx.agentId,
    sessionId: ctx.sessionId ?? 'unknown',
    ...(ctx.principalId ? { principalId: ctx.principalId } : {}),
    ...(ctx.principalName ? { principalName: ctx.principalName } : {}),
    ...(ctx.projectId ? { projectId: ctx.projectId } : {}),
    ...(ctx.projectSlug ? { projectSlug: ctx.projectSlug } : {}),
    ...(ctx.sharedSessionId ? { sharedSessionId: ctx.sharedSessionId } : {}),
    ...(ctx.networkSessionId ? { networkSessionId: ctx.networkSessionId } : {}),
    ...(ctx.hostNodeId ? { hostNodeId: ctx.hostNodeId } : {}),
    ...(ctx.participantNodeIds ? { participantNodeIds: ctx.participantNodeIds } : {}),
    ...(ctx.participantIds ? { participantIds: ctx.participantIds } : {}),
  };
}
