import type { ProjectBindingRegistry } from './bindings.js';
import type { ProjectChannelCoordinatorRegistry } from './channel-coordination.js';

interface ProjectRoomNotifierDeps {
  projectBindings: ProjectBindingRegistry;
  projectChannelCoordinators: ProjectChannelCoordinatorRegistry;
}

export function createProjectRoomNotifier(deps: ProjectRoomNotifierDeps) {
  const notify = async (projectId: string, content: string): Promise<void> => {
    const bindings = deps.projectBindings.list().filter((binding) => binding.projectId === projectId);
    if (bindings.length === 0) return;
    const bindingsByPlatform = new Map<string, typeof bindings>();
    for (const binding of bindings) {
      const bucket = bindingsByPlatform.get(binding.platform) ?? [];
      bucket.push(binding);
      bindingsByPlatform.set(binding.platform, bucket);
    }
    for (const [platform, platformBindings] of bindingsByPlatform.entries()) {
      const coordinator = deps.projectChannelCoordinators.get(platform as 'discord' | 'telegram' | 'cli');
      if (!coordinator) continue;
      await coordinator.notifyBindings(platformBindings, content);
    }
  };

  return {
    notify,
  };
}
