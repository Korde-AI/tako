import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectBinding } from './types.js';
import type { ChannelPlatform } from '../channels/platforms.js';

export class ProjectBindingRegistry {
  private bindings = new Map<string, ProjectBinding>();
  private loaded = false;

  constructor(private rootDir: string) {}

  private get bindingsFile(): string {
    return join(this.rootDir, 'bindings.json');
  }

  private key(input: {
    platform: string;
    channelTarget: string;
    threadId?: string;
    agentId?: string;
  }): string {
    return [
      input.platform,
      input.channelTarget,
      input.threadId ?? '',
      input.agentId ?? '',
    ].join(':');
  }

  async load(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    const bindings = await this.readJsonFile<ProjectBinding[]>(this.bindingsFile, []);
    this.bindings = new Map(bindings.map((binding) => [this.key(binding), binding]));
    this.loaded = true;
  }

  async save(): Promise<void> {
    await mkdir(this.rootDir, { recursive: true });
    await writeFile(this.bindingsFile, JSON.stringify(this.list(), null, 2) + '\n', 'utf-8');
  }

  list(): ProjectBinding[] {
    return Array.from(this.bindings.values()).sort((a, b) =>
      this.key(a).localeCompare(this.key(b)));
  }

  listActive(): ProjectBinding[] {
    return this.list().filter((binding) => (binding.status ?? 'active') === 'active');
  }

  async bind(input: {
    projectId: string;
    platform: ChannelPlatform;
    channelTarget: string;
    threadId?: string;
    agentId?: string;
  }): Promise<ProjectBinding> {
    await this.ensureLoaded();
    const binding: ProjectBinding = {
      bindingId: crypto.randomUUID(),
      projectId: input.projectId,
      platform: input.platform,
      channelTarget: input.channelTarget,
      threadId: input.threadId,
      agentId: input.agentId,
      createdAt: new Date().toISOString(),
      status: 'active',
    };
    this.bindings.set(this.key(binding), binding);
    await this.save();
    return binding;
  }

  resolve(input: {
    platform: string;
    channelTarget?: string;
    threadId?: string;
    agentId?: string;
  }): ProjectBinding | null {
    if (!input.channelTarget && !input.threadId) return null;
    const matches = this.listActive().filter((binding) => {
      if (binding.platform !== input.platform) return false;
      if (input.channelTarget && binding.channelTarget !== input.channelTarget) return false;
      if (binding.threadId && binding.threadId !== input.threadId) return false;
      return true;
    });
    if (matches.length === 0) return null;

    const score = (binding: ProjectBinding): number => {
      let value = 0;
      if (input.threadId && binding.threadId && binding.threadId === input.threadId) value += 4;
      if (input.channelTarget && binding.channelTarget === input.channelTarget) value += 2;
      if (binding.agentId && binding.agentId === input.agentId) value += 2;
      if (!binding.agentId) value += 1;
      return value;
    };

    matches.sort((a, b) => score(b) - score(a));
    return matches[0];
  }

  async deactivateMatching(input: {
    platform: string;
    channelTarget?: string;
    threadId?: string;
    projectId?: string;
    agentId?: string;
    reason: string;
  }): Promise<ProjectBinding[]> {
    await this.ensureLoaded();
    const changed: ProjectBinding[] = [];
    for (const [key, binding] of this.bindings.entries()) {
      if (binding.platform !== input.platform) continue;
      if (input.projectId && binding.projectId !== input.projectId) continue;
      if (input.channelTarget && binding.channelTarget !== input.channelTarget) continue;
      if (input.threadId && binding.threadId !== input.threadId) continue;
      if (input.agentId && binding.agentId !== input.agentId) continue;
      if ((binding.status ?? 'active') === 'inactive') continue;
      const updated: ProjectBinding = {
        ...binding,
        status: 'inactive',
        deactivatedAt: new Date().toISOString(),
        deactivatedReason: input.reason,
      };
      this.bindings.set(key, updated);
      changed.push(updated);
    }
    if (changed.length > 0) {
      await this.save();
    }
    return changed;
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  private async readJsonFile<T>(path: string, fallback: T): Promise<T> {
    if (!existsSync(path)) return fallback;
    return JSON.parse(await readFile(path, 'utf-8')) as T;
  }
}
