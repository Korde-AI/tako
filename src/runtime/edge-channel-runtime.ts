import type { Channel, InboundMessage } from '../channels/channel.js';
import { inferChannelPlatformFromChannelId, type ChannelPlatformRegistry } from '../channels/platforms.js';
import type { TakoConfig } from '../config/schema.js';
import type { AuditLogger } from '../core/audit.js';
import { toAuditContext, toCommandContext, type ExecutionContext } from '../core/execution-context.js';
import { MessageQueue, type QueuedMessage } from '../core/message-queue.js';
import type { AgentLoop } from '../core/agent-loop.js';
import type { Session, SessionManager } from '../gateway/session.js';
import type { HookSystem } from '../hooks/types.js';
import type { ProjectMembershipRegistry } from '../projects/memberships.js';
import { getProjectRole, isProjectMember } from '../projects/access.js';
import type { DeliveryQueue } from '../channels/delivery-queue.js';
import type { CommandRegistry } from '../commands/registry.js';
import type { ProjectRuntime, ResolvedProjectBinding } from './project-runtime-types.js';
import type { EdgeSessionRuntime } from './edge-session-runtime.js';

interface EdgeChannelRuntimeInput {
  config: TakoConfig;
  audit: AuditLogger;
  hooks: Pick<HookSystem, 'emit'>;
  sessions: SessionManager;
  projectMemberships: ProjectMembershipRegistry;
  commandRegistry: CommandRegistry;
  messageQueue: MessageQueue;
  deliveryQueue: DeliveryQueue;
  channelPlatforms: ChannelPlatformRegistry;
  defaultModel: string;
  activeProcessingSessions: Set<string>;
  resolvePrincipal: EdgeSessionRuntime['resolvePrincipal'];
  buildInboundExecutionContext: EdgeSessionRuntime['buildInboundExecutionContext'];
  applyExecutionContextToSession: EdgeSessionRuntime['applyExecutionContextToSession'];
  sanitizeSessionMessages: EdgeSessionRuntime['sanitizeSessionMessages'];
  getSession: EdgeSessionRuntime['getSession'];
  resolveProject: ProjectRuntime['resolveProject'];
  buildAgentAccessMetadata: ProjectRuntime['buildAgentAccessMetadata'];
  isDiscordInvocationAllowed: ProjectRuntime['isDiscordInvocationAllowed'];
  autoEnrollProjectRoomParticipant: ProjectRuntime['autoEnrollProjectRoomParticipant'];
  sweepProjectRoomSignal: ProjectRuntime['sweepProjectRoomSignal'];
  resolveInboundAgentId(input: {
    channel: Channel;
    channelType: string;
    channelTarget: string;
    guildId?: string;
  }): string;
  shouldThrottlePeerAgentMessage(input: {
    targetAgentId: string;
    authorId: string;
    channelId: string;
    isBot: boolean;
  }): boolean;
  getAgentLoop(agentId?: string): AgentLoop;
  persistInboundAttachments(attachments: NonNullable<InboundMessage['attachments']>): Promise<NonNullable<InboundMessage['attachments']>>;
  shutdown(): Promise<void>;
  formatUserFacingAgentError(err: unknown): string;
}

