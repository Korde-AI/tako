import { ActionRowBuilder, ButtonBuilder, ButtonStyle, type Client } from 'discord.js';

export async function sendDiscordPatchApprovalRequest(client: Client | null, input: {
  channelId: string;
  projectId: string;
  projectSlug?: string;
  approvalId: string;
  artifactName: string;
  requestedByNodeId?: string;
  requestedByPrincipalId?: string;
  sourceBranch?: string;
  targetBranch?: string;
  conflictSummary?: string;
}): Promise<string> {
  if (!client) throw new Error('[discord] Not connected');
  const channel = await client.channels.fetch(input.channelId);
  if (!channel || !channel.isTextBased()) throw new Error(`[discord] Cannot send to channel ${input.channelId}`);
  const sendable = channel as { send: (opts: Record<string, unknown>) => Promise<{ id: string }> };
  const lines = [
    `Patch review required for **${input.projectSlug ?? input.projectId}**`,
    `Artifact: \`${input.artifactName}\``,
    `Approval: \`${input.approvalId}\``,
    input.requestedByNodeId ? `From node: \`${input.requestedByNodeId}\`` : null,
    input.requestedByPrincipalId ? `From principal: \`${input.requestedByPrincipalId}\`` : null,
    input.sourceBranch ? `Source branch: \`${input.sourceBranch}\`` : null,
    input.targetBranch ? `Target branch: \`${input.targetBranch}\`` : null,
    input.conflictSummary ? `Conflict: ${input.conflictSummary}` : null,
    '',
    'Use the buttons below or `/patchapprove` and `/patchdeny`.',
  ].filter(Boolean).join('\n');
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`patchapprove:${input.projectId}:${input.approvalId}`).setLabel('Approve Patch').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`patchdeny:${input.projectId}:${input.approvalId}`).setLabel('Deny Patch').setStyle(ButtonStyle.Danger),
  );
  const msg = await sendable.send({ content: lines, components: [row] });
  return msg.id;
}

export async function sendDiscordPeerTaskApprovalRequest(client: Client | null, input: {
  channelId: string;
  approvalId: string;
  agentId: string;
  requesterName?: string;
  requesterIsBot?: boolean;
  toolName: string;
  toolArgsPreview?: string;
  ownerMentions?: string[];
  projectSlug?: string;
}): Promise<string> {
  if (!client) throw new Error('[discord] Not connected');
  const channel = await client.channels.fetch(input.channelId);
  if (!channel || !channel.isTextBased()) throw new Error(`[discord] Cannot send to channel ${input.channelId}`);
  const sendable = channel as { send: (opts: Record<string, unknown>) => Promise<{ id: string }> };
  const requesterLabel = input.requesterName ?? (input.requesterIsBot ? 'peer agent' : 'shared participant');
  const mentionLine = input.ownerMentions && input.ownerMentions.length > 0
    ? input.ownerMentions.join(' ') + ' approval required.'
    : 'Owner approval required.';
  const lines = [
    mentionLine,
    `Agent: \`${input.agentId}\``,
    input.projectSlug ? `Project: \`${input.projectSlug}\`` : null,
    `Requester: ${requesterLabel}${input.requesterIsBot ? ' (bot)' : ''}`,
    `Tool: \`${input.toolName}\``,
    `Approval: \`${input.approvalId}\``,
    input.toolArgsPreview ? `Args: \`${input.toolArgsPreview}\`` : null,
    '',
    'Approve to allow this exact blocked task once. Deny to keep the agent in readonly mode.',
  ].filter(Boolean).join('\n');
  const row = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId(`peerapprove:${input.approvalId}`).setLabel('Approve Task').setStyle(ButtonStyle.Success),
    new ButtonBuilder().setCustomId(`peerdeny:${input.approvalId}`).setLabel('Deny Task').setStyle(ButtonStyle.Danger),
  );
  const msg = await sendable.send({ content: lines, components: [row] });
  return msg.id;
}
