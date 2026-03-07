/**
 * Per-agent auth profiles — provider credentials scoped to individual agents.
 *
 * Stored at: ~/.tako/agents/<id>/agent/auth-profiles.json
 *
 * Resolution order:
 *   1. Agent-specific profile (this file)
 *   2. Main agent's profile (inherited on creation)
 *   3. Global auth (storage.ts / env vars)
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

// ─── Types ──────────────────────────────────────────────────────────

export interface AuthProfile {
  type: 'api_key' | 'oauth';
  key?: string;
  accessToken?: string;
  refreshToken?: string;
  expiresAt?: number;
}

export interface AuthProfilesFile {
  version: 1;
  profiles: Record<string, AuthProfile>;
}

// ─── Paths ──────────────────────────────────────────────────────────

function getProfilesPath(agentId: string): string {
  return join(homedir(), '.tako', 'agents', agentId, 'agent', 'auth-profiles.json');
}

// ─── Read / Write ───────────────────────────────────────────────────

export async function loadAuthProfiles(agentId: string): Promise<AuthProfilesFile> {
  const filePath = getProfilesPath(agentId);
  if (!existsSync(filePath)) {
    return { version: 1, profiles: {} };
  }
  try {
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw) as AuthProfilesFile;
  } catch {
    return { version: 1, profiles: {} };
  }
}

export async function saveAuthProfiles(agentId: string, data: AuthProfilesFile): Promise<void> {
  const filePath = getProfilesPath(agentId);
  const dir = join(filePath, '..');
  await mkdir(dir, { recursive: true });

  // Mask keys in the saved file for safety — store the real values
  await writeFile(filePath, JSON.stringify(data, null, 2) + '\n', { mode: 0o600 });
}

/**
 * Set or update a single auth profile for an agent.
 */
export async function setAuthProfile(
  agentId: string,
  profileKey: string,
  profile: AuthProfile,
): Promise<void> {
  const data = await loadAuthProfiles(agentId);
  data.profiles[profileKey] = profile;
  await saveAuthProfiles(agentId, data);
}

/**
 * Remove an auth profile from an agent.
 */
export async function removeAuthProfile(
  agentId: string,
  profileKey: string,
): Promise<boolean> {
  const data = await loadAuthProfiles(agentId);
  if (!(profileKey in data.profiles)) return false;
  delete data.profiles[profileKey];
  await saveAuthProfiles(agentId, data);
  return true;
}

/**
 * Inherit auth profiles from a source agent to a new agent.
 * Used when creating sub-agents.
 */
export async function inheritAuthProfiles(
  sourceAgentId: string,
  targetAgentId: string,
): Promise<void> {
  const source = await loadAuthProfiles(sourceAgentId);
  if (Object.keys(source.profiles).length === 0) return;
  await saveAuthProfiles(targetAgentId, { ...source });
}

/**
 * Resolve an API key for a provider, checking agent profile first.
 * Returns the key string or null if not found at this level.
 */
export async function resolveAgentAuthKey(
  agentId: string,
  providerKey: string,
): Promise<string | null> {
  const data = await loadAuthProfiles(agentId);
  const profile = data.profiles[providerKey];
  if (!profile) return null;

  if (profile.type === 'api_key' && profile.key) {
    return profile.key;
  }
  if (profile.type === 'oauth' && profile.accessToken) {
    if (profile.expiresAt && profile.expiresAt < Date.now() / 1000) {
      return null; // expired
    }
    return profile.accessToken;
  }
  return null;
}

/**
 * Mask an API key for display (show first 8 and last 4 chars).
 */
export function maskKey(key: string): string {
  if (key.length <= 12) return '***';
  return `${key.slice(0, 8)}...${key.slice(-4)}`;
}
