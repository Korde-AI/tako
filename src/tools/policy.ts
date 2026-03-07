/**
 * Tool policy — allow/deny lists with group expansion and layered resolution.
 *
 * Policy layers (evaluated in order, deny always wins):
 * 1. Global deny list (always blocks)
 * 2. Global allow list
 * 3. Profile-based group activation
 * 4. Sandbox-specific overrides (when running inside a sandbox)
 *
 * Tool groups expand to individual tool names:
 *   group:runtime → exec, process
 *   group:fs      → read, write, edit, apply_patch
 *   group:search  → glob_search, content_search
 *   group:git     → git_status, git_diff, git_commit
 *   group:memory  → memory_search, memory_get, memory_store
 *   group:web     → web_search, web_fetch
 *   group:sessions → session_status, session_list, session_send, session_spawn
 *   group:image   → vision
 */

import type { ToolGroup, ToolProfile } from './tool.js';

// ─── Group expansion ─────────────────────────────────────────────────

/** Maps group names to the individual tools they contain. */
const GROUP_TOOLS: Record<ToolGroup, string[]> = {
  runtime: ['exec', 'process'],
  fs: ['read', 'write', 'edit', 'apply_patch'],
  search: ['glob_search', 'content_search'],
  git: ['git_status', 'git_diff', 'git_commit'],
  memory: ['memory_search', 'memory_get', 'memory_store'],
  web: ['web_search', 'web_fetch'],
  sessions: ['session_status', 'sessions_list', 'sessions_send'],
  image: ['vision'],
  agents: ['agents_list', 'agents_add', 'agents_remove', 'sessions_spawn', 'sessions_history', 'subagents'],
  messaging: ['message'],
};

/** Expand a list of tool names and group references into individual tool names. */
export function expandToolNames(names: string[]): Set<string> {
  const result = new Set<string>();
  for (const name of names) {
    if (name.startsWith('group:')) {
      const groupName = name.slice(6) as ToolGroup;
      const tools = GROUP_TOOLS[groupName];
      if (tools) {
        for (const t of tools) result.add(t);
      }
    } else {
      result.add(name);
    }
  }
  return result;
}

// ─── Exec policy ─────────────────────────────────────────────────────

/** How command execution is controlled. */
export type ExecSecurity = 'deny' | 'allowlist' | 'full';

/** When to ask for approval before executing. */
export type ExecAskMode = 'off' | 'on-miss' | 'always';

/** Exec-specific policy config. */
export interface ExecPolicyConfig {
  /** Security mode: deny all, allowlist only, or full access. */
  security: ExecSecurity;
  /** When to prompt for approval. */
  askMode?: ExecAskMode;
  /** Patterns for pre-approved commands (regex strings). */
  allowlist?: string[];
  /** Max execution timeout in ms (default: 30000). */
  timeout?: number;
  /** Max output size in bytes (default: 1MB). */
  maxOutputSize?: number;
}

// ─── Tool policy config ──────────────────────────────────────────────

/** Tool policy configuration. */
export interface ToolPolicyConfig {
  /** Base profile for group activation. */
  profile: ToolProfile;
  /** Explicitly allowed tools or groups (overrides profile). */
  allow?: string[];
  /** Explicitly denied tools or groups (always wins). */
  deny?: string[];
  /** Sandbox-specific tool policy overrides. */
  sandbox?: {
    tools?: {
      allow?: string[];
      deny?: string[];
    };
  };
  /** Exec-specific policy. */
  exec?: ExecPolicyConfig;
}

// ─── Decision type ───────────────────────────────────────────────────

/** Result of a policy check. */
export interface PolicyDecision {
  allowed: boolean;
  reason: string;
}

// ─── ToolPolicy class ────────────────────────────────────────────────

/**
 * ToolPolicy — resolves allow/deny decisions for tools.
 *
 * Supports layered resolution: global policy, then optional sandbox overlay.
 * Deny always wins over allow at each layer.
 */
export class ToolPolicy {
  private globalAllow: Set<string>;
  private globalDeny: Set<string>;
  private sandboxAllow: Set<string>;
  private sandboxDeny: Set<string>;
  private execPolicy: ExecPolicyConfig;
  private compiledAllowlist: RegExp[] | null = null;

