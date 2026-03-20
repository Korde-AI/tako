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
- Adding a second member is what allows the project to become collaborative.
- Use stable identifiers when possible:
  - Discord user ID
  - username
  - display name
  - principal ID
- Do not force a member-management tool call if the user is only asking for explanation or current state.

## Status discipline

`STATUS.md` should stay concise:
- Current Goal
- In Progress
- Done
- Blockers
- Next Actions
