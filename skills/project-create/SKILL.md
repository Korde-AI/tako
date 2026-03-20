---
name: project-create
description: Use when the user wants to create a new project, open a project room, bind a Discord room to a project, or initialize a shared project workspace. Covers creating a Discord channel or thread, binding the room, creating PROJECT.md and STATUS.md, and announcing the initial project brief.
---

# Project Create

Use this when the user asks to create or open a project.

## Workflow

1. Decide whether the user wants a new channel, a thread, or the current room.
2. Decide whether `project_bootstrap` is the right tool and call it if the request is a real project bootstrap action.
3. After bootstrap, verify the room is bound.
4. Ensure the shared project docs exist:
   - `PROJECT.md`
   - `STATUS.md`
5. Announce the new room briefly with project name, mode, and next step.

## Room rules

- If the user says `channel`, prefer a Discord channel.
- New project channels should be private to the requester by default.
- If the user says `thread`, prefer a thread.
- If the user says `here` or `this channel`, bind the current room.
- Do not ask for Guild ID if the current Discord guild context exists.
- Prefer `project_bootstrap` over the generic `message` tool for real project bootstrap actions.
- Use tools only when the request actually requires state changes. Do not force a tool call for normal discussion.

## Initial state

New projects start as `single-user` until another member is added.
