# CODEX.md — Tako Agent Engineering Protocol (Codex)

This file is auto-read by Codex when working in this repository.

**Read `AGENTS.md`** — it is the canonical engineering protocol for all coding agents.

## Quick Commands

```bash
npm run build          # Build
npm test              # Test
npm run lint          # Lint
npx tsc --noEmit      # Type check
npm run check         # All of the above
```

## Key Files

- `ARCHITECTURE.md` — design intent, interfaces, and long-term constraints
- `docs/repo-structure.md` — current repo/runtime boundary map
- `AGENTS.md` — engineering protocol (read first)
- `src/providers/provider.ts` — Provider interface
- `src/channels/channel.ts` — Channel interface
- `src/tools/tool.ts` — Tool interface
- `src/memory/store.ts` — MemoryStore interface
- `src/config/schema.ts` — Config schema

## Rules

1. **Read the interface before implementing.** All subsystems are interface-driven.
2. **Check reference runtime + reference architecture before designing.** Don't reinvent.
3. **New tools → skill arms, not kernel.** Keep the kernel minimal.
4. **Conventional commits.** `feat:`, `fix:`, `docs:`, `refactor:`, `test:`.
5. **Small PRs.** One concern per change.
6. **No secrets in code.** Ever.
