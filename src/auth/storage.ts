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

import { join } from 'node:path';
import { mkdir, readFile, writeFile, unlink } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { getRuntimePaths } from '../core/paths.js';

/** In-flight refresh lock to prevent concurrent refreshes per provider. */
const refreshLocks = new Map<string, Promise<OAuthCredential | null>>();

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
  return getRuntimePaths().authDir;
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
  anthropic: ['ANTHROPIC_SETUP_TOKEN', 'ANTHROPIC_API_KEY', 'ANTHROPIC_API_KEYS', 'OPENCLAW_LIVE_ANTHROPIC_KEY'],
  openai: ['OPENAI_API_KEY'],
  litellm: ['LITELLM_API_KEY'],
};

export async function getAuthStatus(provider: string): Promise<AuthStatus> {
  // 1. Check env vars
  const envVars = PROVIDER_ENV_VARS[provider] ?? [`${provider.toUpperCase()}_API_KEY`];
  for (const envVar of envVars) {
    if (process.env[envVar]) {
      const token = process.env[envVar]!;
      const method: AuthMethod =
        provider === 'anthropic' && (envVar === 'ANTHROPIC_SETUP_TOKEN' || token.includes('sk-ant-oat'))
          ? 'setup_token'
          : 'api_key';
      return { provider, authenticated: true, method, source: 'env' };
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
  // 1. Auth file first (most recently configured via onboard/CLI)
  const cred = await readAuthCredential(provider);
  if (cred) {
    switch (cred.auth_method) {
      case 'api_key':
        return { token: cred.api_key, method: 'api_key', source: 'auth_file' };
      case 'setup_token':
        return { token: cred.setup_token, method: 'setup_token', source: 'auth_file' };
      case 'oauth': {
        // If token has a known expiry and is near-expired, try refreshing first
        if (cred.expires_at && isTokenExpired(cred)) {
          const refreshed = await refreshOAuthToken(provider);
          if (refreshed) {
            return { token: refreshed.access_token, method: 'oauth', source: 'auth_file' };
          }
          // Refresh failed — fall through to env vars
          break;
        }
        return { token: cred.access_token, method: 'oauth', source: 'auth_file' };
      }
    }
  }

  // 2. Env vars as fallback
  const envVars = PROVIDER_ENV_VARS[provider] ?? [`${provider.toUpperCase()}_API_KEY`];
  for (const envVar of envVars) {
    if (process.env[envVar]) {
      const token = process.env[envVar]!;
      const method: AuthMethod =
        provider === 'anthropic' && (envVar === 'ANTHROPIC_SETUP_TOKEN' || token.includes('sk-ant-oat'))
          ? 'setup_token'
          : 'api_key';
      return { token, method, source: 'env' };
    }
  }

  return null;
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

// ─── OAuth token refresh ────────────────────────────────────────────

/** Anthropic OAuth token endpoint. */
const ANTHROPIC_TOKEN_ENDPOINT = 'https://console.anthropic.com/v1/oauth/token';

/**
 * Attempt to refresh an OAuth/setup token for the given provider.
 *
 * For Anthropic OAuth tokens (sk-ant-oat01-*):
 *   - If a refresh_token is stored, performs a standard OAuth2 refresh grant.
 *   - If no refresh_token, the token cannot be refreshed automatically —
 *     returns null and logs instructions.
 *
 * Uses an in-memory lock to prevent concurrent refresh attempts.
 */
export async function refreshOAuthToken(provider: string): Promise<OAuthCredential | null> {
  // Coalesce concurrent refresh calls
  const existing = refreshLocks.get(provider);
  if (existing) return existing;

  const promise = doRefreshOAuthToken(provider);
  refreshLocks.set(provider, promise);
  try {
    return await promise;
  } finally {
    refreshLocks.delete(provider);
  }
}

async function doRefreshOAuthToken(provider: string): Promise<OAuthCredential | null> {
  const cred = await readAuthCredential(provider);
  if (!cred) return null;

  // Only OAuth/setup_token credentials with OAuth-style tokens can be refreshed
  const token = cred.auth_method === 'oauth'
    ? cred.access_token
    : cred.auth_method === 'setup_token'
      ? cred.setup_token
      : null;

  if (!token || !token.includes('sk-ant-oat')) {
    return null; // Not an OAuth token — nothing to refresh
  }

  // Need a refresh_token to perform the refresh grant
  if (cred.auth_method !== 'oauth' || !cred.refresh_token) {
    console.warn(
      `[auth] ${provider} OAuth token has no refresh_token — cannot auto-refresh.\n` +
      `       Run \`tako models auth login --provider ${provider}\` to re-authenticate.`,
    );
    return null;
  }

  // Standard OAuth2 refresh token grant
  console.log(`[auth] Refreshing ${provider} OAuth token...`);
  try {
    const body = new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: cred.refresh_token,
      ...(cred.client_id ? { client_id: cred.client_id } : {}),
    });

    const res = await fetch(ANTHROPIC_TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error(
        `[auth] Token refresh failed (HTTP ${res.status}): ${text}\n` +
        `       Run \`tako models auth login --provider ${provider}\` to re-authenticate.`,
      );
      return null;
    }

    const data = await res.json() as Record<string, unknown>;
    const newToken = data.access_token as string;
    if (!newToken) {
      console.error('[auth] Token refresh response missing access_token');
      return null;
    }

    const updated: OAuthCredential = {
      ...cred,
      auth_method: 'oauth',
      access_token: newToken,
      refresh_token: (data.refresh_token as string) ?? cred.refresh_token,
      expires_at: data.expires_in
        ? Math.floor(Date.now() / 1000) + (data.expires_in as number)
        : data.expires_at as number | undefined,
      token_type: (data.token_type as string) ?? cred.token_type,
    };

    await writeAuthCredential(updated);
    console.log(`[auth] ${provider} OAuth token refreshed successfully`);
    return updated;
  } catch (err) {
    console.error(
      `[auth] Token refresh error: ${err instanceof Error ? err.message : String(err)}\n` +
      `       Run \`tako models auth login --provider ${provider}\` to re-authenticate.`,
    );
    return null;
  }
}

// ─── Token health check ─────────────────────────────────────────────

/**
 * Verify that the resolved token for a provider is functional.
 * Makes a lightweight API call (model list) to check validity.
 * Returns { valid, error? }.
 */
export async function checkTokenHealth(provider: string): Promise<{ valid: boolean; error?: string }> {
  const auth = await resolveAuth(provider);
  if (!auth) {
    return { valid: false, error: 'No credentials configured' };
  }

  if (provider === 'anthropic') {
    try {
      // Lightweight check: hit the models endpoint
      const headers: Record<string, string> = {
        'accept': 'application/json',
        'anthropic-version': '2023-06-01',
      };

      if (auth.token.includes('sk-ant-oat')) {
        headers['authorization'] = `Bearer ${auth.token}`;
        headers['anthropic-dangerous-direct-browser-access'] = 'true';
        headers['anthropic-beta'] = 'oauth-2025-04-20';
      } else {
        headers['x-api-key'] = auth.token;
      }

      const res = await fetch('https://api.anthropic.com/v1/models?limit=1', { headers });
      if (res.ok) {
        return { valid: true };
      }
      const body = await res.text().catch(() => '');
      return { valid: false, error: `HTTP ${res.status}: ${body.slice(0, 200)}` };
    } catch (err) {
      return { valid: false, error: err instanceof Error ? err.message : String(err) };
    }
  }

  // For non-anthropic providers, assume valid if token exists
  return { valid: true };
}
