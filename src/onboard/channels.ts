/**
 * Tako 🐙 Channel Management CLI
 *
 * Commands:
 *   tako channels list              List configured channels
 *   tako channels add discord       Interactive Discord setup
 *   tako channels add telegram      Interactive Telegram setup
 *   tako channels remove discord    Remove channel
 *   tako channels status            Show channel connection status
 */

import * as p from '@clack/prompts';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { TakoConfig } from '../config/schema.js';

// ─── Config helpers ──────────────────────────────────────────────────

function getConfigPath(): string {
  return join(homedir(), '.tako', 'tako.json');
}

async function loadConfigFile(): Promise<Partial<TakoConfig>> {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) return {};
  const raw = await readFile(configPath, 'utf-8');
  return JSON.parse(raw) as Partial<TakoConfig>;
}

async function saveConfigFile(config: Partial<TakoConfig>): Promise<void> {
  const configPath = getConfigPath();
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

// ─── Commands ────────────────────────────────────────────────────────

export async function runChannels(args: string[]): Promise<void> {
  const subcommand = args[0] ?? 'status';

  switch (subcommand) {
    case 'list':
      await channelsList();
      break;
    case 'add':
      await channelsAdd(args[1]);
      break;
    case 'remove':
      await channelsRemove(args[1]);
      break;
    case 'status':
      await channelsStatus();
      break;
    default:
      console.error(`Unknown channels subcommand: ${subcommand}`);
      console.error('Available: list, add, remove, status');
      process.exit(1);
  }
}

async function channelsList(): Promise<void> {
  const config = await loadConfigFile();
  const channels = config.channels ?? {};

  console.log('Configured channels:\n');
  console.log('  ● cli (always active)');

  if (channels.discord?.token) {
    console.log('  ● discord (configured)');
  }
  if (channels.telegram?.token) {
    console.log('  ● telegram (configured)');
  }

  if (!channels.discord?.token && !channels.telegram?.token) {
    console.log('\nNo additional channels configured.');
    console.log("Use 'tako channels add discord' or 'tako channels add telegram' to set one up.");
  }
}

async function channelsAdd(channel?: string): Promise<void> {
  if (!channel) {
    const choice = await p.select({
      message: 'Which channel would you like to add?',
      options: [
        { value: 'discord', label: 'Discord', hint: 'requires bot token' },
        { value: 'telegram', label: 'Telegram', hint: 'requires bot token from @BotFather' },
      ],
    });
    if (p.isCancel(choice)) { p.cancel('Cancelled.'); process.exit(0); }
    channel = choice;
  }

  const config = await loadConfigFile();
  config.channels = config.channels ?? {};

  if (channel === 'discord') {
    // Check if already configured
    if (config.channels.discord?.token) {
      const replace = await p.confirm({
        message: 'Discord is already configured. Replace it?',
        initialValue: false,
      });
      if (p.isCancel(replace) || !replace) return;
    }

    p.log.info('Discord Bot Setup');
    p.log.message('Create a bot at https://discord.com/developers/applications');

    const token = await p.password({
      message: 'Discord bot token:',
      validate: (val) => val ? undefined : 'Token is required',
    });
    if (p.isCancel(token)) { p.cancel('Cancelled.'); process.exit(0); }

    // Verify
    const spinner = p.spinner();
    spinner.start('Verifying Discord token...');
    try {
      const res = await fetch('https://discord.com/api/v10/users/@me', {
        headers: { Authorization: `Bot ${token}` },
      });
      if (res.ok) {
        const bot = await res.json() as { username: string; discriminator: string };
        spinner.stop(`Connected! Bot: ${bot.username}#${bot.discriminator}`);
      } else {
        spinner.stop('Token verification failed. Saved anyway — you can fix later.');
      }
    } catch {
      spinner.stop('Could not reach Discord API. Token saved anyway.');
    }

    const guilds = await p.text({
      message: 'Restrict to specific guild IDs? (comma-separated, or leave empty)',
      placeholder: 'Leave empty for all guilds',
      defaultValue: '',
    });
    if (p.isCancel(guilds)) { p.cancel('Cancelled.'); process.exit(0); }

    config.channels.discord = {
      token,
      ...(guilds && guilds.trim() ? { guilds: guilds.split(',').map((g) => g.trim()) } : {}),
    };
  } else if (channel === 'telegram') {
    if (config.channels.telegram?.token) {
      const replace = await p.confirm({
        message: 'Telegram is already configured. Replace it?',
        initialValue: false,
      });
      if (p.isCancel(replace) || !replace) return;
    }

    p.log.info('Telegram Bot Setup');
    p.log.message('Get a token from @BotFather on Telegram');

    const token = await p.password({
      message: 'Telegram bot token:',
      validate: (val) => val ? undefined : 'Token is required',
    });
    if (p.isCancel(token)) { p.cancel('Cancelled.'); process.exit(0); }

    // Verify
    const spinner = p.spinner();
    spinner.start('Verifying Telegram token...');
    try {
      const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
      if (res.ok) {
        const data = await res.json() as { result: { username: string } };
        spinner.stop(`Connected! Bot: @${data.result.username}`);
      } else {
        spinner.stop('Token verification failed. Saved anyway — you can fix later.');
      }
    } catch {
      spinner.stop('Could not reach Telegram API. Token saved anyway.');
    }

    const allowedUsers = await p.text({
      message: 'Restrict to specific user IDs? (comma-separated, or leave empty)',
      placeholder: 'Leave empty to allow all users',
      defaultValue: '',
    });
    if (p.isCancel(allowedUsers)) { p.cancel('Cancelled.'); process.exit(0); }

    config.channels.telegram = {
      token,
      ...(allowedUsers && allowedUsers.trim()
        ? { allowedUsers: allowedUsers.split(',').map((u) => u.trim()) }
        : {}),
    };
  } else {
    console.error(`Unknown channel: ${channel}`);
    console.error('Available: discord, telegram');
    process.exit(1);
  }

  await saveConfigFile(config);
  console.log(`\n${channel} channel configured and saved to ~/.tako/tako.json`);
}

async function channelsRemove(channel?: string): Promise<void> {
  if (!channel) {
    const config = await loadConfigFile();
    const channels = config.channels ?? {};
    const configured: { value: string; label: string }[] = [];
    if (channels.discord?.token) configured.push({ value: 'discord', label: 'Discord' });
    if (channels.telegram?.token) configured.push({ value: 'telegram', label: 'Telegram' });

    if (configured.length === 0) {
      console.log('No channels to remove.');
      return;
    }

    const choice = await p.select({
      message: 'Which channel to remove?',
      options: configured,
    });
    if (p.isCancel(choice)) { p.cancel('Cancelled.'); process.exit(0); }
    channel = choice;
  }

  const config = await loadConfigFile();
  config.channels = config.channels ?? {};

  if (channel === 'discord') {
    delete config.channels.discord;
  } else if (channel === 'telegram') {
    delete config.channels.telegram;
  } else {
    console.error(`Unknown channel: ${channel}`);
    process.exit(1);
  }

  await saveConfigFile(config);
  console.log(`${channel} channel removed.`);
}

async function channelsStatus(): Promise<void> {
  const config = await loadConfigFile();
  const channels = config.channels ?? {};

  console.log('Tako 🐙 Channel Status\n');
  console.log('  cli      — always active');

  if (channels.discord?.token) {
    const spinner = p.spinner();
    spinner.start('Checking Discord connection...');
    try {
      const res = await fetch('https://discord.com/api/v10/users/@me', {
        headers: { Authorization: `Bot ${channels.discord.token}` },
      });
      if (res.ok) {
        const bot = await res.json() as { username: string; discriminator: string };
        spinner.stop(`discord  — connected (${bot.username}#${bot.discriminator})`);
      } else {
        spinner.stop('discord  — token invalid');
      }
    } catch {
      spinner.stop('discord  — cannot reach API');
    }
  } else {
    console.log('  discord  — not configured');
  }

  if (channels.telegram?.token) {
    const spinner = p.spinner();
    spinner.start('Checking Telegram connection...');
    try {
      const res = await fetch(`https://api.telegram.org/bot${channels.telegram.token}/getMe`);
      if (res.ok) {
        const data = await res.json() as { result: { username: string } };
        spinner.stop(`telegram — connected (@${data.result.username})`);
      } else {
        spinner.stop('telegram — token invalid');
      }
    } catch {
      spinner.stop('telegram — cannot reach API');
    }
  } else {
    console.log('  telegram — not configured');
  }
}
