---
name: project-create
description: Use when the user wants to create a new project, open a project room, bind a Discord room to a project, or initialize a shared project workspace. Covers creating a Discord channel or thread, binding the room, creating PROJECT.md and STATUS.md, and announcing the initial project brief.
command-dispatch: tool
command-tool: project_bootstrap
command-arg-mode: raw
---

# Project Create

Use this when the user asks to create or open a project.

## Workflow

1. Decide whether the user wants a new channel, a thread, or the current room.
2. Use `project_bootstrap`.
3. After bootstrap, verify the room is bound.
4. Ensure the shared project docs exist:
   - `PROJECT.md`
   - `STATUS.md`
5. Announce the new room briefly with project name, mode, and next step.

## Room rules

- If the user says `channel`, prefer a Discord channel.
- If the user says `thread`, prefer a thread.
- If the user says `here` or `this channel`, bind the current room.
- Do not ask for Guild ID if the current Discord guild context exists.

## Initial state

New projects start as `single-user` until another member is added.
