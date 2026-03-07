/**
 * Agent registry — manages multiple isolated agent brains.
 *
 * Each agent has its own workspace, state directory, session store,
 * and config overrides. The "main" agent always exists.
 */

import { mkdir, rm, readdir, writeFile, readFile, chmod } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { AgentsConfig, AgentEntry } from '../config/schema.js';
import type { AgentDescriptor } from './config.js';
import { generateWorkspaceTemplates } from './templates.js';

/** Expand ~ to home directory. */
function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return join(homedir(), p.slice(1));
  }
  return p;
}

export class AgentRegistry {
  private agents = new Map<string, AgentDescriptor>();
  private baseDir: string;
  private defaultModel: string;
  private defaultWorkspace: string;

  constructor(config: AgentsConfig, defaultModel: string) {
    this.baseDir = expandHome('~/.tako/agents');
    this.defaultModel = defaultModel;
    this.defaultWorkspace = expandHome(config.defaults.workspace);

    // Always register the "main" agent
    this.agents.set('main', this.buildDescriptor({
      id: 'main',
      workspace: config.defaults.workspace,
      model: config.defaults.model,
      description: 'Primary Tako agent',
    }, true));

    // Register agents from config
    for (const entry of config.list) {
      if (entry.id === 'main') continue; // Don't override main
      this.agents.set(entry.id, this.buildDescriptor(entry, false));
    }

    // Scan ~/.tako/agents/ for agents created at runtime but not in config
    this.scanDiskAgents();
  }

  /** Discover agents on disk that aren't in the config. */
  private scanDiskAgents(): void {
    try {
      const { readdirSync, readFileSync } = require('fs') as typeof import('fs');
      const entries = readdirSync(this.baseDir, { withFileTypes: true });
      for (const entry of entries) {
        if (!entry.isDirectory() || entry.name === 'main' || this.agents.has(entry.name)) continue;
        const agentJsonPath = join(this.baseDir, entry.name, 'agent.json');
        try {
          const raw = readFileSync(agentJsonPath, 'utf-8');
          const agentData = JSON.parse(raw) as AgentEntry;
          agentData.id = agentData.id || entry.name;
          this.agents.set(agentData.id, this.buildDescriptor(agentData, false));
        } catch { /* no agent.json or malformed */ }
      }
    } catch { /* baseDir doesn't exist yet */ }
  }

  /** Build a resolved AgentDescriptor from a config entry. */
  private buildDescriptor(entry: AgentEntry, isMain: boolean): AgentDescriptor {
    const workspace = expandHome(entry.workspace ?? this.defaultWorkspace);
    const stateDir = join(this.baseDir, entry.id);
    const sessionDir = join(stateDir, 'sessions');

    return {
      id: entry.id,
      workspace: isMain ? this.defaultWorkspace : workspace,
      stateDir,
      sessionDir,
      model: entry.model?.primary ?? this.defaultModel,
      bindings: entry.bindings ?? {},
      canSpawn: entry.canSpawn ?? [],
      description: entry.description ?? '',
      isMain,
      role: isMain ? 'admin' : (entry.role ?? 'standard'),
      skills: entry.skills,
    };
  }

  /** Initialize directories for all agents. */
  async initialize(): Promise<void> {
    await mkdir(this.baseDir, { recursive: true });

    for (const agent of this.agents.values()) {
      await mkdir(agent.stateDir, { recursive: true });
      await mkdir(agent.sessionDir, { recursive: true });

      // Bootstrap workspace for non-main agents
      if (!agent.isMain) {
        await this.ensureWorkspaceAndSessions(agent);
      }
    }
  }

  /**
   * Bootstrap a full agent workspace with rich templates.
   * Creates workspace directory, memory subdirectory, sessions directory,
   * and writes all template files (AGENTS.md, SOUL.md, IDENTITY.md,
   * USER.md, TOOLS.md, HEARTBEAT.md, BOOTSTRAP.md, memory/MEMORY.md).
   * Never overwrites existing files.
   */
  private async ensureWorkspaceAndSessions(agent: AgentDescriptor): Promise<void> {
    // Create workspace + memory + sessions dirs
    await mkdir(agent.workspace, { recursive: true });
    await mkdir(join(agent.workspace, 'memory'), { recursive: true });
    await mkdir(agent.sessionDir, { recursive: true });

    // Generate workspace templates for the new agent
    const templates = generateWorkspaceTemplates({
      agentId: agent.id,
      description: agent.description || undefined,
      model: agent.model,
      role: agent.role,
    });

    // Write each template file (never overwrite existing)
    for (const [relativePath, content] of Object.entries(templates)) {
      const filePath = join(agent.workspace, relativePath);
      if (!existsSync(filePath)) {
        await writeFile(filePath, content, 'utf-8');
      }
    }

    // Create today's daily log
    const today = new Date().toISOString().slice(0, 10);
    const dailyPath = join(agent.workspace, 'memory', `${today}.md`);
    if (!existsSync(dailyPath)) {
      await writeFile(dailyPath, `# Daily Log — ${today}\n\nAgent: ${agent.id}\n\n`, 'utf-8');
    }
  }

  /** Get an agent descriptor by ID. */
  get(id: string): AgentDescriptor | undefined {
    return this.agents.get(id);
  }

