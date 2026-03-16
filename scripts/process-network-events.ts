#!/usr/bin/env bun

import { resolveConfig } from '../src/config/resolve.js';
import { setRuntimePaths, getRuntimePaths } from '../src/core/paths.js';
import { readNodeIdentity } from '../src/core/node-identity.js';
import { EdgeHubClient } from '../src/network/edge-client.js';
import { NetworkSharedSessionStore, type NetworkSessionEvent } from '../src/network/shared-sessions.js';
import { TrustStore } from '../src/network/trust.js';
import { CapabilityRegistry } from '../src/network/capabilities.js';
import { DelegationStore } from '../src/network/delegation.js';
import { ProjectRegistry } from '../src/projects/registry.js';
import { evaluateDelegationRequest } from '../src/network/delegation-policy.js';
import { DelegationExecutor } from '../src/network/delegation-executor.js';
import { buildExecutionContext } from '../src/core/execution-context.js';
import { resolveProjectRoot } from '../src/projects/root.js';
import { sendNetworkSessionEvent } from '../src/network/session-sync.js';

function readFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

const args = process.argv.slice(2);
const home = readFlag(args, '--home');
if (!home) {
  console.error('Usage: bun run scripts/process-network-events.ts --home <path>');
  process.exit(1);
}

setRuntimePaths({ home, mode: 'edge' });
const runtimePaths = getRuntimePaths();
const config = await resolveConfig(undefined, { home });
if (!config.network?.hub) {
  console.error(`No network.hub configured for ${home}`);
  process.exit(1);
}

const identity = await readNodeIdentity();
if (!identity) {
  console.error(`No node identity found for ${home}`);
  process.exit(1);
}

const client = new EdgeHubClient(config.network.hub);
const networkSessions = new NetworkSharedSessionStore(runtimePaths.networkSessionsFile, runtimePaths.networkEventsFile);
const trustStore = new TrustStore(runtimePaths.trustFile);
const capabilityRegistry = new CapabilityRegistry(runtimePaths.capabilitiesFile);
const delegationStore = new DelegationStore(runtimePaths.delegationRequestsFile, runtimePaths.delegationResultsFile);
const projectRegistry = new ProjectRegistry(runtimePaths.projectsDir);
const delegationExecutor = new DelegationExecutor();

await Promise.all([
  networkSessions.load(),
  trustStore.load(),
  capabilityRegistry.load(),
  delegationStore.load(),
  projectRegistry.load(),
]);

const events = await client.fetchPendingSessionEvents(identity.nodeId);
let handled = 0;

for (const event of events) {
  if (!networkSessions.get(event.networkSessionId)) {
    const now = new Date().toISOString();
    await networkSessions.upsertSession({
      networkSessionId: event.networkSessionId,
      projectId: event.projectId,
      projectSlug: typeof event.payload.metadata?.projectSlug === 'string' ? event.payload.metadata.projectSlug : undefined,
      hostNodeId: event.fromNodeId,
      participantNodeIds: Array.from(new Set([identity.nodeId, event.fromNodeId])),
      participantPrincipalIds: typeof event.payload.metadata?.participantPrincipalId === 'string'
        ? [event.payload.metadata.participantPrincipalId]
        : [],
      localSessionBindings: [],
      createdAt: now,
      updatedAt: now,
      lastEventAt: event.createdAt,
      status: 'active',
    });
  }
  await networkSessions.appendEvent(event, 'received');
  if (event.type === 'delegation_request' && event.payload.delegationRequest) {
    handled++;
    const request = event.payload.delegationRequest;
    await delegationStore.saveIncomingRequest(request);
    const trust = trustStore.getByNodeId(request.fromNodeId);
    const capability = capabilityRegistry.get(request.capabilityId);
    const project = projectRegistry.get(request.projectId);
    const verdict = evaluateDelegationRequest({
      trust,
      capability,
      projectId: request.projectId,
      remoteProjectRole: null,
    });
    const ctx = buildExecutionContext({
      nodeIdentity: identity,
      home: runtimePaths.home,
      agentId: 'main',
      workspaceRoot: config.memory.workspace,
      projectRoot: project ? resolveProjectRoot(runtimePaths, project) : undefined,
      allowedToolRoot: project ? resolveProjectRoot(runtimePaths, project) : config.memory.workspace,
      project,
      metadata: { delegationRequestId: request.requestId, source: 'process-network-events.ts' },
    });
    const result = verdict.allowed
      ? await delegationExecutor.execute(request, ctx)
      : {
          requestId: request.requestId,
          projectId: request.projectId,
          fromNodeId: request.fromNodeId,
          toNodeId: request.toNodeId,
          status: 'denied' as const,
          summary: `Delegation denied: ${verdict.reason}`,
          error: verdict.reason,
          createdAt: new Date().toISOString(),
        };
    await delegationStore.saveResult(result);
    const responseEvent: NetworkSessionEvent = {
      eventId: crypto.randomUUID(),
      networkSessionId: event.networkSessionId,
      projectId: request.projectId,
      fromNodeId: identity.nodeId,
      fromPrincipalId: 'system',
      type: 'delegation_result',
      audience: 'specific-nodes',
      targetNodeIds: [request.fromNodeId],
      payload: {
        delegationResult: result,
        summary: result.summary,
        metadata: {
          requestId: request.requestId,
          capabilityId: request.capabilityId,
        },
      },
      createdAt: new Date().toISOString(),
    };
    await sendNetworkSessionEvent(client, networkSessions, trustStore, responseEvent);
  } else if (event.type === 'delegation_result' && event.payload.delegationResult) {
    handled++;
    await delegationStore.saveResult(event.payload.delegationResult);
  }
  await client.ackSessionEvent(identity.nodeId, event.eventId);
}

console.log(JSON.stringify({ fetched: events.length, handled }, null, 2));
