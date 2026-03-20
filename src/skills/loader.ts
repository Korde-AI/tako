/**
 * Skill loader — discovers, parses, loads, and hot-reloads skill arms.
 *
 * Skills are directories containing a SKILL.md file with YAML frontmatter.
 * The loader scans configured skill directories, parses frontmatter for
 * metadata/triggers, loads tool definitions from tools/ subdirectories,
 * and supports hot-reload via fs.watch.
 */

import { readFile, readdir, stat } from 'node:fs/promises';
import { watch, type FSWatcher, existsSync } from 'node:fs';
import { join, basename } from 'node:path';
import type { SkillManifest, SkillTrigger, LoadedSkill, SkillRequirements } from './types.js';
import type { Tool } from '../tools/tool.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { HookSystem } from '../hooks/types.js';
import { detectExtensions } from './extension-loader.js';

/**
 * Parse YAML frontmatter from a SKILL.md file.
 * Supports the standard `---` delimited frontmatter block.
 * Returns { frontmatter, body } where body is everything after the closing `---`.
 */
function parseFrontmatter(content: string): { meta: Record<string, string>; body: string } {
  const meta: Record<string, string> = {};

  if (!content.startsWith('---')) {
    return { meta, body: content };
  }

  const endIdx = content.indexOf('\n---', 3);
  if (endIdx === -1) {
    return { meta, body: content };
  }

  const frontmatterBlock = content.slice(4, endIdx);
  const body = content.slice(endIdx + 4).trimStart();

  // Parse simple YAML key: value pairs (single-line only, matching reference runtime)
  for (const line of frontmatterBlock.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const colonIdx = trimmed.indexOf(':');
    if (colonIdx === -1) continue;

    const key = trimmed.slice(0, colonIdx).trim();
    let value = trimmed.slice(colonIdx + 1).trim();

    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    meta[key] = value;
  }

  return { meta, body };
}

/**
 * Parse trigger definitions from frontmatter.
 * Supports comma-separated keywords or JSON array format.
 */
function parseTriggers(raw: string | undefined): SkillTrigger[] | undefined {
  if (!raw) return undefined;

  // "always" shorthand
  if (raw === 'always') return [{ type: 'always' }];
  if (raw === 'manual') return [{ type: 'manual' }];

  // Try JSON array: [{"type":"keyword","value":"foo"}]
  if (raw.startsWith('[')) {
    try {
      return JSON.parse(raw) as SkillTrigger[];
    } catch {
      // Fall through to keyword parsing
    }
  }

  // Comma-separated keywords
  return raw.split(',').map((kw) => ({
    type: 'keyword' as const,
    value: kw.trim(),
  }));
}

/**
 * Parse requirements from frontmatter.
 */
function parseRequirements(raw: string | undefined): SkillRequirements | undefined {
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as SkillRequirements;
  } catch {
    return undefined;
  }
}

/**
 * Parse a comma-separated list from frontmatter.
 */
function parseList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  if (raw.startsWith('[')) {
    try {
      return JSON.parse(raw) as string[];
    } catch {
      // Fall through
    }
  }
  return raw.split(',').map((s) => s.trim()).filter(Boolean);
}

export class SkillLoader {
  private skillDirs: string[];
  private loadedSkills = new Map<string, LoadedSkill>();
  private watchers: FSWatcher[] = [];
  private onReload?: (skills: LoadedSkill[]) => void;

  constructor(skillDirs: string[]) {
    this.skillDirs = skillDirs;
  }

  /** Discover all skills in configured directories. */
  async discover(): Promise<SkillManifest[]> {
    const manifests: SkillManifest[] = [];

    for (const dir of this.skillDirs) {
      try {
        const entries = await readdir(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const skillDir = join(dir, entry.name);
          const skillMdPath = join(skillDir, 'SKILL.md');
          try {
            await stat(skillMdPath);
            const manifest = await this.parseManifest(entry.name, skillDir, skillMdPath);
            if (this.checkRequirements(manifest)) {
              manifests.push(manifest);
            }
          } catch {
            // No SKILL.md — skip
          }
        }
      } catch {
        // Directory not found — skip
      }
    }

    return manifests;
  }

