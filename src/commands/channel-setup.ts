/**
 * Channel setup controller — interactive credential entry via Discord modals.
 *
 * The controller itself is platform-agnostic. Channel-specific setup behavior
 * lives in channel setup adapters.
 */

import {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  type ButtonInteraction,
  type ChatInputCommandInteraction,
  type ModalSubmitInteraction,
  type StringSelectMenuInteraction,
} from 'discord.js';
import {
  createBuiltinChannelSetupAdapters,
  type ChannelSetupAdapterRegistry,
} from '../channels/setup-adapters.js';

export interface ChannelSetupDeps {
  listAgents: () => Array<{ id: string; description: string }>;
  saveChannelConfig: (agentId: string, channelType: string, config: Record<string, unknown>) => Promise<void>;
}

export interface ChannelSetupController {
  handleSetupCommand(interaction: ChatInputCommandInteraction): Promise<void>;
  handleAgentSelect(interaction: StringSelectMenuInteraction): Promise<boolean>;
  handleButton(interaction: ButtonInteraction): Promise<boolean>;
  handleModalSubmit(interaction: ModalSubmitInteraction): Promise<boolean>;
}

export function createChannelSetupController(input: {
  deps: ChannelSetupDeps;
  adapters?: ChannelSetupAdapterRegistry;
}): ChannelSetupController {
  const adapters = input.adapters ?? createBuiltinChannelSetupAdapters();

  return {
    async handleSetupCommand(interaction: ChatInputCommandInteraction): Promise<void> {
      const agents = input.deps.listAgents();

      if (agents.length === 0) {
        await interaction.reply({
          content: 'No agents registered. Create an agent first.',
          flags: 64,
        });
        return;
      }

      const options = agents.slice(0, 25).map((agent) => ({
        label: agent.id,
        value: agent.id,
        description: agent.description ? agent.description.slice(0, 100) : undefined,
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
    },

    async handleAgentSelect(interaction: StringSelectMenuInteraction): Promise<boolean> {
      if (interaction.customId !== 'setup_agent_select') return false;
      const agentId = interaction.values[0];
      const buttons = adapters.list().map((adapter) =>
        new ButtonBuilder()
          .setCustomId(`setup:type:${adapter.platform}:${agentId}`)
          .setLabel(adapter.label)
          .setStyle(adapter.buttonStyle ?? ButtonStyle.Primary));

      buttons.push(
        new ButtonBuilder()
          .setCustomId('setup_cancel')
          .setLabel('Cancel')
          .setStyle(ButtonStyle.Secondary),
      );

      const buttonRow = new ActionRowBuilder<ButtonBuilder>().addComponents(buttons);
      await interaction.update({
        content: `**Channel Setup** — Agent: **${agentId}**\nSelect channel type:`,
        components: [buttonRow],
      });
      return true;
    },

    async handleButton(interaction: ButtonInteraction): Promise<boolean> {
      const customId = interaction.customId;
      if (customId === 'setup_cancel') {
        await interaction.update({
          content: 'Channel setup cancelled.',
          components: [],
        });
        return true;
      }

      const match = customId.match(/^setup:type:([^:]+):(.+)$/);
      if (!match) return false;

      const platform = match[1];
      const agentId = match[2];
      const adapter = adapters.get(platform);
      if (!adapter) return false;

      await interaction.showModal(adapter.buildModal(agentId));
      return true;
    },

    async handleModalSubmit(interaction: ModalSubmitInteraction): Promise<boolean> {
      const match = interaction.customId.match(/^setup:modal:([^:]+):(.+)$/);
      if (!match) return false;

      const platform = match[1];
      const agentId = match[2];
      const adapter = adapters.get(platform);
      if (!adapter) return false;

      const content = await adapter.saveFromModal({
        interaction,
        agentId,
        deps: input.deps,
      });

      await interaction.reply({
        content,
        flags: 64,
      });
      return true;
    },
  };
}
