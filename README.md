# Tako 🐙

**Agent-as-CPU OS** — minimal core runtime + pluggable skill arms.

Tako is a multi-channel AI agent runtime you can run locally or on a server. It supports CLI, Discord, Telegram, tool execution, memory, sessions, and hot-reloadable skills.

---

## What you get

- Minimal kernel with clear interfaces (provider/channel/tools/memory/hooks)
- Pluggable skills (`SKILL.md` + optional `tools/*`)
- Multi-channel operation from one runtime (CLI + Discord + Telegram)
- Session persistence + compaction
- Tool profiles (`minimal`, `coding`, `full`)
- Daemon mode with status/restart/tui attach

---

## Install

> Prerequisite: install **Node.js (>=20)** first, and install **Bun (>=1.0)** if you want to use Bun-based install/dev commands.

### Option A — npm (published package)

```bash
npm install -g @shuyhere/takotako
```

Or with Bun:

```bash
bun add -g @shuyhere/takotako
```

Then run:

```bash
tako onboard
tako start -d   ## preferred: run in background after onboard
```

### Option B — install from GitHub source

```bash
npm install -g github:Korde-AI/tako
```

### Option C — from source

```bash
git clone https://github.com/Korde-AI/tako.git
cd tako
npm install
npm run build
npm link

tako onboard
tako start -d   ## preferred: run in background after onboard
```

For detailed setup and platform notes, see **[docs/INSTALL.md](docs/INSTALL.md)**.

---

## Quick usage

```bash
tako start            # foreground
tako start -d         # daemon
tako status           # health + runtime info
tako tui              # attach TUI to daemon
tako stop             # stop daemon
tako restart          # restart daemon

tako doctor           # health diagnostics
tako models list      # list models
tako models auth login --provider anthropic
```

Inside chat/CLI, built-in commands include:

- `/help`
- `/status`
- `/model`
- `/agents`
- `/queue`
- `/usage`

See **[docs/USAGE.md](docs/USAGE.md)** for full command and workflow docs.

---

## Setting up Discord & Telegram

Tako supports multiple bots simultaneously — one per agent. Here's how to connect your main agent to Discord and Telegram.

### Discord Setup

**Step 1 — Create a Discord application**

