import type { HookSystem } from '../hooks/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import { SkillLoader } from './loader.js';

interface InitializeSkillRuntimeInput {
  skillDirs: string[];
  toolRegistry: ToolRegistry;
  hooks: HookSystem;
  addSkillInstructions: (instructions: string) => void;
}

interface BuildAgentSkillLoaderInput {
  baseSkillLoader: SkillLoader;
  baseSkillDirs: string[];
  extraSkillDirs?: string[];
  toolRegistry: ToolRegistry;
  hooks: HookSystem;
  agentId: string;
  log?: (message: string) => void;
}

export async function initializeSkillRuntime(input: InitializeSkillRuntimeInput): Promise<{
  skillLoader: SkillLoader;
  skillManifests: Awaited<ReturnType<SkillLoader['discover']>>;
}> {
  const skillLoader = new SkillLoader(input.skillDirs);
  const skillManifests = await skillLoader.discover();
  for (const manifest of skillManifests) {
    const loaded = await skillLoader.load(manifest);
    skillLoader.registerTools(loaded, input.toolRegistry);
    skillLoader.registerHooks(loaded, input.hooks);
    input.addSkillInstructions(loaded.instructions);
  }

  skillLoader.startWatching(async (reloadedSkills) => {
    for (const skill of reloadedSkills) {
      skillLoader.registerTools(skill, input.toolRegistry);
      skillLoader.registerHooks(skill, input.hooks);
    }
    console.log(`[tako] Skills reloaded: ${reloadedSkills.length} skills`);
  });

  return { skillLoader, skillManifests };
}

export async function buildAgentSkillLoader(input: BuildAgentSkillLoaderInput): Promise<SkillLoader> {
  const extra = input.extraSkillDirs ?? [];
  if (extra.length === 0) {
    return input.baseSkillLoader;
  }

  const agentSkillDirs = [...input.baseSkillDirs, ...extra];
  const agentSkillLoader = new SkillLoader(agentSkillDirs);
  const agentSkillManifests = await agentSkillLoader.discover();
  for (const manifest of agentSkillManifests) {
    const loaded = await agentSkillLoader.load(manifest);
    agentSkillLoader.registerTools(loaded, input.toolRegistry);
    agentSkillLoader.registerHooks(loaded, input.hooks);
  }
  input.log?.(`[tako] Agent "${input.agentId}" using ${agentSkillDirs.length} skill dir(s)`);
  return agentSkillLoader;
}