  constructor(config: ToolPolicyConfig) {
    this.globalAllow = expandToolNames(config.allow ?? []);
    this.globalDeny = expandToolNames(config.deny ?? []);
    this.sandboxAllow = expandToolNames(config.sandbox?.tools?.allow ?? []);
    this.sandboxDeny = expandToolNames(config.sandbox?.tools?.deny ?? []);
    this.execPolicy = config.exec ?? { security: 'full' };

    // Pre-compile exec allowlist patterns
    if (this.execPolicy.allowlist) {
      this.compiledAllowlist = this.execPolicy.allowlist.map((p) => new RegExp(p));
    }
  }

  /**
   * Check if a tool is allowed under the current policy.
   *
   * @param toolName - The tool to check
   * @param inSandbox - Whether the tool is executing inside a sandbox
   */
  check(toolName: string, inSandbox: boolean = false): PolicyDecision {
    // Global deny always wins
    if (this.globalDeny.has(toolName)) {
      return { allowed: false, reason: `"${toolName}" is in the global deny list` };
    }

    // Sandbox deny layer
    if (inSandbox && this.sandboxDeny.has(toolName)) {
      return { allowed: false, reason: `"${toolName}" is denied in sandbox mode` };
    }

    // Global allow overrides profile
    if (this.globalAllow.has(toolName)) {
      return { allowed: true, reason: `"${toolName}" is in the global allow list` };
    }

    // Sandbox allow
    if (inSandbox && this.sandboxAllow.has(toolName)) {
      return { allowed: true, reason: `"${toolName}" is explicitly allowed in sandbox mode` };
    }

    // Fall through — let the ToolRegistry's profile-based check handle it
    return { allowed: true, reason: 'Allowed by default (profile-based)' };
  }

  /**
   * Check if a specific command is allowed by the exec policy.
   *
   * @param command - Shell command string to check
   */
  checkExec(command: string): PolicyDecision {
    if (this.execPolicy.security === 'deny') {
      return { allowed: false, reason: 'Exec is denied by security policy' };
    }

    if (this.execPolicy.security === 'full') {
      return { allowed: true, reason: 'Exec is in full-access mode' };
    }

    // Allowlist mode — check against patterns
    if (this.compiledAllowlist) {
      for (const pattern of this.compiledAllowlist) {
        if (pattern.test(command)) {
          return { allowed: true, reason: `Command matches allowlist pattern: ${pattern.source}` };
        }
      }
    }

    return {
      allowed: false,
      reason: 'Command not in exec allowlist',
    };
  }

  /** Get exec policy config. */
  getExecPolicy(): Readonly<ExecPolicyConfig> {
    return { ...this.execPolicy };
  }

  /** Get the exec timeout (ms). */
  getExecTimeout(): number {
    return this.execPolicy.timeout ?? 30_000;
  }

  /** Get the max output size (bytes). */
  getMaxOutputSize(): number {
    return this.execPolicy.maxOutputSize ?? 1024 * 1024;
  }

  /**
   * Produce a human-readable explanation of why a tool is allowed or denied.
   */
  explain(toolName: string, inSandbox: boolean = false): string {
    const decision = this.check(toolName, inSandbox);
    const lines = [
      `Tool: ${toolName}`,
      `Sandbox: ${inSandbox ? 'yes' : 'no'}`,
      `Decision: ${decision.allowed ? 'ALLOWED' : 'DENIED'}`,
      `Reason: ${decision.reason}`,
    ];

    if (this.globalDeny.has(toolName)) {
      lines.push(`Global deny list: contains "${toolName}"`);
    }
    if (this.globalAllow.has(toolName)) {
      lines.push(`Global allow list: contains "${toolName}"`);
    }
    if (inSandbox) {
      if (this.sandboxDeny.has(toolName)) {
        lines.push(`Sandbox deny list: contains "${toolName}"`);
      }
      if (this.sandboxAllow.has(toolName)) {
        lines.push(`Sandbox allow list: contains "${toolName}"`);
      }
    }

    return lines.join('\n');
  }
}
