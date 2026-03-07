/**
 * Config schema — typed configuration for Tako.
 */

import type { ThinkingLevel } from '../core/thinking.js';

// ─── Config types ───────────────────────────────────────────────────

export interface TakoConfig {
  providers: ProvidersConfig;
  channels: ChannelsConfig;
  tools: ToolsConfig;
  memory: MemoryConfig;
  gateway: GatewayConfig;
  agent: AgentConfig;
  sandbox: SandboxConfig;
  agents: AgentsConfig;
  skills: SkillsConfig;
  heartbeat: HeartbeatConfig;
  session: SessionConfig;
  /** Failed message retry queue configuration. */
  retryQueue: RetryQueueConfig;
  /** Cache layer configuration. */
  cache: CacheConfig;
  /** Audit logging configuration. */
  audit: AuditLogConfig;
  /** Message queue configuration for batching rapid inbound messages. */
  queue: QueueConfigSchema;
  /** Security hardening configuration. */
  security: SecurityConfig;
  /** Typing indicator configuration. */
  typing?: TypingIndicatorConfig;
  /** Tool loop detection configuration. */
  toolLoopDetection?: ToolLoopDetectionConfig;
  /** Exec approval configuration. */
  execApprovals?: {
    mode?: 'off' | 'ask' | 'allowlist' | 'full';
    alwaysAsk?: string[];
    allowed?: string[];
    blocked?: string[];
    timeoutMs?: number;
    autoApproveAfter?: number;
  };
  /** Session pruning configuration. */
  pruning?: {
    enabled?: boolean;
    mode?: 'off' | 'cache-ttl' | 'progressive';
    toolResultTtlMs?: number;
    maxToolResultChars?: number;
    startAt?: number;
    aggressiveAt?: number;
  };
  /** Prompt caching configuration. */
  promptCache?: PromptCacheConfigSchema;
  /** Usage tracking configuration. */
  usage?: UsageConfigSchema;
  /** Thinking/reasoning control configuration. */
  thinking?: { default?: ThinkingLevel; modelDefaults?: Record<string, ThinkingLevel> };
  /** Reaction feedback configuration. */
  reactions?: { enabled?: boolean; reactions?: Record<string, string> };
  /** Gateway lock configuration. */
  gatewayLock?: { enabled?: boolean };
  /** Secrets management configuration. */
  secrets?: { backend?: 'file' | 'env' | 'keychain'; path?: string };
  /** Timezone configuration. */
  timezone?: { timezone?: string; autoDetect?: boolean };
  /** Per-skill channel configuration. Keyed by skill name. */
  skillChannels?: Record<string, Record<string, unknown>>;
  /** Per-skill extension configuration. Keyed by skill name, then extension type. */
  skillExtensions?: Record<string, Record<string, Record<string, unknown>>>;
  /** Runtime-only: absolute path of the config file that was loaded. */
  _configPath?: string;
}

// ─── Skills config ──────────────────────────────────────────────────

/** Configuration for skill discovery. */
export interface SkillsConfig {
  /**
   * Directories to scan for skills (each must contain subdirs with SKILL.md).
   * Supports ~ expansion. Resolved in order — first match wins on name collision.
   * Defaults to ['./skills', '~/.tako/skills'].
   */
  dirs: string[];
}

// ─── Multi-agent config ─────────────────────────────────────────────

/** Configuration for the multi-agent system. */
export interface AgentsConfig {
  /** Default settings applied to all agents unless overridden. */
  defaults: AgentDefaults;
  /** List of configured agents. */
  list: AgentEntry[];
}

/** Default agent settings. */
export interface AgentDefaults {
  /** Default workspace path for agents. */
  workspace: string;
  /** Default model for agents. */
  model?: { primary: string };
}

/** A single agent entry in the config. */
export interface AgentEntry {
  /** Unique agent ID (e.g. 'code-agent', 'research-agent'). */
  id: string;
  /** Agent workspace path (overrides default). */
  workspace?: string;
  /** Agent-specific model override. */
  model?: { primary: string };
  /** Channel bindings — route inbound messages to this agent. */
  bindings?: AgentBindings;
  /** Sub-agent allowlist — which agent IDs this agent can spawn. */
  canSpawn?: string[];
  /** Agent description (shown in agents_list). */
  description?: string;
  /** Permission role (admin, operator, editor, standard, viewer, restricted, readonly). */
  role?: string;
  /** Role config with per-user overrides (takes precedence over `role`). */
  roles?: { default: string; users?: Record<string, string> };
  /** Channel connection preferences for this agent. */
  channels?: AgentChannels;
  /** Per-agent prompt cache retention override. */
  cacheRetention?: 'none' | 'short' | 'long';
}

