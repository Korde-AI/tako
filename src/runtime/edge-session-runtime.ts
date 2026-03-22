import type { Channel, InboundMessage } from '../channels/channel.js';
import { inferChannelPlatformFromChannelId, type ChannelPlatform, type ChannelPlatformRegistry } from '../channels/platforms.js';
import type { TakoConfig } from '../config/schema.js';
import { buildExecutionContext, toAuditContext, toSessionMetadata, type ExecutionContext } from '../core/execution-context.js';
import type { AuditLogger } from '../core/audit.js';
import type { TakoPaths } from '../core/paths.js';
import type { ThreadBindingManager } from '../core/thread-bindings.js';
import type { Session, SessionManager } from '../gateway/session.js';
import type { HookSystem } from '../hooks/types.js';
import type { NetworkSharedSessionStore } from '../network/shared-sessions.js';
import type { Principal } from '../principals/types.js';
import type { PrincipalRegistry } from '../principals/registry.js';
import { isProjectMember } from '../projects/access.js';
import type { ProjectMembershipRegistry } from '../projects/memberships.js';
import { resolveProjectRoot } from '../projects/root.js';
import type { Project } from '../projects/types.js';
import type { ProjectRegistry } from '../projects/registry.js';
import type { SharedSession, SharedSessionRegistry } from '../sessions/shared.js';
import type { ResolvedProjectBinding } from './project-runtime-types.js';

interface NodeIdentityLike {
  nodeId: string;
}

interface ResolvedPrincipal extends Principal {
  principalId: string;
  displayName: string;
}

interface SharedSessionJoinInput {
  shared: SharedSession;
  ctx: ExecutionContext;
  project: Project | null;
}

interface EdgeSessionRuntimeInput {
  config: TakoConfig;
  runtimePaths: TakoPaths;
  sessions: SessionManager;
  principalRegistry: PrincipalRegistry;
  projectRegistry: ProjectRegistry;
  projectMemberships: ProjectMembershipRegistry;
  sharedSessionRegistry: SharedSessionRegistry;
  networkSharedSessions: NetworkSharedSessionStore;
  threadBindings: ThreadBindingManager;
  channelPlatforms: ChannelPlatformRegistry;
  hooks: Pick<HookSystem, 'emit'>;
  audit: AuditLogger;
  getNodeIdentity: () => NodeIdentityLike;
  resolveAgentId: (input: {
    platform: ChannelPlatform;
    channelTarget: string;
    guildId?: string;
    channelAgentId?: string;
  }) => string;
  onThreadAcpMessage: (input: {
    sessionKey: string;
    content: string;
    channelTarget: string;
    channel?: Channel;
  }) => Promise<boolean>;
  onSharedSessionParticipantJoined: (input: SharedSessionJoinInput) => Promise<void>;
}

export interface EdgeSessionRuntime {
  resolvePrincipal(msg: InboundMessage): Promise<ResolvedPrincipal>;
  buildInboundExecutionContext(input: {
    agentId: string;
    sessionId?: string;
    principal?: ResolvedPrincipal | null;
    authorId: string;
    authorName: string;
    platform: ChannelPlatform;
    channelId: string;
    channelTarget: string;
    threadId?: string;
    project?: Project | null;
    projectRole?: string | null;
    metadata?: Record<string, unknown>;
  }): ExecutionContext;
  applyExecutionContextToSession(session: Session, ctx: ExecutionContext, channel?: Channel): void;
  ensureSharedSession(input: { session: Session; ctx: ExecutionContext }): Promise<SharedSession | null>;
  sanitizeSessionMessages(session: Session): number;
  getSession(
    msg: InboundMessage,
    channel?: Channel,
    resolvedProject?: ResolvedProjectBinding | null,
    accessMetadata?: Record<string, unknown>,
  ): Promise<(Session & { isNew?: boolean }) | null>;
}

