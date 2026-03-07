/**
 * Channel skill loader — loads channel adapters from skill directories.
 *
 * Skills can provide channel adapters by including a channel/ subdirectory
 * with a module that exports a class implementing the Channel interface.
 * The channel is registered with the gateway on gateway_start.
 */

import { join } from 'node:path';
import type { Channel } from '../channels/channel.js';
import type { LoadedSkill } from './types.js';

export interface ChannelFactory {
  create(config: Record<string, unknown>): Channel;
}

/**
 * Load a channel adapter from a skill's channel/ directory.
 * Expects a default export or named `createChannel` export.
 */
export async function loadChannelFromSkill(
  skill: LoadedSkill,
  config: Record<string, unknown>,
): Promise<Channel | null> {
  if (!skill.manifest.hasChannel || !skill.manifest.channelDir) {
    return null;
  }

  try {
    // Try loading the main channel module
    const modulePath = join(skill.manifest.channelDir, 'index.js');
    const mod = await import(modulePath);

    if (typeof mod.createChannel === 'function') {
      return mod.createChannel(config);
    }
    if (typeof mod.default === 'function') {
      return new mod.default(config);
    }

    console.warn(`[channel-loader] Skill "${skill.manifest.name}" has channel/ dir but no createChannel export`);
    return null;
  } catch (err) {
    console.error(`[channel-loader] Failed to load channel from skill "${skill.manifest.name}":`, err);
    return null;
  }
}
