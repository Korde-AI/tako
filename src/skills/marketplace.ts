/**
 * Skill & Mod Marketplace — search, install, update, and remove skills from GitHub.
 *
 * Registry format: GitHub repos with the `tako-skill` topic and SKILL.md at root.
 * Install metadata stored in ~/.tako/installed-skills.json.
 */

import { exec as execCb } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, mkdir, rm, access } from 'node:fs/promises';
import { join, resolve, normalize } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';

const execAsync = promisify(execCb);

// ─── Types ──────────────────────────────────────────────────────────

export interface InstalledSkill {
  name: string;
  repo: string;
  installedAt: string;
  updatedAt: string;
  path: string;
  version?: string;
}

interface InstalledSkillsFile {
  version: number;
  skills: InstalledSkill[];
}

export interface SearchResult {
  fullName: string;
  description: string;
  stars: number;
  url: string;
  updatedAt: string;
}

// ─── Marketplace ────────────────────────────────────────────────────

export class SkillMarketplace {
  private installDir: string;
  private metadataPath: string;

  constructor(installDir?: string) {
    this.installDir = resolve(installDir ?? join(homedir(), '.tako', 'skills'));
    this.metadataPath = join(homedir(), '.tako', 'installed-skills.json');
  }

  /**
   * Validate that a resolved path is safely within the skills install directory.
   * Prevents path traversal attacks from skill names like "../../../etc".
   */
  private validateInstallPath(destPath: string): void {
    const resolved = resolve(destPath);
    const normalizedRoot = resolve(this.installDir);
    if (!resolved.startsWith(normalizedRoot + '/') && resolved !== normalizedRoot) {
      throw new Error(
        `Path traversal blocked: "${destPath}" resolves outside skills directory "${normalizedRoot}"`,
      );
    }
  }

  /**
   * Search GitHub for skills with the `tako-skill` topic.
   */
  async search(query: string): Promise<SearchResult[]> {
    try {
      const { stdout } = await execAsync(
        `gh search repos --topic tako-skill ${JSON.stringify(query)} --json fullName,description,stargazersCount,url,updatedAt --limit 20`,
        { timeout: 15000 },
      );
      const repos = JSON.parse(stdout) as Array<{
        fullName: string;
        description: string;
        stargazersCount: number;
        url: string;
        updatedAt: string;
      }>;

      return repos.map((r) => ({
        fullName: r.fullName,
        description: r.description ?? '',
        stars: r.stargazersCount,
        url: r.url,
        updatedAt: r.updatedAt,
      }));
    } catch (err) {
      throw new Error(
        `Search failed (ensure gh CLI is installed and authenticated): ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Install a skill from a GitHub repo (owner/repo format).
   */
  async install(repo: string): Promise<InstalledSkill> {
    // Check if already installed
    const existing = await this.getInstalled();
    if (existing.find((s) => s.repo === repo)) {
      throw new Error(`Skill ${repo} is already installed. Use 'update' to get the latest version.`);
    }

    const name = repo.split('/')[1] ?? repo;

    // Sanitize skill name — reject names with path traversal components
    if (name.includes('..') || name.includes('/') || name.includes('\\') || name.includes('\0')) {
      throw new Error(`Invalid skill name: "${name}" contains path traversal characters`);
    }

    const destPath = resolve(this.installDir, name);

    // Validate the destination path is within the skills directory
    this.validateInstallPath(destPath);

    // Clone the repo
    await mkdir(this.installDir, { recursive: true });
    try {
      await execAsync(`git clone --depth 1 https://github.com/${repo}.git ${JSON.stringify(destPath)}`, {
        timeout: 60000,
      });
    } catch (err) {
      throw new Error(`Failed to clone ${repo}: ${err instanceof Error ? err.message : String(err)}`);
    }

    // Verify SKILL.md exists
    const skillMdPath = join(destPath, 'SKILL.md');
    if (!existsSync(skillMdPath)) {
      // Clean up
      await rm(destPath, { recursive: true, force: true });
      throw new Error(`${repo} is not a valid Tako skill: SKILL.md not found at root`);
    }

    // Get version info
    let version: string | undefined;
    try {
      const { stdout } = await execAsync('git rev-parse --short HEAD', { cwd: destPath });
      version = stdout.trim();
    } catch {
      // no version info
    }

    const skill: InstalledSkill = {
      name,
      repo,
      installedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      path: destPath,
      version,
    };

    // Save metadata
    const installed = await this.getInstalled();
    installed.push(skill);
    await this.saveInstalled(installed);

    return skill;
  }

  /**
   * Update an installed skill (git pull).
   */
  async update(name?: string): Promise<InstalledSkill[]> {
    const installed = await this.getInstalled();
    const toUpdate = name
      ? installed.filter((s) => s.name === name)
      : installed;

    if (toUpdate.length === 0) {
      throw new Error(name ? `Skill not found: ${name}` : 'No skills installed');
    }

    const updated: InstalledSkill[] = [];
    for (const skill of toUpdate) {
      try {
        await execAsync('git pull --ff-only', { cwd: skill.path, timeout: 30000 });

        // Update version
        try {
          const { stdout } = await execAsync('git rev-parse --short HEAD', { cwd: skill.path });
          skill.version = stdout.trim();
        } catch {}

        skill.updatedAt = new Date().toISOString();
        updated.push(skill);
      } catch (err) {
        console.error(`Failed to update ${skill.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }

    await this.saveInstalled(installed);
    return updated;
  }

  /**
   * Remove an installed skill.
   */
  async remove(name: string): Promise<boolean> {
    const installed = await this.getInstalled();
    const skill = installed.find((s) => s.name === name);
    if (!skill) return false;

    // Remove directory
    try {
      await rm(skill.path, { recursive: true, force: true });
    } catch {
      // Directory might already be gone
    }

    // Update metadata
    const remaining = installed.filter((s) => s.name !== name);
    await this.saveInstalled(remaining);
    return true;
  }

  /**
   * List installed skills.
   */
  async list(): Promise<InstalledSkill[]> {
    return this.getInstalled();
  }

  /**
   * Get info about an installed skill (reads its SKILL.md).
   */
  async info(name: string): Promise<{ skill: InstalledSkill; manifest: string } | null> {
    const installed = await this.getInstalled();
    const skill = installed.find((s) => s.name === name);
    if (!skill) return null;

    let manifest = '';
    try {
      manifest = await readFile(join(skill.path, 'SKILL.md'), 'utf-8');
    } catch {
      manifest = '(SKILL.md not found — skill may be corrupted)';
    }

    return { skill, manifest };
  }

  // ─── Private ────────────────────────────────────────────────────

  private async getInstalled(): Promise<InstalledSkill[]> {
    try {
      const raw = await readFile(this.metadataPath, 'utf-8');
      const data = JSON.parse(raw) as InstalledSkillsFile;
      return data.skills;
    } catch {
      return [];
    }
  }

  private async saveInstalled(skills: InstalledSkill[]): Promise<void> {
    await mkdir(join(this.metadataPath, '..'), { recursive: true });
    const data: InstalledSkillsFile = { version: 1, skills };
    await writeFile(this.metadataPath, JSON.stringify(data, null, 2), 'utf-8');
  }
}
