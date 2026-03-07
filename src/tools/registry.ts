/**
 * Tool registry — registration, policy enforcement, grouping, and profiles.
 *
 * Now integrates with ToolPolicy for layered allow/deny resolution
 * and sandbox-aware tool filtering.
 */

import type { Tool, ToolGroup, ToolProfile } from './tool.js';
import { ToolPolicy, type ToolPolicyConfig } from './policy.js';

/** Which tool groups each profile includes. */
const PROFILE_GROUPS: Record<ToolProfile, ToolGroup[]> = {
  minimal: ['fs', 'runtime'],
  coding: ['fs', 'runtime', 'search', 'git', 'memory'],
  full: ['fs', 'runtime', 'search', 'git', 'memory', 'web', 'sessions', 'image', 'agents', 'messaging'],
};

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  private profile: ToolProfile = 'full';
  private denyList = new Set<string>();
  private allowList = new Set<string>();
  private toolPolicy: ToolPolicy | null = null;
  private inSandbox: boolean = false;

  /** Set the active tool profile. */
  setProfile(profile: ToolProfile): void {
    this.profile = profile;
  }

  /** Set the deny list (tool names that are always blocked). */
  setDenyList(names: string[]): void {
    this.denyList = new Set(names);
  }

  /** Set the allow list (overrides profile restrictions). */
  setAllowList(names: string[]): void {
    this.allowList = new Set(names);
  }

  /** Set the ToolPolicy for layered allow/deny resolution. */
  setToolPolicy(policy: ToolPolicy): void {
    this.toolPolicy = policy;
  }

  /** Create and set a ToolPolicy from config. */
  setToolPolicyFromConfig(config: ToolPolicyConfig): void {
    this.toolPolicy = new ToolPolicy(config);
  }

  /** Set whether tools are executing inside a sandbox. */
  setSandboxMode(inSandbox: boolean): void {
    this.inSandbox = inSandbox;
  }

  /** Get the current ToolPolicy (if set). */
  getToolPolicy(): ToolPolicy | null {
    return this.toolPolicy;
  }

  /** Register a tool. */
  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  /** Register multiple tools at once. */
  registerAll(tools: Tool[]): void {
    for (const tool of tools) {
      this.register(tool);
    }
  }

  /** Unregister a tool by name. */
  unregister(name: string): boolean {
    return this.tools.delete(name);
  }

  /** Get a tool by name (returns undefined if not found or denied). */
  getTool(name: string): Tool | undefined {
    if (this.denyList.has(name)) return undefined;

    // Check ToolPolicy if set
    if (this.toolPolicy) {
      const decision = this.toolPolicy.check(name, this.inSandbox);
      if (!decision.allowed) return undefined;
    }

    const tool = this.tools.get(name);
    if (!tool) return undefined;
    if (!this.isToolActive(tool)) return undefined;
    return tool;
  }

  /** Check if a tool is active under the current profile + policy. */
  private isToolActive(tool: Tool): boolean {
    if (this.denyList.has(tool.name)) return false;
    if (this.allowList.has(tool.name)) return true;
    if (!tool.group) return true; // ungrouped tools are always active
    const activeGroups = PROFILE_GROUPS[this.profile];
    return activeGroups.includes(tool.group);
  }

  /** Get all currently active tools (respecting profile + policy). */
  getActiveTools(): Tool[] {
    return Array.from(this.tools.values()).filter((t) => {
      // ToolPolicy check
      if (this.toolPolicy) {
        const decision = this.toolPolicy.check(t.name, this.inSandbox);
        if (!decision.allowed) return false;
      }
      return this.isToolActive(t);
    });
  }

  /** Get all registered tools (ignoring policy). */
  getAllTools(): Tool[] {
    return Array.from(this.tools.values());
  }

  /** Get tools in a specific group. */
  getToolsByGroup(group: ToolGroup): Tool[] {
    return this.getActiveTools().filter((t) => t.group === group);
  }

  /**
   * Explain why a tool is allowed or blocked.
   * Returns a human-readable explanation string.
   */
  explainTool(name: string): string {
    const lines: string[] = [`Tool: ${name}`];
    const tool = this.tools.get(name);

    if (!tool) {
      lines.push('Status: NOT REGISTERED');
      return lines.join('\n');
    }

    lines.push(`Group: ${tool.group ?? 'none'}`);
    lines.push(`Profile: ${this.profile}`);

    if (this.denyList.has(name)) {
      lines.push('Status: DENIED (in deny list)');
      return lines.join('\n');
    }

    if (this.toolPolicy) {
      const decision = this.toolPolicy.check(name, this.inSandbox);
      lines.push(`Policy decision: ${decision.allowed ? 'ALLOWED' : 'DENIED'} — ${decision.reason}`);
      if (!decision.allowed) {
        lines.push('Status: DENIED (by tool policy)');
        return lines.join('\n');
      }
    }

    if (this.allowList.has(name)) {
      lines.push('Status: ALLOWED (in allow list, overrides profile)');
      return lines.join('\n');
    }

    if (!tool.group) {
      lines.push('Status: ALLOWED (ungrouped tools are always active)');
      return lines.join('\n');
    }

    const activeGroups = PROFILE_GROUPS[this.profile];
    if (activeGroups.includes(tool.group)) {
      lines.push(`Status: ALLOWED (group "${tool.group}" is active in "${this.profile}" profile)`);
    } else {
      lines.push(`Status: DENIED (group "${tool.group}" is not in "${this.profile}" profile)`);
    }

    return lines.join('\n');
  }
}
