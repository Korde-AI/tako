/**
 * Interactive Model Picker for Discord.
 *
 * Shows an ephemeral embed with provider/model dropdowns and action buttons.
 * Provider selection dynamically updates the model dropdown.
 */

import {
  ActionRowBuilder,
  StringSelectMenuBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  type ChatInputCommandInteraction,
} from 'discord.js';

export interface ModelPickerDeps {
  getModel: () => string;
  setModel: (ref: string) => void;
  getDefaultModel: () => string;
  getProviders: () => string[];
  getModelsForProvider: (provider: string) => string[];
}

export async function showModelPicker(
  interaction: ChatInputCommandInteraction,
  deps: ModelPickerDeps,
): Promise<void> {
  const current = deps.getModel();
  const defaultModel = deps.getDefaultModel();
  const providers = deps.getProviders();

  // Parse current provider/model from ref like "anthropic/claude-sonnet-4-6"
  const slashIdx = current.indexOf('/');
  const currentProvider = slashIdx >= 0 ? current.slice(0, slashIdx) : providers[0];
  const currentModelName = slashIdx >= 0 ? current.slice(slashIdx + 1) : current;

  const models = deps.getModelsForProvider(currentProvider);

  const embed = new EmbedBuilder()
    .setTitle('Model Picker')
    .setDescription(
      `**Current model:** \`${current}\`\n**Default:** \`${defaultModel}\`\n\nSelect a provider and model, then press **Submit**.`,
    )
    .setColor(0x5865f2);

  function buildProviderRow(selected: string) {
    return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('model_picker_provider')
        .setPlaceholder('Select provider')
        .addOptions(
          providers.map((p) => ({
            label: p,
            value: p,
            default: p === selected,
          })),
        ),
    );
  }

  function buildModelRow(modelList: string[], selected: string) {
    const opts = modelList.slice(0, 25);
    if (opts.length === 0) {
      opts.push('(none)');
    }
    return new ActionRowBuilder<StringSelectMenuBuilder>().addComponents(
      new StringSelectMenuBuilder()
        .setCustomId('model_picker_model')
        .setPlaceholder('Select model')
        .addOptions(
          opts.map((m) => ({
            label: m,
            value: m,
            default: m === selected,
          })),
        ),
    );
  }

  const buttons = new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder()
      .setCustomId('model_picker_cancel')
      .setLabel('Cancel')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('model_picker_reset')
      .setLabel('Reset to default')
      .setStyle(ButtonStyle.Secondary),
    new ButtonBuilder()
      .setCustomId('model_picker_submit')
      .setLabel('Submit')
      .setStyle(ButtonStyle.Primary),
  );

  await interaction.reply({
    embeds: [embed],
    components: [buildProviderRow(currentProvider), buildModelRow(models, currentModelName), buttons],
    flags: 64, // ephemeral
  });

  const replyMessage = await interaction.fetchReply();

  let selectedProvider = currentProvider;
  let selectedModel = models.includes(currentModelName) ? currentModelName : models[0] ?? '';

  const collector = replyMessage.createMessageComponentCollector({
    time: 60_000,
  });

  collector.on('collect', async (i) => {
    if (i.customId === 'model_picker_provider' && i.isStringSelectMenu()) {
      selectedProvider = i.values[0];
      const newModels = deps.getModelsForProvider(selectedProvider);
      selectedModel = newModels[0] ?? '';

      await i.update({
        embeds: [embed],
        components: [buildProviderRow(selectedProvider), buildModelRow(newModels, selectedModel), buttons],
      });
    } else if (i.customId === 'model_picker_model' && i.isStringSelectMenu()) {
      selectedModel = i.values[0];
      await i.deferUpdate();
    } else if (i.customId === 'model_picker_submit' && i.isButton()) {
      const fullRef = `${selectedProvider}/${selectedModel}`;
      deps.setModel(fullRef);
      await i.update({
        content: `Model switched to **${fullRef}**`,
        embeds: [],
        components: [],
      });
      collector.stop();
    } else if (i.customId === 'model_picker_reset' && i.isButton()) {
      deps.setModel(defaultModel);
      await i.update({
        content: `Model reset to default: **${defaultModel}**`,
        embeds: [],
        components: [],
      });
      collector.stop();
    } else if (i.customId === 'model_picker_cancel' && i.isButton()) {
      await i.update({
        content: 'Model picker cancelled.',
        embeds: [],
        components: [],
      });
      collector.stop();
    }
  });

  collector.on('end', (_, reason) => {
    if (reason === 'time') {
      interaction
        .editReply({
          content: 'Model picker timed out.',
          embeds: [],
          components: [],
        })
        .catch(() => {});
    }
  });
}
