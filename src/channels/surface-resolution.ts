import type { Channel } from './channel.js';
import type { DiscordChannel } from './discord.js';
import type { TelegramChannel } from './telegram.js';

interface ChannelSurfaceResolverDeps {
  channels: Channel[];
  discordChannels: DiscordChannel[];
  discordFallback?: DiscordChannel;
  telegramFallback?: TelegramChannel;
}

export function createChannelSurfaceResolvers(deps: ChannelSurfaceResolverDeps) {
  const resolveDiscord = (agentId?: string): DiscordChannel | undefined => {
    if (agentId) {
      const agentChannel = deps.discordChannels.find((channel) => channel.agentId === agentId);
      if (agentChannel) return agentChannel;
    }
    return deps.discordFallback;
  };

  const resolveTelegram = (agentId?: string): TelegramChannel | undefined => {
    const agentChannel = deps.channels.find(
      (channel) => channel.id === 'telegram' && (channel as { agentId?: string }).agentId === agentId,
    ) as TelegramChannel | undefined;
    return agentChannel ?? deps.telegramFallback;
  };

  return {
    resolveDiscord,
    resolveTelegram,
  };
}
