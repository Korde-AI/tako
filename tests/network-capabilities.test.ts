import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { CapabilityRegistry } from '../src/network/capabilities.js';

describe('network capabilities', () => {
  let root: string;

  beforeEach(async () => {
    root = join(tmpdir(), `tako-capabilities-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('loads defaults and can disable a capability', async () => {
    const registry = new CapabilityRegistry(join(root, 'capabilities.json'));
    await registry.load();
    assert.ok(registry.get('summarize_workspace'));
    const updated = await registry.setEnabled('summarize_workspace', false);
    assert.equal(updated.enabled, false);
    assert.equal(registry.listEnabled().some((row) => row.capabilityId === 'summarize_workspace'), false);
  });
});
