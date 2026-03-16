# Network Collaboration

Use this mode when each collaborator brings their own edge and a hub coordinates routes and relay.

## Single-server test layout

```bash
tako hub start --home /srv/tako/hub --port 18790
tako start --home /srv/tako/edge-alice --port 18801
tako start --home /srv/tako/edge-bob --port 18802
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
tako network status --home /srv/tako/edge-alice
tako hub status --home /srv/tako/hub
tako hub nodes --home /srv/tako/hub
```

## Pair and invite

On the hosting edge:

```bash
tako network invite create alpha --issued-by <principalId> --target-node <remoteNodeId> --home /srv/tako/edge-alice
```

Move the invite JSON to the invited edge, then:

```bash
tako network invite import ./invite.json --home /srv/tako/edge-bob
tako network invite accept <inviteId> --home /srv/tako/edge-bob
```

## Register a network session

```bash
tako network sessions register alpha --nodes <bobNodeId> --home /srv/tako/edge-alice
```

## Delegate bounded work

```bash
tako network delegate alpha --to <bobNodeId> --capability summarize_workspace --home /srv/tako/edge-alice
```

## Current limits

- no central shared filesystem
- no unrestricted remote shell
- live invite delivery is still local-first, not hub-delivered
- each edge keeps its own private memory and local tool policy
