# AGENTS.md — Tako Agent Engineering Protocol

This file defines the default working protocol for coding agents in this repository.
Scope: entire repository.

## 1) Project Snapshot (Read First)

Tako 🐙 is a TypeScript-first agent OS optimized for:

- minimal kernel with clear boundaries
- pluggable skill arms (everything beyond core is detachable)
- trait-based architecture (interfaces, not inheritance)
- developer velocity (TypeScript over Rust for iteration speed)
- research-ready for advanced agent workflows

**Philosophy:** Agent = CPU, conversation/tools = OS kernel, skills = pluggable arms.

Core architecture is **interface-driven and modular**. Most extension work should be done by implementing interfaces and registering in factory/registry modules.

Key extension points (interfaces):

- `src/providers/provider.ts` (`Provider`) — LLM inference routing
- `src/channels/channel.ts` (`Channel`) — messaging I/O
- `src/tools/tool.ts` (`Tool`) — agent syscalls
- `src/memory/store.ts` (`MemoryStore`) — persistence + recall
- `src/hooks/types.ts` (`HookSystem`) — lifecycle events
- `src/skills/types.ts` (`SkillManifest`) — pluggable skill arms

Reference architecture docs:

- `ARCHITECTURE.md` — design intent and system philosophy
- `docs/repo-structure.md` — current repository boundary map and refactor target
- reference runtime docs: `~/.nvm/versions/node/v22.22.0/lib/node_modules/reference-runtime/docs/`
- reference architecture repo: https://github.com/reference-arch-labs/reference-arch

## 2) Architecture Observations (Why This Protocol Exists)

These codebase realities should drive every design decision:

1. **Interface + registry architecture is the stability backbone**
    - Extension points are intentionally explicit and swappable.
    - Most features should be added via interface implementation + registry registration, not cross-cutting rewrites.

2. **Security-critical surfaces carry real-world blast radius**
    - `src/gateway/`, `src/tools/exec.ts`, `src/tools/fs.ts` can execute shell commands and modify files.
    - Defaults must lean secure-by-default (deny lists, sandboxing, explicit opt-in).

3. **Config and runtime contracts are user-facing API**
    - `src/config/schema.ts` and `tako.json` are effectively public interfaces.
    - Backward compatibility and explicit migration matter.

4. **Kernel tools vs skill arm tools is a deliberate boundary**
    - Kernel tools are organized into 10 groups across 3 profiles (minimal/coding/full).
    - Everything else is a pluggable skill arm — do NOT add tools to the kernel without strong justification.

5. **Always reference reference runtime and reference architecture**
    - Before designing any subsystem, re-read how both handle it.
    - reference runtime = battle-tested TypeScript reference. reference architecture = minimal Rust reference.
    - Learn, simplify, and differentiate — don't blindly copy.

## 3) Engineering Principles (Normative)

These principles are mandatory. They are implementation constraints, not slogans.

### 3.1 KISS (Keep It Simple, Stupid)

**Why here:** Agent runtimes must stay auditable. Users need to understand what's happening.

Required:

- Prefer straightforward control flow over clever meta-programming.
- Prefer explicit types and interfaces over hidden dynamic behavior.
- Keep error paths obvious and localized.
- Use `throw new Error()` with descriptive messages, not silent fallbacks.

### 3.2 YAGNI (You Aren't Gonna Need It)

**Why here:** Premature features bloat the kernel. Tako's value is in what it _doesn't_ include.

Required:

- Do not add new config keys, interface methods, or tool groups without a concrete use case.
- Do not introduce speculative abstractions without at least one current caller.
- If something could be a skill arm, it MUST be a skill arm (not kernel).

### 3.3 DRY + Rule of Three

**Why here:** Naive DRY creates brittle shared abstractions across providers/channels/tools.

Required:

- Duplicate small, local logic when it preserves clarity.
- Extract shared utilities only after repeated, stable patterns (rule-of-three).
- When extracting, preserve module boundaries and avoid hidden coupling.

