#!/usr/bin/env bun

import { PrincipalRegistry } from '../src/principals/registry.js';
import { setRuntimePaths } from '../src/core/paths.js';

function readFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

const args = process.argv.slice(2);
const home = readFlag(args, '--home');
const displayName = readFlag(args, '--display-name');
const platform = readFlag(args, '--platform') ?? 'cli';
const platformUserId = readFlag(args, '--platform-user-id');
const authorityLevel = readFlag(args, '--authority-level');

if (!home || !displayName || !platformUserId) {
  console.error('Usage: bun run scripts/seed-principal.ts --home <path> --display-name <name> --platform-user-id <id> [--platform cli] [--authority-level owner]');
  process.exit(1);
}

setRuntimePaths({ home, mode: 'edge' });
const registry = new PrincipalRegistry(`${home}/principals`);
await registry.load();
const principal = await registry.getOrCreateHuman({
  displayName,
  platform: platform as 'cli' | 'discord' | 'telegram' | 'web' | 'system',
  platformUserId,
  authorityLevel: authorityLevel as any,
});
console.log(principal.principalId);
