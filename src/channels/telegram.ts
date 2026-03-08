/**
 * Telegram channel adapter.
 *
 * Connects to Telegram Bot API using grammY.
 * Uses long polling, converts Telegram messages to InboundMessage,
 * and sends responses with Markdown support.
 */

import { Bot, type Context, type CommandContext as GrammyCommandContext } from 'grammy';
import type { ReactionType } from 'grammy/types';
import type { Channel, InboundMessage, OutboundMessage, MessageHandler } from './channel.js';
import { withRetry, TELEGRAM_RETRY } from './retry.js';
import type { SkillCommandSpec } from '../commands/skill-commands.js';
import { scanSecrets } from '../core/security.js';

/** Handler for native Telegram /command messages. */
export type TelegramCommandHandler = (
  commandName: string,
  chatId: string,
  author: { id: string; name: string; meta?: Record<string, unknown> },
) => Promise<string | null>;

/** Mask a name for privacy: keep first 2 and last 3 chars, replace middle with ***. */
function maskName(name: string): string {
  if (name.length <= 5) return name[0] + '***' + name[name.length - 1];
  return name.slice(0, 2) + '***' + name.slice(-3);
}

export interface TelegramChannelOpts {
  token: string;
  allowedUsers?: string[];
}

export class TelegramChannel implements Channel {
  id = 'telegram';
  agentId?: string;
  private token: string;
  private allowedUsers?: Set<string>;
  private bot: Bot | null = null;
  private handlers: MessageHandler[] = [];
  private commandHandler: TelegramCommandHandler | null = null;
  private nativeCommands: Array<{ name: string; description: string }> = [];
  private running = false;
  private activeChatIds = new Set<string>();
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 5000;

  constructor(opts: TelegramChannelOpts) {
    this.token = opts.token;
    this.allowedUsers = opts.allowedUsers ? new Set(opts.allowedUsers) : undefined;
  }

  /** Set native commands and their handler. Call before connect(). */
  setCommands(
    commands: Array<{ name: string; description: string }>,
    handler: TelegramCommandHandler,
  ): void {
    this.nativeCommands = commands;
    this.commandHandler = handler;
  }

  /**
   * Register skill commands as Telegram bot commands.
   * Merges skill specs with existing native commands, updates bot menu.
   * Call after connect() when skills are loaded.
   */
  async registerSkillCommands(
    specs: SkillCommandSpec[],
    handler: TelegramCommandHandler,
  ): Promise<void> {
    const existingNames = new Set(this.nativeCommands.map((c) => c.name));
    const newCommands = specs
      .filter((s) => !existingNames.has(s.name))
      .map((s) => ({ name: s.name, description: s.description }));

    this.nativeCommands = [...this.nativeCommands, ...newCommands];
    this.commandHandler = handler;

    // Update bot menu if already connected
    if (this.bot) {
      const menuCommands = this.nativeCommands.map((c) => ({
        command: c.name,
        description: c.description,
      }));
      await this.bot.api.setMyCommands(menuCommands).catch((err) => {
        console.warn('[telegram] Failed to update skill commands:', err instanceof Error ? err.message : err);
      });
    }
  }

  async connect(): Promise<void> {
    this.bot = new Bot(this.token);

    // Register native bot.command() handlers for each known command
    // These fire BEFORE the generic message:text handler, so commands
    // get handled directly without going through the message pipeline.
    if (this.commandHandler && this.nativeCommands.length > 0) {
      const handler = this.commandHandler;
      for (const cmd of this.nativeCommands) {
        this.bot.command(cmd.name, async (ctx: GrammyCommandContext<Context>) => {
          if (!ctx.from) return;

          // Filter by allowed users
          if (this.allowedUsers) {
            const userId = ctx.from.id.toString();
            const username = ctx.from.username;
            if (!this.allowedUsers.has(userId) && (!username || !this.allowedUsers.has(username))) {
              return;
            }
          }

          const authorName = [ctx.from.first_name, ctx.from.last_name].filter(Boolean).join(' ') || ctx.from.username || 'Unknown';
          const chatId = ctx.chat.id.toString();

          const result = await handler(cmd.name, chatId, {
            id: ctx.from.id.toString(),
            name: authorName,
            meta: {
              username: ctx.from.username,
              chatType: ctx.chat.type,
            },
          });

          if (result) {
            try {
              await ctx.reply(result, { parse_mode: 'Markdown' });
            } catch {
              await ctx.reply(result);
            }
          }
        });
      }
    }

    // Handle text messages
    this.bot.on('message:text', async (ctx: Context) => {
      await this.handleMessage(ctx);
    });

    // Handle photos
    this.bot.on('message:photo', async (ctx: Context) => {
      await this.handleMessage(ctx);
    });

    // Handle documents
    this.bot.on('message:document', async (ctx: Context) => {
      await this.handleMessage(ctx);
    });

    // Error handling with reconnect
    this.bot.catch((err) => {
      console.error('[telegram] Bot error:', err.message ?? err);
      // If the bot stops unexpectedly, attempt reconnect
      if (this.running && !this.bot?.isInited()) {
        this.attemptReconnect();
      }
    });

    // Register slash commands in bot menu (use dynamic list if set, fallback to defaults)
    const menuCommands = this.nativeCommands.length > 0
      ? this.nativeCommands.map((c) => ({ command: c.name, description: c.description }))
      : [
          { command: 'status', description: 'Show agent status' },
          { command: 'help', description: 'List commands' },
          { command: 'new', description: 'Start a new session' },
          { command: 'compact', description: 'Compact session history' },
          { command: 'model', description: 'Show/switch model' },
          { command: 'agents', description: 'List agents' },
        ];
    this.bot.api.setMyCommands(menuCommands).catch((err) => {
      console.warn('[telegram] Failed to register bot commands:', err instanceof Error ? err.message : err);
    });

    // Start long polling (non-blocking)
    this.running = true;
    this.reconnectAttempts = 0;
    this.bot.start({
      onStart: (botInfo) => {
        this.reconnectAttempts = 0;
        console.log(`[telegram] ✦ Connected as @${maskName(botInfo.username ?? '')}`);
      },
    });
  }

