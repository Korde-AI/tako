# Tako Collaboration Network

## Purpose
This document captures the collaboration-network design that now drives Tako's runtime changes.

The target product is:
- one personal `edge` node per user
- one optional `hub` node for coordination
- no central shared LLM runtime
- no shared token-credit pool by default

Each user keeps their own:
- provider credentials
- model usage and billing
- private memory
- local tools
- local files
- local execution environment

The hub is infrastructure only. It coordinates:
- node identity
- peer discovery
- project membership
- session routing and relay
- presence and capability summaries
- audit aggregation

The hub does not:
- run prompts through an LLM
- own private user memory by default
- execute user tools
- become the central reasoning agent

## Runtime Model

### Edge
An edge is the full Tako runtime.

Properties:
- can run alone
- can later connect to a hub
- owns local state
- resolves users into principals
- runs the agent loop locally

Examples:

```bash
tako start --home ~/.tako-edge-main
tako start --home ~/.tako-edge-alice --hub hub.example.com:18790
```

### Hub
A hub is the coordination service.

Properties:
- no LLM runtime
- no channel/provider startup
- health and status endpoints only in early phases
- stores network coordination data

Example:

```bash
tako hub start --home ~/.tako-hub
```

## Core Design Decisions

### 1. `--home` instead of global `~/.tako`
The old runtime assumed one global installation rooted at `~/.tako`.

That is incompatible with:
- multiple edge nodes on one machine
- hub and edge coexisting on one machine
- clean local testing of the collaboration topology

So each node now has an installation root:
- edge default: `~/.tako-edge-main`
- hub default: `~/.tako-hub`

All important runtime state must live under `<home>`.

### 2. `edge` is the real local runtime
There is no separate standalone architecture anymore.

Solo use is just:
- an edge with no hub configured

That keeps the runtime model simple:
- `edge` = agent node
- `hub` = coordination node

### 3. Principal identity comes before projects
Projects, memberships, and shared sessions only make sense if the runtime can already answer:
- who is this user?
- is this the same human across repeated interactions?
- what local principal owns this action?

So principal identity is introduced before project membership.

### 4. Local correctness before federation
The final product is networked edges plus hub.

But federation is not the first engineering dependency.

The edge runtime must first understand:
- installation-local state
- node identity
- principal identity
- principal-aware session metadata
- principal-aware ACL compatibility

Otherwise the network would only distribute broken local assumptions.

## Construction Drawings

### Solo edge

```text
user
  -> local channel
  -> local edge
  -> local prompt + local tools + local memory
```

### Collaboration network

```text
Alice edge ----\
Bob edge   -----+---- hub
Carol edge ----/
```

### Responsibility split

```text
edge:
  principal resolution
  local authorization
  local agent loop
  local tools
  private memory

hub:
  node registry
  project registry
  memberships
  routing
  relay
  audit aggregation
```

## Phase 1 Summary

Phase 1 introduced installation-local runtime state.

Delivered:
- `--home`
- central path resolver
- isolated config/env/auth/runtime storage
- isolated lock and PID files
- isolated edge and hub homes

Key files:
- [src/core/paths.ts](../src/core/paths.ts)
- [src/core/runtime-mode.ts](../src/core/runtime-mode.ts)

Outcome:
- one machine can safely host multiple Tako nodes

## Phase 2 Summary

Phase 2 made the node model explicit.

Delivered:
- explicit `edge` and `hub`
- persistent node identity
- hub runtime shell with health/status/identity endpoints
- home-aware daemon/status behavior

Key files:
- [src/core/node-identity.ts](../src/core/node-identity.ts)
- [src/hub/server.ts](../src/hub/server.ts)
- [src/hub/routes.ts](../src/hub/routes.ts)
- [src/cli/hub.ts](../src/cli/hub.ts)

Outcome:
- `edge` and `hub` are now explicit runtime types

## Phase 3 Summary

Phase 3 introduced principal identity on the edge.

