/**
 * Agent permission roles for Tako.
 *
 * The root agent (created at first onboarding) has admin permissions.
 * Sub-agents are created with a specific role that limits what they can do.
 *
 * Predefined roles:
 *   admin      — full control: create/delete agents, manage roles, all tools, config
 *   operator   — manage agents and run all tools, but can't change roles or config
 *   editor     — read/write files, safe commands, no exec or config changes
 *   standard   — use all tools, can spawn sub-agents from its allowlist
 *   viewer     — read-only access, search and memory tools
 *   restricted — limited tools (no exec, no file write outside workspace)
 *   readonly   — can only read files and respond, no side effects
 *
 * Per-user role overrides: map platform user IDs to specific roles.
 * Config: agents.list[].roles: { default: RoleName; users?: Record<string, RoleName> }
 *
 * Custom roles can be created by the root agent at runtime.
 */

export type RoleName = 'admin' | 'operator' | 'editor' | 'standard' | 'viewer' | 'restricted' | 'readonly' | 'shared_reader';

export interface AgentRole {
  /** Role identifier. */
  name: string;
  /** Human-readable description. */
  description: string;
  /** Tool allowlist (empty = all tools). Checked at execution time. */
  allowTools: string[];
  /** Tool denylist (takes priority over allow). */
  denyTools: string[];
  /** Can this agent create other agents? */
  canCreateAgents: boolean;
  /** Can this agent delete other agents? */
  canDeleteAgents: boolean;
  /** Can this agent change roles of other agents? */
  canManageRoles: boolean;
  /** Can this agent modify Tako config? */
  canEditConfig: boolean;
  /** Can this agent use exec/shell tools? */
  canExec: boolean;
  /** Can this agent write files outside its workspace? */
  canWriteGlobal: boolean;
  /** Can this agent connect to channels? */
  canBindChannels: boolean;
}

/** Per-agent role configuration with per-user overrides. */
export interface AgentRoleConfig {
  /** Default role for this agent. */
  default: RoleName;
  /** Per-user role overrides (keyed by platform user ID, e.g. Discord or Telegram ID). */
  users?: Record<string, RoleName>;
}

/** Predefined roles. */
export const PREDEFINED_ROLES: Record<string, AgentRole> = {
  admin: {
    name: 'admin',
    description: 'Full control — create agents, manage roles, all tools, config',
    allowTools: [],
    denyTools: [],
    canCreateAgents: true,
    canDeleteAgents: true,
    canManageRoles: true,
    canEditConfig: true,
    canExec: true,
    canWriteGlobal: true,
    canBindChannels: true,
  },
  operator: {
    name: 'operator',
    description: 'Manage agents and run all tools, but no role/config changes',
    allowTools: [],
    denyTools: [],
    canCreateAgents: true,
    canDeleteAgents: false,
    canManageRoles: false,
    canEditConfig: false,
    canExec: true,
    canWriteGlobal: true,
    canBindChannels: true,
  },
  editor: {
    name: 'editor',
    description: 'Read/write files and safe commands — no exec, no config changes',
    allowTools: ['read', 'write', 'edit', 'list_directory', 'memory_search', 'memory_write',
      'web_search', 'web_fetch', 'apply_patch'],
    denyTools: ['exec', 'shell', 'exec_command', 'cron_add', 'cron_remove',
      'agents_add', 'agents_remove'],
    canCreateAgents: false,
    canDeleteAgents: false,
    canManageRoles: false,
    canEditConfig: false,
    canExec: false,
    canWriteGlobal: false,
    canBindChannels: false,
  },
  standard: {
    name: 'standard',
    description: 'All tools, can spawn sub-agents from allowlist',
    allowTools: [],
    denyTools: [],
    canCreateAgents: false,
    canDeleteAgents: false,
    canManageRoles: false,
    canEditConfig: false,
    canExec: true,
    canWriteGlobal: false,
    canBindChannels: false,
  },
  viewer: {
    name: 'viewer',
    description: 'Read-only with search — can read files, search, and use memory',
    allowTools: ['read', 'list_directory', 'memory_search', 'web_search', 'web_fetch'],
    denyTools: ['exec', 'shell', 'write', 'edit', 'exec_command', 'apply_patch',
      'cron_add', 'cron_remove', 'agents_add', 'agents_remove', 'memory_write'],
    canCreateAgents: false,
    canDeleteAgents: false,
    canManageRoles: false,
    canEditConfig: false,
    canExec: false,
    canWriteGlobal: false,
    canBindChannels: false,
  },
  restricted: {
    name: 'restricted',
    description: 'Limited tools — no exec, no writes outside workspace',
    allowTools: [],
    denyTools: ['exec', 'shell', 'exec_command'],
    canCreateAgents: false,
    canDeleteAgents: false,
    canManageRoles: false,
    canEditConfig: false,
    canExec: false,
    canWriteGlobal: false,
    canBindChannels: false,
  },
  readonly: {
    name: 'readonly',
    description: 'Read-only — can read files and respond, no side effects',
    allowTools: ['read', 'list_directory', 'memory_search', 'web_search', 'web_fetch'],
    denyTools: ['exec', 'shell', 'write', 'edit', 'exec_command', 'cron_add', 'cron_remove', 'agents_add', 'agents_remove'],
    canCreateAgents: false,
    canDeleteAgents: false,
    canManageRoles: false,
    canEditConfig: false,
    canExec: false,
    canWriteGlobal: false,
    canBindChannels: false,
  },
  shared_reader: {
    name: 'shared_reader',
    description: 'Shared readonly access — can inspect shared project and channel state, but cannot mutate or execute side effects',
    allowTools: [
      'read',
      'list_directory',
      'glob_search',
      'content_search',
      'memory_search',
      'web_search',
      'web_fetch',
      'github_repo_inspect',
      'extract_office_text',
      'discord_room_inspect',
      'git_status',
      'session_status',
    ],
    denyTools: [
      'exec',
      'shell',
      'write',
      'edit',
      'apply_patch',
      'exec_command',
      'cron_add',
      'cron_remove',
      'agents_add',
      'agents_remove',
      'project_bootstrap',
      'project_member_manage',
      'project_close',
      'message',
      'discord_room_access_manage',
      'allow_from_add',
      'allow_from_remove',
      'memory_write',
    ],
    canCreateAgents: false,
    canDeleteAgents: false,
    canManageRoles: false,
    canEditConfig: false,
    canExec: false,
    canWriteGlobal: false,
    canBindChannels: false,
  },
};

