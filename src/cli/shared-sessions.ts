import { getRuntimePaths } from '../core/paths.js';
import { SharedSessionRegistry } from '../sessions/shared.js';

export async function runSharedSessions(args: string[]): Promise<void> {
  const registry = new SharedSessionRegistry(getRuntimePaths().sharedSessionsDir);
  await registry.load();

  const subcommand = args[0] ?? 'list';
  switch (subcommand) {
    case 'list':
      await listSharedSessions(registry);
      return;
    case 'show':
      await showSharedSession(registry, args[1]);
      return;
    default:
      console.error(`Unknown shared-sessions subcommand: ${subcommand}`);
      console.error('Available: list, show <sharedSessionId>');
      process.exit(1);
  }
}

async function listSharedSessions(registry: SharedSessionRegistry): Promise<void> {
  const sessions = registry.list();
  if (sessions.length === 0) {
    console.log('No shared sessions found.');
    return;
  }
  for (const session of sessions) {
    console.log(
      `${session.sharedSessionId}  ${session.projectSlug ?? session.projectId}  agent=${session.agentId}  participants=${session.participantIds.length}  lastActive=${session.lastActiveAt}`,
    );
  }
}

async function showSharedSession(registry: SharedSessionRegistry, sharedSessionId?: string): Promise<void> {
  if (!sharedSessionId) {
    console.error('Usage: tako shared-sessions show <sharedSessionId>');
    process.exit(1);
  }
  const session = registry.get(sharedSessionId);
  if (!session) {
    console.error(`Shared session not found: ${sharedSessionId}`);
    process.exit(1);
  }
  console.log(JSON.stringify(session, null, 2));
}