Delivered:
- persistent principal registry under `<home>/principals`
- principal resolution for inbound users
- principal-aware command context
- principal-aware session metadata
- principal-aware ACL compatibility
- principal-aware audit records
- principal-aware message queue batching

Key files:
- [src/principals/types.ts](../src/principals/types.ts)
- [src/principals/registry.ts](../src/principals/registry.ts)
- [src/cli/principals.ts](../src/cli/principals.ts)
- [src/auth/allow-from.ts](../src/auth/allow-from.ts)
- [src/core/audit.ts](../src/core/audit.ts)
- [src/core/message-queue.ts](../src/core/message-queue.ts)

Runtime consequences:
- inbound users resolve to stable `principalId`
- sessions carry:
  - `principalId`
  - `principalName`
  - `platform`
  - `platformUserId`
- `/claim` stores both compatibility-era platform IDs and principal IDs
- rate limiting prefers `principalId`
- audit logs carry principal identity

## Data Layout

### Edge home

```text
<edgeHome>/
├── tako.json
├── .env
├── node.json
├── auth/
├── credentials/
├── runtime/
├── principals/
├── agents/
├── media/
├── cron/
├── delivery-queue/
├── audit/
└── workspace/
```

### Hub home

```text
<hubHome>/
├── node.json
├── runtime/
├── audit/
└── ...
```

## Current Identity Model

### Principal

```ts
Principal {
  principalId: string
  type: 'human' | 'local-agent' | 'remote-agent' | 'system'
  displayName: string
  aliases?: string[]
  createdAt: string
  updatedAt: string
  lastSeenAt?: string
  authorityLevel?: 'owner' | 'admin' | 'member' | 'guest'
  metadata?: Record<string, unknown>
}
```

### Platform mapping

```ts
PrincipalPlatformMapping {
  principalId: string
  platform: 'discord' | 'telegram' | 'cli' | 'web' | 'system'
  platformUserId: string
  username?: string
  displayName?: string
  linkedAt: string
  lastSeenAt?: string
}
```

## Compatibility Rules

Phase 3 is intentionally transitional in a few places.

Still retained for compatibility:
- `authorId`
- `platformUserId`
- legacy allowlists keyed by platform user IDs

Preferred identity for new runtime behavior:
- `principalId`
- `principalName`

This means:
- old session and command flows still work
- new auth and audit paths can already use principal identity

## What Phase 3 Does Not Do

Phase 3 does not yet implement:
- shared-session participation lists
- cross-edge identity federation

Those belong to later phases.

## What Phase 4 Depends On

Phase 4 can now build on:
- installation-local homes
- explicit node identity
- stable principal identity
- principal-aware sessions

## Phase 4 Summary

Phase 4 introduced the first real collaboration boundary on the edge.

Delivered:
- persistent project registry under `<home>/projects/projects.json`
- persistent project membership registry under `<home>/projects/memberships.json`
- persistent project binding registry under `<home>/projects/bindings.json`
- project home bootstrap under `<home>/projects/<projectId>/`
- project CLI for:
  - create
  - list
  - show
  - members
  - add-member
  - remove-member
  - bind
- inbound project resolution from channel/thread context
- basic membership gate before agent-loop entry
- project-aware session metadata
- project-aware command context
- project-aware audit fields

Key files:
- [src/projects/types.ts](../src/projects/types.ts)
- [src/projects/registry.ts](../src/projects/registry.ts)
- [src/projects/memberships.ts](../src/projects/memberships.ts)
- [src/projects/bindings.ts](../src/projects/bindings.ts)
- [src/projects/access.ts](../src/projects/access.ts)
- [src/projects/bootstrap.ts](../src/projects/bootstrap.ts)
- [src/cli/projects.ts](../src/cli/projects.ts)
- [src/index.ts](../src/index.ts)
- [src/commands/registry.ts](../src/commands/registry.ts)
- [src/core/audit.ts](../src/core/audit.ts)

