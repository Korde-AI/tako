import { existsSync } from 'node:fs';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DiscordChannel } from '../channels/discord.js';
import { syncProjectMembershipsToHub, syncProjectToHub } from '../network/sync.js';
import { bootstrapProjectHome } from '../projects/bootstrap.js';
import { inferProjectBootstrapIntent } from '../projects/bootstrap-intent.js';
import { defaultProjectWorkspaceRootBySlug, resolveProjectRoot } from '../projects/root.js';
import { ProjectWorktreeRegistry } from '../projects/worktrees.js';
import { getProjectRole } from '../projects/access.js';
import type { ProjectBootstrapRequest } from '../tools/projects.js';
import type { ToolContext, ToolResult } from '../tools/tool.js';
import type { ProjectRuntime, ProjectRuntimeShared } from './project-runtime-types.js';

export function createProjectBootstrapRuntime(shared: ProjectRuntimeShared): Pick<ProjectRuntime, 'bootstrapDiscordProjectFromTool'> {
  const { input } = shared;

  const ensureDiscordBootstrapOwnership = async (
    agentId: string,
    authorId: string,
    principalId?: string,
  ): Promise<boolean> => {
    const { claimOwner, loadAllowFrom } = await import('../auth/allow-from.js');
    const acl = await loadAllowFrom('discord', agentId);
    if (acl.mode === 'open' && acl.claimed !== true) {
      const claimed = await claimOwner('discord', agentId, authorId, principalId);
      return claimed.success;
    }
    if (acl.mode !== 'allowlist' || acl.claimed !== true) return false;
    if (principalId && (acl.allowedPrincipalIds ?? []).includes(principalId)) return true;
    return (acl.allowedUserIds ?? []).includes(authorId);
  };

  const bootstrapDiscordProjectFromTool = async (
    args: ProjectBootstrapRequest,
    ctx: ToolContext,
  ): Promise<ToolResult> => {
    if (ctx.channelType !== 'discord') {
      return { output: '', success: false, error: 'project_bootstrap currently supports Discord only.' };
    }
    if (!(ctx.channel instanceof DiscordChannel)) {
      return { output: '', success: false, error: 'Discord channel adapter not available in tool context.' };
    }
    const executionContext = ctx.executionContext;
    if (!executionContext?.principalId || !executionContext.authorId || !executionContext.agentId) {
      return { output: '', success: false, error: 'Missing principal or channel execution context.' };
    }

    const prompt = args.prompt?.trim();
    if (!prompt) return { output: '', success: false, error: 'prompt is required.' };

    const intent = inferProjectBootstrapIntent(prompt);
    const destination = args.destination && args.destination !== 'auto' ? args.destination : intent.destination;
    const projectType = intent.projectType;
    const displayName = args.displayName?.trim() || intent.displayName;
    const slug = args.slug?.trim() || intent.slug;
    const description = args.description?.trim() || intent.description;

    const isOwner = await ensureDiscordBootstrapOwnership(executionContext.agentId, executionContext.authorId, executionContext.principalId);
    const currentProjectId = executionContext.projectId;
    const existingRole = currentProjectId
      ? getProjectRole(input.projectMemberships, currentProjectId, executionContext.principalId)
      : null;
    const isAdmin = existingRole === 'admin';
    if (!isOwner && !isAdmin) {
      return {
        output: 'Project bootstrap is restricted to the claimed owner or a project admin in this Discord context.',
        success: false,
        error: 'owner_or_admin_required',
      };
    }

    const existing = input.projectRegistry.findBySlug(slug);
    const project = existing ?? await input.projectRegistry.create({
      slug,
      displayName,
      ownerPrincipalId: executionContext.principalId,
      workspaceRoot: defaultProjectWorkspaceRootBySlug(input.config.memory.workspace, slug),
      description,
      collaboration: {
        mode: 'single-user',
        autoArtifactSync: false,
        patchRequiresApproval: true,
        announceJoins: false,
      },
      metadata: {
        createdFrom: 'discord-tool-bootstrap',
        requestedInChannel: executionContext.channelId,
        projectType,
      },
    });
    if (!existing) {
      await bootstrapProjectHome(input.runtimePaths.projectsDir, project);
    }
    await input.projectMemberships.upsert({
      projectId: project.projectId,
      principalId: executionContext.principalId,
      role: 'admin',
      addedBy: executionContext.principalId,
    });

    const metadata = executionContext.metadata ?? {};
    const currentChannelTarget = ctx.channelTarget ?? executionContext.channelTarget ?? '';
    const currentThreadId = executionContext.threadId;
    const parentChannelId = typeof metadata['parentChannelId'] === 'string' ? metadata['parentChannelId'] : undefined;
    const guildId = typeof metadata['guildId'] === 'string' ? metadata['guildId'] : undefined;

    let boundChannelTarget = currentChannelTarget;
    let boundThreadId: string | undefined = currentThreadId;
    let createdChannel: { id: string; name: string } | null = null;
    let createdThread: { id: string; name: string } | null = null;

    if (destination === 'channel') {
      if (!guildId) {
        return {
          output: 'Cannot create a Discord channel here because no guild context is available. Ask to use the current channel instead.',
          success: false,
          error: 'missing_guild_context',
        };
      }
      const coordinator = input.projectChannelCoordinators.get('discord');
      if (!coordinator) {
        return {
          output: 'Discord project coordinator is not available. Cannot create or bind a Discord project room here.',
          success: false,
          error: 'missing_discord_project_coordinator',
        };
      }
      const room = await coordinator.bootstrapProjectRoom({
        agentId: executionContext.agentId,
        guildId,
        currentChannelTarget,
        currentThreadId,
        parentChannelId,
        slug,
        displayName: project.displayName,
        description,
        destination,
        ownerUserId: executionContext.authorId,
      });
      boundChannelTarget = room.channelTarget;
      boundThreadId = room.threadId;
      createdChannel = room.createdChannel ?? null;
      createdThread = room.createdThread ?? null;
    }

    await input.projectBindings.bind({
      projectId: project.projectId,
      platform: 'discord',
      channelTarget: boundChannelTarget,
      threadId: boundThreadId,
      agentId: executionContext.agentId,
    });

    if (project.metadata?.['roomState'] === 'pending_rebind') {
      await input.projectRegistry.update(project.projectId, {
        metadata: {
          ...(project.metadata ?? {}),
          roomState: 'active',
          pendingRoomReason: null,
          pendingRoomAt: null,
          pendingRoomBindingId: null,
        },
      });
    }

    const worktreeRegistry = new ProjectWorktreeRegistry(join(input.runtimePaths.projectsDir, project.projectId, 'worktrees'), project.projectId);
    await worktreeRegistry.load();
    const projectRoot = resolveProjectRoot(input.runtimePaths, project);
    await worktreeRegistry.register({
      nodeId: input.getNodeIdentity().nodeId,
      root: projectRoot,
      label: 'owner-default',
      ownerPrincipalId: executionContext.principalId,
    });

    const statusPath = join(projectRoot, 'STATUS.md');
    const projectDocPath = join(projectRoot, 'PROJECT.md');
    const noticePath = join(projectRoot, 'NOTICE.md');
    const modeLabel = project.collaboration?.mode ?? 'single-user';
    const templateSectionsByType: Record<string, string[]> = {
      programming: ['## Engineering Focus', '- Repo / codebase', '- Milestone tasks', '- Bugs / blockers', '- Review and merge plan'],
      design: ['## Design Focus', '- Product goals', '- User flows', '- Screens / assets', '- Review checkpoints'],
      research: ['## Research Focus', '- Research question', '- Sources / papers', '- Findings', '- Open questions'],
      general: ['## Project Focus', '- Goal', '- Workstreams', '- Risks', '- Next review'],
    };
    const templateSection = templateSectionsByType[projectType] ?? templateSectionsByType.general;
    if (!existsSync(projectDocPath)) {
      const projectDoc = [
        `# ${project.displayName}`,
        '',
        `- Slug: \`${project.slug}\``,
        `- Type: \`${projectType}\``,
        `- Owner principal: \`${project.ownerPrincipalId}\``,
        `- Mode: \`${modeLabel}\``,
        project.description ? '' : null,
        project.description ? '## Description' : null,
        project.description ?? null,
        '',
        ...templateSection,
      ].filter(Boolean).join('\n');
      await writeFile(projectDocPath, `${projectDoc}\n`, 'utf-8');
    }
    if (!existsSync(statusPath)) {
      const statusDoc = [
        '# STATUS',
        '',
        `Project: ${project.displayName} (\`${project.slug}\`)`,
        `Type: ${projectType}`,
        `Mode: ${modeLabel}`,
        '',
        '## Current Goal',
        '- Define the immediate next milestone.',
        '',
        '## In Progress',
        '- Project room initialized.',
        '',
        '## Done',
        `- Project created by ${executionContext.principalName ?? executionContext.principalId}.`,
        '',
        '## Blockers',
        '- None recorded yet.',
        '',
        '## Next Actions',
        '- Add collaborators if needed.',
        '- Update this file as work progresses.',
        '',
        ...templateSection,
      ].join('\n');
      await writeFile(statusPath, `${statusDoc}\n`, 'utf-8');
    }
    if (!existsSync(noticePath)) {
      const noticeDoc = [
        '# Notice',
        '',
        `${project.displayName} was initialized as a private ${projectType} project room.`,
        `This room starts in \`${modeLabel}\` mode and becomes collaborative after another member is added.`,
        '',
        '## Workspace',
        `- Local workspace: \`${projectRoot}\``,
        '- Shared starter docs: `PROJECT.md`, `STATUS.md`',
      ].join('\n');
      await writeFile(noticePath, `${noticeDoc}\n`, 'utf-8');
    }

    const background = await shared.buildProjectBackground(project.projectId, existing ? 'discord_tool_rebind' : 'discord_tool_bootstrap');
    const hubClient = input.getHubClient();
    if (hubClient) {
      await syncProjectToHub(hubClient, input.getNodeIdentity(), project, input.projectMemberships).catch(() => {});
      await syncProjectMembershipsToHub(hubClient, input.getNodeIdentity(), project.projectId, input.projectMemberships).catch(() => {});
    }

    if (createdThread || createdChannel) {
      await ctx.channel.send({
        target: createdThread?.id ?? createdChannel!.id,
        content: [
          `Project room initialized for **${project.displayName}**.`,
          `Type: \`${projectType}\``,
          `Mode: \`${modeLabel}\``,
          `Workspace: \`${projectRoot}\``,
          'Starter docs created: \`PROJECT.md\`, \`STATUS.md\`, \`NOTICE.md\`',
          '',
          'This room is private to the owner until another member is added.',
          '',
          'Intro:',
          project.description || description,
          '',
          background?.summary ?? '',
        ].join('\n\n'),
      }).catch(() => {});
    }

    if (ctx.sessionId) {
      const sourceSession = input.sessions.get(ctx.sessionId);
      if (sourceSession) {
        sourceSession.metadata.recentProjectId = project.projectId;
        sourceSession.metadata.recentProjectSlug = project.slug;
        sourceSession.metadata.recentProjectRoomChannelId = createdChannel?.id ?? boundChannelTarget;
        sourceSession.metadata.recentProjectRoomThreadId = createdThread?.id ?? boundThreadId;
      }
    }

    return {
      output: [
        existing ? `Bound existing project ${project.displayName} (${project.slug}).` : `Created project ${project.displayName} (${project.slug}).`,
        createdChannel ? `Opened private channel: ${createdChannel.id}` : null,
        createdThread ? `Opened thread: ${createdThread.id}` : null,
        !createdChannel && !createdThread ? (boundThreadId ? `Bound current thread: ${boundThreadId}` : 'Bound current channel.') : null,
        `Type: ${projectType}`,
        `Workspace: ${projectRoot}`,
        'Starter docs: PROJECT.md, STATUS.md, NOTICE.md',
        background ? `Background: ${background.summary.split('\n')[0]}` : null,
      ].filter(Boolean).join('\n'),
      success: true,
      data: {
        projectId: project.projectId,
        projectSlug: project.slug,
        channelId: createdChannel?.id ?? boundChannelTarget,
        threadId: createdThread?.id ?? boundThreadId,
      },
    };
  };

  return { bootstrapDiscordProjectFromTool };
}
