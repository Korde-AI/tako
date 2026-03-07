/**
 * Channel status health check.
 *
 * Verifies bot tokens for configured channels by testing API connectivity.
 */

import type { TakoConfig } from '../../config/schema.js';
import type { CheckResult } from '../doctor.js';

export async function checkChannels(config: TakoConfig): Promise<CheckResult> {
  const configured: string[] = [];
  const issues: string[] = [];

  if (config.channels.discord) {
    configured.push('discord');
    if (!config.channels.discord.token) {
      issues.push('Discord token is empty');
    } else {
      // Validate Discord bot token format (roughly: base64.base64.base64)
      const parts = config.channels.discord.token.split('.');
      if (parts.length < 3) {
        issues.push('Discord token format looks invalid');
      } else {
        // Test Discord API connectivity
        try {
          const response = await fetch('https://discord.com/api/v10/users/@me', {
            headers: { Authorization: `Bot ${config.channels.discord.token}` },
            signal: AbortSignal.timeout(10_000),
          });
          if (response.status === 401) {
            issues.push('Discord bot token is invalid (401)');
          } else if (response.ok) {
            const data = await response.json() as { username?: string };
            configured[configured.length - 1] = `discord (@${data.username ?? 'unknown'})`;
          }
        } catch (err) {
          issues.push(`Discord connectivity failed: ${err instanceof Error ? err.message : err}`);
        }
      }
    }
  }

  if (config.channels.telegram) {
    configured.push('telegram');
    if (!config.channels.telegram.token) {
      issues.push('Telegram token is empty');
    } else {
      // Test Telegram Bot API connectivity
      try {
        const response = await fetch(
          `https://api.telegram.org/bot${config.channels.telegram.token}/getMe`,
          { signal: AbortSignal.timeout(10_000) },
        );
        if (response.ok) {
          const data = await response.json() as { result?: { username?: string } };
          if (data.result?.username) {
            configured[configured.length - 1] = `telegram (@${data.result.username})`;
          }
        } else {
          issues.push(`Telegram bot token invalid (HTTP ${response.status})`);
        }
      } catch (err) {
        issues.push(`Telegram connectivity failed: ${err instanceof Error ? err.message : err}`);
      }
    }
  }

  if (config.channels.cli) configured.push('cli');

  if (configured.length === 0) {
    return {
      name: 'channels',
      status: 'warn',
      message: 'No channels configured — CLI will be used by default',
      repairable: false,
    };
  }

  if (issues.length > 0) {
    return {
      name: 'channels',
      status: 'warn',
      message: `Channels: ${configured.join(', ')}. Issues: ${issues.join('; ')}`,
      repairable: false,
    };
  }

  return {
    name: 'channels',
    status: 'ok',
    message: `Channels configured: ${configured.join(', ')}`,
    repairable: false,
  };
}
