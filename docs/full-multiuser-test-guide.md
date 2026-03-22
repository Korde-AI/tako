# Full Tako Multi-User And Multi-Agent Test Guide

Use this guide to test the full Tako collaboration model on a single server without Discord, Telegram, or a real LLM endpoint.

## Target

You will run:
- `1 hub`
- `2 edges`
- `2 users/principals`
- `1 shared project`
- `1 invite`
- `1 network session`
- `1 delegated task`
- shared artifacts and per-edge worktrees

## Best Starting Point

Use the built harness first:
- `scripts/tmux-single-server-test.sh`
- `scripts/run-single-server-flow.sh`

## 1. Preconditions

From the repo root:

```bash
cd /home/shuyhere/projects/tako
npm install
npm run build
npm test
```

If you want the already-verified path, use a fresh temp dir:

```bash
/tmp/tako-full-check
```

## 2. Fastest Full Test

Run:

```bash
cd /home/shuyhere/projects/tako
./scripts/tmux-single-server-test.sh /tmp/tako-full-check
```

Attach:

```bash
tmux attach -t tako-single-server
```

You should see windows:
- `hub`
- `status`
- `edge-a`
- `edge-b`
- `admin`

When the flow completes, read:
- `/tmp/tako-full-check/report.md`

That is the shortest path.

## 3. What This Harness Actually Tests

It verifies:
1. hub startup
2. edge startup
3. principal creation
4. project creation
5. invite create/import/accept
6. trust establishment
7. network session registration
8. background collaboration state
9. bounded delegation
10. result return path

It does not require:
- Discord
- Telegram
- a real LLM endpoint

## 4. Manual Full Test, Step by Step

If you want to understand the whole system, run it manually.

### 4.1 Create homes

```bash
mkdir -p /tmp/tako-manual/hub
mkdir -p /tmp/tako-manual/edge-a
mkdir -p /tmp/tako-manual/edge-b
```

### 4.2 Start hub

```bash
cd /home/shuyhere/projects/tako
bun run src/index.ts hub start --home /tmp/tako-manual/hub --port 18790
```

In another shell, verify:

```bash
bun run src/index.ts hub status --home /tmp/tako-manual/hub --json
```

### 4.3 Start edge A

```bash
cd /home/shuyhere/projects/tako
bun run src/index.ts start --home /tmp/tako-manual/edge-a --port 18801
```

### 4.4 Start edge B

```bash
cd /home/shuyhere/projects/tako
bun run src/index.ts start --home /tmp/tako-manual/edge-b --port 18802
```

### 4.5 Create local principals

Use the helper if you want a deterministic setup:
- `scripts/seed-principal.ts`

Example:

```bash
bun run scripts/seed-principal.ts /tmp/tako-manual/edge-a alice
bun run scripts/seed-principal.ts /tmp/tako-manual/edge-b bob
```

Then inspect:

```bash
bun run src/index.ts principals list --home /tmp/tako-manual/edge-a
bun run src/index.ts principals list --home /tmp/tako-manual/edge-b
```

Save:
- `EDGE_A_PRINCIPAL_ID`
- `EDGE_B_PRINCIPAL_ID`

### 4.6 Create project on edge A

```bash
bun run src/index.ts projects create alpha \
  --owner <EDGE_A_PRINCIPAL_ID> \
  --name "Alpha" \
  --home /tmp/tako-manual/edge-a
```

Verify:

```bash
bun run src/index.ts projects show alpha --home /tmp/tako-manual/edge-a --json
```

### 4.7 Register worktrees

```bash
bun run src/index.ts projects worktree-register alpha \
  --root /tmp/tako-manual/edge-a/workspace \
  --home /tmp/tako-manual/edge-a

bun run src/index.ts projects worktree-register alpha \
  --root /tmp/tako-manual/edge-b/workspace \
  --home /tmp/tako-manual/edge-b
```

Check:

```bash
bun run src/index.ts projects worktrees alpha --home /tmp/tako-manual/edge-a
bun run src/index.ts projects worktrees alpha --home /tmp/tako-manual/edge-b
```

### 4.8 Create invite from edge A

First get edge B node ID:

```bash
bun run src/index.ts status --home /tmp/tako-manual/edge-b --json
```

Then:

```bash
bun run src/index.ts network invite create alpha \
  --issued-by <EDGE_A_PRINCIPAL_ID> \
  --target-node <EDGE_B_NODE_ID> \
  --role contribute \
  --home /tmp/tako-manual/edge-a \
  --json > /tmp/tako-manual/invite.json
```

### 4.9 Import and accept on edge B

```bash
bun run src/index.ts network invite import /tmp/tako-manual/invite.json \
  --home /tmp/tako-manual/edge-b

bun run src/index.ts network invite list --home /tmp/tako-manual/edge-b --json
```

Accept:

