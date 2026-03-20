---
name: project-collaboration
description: Use when the user wants to collaborate in an already-shared project with other humans or agents. Covers syncing progress, summarizing project state, coordinating roles, handling blockers, and resolving collaboration confusion once the project has more than one member.
---

# Project Collaboration

Use this only when the project has more than one member or the user explicitly wants shared collaboration behavior.

## Activation rule

Treat collaboration as active only after the project has more than one member.
A single-user project should not behave as a collaborative room.

## Workflow

1. Confirm the project has multiple members.
2. Read current project state and `STATUS.md`.
3. Summarize progress before proposing new work.
4. For questions like:
   - `tell me about the project`
   - `give me a basic intro`
   - `what is this project`
   - `summarize the project`
   answer directly from the current shared project context, `PROJECT.md`, and `STATUS.md` when available.
   Do not call `project_sync` just to answer an introductory or explanatory question.
5. When asked to sync, especially with phrases like:
   - `sync your work tree`
   - `sync this project`
   - `sync the progress`
   - `sync to other participants`
   use `project_sync`, not generic git or shell sync logic, unless the user explicitly asks for a raw git operation.
6. When roles or communication are unclear, state:
   - current members
   - current mode
   - who can act next

## Coordination rules

- Prefer project state, membership, and network session flows.
- Treat project sync as project/workspace synchronization by default. The local mirror path should default to the agent workspace under `projects/<project-slug>`.
- Do not rely on bot-to-bot Discord mentions for real agent coordination.
- Keep shared updates in project files and room announcements.
- Do not call sync tools for ordinary chat unless the user is actually asking to synchronize or persist project state.
