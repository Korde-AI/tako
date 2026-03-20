/**
 * Tests for core tools and tool registry.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile, readFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { ToolRegistry } from '../src/tools/registry.js';
import { readTool, writeTool, editTool } from '../src/tools/fs.js';
import { execTool } from '../src/tools/exec.js';
import { contentSearchTool } from '../src/tools/search.js';
import type { ToolContext } from '../src/tools/tool.js';
import { createMemoryTools } from '../src/tools/memory.js';
import { createProjectTools } from '../src/tools/projects.js';
import { createMessageTools } from '../src/tools/message.js';
import { extractPptxSlideTextFromXml, officeTools } from '../src/tools/office.js';
import { setRuntimePaths } from '../src/core/paths.js';
import { bootstrapProjectHome } from '../src/projects/bootstrap.js';

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

  it('registers project bootstrap and member management tools', () => {
    const tools = createProjectTools({
      bootstrapFromPrompt: async () => ({ output: 'ok', success: true }),
      manageMember: async () => ({ output: 'ok', success: true }),
      syncProject: async () => ({ output: 'ok', success: true }),
    });
    const names = tools.map((tool) => tool.name).sort();
    assert.deepEqual(names, ['project_bootstrap', 'project_member_manage', 'project_sync']);
  });

  it('registers office extraction tool', () => {
    const names = officeTools.map((tool) => tool.name);
    assert.ok(names.includes('extract_office_text'));
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

  it('blocks reads outside the allowed tool root', async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'tako-fs-'));
    const projectRoot = join(tmpDir, 'project');
    const outsideRoot = join(tmpDir, 'outside');
    await mkdir(projectRoot, { recursive: true });
    await mkdir(outsideRoot, { recursive: true });
    await writeFile(join(outsideRoot, 'secret.txt'), 'classified');

    const result = await readTool.execute(
      { path: '../outside/secret.txt' },
      {
        ...makeCtx(projectRoot),
        allowedToolRoot: projectRoot,
      },
    );
    assert.equal(result.success, false);
    assert.match(result.error ?? '', /outside allowed root/);

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

  it('blocks exec cwd outside the allowed tool root', async () => {
    const base = await mkdtemp(join(tmpdir(), 'tako-exec-'));
    const projectRoot = join(base, 'project');
    const outsideRoot = join(base, 'outside');
    await mkdir(projectRoot, { recursive: true });
    await mkdir(outsideRoot, { recursive: true });

    const result = await execTool.execute(
      { command: 'pwd', cwd: '../outside' },
      {
        ...makeCtx(projectRoot),
        allowedToolRoot: projectRoot,
      },
    );
    assert.equal(result.success, false);
    assert.match(result.error ?? '', /outside allowed root/);

    await rm(base, { recursive: true, force: true });
  });
});

describe('search tools', () => {
  it('blocks content search outside the allowed tool root', async () => {
    const base = await mkdtemp(join(tmpdir(), 'tako-search-'));
    const projectRoot = join(base, 'project');
    const outsideRoot = join(base, 'outside');
    await mkdir(projectRoot, { recursive: true });
    await mkdir(outsideRoot, { recursive: true });
    await writeFile(join(outsideRoot, 'secret.txt'), 'private');

    const result = await contentSearchTool.execute(
      { pattern: 'private', path: '../outside' },
      {
        ...makeCtx(projectRoot),
        allowedToolRoot: projectRoot,
      },
    );
    assert.equal(result.success, false);
    assert.match(result.error ?? '', /outside allowed root/);

    await rm(base, { recursive: true, force: true });
  });
});

describe('memory tools', () => {
  it('scopes project memory visibility to shared plus caller-private', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tako-memory-scope-'));
    const workspace = join(home, 'workspace');
    await mkdir(join(workspace, 'memory'), { recursive: true });
    await writeFile(join(workspace, 'memory', 'MEMORY.md'), 'global note\n');
    setRuntimePaths({ home, mode: 'edge' });

    const projectsDir = join(home, 'projects');
    const project = {
      projectId: 'project-1',
      slug: 'alpha',
      displayName: 'Alpha',
      ownerPrincipalId: 'principal-1',
      status: 'active' as const,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    await bootstrapProjectHome(projectsDir, project);

    const tools = createMemoryTools({ workspaceRoot: workspace });
    const memoryStore = tools.find((tool) => tool.name === 'memory_store');
    const memorySearch = tools.find((tool) => tool.name === 'memory_search');
    assert.ok(memoryStore);
    assert.ok(memorySearch);

    const ctx: ToolContext = {
      sessionId: 'session-1',
      workDir: workspace,
      workspaceRoot: workspace,
      executionContext: {
        mode: 'edge',
        home,
        nodeId: 'node-1',
        nodeName: 'edge-main',
        agentId: 'main',
        sessionId: 'session-1',
        principalId: 'principal-1',
        principalName: 'Shu',
        projectId: 'project-1',
        projectSlug: 'alpha',
      },
    };

    const otherCtx: ToolContext = {
      ...ctx,
      executionContext: {
        ...ctx.executionContext!,
        principalId: 'principal-2',
        principalName: 'Bob',
      },
    };

    await memoryStore!.execute({ path: 'MEMORY.md', content: 'private alpha note', mode: 'append' }, ctx);
    await memoryStore!.execute({ path: 'MEMORY.md', content: 'shared alpha note', mode: 'append', scope: 'project-shared' }, ctx);

    const ownerSearch = await memorySearch!.execute({ query: 'alpha note', limit: 10 }, ctx);
    assert.ok(ownerSearch.output.includes('project-private:MEMORY.md'));
    assert.ok(ownerSearch.output.includes('project-shared:MEMORY.md'));

    const otherSearch = await memorySearch!.execute({ query: 'private alpha note', limit: 10 }, otherCtx);
    assert.ok(!otherSearch.output.includes('project-private:MEMORY.md'));

    await rm(home, { recursive: true, force: true });
  });
});

describe('message tools', () => {
  it('infers Discord guild and parent channel from execution context for channel creation', async () => {
    let seen: { guildId: string; name: string; topic?: string; parentId?: string } | null = null;
    const tools = createMessageTools({
      resolveDiscord: () => ({
        createChannel: async (guildId: string, name: string, opts?: { topic?: string; parentId?: string }) => {
          seen = { guildId, name, topic: opts?.topic, parentId: opts?.parentId };
          return { id: '123', name };
        },
      } as any),
    });
    const messageTool = tools.find((tool) => tool.name === 'message');
    assert.ok(messageTool);

    const result = await messageTool!.execute(
      { action: 'channel-create', platform: 'discord', name: 'callgo', topic: 'project room' },
      {
        sessionId: 'session-1',
        workDir: '/tmp',
        workspaceRoot: '/tmp',
        channelTarget: 'parent-chan-1',
        executionContext: {
          mode: 'edge',
          home: '/tmp',
          nodeId: 'node-1',
          nodeName: 'edge-a',
          agentId: 'main',
          metadata: {
            guildId: 'guild-1',
            parentChannelId: 'parent-chan-1',
          },
        },
      },
    );

    assert.equal(result.success, true);
    assert.deepEqual(seen, {
      guildId: 'guild-1',
      name: 'callgo',
      topic: 'project room',
      parentId: 'parent-chan-1',
    });
  });
});

describe('office tools', () => {
  it('extracts slide text from pptx slide XML', () => {
    const xml = `
      <p:sld xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
        <a:t>Hello</a:t>
        <a:t>World &amp; Beyond</a:t>
      </p:sld>
    `;
    assert.deepEqual(extractPptxSlideTextFromXml(xml), ['Hello', 'World & Beyond']);
  });
});
