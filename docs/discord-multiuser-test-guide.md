# Tako Discord Multi-User Test Guide

Use this guide when you want to test Tako primarily from the Discord side instead of driving the whole flow from CLI commands.

This is the correct split:
- Discord is the human collaboration surface
- Tako edge and hub are still the control plane underneath
- a few bootstrap/admin actions still require CLI today

## What This Guide Covers

This guide validates that:
- one Discord project channel or thread can host a shared project
- multiple humans can collaborate in that project from Discord
- invited remote agents can join the same project through the network model
- shared project background refreshes when new people or agents join
- shared artifacts and patch approvals surface back into Discord
- each agent still keeps its own worktree and local machine authority

## Current Product Boundary

You can test collaboration from Discord.

You cannot yet do every setup step from Discord alone.

Today, these still require CLI or operator setup:
- hub startup
- edge startup
- Discord bot token/config wiring
- initial project creation
- project-channel binding
- invite import/accept between homes when testing multiple user-owned edges

After bootstrap, the collaboration flow can be tested from Discord much more directly.

## Topology

Recommended single-server test topology:
- `1 hub`
- `2 edges`
- `2 Discord bot identities` if you want true separate bot actors
- or `1 bot + networked edges` if you only need one visible bot surface first
- `1 shared project`
- `1 bound Discord channel or thread`

## Recommended Test Modes

### Mode A: Fastest Discord validation
Use:
- one shared Discord bot
- one bound Discord project channel/thread
- one edge serving the channel
- additional humans in Discord

This validates:
- multi-human project collaboration in Discord
- shared session behavior
- project background refresh on new participant join
- shared artifacts/patch workflow in the channel

### Mode B: Full invited-agent validation
Use:
- hub
- edge A
- edge B
- trust/invite flow between edges
- one bound Discord project channel/thread
- remote network session and delegated work

This validates the full target model more closely.

## Preconditions

You need:
- a Discord server you control
- a bot application/token for the Tako-connected bot
- one text channel or thread dedicated to the project
- Tako built locally

From repo root:

```bash
cd /home/shuyhere/projects/tako
npm install
npm run build
npm test
```

## 1. Minimal Bootstrap Setup

These are the parts that still happen outside Discord.

### 1.1 Start the hub

```bash
bun run src/index.ts hub start --home /tmp/tako-discord/hub --port 18790
```

### 1.2 Start edge A

Configure edge A with your Discord token and hub URL, then start it.

Example shape in its config:
- Discord enabled
- bot token present
- gateway bind/port set
- `network.hub` pointing to the hub

Then run:

```bash
bun run src/index.ts start --home /tmp/tako-discord/edge-a --port 18801
```

### 1.3 Optional: start edge B for invited-agent testing

```bash
bun run src/index.ts start --home /tmp/tako-discord/edge-b --port 18802
```

### 1.4 Create principals and project

You still need one initial owner principal and project.

Create the project on edge A:

```bash
bun run src/index.ts projects create alpha \
  --owner <EDGE_A_PRINCIPAL_ID> \
  --name "Alpha" \
  --home /tmp/tako-discord/edge-a
```

### 1.5 Bind the Discord channel or thread to the project

Bind the channel:

```bash
bun run src/index.ts projects bind alpha \
  --platform discord \
  --target <DISCORD_CHANNEL_ID> \
  --home /tmp/tako-discord/edge-a
```

If you are using a thread, bind the thread too:

```bash
bun run src/index.ts projects bind alpha \
  --platform discord \
  --target <DISCORD_CHANNEL_ID> \
  --thread <DISCORD_THREAD_ID> \
  --home /tmp/tako-discord/edge-a
```

After this point, the actual behavior test moves into Discord.

## 2. Discord-Side Test Flow

## 2.1 Verify the bot responds in the project channel

In the bound Discord channel or thread, send:

```text
/whoami
```

Expected:
- the bot responds in the same channel/thread
- the response identifies the current principal/session/project context
- the project is recognized as the bound project

Also try:

```text
/help
```

Expected:
- the command works in the bound project channel
- the bot uses the project context instead of creating an unrelated solo context

## 2.2 Verify multi-human join behavior

Have a second human user post in the same bound channel/thread.

Expected behavior:
- the project session becomes shared for that channel/thread
- participant tracking updates
- project background refresh is triggered
- if join announcements are enabled, the channel receives a shared-safe project background update

What to look for:
- a new participant is recognized
- the shared project context is refreshed
- no private memory from another participant is exposed

## 2.3 Verify project background from Discord

Use the project background command in Discord:

```text
/projectbg
```

Expected:
- a summary of shared-safe project background
- recent artifacts
- participant/session context
- no private per-user notes
- no private per-edge worktree details beyond safe summary

## 2.4 Verify shared artifact announcement from Discord activity

From the operator side, publish an artifact into the project once.

