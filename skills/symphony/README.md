# Symphony — Project Work Orchestrator

Symphony turns issue tracking into autonomous agent runs. It monitors GitHub Issues (via `gh` CLI), spawns isolated sub-agents per issue, monitors their progress, handles retries, and manages workspaces.

Inspired by [OpenAI Symphony](https://github.com/openai/symphony).

## Quick start

```bash
# Start monitoring a repo
tako symphony start --repo owner/repo --labels bug,feature

# Check status
tako symphony status

# Stop monitoring
tako symphony stop
```

## Configuration

### CLI flags

| Flag | Default | Description |
|------|---------|-------------|
| `--repo` | auto-detect | GitHub repo (owner/repo) |
| `--labels` | all | Comma-separated label filter |
| `--interval` | `30s` | Poll interval |
| `--max-agents` | `5` | Max concurrent agents |

### WORKFLOW.md

Place a `WORKFLOW.md` in your repo root to define per-repo orchestration policy. The YAML frontmatter configures behavior, and the Markdown body is the prompt template injected into each agent.

Template variables: `{{issue.number}}`, `{{issue.title}}`, `{{issue.body}}`, `{{issue.labels}}`, `{{issue.title_slug}}`, `{{attempt}}`.

## Architecture

```
Poll Loop ──► Reconcile ──► Fetch Issues ──► Dispatch
                 │                              │
                 ▼                              ▼
          Detect stalls              Create workspace
          Update states              Spawn sub-agent
          Schedule retries           Monitor progress
```

- **Orchestrator**: Singleton managing the poll-reconcile-dispatch loop
- **WorkspaceManager**: Creates isolated git worktrees per issue
- **WorkflowLoader**: Parses WORKFLOW.md frontmatter + prompt templates
- **Status**: Formatted dashboard output

State is in-memory. Recovery is tracker-driven — on restart, Symphony re-polls and reconciles.
