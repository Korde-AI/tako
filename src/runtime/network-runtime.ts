import type { SessionManager } from '../gateway/session.js';
import type { EdgeHubClient } from '../network/edge-client.js';
import { registerNodeWithHub, syncAllProjectsToHub } from '../network/sync.js';
import { pollNetworkSessionEvents } from '../network/session-sync.js';
import type { CapabilityRegistry } from '../network/capabilities.js';
import type { ProjectRegistry } from '../projects/registry.js';
import type { ProjectMembershipRegistry } from '../projects/memberships.js';
import type { NetworkSharedSessionStore, NetworkSessionEvent } from '../network/shared-sessions.js';
import type { TakoConfig } from '../config/schema.js';

interface NodeIdentityLike {
  nodeId: string;
}

interface NetworkRuntimeInput {
  hubClient: EdgeHubClient | null;
  config: TakoConfig;
  identity: NodeIdentityLike;
  capabilityRegistry: CapabilityRegistry;
  projectRegistry: ProjectRegistry;
  projectMemberships: ProjectMembershipRegistry;
  networkSharedSessions: NetworkSharedSessionStore;
  sessions: SessionManager;
  onEvent(event: NetworkSessionEvent): Promise<void>;
}

export async function startNetworkRuntime(input: NetworkRuntimeInput): Promise<{
  stopHubHeartbeat: (() => void) | null;
  stopNetworkPolling: (() => void) | null;
}> {
  const hubClient = input.hubClient;
  if (!hubClient) {
    return {
      stopHubHeartbeat: null,
      stopNetworkPolling: null,
    };
  }

  try {
    await registerNodeWithHub(hubClient, input.identity as never, input.capabilityRegistry);
    await syncAllProjectsToHub(
      hubClient,
      input.identity as never,
      input.projectRegistry,
      input.projectMemberships,
    );
  } catch (err) {
    console.warn(`[network] Failed to sync edge to hub ${input.config.network?.hub}: ${err instanceof Error ? err.message : String(err)}`);
  }

  const heartbeatSeconds = Math.max(5, input.config.network?.heartbeatSeconds ?? 30);
  const heartbeatTimer = setInterval(() => {
    void hubClient.heartbeat(input.identity.nodeId).catch((err) => {
      console.warn(`[network] Hub heartbeat failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, heartbeatSeconds * 1000);

  const pollTimer = setInterval(() => {
    void pollNetworkSessionEvents(hubClient, input.networkSharedSessions, input.identity.nodeId, {
      sessions: input.sessions,
      onEvent: input.onEvent,
    }).catch((err) => {
      console.warn(`[network] Session poll failed: ${err instanceof Error ? err.message : String(err)}`);
    });
  }, heartbeatSeconds * 1000);

  return {
    stopHubHeartbeat: () => clearInterval(heartbeatTimer),
    stopNetworkPolling: () => clearInterval(pollTimer),
  };
}
