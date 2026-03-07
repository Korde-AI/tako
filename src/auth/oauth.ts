/**
 * OAuth helper — PKCE flow for provider authentication.
 *
 * Implements the Authorization Code flow with PKCE:
 *   1. Generate code_verifier + code_challenge
 *   2. Build authorization URL
 *   3. Open browser (or print URL for manual visit)
 *   4. Wait for user to paste authorization code
 *   5. Exchange code for access + refresh tokens
 *   6. Store tokens via auth/storage.ts
 *   7. Auto-refresh when expired
 */

import { randomBytes, createHash } from 'node:crypto';
import { createServer } from 'node:http';
import {
  writeAuthCredential,
  readAuthCredential,
  isTokenExpired,
  type OAuthCredential,
} from './storage.js';

// ─── PKCE ───────────────────────────────────────────────────────────

export function generateCodeVerifier(): string {
  return randomBytes(32).toString('base64url');
}

export function generateCodeChallenge(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

// ─── OAuth provider configs ─────────────────────────────────────────

export interface OAuthProviderConfig {
  provider: string;
  client_id: string;
  auth_url: string;
  token_url: string;
  redirect_uri: string;
  scopes: string[];
}

/** Known OAuth configurations for providers. */
export const OAUTH_PROVIDERS: Record<string, OAuthProviderConfig> = {
  'openai-codex': {
    provider: 'openai-codex',
    client_id: 'app_EMoamEEZ73f0CkXaXp7hrann',
    auth_url: 'https://auth.openai.com/oauth/authorize',
    token_url: 'https://auth.openai.com/oauth/token',
    redirect_uri: 'http://localhost:1455/auth/callback',
    scopes: ['openid', 'profile', 'email', 'offline_access'],
  },
};

// ─── Auth URL builder ───────────────────────────────────────────────

export interface AuthUrlParams {
  config: OAuthProviderConfig;
  code_verifier: string;
  state?: string;
}

export function buildAuthUrl(params: AuthUrlParams): string {
  const { config, code_verifier, state } = params;
  const code_challenge = generateCodeChallenge(code_verifier);

  const url = new URL(config.auth_url);
  url.searchParams.set('client_id', config.client_id);
  url.searchParams.set('redirect_uri', config.redirect_uri);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('scope', config.scopes.join(' '));
  url.searchParams.set('code_challenge', code_challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  if (state) url.searchParams.set('state', state);

  return url.toString();
}

// ─── Token exchange ─────────────────────────────────────────────────

export interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  token_type: string;
  expires_in?: number;
  scope?: string;
}

export async function exchangeCode(
  config: OAuthProviderConfig,
  code: string,
  code_verifier: string,
): Promise<TokenResponse> {
  const res = await fetch(config.token_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: config.redirect_uri,
      client_id: config.client_id,
      code_verifier,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token exchange failed (${res.status}): ${body}`);
  }

  return res.json() as Promise<TokenResponse>;
}

// ─── Token refresh ──────────────────────────────────────────────────

export async function refreshToken(
  config: OAuthProviderConfig,
  refresh_token: string,
): Promise<TokenResponse> {
  const res = await fetch(config.token_url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token,
      client_id: config.client_id,
    }),
  });

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Token refresh failed (${res.status}): ${body}`);
  }

  return res.json() as Promise<TokenResponse>;
}

// ─── Store OAuth tokens ─────────────────────────────────────────────

export async function storeOAuthTokens(
  provider: string,
  tokenResponse: TokenResponse,
  clientId?: string,
): Promise<OAuthCredential> {
  const credential: OAuthCredential = {
    provider,
    auth_method: 'oauth',
    access_token: tokenResponse.access_token,
    refresh_token: tokenResponse.refresh_token,
    expires_at: tokenResponse.expires_in
      ? Math.floor(Date.now() / 1000) + tokenResponse.expires_in
      : undefined,
    token_type: tokenResponse.token_type,
    scope: tokenResponse.scope,
    client_id: clientId,
    created_at: Date.now(),
  };

  await writeAuthCredential(credential);
  return credential;
}

// ─── Auto-refresh ───────────────────────────────────────────────────

/**
 * Get a valid OAuth access token, refreshing if expired.
 * Returns null if no OAuth credential exists or refresh fails.
 */
export async function getValidOAuthToken(provider: string): Promise<string | null> {
  const cred = await readAuthCredential(provider);
  if (!cred || cred.auth_method !== 'oauth') return null;

  if (!isTokenExpired(cred)) {
    return cred.access_token;
  }

  // Try to refresh
  if (!cred.refresh_token) return null;

  const config = OAUTH_PROVIDERS[provider];
  if (!config) return null;

  try {
    const tokenResponse = await refreshToken(config, cred.refresh_token);
    const updated = await storeOAuthTokens(provider, tokenResponse, cred.client_id);
    return updated.access_token;
  } catch (err) {
    console.warn(`[oauth] Failed to refresh token for ${provider}:`, (err as Error).message);
    return null;
  }
}

