# Tako 🐙 — Architecture

> Agent-as-CPU OS: minimal core + pluggable skill arms

## Philosophy

- **Agent = CPU**: the LLM is the processor, it executes instructions
- **Core = OS kernel**: providers, channels, tools, memory, gateway — the minimal runtime
- **Skills = pluggable arms**: everything beyond core is a tentacle that can be attached/detached

## ⚠️ Standing Reference Note

**Always keep looking at the original prompt/identification architecture of reference runtime and reference architecture.**

- **reference runtime docs:** `~/.nvm/versions/node/v22.22.0/lib/node_modules/reference-runtime/docs/`
  - Key files: `concepts/architecture.md`, `concepts/agent-loop.md`, `concepts/agent.md`, `concepts/memory.md`, `concepts/system-prompt.md`
  - Channels: `channels/index.md` — 20+ adapters, unified interface
  - Providers: `providers/index.md` — model routing, failover, key rotation
  - Tools: `tools/index.md` — tool profiles, allow/deny, plugin hooks
  - Gateway: `gateway/network-model.md`, `gateway/protocol.md` — WebSocket control plane
- **reference architecture repo:** https://github.com/reference-arch-labs/reference-arch
  - Trait-based architecture: providers, channels, tools, memory, tunnels — all swappable
  - Minimal kernel philosophy: lean binary, fast startup, low memory
  - Skills: https://github.com/reference-arch-labs/reference-arch/tree/dev/skills (find-skills + skill-creator)
  - Docs hub: https://github.com/reference-arch-labs/reference-arch/blob/dev/docs/README.md

**When designing any Tako subsystem, first re-read how reference runtime and reference architecture handle it. Don't reinvent — learn, simplify, and differentiate.**

**Prompt architecture is critical — always study:**
- **reference runtime prompt:** `docs/concepts/system-prompt.md` — how the system prompt is assembled (tooling, safety, skills, workspace files, runtime, heartbeats, reply tags)
- **reference architecture prompt:** `src/agent/prompt.rs` (496 lines) — Rust-based prompt builder, same core sections
- Both systems inject bootstrap files (SOUL.md, IDENTITY.md, AGENTS.md, etc.) into context
- Both use prompt modes: `full` (main session) vs `minimal` (sub-agents) vs `none`
- Tako must build its own prompt assembler following these patterns

## Design Principles

1. **Minimal kernel** — only what every agent needs, nothing more
2. **Trait-based** — every subsystem is an interface; swap implementations freely
3. **Clear boundaries** — each subsystem has one job, one interface, zero leakage
4. **Convention over config** — sane defaults, override when needed
5. **Markdown-first memory** — plain files are the source of truth
6. **Single binary mindset** — even in TS, think "one process, fast start"

