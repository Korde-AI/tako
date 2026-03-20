# Local Collaborative Edge

Use this mode when multiple humans share one edge through Discord or Telegram.

Development-first rule:
- use `bun run src/index.ts ...` from the repo checkout
- do not start with `tako start` for this workflow

## Start

```bash
bun run src/index.ts onboard --home /tmp/tako-discord/edge-main
bun run src/index.ts start --home /tmp/tako-discord/edge-main --port 18801
```

## Create a project

```bash
bun run src/index.ts projects create alpha --owner <principalId> --name "Project Alpha" --home /tmp/tako-discord/edge-main
bun run src/index.ts projects add-member alpha <principalId> --role contribute --added-by <ownerPrincipalId> --home /tmp/tako-discord/edge-main
```

## Bind a Discord or Telegram surface

Discord channel:

```bash
bun run src/index.ts projects bind alpha --platform discord --target <channelId> --home /tmp/tako-discord/edge-main
```

Telegram group or topic:

```bash
bun run src/index.ts projects bind alpha --platform telegram --target <chatId> --thread <topicId> --home /tmp/tako-discord/edge-main
```

## What this mode supports

- multiple humans on one edge
- project memberships
- shared local sessions
- project-shared memory plus per-principal private project memory
- project-root tool isolation

## Important limit

This is still one edge. It is not yet “multiple user-owned edges collaborating” until you add a hub and trust flows.
