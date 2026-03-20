# Discord Personal Agent And Collaboration Guide

Use this guide when you want:
- one personal Discord agent per person
- collaboration through Discord channels and project rooms
- no hub in the first stage

This is the default development model.

The hub is optional later if you want a dashboard, extra control-plane visibility, or more structured multi-edge routing. It is not required for normal Discord-first personal-agent collaboration.

## What this mode gives you

With Discord and one edge per person, you can already do:
- personal agent ownership
- project creation from Discord
- shared project rooms
- shared project docs:
  - `PROJECT.md`
  - `STATUS.md`
  - `NOTICE.md`
- collaboration between humans in Discord
- readonly access to other people’s agents for shared project information
- approval-gated privileged cross-user or cross-agent actions
- Discord-based project invites and join flow
- local project mirrors and worktrees on each person’s machine

## What this mode does not require

You do not need:
- a hub
- a central shared filesystem
- node IDs in the normal Discord UX

## Mental model

Each person has:
- their own Discord bot
- their own edge home
- their own local workspace
- their own private memory and execution authority

Discord is the shared collaboration surface.

That means:
- your own agent can execute for you
- other people can ask your agent shared project questions
- other people do not get your private memory or unrestricted execution

## Recommended dev commands

Run from source.

Do not start with `tako start` for this workflow.

Use:

```bash
bun run src/index.ts onboard --home /tmp/tako-discord/edge-yourname
bun run src/index.ts start --home /tmp/tako-discord/edge-yourname --port 1880X
```

Examples:

```bash
bun run src/index.ts onboard --home /tmp/tako-discord/edge-shu
bun run src/index.ts start --home /tmp/tako-discord/edge-shu --port 18801
```

```bash
bun run src/index.ts onboard --home /tmp/tako-discord/edge-jiaxin
bun run src/index.ts start --home /tmp/tako-discord/edge-jiaxin --port 18802
```

## 1. Create one edge per person

Each person should have:
- a different `--home`
- a different port
- a different Discord bot token

Example:

- Shu:
  - home: `/tmp/tako-discord/edge-shu`
  - port: `18801`
  - bot: `shuassitant`

- Jiaxin:
  - home: `/tmp/tako-discord/edge-jiaxin`
  - port: `18802`
  - bot: `jiaxinassistant`

## 2. Onboard each edge

Example for Jiaxin:

```bash
cd ~/tako
bun run src/index.ts onboard --home /tmp/tako-discord/edge-jiaxin
```

Recommended onboarding choice:
- `Discord bot (Recommended)`

## 3. Start each edge

Example:

```bash
cd ~/tako
bun run src/index.ts start --home /tmp/tako-discord/edge-shu --port 18801
```

```bash
cd ~/tako
bun run src/index.ts start --home /tmp/tako-discord/edge-jiaxin --port 18802
```

## 4. Invite the bots into the same Discord server

Each personal agent bot should be in the same server if you want shared project collaboration there.

Enable the usual Discord bot permissions:
- View Channels
- Send Messages
- Read Message History
- Use Slash Commands
- Create Threads if needed
- Send Messages in Threads

Enable:
- `MESSAGE CONTENT INTENT`

## 5. Claim ownership

Each person should claim their own bot from their own Discord account:

```text
/claim
```

That establishes:
- owner of the bot
- full execution rights for the owner

## 6. Create a project from Discord

From the owner’s bot:

```text
@shuassitant create a private project channel for SkillTree and initialize the workspace
```

Expected:
- private project room created
- project bound to the room
- local project workspace created
- starter docs created:
  - `PROJECT.md`
  - `STATUS.md`
  - `NOTICE.md`

Default local project path behavior:
- each edge keeps the project under its own workspace
- default path shape:
  - `.../workspace/projects/<project-slug>`

## 7. Invite another person or agent through Discord

From the host agent in the project room:

```text
@shuassitant invite jiaxinassistant into this project
```

Then from the receiving agent in the same Discord room:

```text
@jiaxinassistant accept the latest invite in this channel
```

Expected:
- the receiving edge joins the project
- local project mirror is created on the receiving host
- local worktree is registered
- the room is bound locally on that edge too

## 8. Collaboration permissions

### Your own agent

You have full control over your own agent.

Examples:

```text
@shuassitant sync the progress
@shuassitant add CC to this project
```

### Someone else using your agent

Other people can still ask:
- shared project questions
- room/member questions
- project status questions

But they do not get:
- host filesystem execution
- private memory
- unrestricted mutation rights

Examples that should work:

```text
@shuassitant who is in this project?
@shuassitant can you see the members here?
```

Examples that should be blocked or approval-gated:

```text
@shuassitant close this project
@shuassitant run ls -la
```

## 9. Approval flow

If another user or another agent asks your agent to do a privileged action:
- the task is blocked
- the owner gets a Discord approval card
- approve or deny from Discord

If approved:
- the exact approved task executes once

## 10. Project sync from Discord

In a bound project room:

```text
@jiaxinassistant sync your work tree
```

Expected:
- it resolves the current project from the room
- it uses the default local project path
- it does not ask for a repo path unless the user explicitly wants a custom one

## 11. Welcome and collaboration flow

When a new person joins a bound project room and starts participating:
- project membership can be updated
- collaboration mode can activate
- welcome/sync notices appear in the room

## 12. When to add a hub later

Add a hub only when you want more than normal Discord-first collaboration.

Good reasons to add a hub later:
- a central dashboard
- extra control-plane visibility
- node registry and route inspection
- more structured multi-edge transport beyond Discord relay
- operator-focused monitoring

Not a reason by itself:
- basic collaboration in Discord

## 13. Recommended default product story

Stage 1:
- personal agents
- Discord collaboration
- no hub required

Stage 2:
- optional hub for dashboard and advanced coordination

That is the correct default explanation for users.
