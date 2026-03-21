import type { Channel } from './channel.js';
import type { TelegramChannel, TelegramCommandHandler } from './telegram.js';
import type { Session, SessionManager } from '../gateway/session.js';
import type { PrincipalRegistry } from '../principals/registry.js';
import type { Project } from '../projects/types.js';
import type { CommandContext, CommandRegistry } from '../commands/registry.js';
import type { ExecutionContext } from '../core/execution-context.js';

interface TelegramAuthor {
  id: string;
  name: string;
  meta?: Record<string, unknown>;
}

interface ResolvedProjectRef {
  project: Project;
}

export interface TelegramCommandRuntimeDeps {
  principalRegistry: PrincipalRegistry;
  sessions: SessionManager;
  commandRegistry: CommandRegistry;
  resolveProject: (input: { platform: 'telegram'; channelTarget: string; agentId: string }) => ResolvedProjectRef | null;
  getProjectRole: (projectId: string, principalId: string) => string | null;
  buildAgentAccessMetadata: (input: {
    platform: 'telegram';
    agentId: string;
    authorId: string;
    principalId: string;
    project: Project | null;
    metadata: Record<string, unknown>;
  }) => Promise<Record<string, unknown>>;
  buildInboundExecutionContext: (input: any) => ExecutionContext;
  toSessionMetadata: (ctx: ExecutionContext) => Record<string, unknown>;
  ensureSharedSession: (input: { session: Session; ctx: ExecutionContext }) => Promise<{
    sharedSessionId: string;
    ownerPrincipalId: string;
    participantIds: string[];
    activeParticipantIds: string[];
  } | null>;
  applyExecutionContextToSession: (session: Session, ctx: ExecutionContext, channel?: Channel) => void;
  toCommandContext: (ctx: ExecutionContext) => Omit<CommandContext, 'session'>;
  isProjectMember: (projectId: string, principalId: string) => boolean;
}

export function createTelegramCommandHandler(input: {
  agentId: string;
  channel: TelegramChannel;
  deps: TelegramCommandRuntimeDeps;
}): TelegramCommandHandler {
  const { agentId, channel, deps } = input;

  return async (commandName: string, chatId: string, author: TelegramAuthor) => {
    const principal = await deps.principalRegistry.getOrCreateHuman({
      displayName: author.name,
      platform: 'telegram',
      platformUserId: author.id,
      username: typeof author.meta?.username === 'string' ? author.meta.username : undefined,
      metadata: { channelId: `telegram:${chatId}` },
    });
    const channelKey = `telegram:${chatId}`;
    const resolvedProject = deps.resolveProject({
      platform: 'telegram',
      channelTarget: chatId,
      agentId,
    });
    const projectRole = resolvedProject
      ? deps.getProjectRole(resolvedProject.project.projectId, principal.principalId) ?? undefined
      : undefined;
    const accessMetadata = await deps.buildAgentAccessMetadata({
      platform: 'telegram',
      agentId,
      authorId: author.id,
      principalId: principal.principalId,
      project: resolvedProject?.project ?? null,
      metadata: { ...(author.meta ?? {}) },
    });
    const sessionKey = `agent:${agentId}:${channelKey}`;
    const session = deps.sessions.getOrCreate(sessionKey, {
      name: `${agentId}/${channelKey}/${author.name}`,
      metadata: deps.toSessionMetadata(deps.buildInboundExecutionContext({
        agentId,
        principal,
        authorId: author.id,
        authorName: author.name,
        platform: 'telegram',
        channelId: channelKey,
        channelTarget: chatId,
        project: resolvedProject?.project ?? null,
        projectRole: projectRole ?? null,
        metadata: accessMetadata,
      })),
    });
    let executionContext = deps.buildInboundExecutionContext({
      agentId,
      sessionId: session.id,
      principal,
      authorId: author.id,
      authorName: author.name,
      platform: 'telegram',
      channelId: channelKey,
      channelTarget: chatId,
      project: resolvedProject?.project ?? null,
      projectRole: projectRole ?? null,
      metadata: accessMetadata,
    });
    const shared = await deps.ensureSharedSession({ session, ctx: executionContext });
    if (shared) {
      executionContext = {
        ...executionContext,
        sharedSessionId: shared.sharedSessionId,
        ownerPrincipalId: shared.ownerPrincipalId,
        participantIds: shared.participantIds,
        activeParticipantIds: shared.activeParticipantIds,
      };
    }
    deps.applyExecutionContextToSession(session, executionContext, channel);

    if (resolvedProject && !deps.isProjectMember(resolvedProject.project.projectId, principal.principalId)) {
      return 'You are not a member of this project.';
    }

    return deps.commandRegistry.handle('/' + commandName, {
      ...deps.toCommandContext(executionContext),
      session,
    });
  };
}

export function wireTelegramRuntime(input: {
  channel: TelegramChannel;
  nativeCommandList: Array<{ name: string; description: string }>;
  commandHandler: TelegramCommandHandler;
}): void {
  input.channel.setCommands(input.nativeCommandList, input.commandHandler);
}