Then in Discord, verify:
- the bound project channel receives an artifact announcement
- the artifact appears as shared project state
- subsequent `/projectbg` reflects it

Expected:
- users in Discord can see that a shared artifact exists
- the artifact belongs to the shared project, not one user’s private assistant context

## 2.5 Verify patch review flow in Discord

Create a patch artifact from one edge worktree.

In Discord, test the review flow:
- use the patch listing command
- use the button-based approval or denial if the message is posted with buttons
- or the command fallback if needed

Commands to use in Discord:

```text
/patches
/patchapprove <approvalId>
/patchdeny <approvalId>
```

Expected:
- pending patch appears in the project channel
- patch approval updates the project review state
- denial is reflected cleanly
- patch state is shared project state, not a private note

If button UI is present, also verify:
- `Approve Patch`
- `Deny Patch`

Expected:
- clicking a button resolves the same approval record used by the command path

## 2.6 Verify invited remote agent behavior

This is the full target test.

Bootstrap steps still happen outside Discord:
- create invite on edge A
- import/accept on edge B
- establish trust
- register the network session if needed

Once that is done, return to Discord.

Expected Discord-side behavior when the remote edge joins:
- project background refresh happens again
- the channel/thread reflects that another agent participant is present
- shared session context remains one project conversation
- remote collaboration happens without exposing the remote edge’s private machine state

What to verify:
- no direct remote filesystem view is exposed in Discord
- only shared project-safe context appears
- remote results arrive as collaboration artifacts/messages, not as raw shell access

## 2.7 Verify delegated work result surfaces back into Discord

Trigger delegated work from the owner side so another trusted edge performs bounded work.

Good bounded examples:
- summarize workspace
- inspect logs
- run tests
- review patch

Expected in Discord:
- the result is surfaced back into the bound project channel/thread
- the result is structured and attributable to the remote participant/edge
- the shared project can continue from that result

What must not happen:
- raw remote shell exposure
- leakage of the other user’s private memory
- leakage of the other user’s non-project local files

## 3. Full Expected Behavior In Discord

When the system is working correctly, the Discord project channel should behave like this:

1. The channel/thread is the shared project collaboration surface.
2. New humans joining the conversation trigger shared project background refresh.
3. New invited agents joining the project also trigger shared project background refresh.
4. Shared artifacts and patch reviews appear in the same project channel.
5. Delegated work results come back into the same project conversation.
6. Each agent still keeps:
- its own worktree
- its own local machine authority
- its own private memory outside the shared project boundary

That is the correct model.

## 4. What To Check For Specifically

### Pass criteria

You should confirm all of these from the Discord side:

1. `/whoami` resolves to the bound project context.
2. A second human joining causes visible shared-session behavior.
3. `/projectbg` shows shared-safe context only.
4. Shared artifacts become visible in the project channel.
5. Patch review appears in the project channel and can be approved or denied there.
6. Remote invited-agent participation is visible as project collaboration, not as a separate unrelated session.
7. Delegated remote work results surface back into the same project channel/thread.
8. No one sees another participant’s private project memory.
9. No one gains direct access to another participant’s machine or local ACP through Discord.

### Fail criteria

Treat these as failures:
- replies appear in the wrong Discord channel/thread
- a new participant does not refresh project background
- remote invited agent activity creates a disconnected conversation
- shared artifacts do not surface to the channel
- patch approval only works in CLI but not in Discord
- delegated results never return to the channel
- private notes or private machine details leak into channel responses

## 5. Recommended Test Sequence

Run in this order:

1. bind one Discord channel/thread to one project
2. test `/whoami` and `/help`
3. add a second human and verify shared-session join refresh
4. verify `/projectbg`
5. publish one artifact and verify channel announcement
6. create one patch and approve/deny it from Discord
7. connect a second edge through invite/trust/network session bootstrap
8. verify remote participant join refresh in Discord
9. run one bounded delegated task and verify the result appears in the channel

## 6. What Still Requires Operator Support Today

The current product still needs CLI/operator support for:
- initial edge and hub boot
- Discord config and bot token wiring
- initial project creation and project-channel binding
- invite import/accept between homes
- some network/session bootstrap operations

So the correct expectation is:
- collaboration test from Discord: yes
- total zero-CLI setup from Discord only: not yet

## 7. Files To Inspect If Something Breaks

Relevant files:
- `src/channels/discord.ts`
- `src/index.ts`
- `src/projects/background.ts`
- `src/projects/approvals.ts`
- `src/projects/artifacts.ts`
- `src/network/session-sync.ts`
- `src/network/shared-sessions.ts`

## 8. Recommendation

Use this testing ladder:
1. first prove the core system with the no-LLM single-server harness
2. then move the human-facing validation into Discord using this guide
3. only after that add real provider-backed agent conversations

That order isolates transport bugs from collaboration bugs and collaboration bugs from model/provider bugs.
