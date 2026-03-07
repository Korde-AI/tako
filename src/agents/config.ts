/**
 * Agent config — per-agent configuration, channel bindings, spawn allowlists.
 *
 * Each agent is an isolated brain with its own workspace, model preferences,
 * and channel routing rules.
 */

import type { AgentEntry, AgentBindings } from '../config/schema.js';

/** Runtime agent descriptor (resolved from config + defaults). */
export interface AgentDescriptor {
  /** Unique agent ID. */
  id: string;
  /** Resolved workspace path (absolute). */
  workspace: string;
  /** State directory for agent-specific data. */
  stateDir: string;
  /** Session persistence directory. */
  sessionDir: string;
  /** Primary model ID (e.g. 'anthropic/claude-sonnet-4-6'). */
  model: string;
  /** Channel bindings. */
  bindings: AgentBindings;
  /** Which agent IDs this agent can spawn as sub-agents. */
  canSpawn: string[];
  /** Agent description. */
  description: string;
  /** Whether this is the default "main" agent. */
  isMain: boolean;
  /** Permission role name (admin, operator, standard, restricted, readonly). */
  role: string;
  /** Per-agent skill directories (appended to global dirs at runtime). */
  skills?: { dirs: string[] };
}

/**
 * Resolve a channel message to the correct agent ID based on bindings.
 *
 * @param agents - List of agent descriptors
 * @param channelType - Channel type ('discord', 'telegram', 'cli')
 * @param channelTarget - Channel-specific target (channel name, user ID, etc.)
 * @returns The matching agent ID, or 'main' if no binding matches
 */
export function resolveAgentForChannel(
  agents: AgentDescriptor[],
  channelType: string,
  channelTarget: string,
  guildId?: string,
): string {
  // Pass 1: exact channel/user/group binding
  for (const agent of agents) {
    if (!agent.bindings) continue;

    if (channelType === 'discord' && agent.bindings.discord) {
      if (agent.bindings.discord.channels.includes(channelTarget)) {
        return agent.id;
      }
    }

    if (channelType === 'telegram' && agent.bindings.telegram) {
      if (agent.bindings.telegram.users?.includes(channelTarget)) {
        return agent.id;
      }
      if (agent.bindings.telegram.groups?.includes(channelTarget)) {
        return agent.id;
      }
    }

    if (channelType === 'cli' && agent.bindings.cli) {
      return agent.id;
    }
  }

  // Pass 2: guild-level binding (Discord only)
  if (channelType === 'discord' && guildId) {
    for (const agent of agents) {
      if (!agent.bindings?.discord) continue;
      if (agent.bindings.discord.channels.includes(guildId)) {
        return agent.id;
      }
    }
  }

  return 'main';
}

/**
 * Check if an agent is allowed to spawn a sub-agent.
 *
 * @param parent - Parent agent descriptor
 * @param targetAgentId - ID of the agent to spawn
 * @returns true if spawning is allowed
 */
export function canAgentSpawn(parent: AgentDescriptor, targetAgentId: string): boolean {
  // Main agent can spawn anything
  if (parent.isMain) return true;
  // Empty allowlist means can spawn anything
  if (parent.canSpawn.length === 0) return true;
  return parent.canSpawn.includes(targetAgentId);
}
