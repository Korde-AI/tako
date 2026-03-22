import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { resolveConfig } from '../config/resolve.js';
import type { AgentBindings } from '../config/schema.js';
import { getRuntimePaths } from '../core/paths.js';
import { AgentRegistry } from '../agents/registry.js';

export async function runAgents(args: string[]): Promise<void> {
  const config = await resolveConfig();
  const registry = new AgentRegistry(config.agents, config.providers.primary);
  await registry.loadDynamic();

  const subcommand = args[0] ?? 'list';

  switch (subcommand) {
    case 'list': {
      const showBindings = args.includes('--bindings');
      const agents = registry.list();

      if (agents.length === 0) {
        console.log('No agents configured (only default "main" agent).');
        return;
      }

      console.log(`Agents (${agents.length}):\n`);
      for (const agent of agents) {
        console.log(`  ${agent.id}${agent.isMain ? ' (main)' : ''}`);
        console.log(`    Workspace: ${agent.workspace}`);
        console.log(`    Model: ${agent.model}`);
        if (agent.description) console.log(`    Description: ${agent.description}`);
        if (agent.canSpawn.length > 0) console.log(`    Can spawn: ${agent.canSpawn.join(', ')}`);
        if (showBindings && Object.keys(agent.bindings).length > 0) {
          console.log(`    Bindings: ${JSON.stringify(agent.bindings)}`);
        }
        console.log();
      }
      break;
    }

    case 'add': {
      const nameArg = args[1];
      const hasFlags = args.some((a) => a.startsWith('--'));
      const isInteractive = !nameArg && !hasFlags;

      let agentName: string;
      let workspace: string | undefined;
      let model: string | undefined;
      let description: string | undefined;
      let discordChannels: string[] | undefined;
      let telegramUsers: string[] | undefined;

      if (isInteractive) {
        const p = await import('@clack/prompts');

        p.intro('Tako 🐙 — New Agent Setup');

        const nameResult = await p.text({
          message: 'Agent name (lowercase, hyphens ok)',
          placeholder: 'code-agent',
          validate: (v) => {
            if (!v) return 'Name is required';
            if (!/^[a-z][a-z0-9-]*$/.test(v)) return 'Use lowercase letters, numbers, and hyphens';
            if (v === 'main') return '"main" is reserved';
            if (registry.has(v)) return `Agent "${v}" already exists`;
            return undefined;
          },
        });
        if (p.isCancel(nameResult)) { p.cancel('Cancelled.'); return; }
        agentName = nameResult;

        const descResult = await p.text({
          message: 'Description (what does this agent do?)',
          placeholder: 'Handles code review and refactoring tasks',
        });
        if (p.isCancel(descResult)) { p.cancel('Cancelled.'); return; }
        description = descResult || undefined;

        const wsResult = await p.text({
          message: 'Workspace path',
          placeholder: `~/.tako/workspace-${agentName}`,
          defaultValue: `~/.tako/workspace-${agentName}`,
        });
        if (p.isCancel(wsResult)) { p.cancel('Cancelled.'); return; }
        workspace = wsResult || `~/.tako/workspace-${agentName}`;

        const modelResult = await p.select({
          message: 'Model',
          options: [
            { value: '', label: `Inherit from main (${config.providers.primary})`, hint: 'recommended' },
            { value: 'anthropic/claude-sonnet-4-6', label: 'claude-sonnet-4-6', hint: 'fast, balanced' },
            { value: 'anthropic/claude-opus-4-6', label: 'claude-opus-4-6', hint: 'powerful, slower' },
            { value: 'anthropic/claude-haiku-4-5', label: 'claude-haiku-4-5', hint: 'fastest, cheapest' },
          ],
        });
        if (p.isCancel(modelResult)) { p.cancel('Cancelled.'); return; }
        model = modelResult || undefined;

        const bindResult = await p.confirm({
          message: 'Set up channel bindings? (route specific channels to this agent)',
          initialValue: false,
        });
        if (p.isCancel(bindResult)) { p.cancel('Cancelled.'); return; }

        if (bindResult) {
          if (config.channels.discord?.token) {
            const dcResult = await p.text({
              message: 'Discord channel names (comma-separated, or empty to skip)',
              placeholder: 'coding, code-review',
            });
            if (p.isCancel(dcResult)) { p.cancel('Cancelled.'); return; }
            if (dcResult) {
              discordChannels = dcResult.split(',').map((s) => s.trim()).filter(Boolean);
            }
          }

          if (config.channels.telegram?.token) {
            const tgResult = await p.text({
              message: 'Telegram user IDs to route (comma-separated, or empty to skip)',
              placeholder: '123456789',
            });
            if (p.isCancel(tgResult)) { p.cancel('Cancelled.'); return; }
            if (tgResult) {
              telegramUsers = tgResult.split(',').map((s) => s.trim()).filter(Boolean);
            }
          }
        }

        p.note([
          `Name:        ${agentName}`,
          `Description: ${description || '(none)'}`,
          `Workspace:   ${workspace}`,
          `Model:       ${model || `inherit (${config.providers.primary})`}`,
          discordChannels ? `Discord:     ${discordChannels.join(', ')}` : null,
          telegramUsers ? `Telegram:    ${telegramUsers.join(', ')}` : null,
        ].filter(Boolean).join('\n'), 'New Agent');

        const confirmResult = await p.confirm({ message: 'Create this agent?', initialValue: true });
        if (p.isCancel(confirmResult) || !confirmResult) { p.cancel('Cancelled.'); return; }
      } else {
        if (!nameArg) {
          console.error('Usage: tako agents add <name> [--workspace <path>] [--model <model>] [--description <desc>]');
          console.error('       tako agents add  (interactive wizard)');
          process.exit(1);
        }
        agentName = nameArg;

        const workspaceIdx = args.indexOf('--workspace');
        const modelIdx = args.indexOf('--model');
        const descIdx = args.indexOf('--description');
        const discordIdx = args.indexOf('--discord-channels');
        const telegramIdx = args.indexOf('--telegram-users');

        workspace = workspaceIdx >= 0 ? args[workspaceIdx + 1] : undefined;
        model = modelIdx >= 0 ? args[modelIdx + 1] : undefined;
        description = descIdx >= 0 ? args[descIdx + 1] : undefined;
        if (discordIdx >= 0 && args[discordIdx + 1]) {
          discordChannels = args[discordIdx + 1].split(',').map((s) => s.trim());
        }
        if (telegramIdx >= 0 && args[telegramIdx + 1]) {
          telegramUsers = args[telegramIdx + 1].split(',').map((s) => s.trim());
        }
      }

      const bindings: AgentBindings = {};
      if (discordChannels && discordChannels.length > 0) {
        bindings.discord = { channels: discordChannels };
      }
      if (telegramUsers && telegramUsers.length > 0) {
        bindings.telegram = { users: telegramUsers };
      }

      try {
        const agent = await registry.add({
          id: agentName,
          workspace,
          model: model ? { primary: model } : undefined,
          description,
          bindings: Object.keys(bindings).length > 0 ? bindings : undefined,
        });

        console.log(`\nAgent created: ${agent.id}`);
        console.log(`  Workspace:   ${agent.workspace}`);
        console.log(`  State dir:   ${agent.stateDir}`);
        console.log(`  Sessions:    ${agent.sessionDir}`);
        console.log(`  Model:       ${agent.model}`);
        if (agent.description) console.log(`  Description: ${agent.description}`);
        if (Object.keys(agent.bindings).length > 0) {
          console.log(`  Bindings:    ${JSON.stringify(agent.bindings)}`);
        }
        console.log(`\nWorkspace files created:`);
        console.log(`  AGENTS.md    — Operating instructions`);
        console.log(`  SOUL.md      — Personality & values`);
        console.log(`  IDENTITY.md  — Name, capabilities`);
        console.log(`  USER.md      — User profile (empty)`);
        console.log(`  TOOLS.md     — Tool learnings (empty)`);
        console.log(`  HEARTBEAT.md — Status update behavior`);
        console.log(`  BOOTSTRAP.md — First-run ritual`);
        console.log(`  memory/MEMORY.md — Long-term memory`);
      } catch (err) {
        console.error(`Failed to create agent: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
      break;
    }

    case 'remove': {
      const name = args[1];
      if (!name) {
        console.error('Usage: tako agents remove <name>');
        process.exit(1);
      }

      try {
        const removed = await registry.remove(name);
        if (removed) {
          console.log(`Agent removed: ${name}`);
          console.log('Note: agent workspace was preserved (only state directory was removed).');
        } else {
          console.error(`Agent not found: ${name}`);
          process.exit(1);
        }
      } catch (err) {
        console.error(`Failed to remove agent: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
      break;
    }

    case 'info': {
      const name = args[1];
      if (!name) {
        console.error('Usage: tako agents info <name>');
        process.exit(1);
      }

      const info = registry.info(name);
      if (!info) {
        console.error(`Agent not found: ${name}`);
        console.error(`Available agents: ${registry.list().map((a) => a.id).join(', ')}`);
        process.exit(1);
      }

      console.log(`Agent: ${info.id}`);
      console.log(JSON.stringify(info, null, 2));
      break;
    }

    case 'bind': {
      const agentId = args[1];
      const channel = args.includes('--channel') ? args[args.indexOf('--channel') + 1] : undefined;
      const target = args.includes('--target') ? args[args.indexOf('--target') + 1] : undefined;

      if (!agentId || !channel || !target) {
        console.error('Usage: tako agents bind <agentId> --channel <discord|telegram> --target <channelId>');
        process.exit(1);
      }

      const agent = registry.get(agentId);
      if (!agent) {
        console.error(`Agent not found: ${agentId}`);
        process.exit(1);
      }

      const bindings = { ...agent.bindings };
      if (channel === 'discord') {
        const existing = bindings.discord?.channels ?? [];
        if (!existing.includes(target)) {
          bindings.discord = { channels: [...existing, target] };
        }
      } else if (channel === 'telegram') {
        const existing = bindings.telegram?.users ?? [];
        if (!existing.includes(target)) {
          bindings.telegram = { users: [...existing, target] };
        }
      } else {
        console.error(`Unknown channel type: ${channel}. Use "discord" or "telegram".`);
        process.exit(1);
      }

      const agentJsonPath = join(getRuntimePaths().agentsDir, agentId, 'agent.json');
      if (existsSync(agentJsonPath)) {
        const raw = await readFile(agentJsonPath, 'utf-8');
        const entry = JSON.parse(raw);
        entry.bindings = bindings;
        await writeFile(agentJsonPath, JSON.stringify(entry, null, 2), 'utf-8');
      }

      console.log(`Bound ${channel}/${target} → agent ${agentId}`);
      break;
    }

    case 'unbind': {
      const agentId = args[1];
      const channel = args.includes('--channel') ? args[args.indexOf('--channel') + 1] : undefined;
      const target = args.includes('--target') ? args[args.indexOf('--target') + 1] : undefined;

      if (!agentId || !channel || !target) {
        console.error('Usage: tako agents unbind <agentId> --channel <discord|telegram> --target <channelId>');
        process.exit(1);
      }

      const agent = registry.get(agentId);
      if (!agent) {
        console.error(`Agent not found: ${agentId}`);
        process.exit(1);
      }

      const bindings = { ...agent.bindings };
      if (channel === 'discord' && bindings.discord) {
        bindings.discord.channels = bindings.discord.channels.filter((c) => c !== target);
      } else if (channel === 'telegram' && bindings.telegram) {
        bindings.telegram.users = (bindings.telegram.users ?? []).filter((u) => u !== target);
      }

      const agentJsonPath = join(getRuntimePaths().agentsDir, agentId, 'agent.json');
      if (existsSync(agentJsonPath)) {
        const raw = await readFile(agentJsonPath, 'utf-8');
        const entry = JSON.parse(raw);
        entry.bindings = bindings;
        await writeFile(agentJsonPath, JSON.stringify(entry, null, 2), 'utf-8');
      }

      console.log(`Unbound ${channel}/${target} from agent ${agentId}`);
      break;
    }

    case 'bindings': {
      const agents = registry.list();
      let hasBindings = false;

      console.log('Agent Bindings:\n');
      for (const agent of agents) {
        const b = agent.bindings;
        if (!b || (Object.keys(b).length === 0)) continue;

        hasBindings = true;
        console.log(`  ${agent.id}:`);
        if (b.discord?.channels?.length) {
          console.log(`    Discord: ${b.discord.channels.join(', ')}`);
        }
        if (b.telegram?.users?.length) {
          console.log(`    Telegram users: ${b.telegram.users.join(', ')}`);
        }
        if (b.telegram?.groups?.length) {
          console.log(`    Telegram groups: ${b.telegram.groups.join(', ')}`);
        }
        if (b.cli) {
          console.log(`    CLI: bound`);
        }
        console.log();
      }

      if (!hasBindings) {
        console.log('  No bindings configured.');
        console.log('\n  Add bindings with: tako agents bind <agentId> --channel discord --target <channelId>');
      }
      break;
    }

    case 'set-identity': {
      const agentId = args[1];
      if (!agentId) {
        console.error('Usage: tako agents set-identity <agentId> --name <name> [--emoji <emoji>]');
        process.exit(1);
      }

      const agent = registry.get(agentId);
      if (!agent) {
        console.error(`Agent not found: ${agentId}`);
        process.exit(1);
      }

      const nameArg = args.includes('--name') ? args[args.indexOf('--name') + 1] : undefined;
      const emojiArg = args.includes('--emoji') ? args[args.indexOf('--emoji') + 1] : undefined;

      if (!nameArg && !emojiArg) {
        console.error('Provide at least --name or --emoji');
        process.exit(1);
      }

      const agentJsonPath = join(getRuntimePaths().agentsDir, agentId, 'agent.json');
      let entry: Record<string, unknown> = {};
      if (existsSync(agentJsonPath)) {
        const raw = await readFile(agentJsonPath, 'utf-8');
        entry = JSON.parse(raw);
      }

      if (nameArg) entry.displayName = nameArg;
      if (emojiArg) entry.emoji = emojiArg;

      await writeFile(agentJsonPath, JSON.stringify(entry, null, 2), 'utf-8');
      console.log(`Updated identity for agent ${agentId}:`);
      if (nameArg) console.log(`  Name: ${nameArg}`);
      if (emojiArg) console.log(`  Emoji: ${emojiArg}`);
      break;
    }

    default:
      console.error(`Unknown agents subcommand: ${subcommand}`);
      console.error('Available: list, add, remove, info, bind, unbind, bindings, set-identity');
      process.exit(1);
  }
}
