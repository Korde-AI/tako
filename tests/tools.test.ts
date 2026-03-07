/**
 * Tests for core tools and tool registry.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ToolRegistry } from '../src/tools/registry.js';
import { readTool, writeTool, editTool } from '../src/tools/fs.js';
import { execTool } from '../src/tools/exec.js';
import type { ToolContext } from '../src/tools/tool.js';

function makeCtx(workDir: string): ToolContext {
  return {
    sessionId: 'test-session',
    workDir,
    workspaceRoot: workDir,
  };
}

// ─── ToolRegistry ────────────────────────────────────────────────────

describe('ToolRegistry', () => {
  it('registers and retrieves tools', () => {
    const registry = new ToolRegistry();
    registry.register(readTool);
    assert.equal(registry.getTool('read'), readTool);
  });

  it('returns undefined for unregistered tool', () => {
    const registry = new ToolRegistry();
    assert.equal(registry.getTool('nonexistent'), undefined);
  });

  it('respects deny list', () => {
    const registry = new ToolRegistry();
    registry.register(readTool);
    registry.setDenyList(['read']);
    assert.equal(registry.getTool('read'), undefined);
  });

  it('respects allow list override', () => {
    const registry = new ToolRegistry();
    registry.register(readTool);
    registry.setProfile('minimal');
    // 'fs' is in minimal, so read should be active
    assert.ok(registry.getTool('read'));
  });

  it('filters by profile', () => {
    const registry = new ToolRegistry();
    registry.register(readTool); // group: fs
    registry.register(execTool); // group: runtime

    registry.setProfile('minimal'); // includes fs, runtime
    assert.ok(registry.getTool('read'));
    assert.ok(registry.getTool('exec'));

    // web tools should not be in minimal
    const webTool = { name: 'web_test', description: '', group: 'web' as const, parameters: { type: 'object' }, execute: async () => ({ output: '', success: true }) };
    registry.register(webTool);
    assert.equal(registry.getTool('web_test'), undefined);
  });

  it('getActiveTools returns only active tools', () => {
    const registry = new ToolRegistry();
    registry.register(readTool);
    registry.register(writeTool);
    registry.setDenyList(['write']);
    const active = registry.getActiveTools();
    assert.ok(active.some((t) => t.name === 'read'));
    assert.ok(!active.some((t) => t.name === 'write'));
  });
});

// ─── fs tools ────────────────────────────────────────────────────────

describe('fs tools', () => {
  let tmpDir: string;

  it('read tool reads a file', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'tako-fs-'));
    await writeFile(join(tmpDir, 'test.txt'), 'Hello Tako');

    const result = await readTool.execute({ path: 'test.txt' }, makeCtx(tmpDir));
    assert.ok(result.success);
    assert.ok(result.output.includes('Hello Tako'));

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('read tool reads a line range', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'tako-fs-'));
    await writeFile(join(tmpDir, 'test.txt'), 'line1\nline2\nline3\nline4');

    const result = await readTool.execute({ path: 'test.txt', start: 2, end: 3 }, makeCtx(tmpDir));
    assert.ok(result.success);
    assert.ok(result.output.includes('line2'));
    assert.ok(result.output.includes('line3'));
    assert.ok(!result.output.includes('line4'));

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('write tool creates a file', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'tako-fs-'));

    const result = await writeTool.execute({ path: 'new.txt', content: 'New content' }, makeCtx(tmpDir));
    assert.ok(result.success);

    const content = await readFile(join(tmpDir, 'new.txt'), 'utf-8');
    assert.equal(content, 'New content');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('edit tool replaces text', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'tako-fs-'));
    await writeFile(join(tmpDir, 'edit.txt'), 'Hello world');

    const result = await editTool.execute(
      { path: 'edit.txt', old_string: 'world', new_string: 'Tako' },
      makeCtx(tmpDir),
    );
    assert.ok(result.success);

    const content = await readFile(join(tmpDir, 'edit.txt'), 'utf-8');
    assert.equal(content, 'Hello Tako');

    await rm(tmpDir, { recursive: true, force: true });
  });

  it('edit tool fails on missing old_string', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'tako-fs-'));
    await writeFile(join(tmpDir, 'edit.txt'), 'Hello world');

    const result = await editTool.execute(
      { path: 'edit.txt', old_string: 'nonexistent', new_string: 'replacement' },
      makeCtx(tmpDir),
    );
    assert.equal(result.success, false);

    await rm(tmpDir, { recursive: true, force: true });
  });
});

// ─── exec tool ───────────────────────────────────────────────────────

describe('exec tool', () => {
  it('executes a shell command', async () => {
    const result = await execTool.execute({ command: 'echo "hello"' }, makeCtx('/tmp'));
    assert.ok(result.success);
    assert.ok(result.output.includes('hello'));
  });

  it('handles command failure', async () => {
    const result = await execTool.execute({ command: 'exit 1' }, makeCtx('/tmp'));
    assert.equal(result.success, false);
  });
});