Runtime consequences:
- a collaborative channel or thread can resolve to a stable `projectId`
- non-members can be denied before session execution
- new sessions can carry:
  - `projectId`
  - `projectSlug`
  - `projectRole`
- `/whoami` can report current project context
- audit records can attribute events to a project

Current limits after Phase 4:
- tool authorization is still not project-scoped
- memory visibility is still not split into shared vs private per project
- shared sessions are still local-runtime sessions with project metadata, not the later full shared-session model

## What Phase 5 Depends On

Phase 5 can now build on:
- installation-local homes
- explicit node identity
- stable principal identity
- local project and membership state
- project-aware session metadata
- project-aware audit context

## Phase 5 Summary

Phase 5 introduced a canonical runtime execution context.

Delivered:
- `ExecutionContext` as the shared runtime identity/project envelope
- adapters for:
  - session metadata
  - command context
  - audit context
- shared ingress wiring so regular messages, slash commands, and Telegram command paths build the same context shape
- tool runtime access to `executionContext`
- prompt builder access to `executionContext`
- session-local runtime context attachment with persistence-safe stripping

Key files:
- [src/core/execution-context.ts](../src/core/execution-context.ts)
- [src/index.ts](../src/index.ts)
- [src/core/agent-loop.ts](../src/core/agent-loop.ts)
- [src/gateway/session.ts](../src/gateway/session.ts)
- [src/commands/registry.ts](../src/commands/registry.ts)
- [src/tools/tool.ts](../src/tools/tool.ts)
- [src/core/prompt.ts](../src/core/prompt.ts)

Runtime consequences:
- ingress now builds identity and project context once per interaction
- sessions, commands, audit, prompts, and tools consume the same context contract
- `authorId` and `platformUserId` remain available only as compatibility-era fields

Current limits after Phase 5:
- tool authorization is still not project-scoped
- memory visibility is still not split into shared vs private per project
- shared sessions are still the later missing layer

## What Phase 6 Depends On

Phase 6 can now build on:
- installation-local homes
- explicit node identity
- stable principal identity
- local project and membership state
- canonical execution context across ingress, sessions, commands, tools, and prompts

## Phase 6 Summary

Phase 6 introduced local shared-session state on the edge.

Delivered:
- persistent shared-session registry under `<home>/shared-sessions/shared-sessions.json`
- `SharedSession` records for project-bound local sessions
- participant and active-participant tracking
- shared-session CLI inspection surface
- execution context support for:
  - `sharedSessionId`
  - `ownerPrincipalId`
  - `participantIds`
  - `activeParticipantIds`
- command and audit surfaces that can inspect shared-session state

Key files:
- [src/sessions/shared.ts](../src/sessions/shared.ts)
- [src/cli/shared-sessions.ts](../src/cli/shared-sessions.ts)
- [src/index.ts](../src/index.ts)
- [src/core/execution-context.ts](../src/core/execution-context.ts)
- [src/commands/registry.ts](../src/commands/registry.ts)
- [src/core/audit.ts](../src/core/audit.ts)
- [src/core/paths.ts](../src/core/paths.ts)

Runtime consequences:
- a project-bound local session now has a stable shared-session record
- second and later principals joining the same bound project channel can be tracked as session participants
- one local edge can now host collaboration in:
  - a bound Discord channel or thread
  - a bound Telegram group or topic
- `/whoami` can report shared-session identity and participant count
- audit trails can distinguish shared-session activity from solo activity

Current limits after Phase 6:
- replies still stay within the same local channel/thread
- shared/private project memory visibility is still deferred
- project-scoped tool authorization is still deferred
- cross-edge shared-session routing is still not implemented
- separately owned remote Takos still cannot join the same Discord/TG collaboration as invited network agents

## What Phase 7 Depends On

Phase 7 can now build on:
- installation-local homes
- explicit node identity
- stable principal identity
- local project and membership state
- canonical execution context
- participant-aware local shared sessions

## Phase 7 Summary

Phase 7 introduced scoped project memory on the local edge.

