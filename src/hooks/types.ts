/**
 * Hook system types — lifecycle events for the Tako kernel.
 *
 * Hooks let skill arms and extensions intercept key moments in
 * the agent lifecycle without modifying core code. They follow
 * a simple event emitter pattern with ordered handler execution.
 *
 * Design rules:
 * - Hooks fire in registration order (no priority system)
 * - Handlers can modify the context's mutable `data` bag
 * - Handlers can be async but should not block indefinitely
 * - Hooks can inspect but NOT block tool calls (use tool policy for that)
 * - Skill arms register hooks when loaded via the HookSystem
 *
 * @example
 * ```typescript
 * hooks.on('before_tool_call', async (ctx) => {
 *   console.log(`Tool: ${ctx.data.toolName}`);
 * });
 * ```
 */

// ─── Hook events ────────────────────────────────────────────────────

/**
 * Lifecycle events that hooks can listen to.
 *
 * Agent lifecycle:
 * - `before_prompt_build` — inject context before system prompt assembly
 * - `agent_start` — agent loop is starting a new turn
 * - `agent_end` — agent loop completed (includes turn count)
 *
 * Tool lifecycle:
 * - `before_tool_call` — intercept tool params before execution
 * - `after_tool_call` — inspect/transform tool results after execution
 *
 * Session lifecycle:
 * - `session_start` — new session created for a user
 * - `session_end` — session closed or expired
 *
 * Message lifecycle:
 * - `message_received` — inbound message from any channel
 * - `message_sending` — outbound message about to be sent
 *
 * Gateway lifecycle:
 * - `gateway_start` — WebSocket gateway daemon started
 * - `gateway_stop` — gateway shutting down
 *
 * Channel lifecycle (skill-loaded channels):
 * - `channel_register` — a skill channel was registered
 * - `channel_unregister` — a skill channel was unregistered
 *
 * Compaction lifecycle:
 * - `before_compaction` — about to compact — last chance to save state
 * - `after_compaction` — compaction complete — session init context injected
 *
 * Sandbox lifecycle:
 * - `sandbox_container_created` — sandbox container created and started
 * - `sandbox_container_destroyed` — sandbox container stopped and removed
 * - `sandbox_exec_blocked` — a command was blocked by exec safety
 */
export type HookEvent =
  // Agent lifecycle
  | 'before_prompt_build'
  | 'agent_start'
  | 'agent_end'
  // Tool lifecycle
  | 'before_tool_call'
  | 'after_tool_call'
  // Session lifecycle
  | 'session_start'
  | 'session_end'
  // Message lifecycle
  | 'message_received'
  | 'message_sending'
  // Gateway lifecycle
  | 'gateway_start'
  | 'gateway_stop'
  // Channel lifecycle (skill-loaded channels)
  | 'channel_register'
  | 'channel_unregister'
  // Compaction lifecycle
  | 'before_compaction'
  | 'after_compaction'
  // Sandbox lifecycle
  | 'sandbox_container_created'
  | 'sandbox_container_destroyed'
  | 'sandbox_exec_blocked';

// ─── Hook context ───────────────────────────────────────────────────

/**
 * Context passed to every hook handler.
 * The `data` bag is mutable — hooks can read and modify it to pass
 * information between handlers and back to the emitting code.
 */
export interface HookContext {
  /** The event that triggered this hook */
  event: HookEvent;
  /** Current session ID (if applicable) */
  sessionId?: string;
  /** Mutable data bag — hooks can read, modify, and add entries */
  data: Record<string, unknown>;
  /** Unix timestamp of the hook invocation */
  timestamp: number;
}

/** A hook handler function. Can be sync or async. */
export type HookHandler = (ctx: HookContext) => void | Promise<void>;

// ─── HookSystem interface ───────────────────────────────────────────

/**
 * HookSystem — the lifecycle event trait.
 *
 * A simple event emitter for intercepting key moments in the agent
 * lifecycle. Skill arms and extensions register handlers to observe
 * or modify behavior without touching core code.
 *
 * Built-in implementation:
 * - {@link TakoHookSystem} — simple ordered event emitter
 */
export interface HookSystem {
  /**
   * Register a handler for a lifecycle event.
   * Handlers fire in registration order.
   *
   * @param event - The lifecycle event to listen for
   * @param handler - Callback invoked when the event fires
   */
  on(event: HookEvent, handler: HookHandler): void;

  /**
   * Remove a previously registered handler.
   *
   * @param event - The lifecycle event
   * @param handler - The exact handler reference to remove
   */
  off(event: HookEvent, handler: HookHandler): void;

  /**
   * Emit an event, invoking all registered handlers in order.
   * Each handler is awaited before the next fires.
   *
   * @param event - The lifecycle event to emit
   * @param ctx - Context passed to all handlers
   */
  emit(event: HookEvent, ctx: HookContext): Promise<void>;
}
