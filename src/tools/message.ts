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
import type {
  MessageSurface,
  MessageSurfacePlatform,
} from '../channels/surface-capabilities.js';

export interface MessageToolDeps {
  /** Resolve the correct messaging surface for a given platform and agent at call time. */
  resolveSurface: (platform: MessageSurfacePlatform, agentId?: string) => MessageSurface | undefined;
}

/**
 * Create the message tool bound to messaging surface capabilities.
 * The tool layer does not depend directly on Discord/Telegram implementations.
 */
export function createMessageTools(deps: MessageToolDeps): Tool[] {
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
        private: {
          type: 'boolean',
          description: 'When true for Discord channel-create, create a private channel visible to the current requester and bot only',
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
        private?: boolean;
      };

      // Resolve "current" target → use the session's active channel
      const resolveTarget = (t?: string): string | undefined => {
        if (!t || t === 'current') return ctx.channelTarget as string | undefined;
        return t;
      };
      const executionMeta = ctx.executionContext?.metadata ?? {};
      const inferDiscordGuildId = (): string | undefined => {
        const fromExecution = typeof executionMeta['guildId'] === 'string' ? executionMeta['guildId'] : undefined;
        const fromMeta = typeof ctx.meta?.['guildId'] === 'string' ? String(ctx.meta['guildId']) : undefined;
        return p.guildId ?? fromExecution ?? fromMeta;
      };
      const inferDiscordParentId = (): string | undefined => {
        const fromExecution = typeof executionMeta['parentChannelId'] === 'string' ? executionMeta['parentChannelId'] : undefined;
        const fromTarget = ctx.channelTarget;
        return p.parentId ?? fromExecution ?? (typeof fromTarget === 'string' ? fromTarget : undefined);
      };

      const resolveSurface = (): MessageSurface | undefined => deps.resolveSurface(p.platform, ctx.agentId);

      // Validate platform availability
      const surface = resolveSurface();
      if (!surface) {
        return {
          output: '',
          success: false,
          error: `${p.platform === 'discord' ? 'Discord' : 'Telegram'} channel is not configured or connected for this agent.`,
        };
      }

      try {
        switch (p.action) {
          // ─── send ──────────────────────────────────────────────
          case 'send': {
            const target = resolveTarget(p.target);
            if (!target) return { output: '', success: false, error: 'target (channel/chat ID) is required for send — or use "current" to send to the active channel' };
            if (!p.message && !p.media) return { output: '', success: false, error: 'message or media is required for send' };

            const attachments: import('../channels/channel.js').Attachment[] = [];
            if (p.media) {
              const isUrl = /^https?:\/\//i.test(p.media);
              if (isUrl) {
                attachments.push({ type: 'file', url: p.media, filename: basename(new URL(p.media).pathname) || 'attachment' });
              } else {
                const data = await readFile(p.media);
                attachments.push({ type: 'file', data, filename: basename(p.media) || 'attachment' });
              }
            }

            const result = await surface.send({
              target,
              content: p.message ?? '',
              attachments,
            });
            return {
              output: JSON.stringify({
                sent: true,
                platform: p.platform,
                channelId: target,
                chatId: p.platform === 'telegram' ? target : undefined,
                messageId: result.messageId,
                attached: attachments.length > 0,
                agentId: ctx.agentId,
              }),
              success: true,
            };
          }

          // ─── channel-create ────────────────────────────────────
          case 'channel-create': {
            if (!surface.createChannel) {
              return { output: '', success: false, error: 'channel-create is only supported on Discord' };
            }
            const guildId = inferDiscordGuildId();
            if (!guildId) {
              return {
                output: '',
                success: false,
                error: 'guildId is required for channel-create unless the current Discord guild context is available',
              };
            }
            if (!p.name) return { output: '', success: false, error: 'name is required for channel-create' };

            const channel = await surface.createChannel({
              guildId,
              name: p.name,
              topic: p.topic,
              parentId: inferDiscordParentId(),
              privateUserId: p.private ? ctx.executionContext?.authorId : undefined,
            });

            return {
              output: JSON.stringify({
                created: true,
                platform: 'discord',
                guildId,
                channelId: channel.id,
                channelName: channel.name,
              }),
              success: true,
            };
          }

          // ─── channel-edit ──────────────────────────────────────
          case 'channel-edit': {
            if (!surface.editChannel) {
              return { output: '', success: false, error: 'channel-edit is only supported on Discord' };
            }
            if (!p.target) return { output: '', success: false, error: 'target (channel ID) is required for channel-edit' };

            await surface.editChannel({
              channelId: p.target,
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
            if (!surface.deleteChannel) {
              return { output: '', success: false, error: 'channel-delete is only supported on Discord' };
            }
            if (!p.target) return { output: '', success: false, error: 'target (channel ID) is required for channel-delete' };

            await surface.deleteChannel(p.target);

            return {
              output: JSON.stringify({ deleted: true, platform: 'discord', channelId: p.target }),
              success: true,
            };
          }

          // ─── thread-create ─────────────────────────────────────
          case 'thread-create': {
            if (!surface.createThread) {
              return { output: '', success: false, error: 'thread-create is only supported on Discord' };
            }
            if (!p.target) return { output: '', success: false, error: 'target (channel ID) is required for thread-create' };
            if (!p.name) return { output: '', success: false, error: 'name is required for thread-create' };

            const thread = await surface.createThread({
              channelId: p.target,
              name: p.name,
              messageId: p.messageId,
            });

            return {
              output: JSON.stringify({ created: true, platform: 'discord', threadId: thread.id, threadName: thread.name }),
              success: true,
            };
          }

          // ─── react ─────────────────────────────────────────────
          case 'react': {
            if (!surface.react) {
              return { output: '', success: false, error: 'react is only supported on Discord' };
            }
            if (!p.target) return { output: '', success: false, error: 'target (channel ID) is required for react' };
            if (!p.messageId) return { output: '', success: false, error: 'messageId is required for react' };
            if (!p.emoji) return { output: '', success: false, error: 'emoji is required for react' };

            await surface.react({
              channelId: p.target,
              messageId: p.messageId,
              emoji: p.emoji,
            });

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
