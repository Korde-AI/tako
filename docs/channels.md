# Channel Setup — Getting Your Bot Tokens

Tako connects to Discord and Telegram through bot tokens. This guide explains how to get those tokens. Once you have them, just run `tako onboard` and paste them in when prompted.

---

## Discord

### Step 1 — Create a Discord application

1. Go to [https://discord.com/developers/applications](https://discord.com/developers/applications)
2. Click **New Application** → give it a name (e.g. `Tako`)
3. Go to the **Bot** tab → click **Add Bot**
4. Under **Token**, click **Reset Token** → **copy it** (you'll need this in `tako onboard`)

### Step 2 — Enable required intents

Still on the **Bot** tab, scroll down to **Privileged Gateway Intents** and enable:

- ✅ `MESSAGE CONTENT INTENT` — required to read messages
- ✅ `SERVER MEMBERS INTENT` — optional, for member info

### Step 3 — Invite the bot to your server

1. Go to **OAuth2 → URL Generator**
2. Under **Scopes**, check: `bot` and `applications.commands`
3. Under **Bot Permissions**, check:
   - Send Messages
   - Read Messages / View Channels
   - Read Message History
   - Add Reactions
   - Attach Files
   - Embed Links
   - Create Public Threads
   - Send Messages in Threads
   - Manage Channels
   - Use Slash Commands
4. Copy the generated URL → open it in your browser → select your server → **Authorize**

### Step 4 — Run onboarding

```bash
tako onboard
```

When prompted for a Discord bot token, paste the token you copied in Step 1.

---

## Telegram

### Step 1 — Create a bot with BotFather

1. Open Telegram and search for **@BotFather**
2. Send `/newbot`
3. Follow the prompts — choose a name and username for your bot
4. BotFather will reply with your bot token — **copy it**

### Step 2 — Find your Telegram user ID (for access control)

Message **[@userinfobot](https://t.me/userinfobot)** on Telegram. It will reply with your numeric user ID. Keep this handy — `tako onboard` will ask for it to lock the bot to your account.

### Step 3 — Run onboarding

```bash
tako onboard
```

When prompted for a Telegram bot token, paste the token from Step 1.

---

## Multiple agents

Each agent (e.g. `code-agent`, `project-manager`) can have its own Discord bot. Just create a separate Discord application for each one and configure them via:

```
/setup
```

in Discord after Tako is running. See **[agent use cases in the README](../README.md#creating-agents)** for details.
