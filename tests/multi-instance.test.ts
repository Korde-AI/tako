import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { GatewayLock } from '../src/gateway/lock.js';
import { getPidPath, writePidFile, readPidFile, removePidFile } from '../src/daemon/pid.js';
import { setRuntimePaths } from '../src/core/paths.js';
import { Gateway } from '../src/gateway/gateway.js';

describe('multi-instance isolation', () => {
  let root: string;
  let previousHome: string | undefined;
  let previousMode: string | undefined;

  beforeEach(async () => {
    previousHome = process.env['TAKO_HOME'];
    previousMode = process.env['TAKO_MODE'];
    root = join(tmpdir(), `tako-instance-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await mkdir(root, { recursive: true });
  });

  afterEach(async () => {
    if (previousHome === undefined) delete process.env['TAKO_HOME'];
    else process.env['TAKO_HOME'] = previousHome;
    if (previousMode === undefined) delete process.env['TAKO_MODE'];
    else process.env['TAKO_MODE'] = previousMode;
    await rm(root, { recursive: true, force: true });
  });

  it('allows separate locks for separate homes', async () => {
    const lockA = new GatewayLock(join(root, 'edge-a', 'runtime'));
    const lockB = new GatewayLock(join(root, 'edge-b', 'runtime'));

    assert.equal(await lockA.acquire(), true);
    assert.equal(await lockB.acquire(), true);

    await lockA.release();
    await lockB.release();
  });

  it('prevents two locks in the same home', async () => {
    const stateDir = join(root, 'edge-shared', 'runtime');
    const lockA = new GatewayLock(stateDir);
    const lockB = new GatewayLock(stateDir);

    assert.equal(await lockA.acquire(), true);
    assert.equal(await lockB.acquire(), false);

    await lockA.release();
  });

  it('writes pid files under the selected home runtime directory', async () => {
    const home = join(root, 'edge-pid');
    setRuntimePaths({ home, mode: 'edge' });

    await writePidFile({
      pid: process.pid,
      startedAt: new Date().toISOString(),
      port: 18790,
      bind: '127.0.0.1',
    });

    const info = await readPidFile();
    assert.equal(info?.pid, process.pid);
    const pidPath = getPidPath();
    assert.equal(pidPath, join(home, 'runtime', 'tako.pid'));
    await stat(pidPath);

    await removePidFile();
  });

  it('refuses to start a second gateway in the same home without killing the owner process', async () => {
    const home = join(root, 'edge-locked');
    const paths = setRuntimePaths({ home, mode: 'edge' });
    const lock = new GatewayLock(paths.runtimeDir);
    assert.equal(await lock.acquire(), true);

    const gateway = new Gateway({
      bind: '127.0.0.1',
      port: 0,
      authToken: '',
    }, {
      sessions: {} as any,
    });

    await assert.rejects(
      gateway.start(),
      /Another Tako daemon is already running for home/,
    );

    await lock.release();
  });
});
