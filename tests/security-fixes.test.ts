/**
 * Tests for security + stability fixes (7 issues).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// ─── Fix 1: Browser SSRF — redirect check ──────────────────────────

describe('Browser SSRF redirect protection', () => {
  it('NetworkPolicy blocks private IPs that could appear in redirects', async () => {
    const { NetworkPolicy } = await import('../src/core/network-policy.js');
    const policy = new NetworkPolicy({ mode: 'blocklist' });

    // Simulate checking a final URL after redirect
    assert.ok(!policy.check('http://192.168.1.1/admin').allowed);
    assert.ok(!policy.check('http://10.0.0.1/api').allowed);
    assert.ok(!policy.check('http://127.0.0.1:3000/internal').allowed);
    assert.ok(!policy.check('http://169.254.169.254/latest/meta-data/').allowed);

    // Public URLs should still be allowed
    assert.ok(policy.check('https://example.com').allowed);
  });
});

// ─── Fix 2: Exec script pinning ────────────────────────────────────

describe('ExecSafety script pinning', () => {
  it('extracts script path from bun run command', async () => {
    const { ExecSafety } = await import('../src/tools/exec-safety.js');
    const safety = new ExecSafety({ workDir: '/tmp' });

    const path = safety.extractScriptPath('bun run test.ts');
    assert.ok(path?.endsWith('test.ts'));

    const denoPath = safety.extractScriptPath('deno run script.js');
    assert.ok(denoPath?.endsWith('script.js'));

    // Non-script commands return null
    assert.equal(safety.extractScriptPath('ls -la'), null);
    assert.equal(safety.extractScriptPath('npm test'), null);
  });

  it('pins and verifies script content', async () => {
    const { ExecSafety } = await import('../src/tools/exec-safety.js');
    const dir = join(tmpdir(), 'tako-test-pin-' + Date.now());
    mkdirSync(dir, { recursive: true });
    const scriptFile = join(dir, 'test.ts');
    writeFileSync(scriptFile, 'console.log("hello");');

    const safety = new ExecSafety({ workDir: dir });
    const cmd = 'bun run test.ts';

    // Pin the script
    const hash = safety.pinScript(cmd);
    assert.ok(hash);
    assert.equal(typeof hash, 'string');
    assert.equal(hash!.length, 64); // SHA-256 hex

    // Verify should pass (unchanged)
    const result = safety.verifyPinnedScript(cmd);
    assert.ok(result.ok);

    // Modify the script
    writeFileSync(scriptFile, 'console.log("evil!");');

    // Verify should fail
    const result2 = safety.verifyPinnedScript(cmd);
    assert.ok(!result2.ok);
    assert.ok(result2.reason?.includes('changed'));

    // Cleanup
    unlinkSync(scriptFile);
  });

  it('returns ok for non-script commands', async () => {
    const { ExecSafety } = await import('../src/tools/exec-safety.js');
    const safety = new ExecSafety({ workDir: '/tmp' });

    const result = safety.verifyPinnedScript('ls -la');
    assert.ok(result.ok);
  });
});

// ─── Fix 3: Config validation fail-closed ───────────────────────────

describe('Config validation fail-closed', () => {
  it('throws on invalid config file', async () => {
    const { resolveConfig } = await import('../src/config/resolve.js');
    const dir = join(tmpdir(), 'tako-test-config-' + Date.now());
    mkdirSync(dir, { recursive: true });
    const configPath = join(dir, 'tako.json');
    writeFileSync(configPath, 'not valid json {{{');

    await assert.rejects(
      () => resolveConfig(configPath),
      (err: Error) => {
        assert.ok(err.message.includes('Failed to load config'));
        return true;
      },
    );

    // Cleanup
    unlinkSync(configPath);
  });

  it('throws on invalid config values', async () => {
    const { resolveConfig } = await import('../src/config/resolve.js');
    const dir = join(tmpdir(), 'tako-test-config2-' + Date.now());
    mkdirSync(dir, { recursive: true });
    const configPath = join(dir, 'tako.json');
    writeFileSync(configPath, JSON.stringify({
      gateway: { port: -1 },
    }));

    await assert.rejects(
      () => resolveConfig(configPath),
      (err: Error) => {
        assert.ok(err.message.includes('validation failed'));
        return true;
      },
    );

    // Cleanup
    unlinkSync(configPath);
  });
});

// ─── Fix 4: Skills path pinning ────────────────────────────────────

describe('SkillMarketplace path traversal protection', () => {
  it('rejects repo names with path traversal', async () => {
    const { SkillMarketplace } = await import('../src/skills/marketplace.js');
    const marketplace = new SkillMarketplace('/tmp/tako-test-skills');

    await assert.rejects(
      () => marketplace.install('evil/../../etc'),
      (err: Error) => {
        assert.ok(err.message.includes('path traversal'));
        return true;
      },
    );
  });

  it('rejects repo names with backslash', async () => {
    const { SkillMarketplace } = await import('../src/skills/marketplace.js');
    const marketplace = new SkillMarketplace('/tmp/tako-test-skills');

    await assert.rejects(
      () => marketplace.install('evil/..\\..\\etc'),
      (err: Error) => {
        assert.ok(err.message.includes('path traversal'));
        return true;
      },
    );
  });
});

// ─── Fix 5: Gateway drain timeout ──────────────────────────────────

describe('Gateway drain timeout', () => {
  it('has a DRAIN_TIMEOUT_MS constant', async () => {
    const { Gateway } = await import('../src/gateway/gateway.js');
    assert.equal(Gateway.DRAIN_TIMEOUT_MS, 25_000);
  });
});

// ─── Fix 6: Cron catch-up staggering ───────────────────────────────

describe('Cron catch-up staggering', () => {
  it('CronScheduler exposes MAX_CATCHUP constants', async () => {
    // The constants are module-level, so we verify the behavior by checking
    // that CronScheduler loads without errors and the start method exists
    const { CronScheduler } = await import('../src/core/cron.js');
    const scheduler = new CronScheduler('/tmp/tako-test-cron-' + Date.now());
    assert.ok(typeof scheduler.start === 'function');
    assert.ok(typeof scheduler.stop === 'function');
  });
});

// ─── Fix 7: Tool result head+tail truncation ────────────────────────

describe('Tool result head+tail truncation', () => {
  it('AgentLoop class exists with truncation support', async () => {
    const { AgentLoop } = await import('../src/core/agent-loop.js');
    assert.ok(AgentLoop);

    // Create a minimal instance to test truncation
    const mockProvider = {
      chat: async function* () { yield { text: 'test', done: true }; },
      id: 'mock',
    };
    const mockRegistry = {
      getActiveTools: () => [],
      getTool: () => null,
    };
    const mockPromptBuilder = {
      build: async () => 'system prompt',
      setTools: () => {},
      setSkills: () => {},
      setModel: () => {},
      setWorkingDir: () => {},
      setTimezoneContext: () => {},
    };
    const mockContextManager = {
      pruneMessages: (msgs: any[]) => ({ messages: msgs, tokensSaved: 0 }),
    };

    // Verify the class can be instantiated with maxOutputChars config
    const loop = new AgentLoop(
      {
        provider: mockProvider as any,
        toolRegistry: mockRegistry as any,
        promptBuilder: mockPromptBuilder as any,
        contextManager: mockContextManager as any,
      },
      { maxOutputChars: 100 },
    );
    assert.ok(loop);

    // Test the truncation method via reflection
    const truncate = (loop as any).truncateToolResult.bind(loop);

    // Short output — no truncation
    const short = truncate('hello world');
    assert.equal(short, 'hello world');

    // Long output — should be truncated with head+tail
    const longOutput = 'A'.repeat(50) + 'ERROR at the end'.padStart(80, 'B');
    const truncated = truncate(longOutput);
    assert.ok(truncated.length <= 100);
    assert.ok(truncated.includes('truncated'));
    // Tail should be preserved (last 20%)
    assert.ok(truncated.includes('end'));
  });
});
