import type { PrincipalRegistry } from '../principals/registry.js';
import type { ToolContext } from '../tools/tool.js';
import type { ProjectRoomInspection } from '../projects/channel-coordination.js';

interface ResolvedDiscordIdentity {
  principalId: string;
  displayName: string;
  userId?: string;
  username?: string;
}

interface DiscordProjectSupportDeps {
  principalRegistry: PrincipalRegistry;
  normalizeIdentity: (value?: string | null) => string | null;
  inspectCurrentRoom: (ctx: ToolContext) => Promise<ProjectRoomInspection | null>;
}

export function createDiscordProjectSupport(deps: DiscordProjectSupportDeps) {
  const resolvePrincipalIdentity = (identity: string): ResolvedDiscordIdentity | null => {
    const normalized = deps.normalizeIdentity(identity);
    if (!normalized) return null;
    const mappings = deps.principalRegistry.listMappings().filter((mapping) => mapping.platform === 'discord');
    for (const mapping of mappings) {
      const principal = deps.principalRegistry.get(mapping.principalId);
      const candidates = new Set<string>();
      const add = (value?: string | null) => {
        const candidate = deps.normalizeIdentity(value);
        if (candidate) candidates.add(candidate);
      };
      add(mapping.platformUserId);
      add(mapping.username);
      add(mapping.displayName);
      add(mapping.principalId);
      add(principal?.displayName);
      for (const alias of principal?.aliases ?? []) add(alias);
      if (candidates.has(normalized)) {
        return {
          principalId: mapping.principalId,
          displayName: principal?.displayName ?? mapping.displayName ?? mapping.username ?? mapping.platformUserId,
          userId: mapping.platformUserId,
          username: mapping.username,
        };
      }
    }
    return null;
  };

  const resolvePrincipalIdentityFromRoom = async (
    identity: string,
    ctx: ToolContext,
  ): Promise<ResolvedDiscordIdentity | null> => {
    const executionContext = ctx.executionContext;
    if (ctx.channelType !== 'discord' || !executionContext?.agentId) return null;

    const normalized = deps.normalizeIdentity(identity);
    if (!normalized) return null;

    const inspection = await deps.inspectCurrentRoom(ctx).catch(() => null);
    if (!inspection) return null;

    const matched = inspection.members.find((member) => {
      const candidates = new Set<string>();
      const add = (value?: string | null) => {
        const candidate = deps.normalizeIdentity(value);
        if (candidate) candidates.add(candidate);
      };
      add(member.userId);
      add(member.username);
      add(member.displayName);
      return candidates.has(normalized);
    });
    if (!matched) return null;

    const principal = await deps.principalRegistry.getOrCreateHuman({
      displayName: matched.displayName ?? matched.username ?? matched.userId,
      platform: 'discord',
      platformUserId: matched.userId,
      username: matched.username,
      metadata: {
        channelId: executionContext.channelId,
        learnedFromRoomInspection: true,
      },
    });

    return {
      principalId: principal.principalId,
      displayName: principal.displayName,
      userId: matched.userId,
      username: matched.username,
    };
  };

  return {
    resolvePrincipalIdentity,
    resolvePrincipalIdentityFromRoom,
  };
}
