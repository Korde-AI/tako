import type { SessionManager } from '../gateway/session.js';
import type { EdgeHubClient } from './edge-client.js';
import { NetworkSharedSessionStore, type NetworkSessionEvent, type NetworkSharedSession } from './shared-sessions.js';
import { TrustStore } from './trust.js';

export async function registerNetworkSession(
  client: EdgeHubClient,
  store: NetworkSharedSessionStore,
  input: {
    networkSessionId?: string;
    projectId: string;
    projectSlug?: string;
    hostNodeId: string;
    collaboration?: NetworkSharedSession['collaboration'];
    participantNodeIds: string[];
  },
): Promise<NetworkSharedSession> {
  const session = await client.registerNetworkSession(input);
  await store.upsertSession(session);
  return session;
}

export async function sendNetworkSessionEvent(
  client: EdgeHubClient,
  store: NetworkSharedSessionStore,
  trustStore: TrustStore,
  event: NetworkSessionEvent,
): Promise<void> {
  const session = store.get(event.networkSessionId);
  if (!session) throw new Error(`Network session not found: ${event.networkSessionId}`);
  const targets = (event.targetNodeIds ?? session.participantNodeIds).filter((nodeId) => nodeId !== event.fromNodeId);
  for (const nodeId of targets) {
    const trust = trustStore.getByNodeId(nodeId);
    if (!trust || trust.status !== 'trusted') {
      throw new Error(`Untrusted network target: ${nodeId}`);
    }
  }
  await client.sendSessionEvent(event);
  await store.appendEvent(event, 'sent');
}

export async function pollNetworkSessionEvents(
  client: EdgeHubClient,
  store: NetworkSharedSessionStore,
  nodeId: string,
  opts?: {
    sessions?: SessionManager;
    onEvent?: (event: NetworkSessionEvent) => Promise<void>;
  },
): Promise<NetworkSessionEvent[]> {
  const events = await client.fetchPendingSessionEvents(nodeId);
  for (const event of events) {
    await store.appendEvent(event, 'received');
    await opts?.onEvent?.(event);
    if (opts?.sessions && event.type === 'message') {
      const session = store.get(event.networkSessionId);
      const localBinding = session?.localSessionBindings.find((binding) => binding.nodeId === nodeId);
      if (localBinding && opts.sessions.get(localBinding.localSessionId)) {
        opts.sessions.addMessage(localBinding.localSessionId, {
          role: 'user',
          name: `remote:${event.fromNodeId}`,
          content: event.payload.text ?? event.payload.summary ?? '',
        });
      }
    }
    await client.ackSessionEvent(nodeId, event.eventId);
  }
  return events;
}
