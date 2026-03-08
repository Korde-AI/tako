/**
 * System tools — restart, config reload, status.
 *
 * Allows the agent to restart itself and deliver a post-restart note.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { ToolContext, ToolResult } from './tool.js';
import type { ToolRegistry } from './registry.js';

const RESTART_GUARD_PATH = join(homedir(), '.tako', 'restart-guard.json');
const MIN_RESTART_INTERVAL_MS = 90_000;

export function registerSystemTools(registry: ToolRegistry, opts: { gatewayPort: number; gatewayBind: string }): void {
  registry.register({
    name: 'system_restart',
    description: 'Restart Tako. Use after making code changes, config updates, or when asked to restart. Pass a human-readable note that will be delivered to the user after restart. IMPORTANT: The process will exit shortly after this tool is called, so always include a note for post-restart delivery.',
    parameters: {
      type: 'object',
      properties: {
        note: {
          type: 'string',
          description: 'Human-readable message to deliver after restart (e.g. "Restarted after config update.")',
        },
      },
    },
    execute: async (_args: Record<string, unknown>, ctx: ToolContext): Promise<ToolResult> => {
      const note = (_args.note as string) || 'Tako restarted.';
      const sessionKey = ctx.sessionId || null;
      const channelId = (ctx.channelTarget as string) || null;
      const agentId = ctx.agentId || null;

      try {
        // Guard against restart loops caused by repeated tool calls.
        try {
          if (existsSync(RESTART_GUARD_PATH)) {
            const raw = await readFile(RESTART_GUARD_PATH, 'utf-8');
            const parsed = JSON.parse(raw) as { lastRestartAt?: number };
            const last = parsed.lastRestartAt ?? 0;
            const elapsed = Date.now() - last;
            if (elapsed < MIN_RESTART_INTERVAL_MS) {
              const wait = Math.ceil((MIN_RESTART_INTERVAL_MS - elapsed) / 1000);
              return { success: false, output: `Restart blocked by safety guard. Try again in ~${wait}s.` };
            }
          }
        } catch {
          // Ignore malformed guard file.
        }

        await writeFile(RESTART_GUARD_PATH, JSON.stringify({ lastRestartAt: Date.now() }) + '\n', { mode: 0o600 });

        const res = await fetch(`http://${opts.gatewayBind}:${opts.gatewayPort}/restart`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ note, sessionKey, channelId, agentId }),
        });
        if (res.ok) {
          return { success: true, output: `Restart initiated. Note "${note}" will be delivered after restart.` };
        }
        return { output: `Restart request failed: ${res.status}`, success: false };
      } catch (err) {
        return { output: `Failed to reach gateway: ${err instanceof Error ? err.message : err}`, success: false };
      }
    },
  });
}
