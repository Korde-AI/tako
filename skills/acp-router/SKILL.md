---
name: acp
description: ACP harness router (acpx-backed) for Codex/Claude/Pi/OpenCode/Gemini/Kimi sessions
version: 0.1.0
author: Tako
user-invocable: true
triggers:
  - type: keyword
    value: acp
  - type: keyword
    value: codex
  - type: keyword
    value: claude code
  - type: keyword
    value: gemini cli
---

# ACP Router (acpx)

Use `/acp` to route work into ACP harness agents.

## Usage

- `/acp <agent> <prompt>` — send prompt to a persistent ACP session (auto-created)
- `/acp exec <agent> <prompt>` — one-shot (no persistent session)
- `/acp list` — list known ACP session bindings in Tako
- `/acp reset <agent>` — close and forget the bound session for this chat session
- `/acp help` — show help

## Agents

Supported aliases: `pi`, `claude`, `codex`, `opencode`, `gemini`, `kimi`.

## Notes

- Prefers plugin-local `extensions/acpx/node_modules/.bin/acpx` when available.
- Falls back to `acpx` from PATH.
- Persistent session names are deterministic per Tako chat session + agent.
