import { hostname } from 'node:os';
import { basename } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { getRuntimePaths } from './paths.js';
import type { NodeMode } from './runtime-mode.js';

export interface NodeIdentity {
  nodeId: string;
  mode: NodeMode;
  name: string;
  createdAt: string;
  lastStartedAt: string;
  home: string;
  bind?: string;
  port?: number;
  hub?: string;
}

export interface NodeIdentityOptions {
  mode: NodeMode;
  home: string;
  bind?: string;
  port?: number;
  hub?: string;
  name?: string;
}

function defaultNodeName(mode: NodeMode, home: string): string {
  if (mode === 'hub') return 'hub';
  const base = basename(home);
  if (base && base !== '/' && base !== '.') return base;
  return `edge-${hostname()}`;
}

export function createNodeIdentity(opts: NodeIdentityOptions): NodeIdentity {
  const now = new Date().toISOString();
  return {
    nodeId: crypto.randomUUID(),
    mode: opts.mode,
    name: opts.name ?? defaultNodeName(opts.mode, opts.home),
    createdAt: now,
    lastStartedAt: now,
    home: opts.home,
    bind: opts.bind,
    port: opts.port,
    hub: opts.hub,
  };
}

export async function readNodeIdentity(): Promise<NodeIdentity | null> {
  try {
    const raw = await readFile(getRuntimePaths().nodeIdentityFile, 'utf-8');
    return JSON.parse(raw) as NodeIdentity;
  } catch {
    return null;
  }
}

export async function saveNodeIdentity(identity: NodeIdentity): Promise<void> {
  const file = getRuntimePaths().nodeIdentityFile;
  await mkdir(getRuntimePaths().home, { recursive: true });
  await writeFile(file, JSON.stringify(identity, null, 2) + '\n', 'utf-8');
}

export async function loadOrCreateNodeIdentity(opts: NodeIdentityOptions): Promise<NodeIdentity> {
  const existing = await readNodeIdentity();
  if (!existing) {
    const created = createNodeIdentity(opts);
    await saveNodeIdentity(created);
    return created;
  }

  const updated: NodeIdentity = {
    ...existing,
    mode: opts.mode,
    home: opts.home,
    bind: opts.bind,
    port: opts.port,
    hub: opts.hub,
    lastStartedAt: new Date().toISOString(),
  };
  if (!updated.name) {
    updated.name = defaultNodeName(opts.mode, opts.home);
  }
  await saveNodeIdentity(updated);
  return updated;
}