  async disconnect(): Promise<void> {
    if (this.bot && this.running) {
      this.running = false;
      await this.bot.stop();
      this.bot = null;
      console.log('[telegram] Disconnected');
    }
  }

  /** Broadcast a system message to known Telegram chats. */
  async broadcast(text: string): Promise<void> {
    if (!this.bot) return;
    // Send to all chats we've seen (stored in activeChatIds)
    for (const chatId of this.activeChatIds) {
      try {
        await this.bot.api.sendMessage(chatId, text);
      } catch { /* chat may no longer exist */ }
    }
  }

  async send(msg: OutboundMessage): Promise<void> {
    if (!this.bot) throw new Error('[telegram] Not connected');

    const chatId = msg.target;
    const MAX_TG_LENGTH = 4096;
    // Scan for secrets before sending
    const safeContent = scanSecrets(msg.content);
    const chunks = this.splitMessage(safeContent, MAX_TG_LENGTH);
    const bot = this.bot;

    for (let i = 0; i < chunks.length; i++) {
      const opts: Record<string, unknown> = { parse_mode: 'Markdown' as const };
      if (i === 0 && msg.replyTo) {
        opts.reply_to_message_id = parseInt(msg.replyTo, 10);
      }

      await withRetry(
        async () => {
          try {
            await bot.api.sendMessage(chatId, chunks[i], opts);
          } catch (err: unknown) {
            // Check if this is a Markdown parse error (not retryable, use fallback)
            const isParseError = err instanceof Error &&
              (err.message.includes("can't parse") || err.message.includes('Bad Request'));
            if (isParseError) {
              const plainOpts: Record<string, unknown> = {};
              if (i === 0 && msg.replyTo) {
                plainOpts.reply_to_message_id = parseInt(msg.replyTo, 10);
              }
              await bot.api.sendMessage(chatId, chunks[i], plainOpts);
              return;
            }
            throw err;
          }
        },
        TELEGRAM_RETRY,
        `send chunk ${i + 1}/${chunks.length}`,
      );
    }
  }

  async sendAndGetId(msg: OutboundMessage): Promise<string> {
    if (!this.bot) throw new Error('[telegram] Not connected');

    const chatId = msg.target;
    const opts: Record<string, unknown> = { parse_mode: 'Markdown' as const };
    if (msg.replyTo) {
      opts.reply_to_message_id = parseInt(msg.replyTo, 10);
    }

    let sent: { message_id: number };
    try {
      sent = await this.bot.api.sendMessage(chatId, msg.content, opts);
    } catch (err: unknown) {
      const isParseError = err instanceof Error &&
        (err.message.includes("can't parse") || err.message.includes('Bad Request'));
      if (isParseError) {
        const plainOpts: Record<string, unknown> = {};
        if (msg.replyTo) {
          plainOpts.reply_to_message_id = parseInt(msg.replyTo, 10);
        }
        sent = await this.bot.api.sendMessage(chatId, msg.content, plainOpts);
      } else {
        throw err;
      }
    }
    return sent.message_id.toString();
  }

