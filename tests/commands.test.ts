/**
 * Tests for the skill→command system:
 * - Command parser (valid commands, non-commands, edge cases)
 * - Name sanitization and deduplication
 * - Registry lookup and skill command building
 * - Dispatch routing (model vs tool)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseCommand } from '../src/commands/parser.js';
import { sanitizeCommandName, buildSkillCommands, type SkillCommandSpec } from '../src/commands/skill-commands.js';
import { dispatchSkillCommand, type DispatchContext } from '../src/commands/dispatch.js';
import type { LoadedSkill, SkillManifest } from '../src/skills/types.js';
import type { Tool, ToolContext, ToolResult } from '../src/tools/tool.js';

// ─── Command parser ─────────────────────────────────────────────────

describe('parseCommand', () => {
  it('parses a simple command', () => {
    const result = parseCommand('/help');
    assert.ok(result);
    assert.equal(result.command, 'help');
    assert.equal(result.args, '');
    assert.equal(result.raw, '/help');
  });

  it('parses a command with args', () => {
    const result = parseCommand('/model anthropic/claude-sonnet-4-6');
    assert.ok(result);
    assert.equal(result.command, 'model');
    assert.equal(result.args, 'anthropic/claude-sonnet-4-6');
  });

  it('parses a command with multiline args', () => {
    const result = parseCommand('/skill test\nsome multi\nline input');
    assert.ok(result);
    assert.equal(result.command, 'skill');
    assert.equal(result.args, 'test\nsome multi\nline input');
  });

  it('returns null for non-command messages', () => {
    assert.equal(parseCommand('hello world'), null);
    assert.equal(parseCommand(''), null);
    assert.equal(parseCommand('not a /command'), null);
  });

  it('returns null for invalid command names', () => {
    assert.equal(parseCommand('/'), null);
    assert.equal(parseCommand('/ space'), null);
    assert.equal(parseCommand('/UPPER'), null);
  });

  it('handles leading/trailing whitespace', () => {
    const result = parseCommand('  /status  ');
    assert.ok(result);
    assert.equal(result.command, 'status');
    assert.equal(result.args, '');
  });

  it('handles underscore and numbers in command names', () => {
    const result = parseCommand('/my_cmd_2 arg1');
    assert.ok(result);
    assert.equal(result.command, 'my_cmd_2');
    assert.equal(result.args, 'arg1');
  });
});

// ─── Name sanitization ──────────────────────────────────────────────

describe('sanitizeCommandName', () => {
  it('lowercases and replaces non-alphanumeric', () => {
    assert.equal(sanitizeCommandName('My-Skill'), 'my_skill');
  });

  it('collapses multiple underscores', () => {
    assert.equal(sanitizeCommandName('a--b__c'), 'a_b_c');
  });

  it('strips leading/trailing underscores', () => {
    assert.equal(sanitizeCommandName('-my-skill-'), 'my_skill');
  });

  it('truncates to 32 chars', () => {
    const long = 'a'.repeat(50);
    assert.equal(sanitizeCommandName(long).length, 32);
  });

  it('handles special characters', () => {
    assert.equal(sanitizeCommandName('skill@v2.0!'), 'skill_v2_0');
  });
});

// ─── buildSkillCommands ─────────────────────────────────────────────

function makeLoadedSkill(overrides: Partial<SkillManifest> & { name: string }): LoadedSkill {
  return {
    manifest: {
      description: 'Test skill',
      version: '1.0.0',
      skillPath: '/tmp/test/SKILL.md',
      rootDir: '/tmp/test',
      ...overrides,
    },
    instructions: 'Test instructions',
    tools: [],
    hookBindings: [],
  };
}

describe('buildSkillCommands', () => {
  it('builds specs from loaded skills', () => {
    const skills = [
      makeLoadedSkill({ name: 'my-skill', description: 'A cool skill' }),
    ];
    const specs = buildSkillCommands(skills);
    assert.equal(specs.length, 1);
    assert.equal(specs[0].name, 'my_skill');
    assert.equal(specs[0].skillName, 'my-skill');
    assert.equal(specs[0].description, 'A cool skill');
  });

  it('filters out non-invocable skills', () => {
    const skills = [
      makeLoadedSkill({ name: 'visible', userInvocable: true }),
      makeLoadedSkill({ name: 'hidden', userInvocable: false }),
    ];
    const specs = buildSkillCommands(skills);
    assert.equal(specs.length, 1);
    assert.equal(specs[0].skillName, 'visible');
  });

  it('de-duplicates names with _2, _3 suffixes', () => {
    const skills = [
      makeLoadedSkill({ name: 'deploy' }),
      makeLoadedSkill({ name: 'deploy' }),
      makeLoadedSkill({ name: 'deploy' }),
    ];
    const specs = buildSkillCommands(skills);
    const names = specs.map((s) => s.name);
    assert.equal(names.length, 3);
    assert.ok(names.includes('deploy'));
    assert.ok(names.includes('deploy_2'));
    assert.ok(names.includes('deploy_3'));
  });

  it('truncates long descriptions to 100 chars', () => {
    const longDesc = 'x'.repeat(200);
    const skills = [makeLoadedSkill({ name: 'long', description: longDesc })];
    const specs = buildSkillCommands(skills);
    assert.ok(specs[0].description.length <= 100);
    assert.ok(specs[0].description.endsWith('...'));
  });

  it('builds dispatch config from manifest', () => {
    const skills = [
      makeLoadedSkill({
        name: 'tool-skill',
        commandDispatch: 'tool',
        commandTool: 'exec',
        commandArgMode: 'raw',
      }),
    ];
    const specs = buildSkillCommands(skills);
    assert.ok(specs[0].dispatch);
    assert.equal(specs[0].dispatch!.kind, 'tool');
    assert.equal(specs[0].dispatch!.toolName, 'exec');
    assert.equal(specs[0].dispatch!.argMode, 'raw');
  });

  it('defaults to no dispatch (model mode)', () => {
    const skills = [makeLoadedSkill({ name: 'model-skill' })];
    const specs = buildSkillCommands(skills);
    assert.equal(specs[0].dispatch, undefined);
  });
});

// ─── Dispatch routing ───────────────────────────────────────────────

describe('dispatchSkillCommand', () => {
  const mockTool: Tool = {
    name: 'mock_tool',
    description: 'A mock tool',
    parameters: { type: 'object', properties: {} },
    async execute(params: unknown): Promise<ToolResult> {
      const input = (params as Record<string, string>).input ?? '';
      return { output: `mock result: ${input}`, success: true };
    },
  };

  const mockToolRegistry = {
    getTool(name: string) {
      return name === 'mock_tool' ? mockTool : undefined;
    },
  } as any;

  const mockSkillLoader = {
    get(name: string) {
      if (name === 'model-skill') {
        return {
          manifest: { name: 'model-skill', description: 'Model skill', version: '1.0.0', skillPath: '', rootDir: '' },
          instructions: 'Model skill instructions here',
          tools: [],
          hookBindings: [],
        } as LoadedSkill;
      }
      return undefined;
    },
  } as any;

  const dispatchCtx: DispatchContext = {
    toolRegistry: mockToolRegistry,
    skillLoader: mockSkillLoader,
    toolContext: {
      sessionId: 'test',
      workDir: '/tmp',
      workspaceRoot: '/tmp',
    },
  };

  it('returns not-found for unknown commands', async () => {
    const specs: SkillCommandSpec[] = [];
    const result = await dispatchSkillCommand(
      { command: 'unknown', args: '', raw: '/unknown' },
      specs,
      dispatchCtx,
    );
    assert.equal(result.kind, 'not-found');
  });

  it('dispatches tool commands directly', async () => {
    const specs: SkillCommandSpec[] = [
      {
        name: 'tool_cmd',
        skillName: 'tool-cmd',
        description: 'Tool command',
        dispatch: { kind: 'tool', toolName: 'mock_tool', argMode: 'raw' },
      },
    ];
    const result = await dispatchSkillCommand(
      { command: 'tool_cmd', args: 'hello', raw: '/tool_cmd hello' },
      specs,
      dispatchCtx,
    );
    assert.equal(result.kind, 'tool-result');
    assert.equal(result.response, 'mock result: hello');
  });

  it('returns skill-inject for model-dispatch commands', async () => {
    const specs: SkillCommandSpec[] = [
      {
        name: 'model_skill',
        skillName: 'model-skill',
        description: 'Model skill',
      },
    ];
    const result = await dispatchSkillCommand(
      { command: 'model_skill', args: 'do something', raw: '/model_skill do something' },
      specs,
      dispatchCtx,
    );
    assert.equal(result.kind, 'skill-inject');
    assert.equal(result.skillName, 'model-skill');
    assert.ok(result.instructions?.includes('Model skill instructions'));
    assert.equal(result.forwardMessage, 'do something');
  });

  it('handles /skill <name> generic runner', async () => {
    const specs: SkillCommandSpec[] = [
      {
        name: 'model_skill',
        skillName: 'model-skill',
        description: 'Model skill',
      },
    ];
    const result = await dispatchSkillCommand(
      { command: 'skill', args: 'model-skill some input', raw: '/skill model-skill some input' },
      specs,
      dispatchCtx,
    );
    assert.equal(result.kind, 'skill-inject');
    assert.equal(result.skillName, 'model-skill');
    assert.equal(result.forwardMessage, 'some input');
  });

  it('returns error for tool dispatch with missing tool', async () => {
    const specs: SkillCommandSpec[] = [
      {
        name: 'bad_tool',
        skillName: 'bad-tool',
        description: 'Bad tool',
        dispatch: { kind: 'tool', toolName: 'nonexistent', argMode: 'raw' },
      },
    ];
    const result = await dispatchSkillCommand(
      { command: 'bad_tool', args: '', raw: '/bad_tool' },
      specs,
      dispatchCtx,
    );
    assert.equal(result.kind, 'tool-result');
    assert.ok(result.response?.includes('not found'));
  });
});
