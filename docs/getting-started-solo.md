# Solo Edge

Use this mode when one user owns one Tako edge and does not need hub networking.

## Start

```bash
bun run src/index.ts onboard --home /tmp/tako-edge-main
bun run src/index.ts start --home /tmp/tako-edge-main --port 18801
```

After the first foreground verification, the normal server-style command is:

```bash
bun run src/index.ts start --home /tmp/tako-edge-main --port 18801 -d
```

Recommended checks:

```bash
bun run src/index.ts status --home /tmp/tako-edge-main --json
bun run src/index.ts doctor --home /tmp/tako-edge-main
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
bun run src/index.ts projects list --home /tmp/tako-edge-main --json
bun run src/index.ts principals list --home /tmp/tako-edge-main
bun run src/index.ts memory search "query" --home /tmp/tako-edge-main
```
