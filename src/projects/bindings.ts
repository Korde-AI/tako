import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { ProjectBinding } from './types.js';

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

  async bind(input: {
    projectId: string;
    platform: 'discord' | 'telegram' | 'cli';
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
    };
    this.bindings.set(this.key(binding), binding);
    await this.save();
    return binding;
  }

  resolve(input: {
    platform: string;
    channelTarget: string;
    threadId?: string;
    agentId?: string;
  }): ProjectBinding | null {
    const matches = this.list().filter((binding) => {
      if (binding.platform !== input.platform) return false;
      if (binding.channelTarget !== input.channelTarget) return false;
      if (binding.threadId && binding.threadId !== input.threadId) return false;
      return true;
    });
    if (matches.length === 0) return null;

    const score = (binding: ProjectBinding): number => {
      let value = 0;
      if (binding.threadId && binding.threadId === input.threadId) value += 4;
      if (binding.agentId && binding.agentId === input.agentId) value += 2;
      if (!binding.agentId) value += 1;
      return value;
    };

    matches.sort((a, b) => score(b) - score(a));
    return matches[0];
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  private async readJsonFile<T>(path: string, fallback: T): Promise<T> {
    if (!existsSync(path)) return fallback;
    return JSON.parse(await readFile(path, 'utf-8')) as T;
  }
}