export function createEdgeSessionRuntime(input: EdgeSessionRuntimeInput): EdgeSessionRuntime {
  const resolvePrincipal = async (msg: InboundMessage): Promise<ResolvedPrincipal> => {
    const platform = inferChannelPlatformFromChannelId(msg.channelId, input.channelPlatforms);
    const username = typeof msg.author.meta?.username === 'string' ? msg.author.meta.username : undefined;
    const principal = await input.principalRegistry.getOrCreateHuman({
      displayName: msg.author.name,
      platform,
      platformUserId: msg.author.id,
      username,
      metadata: {
        channelId: msg.channelId,
      },
    });
    msg.author.principalId = principal.principalId;
    msg.author.meta = {
      ...msg.author.meta,
      principalId: principal.principalId,
      principalName: principal.displayName,
    };
    return principal;
  };

  const buildInboundExecutionContext = (args: {
    agentId: string;
    sessionId?: string;
    principal?: ResolvedPrincipal | null;
    authorId: string;
    authorName: string;
    platform: ChannelPlatform;
    channelId: string;
    channelTarget: string;
    threadId?: string;
    project?: Project | null;
    projectRole?: string | null;
    metadata?: Record<string, unknown>;
  }): ExecutionContext => {
    const projectRoot = args.project ? resolveProjectRoot(input.runtimePaths, args.project) : undefined;
    return buildExecutionContext({
      nodeIdentity: input.getNodeIdentity() as never,
      home: input.runtimePaths.home,
      agentId: args.agentId,
      workspaceRoot: input.config.memory.workspace,
      projectRoot,
      allowedToolRoot: projectRoot ?? input.config.memory.workspace,
      sessionId: args.sessionId,
      principal: args.principal,
      authorId: args.authorId,
      authorName: args.authorName,
      platform: args.platform,
      platformUserId: args.authorId,
      channelId: args.channelId,
      channelTarget: args.channelTarget,
      threadId: args.threadId,
      project: args.project ?? null,
      projectRole: (args.projectRole as never) ?? null,
      metadata: args.metadata,
    });
  };

  const applyExecutionContextToSession = (session: Session, ctx: ExecutionContext, channel?: Channel): void => {
    const networkSession = (ctx.sharedSessionId ? input.networkSharedSessions.findBySharedSessionId(ctx.sharedSessionId) : null)
      ?? input.networkSharedSessions.findByLocalSessionId(session.id)
      ?? (ctx.projectId
        ? input.networkSharedSessions.findByProject(ctx.projectId).find((candidate) => candidate.participantNodeIds.includes(input.getNodeIdentity().nodeId)) ?? null
        : null);
    if (networkSession) {
      void input.networkSharedSessions.bindLocalSession({
        networkSessionId: networkSession.networkSessionId,
        nodeId: input.getNodeIdentity().nodeId,
        localSessionId: session.id,
        sharedSessionId: ctx.sharedSessionId,
      }).catch(() => {});
      ctx.networkSessionId = networkSession.networkSessionId;
      ctx.hostNodeId = networkSession.hostNodeId;
      ctx.participantNodeIds = networkSession.participantNodeIds;
    }
    Object.assign(session.metadata, toSessionMetadata(ctx), {
      executionContext: ctx,
      ...(channel ? { channelRef: channel } : {}),
    });
  };

  const ensureSharedSession = async ({ session, ctx }: { session: Session; ctx: ExecutionContext }): Promise<SharedSession | null> => {
    if (!ctx.projectId || !ctx.principalId || !ctx.channelTarget || !ctx.platform) {
      return null;
    }

    let shared = input.sharedSessionRegistry.findBySessionId(session.id);
    if (!shared) {
      shared = input.sharedSessionRegistry.findByBinding({
        projectId: ctx.projectId,
        platform: ctx.platform,
        channelTarget: ctx.channelTarget,
        threadId: ctx.threadId,
        agentId: ctx.agentId,
      });
    }
    const project = input.projectRegistry.get(ctx.projectId);
    const collaborationMode = project?.collaboration?.mode ?? 'single-user';
    let participantJoined = false;
    if (!shared) {
      if (collaborationMode !== 'collaborative' && (!project || ctx.principalId === project.ownerPrincipalId)) {
        return null;
      }
      shared = await input.sharedSessionRegistry.create({
        sessionId: session.id,
        agentId: ctx.agentId,
        projectId: ctx.projectId,
        projectSlug: ctx.projectSlug,
        ownerPrincipalId: ctx.principalId,
        initialParticipantId: ctx.principalId,
        binding: {
          platform: ctx.platform,
          channelId: ctx.channelId ?? `${ctx.platform}:${ctx.channelTarget}`,
          channelTarget: ctx.channelTarget,
          threadId: ctx.threadId,
        },
      });
      void input.audit.log({
        ...toAuditContext({
          ...ctx,
          sharedSessionId: shared.sharedSessionId,
          participantIds: shared.participantIds,
        }),
        event: 'session_start',
        action: 'shared_session_create',
        details: {
          ownerPrincipalId: shared.ownerPrincipalId,
        },
        success: true,
      }).catch(() => {});
      participantJoined = true;
    } else {
      participantJoined = !shared.participantIds.includes(ctx.principalId);
      await input.sharedSessionRegistry.touchParticipant(shared.sharedSessionId, ctx.principalId);
    }
    shared = await input.sharedSessionRegistry.setActiveParticipant(shared.sharedSessionId, ctx.principalId);
    if (participantJoined) {
      await input.onSharedSessionParticipantJoined({ shared, ctx, project });
    }
    const refreshedProject = project ?? input.projectRegistry.get(shared.projectId) ?? null;
    if (ctx.platform === 'discord' && refreshedProject && isProjectMember(input.projectMemberships, shared.projectId, ctx.principalId)) {
      // Preserve the shared session but avoid duplicate room notices elsewhere.
    }
    return shared;
  };

  function sanitizeSessionMessages(session: Session): number {
    let fixed = 0;
    const cleaned: any[] = [];
    for (const m of session.messages as any[]) {
      if (!m || typeof m !== 'object') { fixed++; continue; }
      if (typeof m.role !== 'string') { fixed++; continue; }
      if (!('content' in m) || m.content == null) {
        cleaned.push({ ...m, content: '' });
        fixed++;
        continue;
      }
      cleaned.push(m);
    }
    if (fixed > 0) {
      session.messages = cleaned as any;
    }
    return fixed;
  }

  async function getSession(
    msg: InboundMessage,
    channel?: Channel,
    resolvedProject?: ResolvedProjectBinding | null,
    accessMetadata?: Record<string, unknown>,
  ): Promise<(Session & { isNew?: boolean }) | null> {
    const channelType = inferChannelPlatformFromChannelId(msg.channelId, input.channelPlatforms);
    const channelTarget = msg.channelId.includes(':')
      ? msg.channelId.split(':').slice(1).join(':')
      : msg.channelId;

    const binding = input.threadBindings.getBinding(channelTarget);
    if (binding) {
      input.threadBindings.touch(channelTarget);

      if (binding.sessionKey.includes(':acp:')) {
        const handled = await input.onThreadAcpMessage({
          sessionKey: binding.sessionKey,
          content: msg.content,
          channelTarget,
          channel,
        });
        if (handled) return null;
      }

      const principal = input.principalRegistry.get(msg.author.principalId ?? '') ?? null;
      const session = input.sessions.getOrCreate(binding.sessionKey, {
        name: `${binding.agentId}/thread:${channelTarget}`,
        metadata: {
          ...toSessionMetadata(buildInboundExecutionContext({
            agentId: binding.agentId,
            sessionId: undefined,
            principal,
            authorId: msg.author.id,
            authorName: msg.author.name,
            platform: channelType,
            channelId: msg.channelId,
            channelTarget,
            project: resolvedProject?.project ?? null,
            threadId: msg.threadId,
            metadata: { ...(accessMetadata ?? msg.author.meta ?? {}) },
          })),
          threadBinding: true,
        },
      });
      let ctx = buildInboundExecutionContext({
        agentId: binding.agentId,
        sessionId: session.id,
        principal,
        authorId: msg.author.id,
        authorName: msg.author.name,
        platform: channelType,
        channelId: msg.channelId,
        channelTarget,
        project: resolvedProject?.project ?? null,
        threadId: msg.threadId,
        metadata: { ...(accessMetadata ?? msg.author.meta ?? {}) },
      });
      const shared = await ensureSharedSession({ session, ctx });
      if (shared) {
        ctx = {
          ...ctx,
          sharedSessionId: shared.sharedSessionId,
          ownerPrincipalId: shared.ownerPrincipalId,
          participantIds: shared.participantIds,
          activeParticipantIds: shared.activeParticipantIds,
        };
      }
      applyExecutionContextToSession(session, ctx, channel);
      if (session.isNew) {
        await input.hooks.emit('session_start', {
          event: 'session_start',
          sessionId: session.id,
          data: {
            ...toAuditContext(ctx),
            channelType,
            channelTarget,
            authorId: msg.author.id,
          },
          timestamp: Date.now(),
        });
      }
      return session;
    }

    const guildId = msg.author.meta?.guildId as string | undefined;
    const agentId = input.resolveAgentId({
      platform: channelType,
      channelTarget,
      guildId,
      channelAgentId: channel?.agentId,
    });

    let key: string;
    const chatType = msg.author.meta?.chatType as string | undefined;
    if (channelType === 'discord') {
      key = guildId
        ? `agent:${agentId}:discord:channel:${channelTarget}`
        : `agent:${agentId}:discord:dm:${msg.author.id}`;
    } else if (channelType === 'telegram') {
      key = chatType === 'private'
        ? `agent:${agentId}:telegram:dm:${channelTarget}`
        : `agent:${agentId}:telegram:group:${channelTarget}`;
      if (msg.threadId) {
        key += `:topic:${msg.threadId}`;
      }
    } else if (channelType === 'cli') {
      key = `agent:${agentId}:cli:main`;
    } else {
      key = `agent:${agentId}:${msg.channelId}`;
    }

    const principal = input.principalRegistry.get(msg.author.principalId ?? '') ?? null;
    const session = input.sessions.getOrCreate(key, {
      name: `${agentId}/${msg.channelId}/${msg.author.name}`,
      metadata: {
        ...toSessionMetadata(buildInboundExecutionContext({
          agentId,
          principal,
          authorId: msg.author.id,
          authorName: msg.author.name,
          platform: channelType,
          channelId: msg.channelId,
          channelTarget,
          threadId: msg.threadId,
          project: resolvedProject?.project ?? null,
          metadata: { ...(accessMetadata ?? msg.author.meta ?? {}) },
        })),
      },
    });
    let ctx = buildInboundExecutionContext({
      agentId,
      sessionId: session.id,
      principal,
      authorId: msg.author.id,
      authorName: msg.author.name,
      platform: channelType,
      channelId: msg.channelId,
      channelTarget,
      threadId: msg.threadId,
      project: resolvedProject?.project ?? null,
      metadata: { ...(accessMetadata ?? msg.author.meta ?? {}) },
    });
    const shared = await ensureSharedSession({ session, ctx });
    if (shared) {
      ctx = {
        ...ctx,
        sharedSessionId: shared.sharedSessionId,
        ownerPrincipalId: shared.ownerPrincipalId,
        participantIds: shared.participantIds,
        activeParticipantIds: shared.activeParticipantIds,
      };
    }
    applyExecutionContextToSession(session, ctx, channel);
    if (session.isNew) {
      await input.hooks.emit('session_start', {
        event: 'session_start',
        sessionId: session.id,
        data: {
          ...toAuditContext(ctx),
          channelType,
          channelTarget,
          authorId: msg.author.id,
        },
        timestamp: Date.now(),
      });
    }
    return session;
  }

  return {
    resolvePrincipal,
    buildInboundExecutionContext,
    applyExecutionContextToSession,
    ensureSharedSession,
    sanitizeSessionMessages,
    getSession,
  };
}
