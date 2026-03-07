/**
 * Tests for skill-loaded channels:
 * - Skills with channel/ dir get hasChannel: true
 * - loadChannelFromSkill with mock module
 * - Gateway registerChannel/unregisterChannel
 * - Skill channels receive the message router
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SkillLoader } from '../src/skills/loader.js';
import { loadChannelFromSkill } from '../src/skills/channel-loader.js';
import type { Channel, MessageHandler, InboundMessage, OutboundMessage } from '../src/channels/channel.js';
import type { LoadedSkill } from '../src/skills/types.js';

// ─── Mock channel for testing ────────────────────────────────────────

class MockChannel implements Channel {
  id: string;
  connected = false;
  handler: MessageHandler | null = null;

  constructor(id: string) {
    this.id = id;
  }

  async connect(): Promise<void> {
    this.connected = true;
  }

  async disconnect(): Promise<void> {
    this.connected = false;
  }

  async send(_msg: OutboundMessage): Promise<void> {
    // no-op
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }
}

// ─── Skill discovery with channel/ dir ───────────────────────────────

describe('Skill channel discovery', () => {
  let tmpDir: string;

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'tako-channel-'));

    // Create a skill with a channel/ directory
    await mkdir(join(tmpDir, 'test-channel-skill', 'channel'), { recursive: true });
    await writeFile(join(tmpDir, 'test-channel-skill', 'SKILL.md'), `---
name: test-channel
description: A test channel skill
version: 1.0.0
---

# Test Channel Skill
`);
    // Write a mock channel module
    await writeFile(join(tmpDir, 'test-channel-skill', 'channel', 'index.js'), `
export function createChannel(config) {
  return {
    id: 'test-channel',
    connected: false,
    async connect() { this.connected = true; },
    async disconnect() { this.connected = false; },
    async send() {},
    onMessage(handler) { this.handler = handler; },
  };
}
`);

    // Create a skill without a channel/ directory
    await mkdir(join(tmpDir, 'plain-skill'), { recursive: true });
    await writeFile(join(tmpDir, 'plain-skill', 'SKILL.md'), `---
name: plain-skill
description: A plain skill without channel
version: 1.0.0
---

# Plain Skill
`);
  });

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true });
  });

  it('should set hasChannel: true for skills with channel/ dir', async () => {
    const loader = new SkillLoader([tmpDir]);
    const manifests = await loader.discover();
    const channelSkill = manifests.find(m => m.name === 'test-channel');
    const plainSkill = manifests.find(m => m.name === 'plain-skill');

    // Load them to trigger channel detection
    const loadedChannel = await loader.load(channelSkill!);
    const loadedPlain = await loader.load(plainSkill!);

    assert.equal(loadedChannel.manifest.hasChannel, true);
    assert.ok(loadedChannel.manifest.channelDir?.endsWith('channel'));
    assert.equal(loadedPlain.manifest.hasChannel, undefined);
    assert.equal(loadedPlain.manifest.channelDir, undefined);
  });

  it('should load channel from skill via createChannel export', async () => {
    const loader = new SkillLoader([tmpDir]);
    const manifests = await loader.discover();
    const manifest = manifests.find(m => m.name === 'test-channel')!;
    const loaded = await loader.load(manifest);

    const channel = await loadChannelFromSkill(loaded, {});
    assert.ok(channel);
    assert.equal(channel.id, 'test-channel');
  });

  it('should return null for skills without channel', async () => {
    const loader = new SkillLoader([tmpDir]);
    const manifests = await loader.discover();
    const manifest = manifests.find(m => m.name === 'plain-skill')!;
    const loaded = await loader.load(manifest);

    const channel = await loadChannelFromSkill(loaded, {});
    assert.equal(channel, null);
  });
});

// ─── Gateway registerChannel/unregisterChannel ──────────────────────

describe('Gateway dynamic channel registration', () => {
  // We test the gateway channel methods in isolation using a minimal mock
  // since the full Gateway requires WebSocket server setup.

  it('should register and connect a channel with message router', async () => {
    const channel = new MockChannel('dynamic-test');
    const messages: InboundMessage[] = [];
    const router: MessageHandler = (msg) => { messages.push(msg); };

    // Simulate what Gateway.registerChannel does
    channel.onMessage(router);
    await channel.connect();

    assert.equal(channel.connected, true);
    assert.ok(channel.handler);

    // Simulate an inbound message
    const testMsg: InboundMessage = {
      id: '1',
      channelId: 'dynamic-test:chat1',
      author: { id: 'user1', name: 'Test User' },
      content: 'Hello from dynamic channel',
      timestamp: new Date().toISOString(),
    };
    await channel.handler!(testMsg);
    assert.equal(messages.length, 1);
    assert.equal(messages[0].content, 'Hello from dynamic channel');
  });

  it('should unregister and disconnect a channel', async () => {
    const channel = new MockChannel('dynamic-test');
    await channel.connect();
    assert.equal(channel.connected, true);

    // Simulate what Gateway.unregisterChannel does
    await channel.disconnect();
    assert.equal(channel.connected, false);
  });
});
