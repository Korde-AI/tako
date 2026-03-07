/**
 * Auth storage — read/write provider credentials to ~/.tako/auth/<provider>.json
 *
 * Supports multiple auth methods per provider:
 *   - api_key: traditional API key
 *   - setup_token: Anthropic subscription setup token
 *   - oauth: OAuth2 access/refresh tokens (OpenAI Codex, etc.)
 *
 * Resolution order:
 *   1. Environment variables (highest priority)
 *   2. Auth files (~/.tako/auth/<provider>.json)
 *   3. Legacy .env file (~/.tako/.env)
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';

// ─── Types ──────────────────────────────────────────────────────────

export type AuthMethod = 'api_key' | 'setup_token' | 'oauth';

export interface BaseCredential {
  provider: string;
  auth_method: AuthMethod;
  created_at: number;
}

export interface ApiKeyCredential extends BaseCredential {
  auth_method: 'api_key';
  api_key: string;
}

export interface SetupTokenCredential extends BaseCredential {
  auth_method: 'setup_token';
  setup_token: string;
}

export interface OAuthCredential extends BaseCredential {
  auth_method: 'oauth';
  access_token: string;
  refresh_token?: string;
  expires_at?: number;
  token_type?: string;
  scope?: string;
  email?: string;
  client_id?: string;
}

export type AuthCredential = ApiKeyCredential | SetupTokenCredential | OAuthCredential;

// ─── Auth directory ─────────────────────────────────────────────────

function getAuthDir(): string {
  return join(homedir(), '.tako', 'auth');
}

function getAuthFilePath(provider: string): string {
  return join(getAuthDir(), `${provider}.json`);
}

// ─── Read / Write ───────────────────────────────────────────────────

export async function readAuthCredential(provider: string): Promise<AuthCredential | null> {
  const filePath = getAuthFilePath(provider);
  if (!existsSync(filePath)) return null;

  try {
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw) as AuthCredential;
  } catch {
    return null;
  }
}

export async function writeAuthCredential(credential: AuthCredential): Promise<void> {
  const authDir = getAuthDir();
  await mkdir(authDir, { recursive: true });

  const filePath = getAuthFilePath(credential.provider);
  await writeFile(filePath, JSON.stringify(credential, null, 2) + '\n', { mode: 0o600 });
}

export async function removeAuthCredential(provider: string): Promise<boolean> {
  const filePath = getAuthFilePath(provider);
  if (!existsSync(filePath)) return false;

  try {
    await unlink(filePath);
    return true;
  } catch {
    return false;
  }
}

// ─── Auth status ────────────────────────────────────────────────────

export interface AuthStatus {
  provider: string;
  authenticated: boolean;
  method?: AuthMethod;
  source?: 'env' | 'auth_file' | 'legacy_env';
  expires_at?: number;
  expired?: boolean;
}

/** Env vars to check for each provider. */
const PROVIDER_ENV_VARS: Record<string, string[]> = {
  anthropic: ['ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEYS', 'OPENCLAW_LIVE_ANTHROPIC_KEY'],
  openai: ['OPENAI_API_KEY'],
  litellm: ['LITELLM_API_KEY'],
};

export async function getAuthStatus(provider: string): Promise<AuthStatus> {
  // 1. Check env vars
  const envVars = PROVIDER_ENV_VARS[provider] ?? [`${provider.toUpperCase()}_API_KEY`];
  for (const envVar of envVars) {
    if (process.env[envVar]) {
      return { provider, authenticated: true, method: 'api_key', source: 'env' };
    }
  }

  // 2. Check auth file
  const cred = await readAuthCredential(provider);
  if (cred) {
    const expired = cred.auth_method === 'oauth' && cred.expires_at
      ? cred.expires_at < Date.now() / 1000
      : false;
    return {
      provider,
      authenticated: !expired,
      method: cred.auth_method,
      source: 'auth_file',
      expires_at: cred.auth_method === 'oauth' ? cred.expires_at : undefined,
      expired,
    };
  }

  return { provider, authenticated: false };
}

export async function getAllAuthStatuses(): Promise<AuthStatus[]> {
  const providers = ['anthropic', 'openai', 'litellm'];

  // Also check for any auth files for providers not in the default list
  const authDir = getAuthDir();
  if (existsSync(authDir)) {
    const { readdir } = await import('node:fs/promises');
    const files = await readdir(authDir);
    for (const file of files) {
      if (file.endsWith('.json')) {
        const name = file.replace('.json', '');
        if (!providers.includes(name)) {
          providers.push(name);
        }
      }
    }
  }

  return Promise.all(providers.map(getAuthStatus));
}

// ─── Credential resolution ──────────────────────────────────────────

export interface ResolvedAuth {
  token: string;
  method: AuthMethod;
  source: 'env' | 'auth_file';
}

/**
 * Resolve the effective API key or access token for a provider.
 * Returns null if no auth is available.
 */
export async function resolveAuthToken(provider: string): Promise<string | null> {
  const resolved = await resolveAuth(provider);
  return resolved?.token ?? null;
}

/**
 * Resolve auth with method metadata so callers know whether to use
 * the token as an API key or a Bearer token.
 */
export async function resolveAuth(provider: string): Promise<ResolvedAuth | null> {
  // 1. Env vars first
  const envVars = PROVIDER_ENV_VARS[provider] ?? [`${provider.toUpperCase()}_API_KEY`];
  for (const envVar of envVars) {
    if (process.env[envVar]) {
      return { token: process.env[envVar]!, method: 'api_key', source: 'env' };
    }
  }

  // 2. Auth file
  const cred = await readAuthCredential(provider);
  if (!cred) return null;

  switch (cred.auth_method) {
    case 'api_key':
      return { token: cred.api_key, method: 'api_key', source: 'auth_file' };
    case 'setup_token':
      return { token: cred.setup_token, method: 'setup_token', source: 'auth_file' };
    case 'oauth': {
      // Check if expired
      if (cred.expires_at && cred.expires_at < Date.now() / 1000) {
        // Token expired — caller should refresh
        return null;
      }
      return { token: cred.access_token, method: 'oauth', source: 'auth_file' };
    }
  }
}

// ─── Token validity helpers ─────────────────────────────────────────

export function isTokenExpired(cred: OAuthCredential): boolean {
  if (!cred.expires_at) return false;
  // Consider expired if within 5 minutes of expiry
  return cred.expires_at < (Date.now() / 1000) + 300;
}

export function isTokenNearExpiry(cred: OAuthCredential): boolean {
  if (!cred.expires_at) return false;
  // Near expiry = within 10 minutes
  return cred.expires_at < (Date.now() / 1000) + 600;
}
