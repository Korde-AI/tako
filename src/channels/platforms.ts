export type ChannelPlatform = string;

export interface ChannelPlatformDescriptor {
  id: ChannelPlatform;
  displayName?: string;
  supportsProjectBindings?: boolean;
  supportsInteractiveSetup?: boolean;
}

export class ChannelPlatformRegistry {
  private descriptors = new Map<ChannelPlatform, ChannelPlatformDescriptor>();

  register(descriptor: ChannelPlatformDescriptor): void {
    const existing = this.descriptors.get(descriptor.id);
    this.descriptors.set(descriptor.id, {
      ...existing,
      ...descriptor,
    });
  }

  get(id: ChannelPlatform): ChannelPlatformDescriptor | undefined {
    return this.descriptors.get(id);
  }

  has(id: ChannelPlatform): boolean {
    return this.descriptors.has(id);
  }

  list(): ChannelPlatformDescriptor[] {
    return Array.from(this.descriptors.values()).sort((a, b) => a.id.localeCompare(b.id));
  }
}

export const DEFAULT_CHANNEL_PLATFORM: ChannelPlatform = 'cli';

export const BUILTIN_CHANNEL_PLATFORMS: ChannelPlatformDescriptor[] = [
  { id: 'cli', displayName: 'CLI', supportsProjectBindings: true },
  { id: 'discord', displayName: 'Discord', supportsProjectBindings: true, supportsInteractiveSetup: true },
  { id: 'telegram', displayName: 'Telegram', supportsProjectBindings: true, supportsInteractiveSetup: true },
];

export function createBuiltinChannelPlatformRegistry(): ChannelPlatformRegistry {
  const registry = new ChannelPlatformRegistry();
  for (const descriptor of BUILTIN_CHANNEL_PLATFORMS) {
    registry.register(descriptor);
  }
  return registry;
}

export function inferChannelPlatformFromChannelId(
  channelId: string,
  registry?: ChannelPlatformRegistry,
  fallback: ChannelPlatform = DEFAULT_CHANNEL_PLATFORM,
): ChannelPlatform {
  const candidate = channelId.includes(':')
    ? channelId.slice(0, channelId.indexOf(':'))
    : channelId;
  if (!candidate) return fallback;
  if (!registry || registry.has(candidate)) return candidate;
  return candidate;
}
