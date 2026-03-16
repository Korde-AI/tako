import { readNodeIdentity } from '../core/node-identity.js';
import { getRuntimeHome, getRuntimeMode, getRuntimePaths } from '../core/paths.js';
import { HubRelay } from '../hub/relay.js';
import { HubStateStore } from '../hub/state.js';
import { HubRegistry } from '../hub/registry.js';

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function outputJsonAware(args: string[], value: unknown, fallback?: () => void): void {
  if (hasFlag(args, '--json') || !fallback) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  fallback();
}

export async function runHubCli(args: string[]): Promise<void> {
  const subcommand = args[0] ?? 'status';
  switch (subcommand) {
    case 'status':
      await runHubStatus(args.slice(1));
      return;
    case 'identity':
      await runHubIdentity(args.slice(1));
      return;
    case 'nodes':
      await runHubNodes(args.slice(1));
      return;
    case 'projects':
      await runHubProjects(args.slice(1));
      return;
    case 'route':
      await runHubRoute(args.slice(1));
      return;
    default:
      console.error(`Unknown hub subcommand: ${subcommand}`);
      console.error('Available: start, status, identity, nodes, projects, route');
      process.exit(1);
  }
}

async function loadRegistry(): Promise<HubRegistry> {
  const store = new HubStateStore(getRuntimePaths().registryDir);
  await store.load();
  return new HubRegistry(store);
}

async function loadRelay(): Promise<HubRelay> {
  const paths = getRuntimePaths();
  const relay = new HubRelay(paths.relaySessionsFile, paths.relayPendingEventsFile);
  await relay.load();
  return relay;
}

async function runHubStatus(args: string[]): Promise<void> {
  const identity = await readNodeIdentity();
  const registry = await loadRegistry();
  const relay = await loadRelay();
  const summary = registry.getStatusSummary();
  const payload = {
    mode: getRuntimeMode(),
    home: getRuntimeHome(),
    identity,
    summary: {
      ...summary,
      relaySessionCount: relay.listSessions().length,
      queuedRelayEventCount: (await Promise.all(registry.listNodes().map((node) => relay.fetchPending(node.nodeId)))).reduce((sum, rows) => sum + rows.length, 0),
    },
  };
  outputJsonAware(args, payload, () => {
    console.log('Tako Hub\n');
    console.log(`Mode: ${payload.mode}`);
    console.log(`Home: ${payload.home}`);
    if (!identity) {
      console.log('Identity: not initialized');
      return;
    }
    console.log(`Node ID: ${identity.nodeId}`);
    console.log(`Name: ${identity.name}`);
    console.log(`Bind: ${identity.bind ?? 'unknown'}`);
    console.log(`Port: ${identity.port ?? 'unknown'}`);
    console.log(`Last started: ${identity.lastStartedAt}`);
    console.log(`Nodes: ${payload.summary.nodeCount} (${payload.summary.onlineNodeCount} online)`);
    console.log(`Projects: ${payload.summary.projectCount}`);
    console.log(`Relay sessions: ${payload.summary.relaySessionCount}`);
    console.log(`Queued relay events: ${payload.summary.queuedRelayEventCount}`);
  });
}

async function runHubIdentity(args: string[]): Promise<void> {
  const identity = await readNodeIdentity();
  if (!identity) {
    console.error(`No hub identity found under ${getRuntimeHome()}`);
    process.exit(1);
  }
  outputJsonAware(args, identity);
}

async function runHubNodes(args: string[]): Promise<void> {
  const registry = await loadRegistry();
  const nodes = registry.listNodes();
  if (nodes.length === 0) {
    console.log('No nodes registered.');
    return;
  }
  outputJsonAware(args, nodes, () => {
    for (const node of nodes) {
      console.log(`${node.nodeId}  ${node.mode}  ${node.name}  status=${node.status}  bind=${node.bind ?? 'unknown'}  port=${node.port ?? 'unknown'}`);
    }
  });
}

async function runHubProjects(args: string[]): Promise<void> {
  const registry = await loadRegistry();
  const projects = registry.listProjects();
  if (projects.length === 0) {
    console.log('No projects registered.');
    return;
  }
  outputJsonAware(args, projects, () => {
    for (const project of projects) {
      console.log(`${project.projectId}  ${project.slug}  host=${project.hostNodeId}  status=${project.status}  members=${project.memberCount ?? 0}`);
    }
  });
}

async function runHubRoute(args: string[]): Promise<void> {
  const projectIdOrSlug = args[0];
  if (!projectIdOrSlug) {
    console.error('Usage: tako hub route <projectId|slug>');
    process.exit(1);
  }
  const registry = await loadRegistry();
  const route = registry.resolveProjectRoute(projectIdOrSlug);
  if (!route) {
    console.error(`No route found for ${projectIdOrSlug}`);
    process.exit(1);
  }
  outputJsonAware(args, route, () => {
    console.log(`${projectIdOrSlug} -> host=${route.hostNodeId} project=${route.projectId}`);
  });
}
