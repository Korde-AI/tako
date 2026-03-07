/**
 * Tests for the unified SkillExtensions system:
 * - Extension detection from skill directories
 * - Extension loading with factory modules
 * - ExtensionRegistry register/unregister/get/list
 * - getSkillsWithExtension filtering
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { detectExtensions } from '../src/skills/extension-loader.js';
import { getSkillsWithExtension } from '../src/skills/extension-loader.js';
import { ExtensionRegistry } from '../src/skills/extension-registry.js';
import { EXTENSION_DIRS } from '../src/skills/extensions.js';
import type { LoadedSkill } from '../src/skills/types.js';

// ─── detectExtensions ───────────────────────────────────────────────

describe('detectExtensions', () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'tako-ext-'));

    // Skill with channel/ and provider/ subdirectories
    await mkdir(join(tmpDir, 'channel'), { recursive: true });
    await writeFile(join(tmpDir, 'channel', 'index.ts'), 'export function createChannel() {}');

    await mkdir(join(tmpDir, 'provider'), { recursive: true });
    await writeFile(join(tmpDir, 'provider', 'index.js'), 'export function createProvider() {}');

    // memory/ dir with type-named entry
    await mkdir(join(tmpDir, 'memory'), { recursive: true });
    await writeFile(join(tmpDir, 'memory', 'memory.ts'), 'export function createMemory() {}');

    // network/ dir with no entry point (should be skipped)
    await mkdir(join(tmpDir, 'network'), { recursive: true });

    // A non-extension directory (should be ignored)
    await mkdir(join(tmpDir, 'tools'), { recursive: true });
    await writeFile(join(tmpDir, 'tools', 'index.ts'), 'export default {}');
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('detects channel, provider, and memory extensions', () => {
    const exts = detectExtensions(tmpDir);

    assert.ok(exts.channel, 'should detect channel/');
    assert.equal(exts.channel!.dir, join(tmpDir, 'channel'));
    assert.equal(exts.channel!.entry, join(tmpDir, 'channel', 'index.ts'));

    assert.ok(exts.provider, 'should detect provider/');
    assert.equal(exts.provider!.dir, join(tmpDir, 'provider'));
    assert.equal(exts.provider!.entry, join(tmpDir, 'provider', 'index.js'));

    assert.ok(exts.memory, 'should detect memory/');
    assert.equal(exts.memory!.entry, join(tmpDir, 'memory', 'memory.ts'));
  });

  it('skips directories without entry points', () => {
    const exts = detectExtensions(tmpDir);
    assert.equal(exts.network, undefined, 'network/ has no entry point');
  });

  it('ignores non-extension directories', () => {
    const exts = detectExtensions(tmpDir);
    assert.equal((exts as any).tools, undefined);
  });

  it('returns empty for directory with no extensions', async () => {
    const emptyDir = await mkdtemp(join(tmpdir(), 'tako-ext-empty-'));
    const exts = detectExtensions(emptyDir);
    for (const type of EXTENSION_DIRS) {
      assert.equal(exts[type], undefined);
    }
    await rm(emptyDir, { recursive: true, force: true });
  });
});

// ─── ExtensionRegistry ──────────────────────────────────────────────

describe('ExtensionRegistry', () => {
  it('registers and retrieves extensions', () => {
    const registry = new ExtensionRegistry();
    const mockProvider = { id: 'mock-provider' };

    registry.register('provider', 'my-skill', mockProvider);

    assert.ok(registry.has('provider'));
    assert.equal(registry.has('channel'), false);

    const result = registry.get<typeof mockProvider>('provider', 'my-skill');
    assert.equal(result?.id, 'mock-provider');
  });

  it('returns all extensions of a type', () => {
    const registry = new ExtensionRegistry();
    registry.register('provider', 'skill-a', { id: 'a' });
    registry.register('provider', 'skill-b', { id: 'b' });

    const all = registry.getAll<{ id: string }>('provider');
    assert.equal(all.length, 2);
    assert.equal(all[0].skillName, 'skill-a');
    assert.equal(all[1].skillName, 'skill-b');
  });

  it('unregisters all extensions from a skill', () => {
    const registry = new ExtensionRegistry();
    registry.register('provider', 'my-skill', { id: 'p' });
    registry.register('channel', 'my-skill', { id: 'c' });
    registry.register('provider', 'other-skill', { id: 'o' });

    registry.unregister('my-skill');

    assert.equal(registry.get('provider', 'my-skill'), undefined);
    assert.equal(registry.get('channel', 'my-skill'), undefined);
    assert.ok(registry.get('provider', 'other-skill'));
  });

  it('lists all registered extensions', () => {
    const registry = new ExtensionRegistry();
    registry.register('provider', 'skill-a', {});
    registry.register('memory', 'skill-b', {});

    const list = registry.list();
    assert.equal(list.length, 2);
    assert.ok(list.find((e) => e.type === 'provider' && e.skillName === 'skill-a'));
    assert.ok(list.find((e) => e.type === 'memory' && e.skillName === 'skill-b'));
  });

  it('clears all extensions', () => {
    const registry = new ExtensionRegistry();
    registry.register('provider', 'skill-a', {});
    registry.register('channel', 'skill-b', {});

    registry.clear();

    assert.equal(registry.has('provider'), false);
    assert.equal(registry.has('channel'), false);
    assert.equal(registry.list().length, 0);
  });

  it('returns undefined for unknown skill', () => {
    const registry = new ExtensionRegistry();
    assert.equal(registry.get('provider', 'nonexistent'), undefined);
  });
});

// ─── getSkillsWithExtension ─────────────────────────────────────────

describe('getSkillsWithExtension', () => {
  function makeSkill(name: string, extensions?: any): LoadedSkill {
    return {
      manifest: {
        name,
        description: name,
        version: '0.1.0',
        skillPath: `/tmp/${name}/SKILL.md`,
        rootDir: `/tmp/${name}`,
        extensions,
      },
      instructions: '',
      tools: [],
      hookBindings: [],
    };
  }

  it('filters skills by extension type', () => {
    const skills = [
      makeSkill('has-provider', { provider: { dir: '/p', entry: '/p/index.ts' } }),
      makeSkill('has-channel', { channel: { dir: '/c', entry: '/c/index.ts' } }),
      makeSkill('no-extensions'),
    ];

    const providers = getSkillsWithExtension(skills, 'provider');
    assert.equal(providers.length, 1);
    assert.equal(providers[0].manifest.name, 'has-provider');

    const channels = getSkillsWithExtension(skills, 'channel');
    assert.equal(channels.length, 1);
    assert.equal(channels[0].manifest.name, 'has-channel');

    const memory = getSkillsWithExtension(skills, 'memory');
    assert.equal(memory.length, 0);
  });
});
