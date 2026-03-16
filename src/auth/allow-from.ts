/**
 * AllowFrom ACL — per-agent, per-channel access control.
 *
 * Stores allowlist config at:
 *   <home>/credentials/<channel>-<agentId>-allowFrom.json
 *
 * Modes:
 * - "open": anyone can talk (default — preserves existing behavior)
 * - "allowlist": only listed user IDs are permitted
 *
 * The owner (first user to onboard) is always allowed.
 *
 * Claim flow:
 * - If no allowlist exists (unclaimed), the first user to run /claim becomes the owner.
 * - After claim, the bot locks to allowlist mode. No one else can /claim again.
 */

import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { Tool, ToolResult, ToolContext } from '../tools/tool.js';
import { getRuntimePaths } from '../core/paths.js';

// ─── Types ──────────────────────────────────────────────────────────

export type AllowFromMode = 'allowlist' | 'open';

export interface AllowFromConfig {
  allowedUserIds: string[];
  allowedPrincipalIds?: string[];
  mode: AllowFromMode;
  /** True once /claim has been used — prevents re-claiming. */
  claimed?: boolean;
}

// ─── Paths ──────────────────────────────────────────────────────────

function getCredentialsDir(): string {
  return getRuntimePaths().credentialsDir;
}

function getAllowFromPath(channel: string, agentId: string): string {
  return join(getCredentialsDir(), `${channel}-${agentId}-allowFrom.json`);
}

// ─── Read / Write ───────────────────────────────────────────────────

export async function loadAllowFrom(channel: string, agentId: string): Promise<AllowFromConfig> {
  const filePath = getAllowFromPath(channel, agentId);
  if (!existsSync(filePath)) {
    return { allowedUserIds: [], mode: 'open' };
  }
  try {
    const raw = await readFile(filePath, 'utf-8');
    const parsed = JSON.parse(raw) as AllowFromConfig;
    return {
      allowedUserIds: parsed.allowedUserIds ?? [],
      allowedPrincipalIds: parsed.allowedPrincipalIds ?? [],
      mode: parsed.mode ?? 'open',
      claimed: parsed.claimed,
    };
  } catch {
    return { allowedUserIds: [], mode: 'open' };
  }
}

export async function saveAllowFrom(channel: string, agentId: string, config: AllowFromConfig): Promise<void> {
  const dir = getCredentialsDir();
  await mkdir(dir, { recursive: true });
  const filePath = getAllowFromPath(channel, agentId);
  await writeFile(filePath, JSON.stringify(config, null, 2) + '\n', { mode: 0o600 });
}

// ─── Check ──────────────────────────────────────────────────────────

/**
 * Check if a user is allowed to send messages on this channel/agent.
 * Returns true if allowed, false if blocked.
 */
export async function isUserAllowed(
  channel: string,
  agentId: string,
  userId: string,
  principalId?: string,
): Promise<boolean> {
  const config = await loadAllowFrom(channel, agentId);
  if (config.mode === 'open') return true;
  if (principalId && config.allowedPrincipalIds?.includes(principalId)) return true;
  return config.allowedUserIds.includes(userId);
}

// ─── Claim ──────────────────────────────────────────────────────────

/**
 * Check if this channel/agent has already been claimed by an owner.
 * An unclaimed bot is in 'open' mode with no allowlist and no claimed flag.
 */
export async function isClaimed(channel: string, agentId: string): Promise<boolean> {
  const config = await loadAllowFrom(channel, agentId);
  return config.claimed === true || (config.mode === 'allowlist' && config.allowedUserIds.length > 0);
}

/**
 * Claim ownership of this channel/agent.
 * Only works if not already claimed — first user wins.
 * Returns true on success, false if already claimed.
 */
export async function claimOwner(
  channel: string,
  agentId: string,
  userId: string,
  principalId?: string,
): Promise<{ success: boolean; alreadyClaimed: boolean }> {
  const already = await isClaimed(channel, agentId);
  if (already) {
    return { success: false, alreadyClaimed: true };
  }
  await saveAllowFrom(channel, agentId, {
    allowedUserIds: [userId],
    allowedPrincipalIds: principalId ? [principalId] : [],
    mode: 'allowlist',
    claimed: true,
  });
  return { success: true, alreadyClaimed: false };
}

// ─── Tools ──────────────────────────────────────────────────────────

export function createAllowFromTools(): Tool[] {
  const allowFromAdd: Tool = {
    name: 'allow_from_add',
    description: 'Add a user ID to the allowlist for the current channel. Requires admin/operator role.',
    parameters: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'User ID to allow' },
        channel: { type: 'string', description: 'Channel type (e.g. discord, telegram)' },
        agentId: { type: 'string', description: 'Agent ID (defaults to current agent)' },
      },
      required: ['userId'],
    },
    group: 'agents',
    async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
      const { userId, channel: chan, agentId: aid } = params as {
        userId: string;
        channel?: string;
        agentId?: string;
      };
      const channel = chan ?? ctx.channelType ?? 'cli';
      const agentId = aid ?? ctx.agentId ?? 'main';

      const config = await loadAllowFrom(channel, agentId);
      if (!config.allowedUserIds.includes(userId)) {
        config.allowedUserIds.push(userId);
      }
      // Switch to allowlist mode when adding users
      config.mode = 'allowlist';
      await saveAllowFrom(channel, agentId, config);

      return {
        output: `Added user ${userId} to allowlist for ${channel}/${agentId}. Mode: allowlist.`,
        success: true,
      };
    },
  };

  const allowFromRemove: Tool = {
    name: 'allow_from_remove',
    description: 'Remove a user ID from the allowlist for the current channel. Requires admin/operator role.',
    parameters: {
      type: 'object',
      properties: {
        userId: { type: 'string', description: 'User ID to remove' },
        channel: { type: 'string', description: 'Channel type (e.g. discord, telegram)' },
        agentId: { type: 'string', description: 'Agent ID (defaults to current agent)' },
      },
      required: ['userId'],
    },
    group: 'agents',
    async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
      const { userId, channel: chan, agentId: aid } = params as {
        userId: string;
        channel?: string;
        agentId?: string;
      };
      const channel = chan ?? ctx.channelType ?? 'cli';
      const agentId = aid ?? ctx.agentId ?? 'main';

      const config = await loadAllowFrom(channel, agentId);
      config.allowedUserIds = config.allowedUserIds.filter((id) => id !== userId);
      await saveAllowFrom(channel, agentId, config);

      const modeNote = config.allowedUserIds.length === 0
        ? ' (allowlist is now empty — consider switching to "open" mode)'
        : '';

      return {
        output: `Removed user ${userId} from allowlist for ${channel}/${agentId}.${modeNote}`,
        success: true,
      };
    },
  };

  return [allowFromAdd, allowFromRemove];
}
