/**
 * Agent communication tool — allows agents to message each other.
 */

import type { Tool, ToolContext, ToolResult } from './tool.js';
import type { AgentComms } from '../agents/communication.js';

/** Create the agent_send tool with a reference to the comms hub. */
export function createCommsTool(comms: AgentComms): Tool {
  return {
    name: 'agent_send',
    description: 'Send a message to another agent and get their response. Use this to delegate tasks or ask other agents for information.',
    group: 'agents',
    parameters: {
      type: 'object',
      properties: {
        to: { type: 'string', description: 'Target agent ID to send the message to' },
        message: { type: 'string', description: 'Message content to send' },
        replyTo: { type: 'string', description: 'Optional message ID to reply to' },
      },
      required: ['to', 'message'],
    },

    async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
      const { to, message, replyTo } = params as { to: string; message: string; replyTo?: string };
      const fromAgent = ctx.agentId ?? 'main';

      try {
        const response = await comms.send(fromAgent, to, message, replyTo);
        return {
          output: response,
          success: true,
        };
      } catch (err) {
        return {
          output: '',
          success: false,
          error: `Failed to send message: ${err instanceof Error ? err.message : String(err)}`,
        };
      }
    },
  };
}
