# Edge Dev Setup

Use this guide when one person wants to run their own Discord edge in development mode.

This guide uses:
- source checkout
- `/tmp` homes
- direct `bun run src/index.ts ...` commands

Do not start with `tako start` for this workflow. In development, use the source entrypoint directly so the running process always matches your local code.

## Example layout

- hub: `/tmp/tako-discord/hub`
- Shu edge: `/tmp/tako-discord/edge-a`
- Jiaxin edge: `/tmp/tako-discord/edge-jiaxin`

Ports:
- hub: `18790`
- edge-a: `18801`
- edge-jiaxin: `18802`

## 1. Clone and install

```bash
git clone https://github.com/Korde-AI/tako.git
cd tako
bun install
```

## 2. Onboard the edge

Example for Jiaxin:

```bash
bun run src/index.ts onboard --home /tmp/tako-discord/edge-jiaxin
```

During onboarding:
- choose your model/provider
- set Discord bot token
- set Anthropic auth if needed
- keep the edge home as `/tmp/tako-discord/edge-jiaxin`

## 3. Check the config

File:
- `/tmp/tako-discord/edge-jiaxin/tako.json`

Development example:

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
    "port": 18802
  },
  "memory": {
    "workspace": "workspace"
  },
  "network": {
    "hub": "http://127.0.0.1:18790",
    "heartbeatSeconds": 30
  }
}
```

## 4. Start the edge in development mode

Use the source entrypoint directly:

```bash
bun run src/index.ts start --home /tmp/tako-discord/edge-jiaxin --port 18802
```

This is the recommended development command.

Do the same pattern for any other edge:

```bash
bun run src/index.ts start --home /tmp/tako-discord/edge-a --port 18801
```

## 5. Start the hub

If you are using multi-edge collaboration:

```bash
bun run src/index.ts hub start --home /tmp/tako-discord/hub --port 18790
```

## 6. Restart after code changes

After pulling new code:

```bash
git pull
bun install
```

Then restart the running edge with the same `bun run src/index.ts start ...` command.

## 7. Verify

Edge:

```bash
bun run src/index.ts status --home /tmp/tako-discord/edge-jiaxin --json
bun run src/index.ts doctor --home /tmp/tako-discord/edge-jiaxin
```

Hub:

```bash
bun run src/index.ts hub status --home /tmp/tako-discord/hub --json
bun run src/index.ts hub nodes --home /tmp/tako-discord/hub --json
```

## 8. Discord test

In Discord:

```text
@jiaxinassistant who are you
```

Then in a project room:

```text
@jiaxinassistant what project is this channel bound to?
@jiaxinassistant sync your work tree
```

## Notes

- `/tmp` is fine for development and testing.
- `/tmp` is not durable across cleanup or reboot.
- for persistent hosting, move homes to a stable path later.
