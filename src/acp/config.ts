/**
 * ACP Runtime configuration types and resolution.
 */

// ─── Permission modes ────────────────────────────────────────────

export const ACP_PERMISSION_MODES = ['approve-all', 'approve-reads', 'deny-all'] as const;
export type AcpPermissionMode = (typeof ACP_PERMISSION_MODES)[number];

export const ACP_NON_INTERACTIVE_POLICIES = ['deny', 'fail'] as const;
export type AcpNonInteractivePolicy = (typeof ACP_NON_INTERACTIVE_POLICIES)[number];

// ─── Allowed agents ──────────────────────────────────────────────

export const ACP_ALLOWED_AGENTS = ['claude', 'codex', 'pi', 'opencode', 'gemini', 'kimi'] as const;
export type AcpAgent = (typeof ACP_ALLOWED_AGENTS)[number];

// ─── Config ──────────────────────────────────────────────────────

/** User-facing ACP runtime configuration (stored in tako.json). */
export interface AcpRuntimeConfig {
  /** Enable ACP integration (default: true). */
  enabled: boolean;
  /** acpx command path (default: resolved via ACPX_CMD env, local node_modules, or global). */
  command: string;
  /** Permission mode for ACP sessions. */
  permissionMode: AcpPermissionMode;
  /** Default agent to use (default: 'claude'). */
  defaultAgent: string;
  /** Allowed agent identifiers. */
  allowedAgents: string[];
  /** Timeout in seconds for one-shot operations (default: 600). */
  timeoutSeconds: number;
  /** Working directory (default: workspace root). */
  cwd: string;
  /** Non-interactive permission policy (default: 'deny'). */
  nonInteractivePermissions: AcpNonInteractivePolicy;
  /** Whether to strip provider auth env vars from child processes. */
  stripProviderAuthEnvVars: boolean;
}

// ─── Defaults & resolution ───────────────────────────────────────

const DEFAULT_CONFIG: AcpRuntimeConfig = {
  enabled: true,
  command: 'acpx',
  permissionMode: 'approve-reads',
  defaultAgent: 'claude',
  allowedAgents: [...ACP_ALLOWED_AGENTS],
  timeoutSeconds: 600,
  cwd: process.cwd(),
  nonInteractivePermissions: 'deny',
  stripProviderAuthEnvVars: true,
};

/** Resolve partial user config into a full AcpRuntimeConfig. */
export function resolveAcpConfig(
  partial?: Partial<AcpRuntimeConfig>,
  workspaceDir?: string,
): AcpRuntimeConfig {
  const cwd = partial?.cwd ?? workspaceDir ?? DEFAULT_CONFIG.cwd;
  return {
    ...DEFAULT_CONFIG,
    ...partial,
    cwd,
  };
}
