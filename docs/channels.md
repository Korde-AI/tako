# Channels

Channels are messaging I/O adapters that connect Tako to different platforms. Multiple channels run simultaneously.

## CLI (Built-in)

Terminal readline interface. Always active.

**Configuration:**
```json
{
  "channels": {
    "cli": {
      "prompt": "tako> "
    }
  }
}
```

**Features:**
- Streaming output (chunks written to stdout in real-time)
- `/quit` and `/exit` commands to stop
- Serialized message handling (no overlapping executions)

## TUI (Built-in)

Terminal UI built with Ink/React. Attach to a running daemon or run standalone.

**Launch:**
```bash
tako tui          # Attach to running daemon
```

**Features:**
- Real-time streaming output
- Image attachment support
- Tab-completion for commands
- Active agent display in header
- Bot name masking for privacy

## Discord (Built-in)

Discord bot via discord.js.

**Configuration:**
```json
{
  "channels": {
    "discord": {
      "token": "your-bot-token",
      "guilds": ["guild-id-1", "guild-id-2"]
    }
  }
}
```

**Features:**
- Auto-create threads for replies (reference runtime-style)
- DM support (via Partials.Channel + Partials.Message)
- Typing indicators (configurable via `agent.typingMode`)
- Automatic message splitting (Discord's 2000 char limit)
- Auto-reconnect with exponential backoff (up to 5 attempts)
- Guild filtering (optional — respond only in specific servers)
- Attachment extraction (images, files)
- Sender name shown in messages: `[From: name]`

**Setup:**
1. Create a bot at [Discord Developer Portal](https://discord.com/developers/applications)
2. Enable Message Content Intent
3. Invite bot to your server with message permissions
4. Set the token via `tako onboard` or `tako channels`

## Telegram (Built-in)

Telegram bot via grammY.

**Configuration:**
```json
{
  "channels": {
    "telegram": {
      "token": "your-bot-token",
      "allowedUsers": ["username1", "username2"]
    }
  }
}
```

**Features:**
- Long polling (non-blocking)
- Typing indicators (configurable via `agent.typingMode`)
- Reactions support
- Markdown formatting with fallback to plain text
- Max 4096 chars per message (Telegram limit)
- User filtering (optional — respond only to specific users)
- Supports photos, documents, audio, video attachments
- Sender name shown in messages: `[From: name]`

**Setup:**
1. Create a bot via [@BotFather](https://t.me/BotFather)
2. Get the token
3. Set via `tako onboard` or `tako channels`

## Custom Channels

Implement the `Channel` interface in `src/channels/channel.ts`:

```typescript
import type { Channel, OutboundMessage, MessageHandler, InboundMessage } from './channel.js';

export class MyChannel implements Channel {
  id = 'my-channel';
  private handler?: MessageHandler;

  async connect(): Promise<void> {
    // Connect to your platform
  }

  async disconnect(): Promise<void> {
    // Clean up
  }

  async send(msg: OutboundMessage): Promise<void> {
    // Send message to your platform
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }
}
```

## Multi-Channel Routing

When multiple channels are active, Tako routes messages independently:

- Each channel + author pair gets its own session
- Sessions are keyed by `channelId:authorId`
- The agent loop runs per-message, streaming output back through the originating channel
- CLI streams to stdout; other channels send the complete response
