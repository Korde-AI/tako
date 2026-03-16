#!/usr/bin/env bun

import { setRuntimePaths } from '../src/core/paths.js';
import { TrustStore } from '../src/network/trust.js';

function readFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

const args = process.argv.slice(2);
const home = readFlag(args, '--home');
const remoteNodeId = readFlag(args, '--remote-node-id');
const remoteNodeName = readFlag(args, '--remote-node-name');
const ceiling = readFlag(args, '--ceiling') ?? 'contribute';

if (!home || !remoteNodeId) {
  console.error('Usage: bun run scripts/set-trust.ts --home <path> --remote-node-id <nodeId> [--remote-node-name <name>] [--ceiling <role>]');
  process.exit(1);
}

setRuntimePaths({ home, mode: 'edge' });
const store = new TrustStore(`${home}/network/trust.json`);
await store.load();
await store.createPending({
  remoteNodeId,
  remoteNodeName,
  authorityCeiling: ceiling as any,
  metadata: { source: 'single-server-test-harness' },
});
const record = await store.markTrusted(remoteNodeId, ceiling as any);
if (!record) {
  console.error(`Could not mark trust for ${remoteNodeId}`);
  process.exit(1);
}
console.log(record.remoteNodeId);
