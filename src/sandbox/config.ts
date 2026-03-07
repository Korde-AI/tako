/**
 * Sandbox configuration types.
 *
 * Controls how tool execution is isolated:
 * - mode: when to sandbox (off, non-main sessions, or all)
 * - scope: container lifecycle (per-session, per-agent, or shared)
 * - workspaceAccess: how the workspace is mounted (none, read-only, read-write)
 * - docker: container image, network, binds, setup
 */

// ─── Sandbox config ──────────────────────────────────────────────────

/** When to sandbox tool execution. */
export type SandboxMode = 'off' | 'non-main' | 'all';

/** Container lifecycle scope. */
export type SandboxScope = 'session' | 'agent' | 'shared';

/** How the workspace is mounted inside the container. */
export type WorkspaceAccess = 'none' | 'ro' | 'rw';

/** Docker-specific configuration for the sandbox container. */
export interface DockerConfig {
  /** Container image (default: 'tako-sandbox:bookworm-slim'). */
  image?: string;
  /** Docker network (default: 'none' — no egress). */
  network?: string;
  /** Additional bind mounts (host:container format). */
  binds?: string[];
  /** Shell command to run inside the container after creation. */
  setupCommand?: string;
  /** User to run commands as inside the container. */
  user?: string;
}

/** Full sandbox configuration. */
export interface SandboxConfig {
  /** When to sandbox: 'off' disables, 'non-main' sandboxes spawned sessions, 'all' sandboxes everything. */
  mode: SandboxMode;
  /** Container lifecycle scope. */
  scope: SandboxScope;
  /** How the workspace is mounted. */
  workspaceAccess: WorkspaceAccess;
  /** Docker container settings. */
  docker?: DockerConfig;
}

/** Default sandbox config (off — no sandboxing). */
export const DEFAULT_SANDBOX_CONFIG: SandboxConfig = {
  mode: 'off',
  scope: 'session',
  workspaceAccess: 'ro',
  docker: {
    image: 'tako-sandbox:bookworm-slim',
    network: 'none',
  },
};
