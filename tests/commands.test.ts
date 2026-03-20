/**
 * Tests for the skill→command system:
 * - Command parser (valid commands, non-commands, edge cases)
 * - Name sanitization and deduplication
 * - Registry lookup and skill command building
 * - Skill injection routing
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseCommand } from '../src/commands/parser.js';
import { CommandRegistry } from '../src/commands/registry.js';
import { sanitizeCommandName, buildSkillCommands, type SkillCommandSpec } from '../src/commands/skill-commands.js';
import { dispatchSkillCommand, type DispatchContext } from '../src/commands/dispatch.js';
import type { LoadedSkill, SkillManifest } from '../src/skills/types.js';

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

  it('builds command specs without direct dispatch metadata', () => {
    const skills = [makeLoadedSkill({ name: 'model-skill' })];
    const specs = buildSkillCommands(skills);
    assert.deepEqual(specs[0], {
      name: 'model_skill',
      skillName: 'model-skill',
      description: 'Test skill',
    });
  });
});

// ─── Dispatch routing ───────────────────────────────────────────────

describe('dispatchSkillCommand', () => {
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
    skillLoader: mockSkillLoader,
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

  it('returns skill-inject for matching commands', async () => {
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

  it('returns not-found when the named skill is unavailable', async () => {
    const specs: SkillCommandSpec[] = [
      {
        name: 'bad_tool',
        skillName: 'bad-tool',
        description: 'Bad tool',
      },
    ];
    const result = await dispatchSkillCommand(
      { command: 'bad_tool', args: '', raw: '/bad_tool' },
      specs,
      dispatchCtx,
    );
    assert.equal(result.kind, 'not-found');
  });
});

describe('CommandRegistry shared readonly mode', () => {
  function makeRegistry(): CommandRegistry {
    return new CommandRegistry({
      getModel: () => 'anthropic/test',
      setModel: () => {},
      listAgents: () => [{ id: 'main' }],
      compactSession: async () => {},
      estimateTokens: () => 0,
      startTime: Date.now(),
      getToolCount: () => 0,
      getSkillCount: () => 0,
    });
  }

  function makeCtx() {
    return {
      channelId: 'discord:123',
      authorId: 'u1',
      authorName: 'User',
      session: { id: 's1', messages: [], metadata: {} } as any,
      agentId: 'main',
      executionContext: {
        metadata: {
          agentAccessMode: 'shared_readonly',
        },
      } as any,
    };
  }

  it('allows safe inspection commands in shared readonly mode', async () => {
    const registry = makeRegistry();
    const result = await registry.handle('/status', makeCtx() as any);
    assert.ok(result);
    assert.match(result!, /Tako Status/);
  });

  it('blocks mutating commands in shared readonly mode', async () => {
    const registry = makeRegistry();
    const result = await registry.handle('/new', makeCtx() as any);
    assert.match(result ?? '', /shared-readonly mode/i);
  });
});
