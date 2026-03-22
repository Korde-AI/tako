#!/usr/bin/env bun
/**
 * Tako 🐙 — Agent-as-CPU OS: minimal core + pluggable skill arms.
 *
 * This file is intentionally thin.
 * - CLI dispatch lives in src/cli/runtime.ts
 * - edge bootstrap lives in src/runtime/edge-runtime.ts
 */

import { runCliRuntime } from './cli/runtime.js';
import { runEdgeRuntime } from './runtime/edge-runtime.js';

const VERSION = '0.0.1';

async function main(): Promise<void> {
  await runCliRuntime({
    argv: process.argv.slice(2),
    version: VERSION,
    handlers: {
      runEdgeRuntime,
    },
  });
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
