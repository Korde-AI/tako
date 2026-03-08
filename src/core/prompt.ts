/**
 * Prompt builder — assembles the system prompt from workspace files.
 *
 * Follows the reference runtime/reference architecture prompt assembly pattern:
 * 1. Core identity (SOUL.md, IDENTITY.md, AGENTS.md)
 * 2. Tool/user context (TOOLS.md, USER.md)
 * 3. Bootstrap (HEARTBEAT.md, BOOTSTRAP.md)
 * 4. Curated memory (MEMORY.md — always injected)
 * 5. Tool inventory (registered tools with schemas)
 * 6. Skill listings (XML format)
 * 7. Runtime context (host, OS, Node, model, shell, time)
 * 8. Repo structure (if in a git repo)
 *
 * Daily logs (memory/YYYY-MM-DD.md) are NOT pre-injected.
 * They are accessed on-demand via memory_search/memory_get tools.
 * Sub-agents only get AGENTS.md + TOOLS.md to keep context small.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hostname } from 'node:os';
import { generateRepoMap } from './self-awareness.js';
import type { Tool } from '../tools/tool.js';
import type { LoadedSkill } from '../skills/types.js';

/** Max characters per bootstrap file (prevents token blowout). */
const BOOTSTRAP_MAX_CHARS = 20_000;

/** Max total characters for all bootstrap files combined. */
const BOOTSTRAP_TOTAL_MAX_CHARS = 150_000;

/** Bootstrap file names to load (in order). */
const BOOTSTRAP_FILES = [
  'SOUL.md',
  'IDENTITY.md',
  'AGENTS.md',
  'TOOLS.md',
  'USER.md',
  'HEARTBEAT.md',
  'BOOTSTRAP.md',
] as const;

/** Minimal mode files (sub-agents). */
const MINIMAL_FILES = ['AGENTS.md', 'TOOLS.md'] as const;

export interface PromptMode {
  /** 'full' for main session, 'minimal' for sub-agents, 'none' to skip */
  mode: 'full' | 'minimal' | 'none';
}

export interface PromptParts {
  /** Workspace bootstrap file contents, keyed by filename */
  files: Map<string, string>;
  /** Curated memory content */
  memory?: string;
  /** Skill instruction blocks */
  skills?: string[];
  /** Tool inventory section */
  toolInventory?: string;
  /** Skill listings in XML format */
  skillListings?: string;
  /** Runtime context section */
  runtime?: string;
  /** Repo structure map */
  repoMap?: string;
  /** Safety guidelines section */
  safety?: string;
  /** Sandbox context info */
  sandboxInfo?: string;
}

export class PromptBuilder {
  private workspacePath: string;
  private skillInstructions: string[] = [];
  private registeredTools: Tool[] = [];
  private loadedSkills: LoadedSkill[] = [];
  private modelId: string = 'unknown';
  private workingDir: string = process.cwd();
  private sandboxMode: string = 'off';
  private sandboxWorkspaceAccess: string = 'ro';
  private timezoneContext: string | null = null;

  constructor(workspacePath: string) {
    this.workspacePath = workspacePath;
  }

  /** Switch workspace (for agent switching). */
  setWorkspace(workspacePath: string): void {
    this.workspacePath = workspacePath;
  }

  /** Get current workspace path. */
  getWorkspace(): string {
    return this.workspacePath;
  }

  /** Set timezone context string for injection into the runtime section. */
  setTimezoneContext(context: string): void {
    this.timezoneContext = context;
  }

  /** Set sandbox context for the safety section. */
  setSandboxInfo(mode: string, workspaceAccess: string): void {
    this.sandboxMode = mode;
    this.sandboxWorkspaceAccess = workspaceAccess;
  }

  /** Register skill instructions to include in the prompt. */
  addSkillInstructions(instructions: string): void {
    this.skillInstructions.push(instructions);
  }

  /** Set the tool inventory for the tools section. */
  setTools(tools: Tool[]): void {
    this.registeredTools = tools;
  }

  /** Set loaded skills for the skills section. */
  setSkills(skills: LoadedSkill[]): void {
    this.loadedSkills = skills;
  }

  /** Set the model ID for runtime context. */
  setModel(modelId: string): void {
    this.modelId = modelId;
  }

  /** Set the working directory for runtime context. */
  setWorkingDir(dir: string): void {
    this.workingDir = dir;
  }

