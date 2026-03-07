/**
 * Skill manifest types — describes a skill arm's capabilities.
 *
 * Skills are directories containing a SKILL.md file with YAML frontmatter.
 * The frontmatter defines metadata, triggers, and dependencies.
 * The Markdown body contains instructions injected into the system prompt.
 */

import type { Tool } from '../tools/tool.js';
import type { HookEvent, HookHandler } from '../hooks/types.js';
import type { SkillExtensions } from './extensions.js';

/**
 * Parsed skill manifest from SKILL.md frontmatter + filesystem.
 */
export interface SkillManifest {
  /** Unique skill name (e.g. 'find-skills', 'skill-creator') */
  name: string;
  /** Human-readable description — also used for trigger matching */
  description: string;
  /** Semantic version string */
  version: string;
  /** Author name or handle */
  author?: string;
  /** Trigger conditions — when should this skill activate? */
  triggers?: SkillTrigger[];
  /** Tool names this skill provides (resolved from tools/ dir) */
  tools?: string[];
  /** Hook event names this skill listens to */
  hooks?: string[];
  /** Whether this skill is user-invocable as a slash command */
  userInvocable?: boolean;
  /** Whether to exclude from automatic model invocation */
  disableModelInvocation?: boolean;
  /** Command dispatch mode — 'tool' bypasses model */
  commandDispatch?: 'tool';
  /** Tool name for direct dispatch */
  commandTool?: string;
  /** Argument mode for tool dispatch */
  commandArgMode?: 'raw';
  /** Platform requirements */
  requires?: SkillRequirements;
  /** Path to the SKILL.md file */
  skillPath: string;
  /** Path to the skill's root directory */
  rootDir: string;
  /** Whether this skill provides a channel adapter */
  hasChannel?: boolean;
  /** Path to the channel adapter directory */
  channelDir?: string;
  /** Channel adapter configuration schema (optional) */
  channelConfig?: Record<string, unknown>;
  /** Extension subsystems provided by this skill */
  extensions?: SkillExtensions;
}

/**
 * Trigger condition for dynamic skill injection.
 * When a trigger matches the current message, the skill's
 * instructions are injected into the system prompt for that turn.
 */
export interface SkillTrigger {
  /** Trigger type */
  type: 'keyword' | 'pattern' | 'always' | 'manual';
  /** Trigger value — keyword string or regex pattern */
  value?: string;
}

/**
 * Runtime requirements for a skill to be eligible.
 */
export interface SkillRequirements {
  /** Required binaries on PATH */
  bins?: string[];
  /** At least one of these binaries must exist */
  anyBins?: string[];
  /** Required environment variables */
  env?: string[];
  /** Required OS platforms */
  os?: string[];
}

/**
 * A fully loaded skill with parsed instructions, tools, and hook bindings.
 */
export interface LoadedSkill {
  /** Parsed manifest from SKILL.md frontmatter */
  manifest: SkillManifest;
  /** The SKILL.md body content (injected into system prompt) */
  instructions: string;
  /** Tools registered by this skill (loaded from tools/ dir) */
  tools: Tool[];
  /** Hook registrations from this skill */
  hookBindings: Array<{ event: HookEvent; handler: HookHandler }>;
}
