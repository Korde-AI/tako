/**
 * Workspace bootstrap — ensures workspace directory structure and
 * default files exist before the agent starts.
 */

import { mkdir, stat, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';

/** Default content for workspace files created during bootstrap. */
const DEFAULT_FILES: Record<string, string> = {
  'SOUL.md': `# Soul

You are Tako, a versatile agent assistant.

Your personality:
- Helpful and resourceful
- Clear and direct in communication
- Thoughtful about consequences of actions
- Curious and eager to learn from each interaction

Your approach:
- Think step-by-step before acting
- Use the right tool for each task
- Learn from mistakes and adapt
- Keep responses focused and relevant
`,
  'IDENTITY.md': `# Identity

- **Name:** Tako
- **Version:** 0.1.0
- **Type:** Agent OS (Agent-as-CPU architecture)
- **Purpose:** Pluggable AI assistant with extensible skill arms
`,
  'AGENTS.md': `# Operating Instructions

You are Tako, an agent operating system. Follow these instructions for all interactions.

## Core Behavior

- Be helpful, accurate, and concise
- Always explain your reasoning before taking actions
- Ask for clarification when instructions are ambiguous
- Use tools when they help accomplish the task

## Tool Usage

- Prefer reading files before modifying them
- Use the simplest tool for the job
- Report errors clearly and suggest fixes

## Safety

- Never execute commands that could harm the system without explicit approval
- Refuse requests that involve illegal or harmful activities
- Protect user privacy and confidential information
`,
  'TOOLS.md': `# Tool Notes

<!-- This file captures tool-specific learnings and notes. -->
<!-- Updated by the agent as it discovers tool behaviors. -->

## Tool Observations

- (none yet)
`,
  'USER.md': `# User Profile

<!-- This file is populated with user preferences over time. -->
<!-- Tako uses this to personalize interactions. -->

## Preferences

- (none yet)

## Notes

- (none yet)
`,
  'memory/MEMORY.md': `# Memory

Long-term curated memory for the Tako agent.
Updated by the agent as it learns from interactions.

## Key Facts

- (none yet)

## User Preferences

- (none yet)

## Session Insights

- (none yet)
`,
  'HEARTBEAT.md': `# Heartbeat

<!-- This file configures heartbeat behavior for long-running tasks. -->
<!-- The agent will periodically emit a heartbeat to indicate it's still working. -->

When working on long tasks, periodically provide brief status updates.
If a task is taking longer than expected, explain what you're working on.
`,
};

/**
 * Ensure the workspace directory exists with required structure.
 * Creates missing directories and default files without overwriting existing ones.
 */
export async function bootstrapWorkspace(workspacePath: string): Promise<void> {
  // Ensure workspace root exists
  await mkdir(workspacePath, { recursive: true });

  // Ensure memory/ subdirectory exists
  await mkdir(join(workspacePath, 'memory'), { recursive: true });

  // Create default files if they don't exist
  for (const [relativePath, content] of Object.entries(DEFAULT_FILES)) {
    const fullPath = join(workspacePath, relativePath);
    const exists = await fileExists(fullPath);
    if (!exists) {
      await writeFile(fullPath, content, 'utf-8');
    }
  }
}

/**
 * Get today's daily memory log path (memory/YYYY-MM-DD.md).
 */
export function dailyMemoryPath(): string {
  const today = new Date().toISOString().slice(0, 10);
  return `memory/${today}.md`;
}

/**
 * Ensure today's daily memory file exists.
 * Creates it with a date header if missing.
 */
export async function ensureDailyMemory(workspacePath: string): Promise<string> {
  const relPath = dailyMemoryPath();
  const fullPath = join(workspacePath, relPath);
  const exists = await fileExists(fullPath);
  if (!exists) {
    const today = new Date().toISOString().slice(0, 10);
    await writeFile(fullPath, `# Daily Log — ${today}\n\n`, 'utf-8');
  }
  return relPath;
}

/**
 * Load a workspace file, returning empty string if missing.
 */
export async function loadWorkspaceFile(workspacePath: string, filename: string): Promise<string> {
  try {
    return await readFile(join(workspacePath, filename), 'utf-8');
  } catch {
    return '';
  }
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
