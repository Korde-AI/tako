# Server Discord Quick Start

Use this guide when you want to:
- run one edge on a server
- connect it to Discord
- start it from source with `bun run src/index.ts ...`
- keep it running in the background

This is the recommended first deployment path.

## 1. Install prerequisites

On the server:

```bash
sudo apt update
sudo apt install -y git curl unzip
curl -fsSL https://bun.sh/install | bash
source ~/.bashrc
```

Check:

```bash
bun --version
git --version
```

## 2. Clone and install

```bash
git clone https://github.com/Korde-AI/tako.git
cd tako
bun install
```

## 3. Create the edge home

Example:

```bash
mkdir -p /tmp/tako-discord/edge-main
```

## 4. Create the Discord bot

Go to:
- https://discord.com/developers/applications

Then:
1. create a new application
2. open the `Bot` tab
3. click `Add Bot`
4. reset/copy the bot token

Enable:
- `MESSAGE CONTENT INTENT`
- `SERVER MEMBERS INTENT` if you want richer member information

Invite the bot to your server from:
- `OAuth2 -> URL Generator`

Scopes:
- `bot`
- `applications.commands`

Recommended bot permissions:
- View Channels
- Send Messages
- Read Message History
- Use Slash Commands
- Create Public Threads
- Send Messages in Threads
- Add Reactions
- Attach Files
- Embed Links
- Manage Channels

## 5. Run onboarding

Use the source entrypoint directly:

```bash
cd ~/tako
bun run src/index.ts onboard --home /tmp/tako-discord/edge-main
```

Recommended onboarding choices:
- provider: your normal provider
- channel: `Discord bot (Recommended)`

During onboarding, paste:
- the Discord bot token
- your model auth

## 6. Check the generated config

File:
- `/tmp/tako-discord/edge-main/tako.json`

Typical development config shape:

```json
{
  "providers": {
    "primary": "anthropic/claude-sonnet-4-6"
  },
  "channels": {
    "discord": {
      "token": "YOUR_DISCORD_BOT_TOKEN"
    }
  },
  "gateway": {
    "bind": "127.0.0.1",
    "port": 18801
  },
  "memory": {
    "workspace": "workspace"
  }
}
```

## 7. Start the edge in the foreground first

Always do one foreground run before backgrounding it:

```bash
cd ~/tako
bun run src/index.ts start --home /tmp/tako-discord/edge-main --port 18801
```

Expected:
- Discord slash commands register
- bot comes online
- no immediate auth/config errors

## 8. Test in Discord

In your Discord server:

```text
@yourbot who are you
```

Then:

```text
/help
```

If mention replies do not work, check:
- bot is invited to the server
- `MESSAGE CONTENT INTENT` is enabled
- the bot can read that channel

## 9. Run it in the background

### Option A: `nohup`

Simple first step:

```bash
cd ~/tako
nohup bun run src/index.ts start --home /tmp/tako-discord/edge-main --port 18801 > /tmp/tako-discord/edge-main.log 2>&1 &
```

Check:

```bash
tail -f /tmp/tako-discord/edge-main.log
```

### Option B: `tmux`

Better for active development:

```bash
tmux new -s tako-edge
cd ~/tako
bun run src/index.ts start --home /tmp/tako-discord/edge-main --port 18801
```

Detach:
- `Ctrl-b d`

Reattach:

```bash
tmux attach -t tako-edge
```

### Option C: `systemd`

Best for stable server hosting.

Example unit:

```ini
[Unit]
Description=Tako Discord Edge
After=network.target

[Service]
WorkingDirectory=/home/YOUR_USER/tako
ExecStart=/home/YOUR_USER/.bun/bin/bun run src/index.ts start --home /tmp/tako-discord/edge-main --port 18801
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl daemon-reload
sudo systemctl enable --now tako-edge
sudo systemctl status tako-edge
```

## 10. Update after code changes

```bash
cd ~/tako
git pull
bun install
```

Then restart the process with the same command you used before.

## 11. Useful checks

```bash
cd ~/tako
bun run src/index.ts status --home /tmp/tako-discord/edge-main --json
bun run src/index.ts doctor --home /tmp/tako-discord/edge-main
```

## 12. Recommended next step

After the bot is live, use the Discord-first guide:
- [discord-personal-agent-collaboration-guide.md](./discord-personal-agent-collaboration-guide.md)

That is the next layer for:
- project creation
- project rooms
- permissions
- collaboration
