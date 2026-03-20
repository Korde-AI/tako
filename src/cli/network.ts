import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { resolveConfig } from '../config/resolve.js';
import { initAudit } from '../core/audit.js';
import { readNodeIdentity } from '../core/node-identity.js';
import { getRuntimePaths } from '../core/paths.js';
import { CapabilityRegistry } from '../network/capabilities.js';
import { DelegationStore } from '../network/delegation.js';
import { ProjectMembershipRegistry } from '../projects/memberships.js';
import { requireProjectRole } from '../projects/access.js';
import { ProjectRegistry } from '../projects/registry.js';
import type { ProjectRole } from '../projects/types.js';
import { bootstrapProjectHome } from '../projects/bootstrap.js';
import { defaultProjectWorkspaceRootBySlug, defaultProjectWorktreeRootForProject, resolveProjectRoot } from '../projects/root.js';
import { ProjectWorktreeRegistry } from '../projects/worktrees.js';
import { compareAuthorityRoles, isRoleWithinAuthorityCeiling, isValidAuthorityCeiling } from '../network/authority.js';
import { InviteStore, type ProjectInvite } from '../network/invites.js';
import { EdgeHubClient } from '../network/edge-client.js';
import { registerNetworkSession, pollNetworkSessionEvents, sendNetworkSessionEvent } from '../network/session-sync.js';
import { NetworkSharedSessionStore, type NetworkSessionEvent } from '../network/shared-sessions.js';
import { TrustStore } from '../network/trust.js';

function hasFlag(args: string[], name: string): boolean {
  return args.includes(name);
}

function readFlag(args: string[], name: string): string | undefined {
  const idx = args.indexOf(name);
  return idx >= 0 ? args[idx + 1] : undefined;
}

function outputJsonAware(args: string[], value: unknown, fallback?: () => void): void {
  if (hasFlag(args, '--json') || !fallback) {
    console.log(JSON.stringify(value, null, 2));
    return;
  }
  fallback();
}

function isProjectRole(value: string | undefined, fallback: ProjectRole = 'contribute'): ProjectRole {
  const role = value ?? fallback;
  if (!isValidAuthorityCeiling(role)) {
    throw new Error(`Invalid role: ${role}`);
  }
  return role;
}

function resolveProjectId(projects: ProjectRegistry, idOrSlug?: string): string {
  if (!idOrSlug) throw new Error('Missing project identifier');
  const byId = projects.get(idOrSlug);
  if (byId) return byId.projectId;
  const bySlug = projects.findBySlug(idOrSlug);
  if (bySlug) return bySlug.projectId;
  throw new Error(`Project not found: ${idOrSlug}`);
}

async function loadStores() {
  const paths = getRuntimePaths();
  const projects = new ProjectRegistry(paths.projectsDir);
  const memberships = new ProjectMembershipRegistry(paths.projectsDir);
  const trusts = new TrustStore(paths.trustFile);
  const invites = new InviteStore(paths.invitesFile);
  const networkSessions = new NetworkSharedSessionStore(paths.networkSessionsFile, paths.networkEventsFile);
  const capabilities = new CapabilityRegistry(paths.capabilitiesFile);
  const delegations = new DelegationStore(paths.delegationRequestsFile, paths.delegationResultsFile);
  await Promise.all([projects.load(), memberships.load(), trusts.load(), invites.load(), networkSessions.load(), capabilities.load(), delegations.load()]);
  return { projects, memberships, trusts, invites, networkSessions, capabilities, delegations };
}

async function initNetworkAudit() {
  const config = await resolveConfig();
  return initAudit(config.audit);
}

async function logInviteEvent(
  action: string,
  success: boolean,
  details: Record<string, unknown>,
): Promise<void> {
  const audit = await initNetworkAudit();
  await audit.log({
    agentId: 'network-cli',
    sessionId: 'network-cli',
    event: success ? 'agent_comms' : 'permission_denied',
    action,
    details,
    success,
  });
}

