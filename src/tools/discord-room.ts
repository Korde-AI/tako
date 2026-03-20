import type { Tool, ToolContext, ToolResult } from './tool.js';

export interface DiscordRoomAccessRequest {
  action: 'add';
  targetIdentity: string;
  channelId?: string;
}

export interface DiscordRoomInspectRequest {
  action?: 'inspect';
  channelId?: string;
}

export interface DiscordRoomToolDeps {
  manageAccess: (input: DiscordRoomAccessRequest, ctx: ToolContext) => Promise<ToolResult>;
  inspectRoom: (input: DiscordRoomInspectRequest, ctx: ToolContext) => Promise<ToolResult>;
}

export function createDiscordRoomTools(deps: DiscordRoomToolDeps): Tool[] {
  const discordRoomAccessManage: Tool = {
    name: 'discord_room_access_manage',
    description: 'Manage access to the current Discord room. Use this when the user wants an existing server member to join or access the current Discord channel, even if no project is bound yet. If the target user is not yet in the server or cannot be resolved, return guidance instead of pretending success.',
    group: 'messaging',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['add'],
          description: 'Grant an existing Discord server member access to a channel.',
        },
        targetIdentity: {
          type: 'string',
          description: 'Discord user ID, @username, username, display name, or principal ID for the person to add.',
        },
        channelId: {
          type: 'string',
          description: 'Optional Discord channel ID override. Omit to use the current room context.',
        },
      },
      required: ['action', 'targetIdentity'],
    },
    async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
      const raw = params as { input?: string };
      if (raw?.input && typeof raw.input === 'string') {
        const input = raw.input
          .trim()
          .replace(/^(add|invite|let)\s+/i, '')
          .replace(/\s+(join|into|to)\s+(this|the)\s+(channel|room).*$/i, '')
          .trim();
        return deps.manageAccess({ action: 'add', targetIdentity: input }, ctx);
      }
      return deps.manageAccess(params as DiscordRoomAccessRequest, ctx);
    },
  };

  const discordRoomInspect: Tool = {
    name: 'discord_room_inspect',
    description: 'Inspect the current Discord room to answer questions like who is here, who can access this channel, whether this room is private, and whether it is bound to a project. Room access is volatile, so call this again for each fresh question about current membership or channel access. Do not rely on earlier inspection results or guess extra users/bots that are not in the latest tool output.',
    group: 'messaging',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['inspect'],
          description: 'Inspect the current Discord room or a specific Discord channel ID.',
        },
        channelId: {
          type: 'string',
          description: 'Optional Discord channel ID override. Omit to use the current room context.',
        },
      },
    },
    async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
      const raw = params as { input?: string };
      if (raw?.input && typeof raw.input === 'string') {
        return deps.inspectRoom({}, ctx);
      }
      return deps.inspectRoom(params as DiscordRoomInspectRequest, ctx);
    },
  };

  return [discordRoomAccessManage, discordRoomInspect];
}
