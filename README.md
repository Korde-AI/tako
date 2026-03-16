# Tako

Tako is a multi-user collaboration runtime built around personal `edge` agents and an optional coordination `hub`.

The current model is:
- each user can run their own edge
- each edge keeps its own provider credentials, private memory, tools, files, and local execution policy
- projects, sessions, trust, routing, and relay can be coordinated across edges
- the hub is control plane only; it does not run the LLM or own private edge state

## Runtime modes

### Edge
Use an edge when you want a real agent runtime.

An edge can run:
- solo
- as one shared local collaboration bot on Discord or Telegram
- as part of a networked multi-edge collaboration setup through a hub

Examples:

```bash
tako start --home ~/.tako-edge-main
tako start --home ~/.tako-edge-alice --hub http://127.0.0.1:18790
```

### Hub
Use a hub when you want node registration, project routing, relay, and audit aggregation.

The hub does:
- node registry
- project registry summaries
- session relay
- route lookup
- presence

The hub does not:
- run prompts
- execute tools
- own private edge memory by default

Example:

```bash
tako hub start --home ~/.tako-hub --port 18790
```

## What works now

### Solo edge
- local sessions
- local memory
- local tools
- CLI and TUI usage

### Shared local collaboration on one edge
- multiple humans on one Discord channel/thread or Telegram group/topic
- project membership and access gating
- shared local sessions
- shared and private project memory scopes
- project-scoped tool roots

### Network collaboration across multiple edges
- hub registration and heartbeat
- project and membership summaries
- trust and invite lifecycle
- network sessions with relay
- bounded remote delegation
- shared project artifacts
- per-edge worktrees
- patch review and approval flow

## Important boundaries

Tako is not built around a central shared filesystem.

The intended model is:
- shared project state
- explicit shared artifacts
- per-edge private worktrees
- per-edge private machine authority
- bounded delegation instead of unrestricted remote execution

That means:
- one agent can join your project without gaining raw ownership of your machine
- shared files are published into project state, not mounted as a central mutable disk
- each edge still acts as a personal assistant for its own owner outside shared project scope

## Quick start

### From source

```bash
git clone https://github.com/Korde-AI/tako.git
cd tako
npm install
npm run build
```

### Start a solo edge

```bash
tako onboard --home ~/.tako-edge-main
tako start --home ~/.tako-edge-main
```

### Start a hub and two edges on one server

```bash
tako hub start --home /srv/tako/hub --port 18790
tako start --home /srv/tako/edge-a --port 18801
tako start --home /srv/tako/edge-b --port 18802
```

### Operator checks

```bash
tako status --home ~/.tako-edge-main --json
tako network status --home ~/.tako-edge-main --json
tako hub status --home ~/.tako-hub --json
tako doctor --home ~/.tako-edge-main
```

## Main CLI surfaces

```bash
tako start
tako status
tako tui
tako doctor

tako principals list --home <edgeHome>
tako projects list --home <edgeHome>
tako shared-sessions list --home <edgeHome>
tako network status --home <edgeHome>
tako hub status --home <hubHome>
```

## Project workflow

Typical collaboration flow:

1. create a project on a hosting edge
2. add memberships or invite another edge
3. bind a Discord channel/thread or Telegram group/topic if needed
4. create or reuse a shared session
5. publish artifacts or patches into project state
6. approve and apply patches locally per edge
7. use bounded delegation when one edge needs another edge to do work locally

## Docs

Use these entry points instead of relying on older docs that still describe the pre-edge/pre-hub layout:

- [Solo edge guide](docs/getting-started-solo.md)
- [Local collaboration guide](docs/getting-started-local-collab.md)
- [Network collaboration guide](docs/getting-started-network-collab.md)
- [Troubleshooting](docs/troubleshooting.md)
- [Release boundary](docs/release-boundary.md)
- [Collaboration design](docs/collaboration-network.md)
- [Phase 14 QA checklist](docs/qa-phase14.md)

## Current verification

Latest verified checks:
- `npm run typecheck`
- `npm run build`
- `npm test`

Latest verified suite result:
- `484 pass, 0 fail`

## Notes before push or deploy

- `main` currently contains the collaboration-network implementation and follow-up cleanup commits
- if you deploy multiple nodes on one machine, always give each one a distinct `--home`
- if you use Discord or Telegram, treat tokens as secrets and keep them out of git
- for a single-server multi-edge test, use the tmux harness in `scripts/tmux-single-server-test.sh`