// ─── Browser opener ─────────────────────────────────────────────────

/**
 * Open a URL in the user's default browser.
 * Falls back to printing the URL if opening fails.
 */
export async function openBrowser(url: string): Promise<boolean> {
  try {
    const { default: open } = await import('open');
    await open(url);
    return true;
  } catch {
    // open package not available or failed — that's fine
    return false;
  }
}

// ─── Local OAuth callback server ────────────────────────────────────

async function startLocalOAuthServer(expectedState: string): Promise<{
  waitForCode: () => Promise<{ code: string } | null>;
  cancelWait: () => void;
  close: () => void;
}> {
  return new Promise((resolveServer) => {
    let resolveCode: (result: { code: string } | null) => void;
    const codePromise = new Promise<{ code: string } | null>((resolve) => {
      resolveCode = resolve;
    });

    const server = createServer((req, res) => {
      const url = new URL(req.url!, `http://localhost:1455`);
      if (url.pathname === '/auth/callback') {
        const code = url.searchParams.get('code');
        const state = url.searchParams.get('state');

        if (state && state !== expectedState) {
          res.writeHead(400, { 'Content-Type': 'text/plain' });
          res.end('State mismatch');
          return;
        }

        res.writeHead(200, { 'Content-Type': 'text/html' });
        res.end(
          '<html><head><title>Authentication successful</title></head>' +
          '<body><h2>\uD83D\uDC19 Tako — Authentication successful!</h2>' +
          '<p>Return to your terminal to continue.</p></body></html>',
        );

        if (code) {
          resolveCode!({ code });
        }
      }
    });

    server.listen(1455, '127.0.0.1', () => {
      resolveServer({
        waitForCode: () => codePromise,
        cancelWait: () => resolveCode!(null),
        close: () => server.close(),
      });
    });

    // Timeout after 120 seconds
    setTimeout(() => {
      resolveCode!(null);
      server.close();
    }, 120_000);
  });
}

// ─── Full OAuth flow (interactive) ──────────────────────────────────

export interface OAuthFlowResult {
  credential: OAuthCredential;
  provider: string;
}

/**
 * Run the full interactive OAuth flow.
 * This is used by the onboarding wizard and `tako models auth` commands.
 * The caller provides UI functions for prompting the user.
 */
export async function runOAuthFlow(
  providerKey: string,
  ui: {
    log: (msg: string) => void;
    prompt: (message: string) => Promise<string | null>;
  },
): Promise<OAuthFlowResult | null> {
  const config = OAUTH_PROVIDERS[providerKey];
  if (!config) {
    ui.log(`Unknown OAuth provider: ${providerKey}`);
    return null;
  }

  // Generate PKCE + state
  const code_verifier = generateCodeVerifier();
  const state = randomBytes(16).toString('hex');
  const authUrl = buildAuthUrl({ config, code_verifier, state });

  // Start local callback server
  const server = await startLocalOAuthServer(state);

  // Open browser
  ui.log('Opening browser for authentication...');
  const opened = await openBrowser(authUrl);
  if (!opened) {
    ui.log('Could not open browser. Visit this URL manually:');
  }
  ui.log(authUrl);

  // Race: wait for callback OR manual paste as fallback
  let code: string | null = null;

  const callbackResult = await Promise.race([
    server.waitForCode(),
    ui.prompt('Waiting for browser callback... Or paste the redirect URL/code:').then((input) => {
      if (!input) return null;
      try {
        const url = new URL(input.trim());
        return { code: url.searchParams.get('code') || input.trim() };
      } catch {
        return { code: input.trim() };
      }
    }),
  ]);

  server.close();

  if (callbackResult?.code) {
    code = callbackResult.code;
  }

  if (!code) {
    ui.log('No authorization code received.');
    return null;
  }

  // Exchange code for tokens
  const tokenResponse = await exchangeCode(config, code, code_verifier);
  const credential = await storeOAuthTokens(providerKey, tokenResponse, config.client_id);

  return { credential, provider: providerKey };
}

// ─── Anthropic setup-token helpers ──────────────────────────────────

const ANTHROPIC_SETUP_TOKEN_PREFIX = 'sk-ant-oat01-';
const ANTHROPIC_SETUP_TOKEN_MIN_LENGTH = 80;

export function validateAnthropicSetupToken(token: string): string | undefined {
  const trimmed = token.trim();
  if (!trimmed) return 'Required';
  if (!trimmed.startsWith(ANTHROPIC_SETUP_TOKEN_PREFIX)) {
    return `Expected token starting with ${ANTHROPIC_SETUP_TOKEN_PREFIX}`;
  }
  if (trimmed.length < ANTHROPIC_SETUP_TOKEN_MIN_LENGTH) {
    return 'Token looks too short; paste the full setup-token';
  }
  return undefined;
}