1. Go to [https://discord.com/developers/applications](https://discord.com/developers/applications)
2. Click **New Application** → give it a name (e.g. `Tako`)
3. Go to the **Bot** tab → click **Add Bot**
4. Under **Token**, click **Reset Token** → copy it (you'll need it shortly)
5. Enable these **Privileged Gateway Intents**:
   - ✅ `MESSAGE CONTENT INTENT`
   - ✅ `SERVER MEMBERS INTENT`

**Step 2 — Invite the bot to your server**

1. Go to **OAuth2 → URL Generator**
2. Check **`bot`** and **`applications.commands`** under Scopes
3. Under Bot Permissions, check:
   - Send Messages, Read Messages/View Channels
   - Read Message History, Add Reactions
   - Attach Files, Embed Links
   - Create Public Threads, Send Messages in Threads
   - Manage Channels, Use Slash Commands
4. Copy the generated URL → open it in your browser → add the bot to your server

**Step 3 — Configure Tako**

Add your bot token to `~/.tako/tako.json`:

```json
{
  "channels": {
    "discord": {
      "token": "YOUR_BOT_TOKEN_HERE"
    }
  }
}
```

Or run `tako onboard` and follow the interactive setup.

**Step 4 — Lock down access (recommended)**

In your Discord server, send `/allowfrom add` to restrict the bot to only respond to you. The bot uses an allowlist — only users you explicitly add can talk to it.

---

### Telegram Setup

**Step 1 — Create a Telegram bot**

1. Open Telegram and search for **@BotFather**
2. Send `/newbot` → follow the prompts → give your bot a name and username
3. BotFather will give you a **token** — copy it

**Step 2 — Configure Tako**

Add your bot token to `~/.tako/tako.json`:

```json
{
  "channels": {
    "telegram": {
      "token": "YOUR_TELEGRAM_BOT_TOKEN_HERE"
    }
  }
}
```

**Step 3 — Lock down access (recommended)**

Get your Telegram user ID by messaging [@userinfobot](https://t.me/userinfobot). Then add it to your config:

```json
{
  "channels": {
    "telegram": {
      "token": "YOUR_TELEGRAM_BOT_TOKEN_HERE",
      "allowedUsers": ["YOUR_TELEGRAM_USER_ID"]
    }
  }
}
```

**Step 4 — Restart Tako**

```bash
tako restart
```

Your agent is now live on both Discord and Telegram.

---

## Creating Agents

Tako supports multiple specialized agents, each with their own bot identity, workspace, personality, and skills.

### How it works

- Each agent gets its own Discord/Telegram bot
- Agents have isolated workspaces (`~/.tako/workspace-<name>/`)
- Each workspace has `SOUL.md` (personality), `IDENTITY.md`, `USER.md`, and `memory/`
- Agents share the same provider (LLM) but can use different models

### Use case 1 — Code Agent

You want a dedicated coding assistant in a `#code-help` channel.

**Step 1 — Create the agent**

```
Ask Tako: "Create a new agent called code-agent for coding help"
```

Or via CLI:

```bash
tako agents add code-agent --description "Coding assistant — fixes bugs, reviews code, helps with repos"
```

**Step 2 — Give it a bot**

Create a second Discord application at [discord.com/developers](https://discord.com/developers/applications) (same process as above). Then in Discord, run:

```
/setup
```

Select `code-agent` → Discord Bot → paste the token.

**Step 3 — Talk to it**

Invite the new bot to your server and `@mention` it in any channel. It will only respond when directly mentioned.

---

### Use case 2 — Project Manager Agent

You want a PM agent that tracks tasks, milestones, and project status.

```
Ask Tako: "Create a project manager agent"
```

The PM agent gets its own workspace and channel. You can talk to it in a dedicated `#project-management` channel — it keeps context across sessions and remembers your projects.

---

### Use case 3 — Research Agent

You want an agent that searches the web, reads papers, and summarizes findings.

```
Ask Tako: "Create a research agent with web search capabilities"
```

Agents inherit all tools by default. You can restrict tool access per agent using roles:

```json
{
  "agents": {
    "list": [
      {
        "id": "research-agent",
        "role": "standard",
        "description": "Research assistant"
      }
    ]
  }
}
```

---

## Creating Skills

Skills extend Tako with new capabilities. A skill is a `SKILL.md` file (instructions) plus optional custom tools.

### Skill structure

```text
skills/my-skill/
├── SKILL.md          ← instructions + metadata (required)
└── tools/
    └── my-tool.mjs   ← custom tool (optional)
```

### SKILL.md format

```markdown
---
name: my-skill
description: What this skill does and when to use it
---

# My Skill

Instructions for the agent go here. Write in plain English.
Tell the agent what to do, how to do it, and what output to produce.
```

### Use case 1 — Daily Standup Skill

Automatically posts a daily standup summary to Discord every morning.

```markdown
---
name: daily-standup
description: Post a daily standup summary to the team Discord channel every morning
---

# Daily Standup

Every morning at 9am, post a standup message to the team channel with:
1. What was completed yesterday
2. What's planned for today
3. Any blockers

Format it as a clean Discord embed with bullet points.
```

Install it:

```bash
cp -r skills/daily-standup ~/.tako/skills/
tako restart
```

---

### Use case 2 — Code Review Skill

Automatically reviews pull requests when linked in chat.

```markdown
---
name: code-review
description: Review GitHub pull requests for code quality, bugs, and best practices
---

# Code Review

When given a GitHub PR URL:
1. Fetch the diff using the GitHub API
2. Review for: correctness, security issues, performance, readability
3. Provide a structured review with specific line-level feedback
4. Rate the PR: Approve / Request Changes / Comment
```

---

### Use case 3 — Custom Tool Skill

A skill with a custom Node.js tool that calls an external API.

```text
skills/weather/
├── SKILL.md
└── tools/
    └── get-weather.mjs
```

`SKILL.md`:
```markdown
---
name: weather
description: Get current weather for any city
tools:
  - get-weather
---

When asked about weather, use the get-weather tool with the city name.
Report temperature, conditions, and a brief forecast.
```

`tools/get-weather.mjs`:
```javascript
export const name = 'get-weather';
export const description = 'Get current weather for a city';
export const parameters = {
  type: 'object',
  properties: {
    city: { type: 'string', description: 'City name' }
  },
  required: ['city']
};

export async function execute({ city }) {
  const res = await fetch(`https://wttr.in/${city}?format=j1`);
  const data = await res.json();
  return { output: JSON.stringify(data.current_condition[0]) };
}
```

---

## Recommended setup

For the best day-to-day control surface, use Discord and invite your bot to a server.
Then run Tako in daemon mode and manage it with slash commands as your live dashboard (`/status`, `/models`, `/agents`, `/queue`, `/usage`).

```bash
tako onboard
tako start -d
```

---

## Configuration

Main config path:

- `~/.tako/tako.json`

You can bootstrap config via:

```bash
tako onboard
```

Template example:

- `tako.example.json`

Reference docs:

- **[docs/configuration.md](docs/configuration.md)**

---

## Developer guide

If you want to contribute or run Tako in dev mode:

- **[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)**
- **[CONTRIBUTING.md](CONTRIBUTING.md)**

---

## Security notes

- Keep `~/.tako/tako.json` and tokens private
- Use restrictive tool profile in production (`minimal`/`coding` where possible)
- Restrict Discord/Telegram bot scopes and allowed users/channels
- Each agent bot should be locked to specific users via the allowlist

---

## License

MIT — see [LICENSE](LICENSE).

---

## Thanks

Tako is informed by the broader agent tooling ecosystem. Special thanks to projects and communities that explored these patterns early, including OpenClaw and ZeroClaw.
