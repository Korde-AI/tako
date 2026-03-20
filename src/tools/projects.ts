import type { Tool, ToolContext, ToolResult } from './tool.js';

export interface ProjectBootstrapRequest {
  prompt: string;
  destination?: 'channel' | 'thread' | 'here' | 'auto';
  displayName?: string;
  slug?: string;
  description?: string;
}

export interface ProjectMemberManageRequest {
  action: 'add' | 'list';
  targetIdentity?: string;
  role?: 'read' | 'contribute' | 'write' | 'admin';
  projectSlug?: string;
}

export interface ProjectToolDeps {
  bootstrapFromPrompt: (input: ProjectBootstrapRequest, ctx: ToolContext) => Promise<ToolResult>;
  manageMember: (input: ProjectMemberManageRequest, ctx: ToolContext) => Promise<ToolResult>;
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
      return deps.bootstrapFromPrompt(params as ProjectBootstrapRequest, ctx);
    },
  };

  const projectMemberManage: Tool = {
    name: 'project_member_manage',
    description: 'Manage project members in the current project room. Use this when the owner or a project admin wants to add or invite a human collaborator to the project, or list current project members. In Discord, this should be used for requests like "add Jiaxin to this project", "invite wandering123", or "who is in this project?". Adding a member promotes the project to collaborative mode.',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add', 'list'],
          description: 'Whether to add a member or list current members.',
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
      return deps.manageMember(params as ProjectMemberManageRequest, ctx);
    },
  };

  return [projectBootstrap, projectMemberManage];
}
