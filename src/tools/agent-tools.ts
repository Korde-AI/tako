/**
 * Agent tools — tools the agent can use to manage other agents and sub-agents.
 *
 * - agents_list: List available agent IDs
 * - sessions_spawn: Spawn a sub-agent (one-shot or persistent)
 * - sessions_history: Fetch message history for a session
 * - subagents: List, steer, or kill spawned sub-agents
 */

import type { Tool, ToolContext, ToolResult } from './tool.js';
import type { AgentRegistry } from '../agents/registry.js';
import type { SubAgentOrchestrator, SubAgentMode } from '../agents/subagent.js';
import type { SessionManager } from '../gateway/session.js';
import type { ThreadBindingManager } from '../core/thread-bindings.js';
import type { DiscordChannel } from '../channels/discord.js';
import { PREDEFINED_ROLES } from '../agents/roles.js';

export interface AgentToolsDeps {
  registry: AgentRegistry;
  orchestrator: SubAgentOrchestrator;
  sessions: SessionManager;
  threadBindings?: ThreadBindingManager;
}

/**
 * Create agent management tools bound to a registry and orchestrator.
 */
export function createAgentTools(deps: AgentToolsDeps): Tool[] {
  const { registry, orchestrator, sessions, threadBindings } = deps;

  // ─── agents_list ───────────────────────────────────────────────────

  const agentsListTool: Tool = {
    name: 'agents_list',
    description: 'List all available agent IDs, their status, workspace, and which can be spawned as sub-agents.',
    group: 'agents',
    parameters: {
      type: 'object',
      properties: {},
    },

    async execute(_params: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const agentsData = [];
      for (const a of registry.list()) {
        // Load channel config for each agent (shows enabled channels without exposing tokens)
        let channels: Record<string, unknown> | null = null;
        try {
          const channelConfig = await registry.loadChannelConfig(a.id);
          if (channelConfig) {
            channels = {};
            for (const [key, val] of Object.entries(channelConfig)) {
              const ch = val as Record<string, unknown>;
              channels[key] = {
                enabled: ch.enabled ?? false,
                ...(ch.guilds ? { guilds: ch.guilds } : {}),
                hasToken: !!ch.token,
              };
            }
          }
        } catch { /* no channel config */ }

        // Per-agent session stats
        const agentSessions = sessions.listByAgent(a.id);
        const lastActive = agentSessions.length > 0
          ? agentSessions.reduce((latest, s) =>
              s.lastActiveAt > latest ? s.lastActiveAt : latest,
              agentSessions[0].lastActiveAt,
            ).toISOString()
          : null;

        agentsData.push({
          id: a.id,
          workspace: a.workspace,
          model: a.model,
          description: a.description,
          isMain: a.isMain,
          role: a.role,
          bindings: a.bindings,
          canSpawn: a.canSpawn,
          channels,
          activeSessions: agentSessions.length,
          lastActiveAt: lastActive,
        });
      }

      return {
        output: JSON.stringify(agentsData, null, 2),
        success: true,
      };
    },
  };

  // ─── sessions_spawn ────────────────────────────────────────────────

  const sessionsSpawnTool: Tool = {
    name: 'sessions_spawn',
    description:
      'Spawn an isolated sub-agent session. Use mode "run" for one-shot tasks (execute and return result) or "session" for persistent sessions that can receive follow-up messages.',
    group: 'agents',
    parameters: {
      type: 'object',
      properties: {
        task: {
          type: 'string',
          description: 'Task description or initial message for the sub-agent',
        },
        agentId: {
          type: 'string',
          description: 'Agent ID to use (defaults to "main")',
        },
        mode: {
          type: 'string',
          enum: ['run', 'session'],
          description: 'Run mode: "run" for one-shot, "session" for persistent',
          default: 'run',
        },
        label: {
          type: 'string',
          description: 'Human-readable label for tracking this sub-agent',
        },
        model: {
          type: 'string',
          description: 'Model override (e.g. "anthropic/claude-opus-4-6")',
        },
        thread: {
          type: 'boolean',
          description: 'Create a Discord thread and bind the session to it',
        },
        threadName: {
          type: 'string',
          description: 'Thread name (default: 🐙 <agentId>)',
        },
      },
      required: ['task'],
    },

    async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
      const {
        task,
        agentId,
        mode = 'run',
        label,
        model,
        thread,
        threadName,
      } = params as {
        task: string;
        agentId?: string;
        mode?: SubAgentMode;
        label?: string;
        model?: string;
        thread?: boolean;
        threadName?: string;
      };

      // Validate agent exists if specified
      if (agentId && !registry.has(agentId)) {
        return {
          output: '',
          success: false,
          error: `Agent not found: ${agentId}. Use agents_list to see available agents.`,
        };
      }

      // Enforce canSpawn allowlist (admin/operator bypass)
      const callerAgent = ctx.agentId ? registry.get(ctx.agentId) : registry.get('main');
      if (callerAgent && agentId) {
        const role = callerAgent.role ?? 'standard';
        const canBypass = role === 'admin' || role === 'operator';
        const hasAllowlist = callerAgent.canSpawn && callerAgent.canSpawn.length > 0;
        if (!canBypass && hasAllowlist && !callerAgent.canSpawn.includes(agentId)) {
          return {
            output: '',
            success: false,
            error: `Agent "${callerAgent.id}" is not allowed to spawn "${agentId}". Allowed: ${callerAgent.canSpawn.join(', ')}`,
          };
        }
        if (!canBypass && !hasAllowlist && role !== 'standard') {
          return {
            output: '',
            success: false,
            error: `Agent "${callerAgent.id}" (role: ${role}) cannot spawn sub-agents.`,
          };
        }
      }

      const agent = agentId ? registry.get(agentId) : undefined;

      try {
        const run = await orchestrator.spawn(ctx.sessionId, {
          task,
          agentId,
          mode,
          label,
          model,
        }, agent);

        // ─── Thread binding (Discord only) ──────────────────────────
        let threadInfo: { threadId: string; threadName: string } | undefined;

        if (thread && ctx.channelType === 'discord' && ctx.channelTarget && ctx.channel) {
          const discordChannel = ctx.channel as DiscordChannel;
          const resolvedAgentId = agentId ?? 'main';
          const name = threadName ?? `🐙 ${resolvedAgentId}`;

          try {
            // Send an anchor message first, then start a thread on it
            const anchorMessageId = await discordChannel.sendToChannel(
              ctx.channelTarget,
              `⚙️ Spawning sub-agent **${resolvedAgentId}** in thread…`,
            );
            const created = await discordChannel.createThread(
              ctx.channelTarget,
              name,
              { messageId: anchorMessageId },
            );

            threadInfo = { threadId: created.id, threadName: created.name };

            // Bind the thread to the sub-agent session
            if (threadBindings) {
              threadBindings.bind(created.id, {
                threadId: created.id,
                parentChannelId: ctx.channelTarget,
                agentId: resolvedAgentId,
                sessionKey: `agent:${resolvedAgentId}:discord:${created.id}`,
              });
              await threadBindings.save();
            }
          } catch (threadErr) {
            console.error(
              '[tako] Thread creation failed:',
              threadErr instanceof Error ? threadErr.message : threadErr,
            );
            // Continue without thread — spawn still succeeded
          }
        }

        // Always return immediately — completion announced via channel callback
        // (both run and session mode are non-blocking now)
        return {
          output: JSON.stringify({
            runId: run.id,
            sessionId: run.sessionId,
            status: 'running',
            label: run.label,
            mode: run.mode,
            agentId: run.agentId,
            ...(threadInfo ? { thread: threadInfo } : {}),
            note: mode === 'run'
              ? 'Task is running. Results will be announced when complete.'
              : 'Session started. Use sessions_send to send follow-up messages.',
          }, null, 2),
          success: true,
        };
      } catch (err) {
        return {
          output: '',
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };

  // ─── sessions_history ──────────────────────────────────────────────

  const sessionsHistoryTool: Tool = {
    name: 'sessions_history',
    description: 'Fetch message history for a session. Returns recent messages with role, content, and timestamps.',
    group: 'agents',
    parameters: {
      type: 'object',
      properties: {
        sessionId: {
          type: 'string',
          description: 'Session ID to retrieve history for',
        },
        limit: {
          type: 'number',
          description: 'Maximum number of messages to return (default: 50)',
          default: 50,
        },
        includeTools: {
          type: 'boolean',
          description: 'Include tool call/result messages (default: false)',
          default: false,
        },
      },
      required: ['sessionId'],
    },

    async execute(params: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const {
        sessionId,
        limit = 50,
        includeTools = false,
      } = params as {
        sessionId: string;
        limit?: number;
        includeTools?: boolean;
      };

      const session = sessions.get(sessionId);
      if (!session) {
        return {
          output: '',
          success: false,
          error: `Session not found: ${sessionId}`,
        };
      }

      let messages = session.messages;

      // Filter out tool messages if not requested
      if (!includeTools) {
        messages = messages.filter(
          (m) => m.role !== 'tool' && !hasToolUse(m),
        );
      }

      // Take last N messages
      const recent = messages.slice(-limit);

      const output = recent.map((m, i) => ({
        index: messages.length - recent.length + i,
        role: m.role,
        content: typeof m.content === 'string'
          ? m.content.slice(0, 500)
          : '[complex content]',
      }));

      return {
        output: JSON.stringify({
          sessionId,
          sessionName: session.name,
          totalMessages: session.messages.length,
          returned: output.length,
          messages: output,
        }, null, 2),
        success: true,
      };
    },
  };

  // ─── subagents ─────────────────────────────────────────────────────

  const subagentsTool: Tool = {
    name: 'subagents',
    description: 'List, steer, or kill spawned sub-agent runs. Use action "list" to see all runs, "steer" to send follow-up messages, or "kill" to terminate a run.',
    group: 'agents',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['list', 'steer', 'kill'],
          description: 'Action to perform',
        },
        target: {
          type: 'string',
          description: 'Run ID (required for "steer" and "kill")',
        },
        message: {
          type: 'string',
          description: 'Follow-up message (required for "steer")',
        },
      },
      required: ['action'],
    },

    async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
      const { action, target, message } = params as {
        action: 'list' | 'steer' | 'kill';
        target?: string;
        message?: string;
      };

      switch (action) {
        case 'list': {
          const runs = orchestrator.listRuns(ctx.sessionId);
          const output = runs.map((r) => ({
            id: r.id,
            label: r.label,
            agentId: r.agentId,
            mode: r.mode,
            status: r.status,
            task: r.task.slice(0, 100),
            startedAt: r.startedAt.toISOString(),
            completedAt: r.completedAt?.toISOString(),
          }));
          return {
            output: JSON.stringify(output, null, 2),
            success: true,
          };
        }

        case 'steer': {
          if (!target) {
            return { output: '', success: false, error: 'Target run ID is required for "steer"' };
          }
          if (!message) {
            return { output: '', success: false, error: 'Message is required for "steer"' };
          }

          try {
            const result = await orchestrator.steer(target, message);
            return {
              output: JSON.stringify({ runId: target, result }, null, 2),
              success: true,
            };
          } catch (err) {
            return {
              output: '',
              success: false,
              error: err instanceof Error ? err.message : String(err),
            };
          }
        }

        case 'kill': {
          if (!target) {
            return { output: '', success: false, error: 'Target run ID is required for "kill"' };
          }

          const killed = orchestrator.kill(target);
          return {
            output: JSON.stringify({
              runId: target,
              killed,
            }, null, 2),
            success: killed,
            error: killed ? undefined : `Run not found or not running: ${target}`,
          };
        }

        default:
          return { output: '', success: false, error: `Unknown action: ${action}` };
      }
    },
  };

  // ─── agents_add ──────────────────────────────────────────────────

  const agentsAddTool: Tool = {
    name: 'agents_add',
    description:
      'Create a new agent with its own workspace, identity, and session store. Use this when the user asks to create, add, or set up a new agent. This is NOT for creating skills — use skill-creator for skills.',
    group: 'agents',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Agent name/id (lowercase, no spaces, hyphens ok)',
        },
        description: {
          type: 'string',
          description: 'What this agent does',
        },
        role: {
          type: 'string',
          description: 'Permission role: admin, operator, standard, restricted, readonly. Default: standard',
          enum: ['admin', 'operator', 'standard', 'restricted', 'readonly'],
        },
        model: {
          type: 'string',
          description: 'Model ref (e.g. anthropic/claude-sonnet-4-6). Default: inherit from main agent',
        },
        workspace: {
          type: 'string',
          description: 'Workspace path (default: ~/.tako/workspace-<name>)',
        },
        channels: {
          type: 'object',
          description: 'Channel connections for this agent',
          properties: {
            discord: {
              type: 'object',
              properties: {
                enabled: { type: 'boolean', description: 'Connect to Discord' },
                guildId: { type: 'string', description: 'Discord guild ID to listen in' },
              },
            },
            telegram: {
              type: 'object',
              properties: {
                enabled: { type: 'boolean', description: 'Connect to Telegram' },
              },
            },
          },
        },
      },
      required: ['name'],
    },

    async execute(params: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const { name, workspace, model, description, role, channels } = params as {
        name: string;
        workspace?: string;
        model?: string;
        description?: string;
        role?: string;
        channels?: {
          discord?: { enabled: boolean; guildId?: string };
          telegram?: { enabled: boolean };
        };
      };

      // Only admin and operator can create agents
      const callerRole = _ctx.agentRole ?? 'admin';
      if (callerRole !== 'admin' && callerRole !== 'operator') {
        return {
          output: '',
          success: false,
          error: 'Permission denied: only admin/operator can create agents.',
        };
      }

      // Validate name format
      if (!/^[a-z][a-z0-9-]*$/.test(name)) {
        return {
          output: '',
          success: false,
          error: 'Agent name must start with a lowercase letter and contain only lowercase letters, numbers, and hyphens.',
        };
      }

      if (registry.has(name)) {
        return {
          output: '',
          success: false,
          error: `Agent "${name}" already exists. Use agents_list to see all agents.`,
        };
      }

      try {
        const agentRole = role || 'standard';
        const agent = await registry.add({
          id: name,
          workspace: workspace || `~/.tako/workspace-${name}`,
          model: model ? { primary: model } : undefined,
          description,
          role: agentRole,
          channels,
        });

        return {
          output: JSON.stringify({
            created: true,
            id: agent.id,
            workspace: agent.workspace,
            stateDir: agent.stateDir,
            sessionDir: agent.sessionDir,
            model: agent.model,
            description: agent.description,
            role: agentRole,
            channels: channels ?? { discord: { enabled: false }, telegram: { enabled: false } },
            filesCreated: [
              'AGENTS.md', 'SOUL.md', 'IDENTITY.md',
              'USER.md', 'TOOLS.md', 'HEARTBEAT.md',
              'BOOTSTRAP.md', 'memory/MEMORY.md',
            ],
            nextSteps: [
              `Switch to agent: /agent switch ${name}`,
              `Customize personality: edit ${agent.workspace}/SOUL.md`,
              channels?.discord?.enabled ? `Route Discord messages via channel bindings in tako.json` : null,
              channels?.telegram?.enabled ? `Route Telegram messages via channel bindings in tako.json` : null,
            ].filter(Boolean),
          }, null, 2),
          success: true,
        };
      } catch (err) {
        return {
          output: '',
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };

  // ─── agents_remove ─────────────────────────────────────────────────

  const agentsRemoveTool: Tool = {
    name: 'agents_remove',
    description:
      'Remove an agent by ID. Removes state directory but preserves workspace files. Cannot remove the "main" agent.',
    group: 'agents',
    parameters: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          description: 'Agent ID to remove',
        },
      },
      required: ['name'],
    },

    async execute(params: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const { name } = params as { name: string };

      // Only admin and operator can remove agents
      const callerRole = _ctx.agentRole ?? 'admin';
      if (callerRole !== 'admin' && callerRole !== 'operator') {
        return {
          output: '',
          success: false,
          error: 'Permission denied: only admin/operator can remove agents.',
        };
      }

      if (!registry.has(name)) {
        return {
          output: '',
          success: false,
          error: `Agent not found: ${name}. Use agents_list to see available agents.`,
        };
      }

      try {
        const removed = await registry.remove(name);
        return {
          output: JSON.stringify({
            removed,
            id: name,
            note: 'Agent state directory removed. Workspace files preserved.',
          }, null, 2),
          success: removed,
          error: removed ? undefined : `Failed to remove agent: ${name}`,
        };
      } catch (err) {
        return {
          output: '',
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };

  // ─── agents_set_role ─────────────────────────────────────────────

  const agentsSetRoleTool: Tool = {
    name: 'agents_set_role',
    description: "Change an agent's permission role. Admin only.",
    group: 'agents',
    parameters: {
      type: 'object',
      properties: {
        agentId: {
          type: 'string',
          description: 'Agent ID to change role for',
        },
        role: {
          type: 'string',
          description: 'New permission role',
          enum: ['admin', 'operator', 'standard', 'restricted', 'readonly'],
        },
      },
      required: ['agentId', 'role'],
    },

    async execute(params: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const { agentId, role } = params as { agentId: string; role: string };

      // Only admin can change roles
      const callerRole = _ctx.agentRole ?? 'admin';
      if (callerRole !== 'admin') {
        return {
          output: '',
          success: false,
          error: 'Permission denied: only admin can change agent roles.',
        };
      }

      // Cannot change main agent's role
      if (agentId === 'main') {
        return {
          output: '',
          success: false,
          error: 'Cannot change the main agent\'s role — it is always admin.',
        };
      }

      // Validate role name
      if (!PREDEFINED_ROLES[role]) {
        return {
          output: '',
          success: false,
          error: `Unknown role: "${role}". Valid roles: ${Object.keys(PREDEFINED_ROLES).join(', ')}`,
        };
      }

      const agent = registry.get(agentId);
      if (!agent) {
        return {
          output: '',
          success: false,
          error: `Agent not found: ${agentId}. Use agents_list to see available agents.`,
        };
      }

      try {
        await registry.setRole(agentId, role);
        return {
          output: JSON.stringify({
            agentId,
            previousRole: agent.role,
            newRole: role,
          }, null, 2),
          success: true,
        };
      } catch (err) {
        return {
          output: '',
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };

  return [agentsListTool, agentsAddTool, agentsRemoveTool, agentsSetRoleTool, sessionsSpawnTool, sessionsHistoryTool, subagentsTool];
}

/** Check if a message contains tool_use content parts. */
function hasToolUse(msg: { content: string | unknown[] }): boolean {
  if (typeof msg.content === 'string') return false;
  if (!Array.isArray(msg.content)) return false;
  return msg.content.some(
    (part: unknown) => typeof part === 'object' && part !== null && (part as Record<string, unknown>).type === 'tool_use',
  );
}
