# Repo Structure

This document distinguishes the current Tako repository structure into the
boundaries that matter for refactoring:

- kernel
- plugins
- skills
- product surfaces
- domain modules

The immediate goal is not to rename everything at once. The goal is to keep
the process entrypoint thin, push runtime composition into dedicated modules,
and stop future work from adding more hardcoded cross-layer wiring.

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
- `src/runtime/`

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

### 1. `src/runtime/edge-runtime.ts` is now the main pressure point

`src/index.ts` is now a thin launcher plus legacy CLI handlers.
The heavy edge bootstrap moved into:

- `src/runtime/edge-runtime.ts`
- `src/cli/runtime.ts`

That is the correct direction, but the edge runtime is still large and still
owns too much orchestration in one module.

The next structural cuts should continue from `src/runtime/edge-runtime.ts`,
not move logic back into `src/index.ts`.

Recent extractions now live under:
- `src/runtime/project-coordination.ts`
- `src/runtime/approval-runtime.ts`
- `src/runtime/network-runtime.ts`
- `src/cli/runtime.ts`

### 2. Tool registration was hardcoded in the entrypoint

Built-in tool registration used to live directly in the entrypoint.
That makes the kernel/plugin boundary blurry.

The first structural correction is:
- `src/core/tool-composition.ts`

This moves built-in tool pack registration into an explicit composition module.

### 3. Surface capabilities still need to keep concrete channels out of tools

The message tool now routes through:

- `src/channels/surface-capabilities.ts`

That is the right seam for Discord, Telegram, dashboard, Slack, and future
surfaces. The remaining rule is:

- tools should depend on surface capabilities
- channels should implement those capabilities
- runtime composition should resolve which surface instance is active

### 4. Skills and runtime policies are still partially mixed

Skills should describe when and how to use tools. Runtime should enforce only
real invariants:
- permissions
- room binding
- security
- persistence

## Recommended Target Layout

This is the target conceptual split. It does not require immediate file moves.

```text
src/
  runtime/
    edge-runtime/
    cli-runtime/
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

1. Keep `src/index.ts` as a minimal launcher only.
2. Keep `src/cli/runtime.ts` responsible for CLI dispatch and process mode
   selection.
3. Keep `src/runtime/edge-runtime.ts` responsible for edge bootstrap and move
   its remaining orchestration into smaller runtime composition modules.
4. Keep `skills/` prompt-only unless a skill explicitly ships a plugin
   extension.
5. Treat channels/providers/network/memory/auth/sandbox as plugin families,
   not kernel.

## What To Avoid

- hardcoding skill-to-tool dispatch in the kernel
- putting project-specific Discord behavior into generic channel interfaces
- letting `src/index.ts` grow as the place where every new rule is added
- using `skills/` as a substitute for runtime permissions or consistency rules
