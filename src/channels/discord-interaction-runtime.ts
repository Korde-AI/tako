import { Events, type ButtonInteraction, type ChatInputCommandInteraction, type Client, type ModalSubmitInteraction, type StringSelectMenuInteraction } from 'discord.js';
import type { DiscordInteractionState } from './discord-types.js';

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
