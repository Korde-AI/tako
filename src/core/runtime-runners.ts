import type { Channel } from '../channels/channel.js';
import type { AgentLoop } from './agent-loop.js';
import type { AuditLogger } from './audit.js';
import type { ChannelDeliveryRegistry } from './channel-delivery.js';
import type { ExecutionContext } from './execution-context.js';
import type { RetryQueue } from './retry-queue.js';
import type { Session, SessionManager } from '../gateway/session.js';
import type { ToolResult } from '../tools/tool.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { PeerTaskApproval, PeerTaskApprovalRegistry } from './peer-approvals.js';
import { AcpxRuntime } from '../acp/runtime.js';
import { AcpSessionManager } from '../tools/acp-sessions.js';
import type { AcpRuntimeConfig } from '../acp/config.js';
import type { ToolCall } from '../providers/provider.js';

export function createAcpRuntimeBundle(acpConfig: AcpRuntimeConfig) {
  const acpRuntime = new AcpxRuntime(acpConfig);
  const acpSessionManager = new AcpSessionManager(acpConfig, acpRuntime);

  return {
    acpRuntime,
    acpSessionManager,
    async probe(): Promise<boolean> {
      await acpRuntime.probeAvailability();
      return acpRuntime.isHealthy();
    },
  };
}

interface PeerTaskRunnerDeps {
  sessions: SessionManager;
  toolRegistry: ToolRegistry;
  peerTaskApprovals: PeerTaskApprovalRegistry;
  audit: AuditLogger;
  workspaceRoot: string;
  activeProcessingSessions: Set<string>;
  getAgentLoop: (agentId?: string) => AgentLoop;
  getChannelDeliveryRegistry: () => ChannelDeliveryRegistry;
  formatUserFacingAgentError: (err: unknown) => string;
}