### 3.4 SRP + ISP (Single Responsibility + Interface Segregation)

**Why here:** Interface-driven architecture encodes subsystem boundaries.

Required:

- Keep each module focused on one concern.
- Extend behavior by implementing existing narrow interfaces whenever possible.
- Avoid fat interfaces and "god modules" that mix policy + transport + storage.

### 3.5 Fail Fast + Explicit Errors

**Why here:** Silent fallback in agent runtimes creates unsafe or costly behavior.

Required:

- Prefer explicit `throw` for unsupported or unsafe states.
- Never silently broaden permissions/capabilities.
- Document fallback behavior when fallback is intentional and safe.

### 3.6 Secure by Default + Least Privilege

**Why here:** Gateway/tools/runtime execute actions with real-world side effects.

Required:

- Deny-by-default for access and exposure boundaries.
- Never log secrets, raw tokens, or sensitive payloads.
- Keep network/filesystem/shell scope as narrow as possible unless explicitly justified.

### 3.7 Reversibility + Small PRs

**Why here:** Fast recovery is mandatory; research projects iterate rapidly.

Required:

- Keep changes easy to revert (small scope, clear blast radius).
- One concern per PR; avoid mixed feature+refactor+infra patches.
- Avoid mega-patches that block safe rollback.

## 4) Repository Map (High-Level)

```
tako/
├── src/
│   ├── index.ts              # CLI entrypoint + command router
│   ├── gateway/              # WebSocket server + control plane
│   │   ├── gateway.ts        # Gateway daemon
│   │   ├── session.ts        # Session management
│   │   └── protocol.ts       # Wire protocol types
│   ├── core/                 # Agent orchestration
│   │   ├── agent-loop.ts     # The CPU cycle (intake → infer → tools → reply)
│   │   ├── prompt.ts         # System prompt assembly
│   │   ├── context.ts        # Context window management
│   │   └── cron.ts           # Cron/scheduler (at/every/cron schedules)
│   ├── providers/            # LLM provider adapters
│   │   ├── provider.ts       # Provider interface (THE CONTRACT)
│   │   ├── anthropic.ts      # Anthropic adapter (SSE streaming, key rotation)
│   │   ├── openai.ts         # OpenAI adapter
│   │   └── litellm.ts        # LiteLLM adapter (proxy, presets, dynamic models)
│   ├── channels/             # Messaging adapters
│   │   ├── channel.ts        # Channel interface (THE CONTRACT)
│   │   ├── cli.ts            # CLI/terminal
│   │   ├── tui.ts            # TUI (Ink/React terminal UI)
│   │   ├── discord.ts        # Discord (auto-threads, DMs, typing, partials)
│   │   └── telegram.ts       # Telegram (reactions, typing)
│   ├── tools/                # Agent syscalls (10 groups)
│   │   ├── tool.ts           # Tool interface (THE CONTRACT)
│   │   ├── registry.ts       # Registration + policy + groups
│   │   ├── policy.ts         # ToolPolicy for layered permission resolution
│   │   ├── fs.ts             # read/write/edit/apply_patch/list_directory/delete
│   │   ├── search.ts         # glob_search/content_search
│   │   ├── exec.ts           # exec/process
│   │   ├── exec-safety.ts    # Command allowlist matching
│   │   ├── memory.ts         # memory_search/memory_get/memory_store
│   │   ├── web.ts            # web_search/web_fetch
│   │   ├── image.ts          # image analysis (vision)
│   │   ├── git.ts            # git operations
│   │   ├── session.ts        # session management tools
│   │   ├── agent-tools.ts    # agents_list, sessions_spawn, subagents
│   │   ├── message.ts        # send_message, create/delete channels, reactions
│   │   ├── model.ts          # model_get/model_set (runtime switching)
│   │   ├── cron-tools.ts     # cron_add/remove/list/run
│   │   └── system-tools.ts   # system_restart with post-restart note
│   ├── memory/               # Persistence + recall
│   │   ├── store.ts          # MemoryStore interface (THE CONTRACT)
│   │   ├── markdown.ts       # Markdown file indexer
│   │   ├── vector.ts         # Embedding search
│   │   └── hybrid.ts         # BM25 + vector fusion
│   ├── hooks/                # Lifecycle events (14 events)
│   │   ├── types.ts          # Event types + handler interface
│   │   └── hooks.ts          # HookSystem implementation
│   ├── daemon/               # Background daemon management
│   │   ├── commands.ts       # start -d, stop, restart, status, tui, dev
│   │   └── pid.ts            # PID file tracking
│   ├── agents/               # Multi-agent system
│   │   └── roles.ts          # 5 predefined roles (admin → readonly)
│   ├── mods/                 # Mod system (shareable agent packages)
│   │   └── mod.ts            # mod list/use/install/create/remove/info
│   ├── onboard/              # Interactive setup wizard
│   │   ├── onboard.ts        # Full onboarding flow
│   │   ├── models.ts         # Model management CLI
│   │   └── channels.ts       # Channel management CLI
│   ├── doctor/               # Health checker
│   │   ├── doctor.ts         # Doctor runner
│   │   ├── checks/           # Individual check modules
│   │   └── repairs.ts        # Auto-repair actions
│   ├── skills/               # Skill arm loader
│   │   ├── types.ts          # Skill manifest types
│   │   └── loader.ts         # Discovery + loading
│   ├── sandbox/              # Docker-based sandboxing
│   └── config/               # Configuration
│       ├── schema.ts         # Config schema + defaults
│       └── resolve.ts        # Resolution + defaults
├── workspace/                # Default agent workspace templates
├── skills/                   # Built-in skill arms (4)
│   ├── find-skills/          # Discover + install skills
│   ├── skill-creator/        # Create new skills
│   ├── security-audit/       # Security scanning
│   └── skill-security-audit/ # Skill security audit (ClawHub)
├── Dockerfile                # Production container
├── docker-compose.yml        # Docker Compose deployment
├── package.json              # Node project config
└── tsconfig.json             # TypeScript config
```

