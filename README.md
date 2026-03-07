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

### Option A — npm (after publish)

```bash
npm install -g takotako
```

Or with Bun:

```bash
bun add -g takotako
```

Then run:

```bash
tako onboard
tako start -d   ## preferred: run in background after onboard
```

### Option B — pre-publish install from GitHub

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

## Skills

Skill directory structure:

```text
skills/my-skill/
├── SKILL.md
└── tools/
    └── my-tool.mjs
```

- `SKILL.md` frontmatter controls metadata, triggers, and command dispatch
- tools are loaded dynamically

See:

- **[docs/skills.md](docs/skills.md)**

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

---

## License

MIT — see [LICENSE](LICENSE).

---

## Thanks

Tako is informed by the broader agent tooling ecosystem. Special thanks to projects and communities that explored these patterns early, including OpenClaw and ZeroClaw.