export function createEdgeChannelRuntime(input: EdgeChannelRuntimeInput) {
  const wireChannel = (channel: Channel): void => {
    input.deliveryQueue.registerChannel(channel);
    channel.onMessage(async (msg: InboundMessage) => {
      try {
        const principal = await input.resolvePrincipal(msg);
        const channelType = inferChannelPlatformFromChannelId(msg.channelId, input.channelPlatforms, channel.id);
        const channelTarget = msg.channelId.includes(':')
          ? msg.channelId.split(':').slice(1).join(':')
          : msg.channelId;
        const projectChannelTarget = (msg.author.meta?.parentChannelId as string | undefined) ?? channelTarget;
        const guildId = msg.author.meta?.guildId as string | undefined;
        const inboundAgentId = input.resolveInboundAgentId({
          channel,
          channelType,
          channelTarget,
          guildId,
        });
        const isBotOrigin = msg.author.meta?.isBot === true;
        if (input.shouldThrottlePeerAgentMessage({
          targetAgentId: inboundAgentId,
          authorId: msg.author.id,
          channelId: msg.channelId,
          isBot: isBotOrigin,
        })) {
          console.warn(`[discord-peer-loop] throttled bot-authored message agent=${inboundAgentId} author=${msg.author.id} channel=${msg.channelId}`);
          return;
        }
        const resolvedProject = input.resolveProject({
          platform: channelType,
          channelTarget: projectChannelTarget,
          threadId: msg.threadId,
          agentId: inboundAgentId,
        });
        if (channelType === 'discord') {
          const discordPolicy = await input.isDiscordInvocationAllowed({
            agentId: inboundAgentId,
            authorId: msg.author.id,
            authorName: msg.author.name,
            username: typeof msg.author.meta?.username === 'string' ? msg.author.meta.username : undefined,
            principalId: principal.principalId,
            channelName: typeof msg.author.meta?.channelName === 'string' ? msg.author.meta.channelName : undefined,
            parentChannelName: typeof msg.author.meta?.parentChannelName === 'string' ? msg.author.meta.parentChannelName : undefined,
            project: resolvedProject?.project ?? null,
          });
          if (!discordPolicy.allowed) {
            console.log(
              `[discord-auth] blocked message agent=${inboundAgentId} user=${msg.author.id} principal=${principal.principalId} ` +
              `channel=${msg.channelId} name=${String(msg.author.meta?.channelName ?? '')} ` +
              `parent=${String(msg.author.meta?.parentChannelName ?? '')} reason=${discordPolicy.reason}`,
            );
            return;
          }
        }
        const projectRole = resolvedProject
          ? getProjectRole(input.projectMemberships, resolvedProject.project.projectId, principal.principalId) ?? undefined
          : undefined;
        const accessMetadata = await input.buildAgentAccessMetadata({
          platform: channelType,
          agentId: inboundAgentId,
          authorId: msg.author.id,
          principalId: principal.principalId,
          project: resolvedProject?.project ?? null,
          metadata: { ...(msg.author.meta ?? {}) },
        });
        const inboundContext = input.buildInboundExecutionContext({
          agentId: inboundAgentId,
          principal,
          authorId: msg.author.id,
          authorName: msg.author.name,
          platform: channelType,
          channelId: msg.channelId,
          channelTarget,
          threadId: msg.threadId,
          project: resolvedProject?.project ?? null,
          projectRole: projectRole ?? null,
          metadata: accessMetadata,
        });
        const inboundText = typeof msg.content === 'string' ? msg.content : '';
        await input.hooks.emit('message_received', {
          event: 'message_received',
          data: {
            ...toAuditContext(inboundContext),
            channelId: msg.channelId,
            authorId: msg.author.id,
            content: msg.content,
          },
          timestamp: Date.now(),
        });

        if (channel.id === 'cli' && (inboundText === '/quit' || inboundText === '/exit')) {
          await input.shutdown();
          process.exit(0);
        }

        const aclAgentId = channel.agentId ?? 'main';
        const aclChannel = channel.id;
        if (aclChannel !== 'cli' && aclChannel !== 'tui') {
          const isClaimCommand = inboundText.trim().toLowerCase() === '/claim';
          if (!isClaimCommand) {
            const allowSharedReadonly = resolvedProject != null;
            const allowed = allowSharedReadonly
              ? true
              : (await import('../auth/allow-from.js')).isUserAllowed(aclChannel, aclAgentId, msg.author.id, principal.principalId);
            if (!allowed) return;
          }
        }

        if (resolvedProject && !isProjectMember(input.projectMemberships, resolvedProject.project.projectId, principal.principalId)) {
          const enrolled = await input.autoEnrollProjectRoomParticipant({
            project: resolvedProject.project,
            principalId: principal.principalId,
            principalName: principal.displayName,
            platformUserId: msg.author.id,
            platform: channelType,
            addedBy: resolvedProject.project.ownerPrincipalId,
          });
          if (!enrolled) {
            void input.audit.log({
              ...toAuditContext(inboundContext),
              event: 'permission_denied',
              action: 'project_membership',
              details: { channelId: msg.channelId, authorId: msg.author.id },
              success: false,
            }).catch(() => {});
            return;
          }
        }

        const session = await input.getSession(msg, channel, resolvedProject, accessMetadata);
        if (!session) return;

        const sessionContext = (
          session.metadata.executionContext as ExecutionContext | undefined
        ) ?? {
          ...inboundContext,
          sessionId: session.id,
        };
        input.applyExecutionContextToSession(session, sessionContext, channel);
        session.metadata.messageId = msg.id;

        if (resolvedProject && inboundText.trim()) {
          await input.sweepProjectRoomSignal({
            project: resolvedProject.project,
            principalId: principal.principalId,
            principalName: principal.displayName,
            text: inboundText,
          }).catch(() => {});
        }

        const target = session.metadata.channelTarget as string;

        if (inboundText.trim().startsWith('/')) {
          if (channel.addReaction) channel.addReaction(target, msg.id, '👋').catch(() => {});
          if (channel.addReaction) channel.addReaction(target, msg.id, '🧐').catch(() => {});
          if (channel.removeReaction) channel.removeReaction(target, msg.id, '👋').catch(() => {});

          try {
            const cmdResult = await input.commandRegistry.handle(inboundText, {
              ...toCommandContext(sessionContext),
              session,
            });

            if (cmdResult) {
              if (channel.id === 'cli') {
                process.stdout.write(cmdResult + '\n');
              } else {
                await channel.send({ target, content: cmdResult, replyTo: msg.id });
              }
              if (channel.removeReaction) channel.removeReaction(target, msg.id, '🧐').catch(() => {});
              if (channel.addReaction) channel.addReaction(target, msg.id, '👍').catch(() => {});
              return;
            }

            if (channel.removeReaction) channel.removeReaction(target, msg.id, '🧐').catch(() => {});
            if (channel.addReaction) channel.addReaction(target, msg.id, '🤷').catch(() => {});
          } catch (err) {
            if (channel.removeReaction) channel.removeReaction(target, msg.id, '🧐').catch(() => {});
            if (channel.addReaction) channel.addReaction(target, msg.id, '😅').catch(() => {});
            throw err;
          }
        }

        if (input.messageQueue.getConfig().mode !== 'off' && channel.id !== 'cli' && channel.id !== 'tui') {
          const queuedAttachments = msg.attachments?.length
            ? await input.persistInboundAttachments(msg.attachments)
            : undefined;

          const queued = input.messageQueue.enqueue(session.id, {
            content: inboundText,
            channelId: msg.channelId,
            authorId: msg.author.id,
            principalId: principal.principalId,
            principalName: principal.displayName,
            timestamp: Date.now(),
            messageId: msg.id,
            attachments: queuedAttachments,
          });
          if (queued) {
            if (channel.sendTyping) channel.sendTyping(target).catch(() => {});
            if (channel.addReaction) channel.addReaction(target, msg.id, '💭').catch(() => {});
            return;
          }
        }

        const typingMode = input.config.agent.typingMode ?? 'instant';
        const typingIntervalMs = (input.config.agent.typingIntervalSeconds ?? 6) * 1000;
        let typingInterval: ReturnType<typeof setInterval> | null = null;

        if (typingMode === 'instant' && channel.sendTyping) {
          channel.sendTyping(target).catch(() => {});
          typingInterval = setInterval(() => {
            channel.sendTyping!(target).catch(() => {});
          }, typingIntervalMs);
        }

        if (channel.addReaction) {
          channel.addReaction(target, msg.id, '🧐').catch(() => {});
        }

        let response = '';
        let hadError = false;
        const senderPrefix = channel.id !== 'cli' && msg.author?.name
          ? `[From: ${msg.author.name}]\n`
          : '';
        const userMessage = senderPrefix + inboundText;

        const activeLoop = input.getAgentLoop(channel.agentId ?? session.metadata?.agentId as string | undefined);
        const repaired = input.sanitizeSessionMessages(session);
        if (repaired > 0) {
          console.warn(`[session] Repaired ${repaired} malformed message(s) in ${session.id}`);
        }

        try {
          activeLoop.setChannel(channel);
          const attachments = msg.attachments?.length
            ? await input.persistInboundAttachments(msg.attachments)
            : msg.attachments;

          for await (const chunk of activeLoop.run(session, userMessage, attachments)) {
            if (channel.id === 'cli') {
              process.stdout.write(chunk);
            }
            response += chunk;
          }
        } catch (err) {
          hadError = true;
          const errMsg = err instanceof Error ? err.message : String(err);
          console.error(`[tako] Error: ${errMsg}`);

          const is404 = errMsg.includes('404') || errMsg.includes('not_found');
          if (is404 && !response) {
            const currentModel = activeLoop.getModel();
            const fallbacks = input.config.providers.fallback ?? [];
            const nextFallback = fallbacks.find((fallback) => fallback !== currentModel);
            if (nextFallback) {
              activeLoop.setModel(nextFallback);
              response = `⚠️ Model \`${currentModel}\` not found. Auto-switched to fallback: \`${nextFallback}\`\n\nPlease resend your message, or use \`/model default\` to reset.`;
            } else {
              activeLoop.setModel(input.defaultModel);
              response = `⚠️ Model \`${currentModel}\` not found. Reset to default: \`${input.defaultModel}\`\n\nPlease resend your message.`;
            }
          } else if (!response) {
            response = input.formatUserFacingAgentError(err);
          }
        }

        if (typingInterval) {
          clearInterval(typingInterval);
          typingInterval = null;
        }

        if (channel.id === 'cli') {
          if (response && !response.endsWith('\n')) {
            process.stdout.write('\n');
          }
        } else if (channel.id === 'tui') {
          if (response) {
            await channel.send({ target: msg.channelId, content: response, replyTo: msg.id });
          }
        } else if (response.trim()) {
          void input.hooks.emit('message_sending', {
            event: 'message_sending',
            data: {
              channelId: msg.channelId,
              sessionId: session.id,
              agentId: session.metadata.agentId,
              content: response,
              principalId: session.metadata.principalId,
              principalName: session.metadata.principalName,
              projectId: session.metadata.projectId,
              projectSlug: session.metadata.projectSlug,
              sharedSessionId: session.metadata.sharedSessionId,
              networkSessionId: session.metadata.networkSessionId,
              hostNodeId: session.metadata.hostNodeId,
              participantNodeIds: session.metadata.participantNodeIds,
              participantIds: session.metadata.participantIds,
              target,
            },
            timestamp: Date.now(),
          }).catch(() => {});

          const outMsg = { target, content: response.trim(), replyTo: msg.id };
          try {
            await channel.send(outMsg);
          } catch (sendErr) {
            await input.deliveryQueue.enqueue(channel.id, outMsg, sendErr instanceof Error ? sendErr.message : String(sendErr));
          }
        } else {
          console.error(`[${channel.id}] Empty response for: "${inboundText.slice(0, 50)}" (session ${session.id}, msgs: ${session.messages.length})`);
          const fallbackMsg = { target, content: '🤔 I processed your message but had nothing to say. Try rephrasing?', replyTo: msg.id };
          try {
            await channel.send(fallbackMsg);
          } catch (sendErr) {
            await input.deliveryQueue.enqueue(channel.id, fallbackMsg, sendErr instanceof Error ? sendErr.message : String(sendErr));
          }
        }

        input.sessions.markSessionDirty(session.id);

        if (channel.removeReaction) {
          channel.removeReaction(target, msg.id, '🧐').catch(() => {});
        }
        if (channel.addReaction) {
          channel.addReaction(target, msg.id, hadError ? '😅' : '👍').catch(() => {});
        }
      } catch (outerErr) {
        const errMsg = outerErr instanceof Error ? outerErr.message : String(outerErr);
        console.error(`[tako] Error processing message in ${channel.id}: ${errMsg}`);
        if (outerErr instanceof Error && outerErr.stack) {
          console.error(outerErr.stack);
        }
        if (channel.addReaction) {
          channel.addReaction(
            msg.channelId.includes(':') ? msg.channelId.split(':').slice(1).join(':') : msg.channelId,
            msg.id,
            '😅',
          ).catch(() => {});
        }
      }
    });
  };

  const createMessageQueueProcessor = () => async (sessionId: string, messages: QueuedMessage[]): Promise<void> => {
    try {
      const session = input.sessions.get(sessionId);
      if (!session) {
        console.warn(`[message-queue] Session ${sessionId} not found, dropping ${messages.length} messages`);
        return;
      }

      const merged = MessageQueue.mergeMessages(messages);
      if (!merged.trim()) {
        console.warn(`[message-queue] Empty/invalid batch for session ${sessionId}, skipping`);
        return;
      }

      const channelRef = session.metadata?.channelRef as Channel | undefined;
      if (!channelRef) {
        console.warn(`[message-queue] No channel ref for session ${sessionId}, processing without channel`);
      }

      if (input.activeProcessingSessions.has(sessionId)) {
        console.warn(`[message-queue] Session ${sessionId} already processing — sending busy notice`);
        const target = (session.metadata?.channelTarget as string) ?? '';
        const lastMsgId = messages[messages.length - 1]?.messageId;
        if (channelRef && target) {
          await channelRef.send({
            target,
            content: '⏳ Still working on a previous task — your message has been queued and I\'ll get to it right after.',
            replyTo: lastMsgId,
          }).catch(() => {});
        }
        setTimeout(() => {
          for (const message of messages) input.messageQueue.enqueue(sessionId, message);
        }, 5_000);
        return;
      }

      input.activeProcessingSessions.add(sessionId);

      const activeLoop = input.getAgentLoop(session.metadata?.agentId as string | undefined);
      const repaired = input.sanitizeSessionMessages(session);
      if (repaired > 0) {
        console.warn(`[message-queue] Repaired ${repaired} malformed message(s) in ${session.id}`);
      }

      if (channelRef) {
        activeLoop.setChannel(channelRef);
        session.metadata.channelRef = channelRef;
      }
      const lastMsgId = messages[messages.length - 1]?.messageId;
      if (lastMsgId) {
        session.metadata.messageId = lastMsgId;
      }

      const target = (session.metadata?.channelTarget as string) ?? '';
      const turnTimeoutMs = (input.config.agent?.turnTimeoutSeconds ?? 300) * 1000;
      const mergedAttachments = messages.flatMap((message) => message.attachments ?? []);
      let response = '';
      let hadError = false;

      try {
        const loopPromise = (async () => {
          for await (const chunk of activeLoop.run(session, merged, mergedAttachments)) {
            response += chunk;
          }
        })();

        const timeoutPromise = new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error(`Turn timeout after ${turnTimeoutMs / 1000}s`)), turnTimeoutMs),
        );

        await Promise.race([loopPromise, timeoutPromise]);
      } catch (err) {
        hadError = true;
        const errMsg = err instanceof Error ? err.message : String(err);
        console.error(`[message-queue] Error processing batch for session ${sessionId}: ${errMsg}`);
        if (!response) response = input.formatUserFacingAgentError(err);
      } finally {
        input.activeProcessingSessions.delete(sessionId);
      }

      if (channelRef && target && response.trim()) {
        const replyMsgId = messages[messages.length - 1]?.messageId;
        try {
          await channelRef.send({ target, content: response.trim(), replyTo: replyMsgId });
        } catch (sendErr) {
          console.error('[message-queue] Send error:', sendErr instanceof Error ? sendErr.message : sendErr);
        }

        if (replyMsgId) {
          if (channelRef.removeReaction) channelRef.removeReaction(target, replyMsgId, '💭').catch(() => {});
          if (channelRef.addReaction) channelRef.addReaction(target, replyMsgId, hadError ? '😅' : '👍').catch(() => {});
        }
      }

      input.sessions.markSessionDirty(sessionId);
    } catch (err) {
      console.error(`[message-queue] Unhandled processor error for session ${sessionId}:`, err instanceof Error ? err.message : err);
    }
  };

  return {
    wireChannel,
    createMessageQueueProcessor,
  };
}
