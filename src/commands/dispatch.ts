/**
 * Command dispatcher — routes parsed commands to the appropriate handler.
 *
 * Returns skill instructions for injection into a model-driven turn.
 */

import type { ParsedCommand } from './parser.js';
import type { SkillCommandSpec } from './skill-commands.js';
import type { SkillLoader } from '../skills/loader.js';

/**
 * Context provided to the command dispatcher.
 */
export interface DispatchContext {
  /** Skill loader for looking up skill instructions */
  skillLoader: SkillLoader;
}

/**
 * Dispatch result indicating how the command was handled.
 */
export interface DispatchResult {
  /** How the command was handled */
  kind: 'skill-inject' | 'not-found';
  /** Skill name to inject (for skill-inject) */
  skillName?: string;
  /** Instructions to inject into system prompt (for skill-inject) */
  instructions?: string;
  /** User message to forward to agent loop (for skill-inject) */
  forwardMessage?: string;
}

/**
 * Dispatch a parsed command against registered skill commands.
 *
 * Returns instructions for injection if a matching skill is found.
 * - Returns not-found if no skill command matches.
 */
export async function dispatchSkillCommand(
  parsed: ParsedCommand,
  specs: SkillCommandSpec[],
  context: DispatchContext,
): Promise<DispatchResult> {
  // Handle `/skill <name> [input]` generic runner
  let spec: SkillCommandSpec | undefined;
  let args = parsed.args;

  if (parsed.command === 'skill') {
    // Parse skill name from args
    const parts = parsed.args.split(/\s+/, 2);
    const skillName = parts[0];
    args = parsed.args.slice(skillName?.length ?? 0).trim();
    spec = specs.find((s) => s.skillName === skillName || s.name === skillName);
  } else {
    spec = specs.find((s) => s.name === parsed.command);
  }

  if (!spec) {
    return { kind: 'not-found' };
  }

  const skill = context.skillLoader.get(spec.skillName);
  if (!skill) {
    return { kind: 'not-found' };
  }

  return {
    kind: 'skill-inject',
    skillName: spec.skillName,
    instructions: skill.instructions,
    forwardMessage: args || parsed.raw,
  };
}
