/**
 * Session tools — session_status, sessions_list, sessions_send.
 *
 * Note: sessions_spawn and sessions_history have moved to agent-tools.ts
 * where they integrate with the AgentRegistry and SubAgentOrchestrator.
 */

import type { Tool, ToolContext, ToolResult } from './tool.js';
import type { SessionManager } from '../gateway/session.js';

/**
 * Create session tools bound to a SessionManager instance.
 */
export function createSessionTools(sessions: SessionManager): Tool[] {
  const sessionStatusTool: Tool = {
    name: 'session_status',
    description: 'Get status of the current session including message count, creation time, and metadata.',
    group: 'sessions',
    parameters: {
      type: 'object',
      properties: {},
    },

    async execute(_params: unknown, ctx: ToolContext): Promise<ToolResult> {
      const session = sessions.get(ctx.sessionId);
      if (!session) {
        return { output: '', success: false, error: 'Session not found' };
      }
      const info = {
        id: session.id,
        name: session.name,
        agentId: session.metadata.agentId ?? 'main',
        createdAt: session.createdAt.toISOString(),
        lastActiveAt: session.lastActiveAt.toISOString(),
        messageCount: session.messages.length,
        isSubAgent: session.metadata.isSubAgent ?? false,
        parentSessionId: session.metadata.parentSessionId,
        metadata: session.metadata,
      };
      return { output: JSON.stringify(info, null, 2), success: true };
    },
  };

  const sessionsListTool: Tool = {
    name: 'sessions_list',
    description: 'List sessions with optional filters by agent, activity, and message count.',
    group: 'sessions',
    parameters: {
      type: 'object',
      properties: {
        agentId: {
          type: 'string',
          description: 'Filter by agent ID',
        },
        activeMinutes: {
          type: 'number',
          description: 'Only show sessions active within the last N minutes',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of sessions to return (default: 20)',
          default: 20,
        },
        messageLimit: {
          type: 'number',
          description: 'Only show sessions with at least N messages',
        },
      },
    },

    async execute(params: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const {
        agentId,
        activeMinutes,
        limit = 20,
        messageLimit,
      } = (params ?? {}) as {
        agentId?: string;
        activeMinutes?: number;
        limit?: number;
        messageLimit?: number;
      };

      let allSessions = sessions.list();

      // Filter by agent ID
      if (agentId) {
        allSessions = allSessions.filter(
          (s) => (s.metadata.agentId ?? 'main') === agentId,
        );
      }

      // Filter by activity
      if (activeMinutes) {
        const cutoff = Date.now() - activeMinutes * 60_000;
        allSessions = allSessions.filter(
          (s) => s.lastActiveAt.getTime() > cutoff,
        );
      }

      // Filter by message count
      if (messageLimit) {
        allSessions = allSessions.filter(
          (s) => s.messages.length >= messageLimit,
        );
      }

      // Sort by most recently active first
      allSessions.sort((a, b) => b.lastActiveAt.getTime() - a.lastActiveAt.getTime());

      // Apply limit
      const limited = allSessions.slice(0, limit);

      const output = limited.map((s) => ({
        id: s.id,
        name: s.name,
        agentId: s.metadata.agentId ?? 'main',
        messageCount: s.messages.length,
        lastActive: s.lastActiveAt.toISOString(),
        isSubAgent: s.metadata.isSubAgent ?? false,
      }));

      return {
        output: JSON.stringify({
          total: allSessions.length,
          returned: output.length,
          sessions: output,
        }, null, 2),
        success: true,
      };
    },
  };

  const sessionsSendTool: Tool = {
    name: 'sessions_send',
    description: 'Send a message into another session. The message is appended as a user message to that session\'s history.',
    group: 'sessions',
    parameters: {
      type: 'object',
      properties: {
        sessionId: { type: 'string', description: 'Target session ID' },
        message: { type: 'string', description: 'Message to send' },
      },
      required: ['sessionId', 'message'],
    },

    async execute(params: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const { sessionId, message } = params as { sessionId: string; message: string };

      const target = sessions.get(sessionId);
      if (!target) {
        return {
          output: '',
          success: false,
          error: `Session not found: ${sessionId}`,
        };
      }

      // Append the message to the target session
      sessions.addMessage(sessionId, {
        role: 'user',
        content: message,
      });

      return {
        output: JSON.stringify({
          sessionId,
          sessionName: target.name,
          messageCount: target.messages.length,
          sent: true,
        }, null, 2),
        success: true,
      };
    },
  };

  return [sessionStatusTool, sessionsListTool, sessionsSendTool];
}
