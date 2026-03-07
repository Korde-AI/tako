/**
 * Skill command builder — generates command specs from loaded skills.
 *
 * Scans loaded skills for userInvocable !== false, sanitizes names,
 * handles deduplication, and reads dispatch configuration from frontmatter.
 */

import type { LoadedSkill } from '../skills/types.js';

/**
 * A command spec derived from a loaded skill.
 */
export interface SkillCommandSpec {
  /** Sanitized command name (a-z0-9_, max 32 chars) */
  name: string;
  /** Original skill name */
  skillName: string;
  /** Truncated description (max 100 chars) */
  description: string;
  /** Direct dispatch config (bypasses model) */
  dispatch?: {
    kind: 'tool';
    toolName: string;
    argMode: 'raw';
  };
}

/**
 * Sanitize a skill name into a valid command name.
 * Lowercase, replace non-alphanumeric with _, truncate to 32 chars.
 */
export function sanitizeCommandName(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '_')
    .replace(/_+/g, '_')
    .replace(/^_|_$/g, '')
    .slice(0, 32);
}

/**
 * Build command specs from an array of loaded skills.
 * Filters to userInvocable !== false, sanitizes names, de-duplicates.
 */
export function buildSkillCommands(skills: LoadedSkill[]): SkillCommandSpec[] {
  const specs: SkillCommandSpec[] = [];
  const usedNames = new Set<string>();

  for (const skill of skills) {
    if (skill.manifest.userInvocable === false) continue;

    let name = sanitizeCommandName(skill.manifest.name);
    if (!name) continue;

    // De-duplicate with _2, _3 suffixes
    if (usedNames.has(name)) {
      let suffix = 2;
      while (usedNames.has(`${name}_${suffix}`)) suffix++;
      name = `${name}_${suffix}`.slice(0, 32);
    }
    usedNames.add(name);

    const description = skill.manifest.description.length > 100
      ? skill.manifest.description.slice(0, 97) + '...'
      : skill.manifest.description;

    const spec: SkillCommandSpec = {
      name,
      skillName: skill.manifest.name,
      description,
    };

    // Build dispatch config from frontmatter
    const m = skill.manifest;
    if (m.commandDispatch === 'tool' && m.commandTool) {
      spec.dispatch = {
        kind: 'tool',
        toolName: m.commandTool,
        argMode: m.commandArgMode ?? 'raw',
      };
    }

    specs.push(spec);
  }

  return specs;
}
