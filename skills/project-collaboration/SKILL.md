---
name: project-collaboration
description: Use when the user wants to collaborate in an already-shared project with other humans or agents. Covers syncing progress, summarizing project state, coordinating roles, handling blockers, and resolving collaboration confusion once the project has more than one member.
command-dispatch: tool
command-tool: project_sync
command-arg-mode: raw
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
4. When asked to sync, update shared project docs first, then announce a concise summary.
5. When roles or communication are unclear, state:
   - current members
   - current mode
   - who can act next

## Coordination rules

- Prefer project state, membership, and network session flows.
- Do not rely on bot-to-bot Discord mentions for real agent coordination.
- Keep shared updates in project files and room announcements.
