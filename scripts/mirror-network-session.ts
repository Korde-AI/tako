#!/usr/bin/env bun

import { readFile } from 'node:fs/promises';
import { getRuntimePaths, setRuntimePaths } from '../src/core/paths.js';
import { NetworkSharedSessionStore, type NetworkSharedSession } from '../src/network/shared-sessions.js';

function readFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

const args = process.argv.slice(2);
const home = readFlag(args, '--home');
const sessionFile = readFlag(args, '--session-file');

if (!home || !sessionFile) {
  console.error('Usage: bun run scripts/mirror-network-session.ts --home <path> --session-file <json>');
  process.exit(1);
}

setRuntimePaths({ home, mode: 'edge' });
const payload = JSON.parse(await readFile(sessionFile, 'utf-8')) as NetworkSharedSession;
const paths = getRuntimePaths();
const store = new NetworkSharedSessionStore(paths.networkSessionsFile, paths.networkEventsFile);
await store.load();
await store.upsertSession(payload);
console.log(payload.networkSessionId);
