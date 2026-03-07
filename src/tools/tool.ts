/**
 * Tool — agent syscall trait.
 *
 * Tools are the agent's interface to the outside world. Core tools are
 * baked into the kernel (fs, exec, memory), and skill arms register
 * additional tools at runtime.
 *
 * Each tool defines:
 * - A JSON Schema for its parameters (sent to the model)
 * - An execute function that performs the action
 * - An optional group for profile-based activation
 *
 * @example
 * ```typescript
 * const readTool: Tool = {
 *   name: 'read',
 *   description: 'Read a file from disk',
 *   parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
 *   group: 'fs',
 *   async execute(params, ctx) {
 *     const { path } = params as { path: string };
 *     const content = await readFile(path, 'utf-8');
 *     return { output: content, success: true };
 *   },
 * };
 * ```
 */

// ─── JSON Schema type (subset used by tool definitions) ─────────────

/** JSON Schema definition for tool parameters. */
export interface JSONSchema {
  /** JSON Schema type ('object', 'string', 'number', 'boolean', 'array') */
  type: string;
  /** Human-readable description of this schema node */
  description?: string;
  /** Property definitions (for type: 'object') */
  properties?: Record<string, JSONSchema>;
  /** Required property names (for type: 'object') */
  required?: string[];
  /** Item schema (for type: 'array') */
  items?: JSONSchema;
  /** Allowed values (enumeration) */
  enum?: unknown[];
  /** Default value */
  default?: unknown;
  /** Additional schema keywords */
  [key: string]: unknown;
}

// ─── Tool context + result ──────────────────────────────────────────

/** Runtime context passed to every tool execution. */
export interface ToolContext {
  /** Current session ID */
  sessionId: string;
  /** Working directory for file operations */
  workDir: string;
  /** Agent's workspace root directory */
  workspaceRoot: string;
  /** Active agent ID */
  agentId?: string;
  /** Active agent's permission role name */
  agentRole?: string;
  /** Channel type (e.g. 'discord', 'telegram', 'cli') */
  channelType?: string;
  /** Channel target ID (e.g. Discord channel ID without prefix) */
  channelTarget?: string;
  /** Channel instance reference for direct channel operations */
  channel?: unknown;
  /** Abort signal for cancellation (e.g. timeout) */
  signal?: AbortSignal;
  /** Arbitrary metadata from the agent loop */
  meta?: Record<string, unknown>;
}

/** Result returned by a tool execution. */
export interface ToolResult {
  /** Tool output text (returned to the model as the tool result) */
  output: string;
  /** Whether the tool call succeeded */
  success: boolean;
  /** Optional structured data (not sent to model, used internally) */
  data?: unknown;
  /** Optional error message (for logging/debugging) */
  error?: string;
}

// ─── Tool groups + profiles ─────────────────────────────────────────

/**
 * Tool groups organize tools by domain.
 * Profiles activate subsets of groups based on the agent's role.
 */
export type ToolGroup =
  | 'fs'        // File operations (read, write, edit, apply_patch)
  | 'runtime'   // Shell execution (exec, process)
  | 'memory'    // Memory operations (search, get, store)
  | 'web'       // Web access (web_search, web_fetch)
  | 'search'    // File search (glob_search, content_search)
  | 'sessions'  // Session management (status, list, send, spawn)
  | 'git'       // Git operations (status, diff, commit)
  | 'image'     // Image analysis (vision)
  | 'agents'    // Multi-agent management (agents_list, agents_add, agents_remove, subagents)
  | 'messaging'; // Channel management (send, create/edit/delete channels, threads, reactions)

/**
 * Tool activation profiles.
 * - `minimal`: only fs + runtime (safe for sandboxed environments)
 * - `coding`: adds search, git, memory (standard development)
 * - `full`: all groups enabled (unrestricted agent)
 */
export type ToolProfile = 'minimal' | 'coding' | 'full';

// ─── Tool interface ─────────────────────────────────────────────────

/**
 * Tool — the agent syscall trait.
 *
 * Each tool is a named function the model can invoke during generation.
 * Tools are registered with the ToolRegistry and activated based on the
 * current profile and policy. Skill arms can register additional tools
 * at runtime.
 */
export interface Tool {
  /** Unique tool name sent to the model (e.g. 'read', 'exec', 'web_search') */
  name: string;

  /** Human-readable description sent to the model to guide tool selection */
  description: string;

  /** JSON Schema defining the tool's input parameters */
  parameters: JSONSchema;

  /** Tool group for profile-based activation (ungrouped tools are always active) */
  group?: ToolGroup;

  /**
   * Execute the tool with the given parameters and context.
   *
   * @param params - Parsed parameters matching the JSON Schema
   * @param ctx - Runtime context (session, workspace, abort signal)
   * @returns Tool result with output text and success status
   */
  execute(params: unknown, ctx: ToolContext): Promise<ToolResult>;
}
