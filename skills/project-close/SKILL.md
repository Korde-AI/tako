---
name: project-close
description: Use when the user wants to close, finish, or shut down a project. Closes the current project, updates STATUS.md with closure information, marks the project status as closed, and announces the closure in the project room.
---

# Project Close

Use this when the owner or a project admin explicitly asks to close or finish a project.

## Workflow

1. Confirm the current project room or target project.
2. If the user is explicitly asking for closure, decide whether `project_close` is the correct tool and call it.
3. Make sure the final response clearly says the project status is now `closed`.
4. If the user provided a reason, preserve it.

## Notes

- Closing a project should set the project status to `closed`.
- Closing is a project-state action, not just a chat response.
- Update `STATUS.md` with closure information.
- Do not call the close tool for hypothetical discussion or status questions.