  /** Parse a SKILL.md file into a manifest using YAML frontmatter. */
  private async parseManifest(
    dirName: string,
    rootDir: string,
    skillPath: string,
  ): Promise<SkillManifest> {
    const content = await readFile(skillPath, 'utf-8');
    const { meta } = parseFrontmatter(content);

    const name = meta['name'] ?? dirName;
    const description = meta['description']
      ?? content.split('\n').find((l) => l.startsWith('#'))?.replace(/^#+\s*/, '')
      ?? name;

    return {
      name,
      description,
      version: meta['version'] ?? '0.1.0',
      author: meta['author'],
      triggers: parseTriggers(meta['triggers']),
      tools: parseList(meta['tools']),
      hooks: parseList(meta['hooks']),
      userInvocable: meta['user-invocable'] !== 'false',
      disableModelInvocation: meta['disable-model-invocation'] === 'true',
      requires: parseRequirements(meta['requires']),
      skillPath,
      rootDir,
    };
  }

  /** Check if a skill's platform requirements are met. */
  private checkRequirements(manifest: SkillManifest): boolean {
    const req = manifest.requires;
    if (!req) return true;

    // OS check
    if (req.os && !req.os.includes(process.platform)) {
      return false;
    }

    // Env var check
    if (req.env) {
      for (const envVar of req.env) {
        if (!process.env[envVar]) return false;
      }
    }

    return true;
  }

  /** Load a skill — read instructions, discover tools from tools/ dir. */
  async load(manifest: SkillManifest): Promise<LoadedSkill> {
    const content = await readFile(manifest.skillPath, 'utf-8');
    const { body } = parseFrontmatter(content);

    // Check for channel/ subdirectory (skill-loaded channel adapter)
    const channelDir = join(manifest.rootDir, 'channel');
    if (existsSync(channelDir)) {
      manifest.hasChannel = true;
      manifest.channelDir = channelDir;
    }

    // Detect extension subsystems (channel, provider, memory, network, sandbox, auth)
    manifest.extensions = detectExtensions(manifest.rootDir);

    // Load tools from the skill's tools/ directory if it exists
    const tools = await this.loadSkillTools(manifest);

    const loaded: LoadedSkill = {
      manifest,
      instructions: body,
      tools,
      hookBindings: [],
    };

    this.loadedSkills.set(manifest.name, loaded);
    return loaded;
  }

  /** Load tool definitions from a skill's tools/ directory. */
  private async loadSkillTools(manifest: SkillManifest): Promise<Tool[]> {
    const toolsDir = join(manifest.rootDir, 'tools');
    try {
      await stat(toolsDir);
    } catch {
      return []; // No tools/ directory
    }

    const tools: Tool[] = [];
    try {
      const entries = await readdir(toolsDir);
      for (const entry of entries) {
        if (!entry.endsWith('.js') && !entry.endsWith('.mjs')) continue;
        try {
          const toolPath = join(toolsDir, entry);
          const mod = await import(toolPath);
          // Support both default export (single tool) and named exports (array)
          if (mod.default) {
            if (Array.isArray(mod.default)) {
              tools.push(...mod.default);
            } else {
              tools.push(mod.default);
            }
          }
          if (mod.tools && Array.isArray(mod.tools)) {
            tools.push(...mod.tools);
          }
        } catch {
          // Skip tools that fail to load
        }
      }
    } catch {
      // Skip on error
    }

    return tools;
  }

  /**
   * Register a loaded skill's tools with the tool registry.
   * Tools from skills are ungrouped (always active regardless of profile).
   */
  registerTools(loaded: LoadedSkill, registry: ToolRegistry): void {
    for (const tool of loaded.tools) {
      registry.register(tool);
    }
  }

  /**
   * Register a loaded skill's hook bindings with the hook system.
   */
  registerHooks(loaded: LoadedSkill, hooks: HookSystem): void {
    for (const binding of loaded.hookBindings) {
      hooks.on(binding.event, binding.handler);
    }
  }

  /**
   * Check if a skill's triggers match the given message.
   * Returns true if the skill should be active for this message.
   */
  matchesTrigger(skill: LoadedSkill, message: string): boolean {
    const triggers = skill.manifest.triggers;

    // No triggers = always active (backward compat)
    if (!triggers || triggers.length === 0) return true;

    const lowerMsg = message.toLowerCase();

    for (const trigger of triggers) {
      switch (trigger.type) {
        case 'always':
          return true;

        case 'manual':
          // Manual skills only activate via explicit /skill invocation
          return false;

        case 'keyword':
          if (trigger.value && lowerMsg.includes(trigger.value.toLowerCase())) {
            return true;
          }
          break;

        case 'pattern':
          if (trigger.value) {
            try {
              const regex = new RegExp(trigger.value, 'i');
              if (regex.test(message)) return true;
            } catch {
              // Invalid regex — skip
            }
          }
          break;
      }
    }

    return false;
  }

  /**
   * Get skills whose triggers match the given message.
   * Used for dynamic skill injection during the agent loop.
   */
  getMatchingSkills(message: string): LoadedSkill[] {
    return this.getAll().filter((skill) => {
      // Skip skills that opt out of model invocation
      if (skill.manifest.disableModelInvocation) return false;
      return this.matchesTrigger(skill, message);
    });
  }

  /** Get a loaded skill by name. */
  get(name: string): LoadedSkill | undefined {
    return this.loadedSkills.get(name);
  }

  /** Get all loaded skills. */
  getAll(): LoadedSkill[] {
    return Array.from(this.loadedSkills.values());
  }

  /**
   * Start watching skill directories for changes.
   * On change, re-discovers and re-loads all skills, then calls the callback.
   */
  startWatching(onReload: (skills: LoadedSkill[]) => void): void {
    this.onReload = onReload;

    for (const dir of this.skillDirs) {
      try {
        const watcher = watch(dir, { recursive: true }, (_eventType, filename) => {
          if (filename && (filename.endsWith('SKILL.md') || filename.endsWith('.js') || filename.endsWith('.mjs'))) {
            this.handleFileChange();
          }
        });
        this.watchers.push(watcher);
      } catch {
        // Directory may not exist yet — that's fine
      }
    }
  }

  /** Debounced reload on file change. */
  private reloadTimer: ReturnType<typeof setTimeout> | null = null;
  private handleFileChange(): void {
    if (this.reloadTimer) clearTimeout(this.reloadTimer);
    this.reloadTimer = setTimeout(async () => {
      try {
        await this.reloadAll();
        if (this.onReload) {
          this.onReload(this.getAll());
        }
      } catch {
        // Reload failed — keep existing skills
      }
    }, 250);
  }

  /** Reload all skills from disk. */
  async reloadAll(): Promise<LoadedSkill[]> {
    this.loadedSkills.clear();
    const manifests = await this.discover();
    const loaded: LoadedSkill[] = [];
    for (const manifest of manifests) {
      loaded.push(await this.load(manifest));
    }
    return loaded;
  }

  /** Stop watching and clean up. */
  stopWatching(): void {
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
    if (this.reloadTimer) {
      clearTimeout(this.reloadTimer);
      this.reloadTimer = null;
    }
  }
}
