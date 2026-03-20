import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { parseNodeMode, type NodeMode } from './runtime-mode.js';

export interface TakoPaths {
  home: string;
  nodeIdentityFile: string;
  configFile: string;
  envFile: string;
  networkDir: string;
  trustFile: string;
  invitesFile: string;
  pairingFile: string;
  networkSessionsFile: string;
  networkEventsFile: string;
  capabilitiesFile: string;
  delegationRequestsFile: string;
  delegationResultsFile: string;
  authDir: string;
  credentialsDir: string;
  runtimeDir: string;
  lockFile: string;
  pidFile: string;
  logsDir: string;
  auditDir: string;
  registryDir: string;
  relayDir: string;
  relaySessionsFile: string;
  relayPendingEventsFile: string;
  principalsDir: string;
  projectsDir: string;
  sharedSessionsDir: string;
  mediaDir: string;
  cronDir: string;
  deliveryQueueDir: string;
  agentsDir: string;
  peersDir: string;
  sessionsDir: string;
  workspaceDir: string;
  acpDir: string;
  threadBindingsFile: string;
  restartNoteFile: string;
  introducedChannelsFile: string;
  peerTaskApprovalsFile: string;
}

let currentMode: NodeMode = parseNodeMode(process.env['TAKO_MODE']);
let currentHome: string | null = null;
let currentPaths: TakoPaths | null = null;

export function expandHomePath(input: string): string {
  if (input === '~') return homedir();
  if (input.startsWith('~/')) return join(homedir(), input.slice(2));
  return input;
}

export function defaultHomeForMode(mode: NodeMode): string {
  return mode === 'hub' ? '~/.tako-hub' : '~/.tako-edge-main';
}

export function resolveHome(explicitHome?: string | null, mode: NodeMode = currentMode): string {
  const homeInput = explicitHome ?? process.env['TAKO_HOME'] ?? defaultHomeForMode(mode);
  const expanded = expandHomePath(homeInput);
  return isAbsolute(expanded) ? expanded : resolve(expanded);
}

export function createTakoPaths(home: string): TakoPaths {
  return {
    home,
    nodeIdentityFile: join(home, 'node.json'),
    configFile: join(home, 'tako.json'),
    envFile: join(home, '.env'),
    networkDir: join(home, 'network'),
    trustFile: join(home, 'network', 'trust.json'),
    invitesFile: join(home, 'network', 'invites.json'),
    pairingFile: join(home, 'network', 'pairing.json'),
    networkSessionsFile: join(home, 'network', 'network-sessions.json'),
    networkEventsFile: join(home, 'network', 'network-events.json'),
    capabilitiesFile: join(home, 'network', 'capabilities.json'),
    delegationRequestsFile: join(home, 'network', 'delegation-requests.json'),
    delegationResultsFile: join(home, 'network', 'delegation-results.json'),
    authDir: join(home, 'auth'),
    credentialsDir: join(home, 'credentials'),
    runtimeDir: join(home, 'runtime'),
    lockFile: join(home, 'runtime', 'tako.lock'),
    pidFile: join(home, 'runtime', 'tako.pid'),
    logsDir: join(home, 'logs'),
    auditDir: join(home, 'audit'),
    registryDir: join(home, 'registry'),
    relayDir: join(home, 'relay'),
    relaySessionsFile: join(home, 'relay', 'sessions.json'),
    relayPendingEventsFile: join(home, 'relay', 'pending-events.json'),
    principalsDir: join(home, 'principals'),
    projectsDir: join(home, 'projects'),
    sharedSessionsDir: join(home, 'shared-sessions'),
    mediaDir: join(home, 'media'),
    cronDir: join(home, 'cron'),
    deliveryQueueDir: join(home, 'delivery-queue'),
    agentsDir: join(home, 'agents'),
    peersDir: join(home, 'peers'),
    sessionsDir: join(home, 'sessions'),
    workspaceDir: join(home, 'workspace'),
    acpDir: join(home, 'acp'),
    threadBindingsFile: join(home, 'runtime', 'thread-bindings.json'),
    restartNoteFile: join(home, 'runtime', 'restart-note.json'),
    introducedChannelsFile: join(home, 'runtime', 'introduced-channels.json'),
    peerTaskApprovalsFile: join(home, 'runtime', 'peer-task-approvals.json'),
  };
}

export function setRuntimePaths(opts: { home?: string | null; mode?: NodeMode | null }): TakoPaths {
  currentMode = parseNodeMode(opts.mode ?? currentMode);
  currentHome = resolveHome(opts.home, currentMode);
  currentPaths = createTakoPaths(currentHome);
  process.env['TAKO_HOME'] = currentHome;
  process.env['TAKO_MODE'] = currentMode;
  return currentPaths;
}

export function getRuntimeMode(): NodeMode {
  if (!currentPaths) setRuntimePaths({});
  return currentMode;
}

export function getRuntimeHome(): string {
  if (!currentPaths) setRuntimePaths({});
  return currentHome!;
}

export function getRuntimePaths(): TakoPaths {
  if (!currentPaths) setRuntimePaths({});
  return currentPaths!;
}

export function getProjectWorkspaceDir(projectId: string): string {
  return join(getRuntimePaths().projectsDir, projectId, 'workspace');
}
