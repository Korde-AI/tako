import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ProjectRole } from '../projects/types.js';

export interface DelegationCapability {
  capabilityId: string;
  name: string;
  description: string;
  category: 'analysis' | 'review' | 'search' | 'build' | 'test' | 'artifact';
  requiresProject: boolean;
  minRole: ProjectRole;
  enabled: boolean;
}

const DEFAULT_CAPABILITIES: DelegationCapability[] = [
  {
    capabilityId: 'summarize_workspace',
    name: 'Summarize Workspace',
    description: 'Summarize the current project workspace layout and recent files.',
    category: 'analysis',
    requiresProject: true,
    minRole: 'read',
    enabled: true,
  },
  {
    capabilityId: 'review_patch',
    name: 'Review Patch',
    description: 'Review a supplied patch or change summary and return findings.',
    category: 'review',
    requiresProject: true,
    minRole: 'contribute',
    enabled: true,
  },
  {
    capabilityId: 'run_tests',
    name: 'Run Tests',
    description: 'Run the local project test command within the project root.',
    category: 'test',
    requiresProject: true,
    minRole: 'write',
    enabled: true,
  },
  {
    capabilityId: 'inspect_logs',
    name: 'Inspect Logs',
    description: 'Inspect local project or edge logs and return a bounded summary.',
    category: 'analysis',
    requiresProject: false,
    minRole: 'read',
    enabled: true,
  },
];

export class CapabilityRegistry {
  private capabilities = new Map<string, DelegationCapability>();
  private loaded = false;

  constructor(private filePath: string) {}

  async load(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const rows = await this.readJsonFile<DelegationCapability[]>(this.filePath, DEFAULT_CAPABILITIES);
    this.capabilities = new Map(rows.map((row) => [row.capabilityId, row]));
    for (const capability of DEFAULT_CAPABILITIES) {
      if (!this.capabilities.has(capability.capabilityId)) {
        this.capabilities.set(capability.capabilityId, capability);
      }
    }
    this.loaded = true;
    await this.save();
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeFile(this.filePath, JSON.stringify(this.list(), null, 2) + '\n', 'utf-8');
  }

  list(): DelegationCapability[] {
    return Array.from(this.capabilities.values()).sort((a, b) => a.capabilityId.localeCompare(b.capabilityId));
  }

  listEnabled(): DelegationCapability[] {
    return this.list().filter((capability) => capability.enabled);
  }

  get(capabilityId: string): DelegationCapability | null {
    return this.capabilities.get(capabilityId) ?? null;
  }

  async setEnabled(capabilityId: string, enabled: boolean): Promise<DelegationCapability> {
    await this.ensureLoaded();
    const capability = this.get(capabilityId);
    if (!capability) throw new Error(`Unknown capability: ${capabilityId}`);
    const updated = { ...capability, enabled };
    this.capabilities.set(capabilityId, updated);
    await this.save();
    return updated;
  }

  private async ensureLoaded(): Promise<void> {
    if (!this.loaded) await this.load();
  }

  private async readJsonFile<T>(path: string, fallback: T): Promise<T> {
    if (!existsSync(path)) return fallback;
    return JSON.parse(await readFile(path, 'utf-8')) as T;
  }
}
