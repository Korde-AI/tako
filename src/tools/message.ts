/**
 * Message tool — channel management and messaging operations.
 *
 * Provides the agent with the ability to:
 * - Send messages to Discord/Telegram channels
 * - Create, edit, and delete Discord channels
 * - Create threads in Discord channels
 * - React to messages with emoji
 *
 * This is the tool for all messaging and channel management operations.
 * Do NOT confuse with skill-creator (which creates skills) or agents_add (which creates agents).
 *
 * Target resolution:
 * - Pass "current" (or omit target) on a "send" action to reply in the
 *   same channel/chat the agent is currently active in. The channel ID
 *   is resolved from the session's ToolContext (ctx.channelTarget).
 */

import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import type { Tool, ToolContext, ToolResult } from './tool.js';
import type { DiscordChannel } from '../channels/discord.js';
import type { TelegramChannel } from '../channels/telegram.js';

export interface MessageToolDeps {
  discord?: DiscordChannel;
  telegram?: TelegramChannel;
  /** Resolve the correct Discord channel for a given agentId at call time. */
  resolveDiscord?: (agentId?: string) => DiscordChannel | undefined;
  /** Resolve the correct Telegram channel for a given agentId at call time. */
  resolveTelegram?: (agentId?: string) => TelegramChannel | undefined;
}

/**
 * Create the message tool bound to channel adapters.
 * Supports per-agent channel resolution via resolveDiscord/resolveTelegram.
 */
