export type ProjectStatus = 'active' | 'archived' | 'closed';
export type ProjectRole = 'read' | 'contribute' | 'write' | 'admin';

export interface ProjectCollaborationPolicy {
  mode?: 'single-user' | 'collaborative';
  autoArtifactSync?: boolean;
  patchRequiresApproval?: boolean;
  announceJoins?: boolean;
}

export interface Project {
  projectId: string;
  slug: string;
  displayName: string;
  ownerPrincipalId: string;
  workspaceRoot?: string;
  collaboration?: ProjectCollaborationPolicy;
  status: ProjectStatus;
  description?: string;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface ProjectMembership {
  projectId: string;
  principalId: string;
  role: ProjectRole;
  addedBy: string;
  addedAt: string;
  updatedAt: string;
}

export interface ProjectBinding {
  bindingId: string;
  projectId: string;
  platform: 'discord' | 'telegram' | 'cli';
  channelTarget: string;
  threadId?: string;
  agentId?: string;
  createdAt: string;
  status?: 'active' | 'inactive';
  deactivatedAt?: string;
  deactivatedReason?: string;
}

export type ProjectArtifactScope = 'shared';
export type ProjectArtifactKind = 'file' | 'patch';

export interface ProjectArtifact {
  artifactId: string;
  projectId: string;
  name: string;
  relativePath: string;
  publishedByPrincipalId: string;
  sourceNodeId?: string;
  scope: ProjectArtifactScope;
  kind: ProjectArtifactKind;
  sizeBytes: number;
  description?: string;
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface ProjectWorktree {
  worktreeId: string;
  projectId: string;
  nodeId: string;
  root: string;
  label?: string;
  ownerPrincipalId?: string;
  status: 'active' | 'inactive';
  createdAt: string;
  updatedAt: string;
  metadata?: Record<string, unknown>;
}

export interface ProjectBackgroundSnapshot {
  projectId: string;
  projectSlug?: string;
  generatedAt: string;
  reason: string;
  memberCount: number;
  members: Array<{
    principalId: string;
    displayName?: string;
    role: ProjectRole;
  }>;
  participantCount: number;
  participantIds: string[];
  activeParticipantIds: string[];
  participantNodeIds?: string[];
  recentArtifacts: Array<{
    artifactId: string;
    name: string;
    kind: ProjectArtifactKind;
    sourceNodeId?: string;
    createdAt: string;
  }>;
  worktrees: Array<{
    nodeId: string;
    root: string;
    label?: string;
    branch?: string;
    dirty?: boolean;
  }>;
  summary: string;
  roomState?: 'active' | 'pending_rebind';
}

export interface ProjectPatchApproval {
  approvalId: string;
  projectId: string;
  artifactId: string;
  artifactName: string;
  targetNodeId?: string;
  requestedByNodeId?: string;
  requestedByPrincipalId?: string;
  status: 'pending' | 'approved' | 'denied' | 'conflict';
  reason?: string;
  sourceBranch?: string;
  targetBranch?: string;
  conflictSummary?: string;
  createdAt: string;
  updatedAt: string;
  reviewedByPrincipalId?: string;
}

export interface ProjectBranchRecord {
  branchRecordId: string;
  projectId: string;
  nodeId: string;
  branchName: string;
  baseBranch?: string;
  worktreeRoot?: string;
  status: 'active' | 'merged' | 'stale' | 'conflict';
  conflictArtifactId?: string;
  conflictSummary?: string;
  createdAt: string;
  updatedAt: string;
}