  async editMessage(chatId: string, messageId: string, content: string): Promise<void> {
    if (!this.bot) throw new Error('[telegram] Not connected');

    try {
      await this.bot.api.editMessageText(chatId, parseInt(messageId, 10), content, {
        parse_mode: 'Markdown',
      });
    } catch (err: unknown) {
      // Fallback to plain text on Markdown parse errors
      const isParseError = err instanceof Error &&
        (err.message.includes("can't parse") || err.message.includes('Bad Request'));
      if (isParseError) {
        await this.bot.api.editMessageText(chatId, parseInt(messageId, 10), content);
      } else {
        throw err;
      }
    }
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }

  /** Get the underlying grammY Bot instance (for advanced operations). */
  getBot(): Bot | null {
    return this.bot;
  }

  /** Send a message to a specific chat ID. */
  async sendToChannel(channelId: string, content: string): Promise<void> {
    await this.sendToChat(channelId, content);
  }

  async sendToChat(chatId: string, content: string): Promise<string> {
    if (!this.bot) throw new Error('[telegram] Not connected');

    const MAX_TG_LENGTH = 4096;
    const chunks = this.splitMessage(content, MAX_TG_LENGTH);
    let lastMessageId = '';

    for (const chunk of chunks) {
      try {
        const msg = await this.bot.api.sendMessage(chatId, chunk, { parse_mode: 'Markdown' });
        lastMessageId = msg.message_id.toString();
      } catch {
        const msg = await this.bot.api.sendMessage(chatId, chunk);
        lastMessageId = msg.message_id.toString();
      }
    }

    return lastMessageId;
  }

  async sendTyping(chatId: string): Promise<void> {
    if (!this.bot) return;

    try {
      await this.bot.api.sendChatAction(chatId, 'typing');
    } catch (err) {
      console.error('[telegram] sendTyping error:', err instanceof Error ? err.message : err);
    }
  }

  // Telegram only allows specific emoji for reactions.
  // Map common emoji to Telegram-compatible ones.
  private static readonly TELEGRAM_EMOJI_MAP: Record<string, string> = {
    '🤔': '🤔',
    '✅': '👍',
    '❌': '👎',
    '👀': '👀',
    '🔥': '🔥',
    '❤️': '❤',
    '🎉': '🎉',
    '💯': '💯',
  };

  // Telegram allowed reactions (subset — bot must have permission)
  private static readonly TELEGRAM_ALLOWED = new Set([
    '👍', '👎', '❤', '🔥', '🥰', '👏', '😁', '🤔', '🤯', '😱',
    '🤬', '😢', '🎉', '🤩', '🤮', '💩', '🙏', '👌', '🕊', '🤡',
    '🥱', '🥴', '😍', '🐳', '❤‍🔥', '🌚', '🌭', '💯', '🤣', '⚡',
    '🍌', '🏆', '💔', '🤨', '😐', '🍓', '🍾', '💋', '🖕', '😈',
    '😴', '😭', '🤓', '👻', '👨‍💻', '👀', '🎃', '🙈', '😇', '😨',
    '🤝', '✍', '🤗', '🫡', '🎅', '🎄', '☃', '💅', '🤪', '🗿',
    '🆒', '💘', '🙉', '🦄', '😘', '💊', '🙊', '😎', '👾', '🤷',
    '🤷‍♂', '🤷‍♀', '😡',
  ]);

  async addReaction(chatId: string, messageId: string, emoji: string): Promise<void> {
    if (!this.bot) return;

    // Map or validate emoji
    const mapped = TelegramChannel.TELEGRAM_EMOJI_MAP[emoji] ?? emoji;
    if (!TelegramChannel.TELEGRAM_ALLOWED.has(mapped)) {
      // Silently skip unsupported reactions
      return;
    }

    try {
      await this.bot.api.setMessageReaction(chatId, parseInt(messageId, 10), [
        { type: 'emoji', emoji: mapped } as ReactionType,
      ]);
    } catch {
      // Silently ignore reaction errors (bot may lack permissions)
    }
  }

  async removeReaction(chatId: string, messageId: string, _emoji: string): Promise<void> {
    if (!this.bot) return;

    try {
      // Empty array removes all bot reactions
      await this.bot.api.setMessageReaction(chatId, parseInt(messageId, 10), []);
    } catch {
      // Silently ignore — bot may lack reaction permissions
    }
  }

  private async handleMessage(ctx: Context): Promise<void> {
    if (!ctx.message || !ctx.from) return;

    // Filter by allowed users
    if (this.allowedUsers) {
      const userId = ctx.from.id.toString();
      const username = ctx.from.username;
      if (!this.allowedUsers.has(userId) && (!username || !this.allowedUsers.has(username))) {
        return;
      }
    }

    const inbound = this.convertInbound(ctx);
    this.activeChatIds.add(ctx.message.chat.id.toString());
    for (const handler of this.handlers) {
      try {
        await handler(inbound);
      } catch (err) {
        console.error('[telegram] Handler error:', err instanceof Error ? err.message : err);
      }
    }
  }