  /**
   * Load a workspace file. Returns content with truncation marker if too long.
   * Returns a "[MISSING]" marker if the file doesn't exist.
   */
  private async loadFile(filename: string, markMissing: boolean = true): Promise<string> {
    const filePath = join(this.workspacePath, filename);
    try {
      const content = await readFile(filePath, 'utf-8');
      if (content.length > BOOTSTRAP_MAX_CHARS) {
        return (
          content.slice(0, BOOTSTRAP_MAX_CHARS) +
          `\n[... truncated at ${BOOTSTRAP_MAX_CHARS} chars — use \`read\` for full file]`
        );
      }
      return content;
    } catch {
      if (markMissing) {
        return `[MISSING] Expected at: ${filePath}`;
      }
      return '';
    }
  }

  /** Build the full system prompt from workspace files. */
  async build(mode: PromptMode = { mode: 'full' }): Promise<string> {
    if (mode.mode === 'none') return '';

    const parts: PromptParts = { files: new Map() };

    if (mode.mode === 'minimal') {
      for (const file of MINIMAL_FILES) {
        parts.files.set(file, await this.loadFile(file));
      }
      parts.runtime = this.buildRuntimeContext();
      return this.assemble(parts, 'minimal');
    }

    // Full mode: load all bootstrap files
    for (const file of BOOTSTRAP_FILES) {
      parts.files.set(file, await this.loadFile(file));
    }

    // Curated memory: try memory/MEMORY.md first, fall back to workspace root
    let memory = await this.loadFile('memory/MEMORY.md', false);
    if (!memory) {
      memory = await this.loadFile('MEMORY.md', false);
    }
    if (memory) {
      parts.memory = memory;
    }

    // Skill instructions (dynamic injection from triggers)
    if (this.skillInstructions.length > 0) {
      parts.skills = this.skillInstructions;
    }

    // Tool inventory
    if (this.registeredTools.length > 0) {
      parts.toolInventory = this.buildToolInventory();
    }

    // Skill listings (XML format like reference architecture)
    if (this.loadedSkills.length > 0) {
      parts.skillListings = this.buildSkillListings();
    }

    // Safety guidelines
    parts.safety = this.buildSafetySection();

    // Runtime context
    parts.runtime = this.buildRuntimeContext();

    // Repo structure map — only include on-demand (via self-awareness tool)
    // Not injected into every prompt to save context space.

    return this.assemble(parts, 'full');
  }