async function ensureAcceptedProjectWorkspace(input: {
  invite: ProjectInvite;
  projects: ProjectRegistry;
}): Promise<{
  projectId: string;
  projectRoot: string;
  worktreeRoot: string;
}> {
  const paths = getRuntimePaths();
  const identity = await readNodeIdentity();
  if (!identity) throw new Error('Node identity not initialized');

  const imported = await input.projects.importProject({
    projectId: input.invite.projectId,
    slug: input.invite.projectSlug,
    displayName: input.invite.projectSlug,
    ownerPrincipalId: input.invite.issuedByPrincipalId,
    workspaceRoot: defaultProjectWorkspaceRootBySlug(paths.workspaceDir, input.invite.projectSlug),
    status: 'active',
    collaboration: {
      mode: 'collaborative',
      announceJoins: true,
      autoArtifactSync: true,
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    metadata: {
      importedFromInviteId: input.invite.inviteId,
      importedFromNodeId: input.invite.hostNodeId,
      importedFromNodeName: input.invite.hostNodeName,
      acceptedRole: input.invite.offeredRole,
    },
  });

  await bootstrapProjectHome(paths.projectsDir, imported);
  const projectRoot = resolveProjectRoot(paths, imported);
  const worktreeRoot = defaultProjectWorktreeRootForProject(imported, paths, identity.nodeId);
  const worktrees = new ProjectWorktreeRegistry(join(paths.projectsDir, imported.projectId, 'worktrees'), imported.projectId);
  await worktrees.load();
  await worktrees.register({
    nodeId: identity.nodeId,
    root: worktreeRoot,
    label: 'network-joined',
    metadata: {
      source: 'invite_accept',
      inviteId: input.invite.inviteId,
      hostNodeId: input.invite.hostNodeId,
    },
  });

  await mkdir(projectRoot, { recursive: true });
  const projectDocPath = join(projectRoot, 'PROJECT.md');
  const statusPath = join(projectRoot, 'STATUS.md');
  const noticePath = join(projectRoot, 'NOTICE.md');
  if (!existsSync(projectDocPath)) {
    await writeFile(projectDocPath, [
      `# ${imported.displayName}`,
      '',
      `- Slug: \`${imported.slug}\``,
      `- Project ID: \`${imported.projectId}\``,
      `- Imported from node: \`${input.invite.hostNodeName ?? input.invite.hostNodeId}\``,
      `- Role on this node: \`${input.invite.offeredRole}\``,
      '',
      '## Local Node Workspace',
      `- Workspace root: \`${projectRoot}\``,
      `- Worktree root: \`${worktreeRoot}\``,
      '',
      'This local project mirror was provisioned from a network invite so the agent has a working project space on this host.',
      '',
    ].join('\n'), 'utf-8');
  }
  if (!existsSync(statusPath)) {
    await writeFile(statusPath, [
      '# STATUS',
      '',
      '## Current Goal',
      `- Sync shared project context from ${input.invite.hostNodeName ?? input.invite.hostNodeId}`,
      '',
      '## In Progress',
      '- Local workspace bootstrapped',
      '- Local worktree registered',
      '',
      '## Next Actions',
      '- Pull or receive shared project artifacts',
      '- Review PROJECT.md and shared coordination updates',
      '',
    ].join('\n'), 'utf-8');
  }
  if (!existsSync(noticePath)) {
    await writeFile(noticePath, [
      '# NOTICE',
      '',
      `This project was joined through network invite \`${input.invite.inviteId}\`.`,
      `Host node: \`${input.invite.hostNodeName ?? input.invite.hostNodeId}\``,
      `Granted role: \`${input.invite.offeredRole}\``,
      '',
      'Shared project information should be synchronized into this local host as collaboration proceeds.',
      '',
    ].join('\n'), 'utf-8');
  }

  return {
    projectId: imported.projectId,
    projectRoot,
    worktreeRoot,
  };
}

export async function runNetwork(args: string[]): Promise<void> {
  const group = args[0] ?? 'trust';
  switch (group) {
    case 'status':
      await runNetworkStatus(args.slice(1));
      return;
    case 'trust':
      await runTrust(args.slice(1));
      return;
    case 'invite':
      await runInvite(args.slice(1));
      return;
    case 'sessions':
      await runSessions(args.slice(1));
      return;
    case 'capabilities':
      await runCapabilities(args.slice(1));
      return;
    case 'delegate':
      await runDelegate(args.slice(1));
      return;
    case 'requests':
      await runRequests(args.slice(1));
      return;
    case 'results':
      await runResults(args.slice(1));
      return;
    case 'route':
      await runRoute(args.slice(1));
      return;
    default:
      console.error(`Unknown network subcommand: ${group}`);
      console.error('Available: status, trust, invite, sessions, capabilities, delegate, requests, results, route');
      process.exit(1);
  }
}

async function runNetworkStatus(args: string[]): Promise<void> {
  const { projects, memberships, trusts, invites, networkSessions, capabilities, delegations } = await loadStores();
  const config = await resolveConfig();
  const identity = await readNodeIdentity();
  await invites.expirePending();
  const summary = {
    mode: 'edge',
    home: getRuntimePaths().home,
    nodeId: identity?.nodeId ?? null,
    nodeName: identity?.name ?? null,
    bind: identity?.bind ?? config.gateway.bind,
    port: identity?.port ?? config.gateway.port,
    hub: config.network?.hub ?? null,
    projects: projects.list().length,
    membershipCount: projects.list().reduce((count, project) => count + memberships.listByProject(project.projectId).length, 0),
    trustCount: trusts.list().length,
    trustedCount: trusts.list().filter((record) => record.status === 'trusted').length,
    pendingInviteCount: invites.listPending().length,
    networkSessionCount: networkSessions.list().length,
    pendingDelegationRequests: delegations.listRequests().length,
    completedDelegationResults: delegations.listResults().length,
    enabledCapabilities: capabilities.list().filter((capability) => capability.enabled).map((capability) => capability.capabilityId),
  };
  outputJsonAware(args, summary, () => {
    console.log('Tako Network\n');
    console.log(`Home: ${summary.home}`);
    console.log(`Node: ${summary.nodeName ?? 'uninitialized'}${summary.nodeId ? ` (${summary.nodeId})` : ''}`);
    console.log(`Gateway: ${summary.bind}:${summary.port}`);
    console.log(`Hub: ${summary.hub ?? 'not configured'}`);
    console.log(`Projects: ${summary.projects}`);
    console.log(`Memberships: ${summary.membershipCount}`);
    console.log(`Trusts: ${summary.trustCount} (${summary.trustedCount} trusted)`);
    console.log(`Pending invites: ${summary.pendingInviteCount}`);
    console.log(`Network sessions: ${summary.networkSessionCount}`);
    console.log(`Delegation requests: ${summary.pendingDelegationRequests}`);
    console.log(`Delegation results: ${summary.completedDelegationResults}`);
    console.log(`Enabled capabilities: ${summary.enabledCapabilities.length > 0 ? summary.enabledCapabilities.join(', ') : 'none'}`);
  });
}

async function runCapabilities(args: string[]): Promise<void> {
  const sub = args[0] ?? 'list';
  const { capabilities } = await loadStores();
  switch (sub) {
    case 'list': {
      const rows = capabilities.list();
      outputJsonAware(args, rows, () => {
        for (const capability of rows) {
          console.log(`${capability.capabilityId}  enabled=${capability.enabled}  minRole=${capability.minRole}  category=${capability.category}`);
        }
      });
      return;
    }
    case 'enable':
    case 'disable': {
      const capabilityId = args[1];
      if (!capabilityId) throw new Error(`Usage: tako network capabilities ${sub} <capabilityId>`);
      const updated = await capabilities.setEnabled(capabilityId, sub === 'enable');
      await logInviteEvent('capability_update', true, { capabilityId, enabled: updated.enabled });
      outputJsonAware(args, updated);
      return;
    }
    default:
      throw new Error('Usage: tako network capabilities <list|enable|disable>');
  }
}

async function runTrust(args: string[]): Promise<void> {
  const sub = args[0] ?? 'list';
  const { trusts } = await loadStores();
  switch (sub) {
    case 'list': {
      const records = trusts.list();
      if (records.length === 0) {
        console.log('No trust records found.');
        return;
      }
      outputJsonAware(args, records, () => {
        for (const record of records) {
          console.log(`${record.remoteNodeId}  ${record.status}  ceiling=${record.authorityCeiling}${record.remoteNodeName ? `  name=${record.remoteNodeName}` : ''}`);
        }
      });
      return;
    }
    case 'revoke': {
      const nodeId = args[1];
      if (!nodeId) {
        throw new Error('Usage: tako network trust revoke <nodeId>');
      }
      const record = await trusts.revoke(nodeId);
      if (!record) {
        console.error(`Trust record not found: ${nodeId}`);
        process.exit(1);
      }
      await logInviteEvent('trust_revoke', true, { remoteNodeId: nodeId });
      outputJsonAware(args, record);
      return;
    }
    default:
      throw new Error('Usage: tako network trust <list|revoke>');
  }
}

async function runSessions(args: string[]): Promise<void> {
  const sub = args[0] ?? 'list';
  const { projects, networkSessions, trusts } = await loadStores();
  switch (sub) {
    case 'list': {
      const sessions = networkSessions.list();
      if (sessions.length === 0) {
        console.log('No network sessions found.');
        return;
      }
      outputJsonAware(args, sessions, () => {
        for (const session of sessions) {
          console.log(`${session.networkSessionId}  ${session.projectSlug ?? session.projectId}  host=${session.hostNodeId}  nodes=${session.participantNodeIds.length}  status=${session.status}`);
        }
      });
      return;
    }
    case 'show': {
      const networkSessionId = args[1];
      if (!networkSessionId) throw new Error('Usage: tako network sessions show <networkSessionId>');
      const session = networkSessions.get(networkSessionId);
      if (!session) {
        console.error(`Network session not found: ${networkSessionId}`);
        process.exit(1);
      }
      outputJsonAware(args, { ...session, events: networkSessions.listEvents(networkSessionId) });
      return;
    }
    case 'register': {
      const projectId = resolveProjectId(projects, args[1]);
      const nodes = (readFlag(args, '--nodes') ?? '')
        .split(',')
        .map((value) => value.trim())
        .filter(Boolean);
      if (nodes.length === 0) {
        throw new Error('Usage: tako network sessions register <projectId|slug> --nodes <nodeA,nodeB> [--session <localSessionId>] [--shared <sharedSessionId>]');
      }
      const config = await resolveConfig();
      if (!config.network?.hub) throw new Error('No network.hub configured for this edge');
      const identity = await readNodeIdentity();
      if (!identity) throw new Error('Node identity not initialized');
      const project = projects.get(projectId);
      if (!project) throw new Error(`Project not found: ${projectId}`);
      const client = new EdgeHubClient(config.network.hub);
      const session = await registerNetworkSession(client, networkSessions, {
        projectId: project.projectId,
        projectSlug: project.slug,
        hostNodeId: identity.nodeId,
        collaboration: {
          autoArtifactSync: hasFlag(args, '--auto-artifacts'),
        },
        participantNodeIds: [identity.nodeId, ...nodes],
      });
      const localSessionId = readFlag(args, '--session');
      const sharedSessionId = readFlag(args, '--shared');
      if (localSessionId) {
        await networkSessions.bindLocalSession({
          networkSessionId: session.networkSessionId,
          nodeId: identity.nodeId,
          localSessionId,
          sharedSessionId,
        });
      }
      const joinEvent: NetworkSessionEvent = {
        eventId: crypto.randomUUID(),
        networkSessionId: session.networkSessionId,
        projectId: project.projectId,
        fromNodeId: identity.nodeId,
        fromPrincipalId: 'system',
        type: 'join',
        audience: 'specific-nodes',
        targetNodeIds: nodes,
        payload: {
          summary: `Node ${identity.nodeId} joined ${project.slug}`,
          metadata: {
            joinKind: 'node_join',
            projectSlug: project.slug,
            nodeName: identity.name,
          },
        },
        createdAt: new Date().toISOString(),
      };
      await sendNetworkSessionEvent(client, networkSessions, trusts, joinEvent);
      await logInviteEvent('network_session_register', true, { networkSessionId: session.networkSessionId, projectId: project.projectId, participantNodeIds: session.participantNodeIds });
      outputJsonAware(args, networkSessions.get(session.networkSessionId));
      return;
    }
    case 'poll': {
      const config = await resolveConfig();
      if (!config.network?.hub) throw new Error('No network.hub configured for this edge');
      const identity = await readNodeIdentity();
      if (!identity) throw new Error('Node identity not initialized');
      const client = new EdgeHubClient(config.network.hub);
      const events = await pollNetworkSessionEvents(client, networkSessions, identity.nodeId);
      await logInviteEvent('network_session_poll', true, { nodeId: identity.nodeId, fetched: events.length });
      outputJsonAware(args, { fetched: events.length });
      return;
    }
    default:
      throw new Error('Usage: tako network sessions <list|show|register|poll>');
  }
}

async function runRoute(args: string[]): Promise<void> {
  const projectIdOrSlug = args[0];
  if (!projectIdOrSlug) {
    throw new Error('Usage: tako network route <projectId|slug>');
  }
  const config = await resolveConfig();
  if (!config.network?.hub) throw new Error('No network.hub configured for this edge');
  const client = new EdgeHubClient(config.network.hub);
  const route = await client.lookupRoute(projectIdOrSlug);
  if (!route) {
    console.error(`No hub route found for ${projectIdOrSlug}`);
    process.exit(1);
  }
  outputJsonAware(args, route, () => {
    console.log(`${projectIdOrSlug} -> host=${route.hostNodeId} project=${route.projectId}`);
  });
}

async function runDelegate(args: string[]): Promise<void> {
  const { projects, trusts, networkSessions, delegations } = await loadStores();
  const projectId = resolveProjectId(projects, args[0]);
  const toNodeId = readFlag(args, '--to');
  const capabilityId = readFlag(args, '--capability');
  const prompt = readFlag(args, '--prompt');
  const networkSessionId = readFlag(args, '--network-session');
  if (!toNodeId || !capabilityId) {
    throw new Error('Usage: tako network delegate <projectId|slug> --to <nodeId> --capability <capabilityId> [--prompt <text>] [--network-session <id>]');
  }
  const config = await resolveConfig();
  if (!config.network?.hub) throw new Error('No network.hub configured for this edge');
  const identity = await readNodeIdentity();
  if (!identity) throw new Error('Node identity not initialized');
  const trust = trusts.getByNodeId(toNodeId);
  if (!trust || trust.status !== 'trusted') {
    throw new Error(`Remote node is not trusted: ${toNodeId}`);
  }
  const session = networkSessionId
    ? networkSessions.get(networkSessionId)
    : networkSessions.findByProject(projectId).find((candidate) => candidate.participantNodeIds.includes(toNodeId)) ?? null;
  if (!session) throw new Error(`No network session bound to project ${projectId} for node ${toNodeId}`);
  const request = await delegations.createRequest({
    networkSessionId: session.networkSessionId,
    projectId,
    fromNodeId: identity.nodeId,
    fromPrincipalId: 'system',
    toNodeId,
    capabilityId,
    input: {
      prompt,
      metadata: {
        projectSlug: projects.get(projectId)?.slug,
      },
    },
  });
  const client = new EdgeHubClient(config.network.hub);
  const event: NetworkSessionEvent = {
    eventId: crypto.randomUUID(),
    networkSessionId: session.networkSessionId,
    projectId,
    fromNodeId: identity.nodeId,
    fromPrincipalId: request.fromPrincipalId,
    type: 'delegation_request',
    audience: 'specific-nodes',
    targetNodeIds: [toNodeId],
    payload: {
      delegationRequest: request,
      summary: `Delegation request ${request.capabilityId}`,
      metadata: { toNodeId },
    },
    createdAt: new Date().toISOString(),
  };
  await sendNetworkSessionEvent(client, networkSessions, trusts, event);
  await logInviteEvent('delegation_request_send', true, { requestId: request.requestId, toNodeId, capabilityId });
  outputJsonAware(args, request);
}

async function runRequests(args: string[]): Promise<void> {
  const sub = args[0] ?? 'list';
  const { delegations } = await loadStores();
  switch (sub) {
    case 'list':
      outputJsonAware(args, delegations.listRequests(), () => {
        for (const request of delegations.listRequests()) {
          console.log(`${request.requestId}  ${request.projectId}  ${request.capabilityId}  ${request.fromNodeId} -> ${request.toNodeId}`);
        }
      });
      return;
    case 'show': {
      const requestId = args[1];
      if (!requestId) throw new Error('Usage: tako network requests show <requestId>');
      const request = delegations.getRequest(requestId);
      if (!request) {
        console.error(`Delegation request not found: ${requestId}`);
        process.exit(1);
      }
      outputJsonAware(args, request);
      return;
    }
    default:
      throw new Error('Usage: tako network requests <list|show>');
  }
}

async function runResults(args: string[]): Promise<void> {
  const sub = args[0] ?? 'show';
  const { delegations } = await loadStores();
  switch (sub) {
    case 'show': {
      const requestId = args[1];
      if (!requestId) throw new Error('Usage: tako network results show <requestId>');
      const result = delegations.getResult(requestId);
      if (!result) {
        console.error(`Delegation result not found: ${requestId}`);
        process.exit(1);
      }
      outputJsonAware(args, result);
      return;
    }
    default:
      throw new Error('Usage: tako network results show <requestId>');
  }
}

async function runInvite(args: string[]): Promise<void> {
  const sub = args[0] ?? 'list';
  const stores = await loadStores();
  await stores.invites.expirePending();

  switch (sub) {
    case 'list': {
      const invites = stores.invites.list();
      if (invites.length === 0) {
        console.log('No invites found.');
        return;
      }
      outputJsonAware(args, invites, () => {
        for (const invite of invites) {
          console.log(`${invite.inviteId}  ${invite.projectSlug}  host=${invite.hostNodeId}  role=${invite.offeredRole}  status=${invite.status}`);
        }
      });
      return;
    }
    case 'show': {
      const inviteId = args[1];
      if (!inviteId) throw new Error('Usage: tako network invite show <inviteId>');
      const invite = stores.invites.get(inviteId);
      if (!invite) {
        console.error(`Invite not found: ${inviteId}`);
        process.exit(1);
      }
      outputJsonAware(args, invite);
      return;
    }
    case 'create': {
      const projectId = resolveProjectId(stores.projects, args[1]);
      const issuedBy = readFlag(args, '--issued-by');
      const targetNodeId = readFlag(args, '--target-node');
      const targetHint = readFlag(args, '--target-hint');
      const role = isProjectRole(readFlag(args, '--role'));
      const ceiling = isProjectRole(readFlag(args, '--ceiling') ?? role);
      if (!issuedBy || !targetNodeId) {
        throw new Error('Usage: tako network invite create <projectId|slug> --issued-by <principalId> --target-node <nodeId> [--target-hint <text>] [--role <role>] [--ceiling <role>] [--expires-at <iso>]');
      }
      if (!isRoleWithinAuthorityCeiling(role, ceiling)) {
        await logInviteEvent('invite_create', false, { projectId, issuedBy, targetNodeId, offeredRole: role, authorityCeiling: ceiling, reason: 'offered_role_exceeds_ceiling' });
        throw new Error(`Offered role ${role} exceeds trust ceiling ${ceiling}`);
      }
      if (!requireProjectRole(stores.memberships, projectId, issuedBy, 'admin')) {
        await logInviteEvent('invite_create', false, { projectId, issuedBy, targetNodeId, reason: 'issuer_not_admin' });
        throw new Error(`Principal ${issuedBy} is not authorized to invite collaborators for project ${projectId}`);
      }
      const project = stores.projects.get(projectId);
      if (!project) throw new Error(`Project not found: ${projectId}`);
      await stores.trusts.createPending({
        remoteNodeId: targetNodeId,
        authorityCeiling: ceiling,
        metadata: { source: 'invite_create', projectId },
      });
      const identity = await readNodeIdentity();
      const invite = await stores.invites.create({
        projectId: project.projectId,
        projectSlug: project.slug,
        hostNodeId: identity?.nodeId ?? 'unknown-host',
        hostNodeName: identity?.name,
        issuedByPrincipalId: issuedBy,
        targetNodeId,
        targetHint,
        offeredRole: role,
        expiresAt: readFlag(args, '--expires-at'),
      });
      await stores.projects.update(project.projectId, {
        collaboration: {
          ...(project.collaboration ?? {}),
          mode: 'collaborative',
          announceJoins: true,
          autoArtifactSync: project.collaboration?.autoArtifactSync ?? true,
        },
        metadata: {
          ...(project.metadata ?? {}),
          collaborationActivatedAt: new Date().toISOString(),
          collaborationActivatedReason: `invite_create:${invite.inviteId}`,
        },
      });
      await logInviteEvent('invite_create', true, {
        inviteId: invite.inviteId,
        projectId: project.projectId,
        projectSlug: project.slug,
        targetNodeId,
        offeredRole: role,
        authorityCeiling: ceiling,
      });
      outputJsonAware(args, invite);
      return;
    }
    case 'import': {
      const source = args[1];
      if (!source) throw new Error('Usage: tako network invite import <file>');
      const parsed = JSON.parse(await readFile(source, 'utf-8')) as ProjectInvite;
      const invite = await stores.invites.importInvite(parsed);
      await stores.trusts.createPending({
        remoteNodeId: invite.hostNodeId,
        remoteNodeName: invite.hostNodeName,
        authorityCeiling: invite.offeredRole,
        metadata: { source: 'invite_import', projectId: invite.projectId },
      });
      await logInviteEvent('invite_import', true, { inviteId: invite.inviteId, hostNodeId: invite.hostNodeId, projectId: invite.projectId });
      outputJsonAware(args, invite);
      return;
    }
    case 'accept': {
      const inviteId = args[1];
      if (!inviteId) throw new Error('Usage: tako network invite accept <inviteId> [--ceiling <role>]');
      const invite = stores.invites.get(inviteId);
      if (!invite) {
        console.error(`Invite not found: ${inviteId}`);
        process.exit(1);
      }
      if (invite.status !== 'pending') {
        throw new Error(`Invite ${inviteId} is not pending`);
      }
      const desiredCeiling = isProjectRole(readFlag(args, '--ceiling') ?? invite.offeredRole);
      if (!isRoleWithinAuthorityCeiling(invite.offeredRole, desiredCeiling)) {
        await logInviteEvent('invite_accept', false, { inviteId, offeredRole: invite.offeredRole, authorityCeiling: desiredCeiling, reason: 'offered_role_exceeds_ceiling' });
        throw new Error(`Invite role ${invite.offeredRole} exceeds requested ceiling ${desiredCeiling}`);
      }
      const currentTrust = stores.trusts.getByNodeId(invite.hostNodeId);
      if (currentTrust && compareAuthorityRoles(invite.offeredRole, currentTrust.authorityCeiling) > 0) {
        await logInviteEvent('invite_accept', false, { inviteId, offeredRole: invite.offeredRole, currentCeiling: currentTrust.authorityCeiling, reason: 'offered_role_exceeds_existing_ceiling' });
        throw new Error(`Invite role ${invite.offeredRole} exceeds trusted ceiling ${currentTrust.authorityCeiling}`);
      }
      const effectiveCeiling = currentTrust && compareAuthorityRoles(desiredCeiling, currentTrust.authorityCeiling) > 0
        ? currentTrust.authorityCeiling
        : desiredCeiling;
      if (!currentTrust) {
        await stores.trusts.createPending({
          remoteNodeId: invite.hostNodeId,
          remoteNodeName: invite.hostNodeName,
          authorityCeiling: effectiveCeiling,
          metadata: { source: 'invite_accept', projectId: invite.projectId },
        });
      }
      const trust = await stores.trusts.markTrusted(invite.hostNodeId, effectiveCeiling);
      const accepted = await stores.invites.markAccepted(invite.inviteId);
      const localProject = await ensureAcceptedProjectWorkspace({
        invite,
        projects: stores.projects,
      });
      await logInviteEvent('invite_accept', true, {
        inviteId,
        hostNodeId: invite.hostNodeId,
        authorityCeiling: effectiveCeiling,
        trustId: trust?.trustId,
        localProjectId: localProject.projectId,
        projectRoot: localProject.projectRoot,
        worktreeRoot: localProject.worktreeRoot,
      });
      outputJsonAware(args, { invite: accepted, trust, localProject });
      return;
    }
    case 'reject': {
      const inviteId = args[1];
      if (!inviteId) throw new Error('Usage: tako network invite reject <inviteId>');
      const invite = stores.invites.get(inviteId);
      if (!invite) {
        console.error(`Invite not found: ${inviteId}`);
        process.exit(1);
      }
      const rejected = await stores.invites.markRejected(inviteId);
      await stores.trusts.markRejected(invite.hostNodeId);
      await logInviteEvent('invite_reject', true, { inviteId, hostNodeId: invite.hostNodeId });
      outputJsonAware(args, rejected);
      return;
    }
    default:
      throw new Error('Usage: tako network invite <list|show|create|import|accept|reject>');
  }
}
