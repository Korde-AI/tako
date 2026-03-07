# Skill-Loaded Channels

Skills can provide channel adapters, letting Tako connect to any messaging
platform without modifying the kernel.

## Skill structure

```
skills/feishu/
├── SKILL.md              # Frontmatter + instructions
├── channel/
│   └── index.ts          # exports createChannel(config) → Channel
├── tools/                # Optional tools
│   └── feishu-tools.ts
└── package.json          # Platform SDK dependency
```

## SKILL.md

```yaml
---
name: feishu
description: Feishu/Lark messaging channel
user-invocable: false
requires: {"env": ["FEISHU_APP_ID", "FEISHU_APP_SECRET"]}
---
```

## Channel module

```typescript
// channel/index.ts
import type { Channel, InboundMessage, OutboundMessage, MessageHandler } from 'tako/channels/channel';

export function createChannel(config: { appId: string; appSecret: string }): Channel {
  return new FeishuChannel(config);
}

class FeishuChannel implements Channel {
  id = 'feishu';
  private handler: MessageHandler | null = null;

  constructor(private config: { appId: string; appSecret: string }) {}

  async connect(): Promise<void> {
    // Connect to Feishu API, start webhook listener, etc.
  }

  async disconnect(): Promise<void> {
    // Clean up connections
  }

  async send(msg: OutboundMessage): Promise<void> {
    // Send message via Feishu API
  }

  onMessage(handler: MessageHandler): void {
    this.handler = handler;
  }
}
```

## Configuration (tako.json)

```json
{
  "skillChannels": {
    "feishu": {
      "appId": "cli_xxx",
      "appSecret": "secret"
    }
  }
}
```

## How it works

1. The skill loader discovers skills with a `channel/` subdirectory and sets
   `hasChannel: true` on the manifest.

2. During startup, after all built-in channels (CLI, Discord, Telegram) are
   connected, Tako iterates loaded skills and calls `loadChannelFromSkill()`
   for each skill with `hasChannel`.

3. The channel module's `createChannel(config)` function is called with
   configuration from `skillChannels.<name>` in `tako.json`.

4. The returned `Channel` instance is wired into the same message router as
   built-in channels — it receives the same message handling, session
   management, and command routing.

5. The gateway also exposes `registerChannel()` / `unregisterChannel()` for
   skills that need to register channels dynamically at runtime via hooks
   (e.g., on `gateway_start`).

## Dynamic registration via hooks

Skills can also register channels at runtime through the hook system:

```typescript
// In a skill's hook handler
hooks.on('gateway_start', async (ctx) => {
  const { registerChannel } = ctx.data;
  const channel = createMyChannel(config);
  await registerChannel(channel);
});
```

The `gateway_start` hook context includes:
- `gateway` — the Gateway instance
- `registerChannel(channel)` — register and connect a channel
- `unregisterChannel(id)` — disconnect and remove a channel
- `config` — gateway configuration
