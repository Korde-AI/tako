import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sendNetworkSessionEvent } from '../network/session-sync.js';
import { syncProjectToHub } from '../network/sync.js';
import { resolveProjectRoot } from '../projects/root.js';
import { detectProjectRoomSignal } from '../projects/room-signals.js';
import { getProjectRole, isProjectMember } from '../projects/access.js';
import type { ProjectCloseRequest, ProjectSyncRequest } from '../tools/projects.js';
import type { ToolContext, ToolResult } from '../tools/tool.js';
import type { ProjectRuntime, ProjectRuntimeShared } from './project-runtime-types.js';

function formatCoordinationNotice(args: {
  kind: 'progress' | 'rebuttal';
  who: string;
  summary: string;
}): string {
  if (args.kind === 'progress') {
    return `📈 **Progress Update**\n${args.who}: ${args.summary}`;
  }
  return `⚠️ **Rebuttal / Risk Raised**\n${args.who}: ${args.summary}\nPlease review, respond, and align the next step.`;
}

export function createProjectSyncRuntime(shared: ProjectRuntimeShared): Pick<ProjectRuntime,
  | 'sweepProjectRoomSignal'
  | 'syncDiscordProjectFromTool'
  | 'closeDiscordProjectFromTool'
> {
  const { input } = shared;

  const sweepProjectRoomSignal: ProjectRuntime['sweepProjectRoomSignal'] = async (args) => {
    const signal = detectProjectRoomSignal(args.text);
    if (!signal) return;

    const projectRoot = resolveProjectRoot(input.runtimePaths, args.project);
    const statusPath = join(projectRoot, 'STATUS.md');
    const prior = existsSync(statusPath) ? await readFile(statusPath, 'utf-8') : '# STATUS\n';
    const stamp = new Date().toISOString();
    const heading = signal.kind === 'progress' ? '## Room Progress Signals' : '## Rebuttals And Risks';
    const line = `- ${stamp} — ${args.principalName ?? args.principalId}: ${signal.summary}`;
    await writeFile(statusPath, `${prior.trimEnd()}\n\n${heading}\n${line}\n`, 'utf-8');

    const background = await shared.buildProjectBackground(args.project.projectId, `room_signal:${signal.kind}`);
    const notice = formatCoordinationNotice({
      kind: signal.kind === 'progress' ? 'progress' : 'rebuttal',
      who: args.principalName ?? args.principalId,
      summary: signal.summary,
    });
    await input.getProjectRoomNotifier().notify(args.project.projectId, notice);

    const hubClient = input.getHubClient();
    if (hubClient) {
      await syncProjectToHub(hubClient, input.getNodeIdentity(), input.projectRegistry.get(args.project.projectId) ?? args.project, input.projectMemberships).catch(() => {});
    }

    const networkSession = input.networkSharedSessions.findByProject(args.project.projectId)
      .find((candidate) => candidate.participantNodeIds.includes(input.getNodeIdentity().nodeId)) ?? null;
    if (hubClient && networkSession?.participantNodeIds.length) {
      await sendNetworkSessionEvent(hubClient, input.networkSharedSessions, input.trustStore, {
        eventId: crypto.randomUUID(),
        networkSessionId: networkSession.networkSessionId,
        projectId: args.project.projectId,
        fromNodeId: input.getNodeIdentity().nodeId,
        fromPrincipalId: args.principalId,
        type: 'system',
        audience: 'specific-nodes',
        targetNodeIds: networkSession.participantNodeIds,
        payload: {
          summary: notice,
          metadata: {
            signalKind: signal.kind,
            projectSlug: args.project.slug,
            backgroundSummary: background?.summary,
          },
        },
        createdAt: new Date().toISOString(),
      }).catch(() => {});
    }
  };

  const syncDiscordProjectFromTool = async (
    args: ProjectSyncRequest,
    ctx: ToolContext,
  ): Promise<ToolResult> => {
    const executionContext = ctx.executionContext;
    if (!executionContext || !executionContext.principalId) {
      return { output: '', success: false, error: 'Missing principal execution context.' };
    }
    const project = shared.resolveProjectForToolContext({
      explicitProjectSlug: args.projectSlug,
      executionContext,
      sessionId: ctx.sessionId,
    });
    if (!project) {
      return {
        output: 'There is no active or recently created project in this conversation yet. Move to the project room, or specify the project slug.',
        success: false,
        error: 'missing_project_context',
      };
    }
    const accessMode = String(executionContext.metadata?.['agentAccessMode'] ?? '');
    const isOwnerFull = accessMode === 'owner_full';
    const isMember = isProjectMember(input.projectMemberships, project.projectId, executionContext.principalId);
    const canWriteSharedState = isOwnerFull || isMember;
    if (!canWriteSharedState && accessMode !== 'shared_readonly') {
      return { output: 'Only project members or the owning agent can sync project state.', success: false, error: 'project_membership_required' };
    }

    const projectRoot = resolveProjectRoot(input.runtimePaths, project);
    const localMirror = await shared.ensureLocalProjectMirror({
      project,
      source: 'project_sync',
    });
    const statusPath = join(projectRoot, 'STATUS.md');
    const update = args.update?.trim();
    if (update && canWriteSharedState) {
      const prior = existsSync(statusPath) ? await readFile(statusPath, 'utf-8') : '# STATUS\n';
      const stamp = new Date().toISOString();
      const appended = `${prior.trimEnd()}\n\n## Sync Notes\n- ${stamp} — ${update}\n`;
      await writeFile(statusPath, appended, 'utf-8');
    }

    const background = await shared.buildProjectBackground(project.projectId, update ? 'project_sync:update' : 'project_sync');
    const summaryLine = background?.summary.split('\n')[0] ?? `Project ${project.displayName} (${project.slug})`;
    const announce = [
      canWriteSharedState ? `[sync] ${summaryLine}` : `[shared sync] ${summaryLine}`,
      update ? `Update: ${update}` : null,
    ].filter(Boolean).join('\n');
    await input.getProjectRoomNotifier().notify(project.projectId, announce);

    return {
      output: [
        `Synced ${project.displayName} (${project.slug}).`,
        localMirror.created ? `Provisioned local project workspace ${localMirror.projectRoot} and worktree ${localMirror.worktreeRoot}.` : null,
        update && canWriteSharedState ? 'STATUS.md updated.' : null,
        update && !canWriteSharedState ? 'Shared view announced without modifying project files.' : null,
        background ? `Background: ${summaryLine}` : null,
      ].filter(Boolean).join('\n'),
      success: true,
      data: {
        projectId: project.projectId,
        projectSlug: project.slug,
        statusPath,
      },
    };
  };

  const closeDiscordProjectFromTool = async (
    args: ProjectCloseRequest,
    ctx: ToolContext,
  ): Promise<ToolResult> => {
    const executionContext = ctx.executionContext;
    if (!executionContext || !executionContext.principalId) {
      return { output: '', success: false, error: 'Missing principal execution context.' };
    }
    const project = shared.resolveProjectForToolContext({
      explicitProjectSlug: args.projectSlug,
      executionContext,
      sessionId: ctx.sessionId,
    });
    if (!project) {
      return {
        output: 'There is no active or recently created project in this conversation yet. Move to the project room, or specify the project slug.',
        success: false,
        error: 'missing_project_context',
      };
    }
    const actorRole = getProjectRole(input.projectMemberships, project.projectId, executionContext.principalId);
    const isOwner = project.ownerPrincipalId === executionContext.principalId;
    const isAdmin = actorRole === 'admin';
    if (!isOwner && !isAdmin) {
      return {
        output: 'Only the project owner or an admin can close a project.',
        success: false,
        error: 'owner_or_admin_required',
      };
    }

    const projectRoot = resolveProjectRoot(input.runtimePaths, project);
    const statusPath = join(projectRoot, 'STATUS.md');
    const reason = args.reason?.trim();
    const updated = await input.projectRegistry.update(project.projectId, {
      status: 'closed',
      metadata: {
        ...(project.metadata ?? {}),
        closedAt: new Date().toISOString(),
        closedBy: executionContext.principalId,
        closeReason: reason ?? null,
      },
    });

    const prior = existsSync(statusPath) ? await readFile(statusPath, 'utf-8') : '# STATUS\n';
    const closureBlock = [
      '',
      '## Closure',
      '- Status: closed',
      `- Closed by: ${executionContext.principalName ?? executionContext.principalId}`,
      reason ? `- Reason: ${reason}` : null,
    ].filter(Boolean).join('\n');
    await writeFile(statusPath, `${prior.trimEnd()}\n${closureBlock}\n`, 'utf-8');

    const background = await shared.buildProjectBackground(project.projectId, 'project_close');
    await input.getProjectRoomNotifier().notify(
      project.projectId,
      [`[project closed] ${updated.displayName} (${updated.slug})`, reason ? `Reason: ${reason}` : null].filter(Boolean).join('\n'),
    );

    return {
      output: [
        `Closed ${updated.displayName} (${updated.slug}).`,
        'Project status: closed.',
        reason ? `Reason: ${reason}` : null,
        background ? `Background: ${background.summary.split('\n')[0]}` : null,
      ].filter(Boolean).join('\n'),
      success: true,
      data: {
        projectId: updated.projectId,
        projectSlug: updated.slug,
        status: updated.status,
      },
    };
  };

  return {
    sweepProjectRoomSignal,
    syncDiscordProjectFromTool,
    closeDiscordProjectFromTool,
  };
}
