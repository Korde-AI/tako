import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { loadOrCreateNodeIdentity } from '../src/core/node-identity.js';
import { setRuntimePaths } from '../src/core/paths.js';
import { createHubState } from '../src/hub/state.js';
import { HubRegistry } from '../src/hub/registry.js';
import { HubRelay } from '../src/hub/relay.js';
import { handleHubRequest } from '../src/hub/routes.js';
import { CapabilityRegistry } from '../src/network/capabilities.js';
import { DelegationExecutor } from '../src/network/delegation-executor.js';
import { DelegationStore } from '../src/network/delegation.js';
import { evaluateDelegationRequest } from '../src/network/delegation-policy.js';
import { EdgeHubClient } from '../src/network/edge-client.js';
import { registerNetworkSession, pollNetworkSessionEvents, sendNetworkSessionEvent } from '../src/network/session-sync.js';
import { NetworkSharedSessionStore, type NetworkSessionEvent } from '../src/network/shared-sessions.js';
import { TrustStore } from '../src/network/trust.js';

describe('network delegation', () => {
  let hubHome: string;
  let edgeAHome: string;
  let edgeBHome: string;

  beforeEach(async () => {
    hubHome = join(tmpdir(), `tako-delegation-hub-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    edgeAHome = join(tmpdir(), `tako-delegation-edge-a-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    edgeBHome = join(tmpdir(), `tako-delegation-edge-b-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await mkdir(hubHome, { recursive: true });
    await mkdir(edgeAHome, { recursive: true });
    await mkdir(edgeBHome, { recursive: true });
  });

  afterEach(async () => {
    await rm(hubHome, { recursive: true, force: true });
    await rm(edgeAHome, { recursive: true, force: true });
    await rm(edgeBHome, { recursive: true, force: true });
  });

  it('sends a delegation request and receives a structured result', async () => {
    setRuntimePaths({ home: hubHome, mode: 'hub' });
    const hubIdentity = await loadOrCreateNodeIdentity({ mode: 'hub', home: hubHome, bind: '127.0.0.1', port: 18790 });
    const state = await createHubState(hubIdentity, '127.0.0.1', 18790, join(hubHome, 'registry'));
    const registry = new HubRegistry(state.store);
    const relay = new HubRelay(join(hubHome, 'relay', 'sessions.json'), join(hubHome, 'relay', 'pending-events.json'));
    await relay.load();

    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url);
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
      let statusCode = 0;
      let responseBody = '';
      const req = {
        method: init?.method ?? 'GET',
        url: `${url.pathname}${url.search}`,
        headers: { host: url.host },
        async *[Symbol.asyncIterator]() {
          if (body !== undefined) yield Buffer.from(JSON.stringify(body));
        },
      } as any;
      const res = {
        writeHead(code: number) { statusCode = code; return this; },
        end(chunk?: string) { responseBody = chunk ?? ''; return this; },
      } as any;
      await handleHubRequest(state, registry, relay, req, res);
      return new Response(responseBody || 'null', { status: statusCode });
    }) as typeof fetch;

    try {
      const client = new EdgeHubClient('http://127.0.0.1:18790');
      const storeA = new NetworkSharedSessionStore(join(edgeAHome, 'sessions.json'), join(edgeAHome, 'events.json'));
      const storeB = new NetworkSharedSessionStore(join(edgeBHome, 'sessions.json'), join(edgeBHome, 'events.json'));
      const trustA = new TrustStore(join(edgeAHome, 'trust.json'));
      const trustB = new TrustStore(join(edgeBHome, 'trust.json'));
      const capabilitiesB = new CapabilityRegistry(join(edgeBHome, 'capabilities.json'));
      const delegationsA = new DelegationStore(join(edgeAHome, 'requests.json'), join(edgeAHome, 'results.json'));
      const delegationsB = new DelegationStore(join(edgeBHome, 'requests.json'), join(edgeBHome, 'results.json'));
      await Promise.all([
        storeA.load(), storeB.load(), trustA.load(), trustB.load(), capabilitiesB.load(), delegationsA.load(), delegationsB.load(),
      ]);
      await trustA.createPending({ remoteNodeId: 'edge-b', authorityCeiling: 'admin' });
      await trustA.markTrusted('edge-b', 'admin');
      await trustB.createPending({ remoteNodeId: 'edge-a', authorityCeiling: 'admin' });
      await trustB.markTrusted('edge-a', 'admin');

      const session = await registerNetworkSession(client, storeA, {
        projectId: 'project-1',
        projectSlug: 'alpha',
        hostNodeId: 'edge-a',
        participantNodeIds: ['edge-a', 'edge-b'],
      });
      await storeB.upsertSession(session);

      const request = await delegationsA.createRequest({
        networkSessionId: session.networkSessionId,
        projectId: 'project-1',
        fromNodeId: 'edge-a',
        fromPrincipalId: 'principal-a',
        toNodeId: 'edge-b',
        capabilityId: 'summarize_workspace',
        input: { prompt: 'Summarize your workspace' },
      });
      const event: NetworkSessionEvent = {
        eventId: 'event-request',
        networkSessionId: session.networkSessionId,
        projectId: 'project-1',
        fromNodeId: 'edge-a',
        fromPrincipalId: 'principal-a',
        type: 'delegation_request',
        audience: 'specific-nodes',
        targetNodeIds: ['edge-b'],
        payload: { delegationRequest: request },
        createdAt: new Date().toISOString(),
      };
      await sendNetworkSessionEvent(client, storeA, trustA, event);

      const executor = new DelegationExecutor();
      await pollNetworkSessionEvents(client, storeB, 'edge-b', {
        onEvent: async (incoming) => {
          const delegationRequest = incoming.payload.delegationRequest;
          if (!delegationRequest) return;
          await delegationsB.saveIncomingRequest(delegationRequest);
          const verdict = evaluateDelegationRequest({
            trust: trustB.getByNodeId(delegationRequest.fromNodeId),
            capability: capabilitiesB.get(delegationRequest.capabilityId),
            projectId: delegationRequest.projectId,
            remoteProjectRole: null,
          });
          assert.equal(verdict.allowed, true);
          const result = await executor.execute(delegationRequest, {
            mode: 'edge',
            home: edgeBHome,
            nodeId: 'edge-b',
            nodeName: 'edge-b',
            agentId: 'main',
            projectId: delegationRequest.projectId,
            projectRoot: edgeBHome,
            allowedToolRoot: edgeBHome,
          });
          await delegationsB.saveResult(result);
          await sendNetworkSessionEvent(client, storeB, trustB, {
            eventId: 'event-result',
            networkSessionId: session.networkSessionId,
            projectId: delegationRequest.projectId,
            fromNodeId: 'edge-b',
            fromPrincipalId: 'system',
            type: 'delegation_result',
            audience: 'specific-nodes',
            targetNodeIds: ['edge-a'],
            payload: { delegationResult: result, summary: result.summary },
            createdAt: new Date().toISOString(),
          });
        },
      });

      await pollNetworkSessionEvents(client, storeA, 'edge-a', {
        onEvent: async (incoming) => {
          if (incoming.payload.delegationResult) {
            await delegationsA.saveResult(incoming.payload.delegationResult);
          }
        },
      });

      const result = delegationsA.getResult(request.requestId);
      assert.ok(result);
      assert.equal(result?.status, 'ok');
      assert.match(result?.summary ?? '', /Workspace|No project root/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
