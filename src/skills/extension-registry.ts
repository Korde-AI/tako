/**
 * Extension registry — tracks all loaded skill extensions at runtime.
 *
 * The gateway queries this to find active channels, providers, memory
 * stores, etc. that were loaded from skills.
 */

import type { ExtensionType } from './extensions.js';

interface RegisteredExtension {
  type: ExtensionType;
  skillName: string;
  instance: unknown;
  loadedAt: number;
}

export class ExtensionRegistry {
  private extensions = new Map<string, RegisteredExtension[]>();

  /** Register a loaded extension instance. */
  register(type: ExtensionType, skillName: string, instance: unknown): void {
    if (!this.extensions.has(type)) {
      this.extensions.set(type, []);
    }
    this.extensions.get(type)!.push({
      type,
      skillName,
      instance,
      loadedAt: Date.now(),
    });
    console.log(`[extensions] Registered ${type} from skill "${skillName}"`);
  }

  /** Unregister all extensions from a skill (for hot-reload). */
  unregister(skillName: string): void {
    for (const [type, list] of this.extensions) {
      this.extensions.set(type, list.filter((e) => e.skillName !== skillName));
    }
  }

  /** Get all extensions of a specific type. */
  getAll<T>(type: ExtensionType): Array<{ skillName: string; instance: T }> {
    return (this.extensions.get(type) ?? []).map((e) => ({
      skillName: e.skillName,
      instance: e.instance as T,
    }));
  }

  /** Get a single extension by type and skill name. */
  get<T>(type: ExtensionType, skillName: string): T | undefined {
    const list = this.extensions.get(type) ?? [];
    return list.find((e) => e.skillName === skillName)?.instance as T | undefined;
  }

  /** List all registered extension types and their skill sources. */
  list(): Array<{ type: ExtensionType; skillName: string; loadedAt: number }> {
    const result: Array<{ type: ExtensionType; skillName: string; loadedAt: number }> = [];
    for (const list of this.extensions.values()) {
      result.push(...list.map((e) => ({ type: e.type, skillName: e.skillName, loadedAt: e.loadedAt })));
    }
    return result;
  }

  /** Check if any extension of a type is registered. */
  has(type: ExtensionType): boolean {
    return (this.extensions.get(type)?.length ?? 0) > 0;
  }

  /** Clear all extensions. */
  clear(): void {
    this.extensions.clear();
  }
}
