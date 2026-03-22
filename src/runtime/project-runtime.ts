import { createProjectBootstrapRuntime } from './project-bootstrap.js';
import { createProjectMembersRuntime } from './project-members.js';
import { createProjectNetworkRuntime } from './project-network.js';
import { createProjectRuntimeShared } from './project-runtime-shared.js';
import type { ProjectRuntime, ProjectRuntimeInput } from './project-runtime-types.js';
import { createProjectSyncRuntime } from './project-sync.js';

export type {
  ProjectRuntime,
  ProjectRuntimeInput,
  ProjectRuntimeShared,
  ResolvedDiscordIdentity,
  ResolvedProjectBinding,
  ProjectRoomNotifierLike,
  DiscordProjectSupportLike,
} from './project-runtime-types.js';

export function createProjectRuntime(input: ProjectRuntimeInput): ProjectRuntime {
  const shared = createProjectRuntimeShared(input);
  const members = createProjectMembersRuntime(shared);
  const sync = createProjectSyncRuntime(shared);
  const network = createProjectNetworkRuntime(shared);
  const bootstrap = createProjectBootstrapRuntime(shared);

  return {
    resolveProject: shared.resolveProject,
    buildProjectBackground: shared.buildProjectBackground,
    activateCollaborativeProject: shared.activateCollaborativeProject,
    autoEnrollProjectRoomParticipant: members.autoEnrollProjectRoomParticipant,
    sweepProjectRoomSignal: sync.sweepProjectRoomSignal,
    normalizeDiscordPolicyIdentity: members.normalizeDiscordPolicyIdentity,
    buildAgentAccessMetadata: members.buildAgentAccessMetadata,
    isDiscordInvocationAllowed: members.isDiscordInvocationAllowed,
    manageDiscordProjectMemberFromTool: members.manageDiscordProjectMemberFromTool,
    syncDiscordProjectFromTool: sync.syncDiscordProjectFromTool,
    closeDiscordProjectFromTool: sync.closeDiscordProjectFromTool,
    manageDiscordRoomAccessFromTool: members.manageDiscordRoomAccessFromTool,
    inspectDiscordRoomFromTool: members.inspectDiscordRoomFromTool,
    manageProjectNetworkFromTool: network.manageProjectNetworkFromTool,
    bootstrapDiscordProjectFromTool: bootstrap.bootstrapDiscordProjectFromTool,
    notifyPatchApprovalReview: shared.notifyPatchApprovalReview,
    formatSharedSessionJoinNotice: shared.formatSharedSessionJoinNotice,
  };
}
