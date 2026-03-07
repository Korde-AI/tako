# Contributing to Tako

Thanks for contributing.

## Before you start

- Read `README.md`
- Read `docs/DEVELOPMENT.md`
- Run the project locally once

## Local setup

```bash
git clone https://github.com/shuyhere/tako.git
cd tako
npm install
```

## Development workflow

1. Create a branch
2. Make focused changes
3. Add/update tests when behavior changes
4. Run checks
5. Open PR with clear summary

## Required checks

```bash
npm run typecheck
npm test
npm run build
```

Or all-in-one:

```bash
npm run check
```

## Coding standards

- TypeScript strict mode
- ESM modules
- Keep diffs small and reversible
- Prefer reuse over duplicate abstractions
- Update docs for user-visible behavior changes

## Docs standards

If you change install/run/developer behavior, update:

- `README.md`
- `docs/INSTALL.md`
- `docs/USAGE.md`
- `docs/DEVELOPMENT.md`

## PR expectations

Use descriptive PR titles and include:

- problem statement
- solution summary
- test evidence
- risks and rollback notes

Use the PR template in `.github/PULL_REQUEST_TEMPLATE.md`.

## Security

- Do not commit secrets/tokens
- Do not weaken safety defaults without explicit discussion
- Call out security-impacting changes clearly in PR

## Suggested commit style

Conventional prefixes:

- `feat:`
- `fix:`
- `refactor:`
- `docs:`
- `test:`
- `chore:`
