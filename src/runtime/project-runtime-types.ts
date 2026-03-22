import type { ChannelPlatform } from '../channels/platforms.js';
import type { TakoConfig } from '../config/schema.js';
import type { ChannelDeliveryRegistry } from '../core/channel-delivery.js';
import type { ExecutionContext } from '../core/execution-context.js';
import type { NodeIdentity } from '../core/node-identity.js';
import type { TakoPaths } from '../core/paths.js';
import type { SessionManager } from '../gateway/session.js';
import type { EdgeHubClient } from '../network/edge-client.js';
import type { NetworkSharedSessionStore } from '../network/shared-sessions.js';
import { TrustStore } from '../network/trust.js';
import type { PrincipalRegistry } from '../principals/registry.js';
import type { ProjectBindingRegistry } from '../projects/bindings.js';
import type { ProjectChannelCoordinatorRegistry } from '../projects/channel-coordination.js';
import type { ProjectMembershipRegistry } from '../projects/memberships.js';
import type { ProjectRegistry } from '../projects/registry.js';
import type { Project, ProjectBackgroundSnapshot, ProjectRole } from '../projects/types.js';
import type { SharedSession } from '../sessions/shared.js';
import type {
  ProjectBootstrapRequest,
  ProjectCloseRequest,
  ProjectMemberManageRequest,
  ProjectNetworkManageRequest,
  ProjectSyncRequest,
} from '../tools/projects.js';
import type { DiscordRoomAccessRequest, DiscordRoomInspectRequest } from '../tools/discord-room.js';
import type { ToolContext, ToolResult } from '../tools/tool.js';

export interface ResolvedProjectBinding {
  binding: NonNullable<ReturnType<ProjectBindingRegistry['resolve']>>;
  project: Project;
}

export interface ResolvedDiscordIdentity {
  principalId: string;
  displayName: string;
  userId?: string;
  username?: string;
}

export interface ProjectRoomNotifierLike {
  notify(projectId: string, content: string): Promise<void>;
}

export interface DiscordProjectSupportLike {
  resolvePrincipalIdentity(identity: string): ResolvedDiscordIdentity | null;
  resolvePrincipalIdentityFromRoom(identity: string, ctx: ToolContext): Promise<ResolvedDiscordIdentity | null>;
}

export interface ProjectRuntimeInput {
  config: TakoConfig;
  runtimePaths: TakoPaths;
  sessions: SessionManager;
  principalRegistry: PrincipalRegistry;
  projectRegistry: ProjectRegistry;
  projectMemberships: ProjectMembershipRegistry;
  projectBindings: ProjectBindingRegistry;
  projectChannelCoordinators: ProjectChannelCoordinatorRegistry;
  channelDeliveryRegistry: ChannelDeliveryRegistry;
  trustStore: TrustStore;
  networkSharedSessions: NetworkSharedSessionStore;
  getHubClient: () => EdgeHubClient | null;
  getNodeIdentity: () => NodeIdentity;
  getProjectRoomNotifier: () => ProjectRoomNotifierLike;
  getDiscordProjectSupport: () => DiscordProjectSupportLike;
  getAgentBaseRole: (agentId: string) => string;
}

