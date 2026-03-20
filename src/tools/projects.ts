import type { Tool, ToolContext, ToolResult } from './tool.js';

export interface ProjectBootstrapRequest {
  prompt: string;
  destination?: 'channel' | 'thread' | 'here' | 'auto';
  displayName?: string;
  slug?: string;
  description?: string;
}

export interface ProjectMemberManageRequest {
  action: 'add' | 'remove' | 'list';
  targetIdentity?: string;
  role?: 'read' | 'contribute' | 'write' | 'admin';
  projectSlug?: string;
}

export interface ProjectSyncRequest {
  update?: string;
  projectSlug?: string;
}

export interface ProjectCloseRequest {
  reason?: string;
  projectSlug?: string;
}

export interface ProjectNetworkManageRequest {
  action: 'invite_create' | 'invite_list' | 'invite_accept';
  projectSlug?: string;
  targetNodeId?: string;
  targetHint?: string;
  role?: 'read' | 'contribute' | 'write' | 'admin';
  ceiling?: 'read' | 'contribute' | 'write' | 'admin';
  inviteId?: string;
}

export interface ProjectToolDeps {
  bootstrapFromPrompt: (input: ProjectBootstrapRequest, ctx: ToolContext) => Promise<ToolResult>;
  manageMember: (input: ProjectMemberManageRequest, ctx: ToolContext) => Promise<ToolResult>;
  syncProject: (input: ProjectSyncRequest, ctx: ToolContext) => Promise<ToolResult>;
  closeProject: (input: ProjectCloseRequest, ctx: ToolContext) => Promise<ToolResult>;
  manageNetwork: (input: ProjectNetworkManageRequest, ctx: ToolContext) => Promise<ToolResult>;
}

