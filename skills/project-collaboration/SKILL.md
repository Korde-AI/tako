---
name: project-collaboration
description: Use when the user wants to create, run, or coordinate a collaborative project room with humans and agents, especially in Discord. Covers creating a project room/channel, binding it to a project, initializing shared project files like STATUS.md, announcing the project brief, adding collaborators, syncing progress, clarifying roles, and resolving collaboration conflicts.
---

# Project Collaboration

Use this skill when the request is about creating or operating a shared project, especially in Discord.

## Default workflow

1. Decide whether the user wants a new channel, a thread, or the current room bound.
2. If a project does not exist yet, use `project_bootstrap`.
3. After the project exists, create or update shared project files in the project root.
4. Announce the project state in the bound room.
5. Add collaborators with `project_member_manage` when the owner/admin asks.
6. Keep the project summary and progress synchronized as work advances.

## Room creation rules

- If the user explicitly says `channel`, prefer a Discord channel.
- If the user explicitly says `thread`, prefer a Discord thread.
- If the user says `use this channel` or `here`, bind the current room.
- In Discord, do not ask for Guild ID if the current guild context already exists. Use the current room context.

## Shared project artifacts

When creating a new project room, create or update at least one shared status file in the project root if possible:
- `STATUS.md`: current goals, owners, blockers, next steps

If there is enough context, also create:
- `PROJECT.md`: project brief and scope

Keep these concise and actionable.

## Announcements

After creating or rebinding a project room, send a concise announcement that includes:
- project name
- current mode: `single-user` or `collaborative`
- current members and roles if known
- immediate next step

## Membership rules

- Owner or admin can add members.
- Use `project_member_manage` for requests like:
  - `add Jiaxin to this project`
  - `invite wandering123`
  - `who is in this project?`
- Adding another human should move the project toward collaborative mode.

## Progress sync

When asked to sync progress, update the shared status files first, then announce a concise summary in the room.
Typical sections in `STATUS.md`:
- Current goal
- In progress
- Done
- Blockers
- Next actions

## Conflict handling

When there is confusion about roles, ownership, or collaboration state:
- inspect current project members
- inspect current project mode
- clarify who can talk in the room
- propose the next concrete action instead of replying vaguely

## Tool usage

Prefer these tools:
- `project_bootstrap`
- `project_member_manage`
- `message`
- file tools for shared project docs

Do not rely on bot-to-bot Discord mentions for agent coordination. Use project state, membership, and network collaboration flows.
