# Task: Scaffold Tako Project Structure

You are scaffolding the Tako 🐙 agent OS project. Read ARCHITECTURE.md first — it is the source of truth.

## What to build

Create the FULL project structure with well-documented skeleton files. Every file should have:
- Proper TypeScript interfaces/types matching ARCHITECTURE.md
- JSDoc comments explaining purpose
- TODO markers for implementation
- Exports that wire up correctly

## Specific files to create:

### 1. Project config
- `package.json` — name: "tako", type: "module", scripts (build, dev, start, doctor), dependencies (placeholder versions ok)
- `tsconfig.json` — strict, ESM, target ES2022, module NodeNext
- `.gitignore`
- `README.md` — Tako branding, quick start, architecture overview

### 2. Core interfaces (THE MOST IMPORTANT — get these right)
- `src/providers/provider.ts` — Provider interface + ChatRequest/ChatChunk/ModelInfo types
- `src/channels/channel.ts` — Channel interface + InboundMessage/OutboundMessage types
- `src/tools/tool.ts` — Tool interface + ToolContext/ToolResult/JSONSchema types
- `src/memory/store.ts` — MemoryStore interface + Snippet/SearchOpts/LineRange types
- `src/hooks/types.ts` — HookEvent union type + HookContext + HookHandler types

### 3. Implementation skeletons (with TODOs)
- `src/index.ts` — entry point
- `src/gateway/gateway.ts` — Gateway class skeleton
- `src/gateway/session.ts` — SessionManager skeleton
- `src/gateway/protocol.ts` — wire protocol types
- `src/core/agent-loop.ts` — AgentLoop class with the CPU cycle
- `src/core/prompt.ts` — PromptBuilder (system prompt assembly)
- `src/core/context.ts` — ContextManager (window management)
- `src/providers/anthropic.ts` — AnthropicProvider skeleton
- `src/providers/openai.ts` — OpenAIProvider skeleton
- `src/providers/litellm.ts` — LiteLLMProvider skeleton
- `src/channels/cli.ts` — CLIChannel skeleton
- `src/channels/discord.ts` — DiscordChannel skeleton
- `src/channels/telegram.ts` — TelegramChannel skeleton
- `src/tools/registry.ts` — ToolRegistry with groups + profiles + allow/deny
- `src/tools/fs.ts` — read/write/edit/apply_patch tool implementations
- `src/tools/search.ts` — glob_search/content_search
- `src/tools/exec.ts` — exec/process tools
- `src/tools/memory.ts` — memory_search/memory_get/memory_store tools
- `src/tools/web.ts` — web_search/web_fetch tools
- `src/tools/image.ts` — image analysis tool
- `src/tools/git.ts` — git operations tool
- `src/tools/session.ts` — session_status/sessions_list/send/spawn
- `src/memory/markdown.ts` — Markdown file indexer
- `src/memory/vector.ts` — Vector embedding search
- `src/memory/hybrid.ts` — BM25 + vector fusion
- `src/hooks/hooks.ts` — HookSystem implementation
- `src/doctor/doctor.ts` — Doctor runner
- `src/doctor/checks/*.ts` — individual health checks
- `src/doctor/repairs.ts` — auto-repair actions
- `src/skills/loader.ts` — Skill loader
- `src/skills/types.ts` — Skill manifest types
- `src/config/schema.ts` — Config schema
- `src/config/resolve.ts` — Config resolution

### 4. Workspace templates
- `workspace/AGENTS.md` — default operating instructions
- `workspace/SOUL.md` — default persona
- `workspace/IDENTITY.md` — default identity
- `workspace/USER.md` — user profile template
- `workspace/TOOLS.md` — tool notes template

### 5. Built-in skills
- `skills/find-skills/SKILL.md` — find-skills skill content
- `skills/skill-creator/SKILL.md` — skill-creator skill content

### 6. Default config
- `tako.json` — example config with comments

## Quality standards
- All interfaces must match ARCHITECTURE.md exactly
- Use proper TypeScript generics where appropriate
- Every file must compile (no syntax errors)
- Consistent code style (2-space indent, semicolons, single quotes)
- Group related types in the same file as their interface