```bash
bun run src/index.ts network invite accept <INVITE_ID> \
  --home /tmp/tako-manual/edge-b
```

Check trust:

```bash
bun run src/index.ts network trust list --home /tmp/tako-manual/edge-a --json
bun run src/index.ts network trust list --home /tmp/tako-manual/edge-b --json
```

## 5. Create Network Session

From edge A:

```bash
bun run src/index.ts network sessions register alpha \
  --nodes <EDGE_B_NODE_ID> \
  --home /tmp/tako-manual/edge-a \
  --json
```

Check:

```bash
bun run src/index.ts network sessions list --home /tmp/tako-manual/edge-a --json
bun run src/index.ts hub status --home /tmp/tako-manual/hub --json
```

## 6. Test Shared Artifacts

Create a file in edge A's worktree:

```bash
echo "shared test file" > /tmp/tako-manual/edge-a/workspace/demo.txt
```

Publish it:

```bash
bun run src/index.ts projects artifact-publish alpha \
  --from /tmp/tako-manual/edge-a/workspace/demo.txt \
  --published-by <EDGE_A_PRINCIPAL_ID> \
  --home /tmp/tako-manual/edge-a
```

List artifacts:

```bash
bun run src/index.ts projects artifacts alpha --home /tmp/tako-manual/edge-a
```

Sync artifact:

```bash
bun run src/index.ts projects artifact-sync alpha <ARTIFACT_ID> \
  --to <EDGE_B_NODE_ID> \
  --home /tmp/tako-manual/edge-a
```

Then inspect on edge B:

```bash
bun run src/index.ts projects artifacts alpha --home /tmp/tako-manual/edge-b
```

## 7. Test Patch Workflow

In edge A worktree:

```bash
cd /tmp/tako-manual/edge-a/workspace
git init
git add .
git commit -m "init"
echo "change from edge a" >> demo.txt
```

Create patch artifact:

```bash
bun run src/index.ts projects patch-create alpha \
  --published-by <EDGE_A_PRINCIPAL_ID> \
  --home /tmp/tako-manual/edge-a
```

List patch approvals or patches:

```bash
bun run src/index.ts projects patches alpha --home /tmp/tako-manual/edge-b
```

If approval is required:

```bash
bun run src/index.ts projects patch-approve alpha <APPROVAL_ID> \
  --home /tmp/tako-manual/edge-b
```

Apply:

```bash
bun run src/index.ts projects patch-apply alpha <ARTIFACT_ID> \
  --home /tmp/tako-manual/edge-b
```

## 8. Test Background Refresh On Join

After edge B joins, inspect project background:

```bash
bun run src/index.ts projects background alpha --home /tmp/tako-manual/edge-a
bun run src/index.ts projects background alpha --home /tmp/tako-manual/edge-b
```

You should see shared-safe context:
- project summary
- recent artifacts
- participant/session context

## 9. Test Delegation

Use a bounded capability that does not need a real model.

List capabilities:

```bash
bun run src/index.ts network capabilities list --home /tmp/tako-manual/edge-b
```

Send request from edge A to edge B:

```bash
bun run src/index.ts network delegate alpha \
  --to <EDGE_B_NODE_ID> \
  --capability summarize_workspace \
  --home /tmp/tako-manual/edge-a
```

Inspect request and result:

```bash
bun run src/index.ts network requests list --home /tmp/tako-manual/edge-a
bun run src/index.ts network results show <REQUEST_ID> --home /tmp/tako-manual/edge-a
```

Expected:
- result status `ok`
- summary describing edge B workspace

## 10. What Pass Looks Like

You should confirm all of these:

1. `hub status` shows:
- `nodeCount: 2`
- `onlineNodeCount: 2`
- `projectCount >= 1`

2. edge A and B both show trust records:

```bash
bun run src/index.ts network trust list --home ...
```

3. at least one network session exists:

```bash
bun run src/index.ts network sessions list --home ...
```

4. at least one shared artifact exists

5. at least one delegation request completed with `ok`

6. each edge still has its own worktree root

That is the core multi-user, multi-agent proof.

## 11. If You Want Discord Later

After the no-LLM local proof passes, then add Discord as the human-facing layer.

The file to inspect is:
- `src/channels/discord.ts`

But you should test the core collaboration model first without Discord, because:
- it removes provider and bot noise
- it isolates collaboration bugs from transport bugs

## 12. Best Documentation To Read While Testing

Start with:
- `README.md`
- `ARCHITECTURE.md`
- `docs/repo-structure.md`
- `docs/getting-started-network-collab.md`
- `docs/qa-phase14.md`

## Recommendation

Run in this order:
1. tmux harness
2. manual single-server test
3. artifact and patch workflow
4. background refresh inspection
5. delegation
6. only then add Discord

## Optional Next Step

If you want, add a copy-paste checklist with blanks for IDs so the manual run is easier to execute without editing commands inline.