## Core Subsystems (5 Traits)

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
│   browser │ cron │ canvas │ nodes │ ...     │
└─────────────────────────────────────────────┘
```

### 1. Provider (inference engine)

```typescript
interface Provider {
  id: string;
  chat(req: ChatRequest): AsyncIterable<ChatChunk>;
  models(): ModelInfo[];
  supports(capability: string): boolean;
}
```

- Model routing via `provider/model` refs
- Key rotation + failover
- Streaming-first (AsyncIterable)
- Built-in: Anthropic, OpenAI, LiteLLM (universal proxy to 100+ providers)
- Custom: any OpenAI-compatible endpoint via LiteLLM

### 2. Channel (messaging I/O)

```typescript
interface Channel {
  id: string;
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  send(msg: OutboundMessage): Promise<void>;
  onMessage(handler: MessageHandler): void;
}
```

- One interface, many adapters (Discord, Telegram, CLI, WebChat)
- Channels run simultaneously through Gateway
- Each channel handles its own auth/pairing
- Built-in: Discord, Telegram, CLI
- Plugin: everything else

### 3. Tool (agent syscalls)

```typescript
interface Tool {
  name: string;
  description: string;
  parameters: JSONSchema;
  execute(params: unknown, ctx: ToolContext): Promise<ToolResult>;
}
```

- Core tools baked into kernel (fs, exec, memory)
- Skill arms register additional tools at runtime
- Tool policy: allow/deny lists per agent
- Tool groups: `group:fs`, `group:runtime`, `group:memory`, `group:web`, `group:search`, `group:sessions`
- Tool profiles: `minimal` | `coding` | `full`

**Tool Classification (informed by reference runtime + reference architecture):**

#### 🔴 KERNEL tools (always available, baked in)

| Tako Tool | reference runtime equiv | reference architecture equiv | Purpose |
|-----------|---------------|----------------|---------|
| `read` | `read` | `file_read.rs` | Read file contents |
| `write` | `write` | `file_write.rs` | Create/overwrite files |
| `edit` | `edit` | `file_edit.rs` | Surgical text replacement |
| `apply_patch` | `apply_patch` | `apply_patch.rs` | Multi-hunk file patches |
| `exec` | `exec` | `shell.rs` | Run shell commands |
| `process` | `process` | `process.rs` | Manage background processes |
| `memory_search` | `memory_search` | `memory_recall.rs` | Semantic memory recall |
| `memory_get` | `memory_get` | — | Read specific memory file/lines |
| `memory_store` | — (write to file) | `memory_store.rs` | Explicit memory write |
| `web_search` | `web_search` | — | Search the internet |
| `web_fetch` | `web_fetch` | `http_request.rs` | Fetch URL content |
| `glob_search` | — | `glob_search.rs` | Find files by pattern |
| `content_search` | — | `content_search.rs` | Grep/search inside files |
| `session_status` | `session_status` | — | Introspection (usage, time, model) |
| `image` | `image` | `image_info.rs` | Vision/image analysis |

#### 🟡 CORE EXTENSIONS (available by default, can be disabled)

| Tako Tool | Source ref | Purpose |
|-----------|-----------|---------|
| `git` | reference architecture `git_operations.rs` | Git operations (status, diff, commit) |
| `sessions_list` | reference runtime | List active sessions |
| `sessions_send` | reference runtime | Send message to another session |
| `sessions_spawn` | reference runtime | Spawn sub-agent |

#### 🟢 SKILL ARM tools (pluggable, not in kernel)

| Category | Tools | Source ref |
|----------|-------|-----------|
| **Browser** | browser, screenshot | reference runtime `browser`, reference architecture `browser.rs` + `screenshot.rs` |
| **Canvas** | canvas, a2ui | reference runtime `canvas` |
| **Messaging** | message (send/react/poll/thread) | reference runtime `message` |
| **Scheduling** | cron (add/list/run/remove) | reference runtime `cron`, reference architecture `cron_*.rs` + `schedule.rs` |
| **Nodes/Devices** | nodes (camera/screen/notify) | reference runtime `nodes` |
| **Gateway** | gateway (restart/config/update) | reference runtime `gateway` |
| **SOP** | sop (execute/advance/approve) | reference architecture `sop_*.rs` |
| **Hardware** | board_info, memory_map | reference architecture `hardware_*.rs` |
| **Integrations** | composio, pushover | reference architecture `composio.rs`, `pushover.rs` |
| **PDF** | pdf_read | reference architecture `pdf_read.rs` |
| **Delegation** | delegate, coordination | reference architecture `delegate.rs` |
| **TTS** | tts | reference runtime `tts` |

**Everything in 🟢 = loaded only when the corresponding skill arm is installed.**

### 4. Memory (persistence + recall)

```typescript
interface MemoryStore {
  search(query: string, opts?: SearchOpts): Promise<Snippet[]>;
  get(path: string, range?: LineRange): Promise<string>;
  index(path: string): Promise<void>;
}
```

- Markdown files = source of truth
- `MEMORY.md` — long-term curated
- `memory/YYYY-MM-DD.md` — daily append-only log
- Vector search: embeddings + BM25 hybrid
- Pre-compaction auto-flush

### 5. Gateway (control plane)

```typescript
interface Gateway {
  start(config: GatewayConfig): Promise<void>;
  stop(): Promise<void>;
  // WebSocket API
  handleConnect(client: Client): void;
  handleRequest(req: Request): Promise<Response>;
  // Event bus
  emit(event: GatewayEvent): void;
  on(event: string, handler: EventHandler): void;
}
```

- Single long-lived daemon process
- WebSocket protocol for all clients
- Session management (create, resume, compact)
- Agent loop orchestration
- Auth + device pairing

## Hooks (simple lifecycle events)

Tako includes a **minimal hook system** for intercepting key lifecycle events. Inspired by reference runtime's plugin hooks but stripped to essentials.

```typescript
interface HookSystem {
  on(event: HookEvent, handler: HookHandler): void;
  off(event: HookEvent, handler: HookHandler): void;
  emit(event: HookEvent, ctx: HookContext): Promise<void>;
}

