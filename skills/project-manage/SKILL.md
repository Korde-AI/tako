---
name: project-manage
description: Use when the user wants to manage an existing project: inspect current members, add or invite a collaborator, check room binding, review project mode, update STATUS.md, or clarify project roles and permissions.
---

# Project Manage

Use this when the project already exists and the task is administrative.

## Workflow

1. Inspect the current project room and membership state.
2. For member changes, decide whether `project_member_manage` is needed and use it only for actual project membership changes.
3. For status updates, update `STATUS.md` first.
4. When clarifying confusion, answer with the current project mode, members, and the next concrete action.

## Membership

- Only the owner or an admin should add members.
- Only the owner or an admin should remove members.
- Adding a second member is what allows the project to become collaborative.
- Removing members should also reconcile the project mode back to `single-user` if only one member remains.
- Use stable identifiers when possible:
  - Discord user ID
  - username
  - display name
  - principal ID
- If the target is visible in the current Discord room but not yet mapped, use current room state to resolve them instead of stopping at "cannot resolve".
- If a visible room member still cannot be resolved cleanly, explicitly @mention them and ask them to speak once so the agent can map them.
- Do not force a member-management tool call if the user is only asking for explanation or current state.
- If the user asks who is here, who can access this channel, or whether you can see the members in the current Discord room, use `discord_room_inspect` first.
- Treat Discord room access as volatile state: run a fresh inspection for each current-membership question instead of relying on earlier inspection results.
- Answer from the latest Discord room state first, then mention project membership separately if the room is project-bound.
- Do not invent extra humans or bots beyond the latest inspection output.
- If the user asks to let someone join the current Discord channel and no project is bound yet, use `discord_room_access_manage` instead of project membership logic.
- If the target person is not yet in the Discord server, explain that they must be invited to the server first before channel access can be granted.

## Status discipline

`STATUS.md` should stay concise:
- Current Goal
- In Progress
- Done
- Blockers
- Next Actions

## Local path defaults

- When a project needs a local workspace or worktree on an agent, default to the agent workspace under:
  - `projects/<project-slug>`
- Do not ask the user for a local repo path unless they explicitly want a custom path.
- For ordinary project sync requests, assume the default project-local path and use project tools first.
