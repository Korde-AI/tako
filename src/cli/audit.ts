/**
 * CLI: tako audit — query audit logs.
 *
 * Subcommands:
 *   tako audit                     — show last 20 entries
 *   tako audit --tail 50           — show last 50 entries
 *   tako audit --agent research    — filter by agent
 *   tako audit --event tool        — filter by event type
 */

import { AuditLogger, type AuditEvent, type AuditEntry } from '../core/audit.js';

const VALID_EVENTS: AuditEvent[] = [
  'agent_run', 'tool_call', 'file_modify', 'message_sent',
  'api_call', 'browser_action', 'auth_failure', 'permission_denied',
  'cron_run', 'agent_spawn', 'agent_comms',
];

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function formatEntry(entry: AuditEntry): string {
  const time = entry.timestamp.slice(11, 19); // HH:MM:SS
  const date = entry.timestamp.slice(0, 10);
  const status = entry.success ? 'OK' : 'FAIL';
  const details = Object.entries(entry.details)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
    .join(' ');
  return `  ${date} ${time}  [${entry.event}] ${entry.action}  agent=${entry.agentId}  ${status}  ${details}`;
}

export async function runAudit(args: string[]): Promise<void> {
  const tailStr = getArg(args, '--tail');
  const agentId = getArg(args, '--agent');
  const eventStr = getArg(args, '--event');

  const tail = tailStr ? parseInt(tailStr, 10) : 20;

  if (eventStr && !VALID_EVENTS.includes(eventStr as AuditEvent)) {
    console.error(`Unknown event type: ${eventStr}`);
    console.error(`Valid events: ${VALID_EVENTS.join(', ')}`);
    process.exit(1);
  }

  const logger = new AuditLogger({ enabled: true, maxFileSizeMb: 10, retention: '30d' });
  const entries = await logger.query({
    tail,
    agentId,
    event: eventStr as AuditEvent | undefined,
  });

  if (entries.length === 0) {
    console.log('No audit entries found.');
    return;
  }

  console.log(`\nAudit log (${entries.length} entries):\n`);
  for (const entry of entries) {
    console.log(formatEntry(entry));
  }
  console.log('');
}
