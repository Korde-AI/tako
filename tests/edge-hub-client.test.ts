import { afterEach, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { EdgeHubClient } from '../src/network/edge-client.js';

describe('edge hub client', () => {
  const originalFetch = globalThis.fetch;
  let requests: Array<{ url: string; method?: string; body?: unknown }> = [];

  beforeEach(() => {
    requests = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === 'string'
        ? input
        : input instanceof URL
          ? input.toString()
          : input.url;
      const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
      requests.push({
        url,
        method: init?.method,
        body,
      });

      if (url.endsWith('/routes/alpha')) {
        return new Response(JSON.stringify({ projectId: 'project-1', hostNodeId: 'edge-1' }), { status: 200 });
      }
      if (url.endsWith('/routes/missing')) {
        return new Response(JSON.stringify({ error: 'not_found' }), { status: 404 });
      }
      if (url.endsWith('/sessions/register')) {
        return new Response(JSON.stringify({
          networkSessionId: 'network-1',
          projectId: 'project-1',
          hostNodeId: 'edge-1',
          participantNodeIds: ['edge-1', 'edge-2'],
          participantPrincipalIds: [],
          localSessionBindings: [],
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lastEventAt: new Date().toISOString(),
          status: 'active',
        }), { status: 200 });
      }
      if (url.endsWith('/sessions/pending/edge-1')) {
        return new Response(JSON.stringify([{
          eventId: 'event-1',
          networkSessionId: 'network-1',
          projectId: 'project-1',
          fromNodeId: 'edge-2',
          fromPrincipalId: 'principal-2',
          type: 'message',
          audience: 'session-participants',
          payload: { text: 'hello' },
          createdAt: new Date().toISOString(),
        }]), { status: 200 });
      }
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('posts registration and heartbeat payloads and resolves routes', async () => {
    const client = new EdgeHubClient('hub.example.com:18790');
    await client.registerNode({
      identity: {
        nodeId: 'edge-1',
        mode: 'edge',
        name: 'edge-1',
        home: '/tmp/edge-1',
        createdAt: new Date().toISOString(),
        lastStartedAt: new Date().toISOString(),
        bind: '127.0.0.1',
        port: 21893,
      },
    });
    await client.heartbeat('edge-1');
    const route = await client.lookupRoute('alpha');
    const missing = await client.lookupRoute('missing');
    const session = await client.registerNetworkSession({
      projectId: 'project-1',
      hostNodeId: 'edge-1',
      participantNodeIds: ['edge-1', 'edge-2'],
    });
    await client.sendSessionEvent({
      eventId: 'event-1',
      networkSessionId: 'network-1',
      projectId: 'project-1',
      fromNodeId: 'edge-1',
      fromPrincipalId: 'principal-1',
      type: 'message',
      audience: 'session-participants',
      payload: { text: 'hi' },
      createdAt: new Date().toISOString(),
    });
    const pending = await client.fetchPendingSessionEvents('edge-1');
    await client.ackSessionEvent('edge-1', 'event-1');

    assert.ok(requests[0]?.url.endsWith('/register/node'));
    assert.ok(requests[1]?.url.endsWith('/heartbeat'));
    assert.equal(route?.hostNodeId, 'edge-1');
    assert.equal(missing, null);
    assert.equal(session.networkSessionId, 'network-1');
    assert.equal(pending.length, 1);
  });
});
