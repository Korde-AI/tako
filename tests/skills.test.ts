/**
 * Tests for the skill system:
 * - Frontmatter parsing
 * - Skill discovery and loading
 * - Trigger matching
 * - Tool registration from skills
 * - Built-in skills verification
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SkillLoader } from '../src/skills/loader.js';
import { ToolRegistry } from '../src/tools/registry.js';

// ─── Frontmatter parsing & discovery ─────────────────────────────────

describe('SkillLoader', () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'tako-skills-'));

    // Create a skill with full frontmatter
    await mkdir(join(tmpDir, 'test-skill'), { recursive: true });
    await writeFile(join(tmpDir, 'test-skill', 'SKILL.md'), `---
name: test-skill
description: A test skill for unit testing
version: 1.2.3
author: Tako Tests
triggers: keyword1, keyword2
---

# Test Skill

These are the skill instructions.

Use this skill when the user asks about testing.
`);

    // Create a skill with no frontmatter
    await mkdir(join(tmpDir, 'bare-skill'), { recursive: true });
    await writeFile(join(tmpDir, 'bare-skill', 'SKILL.md'), `# Bare Skill

Just instructions, no frontmatter.
`);

    // Create a skill with JSON triggers
    await mkdir(join(tmpDir, 'pattern-skill'), { recursive: true });
    await writeFile(join(tmpDir, 'pattern-skill', 'SKILL.md'), `---
name: pattern-skill
description: Skill with pattern trigger
triggers: [{"type":"pattern","value":"\\\\b(deploy|ship)\\\\b"}]
---

# Pattern Skill

Deploy instructions.
`);

    // Create a manual-only skill
    await mkdir(join(tmpDir, 'manual-skill'), { recursive: true });
    await writeFile(join(tmpDir, 'manual-skill', 'SKILL.md'), `---
name: manual-skill
description: Only activated manually
triggers: manual
---

# Manual Skill

Manual activation only.
`);

    // Create a directory without SKILL.md (should be skipped)
    await mkdir(join(tmpDir, 'not-a-skill'), { recursive: true });
    await writeFile(join(tmpDir, 'not-a-skill', 'README.md'), 'Not a skill');
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('discovers skills with SKILL.md files', async () => {
    const loader = new SkillLoader([tmpDir]);
    const manifests = await loader.discover();
    const names = manifests.map((m) => m.name).sort();
    assert.deepEqual(names, ['bare-skill', 'manual-skill', 'pattern-skill', 'test-skill']);
  });

  it('skips directories without SKILL.md', async () => {
    const loader = new SkillLoader([tmpDir]);
    const manifests = await loader.discover();
    const names = manifests.map((m) => m.name);
    assert.ok(!names.includes('not-a-skill'));
  });

  it('parses YAML frontmatter correctly', async () => {
    const loader = new SkillLoader([tmpDir]);
    const manifests = await loader.discover();
    const testSkill = manifests.find((m) => m.name === 'test-skill')!;

    assert.equal(testSkill.name, 'test-skill');
    assert.equal(testSkill.description, 'A test skill for unit testing');
    assert.equal(testSkill.version, '1.2.3');
    assert.equal(testSkill.author, 'Tako Tests');
    assert.ok(testSkill.triggers);
    assert.equal(testSkill.triggers!.length, 2);
    assert.equal(testSkill.triggers![0].type, 'keyword');
    assert.equal(testSkill.triggers![0].value, 'keyword1');
  });

  it('handles missing frontmatter gracefully', async () => {
    const loader = new SkillLoader([tmpDir]);
    const manifests = await loader.discover();
    const bareSkill = manifests.find((m) => m.name === 'bare-skill')!;

    assert.equal(bareSkill.name, 'bare-skill');
    assert.equal(bareSkill.description, 'Bare Skill');
    assert.equal(bareSkill.version, '0.1.0');
  });

  it('loads skill instructions (body without frontmatter)', async () => {
    const loader = new SkillLoader([tmpDir]);
    const manifests = await loader.discover();
    const manifest = manifests.find((m) => m.name === 'test-skill')!;
    const loaded = await loader.load(manifest);

    assert.ok(loaded.instructions.includes('# Test Skill'));
    assert.ok(loaded.instructions.includes('These are the skill instructions'));
    // Frontmatter should NOT be in instructions
    assert.ok(!loaded.instructions.includes('version: 1.2.3'));
  });

  it('handles nonexistent skill directories gracefully', async () => {
    const loader = new SkillLoader(['/tmp/nonexistent-dir-12345']);
    const manifests = await loader.discover();
    assert.equal(manifests.length, 0);
  });
});

// ─── Trigger matching ────────────────────────────────────────────────

describe('SkillLoader trigger matching', () => {
  let tmpDir: string;
  let loader: SkillLoader;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'tako-triggers-'));

    await mkdir(join(tmpDir, 'always-skill'), { recursive: true });
    await writeFile(join(tmpDir, 'always-skill', 'SKILL.md'), `---
name: always-skill
description: Always active
triggers: always
---

Always active skill.
`);

    await mkdir(join(tmpDir, 'keyword-skill'), { recursive: true });
    await writeFile(join(tmpDir, 'keyword-skill', 'SKILL.md'), `---
name: keyword-skill
description: Keyword triggered
triggers: deploy, ship it
---

Deploy skill.
`);

    await mkdir(join(tmpDir, 'manual-skill'), { recursive: true });
    await writeFile(join(tmpDir, 'manual-skill', 'SKILL.md'), `---
name: manual-skill
description: Manual only
triggers: manual
---

Manual skill.
`);

    await mkdir(join(tmpDir, 'no-trigger-skill'), { recursive: true });
    await writeFile(join(tmpDir, 'no-trigger-skill', 'SKILL.md'), `---
name: no-trigger-skill
description: No triggers defined
---

No trigger skill (always active by default).
`);

    loader = new SkillLoader([tmpDir]);
    const manifests = await loader.discover();
    for (const m of manifests) {
      await loader.load(m);
    }
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('always-trigger matches any message', () => {
    const skill = loader.get('always-skill')!;
    assert.ok(loader.matchesTrigger(skill, 'hello world'));
    assert.ok(loader.matchesTrigger(skill, 'anything'));
  });

  it('keyword trigger matches when keyword present', () => {
    const skill = loader.get('keyword-skill')!;
    assert.ok(loader.matchesTrigger(skill, 'please deploy the app'));
    assert.ok(loader.matchesTrigger(skill, 'ship it now'));
  });

  it('keyword trigger does not match unrelated messages', () => {
    const skill = loader.get('keyword-skill')!;
    assert.ok(!loader.matchesTrigger(skill, 'hello world'));
  });

  it('manual trigger does not match any message', () => {
    const skill = loader.get('manual-skill')!;
    assert.ok(!loader.matchesTrigger(skill, 'deploy'));
    assert.ok(!loader.matchesTrigger(skill, 'manual'));
  });

  it('no triggers means always active', () => {
    const skill = loader.get('no-trigger-skill')!;
    assert.ok(loader.matchesTrigger(skill, 'anything'));
  });

  it('getMatchingSkills returns correct set', () => {
    const matching = loader.getMatchingSkills('deploy the app');
    const names = matching.map((s) => s.manifest.name).sort();
    assert.ok(names.includes('always-skill'));
    assert.ok(names.includes('keyword-skill'));
    assert.ok(names.includes('no-trigger-skill'));
    assert.ok(!names.includes('manual-skill'));
  });
});

// ─── Tool registration from skills ──────────────────────────────────

describe('Skill tool registration', () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'tako-skill-tools-'));
    await mkdir(join(tmpDir, 'tool-skill'), { recursive: true });
    await writeFile(join(tmpDir, 'tool-skill', 'SKILL.md'), `---
name: tool-skill
description: Skill with tools
---

Skill with custom tools.
`);
    // No tools/ directory — skill should load with empty tools
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('loads skill with no tools directory', async () => {
    const loader = new SkillLoader([tmpDir]);
    const manifests = await loader.discover();
    const loaded = await loader.load(manifests[0]);
    assert.equal(loaded.tools.length, 0);
  });

  it('registers skill tools with registry', async () => {
    const loader = new SkillLoader([tmpDir]);
    const manifests = await loader.discover();
    const loaded = await loader.load(manifests[0]);

    const registry = new ToolRegistry();
    loader.registerTools(loaded, registry);
    // No tools to register, but should not throw
    assert.equal(registry.getActiveTools().length, 0);
  });
});

// ─── Built-in skills verification ───────────────────────────────────

describe('Built-in skills', () => {
  it('discovers find-skills and skill-creator from ./skills/', async () => {
    const loader = new SkillLoader([join(process.cwd(), 'skills')]);
    const manifests = await loader.discover();
    const names = manifests.map((m) => m.name).sort();
    assert.ok(names.includes('find-skills'), `Expected find-skills in ${names}`);
    assert.ok(names.includes('skill-creator'), `Expected skill-creator in ${names}`);
  });

  it('parses find-skills frontmatter', async () => {
    const loader = new SkillLoader([join(process.cwd(), 'skills')]);
    const manifests = await loader.discover();
    const findSkills = manifests.find((m) => m.name === 'find-skills')!;

    assert.equal(findSkills.name, 'find-skills');
    assert.ok(findSkills.description.includes('discover'));
  });

  it('parses skill-creator frontmatter', async () => {
    const loader = new SkillLoader([join(process.cwd(), 'skills')]);
    const manifests = await loader.discover();
    const creator = manifests.find((m) => m.name === 'skill-creator')!;

    assert.equal(creator.name, 'skill-creator');
    assert.ok(creator.description.includes('skill'));
  });

  it('loads find-skills instructions (body only)', async () => {
    const loader = new SkillLoader([join(process.cwd(), 'skills')]);
    const manifests = await loader.discover();
    const manifest = manifests.find((m) => m.name === 'find-skills')!;
    const loaded = await loader.load(manifest);

    assert.ok(loaded.instructions.includes('# Find Skills'));
    assert.ok(loaded.instructions.includes('npx skills'));
    // Frontmatter should not be in body
    assert.ok(!loaded.instructions.includes('name: find-skills'));
  });

  it('loads skill-creator instructions', async () => {
    const loader = new SkillLoader([join(process.cwd(), 'skills')]);
    const manifests = await loader.discover();
    const manifest = manifests.find((m) => m.name === 'skill-creator')!;
    const loaded = await loader.load(manifest);

    assert.ok(loaded.instructions.includes('# Skill Creator'));
    assert.ok(loaded.instructions.length > 1000, 'skill-creator should have substantial instructions');
  });
});

// ─── Reload ─────────────────────────────────────────────────────────

describe('SkillLoader reloadAll', () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'tako-reload-'));
    await mkdir(join(tmpDir, 'skill-a'), { recursive: true });
    await writeFile(join(tmpDir, 'skill-a', 'SKILL.md'), `---
name: skill-a
description: Skill A
---

Instructions A.
`);
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('reloads all skills from disk', async () => {
    const loader = new SkillLoader([tmpDir]);
    await loader.discover().then((ms) => Promise.all(ms.map((m) => loader.load(m))));
    assert.equal(loader.getAll().length, 1);

    // Add a new skill
    await mkdir(join(tmpDir, 'skill-b'), { recursive: true });
    await writeFile(join(tmpDir, 'skill-b', 'SKILL.md'), `---
name: skill-b
description: Skill B
---

Instructions B.
`);

    const reloaded = await loader.reloadAll();
    assert.equal(reloaded.length, 2);
    const names = reloaded.map((s) => s.manifest.name).sort();
    assert.deepEqual(names, ['skill-a', 'skill-b']);
  });
});
