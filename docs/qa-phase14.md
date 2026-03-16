# Phase 14 QA

## Required manual scenarios

1. Solo edge boots and serves CLI or channel traffic.
2. Local Discord collaborative project works on one edge.
3. Local Telegram collaborative project works on one edge.
4. Hub boots and edge registration appears in hub status.
5. Project create, bind, add-member, and set-root all work.
6. Invite create, import, accept, and reject all work.
7. Network session register, relay, poll, and ack all work.
8. Delegation request produces a structured result.
9. Project-root boundary denies escaped file or exec access.
10. Revoked trust blocks later delegation.
11. Disabled capability blocks delegation.
12. Offline target edge receives relayed events after later poll.

## Release verification commands

```bash
npm run typecheck
npm run build
npm test
```

## Recommended operator checks

```bash
tako status --home <edgeHome> --json
tako network status --home <edgeHome> --json
tako hub status --home <hubHome> --json
tako doctor --home <edgeHome>
```
