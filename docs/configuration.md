# Configuration

Tako is configured via `~/.tako/tako.json`, managed through `tako onboard` or CLI commands. Environment variables can also be used.

**Important:** Never commit `tako.json` to git — it contains tokens and API keys.

## Config File

```json
{
  "providers": {
    "primary": "anthropic/claude-sonnet-4-6",
    "fallback": ["anthropic/claude-haiku-4-5"]
  },
  "channels": {
    "discord": {
      "token": "your-discord-bot-token",
      "guilds": ["guild-id-1"]
    },
    "telegram": {
      "token": "your-telegram-bot-token",
      "allowedUsers": ["username1"]
    },
    "cli": {
      "prompt": "tako> "
    }
  },
  "tools": {
    "profile": "full",
    "deny": ["web_search"],
    "allow": ["exec"]
  },
  "memory": {
    "workspace": "~/.tako/workspace",
    "embeddings": {
      "provider": "openai",
      "model": "text-embedding-3-small"
    }
  },
  "gateway": {
    "bind": "127.0.0.1",
    "port": 18790,
    "authToken": "optional-auth-token"
  },
  "agent": {
    "timeout": 600,
    "thinking": "adaptive",
    "maxToolCalls": 50,
    "maxTurns": 20,
    "maxOutputChars": 50000,
    "maxTokens": 16384,
    "typingMode": "instant"
  },
  "sandbox": {
    "mode": "off",
    "scope": "session",
    "workspaceAccess": "ro"
  },
  "heartbeat": {
    "every": "30m",
    "target": "none",
    "ackMaxChars": 300
  },
  "session": {
    "compaction": { "auto": true, "thresholdPercent": 80 },
    "pruneAfterDays": 7,
    "maxEntries": 100
  }
}
```

## Reference

### providers

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `primary` | string | `"anthropic/claude-sonnet-4-6"` | Primary model (format: `provider/model`) |
| `fallback` | string[] | — | Ordered fallback model chain (up to 3) |
| `overrides` | object | — | Per-provider configuration overrides |
| `litellm` | object | — | LiteLLM proxy config (`baseUrl`, `apiKey`, `model`, `models`) |

### channels

#### discord
| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `token` | string | — | Discord bot token |
| `guilds` | string[] | — | Restrict to specific guild IDs |

#### telegram
| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `token` | string | — | Telegram bot token |
| `allowedUsers` | string[] | — | Restrict to specific usernames |

#### cli
| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `prompt` | string | `"tako> "` | CLI prompt string |

### tools

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `profile` | string | `"full"` | Tool profile: `minimal`, `coding`, or `full` |
| `deny` | string[] | `[]` | Tools to always block |
| `allow` | string[] | — | Tools to always allow (overrides profile) |
| `exec.security` | string | — | Exec safety: `deny`, `allowlist`, or `full` |
| `exec.allowlist` | string[] | — | Regex patterns for pre-approved commands |
| `exec.timeout` | number | — | Max exec timeout in ms |

**Profiles:**
- `minimal`: fs + runtime only
- `coding`: + search, git, memory
- `full`: all 10 groups (fs, runtime, search, git, memory, web, sessions, image, agents, messaging)

### memory

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `workspace` | string | `"~/.tako/workspace"` | Workspace directory path (~ expanded) |
| `embeddings.provider` | string | — | Embedding provider: `"openai"` or `"voyage"` |
| `embeddings.model` | string | — | Embedding model name |

### gateway

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `bind` | string | `"127.0.0.1"` | Bind address for WebSocket server |
| `port` | number | `18790` | Port number |
| `authToken` | string | — | Auth token (auto-generated if missing) |

### agent

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `timeout` | number | `600` | Max agent loop duration in seconds |
| `thinking` | string | `"adaptive"` | Thinking mode: `none`, `adaptive`, `always` |
| `maxToolCalls` | number | `50` | Max tool calls per loop iteration |
| `maxTurns` | number | `20` | Max tool-call turns per agent loop run |
| `maxOutputChars` | number | `50000` | Max output characters before truncation |
| `maxTokens` | number | `16384` | Max output tokens per API call |
| `typingMode` | string | — | Typing indicator: `never`, `instant`, `thinking`, `message` |
| `typingIntervalSeconds` | number | `6` | How often to refresh typing indicator |

### sandbox

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `mode` | string | `"off"` | When to sandbox: `off`, `non-main`, `all` |
| `scope` | string | `"session"` | Container lifecycle: `session`, `agent`, `shared` |
| `workspaceAccess` | string | `"ro"` | Workspace mount: `none`, `ro`, `rw` |
| `docker.image` | string | — | Custom Docker image |
| `docker.network` | string | — | Docker network binding |

### heartbeat

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `every` | string | `"30m"` | Interval: `"30m"`, `"1h"`, `"0m"` (disabled) |
| `target` | string | `"none"` | Delivery: `none`, `last`, or channel ID |
| `prompt` | string | *(built-in)* | Prompt sent to agent loop |
| `ackMaxChars` | number | `300` | Max chars before delivery is dropped |
| `activeHours` | object | — | Window: `{ start, end, timezone }` |

### session

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `compaction.auto` | boolean | `true` | Enable auto-compaction |
| `compaction.thresholdPercent` | number | `80` | Trigger at this % of context window |
| `pruneAfterDays` | number | `7` | Prune completed sub-agent sessions after N days |
| `maxEntries` | number | `100` | Max sessions to keep in memory |

### agents

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `defaults.workspace` | string | `"~/.tako/workspace"` | Default workspace for agents |
| `defaults.model` | object | — | Default model override |
| `list` | AgentEntry[] | `[]` | Configured agents with bindings and roles |

### skills

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `dirs` | string[] | `["./skills", "~/.tako/skills"]` | Directories to scan for skills |

## Environment Variables

| Variable | Purpose |
|----------|---------|
| `ANTHROPIC_API_KEY` | Anthropic provider auth |
| `ANTHROPIC_API_KEYS` | Comma-separated keys for rotation |
| `OPENAI_API_KEY` | OpenAI provider / embeddings |
| `VOYAGE_API_KEY` | Voyage embeddings (alternative) |
| `DISCORD_TOKEN` | Discord bot token |
| `TELEGRAM_TOKEN` | Telegram bot token |

**Recommended:** Use `tako onboard` or `tako models auth login` instead of manual env vars.

## Resolution Order

1. Hardcoded defaults
2. `~/.tako/tako.json` file (shallow merge per section)
3. Environment variables

Path expansion: `~` is expanded to the home directory in path fields.