export function createProjectTools(deps: ProjectToolDeps): Tool[] {
  const projectBootstrap: Tool = {
    name: 'project_bootstrap',
    description: 'Create and bind a collaborative project space from a natural-language owner request. In Discord, use this when the owner asks to create/open/start a project, workspace, collaboration room, channel, or thread. Pass the user request directly in `prompt`; the tool can infer project name, description, and destination.',
    group: 'agents',
    parameters: {
      type: 'object',
      properties: {
        prompt: {
          type: 'string',
          description: 'The user\'s natural-language request, preferably copied verbatim.',
        },
        destination: {
          type: 'string',
          enum: ['auto', 'channel', 'thread', 'here'],
          description: 'Optional override for where the project room should be created or bound.',
        },
        displayName: {
          type: 'string',
          description: 'Optional explicit project display name if the model wants to override the inferred one.',
        },
        slug: {
          type: 'string',
          description: 'Optional explicit slug if the model wants to override the inferred one.',
        },
        description: {
          type: 'string',
          description: 'Optional explicit project description if the model wants to override the inferred one.',
        },
      },
      required: ['prompt'],
    },
    async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
      const raw = params as { input?: string };
      const parsed = (raw?.input && typeof raw.input === 'string')
        ? { prompt: raw.input }
        : params as ProjectBootstrapRequest;
      return deps.bootstrapFromPrompt(parsed, ctx);
    },
  };

  const projectMemberManage: Tool = {
    name: 'project_member_manage',
    description: 'Manage project members in the current project room. Use this when the owner or a project admin wants to add, remove, invite, or list project members. In Discord, this should be used for requests like "add Jiaxin to this project", "remove CC from this project", "invite wandering123", or "who is in this project?". Member changes should follow current room membership when relevant.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'remove', 'list'],
          description: 'Whether to add, remove, or list project members.',
        },
        targetIdentity: {
          type: 'string',
          description: 'Discord user ID, @username, username, display name, or principal ID for the member to add.',
        },
        role: {
          type: 'string',
          enum: ['read', 'contribute', 'write', 'admin'],
          description: 'Project role to assign when adding a member. Defaults to contribute.',
        },
        projectSlug: {
          type: 'string',
          description: 'Optional project slug override. Omit to use the current project room.',
        },
      },
      required: ['action'],
    },
    async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
      const raw = params as { input?: string };
      if (raw?.input && typeof raw.input === 'string') {
        const input = raw.input.trim();
        const lower = input.toLowerCase();
        if (!input || lower === 'list' || lower.includes('who is in') || lower.includes('list members')) {
          return deps.manageMember({ action: 'list' }, ctx);
        }
        if (lower.startsWith('remove ') || lower.startsWith('delete ')) {
          const targetIdentity = input
            .replace(/^(remove|delete)\s+/i, '')
            .replace(/\s+(from)\s+this project.*$/i, '')
            .trim();
          return deps.manageMember({ action: 'remove', targetIdentity }, ctx);
        }
        const targetIdentity = input
          .replace(/^(add|invite)\s+/i, '')
          .replace(/\s+(to|into)\s+this project.*$/i, '')
          .replace(/\s+as\s+.*/i, '')
          .trim();
        return deps.manageMember({ action: 'add', targetIdentity, role: 'contribute' }, ctx);
      }
      return deps.manageMember(params as ProjectMemberManageRequest, ctx);
    },
  };

  const projectSync: Tool = {
    name: 'project_sync',
    description: 'Sync shared project state for the current project. Use this when the user says things like "sync the progress", "sync your work tree", "sync this project", or "sync to other participants". This rebuilds the project background, ensures the local project workspace/worktree exists under the agent workspace, announces a concise update, and can append an update note into STATUS.md.',
    parameters: {
      type: 'object',
      properties: {
        update: {
          type: 'string',
          description: 'Optional progress note to append to STATUS.md and announce in the bound room.',
        },
        projectSlug: {
          type: 'string',
          description: 'Optional project slug override. Omit to use the current project room.',
        },
      },
    },
    async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
      const raw = params as { input?: string };
      const parsed = (raw?.input && typeof raw.input === 'string')
        ? { update: raw.input }
        : params as ProjectSyncRequest;
      return deps.syncProject(parsed, ctx);
    },
  };

  const projectClose: Tool = {
    name: 'project_close',
    description: 'Close the current project. Use this when the owner or an admin wants to close or finish a project. This sets the project status to closed, updates STATUS.md, and announces the closure.',
    parameters: {
      type: 'object',
      properties: {
        reason: {
          type: 'string',
          description: 'Optional closure reason or final note.',
        },
        projectSlug: {
          type: 'string',
          description: 'Optional project slug override. Omit to use the current project room.',
        },
      },
    },
    async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
      const raw = params as { input?: string };
      const parsed = (raw?.input && typeof raw.input === 'string')
        ? { reason: raw.input }
        : params as ProjectCloseRequest;
      return deps.closeProject(parsed, ctx);
    },
  };

  const projectNetworkManage: Tool = {
    name: 'project_network_manage',
    description: 'Manage project/node collaboration invites. Use this to create a project invite for another agent or node, list available invites on this node, or accept an invite so this node joins the project and provisions its local project workspace/worktree. Prefer human-friendly identities in `targetHint` such as a bot name, @mention, or node name instead of exposing raw node IDs to users.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['invite_create', 'invite_list', 'invite_accept'],
          description: 'Create, list, or accept project collaboration invites.',
        },
        projectSlug: {
          type: 'string',
          description: 'Project slug override. Omit to use the current project when creating an invite.',
        },
        targetNodeId: {
          type: 'string',
          description: 'Optional remote node ID to invite. Usually omit this and use targetHint instead.',
        },
        targetHint: {
          type: 'string',
          description: 'Human-friendly target identity such as a Discord bot name, @mention, known node name, or agent name.',
        },
        role: {
          type: 'string',
          enum: ['read', 'contribute', 'write', 'admin'],
          description: 'Offered project role for the remote node.',
        },
        ceiling: {
          type: 'string',
          enum: ['read', 'contribute', 'write', 'admin'],
          description: 'Authority ceiling for the trust relationship.',
        },
        inviteId: {
          type: 'string',
          description: 'Invite ID to accept.',
        },
      },
      required: ['action'],
    },
    async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
      const raw = params as { input?: string };
      if (raw?.input && typeof raw.input === 'string') {
        const input = raw.input.trim();
        const lower = input.toLowerCase();
        if (!input || lower.includes('list invite')) {
          return deps.manageNetwork({ action: 'invite_list' }, ctx);
        }
        if (lower.startsWith('accept ')) {
          return deps.manageNetwork({ action: 'invite_accept', inviteId: input.slice('accept '.length).trim() }, ctx);
        }
        if (lower.includes('accept') && (lower.includes('latest invite') || lower.includes('this channel') || lower.includes('here'))) {
          return deps.manageNetwork({ action: 'invite_accept' }, ctx);
        }
        if (lower.includes('invite')) {
          const targetHint = input
            .replace(/^(create\s+)?(a\s+)?(project\s+)?invite\s+(for\s+)?/i, '')
            .replace(/^(invite)\s+/i, '')
            .replace(/\s+(to\s+join|into|to)\s+(this\s+)?project.*$/i, '')
            .replace(/\s+as\s+(read|contribute|write|admin).*$/i, '')
            .trim();
          return deps.manageNetwork({ action: 'invite_create', targetHint, role: 'contribute' }, ctx);
        }
      }
      return deps.manageNetwork(params as ProjectNetworkManageRequest, ctx);
    },
  };

  return [projectBootstrap, projectMemberManage, projectSync, projectClose, projectNetworkManage];
}
