import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  Events,
  REST,
  Routes,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type Client,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import type { SkillCommandSpec } from '../commands/skill-commands.js';
import type { DiscordInteractionState, SlashCommandHandler } from './discord-types.js';

export function wireDiscordInteractionHandlers(
  client: Client,
  state: DiscordInteractionState,
  _registerSlashCommands: (clientId: string) => Promise<void>,
): void {
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const cmdInteraction = interaction as ChatInputCommandInteraction;
    const interactiveHandler = state.interactiveHandlers.get(cmdInteraction.commandName);
    if (interactiveHandler) {
      try {
        const handled = await interactiveHandler(cmdInteraction);
        if (handled) return;
      } catch (err) {
        console.error('[discord] Interactive handler error:', err instanceof Error ? err.message : err);
        if (!cmdInteraction.replied && !cmdInteraction.deferred) {
          await cmdInteraction.reply({ content: 'Something went wrong.', ephemeral: true });
        }
        return;
      }
    }

    if (!state.slashCommandHandler) {
      await cmdInteraction.reply({ content: 'Commands not ready yet.', ephemeral: true });
      return;
    }

    try {
      await cmdInteraction.deferReply();
      const author = {
        id: cmdInteraction.user.id,
        name: cmdInteraction.user.displayName || cmdInteraction.user.username,
        meta: {
          username: cmdInteraction.user.username,
          discriminator: cmdInteraction.user.discriminator,
          guildId: cmdInteraction.guild?.id,
          guildName: cmdInteraction.guild?.name,
          channelName: cmdInteraction.channel && 'name' in cmdInteraction.channel
            ? (cmdInteraction.channel as { name?: string }).name ?? undefined
            : undefined,
        },
      };
      const result = await state.slashCommandHandler(
        cmdInteraction.commandName,
        cmdInteraction.channelId,
        author,
        cmdInteraction.guild?.id,
      );
      await cmdInteraction.editReply({ content: result || 'Done.' });
    } catch (err) {
      console.error('[discord] Slash command handler error:', err instanceof Error ? err.stack || err.message : err);
      try {
        if (cmdInteraction.deferred || cmdInteraction.replied) {
          await cmdInteraction.editReply({ content: 'Command failed. Check Tako logs for the exact error.' });
        } else {
          await cmdInteraction.reply({ content: 'Command failed. Check Tako logs for the exact error.', ephemeral: true });
        }
      } catch {
        // Ignore secondary Discord API failures.
      }
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isModalSubmit()) return;
    for (const handler of state.modalHandlers) {
      try {
        const handled = await handler(interaction as ModalSubmitInteraction);
        if (handled) return;
      } catch (err) {
        console.error('[discord] Modal handler error:', err instanceof Error ? err.message : err);
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: 'Something went wrong.', flags: 64 }).catch(() => {});
        }
        return;
      }
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isStringSelectMenu()) return;
    for (const handler of state.selectMenuHandlers) {
      try {
        const handled = await handler(interaction as StringSelectMenuInteraction);
        if (handled) return;
      } catch (err) {
        console.error('[discord] Select menu handler error:', err instanceof Error ? err.message : err);
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: 'Something went wrong.', flags: 64 }).catch(() => {});
        }
        return;
      }
    }
  });

  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isButton()) return;
    for (const handler of state.buttonHandlers) {
      try {
        const handled = await handler(interaction as ButtonInteraction);
        if (handled) return;
      } catch (err) {
        console.error('[discord] Button handler error:', err instanceof Error ? err.message : err);
        if (!interaction.replied && !interaction.deferred) {
          await interaction.reply({ content: 'Something went wrong.', flags: 64 }).catch(() => {});
        }
        return;
      }
    }
  });
}

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

export async function registerDiscordSkillCommands(
  state: DiscordInteractionState,
  client: Client | null,
  specs: SkillCommandSpec[],
  handler: SlashCommandHandler,
  registerSlashCommands: (clientId: string) => Promise<void>,
): Promise<void> {
  const skillNames = new Set(specs.map((s) => s.name));
  const coreCommands = state.nativeCommands.filter((c) => !skillNames.has(c.name) && !state.previousSkillNames?.has(c.name));
  const skillCommands = specs.map((s) => ({ name: s.name, description: s.description }));
  const coreFiltered = coreCommands.filter((c) => !skillNames.has(c.name));
  state.nativeCommands = [...coreFiltered, ...skillCommands];
  state.previousSkillNames = skillNames;
  state.slashCommandHandler = handler;
  const clientId = client?.user?.id;
  if (clientId) {
    await registerSlashCommands(clientId);
  }
}

export async function registerDiscordSlashCommands(
  client: Client | null,
  token: string,
  guilds: Set<string> | undefined,
  nativeCommands: Array<{ name: string; description: string }>,
  clientId: string,
): Promise<void> {
  const rest = new REST({ version: '10' }).setToken(token);
  const deduped = new Map<string, { name: string; description: string }>();
  for (const cmd of nativeCommands) deduped.set(cmd.name, { name: cmd.name, description: cmd.description });
  const body = Array.from(deduped.values());
  const MAX_SLASH_COMMANDS = 25;
  const registerBody = body.length > MAX_SLASH_COMMANDS ? body.slice(0, MAX_SLASH_COMMANDS) : body;

  if (body.length > MAX_SLASH_COMMANDS) {
    console.warn(`[discord] Slash command limit is ${MAX_SLASH_COMMANDS}; truncating ${body.length} -> ${registerBody.length}`);
  }

  if (guilds && guilds.size > 0) {
    for (const guildId of guilds) {
      try {
        await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: registerBody });
        console.log(`[discord] ✦ Registered ${registerBody.length} slash commands for guild ${guildId}`);
      } catch (err) {
        console.error(`[discord] Failed to register commands for guild ${guildId}:`, err instanceof Error ? err.message : err);
      }
    }
    try {
      await rest.put(Routes.applicationCommands(clientId), { body: registerBody });
      console.log(`[discord] ✦ Synced ${registerBody.length} global slash commands for DM support`);
    } catch (err) {
      console.warn('[discord] Could not sync global slash commands:', err instanceof Error ? err.message : err);
    }
    return;
  }

  if (client) {
    const guildCache = client.guilds.cache;
    if (guildCache.size > 0) {
      for (const [guildId] of guildCache) {
        try {
          await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: registerBody });
          console.log(`[discord] ✦ Registered ${registerBody.length} slash commands for guild ${guildId}`);
        } catch (err) {
          console.error(`[discord] Failed to register commands for guild ${guildId}:`, err instanceof Error ? err.message : err);
        }
      }
      try {
        await rest.put(Routes.applicationCommands(clientId), { body: registerBody });
        console.log(`[discord] ✦ Synced ${registerBody.length} global slash commands for DM support`);
      } catch (err) {
        console.warn('[discord] Could not sync global slash commands:', err instanceof Error ? err.message : err);
      }
      return;
    }
  }

  try {
    await rest.put(Routes.applicationCommands(clientId), { body: registerBody });
    console.log(`[discord] ✦ Registered ${registerBody.length} slash commands globally`);
  } catch (err) {
    console.error('[discord] Failed to register global commands:', err instanceof Error ? err.message : err);
  }
}