/** Channel connection preferences for an agent. */
export interface AgentChannels {
  discord?: {
    enabled: boolean;
    guildId?: string;
  };
  telegram?: {
    enabled: boolean;
  };
}

/** Channel binding configuration for an agent. */
export interface AgentBindings {
  discord?: { channels: string[] };
  telegram?: { users?: string[]; groups?: string[] };
  cli?: boolean;
}

export interface ProvidersConfig {
  /** Primary model reference (e.g. 'anthropic/claude-sonnet-4-6') */
  primary: string;
  /** Ordered fallback model chain (up to 4 total including primary) */
  fallback?: string[];
  /** Per-provider overrides */
  overrides?: Record<string, Record<string, unknown>>;
  /** LiteLLM-specific config */
  litellm?: LiteLLMConfig;
  /** Cooldown duration in seconds after a provider fails (default: 60) */
  cooldownSeconds?: number;
  /**
   * Anthropic prompt cache retention mode.
   * - 'none': no caching (default)
   * - 'short': ephemeral cache (~5min TTL, resets on hit)
   * - 'long': ephemeral cache with conversation prefix caching
   *
   * When enabled, stable content (system prompt, tools) is marked with
   * cache_control blocks to reduce token costs on repeated turns.
   */
  cacheRetention?: 'none' | 'short' | 'long';
}

// ─── Resilience config ──────────────────────────────────────────────

/** Configuration for the failed message retry queue. */
export interface RetryQueueConfig {
  /** Enable the retry queue (default: true) */
  enabled: boolean;
  /** Delay in seconds before retrying a failed message (default: 30) */
  delaySeconds: number;
  /** Max retries per message (default: 1) */
  maxRetries: number;
  /** Emoji to react with on permanent failure (default: '😨') */
  failureEmoji: string;
}

export interface LiteLLMConfig {
  /** Endpoint display name (e.g. 'OhMyGPT', 'Local LiteLLM') */
  name?: string;
  /** LiteLLM proxy base URL (e.g. 'http://localhost:4000') */
  baseUrl: string;
  /** API key for authenticated proxies (optional) */
  apiKey?: string;
  /** Primary model name configured in the LiteLLM proxy */
  model: string;
  /** All selected models from the LiteLLM proxy (used in fallback chain and /models) */
  models?: string[];
}

export interface ChannelsConfig {
  discord?: DiscordChannelConfig;
  telegram?: TelegramChannelConfig;
  cli?: CLIChannelConfig;
}

export interface DiscordChannelConfig {
  token: string;
  guilds?: string[];
  /** Thread binding config for ACP/sub-agent spawns. */
  threadBindings?: {
    enabled: boolean;
    spawnAcpSessions: boolean;
    spawnSubagents: boolean;
    progressUpdates: boolean;
    progressIntervalMs: number;
  };
}

export interface TelegramChannelConfig {
  token: string;
  allowedUsers?: string[];
}

export interface CLIChannelConfig {
  prompt?: string;
}

export interface ToolsConfig {
  /** Tool profile: controls which tool groups are enabled */
  profile: 'minimal' | 'coding' | 'full';
  /** Explicitly denied tools */
  deny: string[];
  /** Explicitly allowed tools (overrides profile) */
  allow?: string[];
  /** Sandbox-specific tool overrides */
  sandbox?: {
    tools?: { allow?: string[]; deny?: string[] };
  };
  /** Exec-specific safety policy */
  exec?: ExecConfig;
  /** Browser automation tools (Playwright-backed). */
  browser?: BrowserToolsConfig;
}

export interface BrowserToolsConfig {
  /** Enable browser tools. */
  enabled: boolean;
  /** Launch Chromium in headless mode. */
  headless: boolean;
  /** Auto-close browser after this idle time in milliseconds. */
  idleTimeoutMs: number;
}

