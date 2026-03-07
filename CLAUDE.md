# CLAUDE.md — Tako Agent Engineering Protocol (Claude Code)

This file is auto-read by Claude Code when working in this repository.
It mirrors `AGENTS.md` with Claude-specific additions.

**Read `AGENTS.md` first** — it is the canonical engineering protocol.

## Quick Reference for Claude Code

### Build & Validate

```bash
npm run build          # TypeScript compilation
npm run lint           # ESLint
npm test              # Tests
npx tsc --noEmit      # Type check only
npx prettier --check src/  # Format check
```

### Key Interfaces (read these first when working on a subsystem)

| Subsystem | Interface file | Interface name |
|-----------|---------------|----------------|
| Providers | `src/providers/provider.ts` | `Provider` |
| Channels | `src/channels/channel.ts` | `Channel` |
| Tools | `src/tools/tool.ts` | `Tool` |
| Memory | `src/memory/store.ts` | `MemoryStore` |
| Hooks | `src/hooks/types.ts` | `HookSystem`, `HookEvent` |
| Config | `src/config/schema.ts` | `TakoConfig` |
| Skills | `src/skills/types.ts` | `SkillManifest` |

### Architecture Documents

- `ARCHITECTURE.md` — full design with interfaces, tool classification, milestones
- `AGENTS.md` — engineering protocol (you're reading the Claude-specific version)

### Reference Systems (always check before designing)

- **reference runtime** (TypeScript, battle-tested): `~/.nvm/versions/node/v22.22.0/lib/node_modules/reference-runtime/docs/`
- **reference architecture** (Rust, minimal): https://github.com/reference-arch-labs/reference-arch

### Tool Classification Rules

- **🔴 Kernel tools** (10 groups): always available, in `src/tools/`. Changes are high-risk.
- **🟢 Skill arm tools**: pluggable via `skills/`. Low risk. **Default choice for new tools.**

### Critical Rule

> If a new tool could be a skill arm, it MUST be a skill arm. Do not bloat the kernel.

## Claude-Specific Workflow

1. Before editing any file, read the interface it implements.
2. Before implementing a subsystem, check both reference runtime and reference architecture.
3. Run `npx tsc --noEmit` after changes to catch type errors early.
4. Use conventional commits: `feat:`, `fix:`, `docs:`, `refactor:`, `test:`.
5. Keep PRs small and focused — one concern per PR.

## Style

- Strict TypeScript (`strict: true` in tsconfig)
- ESM modules (`"type": "module"` in package.json)
- 2-space indentation
- Single quotes
- Semicolons
- Explicit return types on public functions
- JSDoc on all exported interfaces and types