Delivered:
- scoped memory resolution in [src/memory/scopes.ts](../src/memory/scopes.ts)
- scope-aware memory tools in [src/tools/memory.ts](../src/tools/memory.ts)
- prompt loading that only sees visible scopes in [src/core/prompt.ts](../src/core/prompt.ts)
- project bootstrap memory layout updates in [src/projects/bootstrap.ts](../src/projects/bootstrap.ts)
- memory inspection support in [src/cli/memory.ts](../src/cli/memory.ts)

Memory layout:
```text
<home>/memory/global/private/
<home>/projects/<projectId>/memory/
  shared/
  private/<principalId>/
```

Runtime behavior:
- solo or unbound contexts continue to use `global-private`
- project contexts can read:
  - `project-shared`
  - caller `project-private`
- project contexts cannot read another participant's `project-private` by default
- memory writes default to:
  - `global-private` outside projects
  - `project-private` inside projects
- explicit `project-shared` writes are allowed only in project context

Current limits after Phase 7:
- scoped memory is currently enforced in prompt loading and memory tools, not yet every future memory consumer
- project-scoped tool authorization is still deferred
- cross-edge memory exchange is still not implemented
- invited remote-agent memory participation is still later network work

Important boundary:
- Phase 7 is still local-edge collaboration work
- true invited remote-agent participation belongs later in:
  - Phase 11: Pairing And Invitations
  - Phase 12: Network Shared Sessions

## Phase 8 Summary

Phase 8 introduced project-scoped tool enforcement on the local edge.

Delivered:
- project root resolution in [src/projects/root.ts](../src/projects/root.ts)
- per-project workspace bootstrapping in [src/projects/bootstrap.ts](../src/projects/bootstrap.ts)
- project root CLI management in [src/cli/projects.ts](../src/cli/projects.ts)
- execution context fields for:
  - `workspaceRoot`
  - `projectRoot`
  - `allowedToolRoot`
- allowed-root enforcement in:
  - [src/tools/fs.ts](../src/tools/fs.ts)
  - [src/tools/search.ts](../src/tools/search.ts)
  - [src/tools/git.ts](../src/tools/git.ts)
  - [src/tools/exec.ts](../src/tools/exec.ts)
- denial logging through failed `tool_call` plus `permission_denied` audit records

Runtime behavior:
- solo and unbound contexts keep using the local workspace root
- project-bound contexts resolve an effective project root and use it as the only allowed tool root
- relative tool paths resolve from that allowed root
- absolute paths and `cwd` overrides are denied if they escape that root

Current limits after Phase 8:
- this is still logical root enforcement inside the current runtime, not OS-level sandboxing
- networked invited-agent tool enforcement is still later work
- org-level or hub-distributed policy is still later work

## Phase 9 Summary

Phase 9 introduced the first real hub control plane.

Delivered:
- persistent hub registry state under `<home>/registry`
- node registry and heartbeat-based presence
- project summary and membership summary storage
- route lookup by project ID and slug
- hub HTTP endpoints for:
  - health
  - status
  - identity
  - nodes
  - projects
  - routes
  - node registration
  - heartbeat
  - project registration
  - membership summary updates
- local hub CLI inspection commands
- a minimal [edge-client.ts](../src/network/edge-client.ts) seam for later edge-hub protocol work

Important boundary:
- the hub is still infra-only
- it does not load providers
- it does not run the agent loop
- it does not own edge-private memory or tool execution

Current limits after Phase 9:
- edge authentication and trust handshake are still not implemented on the wire
- invitations and pairing are still not network-routed yet
- cross-edge shared-session routing is still not implemented
- remote delegation is still not implemented

## Phase 10 Summary

Phase 10 turned the hub protocol seam into live edge-hub sync.

Delivered:
- startup edge registration when `network.hub` is configured
- periodic heartbeat from edge to hub
- project summary sync from edge to hub
- membership summary sync from edge to hub
- route lookup support in [edge-client.ts](../src/network/edge-client.ts)
- reusable sync helpers in [sync.ts](../src/network/sync.ts)
- project CLI mutations now update the hub summary state
- normalized hub URL handling in config resolution

