# Repo Structure

This document distinguishes the current Tako repository structure into the
boundaries that matter for refactoring:

- kernel
- plugins
- skills
- product surfaces
- domain modules

The immediate goal is not to rename everything at once. The goal is to stop
mixing these boundaries in `src/index.ts` and to keep future work from adding
more hardcoded cross-layer wiring.

## Boundary Rules

### Kernel

Kernel code is the minimal runtime needed no matter which channels, providers,
or skills are active.

Current kernel-heavy areas:
- `src/core/`
- `src/gateway/`
- `src/config/`
- `src/principals/`
- `src/commands/parser.ts`
- `src/tools/registry.ts`
- `src/tools/tool.ts`

Kernel responsibilities:
- execution loop
- prompt assembly
- session lifecycle
- tool registry and policy
- execution context
- approvals
- runtime paths
- security and auditing

Kernel must not hardcode:
- specific Discord behavior beyond the channel interface
- skill prompt content
- provider-specific message shaping outside provider adapters

### Plugins

Plugins are replaceable adapters or tool packs. They implement interfaces the
kernel depends on, but they are not the kernel itself.

Current plugin-like areas:
- `src/channels/`
- `src/providers/`
- `src/memory/`
- `src/network/`
- `src/sandbox/`
- `src/auth/`
- `src/tools/`
- `src/skills/extensions.ts`
- `src/skills/extension-loader.ts`

Plugin rule:
- the kernel may compose plugins
- plugins should not depend on skill content
- plugin registration should happen in explicit composition modules, not as
  scattered `registerAll(...)` calls inside `src/index.ts`

### Skills

Skills are prompt-side behavior packages, not kernel logic.

Skill areas:
- `skills/`
- `src/skills/loader.ts`
- `src/skills/types.ts`
- `src/skills/channel-loader.ts`
- `src/skills/extension-registry.ts`

Skill rule:
- `skills/` contains prompt content, scripts, references, and optional
  extensions
- `src/skills/` only loads, validates, and injects skills
- business logic should not be copied into `SKILL.md` and then hardcoded again
  in runtime conditionals unless the runtime truly owns that invariant

### Product Surfaces

These are operator-facing entry points, not kernel internals.

Areas:
- `src/cli/`
- `src/onboard/`
- `src/doctor/`
- `src/daemon/`
- `src/tui/`

Rule:
- they should call into the kernel/runtime composition layer
- they should not implement agent behavior themselves

### Domain Modules

These are substantial feature domains that sit above the kernel but below the
product surfaces.

Areas:
- `src/projects/`
- `src/agents/`
- `src/acp/`
- `src/sessions/`
- `src/hub/`

Rule:
- keep domain state machines here
- avoid pushing domain-specific branching down into generic kernel code

## Current Pressure Points

### 1. `src/index.ts` is still too large

Current size is roughly 6900 lines. It is acting as:
- process entrypoint
- composition root
- Discord runtime policy layer
- project orchestration layer
- peer approval coordinator
- network relay coordinator

That is too many responsibilities for one file.

### 2. Tool registration was hardcoded in the entrypoint

Built-in tool registration used to live directly in `src/index.ts`.
That makes the kernel/plugin boundary blurry.

The first structural correction is:
- `src/core/tool-composition.ts`

This moves built-in tool pack registration into an explicit composition module.

### 3. Skills and runtime policies are still partially mixed

Skills should describe when and how to use tools.
Runtime should enforce only real invariants:
- permissions
- room binding
- security
- persistence

If a behavior is only prompt guidance, keep it in skills.
If it is a safety or consistency invariant, keep it in runtime.

## Recommended Target Layout

This is the target conceptual split. It does not require immediate file moves.

```text
src/
  kernel/
    agent-loop/
    prompt/
    sessions/
    tooling/
    security/
  plugins/
    channels/
    providers/
    memory/
    network/
    sandbox/
    auth/
    tools/
  domains/
    projects/
    agents/
    acp/
    hub/
  surfaces/
    cli/
    daemon/
    tui/
    onboard/
    doctor/
  skills/
    loader/
    registry/
```

The current repo does not need a giant rename right now. The practical path is:

1. keep current directories
2. extract composition seams
3. shrink `src/index.ts`
4. move files only when a whole boundary is already clean

## Immediate Refactor Path

1. Keep `src/index.ts` as process bootstrap + high-level wiring only.
2. Move built-in tool registration and other composition logic into dedicated
   modules under `src/core/`.
3. Split Discord-specific project coordination out of `src/index.ts` into
   domain/runtime modules.
4. Keep `skills/` prompt-only unless a skill explicitly ships a plugin
   extension.
5. Treat channels/providers/network/memory/auth/sandbox as plugin families,
   not kernel.

## What To Avoid

- hardcoding skill-to-tool dispatch in the kernel
- putting project-specific Discord behavior into generic channel interfaces
- letting `src/index.ts` grow as the place where every new rule is added
- using `skills/` as a substitute for runtime permissions or consistency rules
