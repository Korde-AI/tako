# Network Collaboration

Use this mode when each collaborator brings their own edge and a hub coordinates routes and relay.

Development-first rule:
- use `bun run src/index.ts ...` from the repo checkout
- do not start with `tako start` for this workflow

## Single-server test layout

```bash
bun run src/index.ts hub start --home /tmp/tako-discord/hub --port 18790
bun run src/index.ts start --home /tmp/tako-discord/edge-alice --port 18801
bun run src/index.ts start --home /tmp/tako-discord/edge-bob --port 18802
```

One server is enough for development if each instance has:
- its own `--home`
- its own port
- its own config and env

## Configure edges to use the hub

Set `network.hub` in each edge home:

```json
{
  "network": {
    "hub": "http://127.0.0.1:18790"
  }
}
```

## Verify control-plane sync

```bash
bun run src/index.ts network status --home /tmp/tako-discord/edge-alice
bun run src/index.ts hub status --home /tmp/tako-discord/hub
bun run src/index.ts hub nodes --home /tmp/tako-discord/hub
```

## Pair and invite

On the hosting edge:

```bash
bun run src/index.ts network invite create alpha --issued-by <principalId> --target-node <remoteNodeId> --home /tmp/tako-discord/edge-alice
```

Move the invite JSON to the invited edge, then:

```bash
bun run src/index.ts network invite import ./invite.json --home /tmp/tako-discord/edge-bob
bun run src/index.ts network invite accept <inviteId> --home /tmp/tako-discord/edge-bob
```

## Register a network session

```bash
bun run src/index.ts network sessions register alpha --nodes <bobNodeId> --home /tmp/tako-discord/edge-alice
```

## Delegate bounded work

```bash
bun run src/index.ts network delegate alpha --to <bobNodeId> --capability summarize_workspace --home /tmp/tako-discord/edge-alice
```

## Current limits

- no central shared filesystem
- no unrestricted remote shell
- live invite delivery is still local-first, not hub-delivered
- each edge keeps its own private memory and local tool policy