type HookEvent =
  // Agent lifecycle
  | 'before_prompt_build'    // Inject context before prompt submission
  | 'agent_start'            // Agent loop starting
  | 'agent_end'              // Agent loop completed
  // Tool lifecycle
  | 'before_tool_call'       // Intercept tool params before execution
  | 'after_tool_call'        // Inspect/transform tool results
  // Session lifecycle
  | 'session_start'          // New session created
  | 'session_end'            // Session closed
  // Message lifecycle
  | 'message_received'       // Inbound message from any channel
  | 'message_sending'        // Outbound message about to send
  // Gateway lifecycle
  | 'gateway_start'          // Gateway daemon started
  | 'gateway_stop';          // Gateway daemon stopping
```

**Design rules:**
- Hooks are sync-first (async allowed but don't block the loop unless critical)
- Hooks can modify context (e.g. `before_prompt_build` can inject system prompt additions)
- Hooks can inspect but NOT block tool calls (use tool policy for that)
- Skill arms can register hooks when loaded
- No complex priority/ordering — hooks fire in registration order

**Reference:**
- reference runtime: `docs/automation/hooks.md` + `docs/tools/plugin.md` (plugin hooks section)
- reference runtime hooks: `before_model_resolve`, `before_prompt_build`, `before_agent_start`, `agent_end`, `before_tool_call`, `after_tool_call`, `message_received`, `message_sending`, `session_start`, `session_end`, `gateway_start`, `gateway_stop`

## Doctor (kernel health checker)

Tako includes a built-in `tako doctor` command for diagnosing and repairing the runtime. Inspired by `reference-runtime doctor`.

```bash
tako doctor          # Interactive health check
tako doctor --yes    # Auto-accept repairs
tako doctor --deep   # Full system scan
```

**Health checks:**
- **Config validation:** parse `tako.json`, detect invalid/deprecated keys, suggest fixes
- **Provider connectivity:** test API key validity + model availability for each configured provider
- **Channel status:** verify Discord bot token, Telegram bot token, etc.
- **Memory health:** check workspace exists, memory files readable, vector index integrity
- **Session integrity:** verify session store, transcript files, detect corruption
- **Tool availability:** confirm core tools functional (fs access, shell, web connectivity)
- **Skill status:** list installed skills, check for updates, detect broken skill manifests
- **Gateway health:** port availability, auth token status, WebSocket connectivity
- **Permissions:** file permissions on config, workspace, credentials

**Repair actions:**
- Normalize deprecated config keys
- Recreate missing workspace directories/files
- Rebuild corrupted vector index
- Fix file permissions (config → 600, workspace → writable)
- Generate missing auth tokens

**Reference:**
- reference runtime: `docs/gateway/doctor.md` — full doctor command with config migrations, state integrity, supervisor audit, sandbox repair
- reference runtime doctor checks: state dir, session persistence, transcript mismatch, config normalization, legacy migrations, auth health, channel probing, service detection

## Agent Loop (the CPU cycle)

```
1. Message arrives (from any Channel)
2. Session resolved (or created)
3. Context assembled:
   - System prompt (SOUL.md, IDENTITY.md, AGENTS.md)
   - Bootstrap files (workspace context)
   - Skill instructions (loaded SKILL.md files)
   - Conversation history
   - Memory recall (if triggered)
