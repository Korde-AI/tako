import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../src/config/schema.js';
import { setRuntimePaths } from '../src/core/paths.js';
import { checkConfig } from '../src/doctor/checks/config.js';
import { checkPermissions } from '../src/doctor/checks/permissions.js';
import { ProjectRegistry } from '../src/projects/registry.js';
import { bootstrapProjectHome } from '../src/projects/bootstrap.js';

const homes: string[] = [];

afterEach(() => {
  setRuntimePaths({ home: undefined, mode: 'edge' });
});

describe('doctor checks', () => {
  it('warns on invalid network hub addresses', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tako-doctor-config-'));
    homes.push(home);
    setRuntimePaths({ home, mode: 'edge' });
    await writeFile(join(home, 'tako.json'), JSON.stringify({ providers: { primary: 'anthropic/claude' } }), 'utf-8');

    const result = await checkConfig({
      ...DEFAULT_CONFIG,
      network: {
        ...DEFAULT_CONFIG.network,
        hub: '::bad-hub::',
      },
    });

    expect(result.status).toBe('warn');
    expect(result.message).toContain('network.hub');
  });

  it('warns when a configured project root is not writable', async () => {
    const home = await mkdtemp(join(tmpdir(), 'tako-doctor-perms-'));
    homes.push(home);
    const projectRoot = join(home, 'missing-project-root');
    await mkdir(join(home, 'workspace'), { recursive: true });
    setRuntimePaths({ home, mode: 'edge' });

    const projects = new ProjectRegistry(join(home, 'projects'));
    await projects.load();
    const project = await projects.create({
      slug: 'alpha',
      displayName: 'Alpha',
      ownerPrincipalId: 'prn-owner',
      workspaceRoot: projectRoot,
    });
    await bootstrapProjectHome(join(home, 'projects'), project);

    const result = await checkPermissions({
      ...DEFAULT_CONFIG,
      memory: {
        ...DEFAULT_CONFIG.memory,
        workspace: join(home, 'workspace'),
      },
    });

    expect(result.status).toBe('warn');
    expect(result.message).toContain('Project root not readable/writable');
    expect(result.message).toContain(projectRoot);
  });
});
