/**
 * Channel — messaging I/O trait.
 *
 * One interface, many adapters (Discord, Telegram, CLI, WebChat, etc.).
 * Channels run simultaneously through the Gateway, each handling its own
 * authentication, rate limiting, and message formatting.
 *
 * Each channel:
 * - Connects to a platform and listens for messages
 * - Converts platform-specific payloads to InboundMessage
 * - Sends OutboundMessage back through the platform
 * - Handles reconnection and error recovery independently
 *
 * @example
 * ```typescript
 * const cli = new CLIChannel();
 * cli.onMessage(async (msg) => {
 *   console.log(`User said: ${msg.content}`);
 *   await cli.send({ target: msg.channelId, content: 'Hello!' });
 * });
 * await cli.connect();
 * ```
 */

// ─── Message types ──────────────────────────────────────────────────

/** An inbound message received from any channel. */
export interface InboundMessage {
  /** Unique message ID (platform-specific, e.g. Discord snowflake) */
  id: string;
  /** Channel identifier with optional platform prefix (e.g. 'cli', 'discord:123') */
  channelId: string;
  /** Author information */
  author: {
    /** Platform-specific user ID */
    id: string;
    /** Display name */
    name: string;
    /** Tako principal ID once resolved on the edge runtime */
    principalId?: string;
    /** Additional platform-specific metadata */
    meta?: Record<string, unknown>;
  };
  /** Message text content */
  content: string;
  /** File or media attachments */
  attachments?: Attachment[];
  /** ISO-8601 timestamp of when the message was sent */
  timestamp: string;
  /** Platform-specific raw payload (for advanced use) */
  raw?: unknown;
  /** Platform thread/topic ID (e.g., Telegram forum topic). */
  threadId?: string;
}

/** An outbound message to send through a channel. */
export interface OutboundMessage {
  /** Target conversation, thread, or chat ID */
  target: string;
  /** Text content to send */
  content: string;
  /** Optional message ID to reply to */
  replyTo?: string;
  /** Optional file or media attachments */
  attachments?: Attachment[];
}

/** A file or media attachment on a message. */
export interface Attachment {
  /** Attachment type */
  type: 'image' | 'file' | 'audio' | 'video';
  /** URL to the attachment (if hosted) */
  url?: string;
  /** Raw binary data (for inline attachments) */
  data?: Buffer;
  /** Original filename */
  filename?: string;
  /** MIME type (e.g. 'image/png', 'application/pdf') */
  mimeType?: string;
}

/** Callback for handling inbound messages. */
export type MessageHandler = (msg: InboundMessage) => void | Promise<void>;

// ─── Channel interface ──────────────────────────────────────────────

/**
 * Channel — the messaging I/O trait.
 *
 * Implementations adapt a specific messaging platform into Tako's
 * unified message handling interface. Multiple channels can run
 * simultaneously, each receiving and sending messages independently.
 *
 * Built-in implementations:
 * - {@link CLIChannel} — terminal readline interface
 * - {@link DiscordChannel} — Discord bot via discord.js
 * - {@link TelegramChannel} — Telegram bot via grammY
 */
export interface Channel {
  /** Unique channel identifier (e.g. 'discord', 'telegram', 'cli') */
  id: string;

  /** If set, all messages on this channel route to this specific agent. */
  agentId?: string;

  /**
   * Connect to the messaging platform.
   * For CLI, this starts the readline interface (blocking).
   * For Discord/Telegram, this authenticates and starts listening.
   */
  connect(): Promise<void>;

  /**
   * Disconnect cleanly from the platform.
   * Releases resources and stops listening for messages.
   */
  disconnect(): Promise<void>;

  /**
   * Send an outbound message through the channel.
   * Handles platform-specific formatting (message splitting, Markdown, etc.).
   *
   * @param msg - The message to send
   */
  send(msg: OutboundMessage): Promise<void>;

  /**
   * Register a handler for inbound messages.
   * Only one handler is typically registered (the agent loop router).
   *
   * @param handler - Callback invoked for each incoming message
   */
  onMessage(handler: MessageHandler): void;

  /**
   * Send a typing indicator to the given chat/channel.
   * Optional — channels that don't support typing can omit this.
   */
  sendTyping?(chatId: string): Promise<void>;

  /**
   * Add a reaction emoji to a message.
   * Optional — channels that don't support reactions can omit this.
   */
  addReaction?(chatId: string, messageId: string, emoji: string): Promise<void>;

  /**
   * Remove a reaction emoji from a message.
   * Optional — channels that don't support reactions can omit this.
   */
  removeReaction?(chatId: string, messageId: string, emoji: string): Promise<void>;

  /**
   * Broadcast a system message to all configured default channels.
   * Used for startup/shutdown notices. Optional — CLI can omit.
   */
  broadcast?(text: string): Promise<void>;

  /**
   * Send a message directly to a specific channel/chat by ID.
   * Used for targeted post-restart notifications.
   * Optional — channels that don't support direct targeting can omit this.
   */
  sendToChannel?(channelId: string, text: string): Promise<string | void>;

  /**
   * Edit an existing message (for streaming updates).
   * Optional — channels that don't support editing can omit this.
   *
   * @param chatId - Target chat/channel ID
   * @param messageId - The message to edit
   * @param content - New content for the message
   */
  editMessage?(chatId: string, messageId: string, content: string): Promise<void>;

  /**
   * Send a message and return the message ID (for subsequent edits).
   * Optional — channels that don't support message IDs can omit this.
   *
   * @param msg - The message to send
   * @returns Platform-specific message ID
   */
  sendAndGetId?(msg: OutboundMessage): Promise<string>;
}
