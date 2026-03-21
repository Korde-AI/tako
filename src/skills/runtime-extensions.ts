import type { Channel } from '../channels/channel.js';
import type { MemoryStore } from '../memory/store.js';
import type { Provider } from '../providers/provider.js';
import type { LoadedSkill } from './types.js';
import { ExtensionRegistry } from './extension-registry.js';
import { getSkillsWithExtension, loadExtension } from './extension-loader.js';
import type { NetworkAdapter } from './extensions.js';
import { loadChannelFromSkill } from './channel-loader.js';

interface SkillRuntimeExtensionsInput {
  loadedSkills: LoadedSkill[];
  skillChannelsConfig?: Record<string, Record<string, unknown>>;
  skillExtensionsConfig?: Record<string, Record<string, Record<string, unknown>>>;
  registerChannel: (channel: Channel, source: string) => void;
}

export async function loadSkillRuntimeExtensions(input: SkillRuntimeExtensionsInput): Promise<ExtensionRegistry> {
  const extensionRegistry = new ExtensionRegistry();

  for (const skill of input.loadedSkills) {
    if (!skill.manifest.hasChannel) continue;
    const channelConfig = input.skillChannelsConfig?.[skill.manifest.name] ?? {};
    const channel = await loadChannelFromSkill(skill, channelConfig);
    if (!channel) continue;
    input.registerChannel(channel, `skill channel: ${skill.manifest.name}`);
  }

  for (const skill of getSkillsWithExtension(input.loadedSkills, 'provider')) {
    const providerConfig = input.skillExtensionsConfig?.[skill.manifest.name]?.provider ?? {};
    const provider = await loadExtension<Provider>(skill, 'provider', providerConfig);
    if (provider) {
      extensionRegistry.register('provider', skill.manifest.name, provider);
    }
  }

  for (const skill of getSkillsWithExtension(input.loadedSkills, 'memory')) {
    const memConfig = input.skillExtensionsConfig?.[skill.manifest.name]?.memory ?? {};
    const memStore = await loadExtension<MemoryStore>(skill, 'memory', memConfig);
    if (memStore) {
      extensionRegistry.register('memory', skill.manifest.name, memStore);
    }
  }

  for (const skill of getSkillsWithExtension(input.loadedSkills, 'channel')) {
    if (skill.manifest.hasChannel) continue;
    const chConfig = input.skillExtensionsConfig?.[skill.manifest.name]?.channel ?? {};
    const channel = await loadExtension<Channel>(skill, 'channel', chConfig);
    if (!channel) continue;
    extensionRegistry.register('channel', skill.manifest.name, channel);
    input.registerChannel(channel, `extension channel: ${skill.manifest.name}`);
  }

  for (const skill of getSkillsWithExtension(input.loadedSkills, 'network')) {
    const netConfig = input.skillExtensionsConfig?.[skill.manifest.name]?.network ?? {};
    const adapter = await loadExtension<NetworkAdapter>(skill, 'network', netConfig);
    if (adapter) {
      extensionRegistry.register('network', skill.manifest.name, adapter);
    }
  }

  return extensionRegistry;
}
