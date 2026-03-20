---
name: symphony
description: Project orchestration — poll GitHub issues, spawn agents per issue, monitor progress, manage workspaces
version: 0.1.0
author: Tako
user-invocable: true
triggers:
  - type: keyword
    value: symphony
  - type: keyword
    value: orchestrate
  - type: keyword
    value: monitor issues
requires:
  bins: [gh]
---

# Symphony — Project Work Orchestrator

Symphony monitors your GitHub issues and spawns autonomous agents to implement them.

## Commands

- `/symphony start [--repo owner/repo] [--labels bug,feature] [--interval 30s] [--max-agents 5]` — Start monitoring
- `/symphony stop` — Stop monitoring
- `/symphony status` — Show dashboard of all running agents
- `/symphony config` — Show/edit WORKFLOW.md settings
- `/symphony history` — Show recent completed runs

## How it works

1. Polls GitHub Issues on a configurable interval
2. For each eligible issue, creates an isolated workspace
3. Spawns a sub-agent with the issue context + WORKFLOW.md instructions
4. Monitors progress, detects stalls, retries on failure
5. Agent commits work, creates PRs, updates issue
6. On completion, reports results back

## WORKFLOW.md

Place a `WORKFLOW.md` in your repo root to configure Symphony behavior:

```yaml
---
tracker:
  labels: ["bug", "enhancement"]
  active_states: ["open"]
  exclude_labels: ["wontfix", "duplicate"]
polling:
  interval_ms: 30000
agent:
  max_concurrent: 5
  max_turns: 20
  timeout_ms: 3600000
  stall_timeout_ms: 300000
workspace:
  root: ~/.tako/symphony-workspaces
hooks:
  before_run: |
    npm install
    npm run build
---

You are working on a GitHub issue. Follow these steps:

1. Read the issue description carefully
2. Create a feature branch: `git checkout -b fix/{{issue.number}}-{{issue.title_slug}}`
3. Implement the fix/feature
4. Write tests
5. Run tests and ensure they pass
6. Commit with a descriptive message referencing #{{issue.number}}
7. Push and create a PR
```
