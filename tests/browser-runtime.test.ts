import { describe, it } from 'bun:test';
import assert from 'node:assert/strict';
import { ToolRegistry } from '../src/tools/registry.js';
import { createBrowserTools } from '../src/tools/browser.js';

describe('browser runtime wiring', () => {
  it('registers browser tools when browser config is enabled', () => {
    const registry = new ToolRegistry();
    registry.setProfile('full');

    registry.registerAll(createBrowserTools({
      enabled: true,
      headless: true,
      idleTimeoutMs: 300_000,
    }));

    const names = registry.getActiveTools().map((tool) => tool.name);
    assert.ok(names.includes('browser_navigate'));
    assert.ok(names.includes('browser_snapshot'));
    assert.ok(names.includes('browser_screenshot'));
    assert.ok(names.includes('browser_click'));
    assert.ok(names.includes('browser_type'));
    assert.ok(names.includes('browser_evaluate'));
  });

  it('blocks browser tools when browser config is disabled', async () => {
    const tools = createBrowserTools({
      enabled: false,
      headless: true,
      idleTimeoutMs: 300_000,
    });

    const navigate = tools.find((tool) => tool.name === 'browser_navigate');
    assert.ok(navigate);

    const result = await navigate.execute(
      { url: 'https://example.com' },
      { sessionId: 's1', workDir: process.cwd(), workspaceRoot: process.cwd() },
    );

    assert.equal(result.success, false);
    assert.match(result.error ?? '', /disabled/i);
  });
});
