# Usage Guide

## Core lifecycle commands

```bash
tako start            # run in foreground
tako start -d         # run as daemon
tako status           # runtime status
tako tui              # attach TUI to daemon
tako stop             # stop daemon
tako restart          # restart daemon
```

## Setup and diagnostics

```bash
tako onboard          # setup wizard
tako doctor           # system diagnostics
```

## Model management

```bash
tako models list
tako models auth login --provider anthropic
tako models auth login --provider openai
```

## In-chat slash commands

Built-ins usually include:

- `/help`
- `/status`
- `/new`
- `/compact`
- `/model`
- `/agents`
- `/whoami`
- `/queue`
- `/usage`

Additional slash commands can come from installed skills.

## Tool profiles

Configure in `~/.tako/tako.json`:

- `minimal` — essential local tools
- `coding` — adds search/git/memory workflows
- `full` — all enabled tool groups

## Sessions and memory

- sessions are persisted under `~/.tako/agents/<agent>/sessions`
- memory workspace defaults to `~/.tako/workspace`
- auto-compaction can be configured in `session.compaction`

## Common workflows

### Quick local assistant

```bash
tako start
```

Use in CLI and stop with `Ctrl+C`.

### Always-on daemon + channels

```bash
tako start -d
tako status
tako tui
```

Configure Discord/Telegram in `tako.json`, then restart.

### Skill development iteration

- add/update `skills/<name>/SKILL.md`
- optional tool files in `skills/<name>/tools/`
- save files; skills can be reloaded without full rebuild in most flows

## Troubleshooting

```bash
tako doctor
tako status
```

Check logs in:

- `~/.tako/logs/`
