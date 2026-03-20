# Tako — Detailed Design & Use Cases

> **Version:** 0.0.21 · **Architecture:** Edge + Hub Collaboration Runtime
> **Codebase:** 46K LOC TypeScript · 204 source files · 32 subsystem modules
> **Verified:** 484 tests passing

---

## Table of Contents

1. [Vision](#vision)
2. [Architecture Overview](#architecture-overview)
3. [Runtime Model](#runtime-model)
4. [Core Subsystems](#core-subsystems)
5. [Identity & Access Model](#identity--access-model)
6. [Collaboration Model](#collaboration-model)
7. [Network Protocol](#network-protocol)
8. [Security Model](#security-model)
9. [Data Layout](#data-layout)
10. [Use Cases](#use-cases)
11. [Comparison with Existing Systems](#comparison-with-existing-systems)
12. [Roadmap](#roadmap)

---

## Vision

Tako is a **multi-user collaboration runtime** for AI agents. Each user runs their own personal **edge** agent node. An optional **hub** coordinates routing, relay, and project state across edges — without ever running the LLM or owning private data.

The key insight: **AI agents should follow the same sovereignty model as humans**. Each person owns their own brain, memory, and tools. Collaboration happens through explicit sharing, not through a central server that sees everything.

```
"Your agent, your keys, your memory. Collaborate when you choose to."
```

---

## Architecture Overview

```
                    ┌──────────────────────────┐
                    │      Hub (optional)       │
                    │  Node registry · Routing  │
                    │  Session relay · Presence  │
                    │  Audit aggregation         │
                    │  ─── NO LLM, NO tools ─── │
                    └─────┬──────┬──────┬───────┘
                          │      │      │
              ┌───────────┘      │      └───────────┐
              │                  │                  │
     ┌────────┴────────┐ ┌──────┴───────┐ ┌───────┴────────┐
     │   Edge (Alice)   │ │  Edge (Bob)  │ │  Edge (Carol)  │
     │                  │ │              │ │                │
     │ ┌──────────────┐ │ │ ┌──────────┐ │ │ ┌────────────┐ │
     │ │ Agent Loop    │ │ │ │Agent Loop│ │ │ │ Agent Loop │ │
     │ │ ┌──┐┌──┐┌──┐ │ │ │ │┌──┐┌──┐ │ │ │ │┌──┐┌──┐   │ │
     │ │ │P ││Ch││T │ │ │ │ ││P ││Ch│ │ │ │ ││P ││Ch│   │ │
     │ │ │r ││an││o │ │ │ │ ││r ││an│ │ │ │ ││r ││an│   │ │
     │ │ │o ││ne││o │ │ │ │ ││o ││ne│ │ │ │ ││o ││ne│   │ │
     │ │ │v ││l ││l │ │ │ │ ││v ││l │ │ │ │ ││v ││l │   │ │
     │ │ └──┘└──┘└──┘ │ │ │ │└──┘└──┘ │ │ │ │└──┘└──┘   │ │
     │ └──────────────┘ │ │ └──────────┘ │ │ └────────────┘ │
     │                  │ │              │ │                │
     │ Memory · Keys    │ │ Memory·Keys  │ │ Memory · Keys  │
     │ Skills · Files   │ │ Skills·Files │ │ Skills · Files  │
     └──────────────────┘ └──────────────┘ └────────────────┘
```

### Design Principles

| # | Principle | Rationale |
|---|-----------|-----------|
| 1 | **Edge-sovereign** | Each user's LLM keys, memory, tools, and execution stay local |
| 2 | **Hub is control-plane only** | Hub never runs prompts, owns private data, or executes tools |
| 3 | **Explicit sharing** | Nothing is shared by default; collaboration requires opt-in |
| 4 | **Convention over config** | Sane defaults, override when needed |
| 5 | **Markdown-first memory** | Plain files are the source of truth |
| 6 | **Progressive trust** | Trust is established per-edge, per-project, with authority ceilings |

---

## Runtime Model

### Edge (Agent Node)

An edge is the full Tako runtime. It can run:
- **Solo** — single user, no network
- **Local collaboration** — multiple humans on one shared Discord/Telegram bot
- **Networked** — connected to a hub, collaborating with remote edges

```bash
# Solo
tako start --home ~/.tako-edge-main

# Networked
tako start --home ~/.tako-edge-alice --hub http://hub.example.com:18790
```

Edge owns:
- Provider credentials (API keys, OAuth tokens)
- Model usage and billing
- Private memory (global + per-project)
- Local tools and execution policy
- Local files and worktrees
- Session state

### Hub (Coordination Node)

A hub is infrastructure only. It coordinates but never reasons.

```bash
tako hub start --home ~/.tako-hub --port 18790
```

Hub provides:
- Node registry + heartbeat-based presence
- Project registry summaries
- Session routing and relay
- Invite lifecycle coordination
- Audit aggregation

Hub explicitly does **NOT**:
- Run LLM prompts
- Own private memory
- Execute tools
- Become a central reasoning agent

---

## Core Subsystems

### Agent Loop (CPU Cycle)

The core processing loop for each message:

```
Message arrives → Session resolved → System prompt assembled
    → Provider.chat() called → Tool calls executed (up to 50/turn)
    → Response streamed → Session persisted
```

| Component | LOC | Responsibility |
|-----------|-----|----------------|
| `core/` | 8,271 | Agent loop, prompt builder, execution context, streaming, pruning, compaction |
| `providers/` | 2,029 | Anthropic, OpenAI, Google, LiteLLM adapters with unified streaming |
| `channels/` | 2,297 | Discord, Telegram with reconnection, rate limiting, message splitting |
| `tools/` | 5,652 | FS, exec, search, git, web, browser, image, memory, ACP, message, symphony |
| `memory/` | 877 | Hybrid BM25 + vector search, scoped visibility, temporal decay |
| `skills/` | 1,072 | Skill discovery, loading, tool registration, extension subsystems |
| `sessions/` | 162 | Session persistence, shared session tracking |

### Skill Extensions

Skills can provide entire subsystem implementations:

| Type | Interface | Example |
|------|-----------|---------|
| Channel | `Channel` | Custom Slack adapter |
| Provider | `Provider` | Local Ollama backend |
| Memory | `MemoryStore` | Custom vector DB |
| Network | `NetworkAdapter` | Custom P2P transport |
| Sandbox | `SandboxProvider` | Docker-based isolation |
| Auth | `AuthProvider` | SSO integration |

### ACP Integration

Full Agent Client Protocol support for spawning coding agents:

```bash
# One-shot task
tako acp exec claude "Implement feature X"

# Persistent session bound to Discord thread
tako acp send claude --session my-task "Continue working on feature X"
```

Supports: Claude Code, Codex, OpenCode, Gemini CLI, Pi.

---

## Identity & Access Model

### Principal Identity

Every human/agent interacting with Tako resolves to a **principal**:

```typescript
Principal {
  principalId: string        // Stable UUID
  type: 'human' | 'local-agent' | 'remote-agent' | 'system'
  displayName: string
  authorityLevel: 'owner' | 'admin' | 'member' | 'guest'
}
```

Principals are mapped to platform identities:

```typescript
PrincipalPlatformMapping {
  principalId: string
  platform: 'discord' | 'telegram' | 'cli' | 'web'
  platformUserId: string
}
```

### Project Roles

```
owner > admin > write > contribute > read
```

| Role | Can do |
|------|--------|
| `read` | View shared artifacts, read shared memory |
| `contribute` | Read + submit patches (require approval) |
| `write` | Contribute + direct artifact publish |
| `admin` | Write + manage members + set policy |

---

## Collaboration Model

### Tier 1: Solo Edge

```
User → Channel → Edge → LLM + Tools + Memory
```

Single user, full agent capabilities. No collaboration overhead.

### Tier 2: Local Collaboration (One Edge, Multiple Humans)

```
Alice ──┐
Bob   ──┤── Discord/Telegram ── Edge ── LLM + Tools
Carol ──┘
```

- Shared project sessions with participant tracking
- Project-scoped memory (shared + private per-principal)
- Project-scoped tool roots (filesystem isolation)
- Membership gating (non-members denied before execution)

### Tier 3: Network Collaboration (Multiple Edges + Hub)

```
Alice's Edge ──┐
Bob's Edge   ──┤── Hub ── Routing + Relay + Audit
Carol's Edge ──┘
```

- Each edge keeps its own LLM keys, memory, and tools
- Trust established per-edge with authority ceilings
- Shared artifacts published explicitly (not synced by default)
- Bounded remote delegation (capability-based, locally enforced)
- Patch review and approval workflow
- Per-edge worktrees with branch coordination

### Memory Scoping

```
<home>/memory/global/private/           ← solo/unbound context
<home>/projects/<projectId>/memory/
  shared/                               ← visible to all project members
  private/<principalId>/                ← visible only to that principal
```

### Artifact Flow

```
Alice publishes artifact → Hub relays → Bob's edge receives
Bob reviews → Applies to local worktree (or rejects)
```

Artifacts are explicit publications, not automatic filesystem sync.

### Delegation Flow

```
Alice requests → Hub relays → Bob's edge evaluates:
  ✓ Trust established?
  ✓ Authority ceiling allows?
  ✓ Capability exposed?
  ✓ Project membership valid?
  → Execute locally within project root bounds
  → Return structured result via relay
```

---

## Network Protocol

### Edge → Hub Sync

| Action | Frequency | Data |
|--------|-----------|------|
| Registration | On startup | Node identity, capabilities |
| Heartbeat | Periodic | Presence, status |
| Project summary | On mutation | Project metadata |
| Membership summary | On mutation | Member list |
| Session events | On activity | Relay messages |

### Trust Lifecycle

```
Edge A creates invite → Invite exported → Edge B imports
    → Edge B accepts → Trust record created (both sides)
    → Authority ceiling set → Collaboration begins
```

Trust states: `pending → trusted → revoked`

### Network Session Events

```
join · leave · message · artifact · delegation-request · delegation-result
```

Events are relayed through the hub. Each edge persists and acknowledges.

---

## Security Model

### Threat Boundaries

| Boundary | Protection |
|----------|------------|
| Edge isolation | Each edge owns its own process, keys, memory |
| Project root enforcement | Tools cannot escape project directory |
| Trust ceiling | Remote operations bounded by explicit authority level |
| Capability-based delegation | Only explicitly exposed capabilities can be invoked remotely |
| Hub separation | Hub never has access to LLM keys, private memory, or tool execution |
| Script content pinning | Bun/Deno run commands verified against content |
| SSRF protection | Private-network redirect hops blocked in browser tools |
| Config validation | Fail-closed on invalid config |

### Crash Resilience

- Process-level `uncaughtException` / `unhandledRejection` handlers (log and survive)
- Per-message error isolation (one bad message can't crash the system)
- Discord/Telegram reconnect with exponential backoff
- Systemd user service with auto-restart on failure
- Emergency compact-and-retry on context overflow

---

## Data Layout

### Edge Home

```
<edgeHome>/
├── tako.json              # Configuration
├── .env                   # Environment variables
├── node.json              # Persistent node identity
├── auth/                  # API credentials
├── credentials/           # OAuth tokens
├── runtime/               # PID, locks
├── principals/            # Principal registry
├── agents/                # Multi-agent configs
├── projects/
│   ├── projects.json      # Project registry
│   ├── memberships.json   # Membership records
│   ├── bindings.json      # Channel bindings
│   └── <projectId>/
│       ├── artifacts/     # Shared artifacts
│       ├── worktrees/     # Per-edge worktrees
│       ├── memory/
│       │   ├── shared/
│       │   └── private/<principalId>/
│       └── branches.json
├── network/
│   ├── trust.json         # Trust records
│   ├── invites.json       # Invite records
│   ├── capabilities.json  # Delegation capabilities
│   └── delegations.json   # Delegation records
├── media/
├── cron/
├── audit/
└── workspace/             # Agent workspace files
```

### Hub Home

```
<hubHome>/
├── node.json
├── registry/
│   ├── nodes.json
│   ├── projects.json
│   └── relay/
├── runtime/
└── audit/
```

---

## Use Cases

### 1. Personal AI Assistant (Solo Edge)

**Scenario:** A developer runs Tako as their personal coding + research agent on their workstation.

```bash
tako onboard --home ~/.tako
tako start --home ~/.tako
```

- Connects to Discord/Telegram as a personal bot
- Manages files, runs code, searches web, controls browser
- Persistent memory across sessions
- Skills extend capabilities (GitHub, email, calendar, etc.)
- ACP integration spawns Claude Code or Codex for complex coding tasks

**Why Tako over ChatGPT?** Full tool access, persistent memory, custom skills, self-hosted.

---

### 2. Research Lab Collaboration (Local Collab)

**Scenario:** A 3-person ML research team shares one Tako edge on a lab server. Each researcher has their own Discord account.

```bash
# Setup
tako projects create paper-v2 --owner alice --name "ICML 2026 Paper"
tako projects add-member paper-v2 bob --role write
tako projects add-member paper-v2 carol --role contribute
tako projects bind paper-v2 --platform discord --target #paper-v2

# Usage (in Discord #paper-v2)
@tako summarize today's experiment results
@tako draft the related work section
@tako review Bob's latest code changes
```

- Each researcher's messages are attributed to their principal
- Shared project memory (experiment results, paper drafts)
- Private memory per researcher (personal notes, TODO lists)
- Project-scoped tool root (can only access paper repo)
- Carol (contribute role) submits patches that need approval

**Why Tako over shared ChatGPT?** Per-user identity, project isolation, persistent shared context, tool access.

---

### 3. Multi-User Startup Team (Network Collab)

**Scenario:** A 5-person distributed startup. Each person runs their own edge on their own machine. A hub on a shared server coordinates.

```bash
# Hub (on shared VPS)
tako hub start --home /srv/tako-hub --port 18790

# Each developer (on their machine)
tako start --home ~/.tako-edge --hub http://hub.startup.dev:18790
```

**Collaboration flow:**
1. CTO creates project "backend-v3" on their edge
2. Invites each developer via trust+invite lifecycle
3. Each developer's edge joins with its own LLM keys and tools
4. Shared artifacts (specs, docs, configs) published to project
5. Developers delegate bounded tasks to each other's agents
6. Patches reviewed and approved via Discord buttons
7. Each developer's private notes and personal code stay local

**Why Tako over Cursor/Copilot?** Each person's agent has full autonomy. No central server sees all code. Collaboration is explicit, not implicit.

---

### 4. Open Source Maintainer (Network + Delegation)

**Scenario:** A maintainer runs their own edge. Contributors run their own edges. The maintainer delegates issue triage and PR review to contributor agents.

```bash
# Maintainer delegates
tako network delegate oss-project --to contributor-edge \
  --capability summarize_workspace \
  --capability review_code
```

- Contributor's agent runs locally on contributor's machine
- Maintainer's agent sends bounded delegation requests
- Contributor's edge evaluates trust + capability before executing
- Results relay back through hub
- Maintainer reviews and merges

**Why Tako over GitHub Actions?** Agent-level delegation with trust boundaries. Contributors use their own API keys. No shared secrets.

---

### 5. AI Research Agent Network

**Scenario:** Multiple AI safety researchers, each with their own agent, collaborating on alignment research across institutions.

- Each researcher's agent has access to their local paper collection, experiment logs, and notes
- Shared project: literature reviews, experiment designs, paper drafts
- Private per-researcher: personal reading notes, unpublished ideas
- Delegation: "Ask Bob's agent to summarize his latest experiment results"
- Hub provides routing but never sees private research data

**Why Tako?** Institutional data boundaries respected. No central server has access to all research. Collaboration is opt-in per-project.

---

### 6. Classroom / Teaching Assistant

**Scenario:** A professor sets up one edge as a course TA bot in the class Discord.

```bash
tako projects create cs101 --owner prof --name "CS101 Fall 2026"
tako projects add-member cs101 student1 --role read
tako projects bind cs101 --platform discord --target #cs101-help
```

- Students ask questions in the bound channel
- TA agent has access to course materials (in project root)
- Cannot access other projects or the professor's private files
- Shared memory accumulates common Q&A for the semester
- Professor can review interaction logs via audit

---

### 7. Personal Knowledge Base + Second Brain

**Scenario:** A power user runs Tako as a personal knowledge manager.

- Daily memory notes auto-accumulated
- Hybrid BM25 + vector search for recall
- Skills for email, calendar, notes, bookmarks
- ACP spawns coding agents for automation tasks
- Cron jobs for periodic summaries, reminders, health checks

**Why Tako over Notion AI?** Full tool access, persistent agent memory, custom skills, self-hosted, private.

---

### 8. DevOps / Infrastructure Agent

**Scenario:** An edge agent monitors and manages infrastructure.

- Skills: healthcheck, SSH, monitoring, alerting
- Cron jobs: periodic security audits, update checks
- Channel: Telegram alerts for critical events
- Tools: exec for commands, browser for dashboards
- Memory: tracks infrastructure state over time

---

## Comparison with Existing Systems

| Feature | Tako | OpenClaw | ChatGPT Teams | Cursor | Claude Code |
|---------|------|----------|---------------|--------|-------------|
| Self-hosted | ✅ | ✅ | ❌ | ❌ | ❌ |
| Multi-user collab | ✅ (edge+hub) | ✅ (single gateway) | ✅ (central) | ❌ | ❌ |
| Data sovereignty | ✅ per-edge | ⚠️ single server | ❌ | ❌ | ❌ |
| Own API keys | ✅ per-user | ✅ per-instance | ❌ | ✅ | ✅ |
| Tool execution | ✅ | ✅ | ❌ | ✅ (limited) | ✅ |
| Persistent memory | ✅ scoped | ✅ | ❌ | ❌ | ❌ |
| Project isolation | ✅ | ⚠️ per-agent | ❌ | ❌ | ❌ |
| Remote delegation | ✅ bounded | ❌ | ❌ | ❌ | ❌ |
| Patch review flow | ✅ | ❌ | ❌ | ❌ | ❌ |
| Pluggable skills | ✅ | ✅ | ❌ | ❌ | ❌ |
| Hub/federated | ✅ | ❌ | ❌ | ❌ | ❌ |

### Key Differentiators

1. **Edge sovereignty**: Unlike centralized platforms, each user's data and compute stay on their own machine
2. **Hub is dumb**: The coordination layer never sees prompts, memory, or tool output
3. **Bounded delegation**: Remote work is capability-gated and locally enforced, not unrestricted remote shell
4. **Project-scoped everything**: Memory, tools, sessions, and artifacts are isolated per-project
5. **Progressive trust**: Start solo, add local collab, then network — same runtime

---

## Roadmap

### Completed (Phases 1–18)

- [x] Installation-local homes (`--home`)
- [x] Edge + Hub runtime model
- [x] Node identity and heartbeat
- [x] Principal identity and platform mapping
- [x] Project registry, memberships, bindings
- [x] Execution context (unified identity envelope)
- [x] Local shared sessions with participant tracking
- [x] Scoped project memory (shared + private)
- [x] Project-scoped tool root enforcement
- [x] Hub control plane (registry, routing, relay)
- [x] Edge-hub sync (registration, heartbeat, project/membership summaries)
- [x] Trust and invite lifecycle
- [x] Network shared sessions with relay
- [x] Bounded remote delegation
- [x] Shared project artifacts and distribution
- [x] Patch creation, application, and review
- [x] Collaboration policy (auto-sync, approval gates, join announcements)
- [x] Branch coordination and conflict tracking
- [x] Discord button-based patch review
- [x] 484 tests passing

### Future Directions

- [ ] Hub-mediated live invite delivery (currently file-based import)
- [ ] Richer conflict resolution and merge semantics
- [ ] OS-level sandboxing (currently logical root enforcement)
- [ ] Org-level or hub-distributed policy
- [ ] Selective audience controls for network sessions
- [ ] Cross-edge memory exchange (beyond artifacts)
- [ ] Web UI dashboard for hub status
- [ ] Plugin marketplace for skills
- [ ] Mobile companion app

---

## Summary

Tako is built on the belief that **AI agents should be personal, sovereign, and collaborative** — not centralized SaaS products that own your data. Each user runs their own agent. Collaboration happens through explicit trust, bounded delegation, and shared project state — never through a central server that sees everything.

The architecture is already complete through 18 phases of construction, from solo edge to full multi-edge network collaboration. The runtime is TypeScript/Node.js (with Bun compatibility), deployable on any Linux/macOS machine, and extensible through a pluggable skill system.

```
Your agent. Your keys. Your memory. Collaborate when you choose to. 🐙
```
