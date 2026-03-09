/**
 * Command registry — handles slash commands locally before they reach the agent loop.
 *
 * Built-in commands: /status, /help, /new, /compact, /model, /agents, /whoami
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Session } from '../gateway/session.js';
import type { SkillCommandSpec } from './skill-commands.js';
import type { LoadedSkill } from '../skills/types.js';
import { buildSkillCommands } from './skill-commands.js';
import type { UsageTracker } from '../core/usage-tracker.js';
import { claimOwner, isClaimed } from '../auth/allow-from.js';

export interface CommandContext {
  channelId: string;
  authorId: string;
  authorName: string;
  session: Session;
  agentId: string;
}

export interface CommandDeps {
  getModel: () => string;
  setModel: (ref: string) => void;
  getDefaultModel?: () => string;
  getFallbackModels?: () => string[];
  listAgents: () => Array<{ id: string; description?: string; role?: string }>;
  compactSession: (sessionId: string, keepLast?: number) => Promise<void>;
  resetSession?: (sessionId: string) => Promise<void>;
  estimateTokens: (session: Session) => number;
  startTime: number;
  getWorkspaceRoot?: () => string;
  getSessionCount?: () => number;
  getChannelNames?: () => string[];
  getSkillCount?: () => number;
  getToolCount?: () => number;
  getQueueMode?: () => string;
  setQueueMode?: (mode: 'off' | 'collect' | 'debounce') => void;
  getQueueStatus?: () => Array<{ sessionId: string; depth: number; oldestMs: number }>;
  usageTracker?: UsageTracker;
  runAcpCommand?: (args: string, ctx: CommandContext) => Promise<string>;
}

interface Command {
  name: string;
  description: string;
  handler: (args: string, ctx: CommandContext) => Promise<string>;
}

export class CommandRegistry {
  private commands = new Map<string, Command>();

  constructor(private deps: CommandDeps) {
    this.registerBuiltins();
  }

  /** Parse and handle a command. Returns response string, or null if not a known command. */
  async handle(input: string, ctx: CommandContext): Promise<string | null> {
    const trimmed = input.trim();
    if (!trimmed.startsWith('/')) return null;

    const spaceIdx = trimmed.indexOf(' ');
    const name = (spaceIdx === -1 ? trimmed.slice(1) : trimmed.slice(1, spaceIdx)).toLowerCase();
    const args = spaceIdx === -1 ? '' : trimmed.slice(spaceIdx + 1).trim();

    const cmd = this.commands.get(name);
    if (!cmd) return null;

    return cmd.handler(args, ctx);
  }

  /** Get all registered commands (for Telegram bot menu, /help, etc.). */
  list(): Array<{ name: string; description: string }> {
    return Array.from(this.commands.values()).map((c) => ({
      name: c.name,
      description: c.description,
    }));
  }

  /** Get a registered command by name (for external lookup). */
  getCommand(name: string): Command | undefined {
    return this.commands.get(name);
  }

  /** Registered skill command specs (for channel registration). */
  private skillSpecs: SkillCommandSpec[] = [];

  /** Get registered skill command specs. */
  getSkillSpecs(): SkillCommandSpec[] {
    return this.skillSpecs;
  }

  /**
   * Build and register skill commands from loaded skills.
   * Returns the generated specs for channel registration.
   */
  buildFromSkills(skills: LoadedSkill[]): SkillCommandSpec[] {
    // Remove previously registered skill commands
    for (const spec of this.skillSpecs) {
      this.commands.delete(spec.name);
    }

    this.skillSpecs = buildSkillCommands(skills);

    // Register a /commands command that lists skill commands
    if (!this.commands.has('commands')) {
      this.register({
        name: 'commands',
        description: 'List all skill commands',
        handler: async () => {
          if (this.skillSpecs.length === 0) {
            return 'No skill commands registered.';
          }
          const lines = this.skillSpecs.map((s) => `/${s.name} — ${s.description}`);
          return `**Skill Commands**\n${lines.join('\n')}`;
        },
      });
    }

    return this.skillSpecs;
  }

  private register(cmd: Command): void {
    this.commands.set(cmd.name, cmd);
  }

  private registerBuiltins(): void {
    this.register({
      name: 'status',
      description: 'Show agent status',
      handler: async (_args, ctx) => {
        const model = this.deps.getModel();
        const uptimeMs = Date.now() - this.deps.startTime;
        const uptime = formatUptime(uptimeMs);
        const msgCount = ctx.session.messages.length;
        const fallbacks = this.deps.getFallbackModels?.() ?? [];
        const agents = this.deps.listAgents?.() ?? [];
        const queueStatus = this.deps.getQueueStatus?.() ?? [];
        const toolCount = this.deps.getToolCount?.() ?? 0;
        const skillCount = this.deps.getSkillCount?.() ?? 0;

        // Estimate context usage
        const contextChars = ctx.session.messages.reduce((sum, m) => {
          if (typeof m.content === 'string') return sum + m.content.length;
          if (Array.isArray(m.content)) return sum + m.content.reduce((s, p) => s + ('text' in p ? (p as any).text?.length ?? 0 : 0), 0);
          return sum;
        }, 0);
        const estimatedTokens = Math.round(contextChars / 3.5);

        const lines = [
          `🐙 **Tako Status**`,
          `━━━━━━━━━━━━━━━━━━━━━`,
          `🤖 Agent: **${ctx.agentId}**`,
          `🧠 Model: \`${model}\``,
          fallbacks.length > 0 ? `🔄 Fallbacks: ${fallbacks.join(' → ')}` : null,
          `⏱️ Uptime: ${uptime}`,
          ``,
          `📊 **Session**`,
          `💬 Messages: ${msgCount}`,
          `📦 Est. tokens: ~${estimatedTokens.toLocaleString()}`,
          `🔧 Tools: ${toolCount} active`,
          `📚 Skills: ${skillCount} loaded`,
        ];

        if (queueStatus.length > 0) {
          lines.push(``, `📬 **Queue**: ${queueStatus.length} pending`);
        }

        if (agents.length > 1) {
          lines.push(``, `👥 **Agents**: ${agents.map((a: any) => a.id).join(', ')}`);
        }

        return lines.filter(Boolean).join('\n');
      },
    });

    this.register({
      name: 'help',
      description: 'List commands or show help for one command',
      handler: async (args) => {
        const target = args.trim().replace(/^\//, '');
        const usage: Record<string, string> = {
          status: '/status — Show runtime + session stats',
          help: '/help [command] — List commands or explain one command',
          new: '/new — Start a fresh session',
          compact: '/compact — Compact current session history',
          model: '/model [name] — View or switch active model',
          agents: '/agents — List available agents',
          whoami: '/whoami — Show current agent identity',
          queue: '/queue <off|collect|debounce> — Set message queue mode',
          usage: '/usage [cost|off|tokens|full] — Show token/cost usage',
          approve: '/approve <id> <allow|deny|allow-always> — Resolve exec approval request',
          claim: '/claim — Claim ownership of this bot (first user wins, locks to allowlist)',
          acp: '/acp <agent> <prompt> — Route prompt to ACP harness (or /acp help)',
        };

        if (target) {
          const cmd = this.getCommand(target);
          if (!cmd) return `Unknown command: /${target}`;
          const line = usage[target] ?? `/${cmd.name} — ${cmd.description}`;
          return `**/${cmd.name}**\n${cmd.description}\n\n${line}`;
        }

        const lines = this.list().map((c) => {
          const brief = usage[c.name] ?? `/${c.name} — ${c.description}`;
          return `• ${brief}`;
        });
        return [
          '**Commands**',
          'Brief intros (reference runtime-style):',
          ...lines,
          '',
          'Tip: run `/help <command>` for details.',
        ].join('\n');
      },
    });

    this.register({
      name: 'new',
      description: 'Start a new session',
      handler: async (_args, ctx) => {
        if (this.deps.resetSession) {
          await this.deps.resetSession(ctx.session.id);
        } else {
          ctx.session.messages.length = 0;
        }
        return '🐙 New session started. Previous conversation archived.';
      },
    });

    this.register({
      name: 'compact',
      description: 'Compact session history',
      handler: async (_args, ctx) => {
        const msgsBefore = ctx.session.messages.length;
        if (msgsBefore <= 20) {
          return `Session has ${msgsBefore} messages — too few to compact.`;
        }
        const tokensBefore = this.deps.estimateTokens(ctx.session);
        await this.deps.compactSession(ctx.session.id);
        const tokensAfter = this.deps.estimateTokens(ctx.session);
        const msgsAfter = ctx.session.messages.length;
        return [
          `**Compacted**`,
          `Messages: ${msgsBefore} → ${msgsAfter}`,
          `Tokens: ~${tokensBefore} → ~${tokensAfter}`,
        ].join('\n');
      },
    });

    this.register({
      name: 'model',
      description: 'Show or switch current model',
      handler: async (args) => {
        const current = this.deps.getModel();
        if (!args) {
          const fallbacks = this.deps.getFallbackModels?.() ?? [];
          const lines = [`**Current model:** ${current}`];
          if (fallbacks.length > 0) {
            lines.push('**Fallback chain:**');
            fallbacks.forEach((m, i) => lines.push(`  ${i + 1}. ${m}`));
          }
          lines.push('', 'Switch: `/model <provider/model-name>`');
          lines.push('Reset to default: `/model default`');
          return lines.join('\n');
        }
        if (args === 'default') {
          const defaultModel = this.deps.getDefaultModel?.() ?? 'anthropic/claude-sonnet-4-6';
          this.deps.setModel(defaultModel);
          return `Model reset to default: ${defaultModel}`;
        }
        const prev = current;
        this.deps.setModel(args);
        return `Model switched: ${prev} → ${args}\n\n⚠️ If this model fails, use \`/model default\` to reset.`;
      },
    });

    this.register({
      name: 'agents',
      description: 'List available agents',
      handler: async () => {
        const agents = this.deps.listAgents();
        if (agents.length === 0) return 'No agents configured.';
        const lines = agents.map((a) => {
          const parts = [a.id];
          if (a.role) parts.push(`(${a.role})`);
          if (a.description) parts.push(`— ${a.description}`);
          return parts.join(' ');
        });
        return `**Agents**\n${lines.join('\n')}`;
      },
    });

    this.register({
      name: 'whoami',
      description: 'Show agent identity and runtime info',
      handler: async (_args, ctx) => {
        const model = this.deps.getModel();
        const uptimeMs = Date.now() - this.deps.startTime;
        const uptime = formatUptime(uptimeMs);
        const workspace = this.deps.getWorkspaceRoot?.() ?? '(unknown)';
        const sessionCount = this.deps.getSessionCount?.() ?? 0;
        const channels = this.deps.getChannelNames?.() ?? [];
        const skills = this.deps.getSkillCount?.() ?? 0;

        // Read SOUL.md and IDENTITY.md from agent's workspace
        let soulContent = '';
        let identityContent = '';
        try {
          soulContent = await readFile(join(workspace, 'SOUL.md'), 'utf-8');
        } catch { /* no SOUL.md */ }
        try {
          identityContent = await readFile(join(workspace, 'IDENTITY.md'), 'utf-8');
        } catch { /* no IDENTITY.md */ }

        const lines: string[] = ['🐙 **Who Am I**', ''];

        // Identity from files — convert "You are" to "I'm" for first-person voice
        if (soulContent) {
          const soulLines = soulContent.split('\n').filter(l => l.trim() && !l.startsWith('#'));
          if (soulLines.length > 0) {
            const converted = soulLines.slice(0, 3).map(line =>
              line
                .replace(/^You are /i, "I'm ")
                .replace(/You're /gi, "I'm ")
                .replace(/\byou\b/gi, 'I')
                .replace(/\byour\b/gi, 'my')
            );
            lines.push(...converted);
            lines.push('');
          }
        }

        // Runtime info
        lines.push(`**Agent:** ${ctx.agentId}`);
        lines.push(`**Model:** ${model}`);
        lines.push(`**Workspace:** ${workspace}`);
        lines.push(`**Uptime:** ${uptime}`);
        lines.push(`**Sessions:** ${sessionCount} active`);
        const uniqueChannels = [...new Set(channels)];
        if (uniqueChannels.length > 0) lines.push(`**Channels:** ${uniqueChannels.join(', ')}`);
        if (skills > 0) lines.push(`**Skills:** ${skills} loaded`);

        return lines.join('\n');
      },
    });

    this.register({
      name: 'queue',
      description: 'Show or set message queue mode (off|collect|debounce)',
      handler: async (args) => {
        if (!this.deps.getQueueMode) return 'Message queue not available.';

        if (!args) {
          const mode = this.deps.getQueueMode();
          const status = this.deps.getQueueStatus?.() ?? [];
          const lines = [`**Queue mode:** ${mode}`];
          if (status.length > 0) {
            lines.push('**Active queues:**');
            for (const s of status) {
              lines.push(`  ${s.sessionId}: ${s.depth} messages (oldest ${Math.round(s.oldestMs / 1000)}s ago)`);
            }
          } else {
            lines.push('No messages queued.');
          }
          return lines.join('\n');
        }

        const mode = args.trim().toLowerCase();
        if (mode !== 'off' && mode !== 'collect' && mode !== 'debounce') {
          return `Invalid mode: \`${mode}\`. Use \`off\`, \`collect\`, or \`debounce\`.`;
        }

        if (this.deps.setQueueMode) {
          this.deps.setQueueMode(mode);
        }
        return `Queue mode set to: **${mode}**`;
      },
    });

    this.register({
      name: 'claim',
      description: 'Claim ownership of this bot — locks it to allowlist mode. First user wins.',
      handler: async (_args, ctx) => {
        // Determine channel type from channelId (e.g. "discord:123" → "discord")
        const channelType = ctx.channelId.includes(':')
          ? ctx.channelId.split(':')[0]!
          : ctx.channelId;

        // Skip for CLI/TUI — no point locking local access
        if (channelType === 'cli' || channelType === 'tui') {
          return '`/claim` is only available on remote channels (Discord, Telegram).';
        }

        const already = await isClaimed(channelType, ctx.agentId);
        if (already) {
          return [
            '🔒 **Already claimed.**',
            'This bot already has an owner. `/claim` can only be run once.',
            '',
            'If you are the owner and need to add more users, ask the bot:',
            '> "add user `<user-id>` to the allowlist"',
          ].join('\n');
        }

        const result = await claimOwner(channelType, ctx.agentId, ctx.authorId);
        if (result.success) {
          return [
            '✅ **Claimed!**',
            `You (${ctx.authorName} / \`${ctx.authorId}\`) are now the owner of this bot on **${channelType}**.`,
            '',
            '🔒 The bot is now in **allowlist mode** — only you can talk to it.',
            '',
            'To allow others:',
            '> "add user `<user-id>` to the allowlist"',
          ].join('\n');
        }

        // Race condition — someone else claimed between the check and the write
        return '🔒 **Already claimed** by someone else. Too slow! 😄';
      },
    });

    this.register({
      name: 'acp',
      description: 'Route commands to ACP harness agents (pi/claude/codex/opencode/gemini/kimi).',
      handler: async (args, ctx) => {
        if (!this.deps.runAcpCommand) {
          return [
            'ACP command routing is not configured in this runtime.',
            'Use CLI fallback: `tako acp help`',
          ].join('\n');
        }
        return this.deps.runAcpCommand(args, ctx);
      },
    });

    this.register({
      name: 'usage',
      description: 'Show token usage and cost (args: cost, off, tokens, full)',
      handler: async (args, ctx) => {
        const tracker = this.deps.usageTracker;
        if (!tracker) return 'Usage tracking not available.';

        const sub = args.trim().toLowerCase();

        if (sub === 'cost' || sub === '') {
          return tracker.formatSessionUsage(ctx.session.id);
        }

        if (sub === 'global' || sub === 'all') {
          return tracker.formatGlobalUsage();
        }

        return [
          '**Usage Commands**',
          '`/usage` — session usage and cost',
          '`/usage global` — global usage across sessions',
        ].join('\n');
      },
    });
  }
}

function formatUptime(ms: number): string {
  const secs = Math.floor(ms / 1000);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m ${secs % 60}s`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}
