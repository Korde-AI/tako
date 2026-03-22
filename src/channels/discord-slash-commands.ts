import { REST, Routes, type Client } from 'discord.js';
import type { SkillCommandSpec } from '../commands/skill-commands.js';
import type { DiscordInteractionState, SlashCommandHandler } from './discord-types.js';

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