Important boundary:
- this is still control-plane sync
- it is not yet invitations
- it is not yet remote shared-session routing
- it is not yet remote agent delegation

Current limits after Phase 10:
- trust handshake is still not implemented on the wire
- pairing and invitations are the next phase after control-plane sync
- cross-edge shared sessions are still Phase 12
- remote delegation is still Phase 13

## Phase 11 Summary

Phase 11 added local-first pairing and invitation state on the edge.

Delivered:
- persistent trust records in [trust.ts](../src/network/trust.ts)
- persistent invite records in [invites.ts](../src/network/invites.ts)
- authority ceiling checks in [authority.ts](../src/network/authority.ts)
- network CLI in [network.ts](../src/cli/network.ts)
- centralized network path roots in [paths.ts](../src/core/paths.ts)
- invite import flow so one edge can accept an invite created on another home

What works now:
- a hosting edge can issue a project invite
- the invited edge can import that invite locally
- the invited edge can accept or reject it
- accepted invites create a durable trusted relationship with an explicit authority ceiling
- revoked trust is persisted locally

Important boundary:
- this is still local-first pairing state
- it is not yet hub-mediated invite delivery
- it is not yet cross-edge shared-session execution
- it is not yet remote delegation

Current limits after Phase 11:
- invites still move between homes via explicit import, not live network delivery
- accepted trust does not yet create shared cross-edge sessions
- the hub does not yet coordinate invite lifecycle
- Phase 12 is still required for network shared sessions

## Phase 12 Summary

Phase 12 added the first real network shared-session path.

Delivered:
- edge-side network session persistence in [shared-sessions.ts](../src/network/shared-sessions.ts)
- session sync helpers in [session-sync.ts](../src/network/session-sync.ts)
- hub relay persistence in [relay.ts](../src/hub/relay.ts)
- hub relay endpoints in [routes.ts](../src/hub/routes.ts)
- edge client relay methods in [edge-client.ts](../src/network/edge-client.ts)
- edge runtime polling and outbound relay wiring in [index.ts](../src/index.ts)
- network session CLI commands through [network.ts](../src/cli/network.ts)

What works now:
- an edge can register a network session for a project
- the hub can persist that session and queue outbound events for remote nodes
- an edge can send a network session event through the hub
- another edge can poll, persist, ack, and locally attach that event
- local session metadata now carries network session identity when bound

Important boundary:
- this is still relay-based session transport
- it does not yet implement remote delegation
- it does not yet merge private memory across edges
- selective audience policy is still basic session-participant routing

Current limits after Phase 12:
- live invite delivery is still not hub-mediated
- remote tool execution is still out of scope
- richer ordering and conflict semantics are still thin
- Phase 13 is still required for delegation and bounded remote work

## Phase 13 Summary

Phase 13 added bounded remote delegation on top of the Phase 12 relay path.

Delivered:
- explicit delegation capability registry in [capabilities.ts](../src/network/capabilities.ts)
- delegation request and result persistence in [delegation.ts](../src/network/delegation.ts)
- local receiving-edge policy evaluation in [delegation-policy.ts](../src/network/delegation-policy.ts)
- bounded local execution handlers in [delegation-executor.ts](../src/network/delegation-executor.ts)
- runtime handling for inbound delegation requests and returned results in [index.ts](../src/index.ts)
- network CLI controls in [network.ts](../src/cli/network.ts)

What works now:
- one trusted edge can send a delegation request to another edge through the existing network session relay
- the receiving edge evaluates trust, ceiling, capability exposure, and local project presence before execution
- approved requests execute locally on the receiving edge within its existing Phase 8 project/tool boundaries
- structured delegation results return to the requesting edge and persist locally
- operators can inspect capabilities, requests, and results through the CLI

