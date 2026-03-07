# Skill Arms

Skills are Tako's extensibility mechanism — pluggable capabilities loaded from the filesystem at runtime.

## What is a Skill?

A skill is a directory containing a `SKILL.md` file. The file has YAML frontmatter for metadata and a Markdown body with instructions that get injected into the agent's system prompt.

```
my-skill/
├── SKILL.md          # Required: metadata + instructions
├── tools/            # Optional: tool implementations (.js/.mjs)
├── scripts/          # Optional: helper scripts
├── references/       # Optional: reference docs loaded on-demand
└── assets/           # Optional: templates, icons, etc.
```

## SKILL.md Format

```markdown
---
name: my-skill
description: What the skill does and when to use it
version: 1.0.0
author: Your Name
triggers: keyword1, keyword2
user-invocable: true
disable-model-invocation: false
requires: {"bins": ["node"], "env": ["API_KEY"], "os": ["linux", "darwin"]}
---

# My Skill

Instructions for the agent on when and how to use this skill.
```

### Frontmatter Fields

| Field | Required | Description |
|-------|----------|-------------|
| `name` | Yes | Unique skill identifier |
| `description` | Yes | What the skill does — also used for trigger matching |
| `version` | No | Semantic version (default: `0.1.0`) |
| `author` | No | Author name |
| `triggers` | No | When to activate (see below) |
| `tools` | No | Tool names this skill provides |
| `hooks` | No | Hook events this skill listens to |
| `user-invocable` | No | Whether exposed as slash command (default: `true`) |
| `disable-model-invocation` | No | Exclude from automatic prompt injection (default: `false`) |
| `requires` | No | JSON object with platform requirements |

### Trigger Types

Triggers determine when a skill's instructions are injected into the system prompt.

**Keyword triggers** (comma-separated):
```yaml
triggers: deploy, ship it, release
```
Matches if any keyword appears in the user's message (case-insensitive).

**Pattern trigger** (regex):
```yaml
triggers: [{"type":"pattern","value":"\\b(deploy|ship)\\b"}]
```

**Always active:**
```yaml
triggers: always
```

**Manual only** (slash command only, never auto-injected):
```yaml
triggers: manual
```

**No triggers defined**: skill is always active (same as `always`).

### Requirements

Skills can declare platform requirements that are checked at load time:

```yaml
requires: {"bins": ["docker"], "env": ["DOCKER_HOST"], "os": ["linux"]}
```

- `bins`: Required binaries on PATH
- `anyBins`: At least one must exist
- `env`: Required environment variables
- `os`: Required OS platforms (`linux`, `darwin`, `win32`)

Skills that don't meet requirements are silently skipped.

## Providing Tools

Skills can provide additional tools by placing JavaScript modules in a `tools/` directory:

```javascript
// my-skill/tools/my-tool.js
export default {
  name: 'my_tool',
  description: 'Does something useful',
  parameters: {
    type: 'object',
    properties: {
      input: { type: 'string', description: 'The input' }
    },
    required: ['input']
  },
  async execute(params, ctx) {
    return { output: `Result: ${params.input}`, success: true };
  }
};
```

Tool modules can export:
- A single tool as `default`
- An array of tools as `default`
- A named `tools` array

Skill tools are registered with the tool registry when the skill loads. They are ungrouped, meaning they're always active regardless of the tool profile.

## CLI Commands

```bash
# List all discovered skills
tako skills list

# Show details about a specific skill
tako skills info find-skills

# Install a skill from the ecosystem
tako skills install vercel-labs/agent-skills@find-skills
```

## Hot Reload

Tako watches skill directories for changes. When a `SKILL.md` or tool file is modified:

1. All skills are re-discovered and re-loaded
2. Tool registrations are updated
3. Hook bindings are refreshed
4. No restart required

The reload is debounced (250ms) to handle rapid file changes.

## Built-in Skills

Tako ships with four built-in skills:

### find-skills
Discovers and installs skills from the ecosystem. Triggers when users ask about finding capabilities or extending the agent.

### skill-creator
Creates new skills from scratch with an iterative draft → test → review → improve workflow. Includes evaluation tooling for measuring skill performance.

### security-audit
Security scanning and analysis capabilities.

### skill-security-audit
Security audit for skill arms (from ClawHub). Validates skill safety before installation.

## Creating a Skill

1. Create a directory in `./skills/`:
   ```bash
   mkdir -p skills/my-skill
   ```

2. Write a `SKILL.md` with frontmatter and instructions:
   ```markdown
   ---
   name: my-skill
   description: Helps with X when the user asks about Y
   version: 0.1.0
   triggers: x, y, z
   ---

   # My Skill

   When the user asks about X, follow these steps...
   ```

3. The skill loads automatically (hot reload) or on next `tako start`.

4. Verify: `tako skills list`

## Providing Extensions

Skills can provide entire subsystem implementations by including extension subdirectories. The loader auto-detects these during skill loading.

### Supported Extension Types

- **channel/** — Messaging adapter (implements `Channel`)
- **provider/** — LLM inference backend (implements `Provider`)
- **memory/** — Persistence + recall backend (implements `MemoryStore`)
- **network/** — Tunnel/exposure adapter (implements `NetworkAdapter`)
- **sandbox/** — Code execution sandbox (implements `SandboxProvider`)
- **auth/** — Authentication provider (implements `AuthProvider`)

### Extension Module Convention

Each extension subdirectory must contain an entry point (`index.ts`, `index.js`, `<type>.ts`, or `<type>.js`) that exports a factory function:

```typescript
// skills/my-provider/provider/index.ts
import type { Provider } from 'tako/providers/provider.js';

export function createProvider(config: Record<string, unknown>): Provider {
  return {
    id: 'my-provider',
    async *chat(req) { /* ... */ yield { done: true }; },
    models() { return []; },
    supports(cap) { return false; },
  };
}
```

The loader tries these patterns in order:
1. Named factory: `createChannel`, `createProvider`, `createMemory`, etc.
2. Generic factory: `create(config)`
3. Default export as constructor: `new mod.default(config)`

### Extension Configuration

Configure extensions in `tako.json` under `skillExtensions`:

```json
{
  "skillExtensions": {
    "ollama": {
      "provider": { "baseUrl": "http://localhost:11434" }
    },
    "qdrant-memory": {
      "memory": { "url": "http://localhost:6333", "collection": "tako" }
    }
  }
}
```

### CLI

```bash
tako extensions list    # List all detected skill extensions
tako extensions status  # Show runtime status (when running)
```
