import type { IncomingMessage, ServerResponse } from 'node:http';
import { URL } from 'node:url';
import type { HubRuntimeState } from './state.js';
import type { HubRegistry } from './registry.js';
import type { HubMembershipSummary, HubNodeRecord, HubProjectRecord } from './types.js';
import type { HubRelay } from './relay.js';
import type { NetworkSessionEvent } from '../network/shared-sessions.js';

function json(res: ServerResponse, code: number, body: unknown): void {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString('utf-8').trim();
  if (!raw) return {} as T;
  return JSON.parse(raw) as T;
}

export async function handleHubRequest(
  state: HubRuntimeState,
  registry: HubRegistry,
  relayOrReq: HubRelay | IncomingMessage,
  reqOrRes: IncomingMessage | ServerResponse,
  maybeRes?: ServerResponse,
): Promise<void> {
  const relay = maybeRes ? relayOrReq as HubRelay : null;
  const req = maybeRes ? reqOrRes as IncomingMessage : relayOrReq as IncomingMessage;
  const res = maybeRes ?? reqOrRes as ServerResponse;
  const hostHeader = typeof req.headers?.host === 'string' ? req.headers.host : `${state.bind}:${state.port}`;
  const url = new URL(req.url ?? '/', `http://${hostHeader}`);
  const method = req.method ?? 'GET';
  const pathname = url.pathname;

  if (method === 'GET' && (pathname === '/health' || pathname === '/healthz')) {
    json(res, 200, {
      status: 'ok',
      mode: 'hub',
      nodeId: state.identity.nodeId,
      home: state.identity.home,
      bind: state.bind,
      port: state.port,
      uptime: Math.floor((Date.now() - state.startedAt) / 1000),
    });
    return;
  }

  if (method === 'GET' && pathname === '/status') {
    json(res, 200, {
      status: 'ok',
      mode: 'hub',
      identity: state.identity,
      bind: state.bind,
      port: state.port,
      uptime: Math.floor((Date.now() - state.startedAt) / 1000),
      registry: registry.getStatusSummary(),
    });
    return;
  }

  if (method === 'GET' && pathname === '/identity') {
    json(res, 200, state.identity);
    return;
  }

  if (method === 'GET' && pathname === '/nodes') {
    json(res, 200, registry.listNodes());
    return;
  }

  if (method === 'GET' && pathname.startsWith('/nodes/')) {
    const nodeId = decodeURIComponent(pathname.slice('/nodes/'.length));
    const node = registry.getNode(nodeId);
    if (!node) {
      json(res, 404, { error: 'not_found' });
      return;
    }
    json(res, 200, node);
    return;
  }

  if (method === 'GET' && pathname === '/projects') {
    json(res, 200, registry.listProjects());
    return;
  }

  if (method === 'GET' && pathname.startsWith('/projects/')) {
    const projectIdOrSlug = decodeURIComponent(pathname.slice('/projects/'.length));
    const project = registry.getProject(projectIdOrSlug);
    if (!project) {
      json(res, 404, { error: 'not_found' });
      return;
    }
    json(res, 200, project);
    return;
  }

  if (method === 'GET' && pathname.startsWith('/routes/')) {
    const projectIdOrSlug = decodeURIComponent(pathname.slice('/routes/'.length));
    const route = registry.resolveProjectRoute(projectIdOrSlug);
    await registry.logRouteLookup(projectIdOrSlug, route);
    if (!route) {
      json(res, 404, { error: 'not_found' });
      return;
    }
    json(res, 200, route);
    return;
  }

  if (method === 'POST' && pathname === '/register/node') {
    const body = await readJsonBody<Omit<HubNodeRecord, 'registeredAt' | 'lastSeenAt' | 'status'> & { status?: HubNodeRecord['status'] }>(req);
    const node = await registry.registerNode(body);
    json(res, 200, node);
    return;
  }

  if (method === 'POST' && pathname === '/heartbeat') {
    const body = await readJsonBody<{ nodeId: string }>(req);
    const node = await registry.heartbeat(body.nodeId);
    if (!node) {
      json(res, 404, { error: 'unknown_node' });
      return;
    }
    json(res, 200, node);
    return;
  }

  if (method === 'POST' && pathname === '/register/project') {
    try {
      const body = await readJsonBody<HubProjectRecord>(req);
      const project = await registry.registerProject(body);
      json(res, 200, project);
    } catch (err) {
      json(res, 409, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  if (method === 'POST' && pathname === '/register/project-memberships') {
    try {
      const body = await readJsonBody<{
        projectId: string;
        hostNodeId: string;
        memberships: Array<Pick<HubMembershipSummary, 'principalId' | 'role'>>;
      }>(req);
      await registry.updateProjectMembershipSummary(body.projectId, body.hostNodeId, body.memberships);
      json(res, 200, { ok: true });
    } catch (err) {
      json(res, 400, { error: err instanceof Error ? err.message : String(err) });
    }
    return;
  }

  if (method === 'POST' && pathname === '/sessions/register') {
    if (!relay) {
      json(res, 500, { error: 'relay_unavailable' });
      return;
    }
    const body = await readJsonBody<{
      networkSessionId?: string;
      projectId: string;
      projectSlug?: string;
      hostNodeId: string;
      collaboration?: {
        autoArtifactSync?: boolean;
      };
      participantNodeIds: string[];
    }>(req);
    const session = await relay.createOrJoinSession(body);
    await registry.logNetworkSessionRegistered(session);
    json(res, 200, session);
    return;
  }

  if (method === 'POST' && pathname === '/sessions/event') {
    if (!relay) {
      json(res, 500, { error: 'relay_unavailable' });
      return;
    }
    const body = await readJsonBody<{ event: NetworkSessionEvent }>(req);
    await relay.enqueueEvent(body.event);
    await registry.logNetworkSessionEvent(body.event, 'network_session_event_enqueued', true);
    json(res, 200, { ok: true });
    return;
  }

  if (method === 'GET' && pathname.startsWith('/sessions/pending/')) {
    if (!relay) {
      json(res, 500, { error: 'relay_unavailable' });
      return;
    }
    const nodeId = decodeURIComponent(pathname.slice('/sessions/pending/'.length));
    json(res, 200, await relay.fetchPending(nodeId));
    return;
  }

  if (method === 'POST' && pathname === '/sessions/ack') {
    if (!relay) {
      json(res, 500, { error: 'relay_unavailable' });
      return;
    }
    const body = await readJsonBody<{ nodeId: string; eventId: string }>(req);
    const acked = await relay.ackEvent(body.nodeId, body.eventId);
    json(res, acked ? 200 : 404, acked ? { ok: true } : { error: 'not_found' });
    return;
  }

  json(res, 404, { error: 'not_found' });
}
