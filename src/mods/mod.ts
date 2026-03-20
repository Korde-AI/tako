/**
 * Tako Mod System — shareable agent configurations.
 *
 * A mod is a portable package containing everything needed to turn Tako
 * into a specific agent: identity, skills, workspace templates, and config.
 *
 * Design principles:
 *   - Mods never touch the main workspace (<home>/workspace)
 *   - Each mod gets its own workspace (<home>/mods/<name>/workspace)
 *   - Channel tokens are NEVER included in mods (user provides their own)
 *   - Mods can be shared as directories, tarballs, or git repos
 *
 * Mod structure:
 *   mod.json          — manifest (name, version, author, description)
 *   workspace/        — workspace template (AGENTS.md, SOUL.md, IDENTITY.md, etc.)
 *   skills/           — bundled skills
 *   config.json       — config overrides (provider, tools, agent settings — NO secrets)
 *
 * <home>/mods/
 *   active            — file containing the currently active mod name (or "main")
 *   <mod-name>/
 *     mod.json
 *     workspace/
 *     skills/
 *     config.json
 */

import { readFile, writeFile, mkdir, readdir, cp, access, rm } from 'node:fs/promises';
import { join, basename } from 'node:path';
import { getRuntimeHome } from '../core/paths.js';

function modsDir(): string {
  return join(getRuntimeHome(), 'mods');
}

function activeFile(): string {
  return join(modsDir(), 'active');
}

// ─── Types ──────────────────────────────────────────────────────────

export interface ModManifest {
  name: string;
  version: string;
  author?: string;
  description: string;
  /** URL or repo where the mod can be found. */
  source?: string;
  /** Required skills (informational). */
  skills?: string[];
  /** Tags for discovery. */
  tags?: string[];
}

export interface ModConfig {
  /** Provider override (e.g. "anthropic/claude-opus-4-6"). */
  provider?: string;
  /** Tool profile override. */
  toolProfile?: string;
  /** Agent config overrides. */
  agent?: {
    timeout?: number;
    thinking?: string;
  };
  /** Additional skill directories (relative to mod root). */
  skillDirs?: string[];
}

export interface ModInfo {
  name: string;
  manifest: ModManifest;
  config: ModConfig;
  path: string;
  isActive: boolean;
}

// ─── Manager ────────────────────────────────────────────────────────