export function createPeerTaskRuntimeHandlers(deps: PeerTaskRunnerDeps) {
  function summarizePeerTaskArgs(args: unknown, maxChars = 180): string {
    const raw = (() => {
      try {
        return JSON.stringify(args);
      } catch {
        return String(args);
      }
    })();
    if (raw.length <= maxChars) return raw;
    return raw.slice(0, maxChars - 3) + '...';
  }

  function buildPeerTaskResumePrompt(approval: PeerTaskApproval): string {
    const approvedArgs = (() => {
      try {
        return JSON.stringify(approval.toolArgs);
      } catch {
        return String(approval.toolArgs);
      }
    })();
    return [
      `[System event] Owner approval granted for request ${approval.approvalId}.`,
      `Tool: ${approval.toolName}.`,
      'Resume the previously blocked task now.',
      `Use the approved input exactly once if still required: ${approvedArgs}.`,
    ].join(' ');
  }

  async function resumePeerTaskApproval(approval: PeerTaskApproval): Promise<void> {
    const session = deps.sessions.get(approval.sessionId);
    if (!session) {
      console.warn(`[peer-approval] Session ${approval.sessionId} not found for ${approval.approvalId}`);
      return;
    }

    const channelRef = session.metadata?.channelRef as Channel | undefined;
    const target = approval.channelTarget ?? session.metadata?.channelTarget as string | undefined;
    if (!channelRef || !target) {
      console.warn(`[peer-approval] Missing channel for ${approval.approvalId}`);
      return;
    }
    if (deps.activeProcessingSessions.has(session.id)) {
      console.warn(`[peer-approval] Session ${session.id} already active, skipping auto-resume for ${approval.approvalId}`);
      return;
    }

    const executionContext = session.metadata?.executionContext as ExecutionContext | undefined;
    const allowedToolRoot = executionContext?.allowedToolRoot
      ?? executionContext?.projectRoot
      ?? deps.workspaceRoot;
    const tool = deps.toolRegistry.getTool(approval.toolName);
    let response = '';
    let hadError = false;
    let directExecutionAttempted = false;

    try {
      if (tool) {
        directExecutionAttempted = true;
        const toolCtx = {
          sessionId: session.id,
          workDir: allowedToolRoot,
          workspaceRoot: deps.workspaceRoot,
          allowedToolRoot,
          agentId: approval.agentId,
          agentRole: String(executionContext?.metadata?.['effectiveAgentRole'] ?? session.metadata?.agentRole ?? 'admin'),
          channelType: approval.channelType ?? session.metadata?.channelType as string | undefined,
          channelTarget: approval.channelTarget ?? session.metadata?.channelTarget as string | undefined,
          channel: channelRef,
          executionContext,
        };
        const result = await tool.execute(approval.toolArgs, toolCtx);
        if (!result.success) {
          throw new Error(result.error || result.output || `Approved tool ${approval.toolName} failed`);
        }
        await deps.peerTaskApprovals.markExecuted(approval.approvalId);
        deps.audit.log({
          agentId: approval.agentId,
          sessionId: approval.sessionId,
          principalId: approval.requesterPrincipalId,
          principalName: approval.requesterPrincipalName,
          projectId: approval.projectId,
          projectSlug: approval.projectSlug,
          event: 'agent_comms',
          action: 'peer_task_execute_approved',
          details: {
            approvalId: approval.approvalId,
            toolName: approval.toolName,
          },
          success: true,
        }).catch(() => {});

        if (approval.toolName !== 'message' && result.output.trim()) {
          response = result.output.trim();
        }
      } else {
        deps.activeProcessingSessions.add(session.id);
        const activeLoop = deps.getAgentLoop(session.metadata?.agentId as string | undefined);
        activeLoop.setChannel(channelRef);
        for await (const chunk of activeLoop.run(session, approval.resumePrompt)) {
          response += chunk;
        }
      }
    } catch (err) {
      hadError = true;
      response = deps.formatUserFacingAgentError(err);
      console.error(`[peer-approval] Resume failed for ${approval.approvalId}:`, err instanceof Error ? err.message : err);
    } finally {
      if (!directExecutionAttempted) {
        deps.activeProcessingSessions.delete(session.id);
      }
    }

    if (response.trim()) {
      await channelRef.send({
        target,
        content: response.trim(),
      }).catch((err) => {
        console.error(`[peer-approval] Send failed for ${approval.approvalId}:`, err instanceof Error ? err.message : err);
      });
    }

    deps.audit.log({
      agentId: approval.agentId,
      sessionId: approval.sessionId,
      principalId: approval.requesterPrincipalId,
      principalName: approval.requesterPrincipalName,
      projectId: approval.projectId,
      projectSlug: approval.projectSlug,
      event: 'agent_comms',
      action: hadError ? 'peer_task_resume_failed' : 'peer_task_resumed',
      details: {
        approvalId: approval.approvalId,
        toolName: approval.toolName,
        directExecution: directExecutionAttempted,
      },
      success: !hadError,
    }).catch(() => {});

    deps.sessions.markSessionDirty(session.id);
  }

  async function handleSharedAccessToolAuthorization(input: {
    session: Session;
    toolCall: ToolCall;
    roleName: string;
    userMessage: string;
    executionContext?: ExecutionContext;
    channel?: Channel;
  }): Promise<{
    allow: boolean;
    approvalId?: string;
    toolResult?: ToolResult;
  } | null> {
    const accessMode = String(input.executionContext?.metadata?.['agentAccessMode'] ?? '');
    if (accessMode !== 'shared_readonly' && accessMode !== 'peer_agent_readonly') {
      return null;
    }

    if (isSharedReadonlySafeToolCall(input.toolCall)) {
      return { allow: true };
    }

    const ownerUserIds = Array.isArray(input.executionContext?.metadata?.['ownerUserIds'])
      ? input.executionContext?.metadata?.['ownerUserIds'] as string[]
      : [];
    const ownerPrincipalIds = Array.isArray(input.executionContext?.metadata?.['ownerPrincipalIds'])
      ? input.executionContext?.metadata?.['ownerPrincipalIds'] as string[]
      : [];

    const granted = await deps.peerTaskApprovals.consumeApproved(
      input.session.id,
      input.executionContext?.agentId ?? input.session.metadata?.agentId as string ?? 'main',
      input.toolCall.name,
      input.toolCall.input,
    );
    if (granted) {
      return {
        allow: true,
        approvalId: granted.approvalId,
      };
    }

    const requesterName = input.executionContext?.principalName
      ?? input.executionContext?.authorName
      ?? input.session.metadata?.principalName as string | undefined
      ?? input.session.metadata?.authorName as string | undefined;
    const requesterIsBot = input.executionContext?.metadata?.['isBotOrigin'] === true;
    const { approval, reused } = await deps.peerTaskApprovals.createOrReuse({
      sessionId: input.session.id,
      agentId: input.executionContext?.agentId ?? input.session.metadata?.agentId as string ?? 'main',
      toolName: input.toolCall.name,
      toolArgs: input.toolCall.input,
      channelType: input.executionContext?.platform ?? input.session.metadata?.channelType as string | undefined,
      channelTarget: input.executionContext?.channelTarget ?? input.session.metadata?.channelTarget as string | undefined,
      projectId: input.executionContext?.projectId,
      projectSlug: input.executionContext?.projectSlug,
      requesterPrincipalId: input.executionContext?.principalId,
      requesterPrincipalName: input.executionContext?.principalName,
      requesterAuthorId: input.executionContext?.authorId,
      requesterAuthorName: input.executionContext?.authorName,
      requesterIsBot,
      ownerUserIds,
      ownerPrincipalIds,
      originalUserMessage: input.userMessage,
      resumePrompt: '',
    });
    if (!approval.resumePrompt) {
      approval.resumePrompt = buildPeerTaskResumePrompt(approval);
      await deps.peerTaskApprovals.save();
    }

    if (!reused) {
      deps.audit.log({
        agentId: approval.agentId,
        sessionId: approval.sessionId,
        principalId: approval.requesterPrincipalId,
        principalName: approval.requesterPrincipalName,
        projectId: approval.projectId,
        projectSlug: approval.projectSlug,
        event: 'agent_comms',
        action: 'peer_task_approval_request',
        details: {
          approvalId: approval.approvalId,
          toolName: approval.toolName,
          requesterIsBot,
        },
        success: true,
      }).catch(() => {});
    }

    if (!reused && input.channel?.id === 'discord' && typeof approval.channelTarget === 'string' && ownerUserIds.length > 0) {
      const adapter = deps.getChannelDeliveryRegistry().get('discord');
      if (adapter) {
        await adapter.sendPeerTaskApproval({
          channelId: approval.channelTarget,
          approvalId: approval.approvalId,
          agentId: approval.agentId,
          requesterName,
          requesterIsBot,
          toolName: approval.toolName,
          toolArgsPreview: summarizePeerTaskArgs(approval.toolArgs),
          ownerMentions: ownerUserIds.map((id) => `<@${id}>`),
          projectSlug: approval.projectSlug,
          agentIdHint: input.executionContext?.agentId ?? input.session.metadata?.agentId as string | undefined,
        }).catch((err) => {
          console.error('[peer-approval] Failed to send approval card:', err instanceof Error ? err.message : err);
        });
      }
    }

    const ownerMentions = ownerUserIds.map((id) => `<@${id}>`);
    return {
      allow: false,
      approvalId: approval.approvalId,
      toolResult: {
        output: reused
          ? `Owner approval is still pending for tool "${input.toolCall.name}". Approval request ${approval.approvalId} is already open${ownerMentions.length > 0 ? ` for ${ownerMentions.join(', ')}` : ''}.`
          : `Owner approval is required before using tool "${input.toolCall.name}" in ${accessMode}. I opened approval request ${approval.approvalId}${ownerMentions.length > 0 ? ` for ${ownerMentions.join(', ')}` : ''}.`,
        success: false,
        error: 'approval_required',
      },
    };
  }

  return {
    summarizePeerTaskArgs,
    buildPeerTaskResumePrompt,
    resumePeerTaskApproval,
    handleSharedAccessToolAuthorization,
  };
}

export function configureRetryRunner(input: {
  retryQueue: RetryQueue;
  sessions: SessionManager;
  runSession: (session: Session, userMessage: string) => AsyncIterable<string>;
}): void {
  input.retryQueue.setRunner(async (sessionId, userMessage) => {
    const session = input.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found for retry`);
    let result = '';
    for await (const chunk of input.runSession(session, userMessage)) {
      result += chunk;
    }
    return result;
  });
}

function isSharedReadonlySafeToolCall(toolCall: ToolCall): boolean {
  if (toolCall.name === 'discord_room_inspect') return true;
  if (toolCall.name === 'project_member_manage') {
    const action = typeof toolCall.input === 'object' && toolCall.input
      ? String((toolCall.input as Record<string, unknown>)['action'] ?? '')
      : '';
    return action === 'list';
  }
  if (toolCall.name === 'project_sync') {
    const update = typeof toolCall.input === 'object' && toolCall.input
      ? (toolCall.input as Record<string, unknown>)['update']
      : undefined;
    return update == null || String(update).trim() === '';
  }
  return false;
}
