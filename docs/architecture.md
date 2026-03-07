# Architecture

Tako follows an **Agent-as-CPU** design: the LLM is the processor, the core runtime is the OS kernel, and skills are pluggable arms.

## Design Principles

1. **Minimal kernel** — only what every agent needs, nothing more
2. **Trait-based** — every subsystem is an interface; swap implementations freely
3. **Clear boundaries** — each subsystem has one job, one interface, zero leakage
4. **Convention over config** — sane defaults, override when needed
5. **Markdown-first memory** — plain files are the source of truth
6. **Single binary mindset** — one process, fast start

## System Diagram

```
┌─────────────────────────────────────────────┐
│                  Tako Gateway                │
│            (WebSocket control plane)         │
├──────┬──────┬──────┬──────┬────────────────┤
│ Prov │ Chan │ Tool │ Mem  │    Session      │
│ ider │ nel  │      │ ory  │    Manager      │
├──────┴──────┴──────┴──────┴────────────────┤
│              Agent Loop                      │
│   intake → context → infer → tools → reply  │
├─────────────────────────────────────────────┤
│           Skill Arms (pluggable)             │
│  find-skills │ skill-creator │ your-skill  │
└─────────────────────────────────────────────┘
```

## Core Subsystems

### 1. Provider (inference engine)

Adapts LLM APIs into a unified streaming interface. Each provider handles:
- API authentication and key rotation
- Message format conversion
- Streaming response parsing
- Model capability detection

Interface: `src/providers/provider.ts`

### 2. Channel (messaging I/O)

Adapts messaging platforms into a unified message handler. Multiple channels run simultaneously. Each handles:
- Platform connection and authentication
- Message format conversion
- Rate limiting and message splitting
- Reconnection and error recovery

Interface: `src/channels/channel.ts`

### 3. Tool (agent syscalls)

Named functions the model can invoke during generation. Organized into groups, activated by profiles:
- **Kernel tools**: organized into 10 groups across 3 profiles
- **Skill tools**: registered at runtime by skill arms
- **Policy**: deny/allow lists override profile defaults

Interface: `src/tools/tool.ts`

### 4. MemoryStore (persistence + recall)

Hybrid search over the agent's markdown memory:
- **BM25**: keyword matching with TF-IDF scoring and temporal decay
- **Vector**: semantic similarity via embeddings (OpenAI or Voyage)
- **Fusion**: Reciprocal Rank Fusion combines both result sets

Interface: `src/memory/store.ts`

### 5. HookSystem (lifecycle events)

Simple event emitter for intercepting agent lifecycle moments:
- Agent start/end, prompt build
- Tool call before/after
- Session start/end
- Message received/sending
- Gateway start/stop

Interface: `src/hooks/types.ts`

## Agent Loop

The CPU cycle runs for each user message:

1. **Message arrives** from any channel
2. **Session resolved** (or created) based on channel + author
3. **System prompt assembled** from workspace files + matching skill instructions
4. **Provider.chat()** called with streaming
5. **Tool calls executed** (up to 50 per turn, configurable `maxTurns` default 20)
6. **Response streamed** back through the originating channel
7. **Session persisted** to disk

Dynamic skill injection happens at step 3: the loader checks each skill's trigger conditions against the user message and injects matching skill instructions into the prompt.

## Gateway

The WebSocket server manages:
- Client authentication
- Session create/resume/list
- Streaming agent responses as chunks
- Tool call notifications

Protocol: `src/gateway/protocol.ts`

## Skill Extensions (Pluggable Subsystems)

Skills can provide entire subsystem implementations via extension subdirectories:

| Type | Subdirectory | Interface | Factory |
|------|-------------|-----------|---------|
| Channel | `channel/` | `Channel` | `createChannel(config)` |
| Provider | `provider/` | `Provider` | `createProvider(config)` |
| Memory | `memory/` | `MemoryStore` | `createMemory(config)` |
| Network | `network/` | `NetworkAdapter` | `createNetwork(config)` |
| Sandbox | `sandbox/` | `SandboxProvider` | `createSandbox(config)` |
| Auth | `auth/` | `AuthProvider` | `createAuth(config)` |

Extensions are auto-detected during skill loading, configured via `skillExtensions` in tako.json, and tracked at runtime in the `ExtensionRegistry`.

See `src/skills/extensions.ts` for interfaces and `src/skills/extension-loader.ts` for the loader.

## Memory Hierarchy

- **MEMORY.md** — curated long-term memory, always in system prompt
- **Daily logs** (memory/YYYY-MM-DD.md) — append-only, accessed via search
- **Bootstrap files** — SOUL.md, IDENTITY.md, AGENTS.md, USER.md, TOOLS.md, HEARTBEAT.md
