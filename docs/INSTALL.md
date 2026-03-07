# Install Guide

This guide covers production and local installation for Tako.

## Requirements

- Node.js >= 20
- npm >= 9
- (Optional) Bun >= 1.0
- Git

## 0) Environment setup (for users)

### Ubuntu / Debian

```bash
sudo apt update
sudo apt install -y curl git build-essential
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt install -y nodejs
```

Optional Bun:

```bash
curl -fsSL https://bun.sh/install | bash
```

### macOS

```bash
brew install node git
# optional
brew install oven-sh/bun/bun
```

Check versions:

```bash
node -v
npm -v
git --version
```

## 1) Install package

Published package: `@shuyhere/takotako`

### npm

```bash
npm install -g @shuyhere/takotako
```

### Bun

```bash
bun add -g @shuyhere/takotako
```

### GitHub source fallback

```bash
npm install -g github:shuyhere/tako
```

Verify:

```bash
tako --help
npm view @shuyhere/takotako version
```

## 2) First-time setup

Run onboarding wizard:

```bash
tako onboard
```

What it configures:

- provider auth (Anthropic/OpenAI/LiteLLM)
- primary model
- optional channels (Discord/Telegram)
- writes config to `~/.tako/tako.json`

### Optional environment variables

You can configure through `tako onboard`, or set env vars directly:

```bash
export ANTHROPIC_API_KEY="..."
export OPENAI_API_KEY="..."
export DISCORD_TOKEN="..."
export TELEGRAM_TOKEN="..."
```

Persist these in your shell profile (`~/.bashrc`, `~/.zshrc`) if needed.

## 3) Start runtime

Foreground:

```bash
tako start
```

Daemon:

```bash
tako start -d
tako status
tako tui
```

## 4) Optional channel setup

### Discord

- Create bot in Discord Developer Portal
- Enable required intents (message content, guilds, DMs)
- Put bot token into `~/.tako/tako.json` under `channels.discord.token`
- Restart Tako

### Telegram

- Create bot via BotFather
- Put token into `~/.tako/tako.json` under `channels.telegram.token`
- Restart Tako

## 5) Health check

```bash
tako doctor
tako status
```

## Upgrade

```bash
npm install -g @shuyhere/takotako
# or GitHub source fallback:
# npm install -g github:shuyhere/tako
```

Then restart:

```bash
tako restart
```

## Uninstall

```bash
npm uninstall -g @shuyhere/takotako
```

Optional cleanup (local state/config):

```bash
rm -rf ~/.tako
```
