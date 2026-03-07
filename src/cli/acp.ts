/**
 * CLI subcommands for ACP session management.
 *
 * Usage:
 *   tako acp list              List ACP sessions (active + persisted)
 *   tako acp kill <id>         Terminate a session
 *   tako acp logs <id>         Show session message log
 */

import { AcpSessionManager, type AcpSession } from '../tools/acp-sessions.js';

export async function runAcp(args: string[]): Promise<void> {
  const sub = args[0] ?? 'list';

  switch (sub) {
    case 'list':
    case 'ls': {
      const sessions = await AcpSessionManager.loadPersistedSessions();
      if (sessions.length === 0) {
        console.log('No ACP sessions found.');
        return;
      }
      console.log('ID        Status     Backend  Label');
      console.log('─'.repeat(60));
      for (const s of sessions) {
        const elapsed = Math.round((Date.now() - s.startedAt) / 1000);
        console.log(
          `${s.id.padEnd(10)} ${s.status.padEnd(10)} ${s.backend.padEnd(8)} ${s.label ?? '(none)'} (${elapsed}s ago)`,
        );
      }
      break;
    }

    case 'kill': {
      const sessionId = args[1];
      if (!sessionId) {
        console.error('Usage: tako acp kill <session-id>');
        process.exit(1);
      }
      // Can only kill live sessions — need a running manager
      console.log(`To kill a live session, use the acp_session_kill tool from within Tako.`);
      console.log(`For stale entries, they will be cleaned up on next Tako restart.`);
      break;
    }

    case 'logs': {
      const sessionId = args[1];
      if (!sessionId) {
        console.error('Usage: tako acp logs <session-id>');
        process.exit(1);
      }
      const sessions = await AcpSessionManager.loadPersistedSessions();
      const session = sessions.find((s) => s.id === sessionId);
      if (!session) {
        console.error(`Session ${sessionId} not found.`);
        process.exit(1);
      }
      console.log(`Session: ${session.id} [${session.status}]`);
      console.log(`Backend: ${session.backend}`);
      console.log(`Started: ${new Date(session.startedAt).toISOString()}`);
      console.log(`Label: ${session.label ?? '(none)'}`);
      console.log('');
      for (const msg of session.messages) {
        const ts = new Date(msg.timestamp).toISOString();
        const prefix = msg.role === 'user' ? '>>> ' : '<<< ';
        console.log(`[${ts}] ${prefix}${msg.content.slice(0, 500)}`);
      }
      break;
    }

    default:
      console.error(`Unknown acp subcommand: ${sub}`);
      console.error('Usage: tako acp [list|kill|logs]');
      process.exit(1);
  }
}
