import { createServer, type Server as HttpServer } from 'node:http';
import { mkdir } from 'node:fs/promises';
import { getRuntimePaths, setRuntimePaths } from '../core/paths.js';
import { createHubState, type HubRuntimeState } from './state.js';
import { handleHubRequest } from './routes.js';
import { loadOrCreateNodeIdentity } from '../core/node-identity.js';
import { HubRegistry } from './registry.js';
import { initAudit } from '../core/audit.js';
import { HubAudit } from './audit.js';
import { HubRelay } from './relay.js';

export interface HubStartOptions {
  home?: string;
  bind?: string;
  port?: number;
}

export interface StartedHubServer {
  state: HubRuntimeState;
  registry: HubRegistry;
  relay: HubRelay;
  server: HttpServer;
}

export async function createStartedHubServer(opts: HubStartOptions = {}): Promise<StartedHubServer> {
  const paths = setRuntimePaths({ home: opts.home, mode: 'hub' });
  await mkdir(paths.runtimeDir, { recursive: true });
  await mkdir(paths.logsDir, { recursive: true });
  await mkdir(paths.auditDir, { recursive: true });
  await mkdir(paths.registryDir, { recursive: true });
  await mkdir(paths.relayDir, { recursive: true });

  const bind = opts.bind ?? '127.0.0.1';
  const port = opts.port ?? 18790;
  const identity = await loadOrCreateNodeIdentity({
    mode: 'hub',
    home: paths.home,
    bind,
    port,
  });
  const state = await createHubState(identity, bind, port, paths.registryDir);
  const audit = initAudit({ enabled: true, maxFileSizeMb: 10, retention: '30d' });
  const registry = new HubRegistry(state.store, new HubAudit(audit, identity.nodeId));
  const relay = new HubRelay(paths.relaySessionsFile, paths.relayPendingEventsFile);
  await relay.load();

  const server: HttpServer = createServer((req, res) => {
    void handleHubRequest(state, registry, relay, req, res).catch((err) => {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    });
  });

  return { state, registry, relay, server };
}

export async function startHubServer(opts: HubStartOptions = {}): Promise<void> {
  const { state, server } = await createStartedHubServer(opts);

  console.log(`[tako-hub] mode=hub home=${state.identity.home} bind=${state.bind} port=${state.port} node=${state.identity.nodeId}`);

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(state.port, state.bind, () => {
      server.off('error', reject);
      resolve();
    });
  });

  console.log(`[tako-hub] listening on http://${state.bind}:${state.port}`);

  await new Promise<void>(() => {
    // Intentionally never resolves while server is running.
  });
}
