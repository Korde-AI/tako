# Development Guide

## Prerequisites

- Node.js >= 20
- npm
- Bun (recommended for local dev speed)

## Setup

```bash
git clone https://github.com/shuyhere/tako.git
cd tako
npm install
```

## Development commands

```bash
npm run build         # compile TypeScript
npm run dev           # TypeScript watch build
npm run typecheck     # static type check
npm test              # run tests (bun)
npm run test:node     # run tests on node test runner
npm run check         # build + typecheck + tests
```

## Running locally

```bash
npm run start
# or
bun run src/index.ts start
```

Daemon mode:

```bash
bun run src/index.ts start -d
bun run src/index.ts status
```

## Packaging sanity check

Before release:

```bash
npm run build
npm pack --dry-run
```

Confirm tarball contains expected files:

- `dist/`
- `skills/`
- `docs/`
- `README.md`
- `LICENSE`
- `tako.example.json`

## Recommended release checklist

1. update version
2. run `npm run check`
3. run `npm pack --dry-run`
4. test install tarball in clean dir
5. publish

## Architecture references

- `ARCHITECTURE.md`
- `src/index.ts` (runtime composition)
- `src/gateway/` (daemon/gateway/session control)
- `src/channels/`, `src/providers/`, `src/tools/`, `src/skills/`
