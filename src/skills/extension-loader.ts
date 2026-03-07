/**
 * Extension loader — discovers and loads skill extensions generically.
 *
 * Scans skill directories for recognized extension subdirectories
 * (channel/, provider/, memory/, etc.) and loads their factory modules.
 */

import { join } from 'node:path';
import { existsSync, statSync } from 'node:fs';
import type { SkillExtensions, SkillExtensionEntry, ExtensionType } from './extensions.js';
import { EXTENSION_DIRS } from './extensions.js';
import type { LoadedSkill } from './types.js';

/** Scan a skill directory for extension subdirectories. */
export function detectExtensions(skillRootDir: string): SkillExtensions {
  const extensions: SkillExtensions = {};

  for (const extType of EXTENSION_DIRS) {
    const dir = join(skillRootDir, extType);
    if (!existsSync(dir) || !statSync(dir).isDirectory()) continue;

    // Find entry point: index.ts, index.js, or <type>.ts, <type>.js
    const candidates = [
      join(dir, 'index.ts'),
      join(dir, 'index.js'),
      join(dir, `${extType}.ts`),
      join(dir, `${extType}.js`),
    ];

    const entry = candidates.find((c) => existsSync(c));
    if (entry) {
      extensions[extType] = { dir, entry };
    }
  }

  return extensions;
}

/** Load a specific extension factory from a skill. */
export async function loadExtension<T>(
  skill: LoadedSkill,
  extensionType: ExtensionType,
  config: Record<string, unknown>,
): Promise<T | null> {
  const ext = skill.manifest.extensions?.[extensionType];
  if (!ext) return null;

  try {
    const mod = await import(ext.entry);

    // Try named factory: createChannel, createProvider, createMemory, etc.
    const factoryName = `create${extensionType.charAt(0).toUpperCase() + extensionType.slice(1)}`;
    if (typeof mod[factoryName] === 'function') {
      return mod[factoryName](config) as T;
    }

    // Try generic factory
    if (typeof mod.create === 'function') {
      return mod.create(config) as T;
    }

    // Try default export as constructor
    if (typeof mod.default === 'function') {
      return new mod.default(config) as T;
    }

    console.warn(`[extension-loader] Skill "${skill.manifest.name}" has ${extensionType}/ but no factory function`);
    return null;
  } catch (err) {
    console.error(
      `[extension-loader] Failed to load ${extensionType} from skill "${skill.manifest.name}":`,
      err instanceof Error ? err.message : String(err),
    );
    return null;
  }
}

/** Get all skills that provide a specific extension type. */
export function getSkillsWithExtension(
  skills: LoadedSkill[],
  extensionType: ExtensionType,
): LoadedSkill[] {
  return skills.filter((s) => s.manifest.extensions?.[extensionType] != null);
}
