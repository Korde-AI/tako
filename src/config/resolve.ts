/**
 * Config resolution — loads tako.json, merges with defaults,
 * resolves env vars, expands paths.
 *
 * Resolution order:
 * 1. Explicit --config path
 * 2. ~/.tako/tako.json (user home)
 * 3. DEFAULT_CONFIG (hardcoded defaults)
 */

import { readFile, access, rename as fsRename } from 'node:fs/promises';
import { resolve, join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { type TakoConfig, DEFAULT_CONFIG } from './schema.js';

const MAX_BACKUPS = 5;

/**
 * Resolve a path that may contain ~ (home directory).
 */
function expandHome(p: string): string {
  if (p.startsWith('~/') || p === '~') {
    return join(homedir(), p.slice(1));
  }
  return p;
}

/**
 * Resolve workspace-like paths safely:
 * - ~ is expanded to home
 * - absolute paths are kept as-is
 * - relative paths are anchored under ~/.tako (never CWD)
 */
function resolveWorkspacePath(p: string): string {
  const expanded = expandHome(p);
  if (isAbsolute(expanded)) return expanded;
  return resolve(join(homedir(), '.tako'), expanded);
}

/**
 * Shallow merge each top-level config section.
 */
function mergeConfig(defaults: TakoConfig, overrides: Partial<TakoConfig>): TakoConfig {
  return {
    providers: { ...defaults.providers, ...overrides.providers },
    channels: { ...defaults.channels, ...overrides.channels },
    tools: {
      ...defaults.tools,
      ...overrides.tools,
      browser: {
        enabled: overrides.tools?.browser?.enabled ?? defaults.tools.browser?.enabled ?? true,
        headless: overrides.tools?.browser?.headless ?? defaults.tools.browser?.headless ?? true,
        idleTimeoutMs: overrides.tools?.browser?.idleTimeoutMs ?? defaults.tools.browser?.idleTimeoutMs ?? 300_000,
      },
    },
    memory: { ...defaults.memory, ...overrides.memory },
    gateway: { ...defaults.gateway, ...overrides.gateway },
    agent: { ...defaults.agent, ...overrides.agent },
    sandbox: { ...defaults.sandbox, ...overrides.sandbox },
    agents: {
      defaults: { ...defaults.agents.defaults, ...overrides.agents?.defaults },
      list: overrides.agents?.list ?? defaults.agents.list,
    },
    skills: {
      dirs: overrides.skills?.dirs ?? defaults.skills.dirs,
    },
    heartbeat: {
      ...defaults.heartbeat,
      ...overrides.heartbeat,
      ...(overrides.heartbeat?.activeHours ? {
        activeHours: { ...defaults.heartbeat.activeHours, ...overrides.heartbeat.activeHours },
      } : {}),
    },
    session: {
      ...defaults.session,
      ...overrides.session,
      compaction: {
        ...defaults.session.compaction,
        ...overrides.session?.compaction,
      },
    },
    retryQueue: { ...defaults.retryQueue, ...overrides.retryQueue },
    cache: {
      ...defaults.cache,
      ...overrides.cache,
      file: { ...defaults.cache.file, ...overrides.cache?.file },
      tool: {
        ...defaults.cache.tool,
        ...overrides.cache?.tool,
        blocklist: overrides.cache?.tool?.blocklist ?? defaults.cache.tool.blocklist,
      },
      symbols: { ...defaults.cache.symbols, ...overrides.cache?.symbols },
    },
    audit: { ...defaults.audit, ...overrides.audit },
    queue: { ...defaults.queue, ...overrides.queue },
    security: {
      ...defaults.security,
      ...overrides.security,
      rateLimits: {
        ...defaults.security.rateLimits,
        ...overrides.security?.rateLimits,
        perUser: { ...defaults.security.rateLimits.perUser, ...overrides.security?.rateLimits?.perUser },
        perChannel: { ...defaults.security.rateLimits.perChannel, ...overrides.security?.rateLimits?.perChannel },
        global: { ...defaults.security.rateLimits.global, ...overrides.security?.rateLimits?.global },
      },
      sanitizer: { ...defaults.security.sanitizer, ...overrides.security?.sanitizer },
      toolValidation: { ...defaults.security.toolValidation, ...overrides.security?.toolValidation },
      secretScanning: { ...defaults.security.secretScanning, ...overrides.security?.secretScanning },
      network: { ...defaults.security.network, ...overrides.security?.network },
    },
    skillExtensions: overrides.skillExtensions ?? defaults.skillExtensions,
  };
}

/**
 * Find the config file path using the resolution order:
 *   1. Explicit path (--config)
 *   2. ~/.tako/tako.json (user home)
 *   3. null (use defaults)
 */
function findConfigFile(explicitPath?: string): string | null {
  if (explicitPath) return explicitPath;

  const homePath = join(homedir(), '.tako', 'tako.json');
  if (existsSync(homePath)) return homePath;

  return null;
}

/**
 * Load .env file from ~/.tako/.env and inject into process.env
 * (only sets vars that are not already set).
 */
async function loadTakoEnv(): Promise<void> {
  const envPath = join(homedir(), '.tako', '.env');
  try {
    const raw = await readFile(envPath, 'utf-8');
    for (const line of raw.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      // Only set if not already defined in environment
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // No .env file — that's fine
  }
}

/**
 * Validate critical config fields after merging.
 * Throws on invalid config instead of silently using permissive defaults.
 */
function validateConfig(config: TakoConfig, filePath: string | null): void {
  const errors: string[] = [];

  // Validate providers
  if (!config.providers || typeof config.providers !== 'object') {
    errors.push('providers section is missing or invalid');
  }

  // Validate gateway port
  if (config.gateway?.port != null) {
    const port = config.gateway.port;
    if (typeof port !== 'number' || port < 1 || port > 65535) {
      errors.push(`gateway.port must be 1-65535, got: ${port}`);
    }
  }

  // Validate security section
  if (config.security) {
    const validModes = ['blocklist', 'allowlist'];
    if (config.security.network?.mode && !validModes.includes(config.security.network.mode)) {
      errors.push(`security.network.mode must be one of ${validModes.join(', ')}, got: ${config.security.network.mode}`);
    }
    const validSanitizerModes = ['warn', 'strip', 'block'];
    if (config.security.sanitizer?.mode && !validSanitizerModes.includes(config.security.sanitizer.mode)) {
      errors.push(`security.sanitizer.mode must be one of ${validSanitizerModes.join(', ')}, got: ${config.security.sanitizer.mode}`);
    }
    const validValidationLevels = ['off', 'warn', 'strict'];
    if (config.security.toolValidation?.level && !validValidationLevels.includes(config.security.toolValidation.level)) {
      errors.push(`security.toolValidation.level must be one of ${validValidationLevels.join(', ')}, got: ${config.security.toolValidation.level}`);
    }
  }

  // Validate agent timeout
  if (config.agent?.timeout != null && (typeof config.agent.timeout !== 'number' || config.agent.timeout <= 0)) {
    errors.push(`agent.timeout must be a positive number, got: ${config.agent.timeout}`);
  }

  if (errors.length > 0) {
    const source = filePath ? ` (from ${filePath})` : '';
    throw new Error(
      `Config validation failed${source}:\n  - ${errors.join('\n  - ')}`,
    );
  }
}

/**
 * Load and resolve the Tako config.
 */
export async function resolveConfig(configPath?: string): Promise<TakoConfig> {
  // Load ~/.tako/.env first so API keys are available
  await loadTakoEnv();

  const filePath = findConfigFile(configPath);

  let fileConfig: Partial<TakoConfig> = {};
  if (filePath) {
    try {
      const raw = await readFile(filePath, 'utf-8');
      fileConfig = JSON.parse(raw) as Partial<TakoConfig>;
    } catch (err) {
      // Config file exists but is invalid — fail-closed instead of silently falling back to defaults
      throw new Error(
        `Failed to load config from ${filePath}: ${err instanceof Error ? err.message : String(err)}. ` +
        `Fix the config file or remove it to use defaults.`,
      );
    }
  }

  const config = mergeConfig(DEFAULT_CONFIG, fileConfig);

  // Validate critical config sections — fail-closed on invalid config
  validateConfig(config, filePath);

  // Resolve workspace paths: never anchor to CWD.
  config.memory.workspace = resolveWorkspacePath(config.memory.workspace);
  config.agents.defaults.workspace = resolveWorkspacePath(config.agents.defaults.workspace);
  config.agents.list = config.agents.list.map((entry) => ({
    ...entry,
    workspace: entry.workspace ? resolveWorkspacePath(entry.workspace) : entry.workspace,
  }));

  // Expand ~ in skill dirs and resolve relative paths against the config file's directory
  // (or cwd if no config file). This ensures './skills' always points to the right place.
  const configDir = filePath ? resolve(filePath, '..') : process.cwd();
  config.skills.dirs = config.skills.dirs.map((d) => {
    const expanded = expandHome(d);
    // Relative paths are resolved against the config file directory
    return resolve(configDir, expanded);
  });

  // Always include the built-in skills directory from the Tako install
  // import.meta.url → dist/config/resolve.js, go up to project root
  const distDir = resolve(new URL('.', import.meta.url).pathname, '..');
  const projectRoot = resolve(distDir, '..');
  const builtinSkillsDir = resolve(projectRoot, 'skills');
  if (!config.skills.dirs.includes(builtinSkillsDir)) {
    config.skills.dirs.unshift(builtinSkillsDir);
  }

  // ─── Mod overrides ───────────────────────────────────────────────
  // If a mod is active, override workspace, skills, and provider.
  try {
    const { ModManager } = await import('../mods/mod.js');
    const mods = new ModManager();
    const modWorkspace = await mods.getActiveWorkspace();
    if (modWorkspace) {
      config.memory.workspace = modWorkspace;
      const modSkillDirs = await mods.getActiveSkillDirs();
      config.skills.dirs = [...modSkillDirs, ...config.skills.dirs];

      const modConfig = await mods.getActiveConfig();
      if (modConfig) {
        if (modConfig.provider) config.providers.primary = modConfig.provider;
        if (modConfig.toolProfile) config.tools.profile = modConfig.toolProfile as any;
        if (modConfig.agent) {
          if (modConfig.agent.timeout) config.agent.timeout = modConfig.agent.timeout;
          if (modConfig.agent.thinking) config.agent.thinking = modConfig.agent.thinking as any;
        }
      }

      const active = await mods.getActive();
      console.log(`[mod] Active: ${active} → workspace: ${modWorkspace}`);
    }
  } catch {
    // Mod system not available — continue with normal config
  }

  // Stash the resolved config path for status display
  config._configPath = filePath ?? undefined;

  return config;
}

/**
 * Persist a partial config update to the user's tako.json.
 * Reads the current file, merges the patch, and writes it back.
 * Only writes to ~/.tako/tako.json (never CWD to avoid stale overrides).
 */
export async function patchConfig(patch: Record<string, unknown>): Promise<void> {
  const configPath = join(homedir(), '.tako', 'tako.json');
  let existing: Record<string, unknown> = {};
  try {
    const raw = await readFile(configPath, 'utf-8');
    existing = JSON.parse(raw) as Record<string, unknown>;
  } catch { /* no existing config */ }

  // Rotate backups before writing
  await rotateBackups(configPath);

  // Deep merge patch into existing
  const merged = deepMergePatch(existing, patch);
  const { writeFile: writeFileAsync } = await import('node:fs/promises');
  await writeFileAsync(configPath, JSON.stringify(merged, null, 2) + '\n', 'utf-8');
}

/**
 * Rotate config backups: tako.json → .bak, .bak → .bak.1, etc.
 * Keeps at most MAX_BACKUPS (5) backup files.
 */
async function rotateBackups(configPath: string): Promise<void> {
  if (!existsSync(configPath)) return;

  // Rotate existing backups from highest to lowest
  for (let i = MAX_BACKUPS - 1; i >= 1; i--) {
    const from = i === 1 ? `${configPath}.bak` : `${configPath}.bak.${i - 1}`;
    const to = `${configPath}.bak.${i}`;
    if (existsSync(from)) {
      try {
        await fsRename(from, to);
      } catch { /* ignore rename failures */ }
    }
  }

  // Rotate current config to .bak
  try {
    await fsRename(configPath, `${configPath}.bak`);
  } catch { /* ignore if file disappeared */ }
}

function deepMergePatch(target: Record<string, unknown>, source: Record<string, unknown>): Record<string, unknown> {
  const result = { ...target };
  for (const [key, value] of Object.entries(source)) {
    if (value && typeof value === 'object' && !Array.isArray(value) && typeof result[key] === 'object' && !Array.isArray(result[key])) {
      result[key] = deepMergePatch(result[key] as Record<string, unknown>, value as Record<string, unknown>);
    } else {
      result[key] = value;
    }
  }
  return result;
}

/**
 * Check if a Tako config exists anywhere in the resolution chain.
 */
export function hasConfig(): boolean {
  return findConfigFile() !== null;
}
