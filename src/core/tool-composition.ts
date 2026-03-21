import type { EmbeddingProvider } from '../memory/vector.js';
import type { SessionManager } from '../gateway/session.js';
import type { CronScheduler } from './cron.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { TakoConfig } from '../config/schema.js';
import { fsTools } from '../tools/fs.js';
import { searchTools } from '../tools/search.js';
import { execTools } from '../tools/exec.js';
import { webTools } from '../tools/web.js';
import { createGitHubTools } from '../tools/github.js';
import { createModelTool } from '../tools/model.js';
import { imageTools } from '../tools/image.js';
import { gitTools } from '../tools/git.js';
import { officeTools } from '../tools/office.js';
import { createMemoryTools } from '../tools/memory.js';
import { createSessionTools } from '../tools/session.js';
import { createBrowserTools } from '../tools/browser.js';
import { createAgentTools } from '../tools/agent-tools.js';
import { createMessageTools } from '../tools/message.js';
import { createIntrospectTools } from '../tools/introspect.js';
import { createAllowFromTools } from '../auth/allow-from.js';
import { createProjectTools } from '../tools/projects.js';
import { createDiscordRoomTools } from '../tools/discord-room.js';
import { createCronTools } from '../tools/cron-tools.js';

export interface RegisterKernelToolPacksInput {
  toolRegistry: ToolRegistry;
  config: TakoConfig;
  embeddingProvider?: EmbeddingProvider;
  sessions: SessionManager;
  projectTools: Parameters<typeof createProjectTools>[0];
  discordRoomTools: Parameters<typeof createDiscordRoomTools>[0];
}

export interface RegisterRuntimeToolPacksInput {
  toolRegistry: ToolRegistry;
  modelTool: Parameters<typeof createModelTool>[0];
  agentTools: Parameters<typeof createAgentTools>[0];
}

export interface RegisterSurfaceToolPacksInput {
  toolRegistry: ToolRegistry;
  messageTools: Parameters<typeof createMessageTools>[0];
  introspectTools: Parameters<typeof createIntrospectTools>[0];
}

export interface RegisterCronToolPackInput {
  toolRegistry: ToolRegistry;
  cronScheduler: CronScheduler;
}

/**
 * Register built-in kernel tools.
 *
 * This is the composition seam between the runtime kernel and the tool packs
 * that ship with Tako. Keeping this out of src/index.ts makes the plugin
 * boundary explicit and avoids scattering hardcoded registerAll(...) calls
 * across the main runtime bootstrap.
 */
export function registerKernelToolPacks(input: RegisterKernelToolPacksInput): void {
  const { toolRegistry, config, embeddingProvider, sessions, projectTools, discordRoomTools } = input;

  toolRegistry.registerAll(fsTools);
  toolRegistry.registerAll(searchTools);
  toolRegistry.registerAll(execTools);
  toolRegistry.registerAll(webTools);
  toolRegistry.registerAll(createGitHubTools());
  toolRegistry.registerAll(createBrowserTools({
    enabled: config.tools.browser?.enabled ?? true,
    headless: config.tools.browser?.headless ?? true,
    idleTimeoutMs: config.tools.browser?.idleTimeoutMs ?? 300_000,
  }));
  toolRegistry.registerAll(imageTools);
  toolRegistry.registerAll(gitTools);
  toolRegistry.registerAll(officeTools);
  toolRegistry.registerAll(createMemoryTools({
    workspaceRoot: config.memory.workspace,
    embeddingProvider,
  }));
  toolRegistry.registerAll(createSessionTools(sessions));
  toolRegistry.registerAll(createAllowFromTools());
  toolRegistry.registerAll(createProjectTools(projectTools));
  toolRegistry.registerAll(createDiscordRoomTools(discordRoomTools));
}

/**
 * Register built-in runtime/control-plane tools.
 *
 * These are still built-ins, but they depend on runtime-composed state such as
 * live channels, agent registries, or schedulers, so they are registered after
 * the kernel tool packs.
 */
export function registerRuntimeToolPacks(input: RegisterRuntimeToolPacksInput): void {
  const { toolRegistry, modelTool, agentTools } = input;

  toolRegistry.register(createModelTool(modelTool));
  toolRegistry.registerAll(createAgentTools(agentTools));
}

export function registerSurfaceToolPacks(input: RegisterSurfaceToolPacksInput): void {
  const { toolRegistry, messageTools, introspectTools } = input;

  toolRegistry.registerAll(createMessageTools(messageTools));
  toolRegistry.registerAll(createIntrospectTools(introspectTools));
}

export function registerCronToolPack(input: RegisterCronToolPackInput): void {
  const { toolRegistry, cronScheduler } = input;

  toolRegistry.registerAll(createCronTools(cronScheduler));
}
