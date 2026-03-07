/**
 * Command dispatcher — routes parsed commands to the appropriate handler.
 *
 * Supports two dispatch modes:
 * - tool dispatch: call a tool directly, return result (no model turn)
 * - model dispatch (default): inject skill instructions into system prompt,
 *   forward to agent loop as a normal message
 */

import type { ParsedCommand } from './parser.js';
import type { SkillCommandSpec } from './skill-commands.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolContext } from '../tools/tool.js';
import type { SkillLoader } from '../skills/loader.js';

/**
 * Context provided to the command dispatcher.
 */
export interface DispatchContext {
  /** Tool registry for direct tool execution */
  toolRegistry: ToolRegistry;
  /** Skill loader for looking up skill instructions */
  skillLoader: SkillLoader;
  /** Tool execution context */
  toolContext: ToolContext;
}

/**
 * Dispatch result indicating how the command was handled.
 */
export interface DispatchResult {
  /** How the command was handled */
  kind: 'tool-result' | 'skill-inject' | 'not-found';
  /** Direct response text (for tool-result) */
  response?: string;
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
 * - If the command maps to a tool-dispatch skill, execute the tool directly.
 * - If the command maps to a model-dispatch skill, return instructions for injection.
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

  // Tool dispatch — execute directly, no model turn
  if (spec.dispatch?.kind === 'tool') {
    const tool = context.toolRegistry.getTool(spec.dispatch.toolName);
    if (!tool) {
      return {
        kind: 'tool-result',
        response: `Tool "${spec.dispatch.toolName}" not found for skill "${spec.skillName}".`,
      };
    }

    try {
      const result = await tool.execute(
        spec.dispatch.argMode === 'raw' ? { input: args } : { input: args },
        context.toolContext,
      );
      return {
        kind: 'tool-result',
        response: result.output,
      };
    } catch (err) {
      return {
        kind: 'tool-result',
        response: `Error executing ${spec.dispatch.toolName}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  // Model dispatch — inject skill instructions, forward message to agent loop
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