Important boundary:
- this is not raw remote shell access
- delegation is capability-based and locally enforced
- each edge still owns its own tools, private memory, and execution policy
- central shared filesystem is still not part of the architecture

Current limits after Phase 13:
- capabilities are still a fixed bounded set, not arbitrary remote tool calls
- live invite delivery is still not hub-mediated
- private memory remains edge-local and is not merged across nodes
- richer conflict resolution and selective audience controls are still future work

## Phase 14 Summary

Phase 14 hardened the operator surface around the collaboration model.

Delivered:
- JSON-capable and more informative CLI status surfaces in:
  - [network.ts](../src/cli/network.ts)
  - [hub.ts](../src/cli/hub.ts)
  - [projects.ts](../src/cli/projects.ts)
  - [commands.ts](../src/daemon/commands.ts)
- richer edge status with project, shared-session, network-session, trust, and invite counts
- richer hub status with relay session and queued relay event counts
- doctor checks for invalid `network.hub` values and unusable project roots in:
  - [config.ts](../src/doctor/checks/config.ts)
  - [permissions.ts](../src/doctor/checks/permissions.ts)
- updated product-facing docs in:
  - [README.md](../README.md)
  - [getting-started-solo.md](../docs/getting-started-solo.md)
  - [getting-started-local-collab.md](../docs/getting-started-local-collab.md)
  - [getting-started-network-collab.md](../docs/getting-started-network-collab.md)
  - [troubleshooting.md](../docs/troubleshooting.md)
  - [release-boundary.md](../docs/release-boundary.md)
  - [qa-phase14.md](../docs/qa-phase14.md)

What this changes operationally:
- one technically competent user can now stand up a hub and multiple edges on one server without reading source code
- the CLI can be scripted with `--json` in the main operator paths
- common collaboration failures are easier to diagnose from built-in commands
- the supported deployment model is documented explicitly instead of being implicit in the code

Important boundary:
- Phase 14 does not add a new transport or a central filesystem
- it hardens the existing architecture instead of changing it

## Phase 15 Summary

Phase 15 adds the filesystem model needed for “shared project plus private agent worktree”.

Delivered:
- shared project artifact records in [artifacts.ts](../src/projects/artifacts.ts)
- per-edge worktree records in [worktrees.ts](../src/projects/worktrees.ts)
- project path helpers for shared artifact roots and per-node worktree roots in [root.ts](../src/projects/root.ts)
- project bootstrap now creates artifact and worktree layout in [bootstrap.ts](../src/projects/bootstrap.ts)
- project CLI support in [projects.ts](../src/cli/projects.ts) for:
  - publishing shared artifacts
  - listing and inspecting artifacts
  - registering per-node worktrees
  - reporting workspace status

What this changes:
- a project can now hold explicit shared files without turning the architecture into a central shared disk
- each invited edge can register its own project worktree independently
- the collaboration model is now:
  - shared project artifacts
  - shared project session
  - private per-edge worktrees
  - private per-edge machine authority

Important boundary:
- this phase defines the structure and operator surface
- it does not yet add automatic artifact sync or merge semantics across edges
- shared artifacts remain explicit publications into project state, not remote filesystem ownership

## Phase 16 Summary

Phase 16 turns the shared-project filesystem model into an actual collaboration path across trusted edges.

Delivered:
- artifact envelope export/import in [distribution.ts](../src/projects/distribution.ts)
- patch creation and application helpers in [patches.ts](../src/projects/patches.ts)
- artifact relay support over network sessions in [shared-sessions.ts](../src/network/shared-sessions.ts)
- project CLI support in [projects.ts](../src/cli/projects.ts) for:
  - syncing existing shared artifacts to trusted participant edges
  - creating patch artifacts from registered worktrees
  - applying patch artifacts into registered worktrees
- Discord thread-aware project resolution and Discord notifications for:
  - relayed project messages
  - synced artifacts
  - delegation results

What this changes:
- shared project files can now move between trusted edges through the existing network-session relay
- each edge still owns its own worktree and chooses locally when to apply a patch
- Discord project channels become a clearer human-facing surface for network collaboration state

