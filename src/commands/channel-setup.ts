/**
 * Channel Setup — secure credential entry via Discord Modals.
 *
 * Flow: /setup → agent selector → channel type buttons → modal for token → store securely.
 * All interactions are ephemeral. Tokens are never echoed in messages.
 */

import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  type ChatInputCommandInteraction,
  type StringSelectMenuInteraction,
  type ButtonInteraction,
  type ModalSubmitInteraction,
} from 'discord.js';

export interface ChannelSetupDeps {
  listAgents: () => Array<{ id: string; description: string }>;
  saveChannelConfig: (agentId: string, channelType: string, config: Record<string, unknown>) => Promise<void>;
}

/**
 * Handle the /setup slash command — show agent selector.
 */
export async function handleSetupCommand(
  interaction: ChatInputCommandInteraction,
  deps: ChannelSetupDeps,
): Promise<void> {
  const agents = deps.listAgents();

  if (agents.length === 0) {
    await interaction.reply({
      content: 'No agents registered. Create an agent first.',
      flags: 64,
    });
    return;
  }

  const options = agents.slice(0, 25).map((a) => ({
    label: a.id,
    value: a.id,
    description: a.description ? a.description.slice(0, 100) : undefined,
  }));

  const selectRow = new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
    new StringSelectMenuBuilder()
      .setCustomId('setup_agent_select')
      .setPlaceholder('Select an agent to configure channels')
      .addOptions(options),
  );

  await interaction.reply({
    content: '**Channel Setup** — Select an agent to configure:',
    components: [selectRow],
    flags: 64,
  });
}

/**
 * Handle agent selection — show channel type buttons.
 */
export async function handleAgentSelect(
  interaction: StringSelectMenuInteraction,
): Promise<void> {
  const agentId = interaction.values[0];

  const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId(`setup_type_discord_${agentId}`)
      .setLabel('Discord Bot')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId(`setup_type_telegram_${agentId}`)
      .setLabel('Telegram Bot')
      .setStyle(ButtonStyle.Primary),
    new ButtonBuilder()
      .setCustomId('setup_cancel')
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary),
  );

  await interaction.update({
    content: `**Channel Setup** — Agent: **${agentId}**\nSelect channel type:`,
    components: [buttonRow],
  });
}

/**
 * Handle channel type button — show the appropriate modal.
 */
export async function handleChannelTypeButton(
  interaction: ButtonInteraction,
): Promise<void> {
  const customId = interaction.customId;

  if (customId === 'setup_cancel') {
    await interaction.update({
      content: 'Channel setup cancelled.',
      components: [],
    });
    return;
  }

  // Parse: setup_type_discord_<agentId> or setup_type_telegram_<agentId>
  const match = customId.match(/^setup_type_(discord|telegram)_(.+)$/);
  if (!match) return;

  const channelType = match[1];
  const agentId = match[2];

  if (channelType === 'discord') {
    const modal = new ModalBuilder()
      .setCustomId(`setup_modal_discord_${agentId}`)
      .setTitle(`Discord Setup — ${agentId}`)
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('bot_token')
            .setLabel('Bot Token')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Paste your Discord bot token here')
            .setRequired(true),
        ),
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('guild_id')
            .setLabel('Guild ID (server to listen in)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Right-click server → Copy Server ID')
            .setRequired(false),
        ),
      );
    await interaction.showModal(modal);
  } else {
    const modal = new ModalBuilder()
      .setCustomId(`setup_modal_telegram_${agentId}`)
      .setTitle(`Telegram Setup — ${agentId}`)
      .addComponents(
        new ActionRowBuilder<TextInputBuilder>().addComponents(
          new TextInputBuilder()
            .setCustomId('bot_token')
            .setLabel('Bot Token from @BotFather')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Paste your Telegram bot token here')
            .setRequired(true),
        ),
      );
    await interaction.showModal(modal);
  }
}

/**
 * Handle modal submission — securely store the token.
 */
export async function handleModalSubmit(
  interaction: ModalSubmitInteraction,
  deps: ChannelSetupDeps,
): Promise<void> {
  const customId = interaction.customId;

  const match = customId.match(/^setup_modal_(discord|telegram)_(.+)$/);
  if (!match) return;

  const channelType = match[1];
  const agentId = match[2];

  const botToken = interaction.fields.getTextInputValue('bot_token');

  if (channelType === 'discord') {
    const guildId = interaction.fields.getTextInputValue('guild_id');
    const guilds = guildId ? [guildId.trim()] : [];

    await deps.saveChannelConfig(agentId, 'discord', {
      enabled: true,
      token: botToken.trim(),
      guilds,
    });

    await interaction.reply({
      content: `Discord bot configured for **${agentId}**. Restart Tako to connect.`,
      flags: 64,
    });
  } else {
    await deps.saveChannelConfig(agentId, 'telegram', {
      enabled: true,
      token: botToken.trim(),
    });

    await interaction.reply({
      content: `Telegram bot configured for **${agentId}**. Restart Tako to connect.`,
      flags: 64,
    });
  }
}