export interface ProjectRuntime {
  resolveProject(input: {
    platform: ChannelPlatform;
    channelTarget: string;
    threadId?: string;
    agentId?: string;
  }): ResolvedProjectBinding | null;
  buildProjectBackground(projectId: string, reason: string, shared?: SharedSession | null): Promise<ProjectBackgroundSnapshot | null>;
  activateCollaborativeProject(projectId: string, reason: string): Promise<Project | null>;
  autoEnrollProjectRoomParticipant(input: {
    project: Project;
    principalId: string;
    principalName?: string;
    platformUserId?: string;
    platform: ChannelPlatform;
    addedBy: string;
  }): Promise<boolean>;
  sweepProjectRoomSignal(input: {
    project: Project;
    principalId: string;
    principalName?: string;
    text: string;
  }): Promise<void>;
  normalizeDiscordPolicyIdentity(value?: string | null): string | null;
  buildAgentAccessMetadata(input: {
    platform: ChannelPlatform;
    agentId: string;
    authorId: string;
    principalId?: string;
    project?: Project | null;
    metadata?: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
  isDiscordInvocationAllowed(input: {
    agentId: string;
    authorId: string;
    authorName?: string;
    username?: string;
    principalId?: string;
    channelName?: string;
    parentChannelName?: string;
    project?: Project | null;
  }): Promise<{ allowed: boolean; reason: string }>;
  manageDiscordProjectMemberFromTool(input: ProjectMemberManageRequest, ctx: ToolContext): Promise<ToolResult>;
  syncDiscordProjectFromTool(input: ProjectSyncRequest, ctx: ToolContext): Promise<ToolResult>;
  closeDiscordProjectFromTool(input: ProjectCloseRequest, ctx: ToolContext): Promise<ToolResult>;
  manageDiscordRoomAccessFromTool(input: DiscordRoomAccessRequest, ctx: ToolContext): Promise<ToolResult>;
  inspectDiscordRoomFromTool(input: DiscordRoomInspectRequest, ctx: ToolContext): Promise<ToolResult>;
  manageProjectNetworkFromTool(input: ProjectNetworkManageRequest, ctx: ToolContext): Promise<ToolResult>;
  bootstrapDiscordProjectFromTool(input: ProjectBootstrapRequest, ctx: ToolContext): Promise<ToolResult>;
  notifyPatchApprovalReview(input: {
    projectId: string;
    projectSlug?: string;
    approvalId: string;
    artifactName: string;
    requestedByNodeId?: string;
    requestedByPrincipalId?: string;
    sourceBranch?: string;
    targetBranch?: string;
    conflictSummary?: string;
  }): Promise<void>;
  formatSharedSessionJoinNotice(input: {
    displayName: string;
    projectSlug: string;
    snapshotSummary?: string;
  }): string;
}

export interface ProjectRuntimeShared {
  input: ProjectRuntimeInput;
  resolveProject(input: {
    platform: ChannelPlatform;
    channelTarget: string;
    threadId?: string;
    agentId?: string;
  }): ResolvedProjectBinding | null;
  resolveProjectForToolContext(input: {
    explicitProjectSlug?: string;
    executionContext?: ExecutionContext;
    sessionId?: string;
  }): Project | null;
  ensureLocalProjectMirror(input: {
    project: Project;
    source: 'invite_accept' | 'project_sync';
    inviteId?: string;
    hostNodeId?: string;
    hostNodeName?: string;
    offeredRole?: ProjectRole;
    sharedDocs?: Record<string, string>;
  }): Promise<{ projectRoot: string; worktreeRoot: string; created: boolean }>;
  collectInviteSharedDocsSnapshot(project: Project): Promise<Record<string, string>>;
  ensureAcceptedProjectWorkspaceAtRuntime(input: {
    invite: {
      inviteId: string;
      projectId: string;
      projectSlug: string;
      hostNodeId: string;
      hostNodeName?: string;
      issuedByPrincipalId: string;
      offeredRole: ProjectRole;
      metadata?: Record<string, unknown>;
    };
    executionContext?: ExecutionContext;
  }): Promise<{ projectId: string; projectRoot: string; worktreeRoot: string }>;
  buildProjectBackground(projectId: string, reason: string, shared?: SharedSession | null): Promise<ProjectBackgroundSnapshot | null>;
  activateCollaborativeProject(projectId: string, reason: string): Promise<Project | null>;
  reconcileProjectCollaborationMode(projectId: string, reason: string): Promise<Project | null>;
  notifyPatchApprovalReview(input: {
    projectId: string;
    projectSlug?: string;
    approvalId: string;
    artifactName: string;
    requestedByNodeId?: string;
    requestedByPrincipalId?: string;
    sourceBranch?: string;
    targetBranch?: string;
    conflictSummary?: string;
  }): Promise<void>;
  formatSharedSessionJoinNotice(input: {
    displayName: string;
    projectSlug: string;
    snapshotSummary?: string;
  }): string;
}