export interface ExecConfig {
  /** Security mode: 'deny' blocks all exec, 'allowlist' requires pattern match, 'full' allows everything */
  security: 'deny' | 'allowlist' | 'full';
  /** Patterns for pre-approved commands (regex strings) */
  allowlist?: string[];
  /** Max timeout in ms */
  timeout?: number;
  /** Max output size in bytes */
  maxOutputSize?: number;
}

export interface SandboxConfig {
  /** When to sandbox: 'off' disables, 'non-main' sandboxes spawned sessions, 'all' sandboxes everything */
  mode: 'off' | 'non-main' | 'all';
  /** Container lifecycle: 'session' (one per session), 'agent', or 'shared' (single container) */
  scope: 'session' | 'agent' | 'shared';
  /** How the workspace is mounted: 'none', 'ro' (read-only), 'rw' (read-write) */
  workspaceAccess: 'none' | 'ro' | 'rw';
  /** Docker container settings */
  docker?: {
    image?: string;
    network?: string;
    binds?: string[];
    setupCommand?: string;
    user?: string;
  };
}

export interface MemoryConfig {
  /** Path to workspace directory */
  workspace: string;
  /** Embedding provider config */
  embeddings?: {
    provider: string;
    model?: string;
  };
}

export interface GatewayConfig {
  /** Bind address */
  bind: string;
  /** Port number */
  port: number;
  /** Auth token (auto-generated if missing) */
  authToken?: string;
}

// ─── Heartbeat config ────────────────────────────────────────────────

/** Heartbeat system configuration. */
export interface HeartbeatConfig {
  /** Interval duration string: "30m", "1h", "0m" (disabled). */
  every: string;
  /** Model override for heartbeat runs. */
  model?: string;
  /** Delivery target: 'none' (silent), 'last' (last channel), or explicit channel ID. */
  target: 'none' | 'last' | string;
  /** Specific recipient for delivery. */
  to?: string;
  /** Heartbeat prompt sent to the agent loop. */
  prompt: string;
  /** Max chars after HEARTBEAT_OK before delivery is dropped (default 300). */
  ackMaxChars: number;
  /** Active hours window — heartbeats only run during this window. */
  activeHours?: {
    start: string;     // "HH:MM"
    end: string;       // "HH:MM"
    timezone?: string; // IANA timezone
  };
}

// ─── Session config ──────────────────────────────────────────────────

/** Session lifecycle configuration. */
export interface SessionConfig {
  /** Auto-compaction settings. */
  compaction: {
    /** Enable auto-compaction when context gets large. */
    auto: boolean;
    /** Trigger compaction at this percentage of context window (0-100). */
    thresholdPercent: number;
    /** Use LLM for compaction summaries (default: true). */
    smartSummary?: boolean;
  };
  /** Prune completed sub-agent sessions after N days. */
  pruneAfterDays: number;
  /** Max sessions to keep in memory. */
  maxEntries: number;
  /** Session init protocol configuration. */
  sessionInit?: SessionInitConfig;
}

/** Session init protocol configuration. */
export interface SessionInitConfig {
  /** Enable session init protocol (default: true). */
  enabled?: boolean;
  /** Include git log in init context (default: true). */
  includeGitLog?: boolean;
  /** Number of recent progress entries to show (default: 3). */
  progressEntries?: number;
  /** Custom instructions to append. */
  customInstructions?: string;
}

export interface AgentConfig {
  /** Max agent loop duration in seconds */
  timeout: number;
  /** Thinking mode */
  thinking: 'none' | 'adaptive' | 'always';
  /** Max tool calls per loop iteration */
  maxToolCalls?: number;
  /** Max output characters per response before truncation (default: 50000) */
  maxOutputChars?: number;
  /** Max tool-call turns per agent loop run (default: 20) */
  maxTurns?: number;
  /** Max output tokens per API call (default: 16384) */
  maxTokens?: number;
  /** When to show typing indicator: 'instant' starts immediately, 'never' disables */
  typingMode?: 'never' | 'instant' | 'thinking' | 'message';
  /** How often to refresh typing indicator in seconds (default: 6) */
  typingIntervalSeconds?: number;
  /** Response streaming configuration */
  streaming?: StreamingConfig;
}

