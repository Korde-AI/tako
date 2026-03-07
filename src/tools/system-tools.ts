/**
 * System tools — restart, config reload, status.
 *
 * Allows the agent to restart itself and deliver a post-restart note.
 */

import type { ToolContext, ToolResult } from './tool.js';
import type { ToolRegistry } from './registry.js';

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

      try {
        const res = await fetch(`http://${opts.gatewayBind}:${opts.gatewayPort}/restart`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ note, sessionKey }),
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
