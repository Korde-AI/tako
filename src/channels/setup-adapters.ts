import {
  ActionRowBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ButtonStyle,
  type ModalSubmitInteraction,
} from 'discord.js';
import type { ChannelPlatform, ChannelPlatformRegistry } from './platforms.js';

export interface ChannelSetupSaveDeps {
  saveChannelConfig: (agentId: string, channelType: string, config: Record<string, unknown>) => Promise<void>;
}

export interface ChannelSetupAdapter {
  platform: ChannelPlatform;
  label: string;
  buttonStyle?: ButtonStyle;
  buildModal(agentId: string): ModalBuilder;
  saveFromModal(input: {
    interaction: ModalSubmitInteraction;
    agentId: string;
    deps: ChannelSetupSaveDeps;
  }): Promise<string>;
}

export class ChannelSetupAdapterRegistry {
  private adapters = new Map<ChannelPlatform, ChannelSetupAdapter>();

  register(adapter: ChannelSetupAdapter): void {
    this.adapters.set(adapter.platform, adapter);
  }

  get(platform: ChannelPlatform): ChannelSetupAdapter | undefined {
    return this.adapters.get(platform);
  }

  list(): ChannelSetupAdapter[] {
    return Array.from(this.adapters.values()).sort((a, b) => a.platform.localeCompare(b.platform));
  }
}

export function createBuiltinChannelSetupAdapters(
  platformRegistry?: ChannelPlatformRegistry,
): ChannelSetupAdapterRegistry {
  const registry = new ChannelSetupAdapterRegistry();

  const discordAdapter: ChannelSetupAdapter = {
    platform: 'discord',
    label: 'Discord Bot',
    buttonStyle: ButtonStyle.Primary,
    buildModal(agentId: string): ModalBuilder {
      return new ModalBuilder()
        .setCustomId(`setup:modal:discord:${agentId}`)
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
    },
    async saveFromModal({ interaction, agentId, deps }): Promise<string> {
      const botToken = interaction.fields.getTextInputValue('bot_token').trim();
      const guildId = interaction.fields.getTextInputValue('guild_id').trim();
      await deps.saveChannelConfig(agentId, 'discord', {
        enabled: true,
        token: botToken,
        guilds: guildId ? [guildId] : [],
      });
      return `Discord bot configured for **${agentId}**. Restart Tako to connect.`;
    },
  };

  const telegramAdapter: ChannelSetupAdapter = {
    platform: 'telegram',
    label: 'Telegram Bot',
    buttonStyle: ButtonStyle.Primary,
    buildModal(agentId: string): ModalBuilder {
      return new ModalBuilder()
        .setCustomId(`setup:modal:telegram:${agentId}`)
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
    },
    async saveFromModal({ interaction, agentId, deps }): Promise<string> {
      const botToken = interaction.fields.getTextInputValue('bot_token').trim();
      await deps.saveChannelConfig(agentId, 'telegram', {
        enabled: true,
        token: botToken,
      });
      return `Telegram bot configured for **${agentId}**. Restart Tako to connect.`;
    },
  };

  for (const adapter of [discordAdapter, telegramAdapter]) {
    registry.register(adapter);
    platformRegistry?.register({
      id: adapter.platform,
      displayName: adapter.label,
      supportsInteractiveSetup: true,
      supportsProjectBindings: true,
    });
  }

  return registry;
}