## 5) Risk Tiers by Path

Use these tiers when deciding validation depth and review rigor.

- **Low risk**: docs, tests-only, workspace templates, skill content (SKILL.md)
- **Medium risk**: most `src/**` behavior changes without security impact (providers, channels, memory)
- **High risk**: `src/gateway/**`, `src/tools/exec.ts`, `src/tools/fs.ts`, `src/config/**`, access-control boundaries, tool policy

When uncertain, classify as higher risk.

## 6) Agent Workflow (Required)

1. **Read before write**
    - Inspect existing module, interface contracts, and adjacent files before editing.
    - Always check `ARCHITECTURE.md` for design intent.

2. **Check references**
    - Before implementing any subsystem, check how reference runtime and reference architecture handle it.
    - reference runtime docs: `~/.nvm/versions/node/v22.22.0/lib/node_modules/reference-runtime/docs/`
    - reference architecture: https://github.com/reference-arch-labs/reference-arch

3. **Define scope boundary**
    - One concern per change; avoid mixed feature+refactor patches.

4. **Implement minimal change**
    - Apply KISS/YAGNI/DRY rule-of-three explicitly.
    - If it could be a skill arm, make it a skill arm.

5. **Validate**
    - `npm run build` — must compile clean
    - `npm run lint` — must pass
    - `npm test` — must pass