Important boundary:
- this is still explicit artifact publication and explicit patch application
- it is not a central shared filesystem
- it is not automatic merge/conflict resolution
- it is not unrestricted remote repo ownership

## Phase 17 Summary

Phase 17 adds participant-aware project background refresh, automatic artifact-sync policy, patch approval workflow, and branch coordination on top of the shared-project model.

Delivered:
- collaboration policy fields on [types.ts](../src/projects/types.ts) for:
  - `autoArtifactSync`
  - `patchRequiresApproval`
  - `announceJoins`
- persistent project background snapshots in [background.ts](../src/projects/background.ts)
- persistent patch approval records in [approvals.ts](../src/projects/approvals.ts)
- persistent per-node branch records in [branches.ts](../src/projects/branches.ts)
- expanded project CLI support in [projects.ts](../src/cli/projects.ts) for:
  - project collaboration policy inspection and updates
  - patch approval and denial
  - branch registration and listing
  - background inspection
- network-session collaboration policy in [shared-sessions.ts](../src/network/shared-sessions.ts) and [session-sync.ts](../src/network/session-sync.ts)
- Discord-facing project commands in [registry.ts](../src/commands/registry.ts):
  - `/projectbg`
  - `/patches`
  - `/patchapprove`
  - `/patchdeny`
- runtime join/background wiring in [index.ts](../src/index.ts) and prompt injection in [agent-loop.ts](../src/core/agent-loop.ts)

What this changes:
- when a new local participant joins a shared project session, the edge rebuilds a project-visible background snapshot
- that snapshot can be announced into bound Discord project channels and injected into the agent loop as shared project background
- projects and network sessions can now opt into automatic artifact sync instead of requiring every artifact push to be explicitly flagged
- patch artifacts can require approval before local application
- branch coordination is now explicit per edge instead of being hidden in local git state

Important boundary:
- project background refresh is built from project-visible state only:
  - shared artifacts
  - shared session participants
  - per-edge worktree branch and dirty status
- it does not expose another participant's private memory
- it does not expose another edge's private filesystem
- Discord patch review uses command-driven approval, not interactive button UI
- automatic artifact sync still relies on trusted network sessions and explicit project/session policy, not global replication

## Phase 18 Summary

Phase 18 closes the loop for multi-edge collaboration by making remote joins explicit, adding Discord button approvals, and persisting conflict state for concurrent branch or patch changes.

Delivered:
- explicit network-side join event usage in [session-sync.ts](../src/network/session-sync.ts), [shared-sessions.ts](../src/network/shared-sessions.ts), [network.ts](../src/cli/network.ts), and [index.ts](../src/index.ts)
- Discord button-based patch review prompts in [discord.ts](../src/channels/discord.ts)
- runtime button handling for patch approval and denial in [index.ts](../src/index.ts)
- conflict-aware patch approval and branch state in:
  - [types.ts](../src/projects/types.ts)
  - [approvals.ts](../src/projects/approvals.ts)
  - [branches.ts](../src/projects/branches.ts)
  - [projects.ts](../src/cli/projects.ts)

What this changes:
- remote node joins and remote principal joins now travel as explicit network events instead of being inferred only from later messages
- those join events trigger the same background-refresh path as local joins, so Discord-bound project channels see the refreshed shared project context immediately
- incoming patch approvals in Discord can now be resolved with buttons as well as slash/text commands
- failed patch applies can now be recorded as conflict state tied to both the patch approval record and the affected branch record

Important boundary:
- join events refresh project-visible background, not private edge state
- button-based patch review is still built on the same approval records; it is a UI layer, not a second workflow
- conflict state is descriptive and auditable; it does not attempt automatic merge resolution

## Verification Status

Current verification for the implemented design:
- `npm run typecheck`
- `npm run build`
- `npm test`

Latest verified suite result at the time of writing:
- `484 pass, 0 fail`