/** Response streaming configuration. */
export interface StreamingConfig {
  /** Enable streaming (default: false; reference runtime-style) */
  enabled?: boolean;
  /** Min chars to buffer before sending a chunk (default: 50) */
  minChunkSize?: number;
  /** Max ms to wait before flushing buffer (default: 500) */
  flushIntervalMs?: number;
}

// ─── Cache config ───────────────────────────────────────────────────

/** Cache layer configuration. */
export interface CacheConfig {
  /** Master switch for all cache layers (default: true). */
  enabled: boolean;
  /** Interval in ms between auto-clean sweeps (default: 60000). */
  autoCleanIntervalMs: number;
  /** File content cache settings. */
  file: FileCacheConfig;
  /** Tool execution result cache settings. */
  tool: ToolCacheConfig;
  /** AST/symbol index cache settings. */
  symbols: SymbolCacheConfig;
}

/** File content cache configuration. */
export interface FileCacheConfig {
  /** Enable file content caching (default: true). */
  enabled: boolean;
  /** Max total cached bytes (default: 50MB). */
  maxSizeBytes: number;
  /** Max single file size to cache in bytes (default: 1MB). */
  maxFileSizeBytes: number;
}

/** Tool execution result cache configuration. */
export interface ToolCacheConfig {
  /** Enable tool result caching (default: true). */
  enabled: boolean;
  /** Default TTL in seconds (default: 60). */
  defaultTtlSeconds: number;
  /** Per-command TTL overrides (e.g. { 'git status': 10, 'ls': 30 }). */
  ttlOverrides?: Record<string, number>;
  /** Commands that should never be cached (e.g. test, build). */
  blocklist: string[];
}

/** AST/symbol index cache configuration. */
export interface SymbolCacheConfig {
  /** Enable symbol index caching (default: true). */
  enabled: boolean;
  /** Disk persistence path (default: '~/.tako/cache/symbol-index.json'). */
  persistPath: string;
  /** Max files to index (default: 5000). */
  maxFiles: number;
}

// ─── Audit config ───────────────────────────────────────────────────

/** Audit logging configuration. */
export interface AuditLogConfig {
  /** Enable audit logging (default: true). */
  enabled: boolean;
  /** Max file size in MB before rotation (default: 10). */
  maxFileSizeMb: number;
  /** Retention period string, e.g. '30d' (default: '30d'). */
  retention: string;
}

// ─── Queue config ───────────────────────────────────────────────────

/** Message queue configuration for batching rapid inbound messages. */
export interface QueueConfigSchema {
  /** Queue mode: 'off' | 'collect' | 'debounce' (default: 'collect') */
  mode: 'off' | 'collect' | 'debounce';
  /** Debounce delay in ms (default: 2000) */
  debounceMs: number;
  /** Max queued messages before force-processing (default: 25) */
  cap: number;
  /** Drop strategy when cap is hit: 'oldest' | 'summarize' (default: 'oldest') */
  dropStrategy: 'oldest' | 'summarize';
  /** Max wait before force-processing in ms (default: 10000) */
  maxWaitMs: number;
}

// ─── Security config ────────────────────────────────────────────────

/** Security hardening configuration. */
export interface SecurityConfig {
  /** Rate limiting settings. */
  rateLimits: {
    enabled: boolean;
    perUser: { maxRequests: number; windowMs: number };
    perChannel: { maxRequests: number; windowMs: number };
    global: { maxRequests: number; windowMs: number };
  };
  /** Input sanitization settings. */
  sanitizer: {
    enabled: boolean;
    mode: 'strip' | 'warn' | 'block';
  };
  /** Tool argument validation settings. */
  toolValidation: {
    level: 'strict' | 'warn' | 'off';
  };
  /** Secret scanning settings. */
  secretScanning: {
    enabled: boolean;
    action: 'redact' | 'block' | 'warn';
  };
  /** Network policy settings. */
  network: {
    mode: 'allowlist' | 'blocklist';
    allowlist?: string[];
    blocklist?: string[];
  };
}

// ─── Typing config ──────────────────────────────────────────────────

/** Typing indicator configuration. */
export interface TypingIndicatorConfig {
  /** Enable typing indicators (default: true). */
  enabled?: boolean;
  /** Interval to re-send typing indicator in ms (default: 5000). */
  intervalMs?: number;
}

// ─── Tool loop detection config ─────────────────────────────────────