6. **Commit hygiene**
    - Use conventional commit titles (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`, `chore:`)
    - Keep commits small and focused

### 6.1 Branch Flow

- Create and work from feature branches (`feat/`, `fix/`, `docs/`)
- PR to `main` by default
- Squash merge preferred for clean history

### 6.2 Interface Stability Contract

These interfaces are **public API** — changes require migration paths:

- `Provider` (`src/providers/provider.ts`)
- `Channel` (`src/channels/channel.ts`)
- `Tool` (`src/tools/tool.ts`)
- `MemoryStore` (`src/memory/store.ts`)
- `HookEvent` / `HookSystem` (`src/hooks/types.ts`)
- `TakoConfig` (`src/config/schema.ts`)
- `tako.json` config keys

Adding methods to interfaces is a **breaking change** for all implementers. Prefer optional methods or new companion interfaces.

## 7) Change Playbooks

### 7.1 Adding a Provider

- Implement `Provider` interface in `src/providers/<name>.ts`.
- Register in provider factory/resolution logic.
- Add focused tests for streaming, error handling, and model listing.
- Avoid provider-specific behavior leaks into shared orchestration code.

### 7.2 Adding a Channel

- Implement `Channel` interface in `src/channels/<name>.ts`.
- Keep `connect`, `disconnect`, `send`, `onMessage` semantics consistent.
- Cover auth/error/reconnect behavior with tests.

### 7.3 Adding a Kernel Tool

- **Think twice: should this be a skill arm instead?**
- Implement `Tool` interface in `src/tools/<name>.ts`.
- Register in `src/tools/registry.ts` with proper group assignment.
- Validate and sanitize all inputs.
- Return structured `ToolResult`; never throw in tool execution path (return error results).

### 7.4 Adding a Skill Arm

- Create `skills/<name>/SKILL.md` with trigger conditions, workflows, and instructions.
- If the skill provides tools, implement them in the skill directory.
- Register via the skill loader; do NOT modify kernel code.

### 7.5 Gateway / Security Changes

- Include threat/risk notes and rollback strategy.
- Add/update tests for failure modes and boundaries.
- Keep observability useful but non-sensitive.

## 8) Validation Matrix

Default local checks:

```bash
# Build
npm run build

# Lint
npm run lint

# Test
npm test

# Type check
npx tsc --noEmit

# Format check
npx prettier --check src/
```

Run all before PR:

```bash
npm run check  # runs build + lint + test
```

## 9) Naming Conventions

- Files/modules: `kebab-case.ts` or `camelCase.ts` (match existing pattern)
- Interfaces: `PascalCase` (`Provider`, `Channel`, `Tool`, `MemoryStore`)
- Types: `PascalCase` (`ChatRequest`, `ToolResult`, `HookEvent`)
- Functions: `camelCase` (`resolveConfig`, `buildPrompt`)
- Constants: `SCREAMING_SNAKE_CASE` (`DEFAULT_PORT`, `MAX_CONTEXT_TOKENS`)
- Config keys: `camelCase` in JSON (`primaryModel`, `gateway.port`)

## 10) Anti-Patterns (Do Not)

- Do not add heavy dependencies for minor convenience.
- Do not add tools to the kernel that could be skill arms.
- Do not silently weaken security policy or access constraints.
- Do not add speculative config flags "just in case".
- Do not mix formatting-only changes with functional changes.
- Do not modify unrelated modules "while here".
- Do not bypass failing checks without explicit explanation.
- Do not commit secrets, tokens, or API keys.
- Do not introduce node_modules into git.

## 11) Vibe Coding Guardrails

When working in fast iterative mode:

- Keep each iteration reversible (small commits, clear rollback).
- Validate assumptions with code search before implementing.
- Prefer deterministic behavior over clever shortcuts.
- Do not "ship and hope" on security-sensitive paths.
- If uncertain, leave a concrete TODO with verification context, not a hidden guess.
- Always check how reference runtime/reference architecture handle it before reinventing.

## 12) Handoff Template (Agent → Agent / Maintainer)

When handing off work, include:

1. What changed
2. What did not change
3. Validation run and results
4. Remaining risks / unknowns
5. Next recommended action