  private convertInbound(ctx: Context): InboundMessage {
    const message = ctx.message!;
    const from = ctx.from!;

    const authorName = [from.first_name, from.last_name].filter(Boolean).join(' ') || from.username || 'Unknown';

    const inbound: InboundMessage = {
      id: message.message_id.toString(),
      channelId: `telegram:${message.chat.id}`,
      author: {
        id: from.id.toString(),
        name: authorName,
        meta: {
          username: from.username,
          chatType: message.chat.type,
          chatTitle: 'title' in message.chat ? message.chat.title : undefined,
        },
      },
      content: message.text || message.caption || '',
      timestamp: new Date(message.date * 1000).toISOString(),
      raw: ctx,
      // Forum topic thread ID (supergroups with topics enabled)
      threadId: (message as any).message_thread_id?.toString(),
    };

    const attachments: InboundMessage['attachments'] = [];

    if (message.photo && message.photo.length > 0) {
      const largest = message.photo[message.photo.length - 1];
      attachments.push({
        type: 'image',
        filename: `photo_${largest.file_id}.jpg`,
      });
    }

    if (message.document) {
      attachments.push({
        type: 'file',
        filename: message.document.file_name ?? `doc_${message.document.file_id}`,
        mimeType: message.document.mime_type ?? undefined,
      });
    }

    if (message.audio) {
      attachments.push({
        type: 'audio',
        filename: message.audio.file_name ?? `audio_${message.audio.file_id}`,
        mimeType: message.audio.mime_type ?? undefined,
      });
    }

    if (message.video) {
      attachments.push({
        type: 'video',
        filename: message.video.file_name ?? `video_${message.video.file_id}`,
        mimeType: message.video.mime_type ?? undefined,
      });
    }

    if (attachments.length > 0) {
      inbound.attachments = attachments;
    }

    return inbound;
  }

  private attemptReconnect(): void {
    if (!this.running) return;

    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      console.error('[telegram] Max reconnection attempts reached — scheduling final retry in 5 minutes');
      setTimeout(() => {
        if (!this.running) return;
        this.reconnectAttempts = 0;
        try {
          this.bot = new Bot(this.token);
          this.bot.catch((err) => {
            console.error('[telegram] Bot error:', err.message ?? err);
          });
          this.bot.on('message:text', async (ctx: Context) => {
            await this.handleMessage(ctx);
          });
          this.bot.start({
            onStart: (botInfo) => {
              this.reconnectAttempts = 0;
              console.log(`[telegram] ✦ Reconnected as @${maskName(botInfo.username ?? '')}`);
            },
          });
        } catch (err) {
          console.error('[telegram] Final reconnection failed:', err instanceof Error ? err.message : err);
          console.error('[telegram] CRITICAL: Telegram channel is offline. Process will continue for other channels.');
        }
      }, 5 * 60 * 1000);
      return;
    }

    this.reconnectAttempts++;
    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts - 1);
    console.log(`[telegram] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    setTimeout(() => {
      if (!this.running) return;
      try {
        this.bot = new Bot(this.token);
        this.bot.catch((err) => {
          console.error('[telegram] Bot error:', err.message ?? err);
          if (this.running) this.attemptReconnect();
        });
        this.bot.on('message:text', async (ctx: Context) => {
          await this.handleMessage(ctx);
        });
        this.bot.start({
          onStart: (botInfo) => {
            this.reconnectAttempts = 0;
            console.log(`[telegram] ✦ Reconnected as @${maskName(botInfo.username ?? '')}`);
          },
        });
      } catch (err) {
        console.error('[telegram] Reconnection failed:', err instanceof Error ? err.message : err);
        this.attemptReconnect();
      }
    }, delay);
  }

  private splitMessage(content: string, maxLen: number): string[] {
    if (content.length <= maxLen) return [content];

    const chunks: string[] = [];
    let remaining = content;

    while (remaining.length > 0) {
      if (remaining.length <= maxLen) {
        chunks.push(remaining);
        break;
      }

      let splitAt = remaining.lastIndexOf('\n', maxLen);
      if (splitAt === -1 || splitAt < maxLen / 2) {
        splitAt = remaining.lastIndexOf(' ', maxLen);
      }
      if (splitAt === -1 || splitAt < maxLen / 2) {
        splitAt = maxLen;
      }

      chunks.push(remaining.slice(0, splitAt));
      remaining = remaining.slice(splitAt).trimStart();
    }

    return chunks;
  }
}