  /**
   * Build the tool inventory section.
   * Lists all registered tools with name, description, and parameter schema.
   */
  private buildToolInventory(): string {
    const lines: string[] = ['# Tool Inventory', ''];
    lines.push(`${this.registeredTools.length} tools available:`, '');

    for (const tool of this.registeredTools) {
      lines.push(`## ${tool.name}`);
      lines.push(tool.description);

      // Show parameter schema if it has properties
      if (tool.parameters?.properties) {
        const params = Object.entries(tool.parameters.properties as Record<string, { type?: string; description?: string }>);
        const required = new Set(tool.parameters.required ?? []);
        if (params.length > 0) {
          lines.push('Parameters:');
          for (const [name, schema] of params) {
            const req = required.has(name) ? ' (required)' : '';
            const type = schema.type ?? 'any';
            const desc = schema.description ? ` — ${schema.description}` : '';
            lines.push(`  - \`${name}\`: ${type}${req}${desc}`);
          }
        }
      }

      if (tool.group) {
        lines.push(`Group: ${tool.group}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Build skill listings in XML format (like reference runtime/reference architecture).
   */
  private buildSkillListings(): string {
    const lines: string[] = ['# Available Skills', '', '<skills>'];

    for (const skill of this.loadedSkills) {
      const m = skill.manifest;
      lines.push(`  <skill name="${m.name}" version="${m.version}">`);
      lines.push(`    <description>${m.description}</description>`);
      if (m.rootDir) {
        lines.push(`    <location>${m.rootDir}</location>`);
      }
      if (m.triggers && m.triggers.length > 0) {
        const triggerStr = m.triggers
          .map((t) => (t.value ? `${t.type}:${t.value}` : t.type))
          .join(', ');
        lines.push(`    <triggers>${triggerStr}</triggers>`);
      }
      if (m.userInvocable) {
        lines.push(`    <invocable>true</invocable>`);
      }
      if (skill.tools.length > 0) {
        const toolNames = skill.tools.map((t) => t.name).join(', ');
        lines.push(`    <tools>${toolNames}</tools>`);
      }
      lines.push(`  </skill>`);
    }

    lines.push('</skills>');
    return lines.join('\n');
  }

  /** Build the safety guidelines section. */
  private buildSafetySection(): string {
    const lines = [
      '# Safety & Security',
      '',
      '## Execution Safety',
      '- Do NOT run destructive commands (rm -rf /, mkfs, dd) without explicit user confirmation.',
      '- Prefer `trash` or moving to a temp directory over `rm` when deleting files.',
      '- Do NOT exfiltrate private data — never send file contents, credentials, or secrets to external services.',
      '- Do NOT read or expose `.env` files, SSH keys, API tokens, or credential files unless the user explicitly requests it.',
      '- Stay within the workspace directory. Do not navigate to or modify files outside the project root.',
      '- When in doubt, ask before acting. Especially for irreversible operations.',
      '',
      '## Network Safety',
      '- Do NOT make network requests to exfiltrate data.',
      '- Be cautious with curl/wget — never post file contents or credentials.',
      '- Prefer read-only operations when possible.',
      '',
      '## Git Safety',
      '- Never force-push without explicit permission.',
      '- Never run `git reset --hard` or `git clean -f` without confirmation.',
      '- Prefer creating new commits over amending existing ones.',
      '',
      '## Process Safety',
      '- Do not start long-running processes without informing the user.',
      '- Respect timeout limits on all commands.',
      '- Do not spawn processes that listen on network ports without permission.',
    ];

    if (this.sandboxMode !== 'off') {
      lines.push(
        '',
        '## Sandbox Context',
        `- Sandbox mode: **${this.sandboxMode}**`,
        `- Workspace access: **${this.sandboxWorkspaceAccess}**`,
        '- Commands execute inside an isolated Docker container.',
        '- Network access may be restricted (default: no egress).',
        '- Some tools may be unavailable in sandbox mode.',
      );
    }

    return lines.join('\n');
  }

  /** Build runtime context section. */
  private buildRuntimeContext(): string {
    const now = new Date();
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
    const timeStr = now.toLocaleTimeString('en-US', { hour12: false, timeZone: tz });
    const dateStr = now.toISOString().slice(0, 10);

    const lines = [
      '# Runtime',
      '',
      `- **Host:** ${hostname()}`,
      `- **OS:** ${process.platform} ${process.arch}`,
      `- **Node:** ${process.version}`,
      `- **Shell:** ${process.env.SHELL ?? 'unknown'}`,
      `- **Model:** ${this.modelId}`,
      `- **Workspace:** ${this.workspacePath}`,
      `- **Working Directory:** ${this.workingDir}`,
      '',
      '# Date & Time',
      '',
    ];

    if (this.timezoneContext) {
      lines.push(`- ${this.timezoneContext}`);
    } else {
      lines.push(
        `- **Date:** ${dateStr}`,
        `- **Time:** ${timeStr}`,
        `- **Timezone:** ${tz}`,
      );
    }

    return lines.join('\n');
  }

  /**
   * Assemble parts into the final system prompt string.
   * Non-empty sections are separated by markdown dividers.
   */
  private assemble(parts: PromptParts, mode: 'full' | 'minimal'): string {
    const sections: string[] = [];

    if (mode === 'full') {
      // Core identity: SOUL → IDENTITY → AGENTS
      this.pushFileSection(sections, parts, 'SOUL.md');
      this.pushFileSection(sections, parts, 'IDENTITY.md');
      this.pushFileSection(sections, parts, 'AGENTS.md');

      // Context files
      this.pushFileSection(sections, parts, 'TOOLS.md');
      this.pushFileSection(sections, parts, 'USER.md');
      // HEARTBEAT.md and BOOTSTRAP.md only loaded if non-empty/meaningful
      const heartbeat = parts.files.get('HEARTBEAT.md') ?? '';
      const isDefaultHeartbeat =
        heartbeat.includes('Keep this file empty') ||
        heartbeat.includes('Add tasks below when you want the agent to check something periodically');
      if (heartbeat && !heartbeat.includes('[MISSING]') && heartbeat.trim().length > 50 && !isDefaultHeartbeat) {
        sections.push(heartbeat);
      }
      // BOOTSTRAP.md is first-run only — skip if it contains default template text
      const bootstrap = parts.files.get('BOOTSTRAP.md') ?? '';
      if (bootstrap && !bootstrap.includes('[MISSING]') && !bootstrap.includes('First-Run Ritual')) {
        sections.push(bootstrap);
      }

      // Curated memory
      if (parts.memory) sections.push(parts.memory);

      // Skills (dynamic injection)
      if (parts.skills) {
        for (const skill of parts.skills) {
          sections.push(skill);
        }
      }

      // Tool inventory
      if (parts.toolInventory) sections.push(parts.toolInventory);

      // Skill listings (XML)
      if (parts.skillListings) sections.push(parts.skillListings);

      // Safety guidelines
      if (parts.safety) sections.push(parts.safety);

      // Repo structure map — removed from default prompt (progressive disclosure)
      // Agent can use self-awareness tool or `read` to explore repo when needed.
    } else {
      // Minimal: AGENTS + TOOLS only
      this.pushFileSection(sections, parts, 'AGENTS.md');
      this.pushFileSection(sections, parts, 'TOOLS.md');
    }

    // Core behavioral rules (always included)
    sections.push(this.buildBehavioralRules());

    // Runtime (always last)
    if (parts.runtime) sections.push(parts.runtime);

    // Enforce total max chars
    let assembled = sections.join('\n\n---\n\n');
    if (assembled.length > BOOTSTRAP_TOTAL_MAX_CHARS) {
      assembled =
        assembled.slice(0, BOOTSTRAP_TOTAL_MAX_CHARS) +
        '\n[... truncated — total context exceeded 150K chars]';
    }

    return assembled;
  }

  /** Core behavioral rules — ensures the agent always responds properly. */
  private buildBehavioralRules(): string {
    return `# Rules

- Always reply after processing — never leave the user without a response.
- Do NOT narrate routine tool calls. Call silently, then summarize the outcome.
- Never ask for bot tokens in chat — direct users to \`/setup\`.
- Use \`tako --help\` for CLI details. Don't memorize commands — look them up.
- When creating agents, guide naturally: Name → Role → Model → Deployment.
- After creating an independent agent, direct to \`/setup\` for channel config.`;
  }

  /** @deprecated — old verbose rules, replaced by compact version above */
  private _oldBehavioralRules(): string {
    return `# Agent Creation Guide

When the user asks to create a new agent, guide them through these steps naturally.
Don't dump all questions at once — have a natural back-and-forth conversation.

1. **Name & Purpose** — Ask what the agent should do. Suggest a name based on the purpose.
2. **Permission Role** — Explain the 5 roles briefly and ask which fits:
   - 🔑 admin — full control, can create/manage other agents
   - ⚙️ operator — manage agents, all tools, no role changes
   - 👤 standard — all tools, can't manage agents (default)
   - 🔒 restricted — no exec, no file writes outside workspace
   - 👁️ readonly — can only read and respond
3. **Model** — Ask if they want the same model as root or a different one.
4. **Deployment** — Ask how the agent should be used:
   - 🔗 **Sub-agent** (default): spawned by the root agent for tasks. No channel setup needed.
   - 🌐 **Independent**: gets its own Discord/Telegram bot. Needs a bot token. Lives in its own channels.
   Most agents work best as sub-agents. Only suggest independent if the user wants a separate bot presence.
5. **Confirm & Create** — Summarize the config and create using agents_add.

After creation, tell the user:
- The agent's workspace path
- How to switch to it: \`/agent switch <name>\`
- That they can customize SOUL.md in the agent's workspace for personality
- **If they chose independent mode:** Tell them to use the \`/setup\` slash command to securely configure Discord/Telegram bot tokens. NEVER ask users to paste tokens in chat — always direct them to \`/setup\`.

## Channel Configuration
- **NEVER ask for bot tokens in chat.** Tokens are sensitive credentials.
- **Always direct users to the \`/setup\` slash command** for channel configuration.
- The \`/setup\` command opens a secure modal (private form) where tokens can be entered safely.
- Say: "Use \`/setup\` to connect a Discord or Telegram bot — it opens a private form so your token stays secure."

---

# Response Rules

## CRITICAL: Always Reply to the User
- **ALWAYS generate a text response** after processing a request, even if you used tools.
- After calling tools, summarize what you did and the result.
- Never leave the user without a reply. If a tool fails, explain the error.
- When spawning sub-agents, tell the user what you're doing and that results will follow.

## Message Format
- Reply directly in plain text. Keep responses concise and actionable.
- Use markdown formatting sparingly (bold for emphasis, code blocks for code/commands).
- For multi-step tasks, briefly explain each step as you go.

## Tool Call Style
- Do NOT narrate routine tool calls — just call the tool silently.
- Do NOT say "Calling read function..." or "Let me check..." before using tools.
- After tool calls complete, summarize the outcome for the user.
- Narrate only when it helps: multi-step work, complex problems, or when the user asks.
- Do NOT end your turn with only a tool call and no text — always provide a final response.`;
  }

  /** Push a file section if it exists in parts. */
  private pushFileSection(sections: string[], parts: PromptParts, filename: string): void {
    const content = parts.files.get(filename);
    if (content) sections.push(content);
  }
}