export function createMessageTools(deps: MessageToolDeps): Tool[] {
  const { resolveDiscord, resolveTelegram } = deps;

  // Fallback to static channels if resolvers not provided
  const getDiscord = (agentId?: string): DiscordChannel | undefined =>
    resolveDiscord ? resolveDiscord(agentId) : deps.discord;
  const getTelegram = (agentId?: string): TelegramChannel | undefined =>
    resolveTelegram ? resolveTelegram(agentId) : deps.telegram;

  const messageTool: Tool = {
    name: 'message',
    description:
      'Send messages and manage channels on Discord and Telegram. Use this for all messaging operations: sending messages, creating/editing/deleting Discord channels, creating threads, and reacting to messages. This is NOT for creating agents (use agents_add) or skills (use skill-creator).',
    group: 'messaging',
    parameters: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: [
            'send',
            'channel-create',
            'channel-edit',
            'channel-delete',
            'thread-create',
            'react',
          ],
          description: 'The messaging action to perform',
        },
        platform: {
          type: 'string',
          enum: ['discord', 'telegram'],
          description: 'Target platform (discord or telegram)',
        },
        target: {
          type: 'string',
          description: 'Channel ID, chat ID, or guild ID (depends on action). Use "current" to send to the channel this agent is currently active in.',
        },
        message: {
          type: 'string',
          description: 'Message content to send (for "send" action)',
        },
        media: {
          type: 'string',
          description: 'Optional media path or URL to attach (Discord send only)',
        },
        name: {
          type: 'string',
          description: 'Name for new channel or thread (for "channel-create" and "thread-create")',
        },
        topic: {
          type: 'string',
          description: 'Channel topic (for "channel-create" and "channel-edit")',
        },
        guildId: {
          type: 'string',
          description: 'Discord guild/server ID (required for "channel-create")',
        },
        parentId: {
          type: 'string',
          description: 'Parent category ID for channel creation',
        },
        messageId: {
          type: 'string',
          description: 'Message ID (for "react" and optionally "thread-create")',
        },
        emoji: {
          type: 'string',
          description: 'Emoji to react with (for "react" action)',
        },
      },
      required: ['action', 'platform'],
    },

    async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
      const p = params as {
        action: string;
        platform: 'discord' | 'telegram';
        target?: string;
        message?: string;
        media?: string;
        name?: string;
        topic?: string;
        guildId?: string;
        parentId?: string;
        messageId?: string;
        emoji?: string;
      };

      // Resolve "current" target → use the session's active channel
      const resolveTarget = (t?: string): string | undefined => {
        if (!t || t === 'current') return ctx.channelTarget as string | undefined;
        return t;
      };

      // Resolve per-agent channels at call time using ctx.agentId
      const discord = getDiscord(ctx.agentId);
      const telegram = getTelegram(ctx.agentId);

      // Validate platform availability
      if (p.platform === 'discord' && !discord) {
        return { output: '', success: false, error: 'Discord channel is not configured or connected for this agent.' };
      }
      if (p.platform === 'telegram' && !telegram) {
        return { output: '', success: false, error: 'Telegram channel is not configured or connected for this agent.' };
      }

      try {
        switch (p.action) {
          // ─── send ──────────────────────────────────────────────
          case 'send': {
            const target = resolveTarget(p.target);
            if (!target) return { output: '', success: false, error: 'target (channel/chat ID) is required for send — or use "current" to send to the active channel' };
            if (!p.message && !p.media) return { output: '', success: false, error: 'message or media is required for send' };

            if (p.platform === 'discord') {
              if (p.media) {
                const isUrl = /^https?:\/\//i.test(p.media);
                const attachments: import('../channels/channel.js').Attachment[] = [];
                if (isUrl) {
                  attachments.push({ type: 'file', url: p.media, filename: basename(new URL(p.media).pathname) || 'attachment' });
                } else {
                  const data = await readFile(p.media);
                  attachments.push({ type: 'file', data, filename: basename(p.media) || 'attachment' });
                }

                const msgId = await discord!.sendAndGetId!({
                  target,
                  content: p.message ?? '',
                  attachments,
                });
                return {
                  output: JSON.stringify({ sent: true, platform: 'discord', channelId: target, messageId: msgId, attached: true, agentId: ctx.agentId }),
                  success: true,
                };
              }

              const msgId = await discord!.sendToChannel(target, p.message ?? '');
              return {
                output: JSON.stringify({ sent: true, platform: 'discord', channelId: target, messageId: msgId, agentId: ctx.agentId }),
                success: true,
              };
            } else {
              if (p.media) {
                return { output: '', success: false, error: 'media attachments are currently supported for Discord only' };
              }
              const msgId = await telegram!.sendToChat(target, p.message ?? '');
              return {
                output: JSON.stringify({ sent: true, platform: 'telegram', chatId: target, messageId: msgId, agentId: ctx.agentId }),
                success: true,
              };
            }
          }

          // ─── channel-create ────────────────────────────────────
          case 'channel-create': {
            if (p.platform !== 'discord') {
              return { output: '', success: false, error: 'channel-create is only supported on Discord' };
            }
            if (!p.guildId) return { output: '', success: false, error: 'guildId is required for channel-create' };
            if (!p.name) return { output: '', success: false, error: 'name is required for channel-create' };

            const channel = await discord!.createChannel(p.guildId, p.name, {
              topic: p.topic,
              parentId: p.parentId,
            });

            return {
              output: JSON.stringify({ created: true, platform: 'discord', channelId: channel.id, channelName: channel.name }),
              success: true,
            };
          }

          // ─── channel-edit ──────────────────────────────────────
          case 'channel-edit': {
            if (p.platform !== 'discord') {
              return { output: '', success: false, error: 'channel-edit is only supported on Discord' };
            }
            if (!p.target) return { output: '', success: false, error: 'target (channel ID) is required for channel-edit' };

            await discord!.editChannel(p.target, {
              name: p.name,
              topic: p.topic,
            });

            return {
              output: JSON.stringify({ edited: true, platform: 'discord', channelId: p.target }),
              success: true,
            };
          }

          // ─── channel-delete ────────────────────────────────────
          case 'channel-delete': {
            if (p.platform !== 'discord') {
              return { output: '', success: false, error: 'channel-delete is only supported on Discord' };
            }
            if (!p.target) return { output: '', success: false, error: 'target (channel ID) is required for channel-delete' };

            await discord!.deleteChannel(p.target);

            return {
              output: JSON.stringify({ deleted: true, platform: 'discord', channelId: p.target }),
              success: true,
            };
          }

          // ─── thread-create ─────────────────────────────────────
          case 'thread-create': {
            if (p.platform !== 'discord') {
              return { output: '', success: false, error: 'thread-create is only supported on Discord' };
            }
            if (!p.target) return { output: '', success: false, error: 'target (channel ID) is required for thread-create' };
            if (!p.name) return { output: '', success: false, error: 'name is required for thread-create' };

            const thread = await discord!.createThread(p.target, p.name, {
              messageId: p.messageId,
            });

            return {
              output: JSON.stringify({ created: true, platform: 'discord', threadId: thread.id, threadName: thread.name }),
              success: true,
            };
          }

          // ─── react ─────────────────────────────────────────────
          case 'react': {
            if (p.platform !== 'discord') {
              return { output: '', success: false, error: 'react is only supported on Discord' };
            }
            if (!p.target) return { output: '', success: false, error: 'target (channel ID) is required for react' };
            if (!p.messageId) return { output: '', success: false, error: 'messageId is required for react' };
            if (!p.emoji) return { output: '', success: false, error: 'emoji is required for react' };

            await discord!.react(p.target, p.messageId, p.emoji);

            return {
              output: JSON.stringify({ reacted: true, platform: 'discord', channelId: p.target, messageId: p.messageId, emoji: p.emoji }),
              success: true,
            };
          }

          default:
            return { output: '', success: false, error: `Unknown action: ${p.action}. Supported: send, channel-create, channel-edit, channel-delete, thread-create, react` };
        }
      } catch (err) {
        return {
          output: '',
          success: false,
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  };

  return [messageTool];
}
