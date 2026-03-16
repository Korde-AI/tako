# Local Collaborative Edge

Use this mode when multiple humans share one edge through Discord or Telegram.

## Start

```bash
tako onboard --home ~/.tako-edge-main
tako start --home ~/.tako-edge-main
```

## Create a project

```bash
tako projects create alpha --owner <principalId> --name "Project Alpha" --home ~/.tako-edge-main
tako projects add-member alpha <principalId> --role contribute --added-by <ownerPrincipalId> --home ~/.tako-edge-main
```

## Bind a Discord or Telegram surface

Discord channel:

```bash
tako projects bind alpha --platform discord --target <channelId> --home ~/.tako-edge-main
```

Telegram group or topic:

```bash
tako projects bind alpha --platform telegram --target <chatId> --thread <topicId> --home ~/.tako-edge-main
```

## What this mode supports

- multiple humans on one edge
- project memberships
- shared local sessions
- project-shared memory plus per-principal private project memory
- project-root tool isolation

## Important limit

This is still one edge. It is not yet “multiple user-owned edges collaborating” until you add a hub and trust flows.