export class ModManager {
  /** List all installed mods. */
  async list(): Promise<ModInfo[]> {
    const root = modsDir();
    await mkdir(root, { recursive: true });
    const active = await this.getActive();
    const entries = await readdir(root, { withFileTypes: true });
    const mods: ModInfo[] = [];

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const modPath = join(root, entry.name);
      const manifest = await this.readManifest(modPath);
      if (!manifest) continue;

      const config = await this.readConfig(modPath);
      mods.push({
        name: entry.name,
        manifest,
        config,
        path: modPath,
        isActive: entry.name === active,
      });
    }
    return mods;
  }

  /** Get the currently active mod name. "main" = default (no mod). */
  async getActive(): Promise<string> {
    try {
      const content = await readFile(activeFile(), 'utf-8');
      return content.trim() || 'main';
    } catch {
      return 'main';
    }
  }

  /** Switch to a mod (or "main" to deactivate mods). */
  async use(name: string): Promise<{ success: boolean; message: string }> {
    const root = modsDir();
    await mkdir(root, { recursive: true });

    if (name === 'main') {
      await writeFile(activeFile(), 'main');
      return {
        success: true,
        message: 'Switched to main workspace. Restart Tako to apply.',
      };
    }

    const modPath = join(root, name);
    const manifest = await this.readManifest(modPath);
    if (!manifest) {
      return { success: false, message: `Mod "${name}" not found. Run \`tako mod list\` to see installed mods.` };
    }

    // Ensure mod workspace exists (copy template if first time)
    const modWorkspace = join(modPath, 'workspace');
    try {
      await access(modWorkspace);
    } catch {
      // No workspace yet — create from template or empty
      await mkdir(modWorkspace, { recursive: true });
    }

    await writeFile(activeFile(), name);
    return {
      success: true,
      message: [
        `Switched to mod: ${manifest.name} v${manifest.version}`,
        manifest.description ? `  ${manifest.description}` : '',
        '',
        '⚠️  Restart Tako to apply the mod.',
        '⚠️  If the mod uses different channels (Discord/Telegram),',
        '   you\'ll need to provide your own bot tokens via `tako onboard`.',
        '',
        `Workspace: ${modWorkspace}`,
      ].filter(Boolean).join('\n'),
    };
  }

  /** Install a mod from a local directory. */
  async install(sourcePath: string): Promise<{ success: boolean; message: string }> {
    const manifest = await this.readManifest(sourcePath);
    if (!manifest) {
      return { success: false, message: `No valid mod.json found at ${sourcePath}` };
    }

    const destPath = join(modsDir(), manifest.name);
    await mkdir(destPath, { recursive: true });

    // Copy mod contents
    await cp(sourcePath, destPath, { recursive: true });

    return {
      success: true,
      message: [
        `Installed mod: ${manifest.name} v${manifest.version}`,
        manifest.description ? `  ${manifest.description}` : '',
        manifest.author ? `  by ${manifest.author}` : '',
        '',
        `Use \`tako mod use ${manifest.name}\` to activate.`,
      ].filter(Boolean).join('\n'),
    };
  }

  /** Install a mod from a git repo URL. */
  async installFromGit(url: string): Promise<{ success: boolean; message: string }> {
    const { execSync } = await import('node:child_process');
    const tmpDir = join(modsDir(), '.tmp-' + Date.now());

    try {
      await mkdir(tmpDir, { recursive: true });
      execSync(`git clone --depth 1 ${url} ${tmpDir}`, { stdio: 'pipe' });
      const result = await this.install(tmpDir);
      await rm(tmpDir, { recursive: true, force: true });
      return result;
    } catch (err) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      return { success: false, message: `Git clone failed: ${err instanceof Error ? err.message : err}` };
    }
  }

  /** Remove an installed mod. */
  async remove(name: string): Promise<{ success: boolean; message: string }> {
    if (name === 'main') {
      return { success: false, message: 'Cannot remove the main workspace.' };
    }

    const active = await this.getActive();
    if (active === name) {
      await writeFile(activeFile(), 'main');
    }

    const modPath = join(modsDir(), name);
    try {
      await rm(modPath, { recursive: true, force: true });
      return { success: true, message: `Mod "${name}" removed.${active === name ? ' Switched back to main.' : ''}` };
    } catch {
      return { success: false, message: `Mod "${name}" not found.` };
    }
  }

  /** Create a new mod from the current workspace (export). */
  async create(name: string, description: string, author?: string): Promise<{ success: boolean; message: string }> {
    const modPath = join(modsDir(), name);
    await mkdir(join(modPath, 'workspace'), { recursive: true });
    await mkdir(join(modPath, 'skills'), { recursive: true });

    const manifest: ModManifest = {
      name,
      version: '0.1.0',
      description,
      author,
      tags: [],
    };

    await writeFile(join(modPath, 'mod.json'), JSON.stringify(manifest, null, 2));
    await writeFile(join(modPath, 'config.json'), JSON.stringify({} as ModConfig, null, 2));

    return {
      success: true,
      message: [
        `Created mod: ${name}`,
        `  Path: ${modPath}`,
        '',
        'Next steps:',
        `  1. Add workspace files to ${join(modPath, 'workspace')}/ (SOUL.md, AGENTS.md, etc.)`,
        `  2. Add skills to ${join(modPath, 'skills')}/`,
        `  3. Edit ${join(modPath, 'config.json')} for provider/tool overrides`,
        `  4. \`tako mod use ${name}\` to test`,
        `  5. Share the folder or push to git`,
      ].join('\n'),
    };
  }

  /** Get the active mod's workspace path. Returns null if on main. */
  async getActiveWorkspace(): Promise<string | null> {
    const active = await this.getActive();
    if (active === 'main') return null;
    return join(modsDir(), active, 'workspace');
  }

  /** Get the active mod's config overrides. Returns null if on main. */
  async getActiveConfig(): Promise<ModConfig | null> {
    const active = await this.getActive();
    if (active === 'main') return null;
    return this.readConfig(join(modsDir(), active));
  }

  /** Get the active mod's skill directories. */
  async getActiveSkillDirs(): Promise<string[]> {
    const active = await this.getActive();
    if (active === 'main') return [];
    const modPath = join(modsDir(), active);
    const config = await this.readConfig(modPath);
    const dirs = [join(modPath, 'skills')];
    if (config.skillDirs) {
      dirs.push(...config.skillDirs.map((d) => join(modPath, d)));
    }
    return dirs;
  }

  // ─── Helpers ────────────────────────────────────────────────────

  private async readManifest(modPath: string): Promise<ModManifest | null> {
    try {
      const data = await readFile(join(modPath, 'mod.json'), 'utf-8');
      return JSON.parse(data) as ModManifest;
    } catch {
      return null;
    }
  }

  private async readConfig(modPath: string): Promise<ModConfig> {
    try {
      const data = await readFile(join(modPath, 'config.json'), 'utf-8');
      return JSON.parse(data) as ModConfig;
    } catch {
      return {};
    }
  }
}

/** Get the mods directory path. */
export function getModsDir(): string {
  return modsDir();
}