/** Tool loop detection configuration. */
export interface ToolLoopDetectionConfig {
  /** Enable loop detection (default: true). */
  enabled?: boolean;
  /** Max identical tool calls before breaking (default: 3). */
  maxRepetitions?: number;
  /** Max similar tool calls (same tool, different args) before warning (default: 5). */
  maxSimilarCalls?: number;
  /** Window of recent tool calls to consider (default: 10). */
  windowSize?: number;
}

// ─── Prompt cache config ─────────────────────────────────────────────

/** Prompt caching configuration. */
export interface PromptCacheConfigSchema {
  /** Enable prompt caching (default: true). */
  enabled?: boolean;
  /** Min tokens for content to be cache-worthy (default: 1024). */
  minTokens?: number;
}

// ─── Usage tracking config ──────────────────────────────────────────

/** Usage tracking configuration. */
export interface UsageConfigSchema {
  /** Enable usage tracking (default: true). */
  enabled?: boolean;
  /** Show usage footer on responses: 'off' | 'tokens' | 'full' | 'cost' (default: 'off'). */
  footer?: 'off' | 'tokens' | 'full' | 'cost';
  /** Max entries to keep in memory (default: 10000). */
  maxEntries?: number;
  /** Persist to disk (default: true). */
  persist?: boolean;
}

// ─── Defaults ───────────────────────────────────────────────────────

export const DEFAULT_CONFIG: TakoConfig = {
  providers: {
    primary: 'anthropic/claude-sonnet-4-6',
  },
  channels: {},
  tools: {
    profile: 'full',
    deny: [],
    browser: {
      enabled: true,
      headless: true,
      idleTimeoutMs: 300_000,
    },
  },
  memory: {
    workspace: '~/.tako/workspace',
  },
  gateway: {
    bind: '127.0.0.1',
    port: 18790,
  },
  agent: {
    timeout: 600,
    thinking: 'adaptive',
    streaming: {
      enabled: false,
      minChunkSize: 200,
      flushIntervalMs: 1000,
    },
  },
  sandbox: {
    mode: 'off',
    scope: 'session',
    workspaceAccess: 'ro',
  },
  agents: {
    defaults: {
      workspace: '~/.tako/workspace',
    },
    list: [],
  },
  skills: {
    dirs: ['./skills', '~/.tako/skills'],
  },
  heartbeat: {
    every: '30m',
    target: 'none',
    prompt: 'You are running a periodic heartbeat check. Read HEARTBEAT.md from the workspace. If there are pending tasks, proactive checks, or status updates to deliver, do so. If everything is quiet, respond with HEARTBEAT_OK.',
    ackMaxChars: 300,
  },
  session: {
    compaction: {
      auto: true,
      thresholdPercent: 80,
    },
    pruneAfterDays: 7,
    maxEntries: 100,
  },
  retryQueue: {
    enabled: true,
    delaySeconds: 30,
    maxRetries: 1,
    failureEmoji: '😨',
  },
  cache: {
    enabled: true,
    autoCleanIntervalMs: 60_000,
    file: {
      enabled: true,
      maxSizeBytes: 50 * 1024 * 1024, // 50 MB
      maxFileSizeBytes: 1 * 1024 * 1024, // 1 MB
    },
    tool: {
      enabled: true,
      defaultTtlSeconds: 60,
      blocklist: ['npm test', 'npm run build', 'bun test', 'make', 'cargo test', 'pytest'],
    },
    symbols: {
      enabled: true,
      persistPath: '~/.tako/cache/symbol-index.json',
      maxFiles: 5000,
    },
  },
  audit: {
    enabled: true,
    maxFileSizeMb: 10,
    retention: '30d',
  },
  queue: {
    mode: 'collect',
    debounceMs: 2000,
    cap: 25,
    dropStrategy: 'oldest',
    maxWaitMs: 10_000,
  },
  security: {
    rateLimits: {
      enabled: true,
      perUser: { maxRequests: 30, windowMs: 60_000 },
      perChannel: { maxRequests: 60, windowMs: 60_000 },
      global: { maxRequests: 200, windowMs: 60_000 },
    },
    sanitizer: {
      enabled: true,
      mode: 'warn',
    },
    toolValidation: {
      level: 'warn',
    },
    secretScanning: {
      enabled: true,
      action: 'redact',
    },
    network: {
      mode: 'blocklist',
    },
  },
};