  /** Get the main agent. */
  getMain(): AgentDescriptor {
    return this.agents.get('main')!;
  }

  /** List all registered agents. */
  list(): AgentDescriptor[] {
    return Array.from(this.agents.values());
  }

  /** Check if an agent exists. */
  has(id: string): boolean {
    return this.agents.has(id);
  }

  /**
   * Add a new agent at runtime.
   * Creates workspace and state directories.
   */
  async add(entry: AgentEntry): Promise<AgentDescriptor> {
    if (this.agents.has(entry.id)) {
      throw new Error(`Agent already exists: ${entry.id}`);
    }
    if (entry.id === 'main') {
      throw new Error('Cannot create an agent with reserved ID "main"');
    }

    const descriptor = this.buildDescriptor(entry, false);

    // Create state directory + full workspace with rich templates
    await mkdir(descriptor.stateDir, { recursive: true });
    await this.ensureWorkspaceAndSessions(descriptor);

    // Persist agent entry to state dir
    await writeFile(
      join(descriptor.stateDir, 'agent.json'),
      JSON.stringify(entry, null, 2),
      'utf-8',
    );

    this.agents.set(entry.id, descriptor);
    return descriptor;
  }

  /**
   * Remove an agent.
   * Removes state directory but preserves workspace (user data).
   */
  async remove(id: string): Promise<boolean> {
    if (id === 'main') {
      throw new Error('Cannot remove the main agent');
    }

    const agent = this.agents.get(id);
    if (!agent) return false;

    // Remove state directory (sessions, config)
    if (existsSync(agent.stateDir)) {
      await rm(agent.stateDir, { recursive: true, force: true });
    }

    this.agents.delete(id);
    return true;
  }

  /**
   * Change an agent's role at runtime.
   * Persists the change to agent.json.
   */
  async setRole(id: string, role: string): Promise<void> {
    if (id === 'main') {
      throw new Error('Cannot change the main agent\'s role');
    }
    const agent = this.agents.get(id);
    if (!agent) {
      throw new Error(`Agent not found: ${id}`);
    }

    agent.role = role;

    // Persist to agent.json
    const agentJsonPath = join(agent.stateDir, 'agent.json');
    if (existsSync(agentJsonPath)) {
      const raw = await readFile(agentJsonPath, 'utf-8');
      const entry = JSON.parse(raw) as AgentEntry;
      entry.role = role;
      await writeFile(agentJsonPath, JSON.stringify(entry, null, 2), 'utf-8');
    }
  }

  /** Get agent info as a summary object. */
  info(id: string): Record<string, unknown> | undefined {
    const agent = this.agents.get(id);
    if (!agent) return undefined;

    return {
      id: agent.id,
      workspace: agent.workspace,
      stateDir: agent.stateDir,
      sessionDir: agent.sessionDir,
      model: agent.model,
      bindings: agent.bindings,
      canSpawn: agent.canSpawn,
      description: agent.description,
      isMain: agent.isMain,
    };
  }

  /**
   * Load dynamically-added agents from the state directory.
   * Agents added via `add()` persist an agent.json file.
   */
  async loadDynamic(): Promise<void> {
    if (!existsSync(this.baseDir)) return;

    let dirs: string[];
    try {
      dirs = await readdir(this.baseDir);
    } catch {
      return;
    }

    for (const dir of dirs) {
      if (this.agents.has(dir)) continue;
      if (dir === 'main') continue;

      const agentJsonPath = join(this.baseDir, dir, 'agent.json');
      if (!existsSync(agentJsonPath)) continue;

      try {
        const raw = await readFile(agentJsonPath, 'utf-8');
        const entry = JSON.parse(raw) as AgentEntry;
        this.agents.set(entry.id, this.buildDescriptor(entry, false));
      } catch {
        // Corrupt agent.json — skip
      }
    }
  }

  /**
   * Save channel configuration for an agent.
   * Stored in ~/.tako/agents/<id>/channels.json with restricted permissions (0600).
   * Merges with existing config so multiple channel types can coexist.
   */
  async saveChannelConfig(
    agentId: string,
    channelType: string,
    config: Record<string, unknown>,
  ): Promise<void> {
    const agent = this.agents.get(agentId);
    if (!agent) {
      throw new Error(`Agent not found: ${agentId}`);
    }

    const channelsPath = join(agent.stateDir, 'channels.json');

    // Load existing config or start fresh
    let existing: Record<string, unknown> = {};
    if (existsSync(channelsPath)) {
      try {
        const raw = await readFile(channelsPath, 'utf-8');
        existing = JSON.parse(raw);
      } catch { /* start fresh */ }
    }

    existing[channelType] = config;

    await writeFile(channelsPath, JSON.stringify(existing, null, 2), 'utf-8');
    await chmod(channelsPath, 0o600);
  }

  /**
   * Load channel configuration for an agent.
   * Returns the parsed channels.json or null if not found.
   */
  async loadChannelConfig(agentId: string): Promise<Record<string, unknown> | null> {
    const agent = this.agents.get(agentId);
    if (!agent) return null;

    const channelsPath = join(agent.stateDir, 'channels.json');
    if (!existsSync(channelsPath)) return null;

    try {
      const raw = await readFile(channelsPath, 'utf-8');
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }
}