/** Check if a tool call is allowed for a given role. */
export function isToolAllowed(role: AgentRole, toolName: string): boolean {
  // Deny list takes priority
  if (role.denyTools.length > 0 && role.denyTools.includes(toolName)) return false;
  // If allow list is specified (non-empty), tool must be in it
  if (role.allowTools.length > 0) return role.allowTools.includes(toolName);
  // Empty allow = all allowed
  return true;
}

/** Get a role by name (predefined or custom). */
export function getRole(name: string, customRoles?: Record<string, AgentRole>): AgentRole | null {
  return PREDEFINED_ROLES[name] ?? customRoles?.[name] ?? null;
}

/** List all available role names. */
export function listRoles(customRoles?: Record<string, AgentRole>): string[] {
  return [...Object.keys(PREDEFINED_ROLES), ...Object.keys(customRoles ?? {})];
}

/**
 * Resolve the effective role for a user interacting with an agent.
 *
 * Resolution order:
 * 1. Per-user override in AgentRoleConfig.users
 * 2. Agent's default role (AgentRoleConfig.default)
 * 3. Fallback to 'standard'
 */
export function resolveUserRole(
  roleConfig: AgentRoleConfig | undefined,
  userId?: string,
  customRoles?: Record<string, AgentRole>,
): AgentRole {
  if (!roleConfig) {
    return PREDEFINED_ROLES['standard'];
  }

  // Check per-user override
  if (userId && roleConfig.users?.[userId]) {
    const role = getRole(roleConfig.users[userId], customRoles);
    if (role) return role;
  }

  // Use agent default
  const role = getRole(roleConfig.default, customRoles);
  return role ?? PREDEFINED_ROLES['standard'];
}

/**
 * Check if a tool call is allowed for a specific user on a specific agent.
 * Convenience function that resolves the role and checks in one call.
 */
export function checkToolPermission(
  toolName: string,
  roleConfig: AgentRoleConfig | undefined,
  userId?: string,
  customRoles?: Record<string, AgentRole>,
): { allowed: boolean; role: AgentRole; reason?: string } {
  const role = resolveUserRole(roleConfig, userId, customRoles);

  if (!isToolAllowed(role, toolName)) {
    return {
      allowed: false,
      role,
      reason: `Role '${role.name}' does not allow tool '${toolName}'`,
    };
  }

  return { allowed: true, role };
}
