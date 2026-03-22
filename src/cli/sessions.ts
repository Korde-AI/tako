import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { resolveConfig } from '../config/resolve.js';
import { SessionManager } from '../gateway/session.js';
import { AgentRegistry } from '../agents/registry.js';

export async function runSessions(args: string[]): Promise<void> {
  const config = await resolveConfig();
  const sessions = new SessionManager();
  const agentRegistry = new AgentRegistry(config.agents, config.providers.primary);
  await agentRegistry.loadDynamic();
  const agentSessionDirs = new Map<string, string>();
  for (const agent of agentRegistry.list()) {
    agentSessionDirs.set(agent.id, agent.sessionDir);
  }
  await sessions.enablePersistence(agentSessionDirs);

  const subcommand = args[0] ?? 'list';

  switch (subcommand) {
    case 'list': {
      const agentFilter = args.includes('--agent') ? args[args.indexOf('--agent') + 1] : undefined;
      let allSessions = sessions.list();

      if (agentFilter) {
        allSessions = allSessions.filter(
          (s) => (s.metadata.agentId ?? 'main') === agentFilter,
        );
      }

      allSessions.sort((a, b) => b.lastActiveAt.getTime() - a.lastActiveAt.getTime());

      if (allSessions.length === 0) {
        console.log('No sessions found.');
        sessions.stopPersistence();
        return;
      }

      console.log(`Sessions (${allSessions.length}):\n`);
      for (const s of allSessions.slice(0, 50)) {
        const agentId = s.metadata.agentId ?? 'main';
        const isSubAgent = s.metadata.isSubAgent ? ' [sub-agent]' : '';
        console.log(`  ${s.id.slice(0, 8)}  ${s.name}  (${agentId}${isSubAgent})`);
        console.log(`    Messages: ${s.messages.length}  Last active: ${s.lastActiveAt.toISOString()}`);
      }
      break;
    }

    case 'history': {
      const sessionId = args[1];
      if (!sessionId) {
        console.error('Usage: tako sessions history <session-id> [--limit <n>]');
        process.exit(1);
      }

      let session = sessions.get(sessionId);
      if (!session) {
        const match = sessions.list().find((s) => s.id.startsWith(sessionId));
        if (match) session = match;
      }

      if (!session) {
        console.error(`Session not found: ${sessionId}`);
        sessions.stopPersistence();
        process.exit(1);
      }

      const limitIdx = args.indexOf('--limit');
      const limit = limitIdx >= 0 ? parseInt(args[limitIdx + 1] ?? '20', 10) : 20;

      const messages = session.messages.slice(-limit);
      console.log(`Session: ${session.name} (${session.id})`);
      console.log(`Total messages: ${session.messages.length}\n`);

      for (const msg of messages) {
        const content = typeof msg.content === 'string'
          ? msg.content.slice(0, 200)
          : '[complex content]';
        console.log(`  [${msg.role}] ${content}`);
      }
      break;
    }

    case 'inspect': {
      const sessionId = args[1];
      if (!sessionId) {
        console.error('Usage: tako sessions inspect <session-id>');
        process.exit(1);
      }

      let session = sessions.get(sessionId);
      if (!session) {
        const match = sessions.list().find((s) => s.id.startsWith(sessionId));
        if (match) session = match;
      }

      if (!session) {
        console.error(`Session not found: ${sessionId}`);
        sessions.stopPersistence();
        process.exit(1);
      }

      console.log(`Session: ${session.name}`);
      console.log(`  ID:          ${session.id}`);
      console.log(`  Created:     ${session.createdAt.toISOString()}`);
      console.log(`  Last active: ${session.lastActiveAt.toISOString()}`);
      console.log(`  Messages:    ${session.messages.length}`);
      console.log(`  Agent:       ${session.metadata.agentId ?? 'main'}`);
      if (session.metadata.isSubAgent) console.log(`  Sub-agent:   yes`);
      if (Object.keys(session.metadata).length > 0) {
        console.log(`  Metadata:    ${JSON.stringify(session.metadata, null, 2)}`);
      }

      const recent = session.messages.slice(-10);
      if (recent.length > 0) {
        console.log(`\nRecent messages (last ${recent.length}):\n`);
        for (const msg of recent) {
          const content = typeof msg.content === 'string'
            ? msg.content.slice(0, 300)
            : '[complex content]';
          console.log(`  [${msg.role}] ${content}`);
        }
      }
      break;
    }

    case 'compact': {
      const sessionId = args[1];
      if (!sessionId) {
        console.error('Usage: tako sessions compact <session-id>');
        process.exit(1);
      }

      console.log('Session compaction requires the daemon to be running.');
      console.log('Use the /compact command inside an active session instead.');
      console.log('Or start Tako and the auto-compaction will handle it based on your config.');
      break;
    }

    case 'clear': {
      const sessionId = args[1];
      if (!sessionId) {
        console.error('Usage: tako sessions clear <session-id>');
        process.exit(1);
      }

      let session = sessions.get(sessionId);
      if (!session) {
        const match = sessions.list().find((s) => s.id.startsWith(sessionId));
        if (match) session = match;
      }

      if (!session) {
        console.error(`Session not found: ${sessionId}`);
        sessions.stopPersistence();
        process.exit(1);
      }

      const agentId = (session.metadata.agentId as string) ?? 'main';
      const agentDir = agentSessionDirs.get(agentId);
      if (agentDir) {
        const sessionFile = join(agentDir, `${session.id}.jsonl`);
        const archiveFile = join(agentDir, `${session.id}.jsonl.archived`);
        if (existsSync(sessionFile)) {
          await rename(sessionFile, archiveFile);
          console.log(`Session ${session.id.slice(0, 8)} archived.`);
          console.log(`  File moved to: ${archiveFile}`);
        } else {
          console.log('Session file not found on disk (may be in-memory only).');
        }
      }
      break;
    }

    default:
      console.error(`Unknown sessions subcommand: ${subcommand}`);
      console.error('Available: list, history, inspect, compact, clear');
      process.exit(1);
  }

  sessions.stopPersistence();
}
