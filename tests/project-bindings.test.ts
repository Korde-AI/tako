import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ProjectBindingRegistry } from '../src/projects/bindings.js';

describe('ProjectBindingRegistry', () => {
  it('ignores inactive bindings during resolve', async () => {
    const root = await mkdtemp(join(tmpdir(), 'tako-bindings-'));
    const registry = new ProjectBindingRegistry(root);
    await registry.load();

    await registry.bind({
      projectId: 'project-1',
      platform: 'discord',
      channelTarget: 'channel-1',
      agentId: 'main',
    });

    let resolved = registry.resolve({
      platform: 'discord',
      channelTarget: 'channel-1',
      agentId: 'main',
    });
    assert.ok(resolved);

    await registry.deactivateMatching({
      platform: 'discord',
      channelTarget: 'channel-1',
      reason: 'discord_channel_deleted',
    });

    resolved = registry.resolve({
      platform: 'discord',
      channelTarget: 'channel-1',
      agentId: 'main',
    });
    assert.equal(resolved, null);
  });
});
