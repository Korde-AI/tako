import type { Tool, ToolContext, ToolResult } from './tool.js';

export interface ProjectBootstrapRequest {
  prompt: string;
  destination?: 'channel' | 'thread' | 'here' | 'auto';
  displayName?: string;
  slug?: string;
  description?: string;
}

export interface ProjectToolDeps {
  bootstrapFromPrompt: (input: ProjectBootstrapRequest, ctx: ToolContext) => Promise<ToolResult>;
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

  return [projectBootstrap];
}
