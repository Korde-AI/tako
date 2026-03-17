/**
 * Shared utility types and helpers for the ACP runtime.
 */

import type { AcpPermissionMode } from './config.js';

// ─── Types ───────────────────────────────────────────────────────

/** Encoded state stored inside an ACP runtime handle. */
export type AcpxHandleState = {
  name: string;
  agent: string;
  cwd: string;
  mode: 'persistent' | 'oneshot';
  acpxRecordId?: string;
  backendSessionId?: string;
  agentSessionId?: string;
};

/** A parsed JSON object from acpx output. */
export type AcpxJsonObject = Record<string, unknown>;

/** An error event extracted from acpx output. */
export type AcpxErrorEvent = {
  message: string;
  code?: string;
  retryable?: boolean;
};

// ─── Type predicates ─────────────────────────────────────────────

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asTrimmedString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

export function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

export function asOptionalString(value: unknown): string | undefined {
  const text = asTrimmedString(value);
  return text || undefined;
}

export function asOptionalBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

// ─── Helpers ─────────────────────────────────────────────────────

/** Extract agent ID from a session key like "agent:claude:myname". */
export function deriveAgentFromSessionKey(sessionKey: string, fallbackAgent: string): string {
  const match = sessionKey.match(/^agent:([^:]+):/i);
  const candidate = match?.[1] ? asTrimmedString(match[1]) : '';
  return candidate || fallbackAgent;
}

/** Build acpx permission CLI flags from a permission mode. */
export function buildPermissionArgs(mode: AcpPermissionMode): string[] {
  if (mode === 'approve-all') return ['--approve-all'];
  if (mode === 'deny-all') return ['--deny-all'];
  return ['--approve-reads'];
}

// ─── Provider auth env var stripping ─────────────────────────────

/**
 * Well-known provider auth env vars that should be stripped
 * from child process environments for security.
 */
const PROVIDER_AUTH_ENV_VARS: readonly string[] = [
  'ANTHROPIC_API_KEY',
  'OPENAI_API_KEY',
  'GOOGLE_API_KEY',
  'GEMINI_API_KEY',
  'AZURE_OPENAI_API_KEY',
  'AWS_ACCESS_KEY_ID',
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'COHERE_API_KEY',
  'MISTRAL_API_KEY',
  'FIREWORKS_API_KEY',
  'TOGETHER_API_KEY',
  'DEEPSEEK_API_KEY',
  'VOYAGE_API_KEY',
  'GROQ_API_KEY',
  'CEREBRAS_API_KEY',
  'NVIDIA_API_KEY',
  'GH_TOKEN',
  'GITHUB_TOKEN',
  'COPILOT_GITHUB_TOKEN',
  'ANTHROPIC_OAUTH_TOKEN',
];

/** Remove provider auth env vars (case-insensitive) from an env object. */
export function omitProviderAuthEnvVars(
  baseEnv: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const env = { ...baseEnv };
  const denied = new Set(PROVIDER_AUTH_ENV_VARS.map((k) => k.toUpperCase()));
  for (const actualKey of Object.keys(env)) {
    if (denied.has(actualKey.toUpperCase())) {
      delete env[actualKey];
    }
  }
  return env;
}
