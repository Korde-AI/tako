# Solo Edge

Use this mode when one user owns one Tako edge and does not need hub networking.

## Start

```bash
tako onboard --home ~/.tako-edge-main
tako start --home ~/.tako-edge-main
```

Recommended checks:

```bash
tako status --home ~/.tako-edge-main --json
tako doctor --home ~/.tako-edge-main
```

## What this mode supports

- CLI use
- Discord or Telegram bot use
- local sessions
- local memory
- local tools rooted to the edge workspace

## What this mode does not need

- hub
- trust records
- invites
- network sessions
- remote delegation

## Typical commands

```bash
tako projects list --home ~/.tako-edge-main --json
tako principals list --home ~/.tako-edge-main
tako memory search "query" --home ~/.tako-edge-main
```
