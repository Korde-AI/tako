import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { setRuntimePaths } from '../src/core/paths.js';
import { createHubState } from '../src/hub/state.js';
import { loadOrCreateNodeIdentity } from '../src/core/node-identity.js';
import { HubRegistry } from '../src/hub/registry.js';
import { HubRelay } from '../src/hub/relay.js';
import { handleHubRequest } from '../src/hub/routes.js';
import { EdgeHubClient } from '../src/network/edge-client.js';
import { registerNetworkSession, pollNetworkSessionEvents, sendNetworkSessionEvent } from '../src/network/session-sync.js';
import { NetworkSharedSessionStore } from '../src/network/shared-sessions.js';
import { TrustStore } from '../src/network/trust.js';
import { ProjectArtifactRegistry } from '../src/projects/artifacts.js';
import { exportArtifactEnvelope, importArtifactEnvelope } from '../src/projects/distribution.js';

describe('network session routing', () => {
  let hubHome: string;
  let edgeAHome: string;
  let edgeBHome: string;

  beforeEach(async () => {
    hubHome = join(tmpdir(), `tako-hub-route-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    edgeAHome = join(tmpdir(), `tako-edge-a-route-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    edgeBHome = join(tmpdir(), `tako-edge-b-route-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    await mkdir(hubHome, { recursive: true });
    await mkdir(edgeAHome, { recursive: true });
    await mkdir(edgeBHome, { recursive: true });
  });

  afterEach(async () => {
    await rm(hubHome, { recursive: true, force: true });
    await rm(edgeAHome, { recursive: true, force: true });
    await rm(edgeBHome, { recursive: true, force: true });
  });

  it('registers a network session, relays an event, and acks it', async () => {
    setRuntimePaths({ home: hubHome, mode: 'hub' });
    const identity = await loadOrCreateNodeIdentity({ mode: 'hub', home: hubHome, bind: '127.0.0.1', port: 18790 });
    const state = await createHubState(identity, '127.0.0.1', 18790, join(hubHome, 'registry'));
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
          if (body !== undefined) {
            yield Buffer.from(JSON.stringify(body));
          }
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
      const storeA = new NetworkSharedSessionStore(join(edgeAHome, 'network-sessions.json'), join(edgeAHome, 'network-events.json'));
      const storeB = new NetworkSharedSessionStore(join(edgeBHome, 'network-sessions.json'), join(edgeBHome, 'network-events.json'));
      const trustA = new TrustStore(join(edgeAHome, 'trust.json'));
      await Promise.all([storeA.load(), storeB.load(), trustA.load()]);
      await trustA.createPending({ remoteNodeId: 'edge-b', authorityCeiling: 'contribute' });
      await trustA.markTrusted('edge-b', 'contribute');

      const session = await registerNetworkSession(client, storeA, {
        projectId: 'project-1',
        projectSlug: 'alpha',
        hostNodeId: 'edge-a',
        participantNodeIds: ['edge-a', 'edge-b'],
      });
      await storeB.upsertSession(session);

      await sendNetworkSessionEvent(client, storeA, trustA, {
        eventId: 'event-1',
        networkSessionId: session.networkSessionId,
        projectId: 'project-1',
        fromNodeId: 'edge-a',
        fromPrincipalId: 'principal-a',
        type: 'message',
        audience: 'session-participants',
        targetNodeIds: ['edge-b'],
        payload: { text: 'hello from edge a' },
        createdAt: new Date().toISOString(),
      });

      const fetched = await pollNetworkSessionEvents(client, storeB, 'edge-b');
      assert.equal(fetched.length, 1);
      assert.equal(fetched[0]?.payload.text, 'hello from edge a');
      assert.equal(storeB.listEvents(session.networkSessionId).length, 1);
      assert.equal(await client.fetchPendingSessionEvents('edge-b').then((rows) => rows.length), 0);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('relays a shared artifact envelope across trusted edges', async () => {
    setRuntimePaths({ home: hubHome, mode: 'hub' });
    const identity = await loadOrCreateNodeIdentity({ mode: 'hub', home: hubHome, bind: '127.0.0.1', port: 18790 });
    const state = await createHubState(identity, '127.0.0.1', 18790, join(hubHome, 'registry'));
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
          if (body !== undefined) {
            yield Buffer.from(JSON.stringify(body));
          }
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
      const storeA = new NetworkSharedSessionStore(join(edgeAHome, 'network-sessions.json'), join(edgeAHome, 'network-events.json'));
      const storeB = new NetworkSharedSessionStore(join(edgeBHome, 'network-sessions.json'), join(edgeBHome, 'network-events.json'));
      const trustA = new TrustStore(join(edgeAHome, 'trust.json'));
      await Promise.all([storeA.load(), storeB.load(), trustA.load()]);
      await trustA.createPending({ remoteNodeId: 'edge-b', authorityCeiling: 'contribute' });
      await trustA.markTrusted('edge-b', 'contribute');

      const sourceArtifacts = new ProjectArtifactRegistry(join(edgeAHome, 'artifacts'), 'project-1');
      await sourceArtifacts.load();
      await mkdir(join(edgeAHome, 'src'), { recursive: true });
      const sourcePath = join(edgeAHome, 'src', 'note.txt');
      await Bun.write(sourcePath, 'artifact from edge a\n');
      const artifact = await sourceArtifacts.publish({
        sourcePath,
        publishedByPrincipalId: 'principal-a',
        sourceNodeId: 'edge-a',
      });
      const envelope = await exportArtifactEnvelope(sourceArtifacts, artifact.artifactId);

      const session = await registerNetworkSession(client, storeA, {
        projectId: 'project-1',
        projectSlug: 'alpha',
        hostNodeId: 'edge-a',
        participantNodeIds: ['edge-a', 'edge-b'],
      });
      await storeB.upsertSession(session);

      await sendNetworkSessionEvent(client, storeA, trustA, {
        eventId: 'artifact-event-1',
        networkSessionId: session.networkSessionId,
        projectId: 'project-1',
        fromNodeId: 'edge-a',
        fromPrincipalId: 'principal-a',
        type: 'artifact_publish',
        audience: 'specific-nodes',
        targetNodeIds: ['edge-b'],
        payload: {
          artifactEnvelope: envelope,
          summary: 'artifact publish',
        },
        createdAt: new Date().toISOString(),
      });

      const targetArtifacts = new ProjectArtifactRegistry(join(edgeBHome, 'artifacts'), 'project-1');
      await targetArtifacts.load();
      const fetched = await pollNetworkSessionEvents(client, storeB, 'edge-b', {
        onEvent: async (event) => {
          if (event.payload.artifactEnvelope) {
            await importArtifactEnvelope(targetArtifacts, event.payload.artifactEnvelope);
          }
        },
      });
      assert.equal(fetched.length, 1);
      const imported = targetArtifacts.list()[0];
      assert.ok(imported);
      assert.equal(await Bun.file(targetArtifacts.resolvePath(imported!)).text(), 'artifact from edge a\n');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('relays explicit join events so remote edges can refresh project state', async () => {
    setRuntimePaths({ home: hubHome, mode: 'hub' });
    const identity = await loadOrCreateNodeIdentity({ mode: 'hub', home: hubHome, bind: '127.0.0.1', port: 18790 });
    const state = await createHubState(identity, '127.0.0.1', 18790, join(hubHome, 'registry'));
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
          if (body !== undefined) {
            yield Buffer.from(JSON.stringify(body));
          }
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
      const storeA = new NetworkSharedSessionStore(join(edgeAHome, 'network-sessions.json'), join(edgeAHome, 'network-events.json'));
      const storeB = new NetworkSharedSessionStore(join(edgeBHome, 'network-sessions.json'), join(edgeBHome, 'network-events.json'));
      const trustA = new TrustStore(join(edgeAHome, 'trust.json'));
      await Promise.all([storeA.load(), storeB.load(), trustA.load()]);
      await trustA.createPending({ remoteNodeId: 'edge-b', authorityCeiling: 'contribute' });
      await trustA.markTrusted('edge-b', 'contribute');

      const session = await registerNetworkSession(client, storeA, {
        projectId: 'project-1',
        projectSlug: 'alpha',
        hostNodeId: 'edge-a',
        participantNodeIds: ['edge-a', 'edge-b'],
      });
      await storeB.upsertSession(session);

      await sendNetworkSessionEvent(client, storeA, trustA, {
        eventId: 'join-event-1',
        networkSessionId: session.networkSessionId,
        projectId: 'project-1',
        fromNodeId: 'edge-a',
        fromPrincipalId: 'principal-a',
        type: 'join',
        audience: 'specific-nodes',
        targetNodeIds: ['edge-b'],
        payload: {
          summary: 'principal joined alpha',
          metadata: {
            joinKind: 'principal_join',
            participantPrincipalId: 'principal-a',
            participantPrincipalName: 'Alice',
          },
        },
        createdAt: new Date().toISOString(),
      });

      const fetched = await pollNetworkSessionEvents(client, storeB, 'edge-b');
      assert.equal(fetched.length, 1);
      assert.equal(fetched[0]?.type, 'join');
      assert.equal(storeB.listEvents(session.networkSessionId)[0]?.event.type, 'join');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