4. Provider.chat() called (streaming)
5. Tool calls executed (if any)
6. Response streamed back through Channel
7. Session persisted
8. Memory updated (if needed)
```

## Project Structure

```
tako/
├── src/
│   ├── index.ts              # Entry point
│   ├── gateway/
│   │   ├── gateway.ts        # WebSocket server + control plane
│   │   ├── session.ts        # Session management
│   │   └── protocol.ts       # Wire protocol types
│   ├── core/
│   │   ├── agent-loop.ts     # The CPU cycle
│   │   ├── prompt.ts         # System prompt assembly
│   │   └── context.ts        # Context window management
│   ├── providers/
│   │   ├── provider.ts       # Provider trait/interface
│   │   ├── anthropic.ts      # Anthropic adapter (native)
│   │   ├── openai.ts         # OpenAI adapter (native)
│   │   └── litellm.ts        # LiteLLM adapter (proxy to 100+ providers)
│   ├── channels/
│   │   ├── channel.ts        # Channel trait/interface
│   │   ├── discord.ts        # Discord adapter
│   │   ├── telegram.ts       # Telegram adapter
│   │   └── cli.ts            # CLI/terminal adapter
│   ├── tools/
│   │   ├── tool.ts           # Tool trait/interface
│   │   ├── registry.ts       # Tool registration + policy + groups
│   │   ├── fs.ts             # read/write/edit/apply_patch
│   │   ├── search.ts         # glob_search/content_search
│   │   ├── exec.ts           # exec/process
│   │   ├── memory.ts         # memory_search/memory_get/memory_store
│   │   ├── web.ts            # web_search/web_fetch
│   │   ├── image.ts          # image analysis (vision)
│   │   ├── git.ts            # git operations (core extension)
│   │   └── session.ts        # session_status/sessions_list/send/spawn
│   ├── memory/
│   │   ├── store.ts          # MemoryStore trait/interface
│   │   ├── markdown.ts       # Markdown file indexer
│   │   ├── vector.ts         # Embedding + vector search
│   │   └── hybrid.ts         # BM25 + vector fusion
│   ├── hooks/
│   │   ├── hooks.ts          # HookSystem implementation
│   │   └── types.ts          # HookEvent + HookContext types
│   ├── doctor/
│   │   ├── doctor.ts         # Health check runner
│   │   ├── checks/           # Individual health check modules
│   │   │   ├── config.ts     # Config validation
│   │   │   ├── providers.ts  # Provider connectivity
│   │   │   ├── channels.ts   # Channel status
│   │   │   ├── memory.ts     # Memory/workspace health
│   │   │   ├── sessions.ts   # Session integrity
│   │   │   └── permissions.ts # File permissions
│   │   └── repairs.ts        # Auto-repair actions
│   ├── skills/
│   │   ├── loader.ts         # Skill discovery + loading
│   │   └── types.ts          # Skill manifest types
│   └── config/
│       ├── schema.ts         # Config schema (TypeBox)
│       └── resolve.ts        # Config resolution + defaults
├── workspace/                 # Default agent workspace
│   ├── AGENTS.md
│   ├── SOUL.md
│   ├── IDENTITY.md
│   ├── USER.md
│   ├── TOOLS.md
│   └── memory/
├── skills/                    # Built-in skill arms (minimal set)
│   ├── find-skills/           # Discover + install skills from skills.sh ecosystem
│   │   └── SKILL.md           # Source: https://skills.sh/vercel-labs/skills/find-skills
│   └── skill-creator/         # Create new skills + iterative improvement workflow
│       └── SKILL.md           # Source: https://skills.sh/anthropics/skills/skill-creator
├── tako.json                  # Config file
├── package.json
├── tsconfig.json
└── README.md
```

## Config (tako.json)

```json5
{
  // Provider config
  providers: {
    primary: "anthropic/claude-sonnet-4-20250514",
    // keys from env: ANTHROPIC_API_KEY, OPENAI_API_KEY, etc.
  },

  // Channel config
  channels: {
    discord: { token: "..." },
    telegram: { token: "..." },
  },

  // Tool policy
  tools: {
    profile: "full",  // minimal | coding | full
    deny: [],
  },

  // Memory
  memory: {
    workspace: "~/.tako/workspace",
    embeddings: { provider: "openai" },
  },

  // Gateway
  gateway: {
    bind: "127.0.0.1",
    port: 18790,  // different from reference runtime default
  },

  // Agent defaults
  agent: {
    timeout: 600,
    thinking: "adaptive",
  },
}
```

## Built-in Skills (2 only — the meta-skills)

Tako ships with exactly **2 built-in skills** — both are meta-skills that bootstrap the ecosystem:

### 1. `find-skills` (from skills.sh / vercel-labs)
- Discovers and installs skills from the open agent skills ecosystem
- Uses `npx skills find [query]` / `npx skills add <owner/repo@skill>`
- Browse: https://skills.sh/
- This is how Tako grows new arms 🐙

### 2. `skill-creator` (from skills.sh / anthropics)
- Creates new skills from scratch with iterative improvement
- Captures intent → interviews → drafts → tests → evaluates → refines
- Generates proper SKILL.md with trigger conditions and workflows
- This is how Tako builds custom arms

**Philosophy:** Tako doesn't ship with 50 skills. It ships with the ability to **find** and **create** any skill it needs. Two meta-skills > a hundred static ones.

## Skill Extensions (Pluggable Subsystems)

Skills aren't limited to tools and instructions — they can provide **entire subsystem implementations**. This is what makes Tako a platform, not just an app.

### Extension Types

| Type | Subdirectory | Interface | Factory | Use Case |
|------|-------------|-----------|---------|----------|
| Channel | `channel/` | `Channel` | `createChannel(config)` | Feishu, WeChat, LINE, Matrix, Slack |
| Provider | `provider/` | `Provider` | `createProvider(config)` | Ollama, vLLM, Together, Groq |
| Memory | `memory/` | `MemoryStore` | `createMemory(config)` | Qdrant, Pinecone, Chroma, Redis |
| Network | `network/` | `NetworkAdapter` | `createNetwork(config)` | Tailscale, Cloudflare, ngrok |
| Sandbox | `sandbox/` | `SandboxProvider` | `createSandbox(config)` | Docker, Firecracker, nsjail |
| Auth | `auth/` | `AuthProvider` | `createAuth(config)` | OAuth2, LDAP, SAML |

### Skill Structure

```
skills/my-skill/
├── SKILL.md              # Metadata + instructions
├── channel/index.ts      # Channel adapter (optional)
├── provider/index.ts     # Provider adapter (optional)
├── memory/index.ts       # Memory backend (optional)
├── network/index.ts      # Network adapter (optional)
├── sandbox/index.ts      # Sandbox provider (optional)
├── auth/index.ts         # Auth provider (optional)
├── tools/                # Agent tools (optional)
│   └── my-tools.ts
└── package.json          # Dependencies
```

A single skill can provide multiple extension types. For example, a "feishu" skill might provide both a channel adapter AND feishu-specific tools.

### Configuration

```json
{
  "skillExtensions": {
    "feishu": {
      "channel": { "appId": "cli_xxx", "appSecret": "xxx" }
    },
    "ollama": {
      "provider": { "baseUrl": "http://localhost:11434", "models": ["llama3", "codellama"] }
    },
    "qdrant-memory": {
      "memory": { "url": "http://localhost:6333", "collection": "tako" }
    }
  }
}
```

### Extension Lifecycle

1. **Discovery**: Skill loader scans skill directories for extension subdirectories
2. **Loading**: Extension loader imports factory modules and creates instances
3. **Registration**: Instances are registered in the ExtensionRegistry
4. **Integration**: Gateway wires extensions into the appropriate subsystem
5. **Hot-reload**: When skill files change, extensions are unregistered and reloaded

## What Tako Does NOT Include (vs reference runtime)

- No 20+ channel adapters at launch (start with Discord + Telegram + CLI)
- No browser automation in kernel (skill arm)
- No canvas/A2UI in kernel (skill arm)
- No node device management in kernel (skill arm)
- No cron scheduler in kernel (skill arm)
- No TTS in kernel (skill arm)
- No complex plugin hook system at v1 (add later)
- No multi-agent ACP runtime at v1 (add later)

## Milestones

### v0.1 — Heartbeat
- [ ] Project scaffolding (TS, ESM, tsconfig)
- [ ] Config loading (tako.json)
- [ ] Single provider (Anthropic)
- [ ] Single channel (CLI)
- [ ] Core tools (read/write/exec)
- [ ] Basic agent loop (no streaming yet)
- [ ] Built-in skills: find-skills + skill-creator
- [ ] "Hello Tako" working end-to-end

### v0.2 — Memory
- [ ] Workspace bootstrap files
- [ ] Markdown memory (read/write)
- [ ] Vector search (embeddings)
- [ ] Memory tools (search/get)

### v0.3 — Channels
- [ ] Discord adapter
- [ ] Telegram adapter
- [ ] Multi-channel routing

### v0.4 — Gateway + Health
- [ ] WebSocket server
- [ ] Session management
- [ ] Streaming responses
- [ ] `tako doctor` — basic health checks (config, providers, workspace)
- [ ] Simple hook system (agent lifecycle + tool lifecycle)

### v0.5 — Skill Arms
- [ ] Skill loader (SKILL.md discovery)
- [ ] Tool registration from skills
- [ ] First external skill arm

### v1.0 — Tako Ships 🐙
- [ ] Stable trait interfaces
- [ ] Documentation
- [ ] npm publish
