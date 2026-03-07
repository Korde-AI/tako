/**
 * Config validation health check.
 *
 * Parses tako.json and checks required fields, validates provider format,
 * gateway config, and channel configuration.
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { TakoConfig } from '../../config/schema.js';
import type { CheckResult } from '../doctor.js';

export async function checkConfig(config: TakoConfig): Promise<CheckResult> {
  // Validate required fields
  if (!config.providers.primary) {
    return {
      name: 'config',
      status: 'error',
      message: 'No primary provider configured',
      repairable: false,
    };
  }

  // Validate provider format (should be "provider/model")
  const parts = config.providers.primary.split('/');
  if (parts.length < 2) {
    return {
      name: 'config',
      status: 'warn',
      message: `Provider format should be "provider/model", got "${config.providers.primary}"`,
      repairable: false,
    };
  }

  const [provider] = parts;
  const validProviders = ['anthropic', 'openai', 'litellm'];
  if (!validProviders.includes(provider)) {
    return {
      name: 'config',
      status: 'warn',
      message: `Unknown provider "${provider}" — expected one of: ${validProviders.join(', ')}`,
      repairable: false,
    };
  }

  // Validate gateway port
  if (config.gateway.port < 1 || config.gateway.port > 65535) {
    return {
      name: 'config',
      status: 'error',
      message: `Invalid gateway port: ${config.gateway.port}`,
      repairable: false,
    };
  }

  // Validate agent timeout
  if (config.agent.timeout <= 0) {
    return {
      name: 'config',
      status: 'warn',
      message: `Agent timeout should be positive, got ${config.agent.timeout}`,
      repairable: false,
    };
  }

  // Try to parse the raw config file for syntax issues
  const configPath = join(homedir(), '.tako', 'tako.json');
  try {
    const raw = await readFile(configPath, 'utf-8');
    JSON.parse(raw);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      return {
        name: 'config',
        status: 'error',
        message: `tako.json parse error: ${err instanceof Error ? err.message : err}`,
        repairable: false,
      };
    }
  }

  // Check for deprecated config keys
  const issues: string[] = [];
  if (config.tools.profile === 'minimal' && (config.tools.allow?.length ?? 0) > 0) {
    issues.push('allow list has no effect with "minimal" profile');
  }

  if (issues.length > 0) {
    return {
      name: 'config',
      status: 'warn',
      message: `Config valid with notes: ${issues.join('; ')}`,
      repairable: false,
    };
  }

  return { name: 'config', status: 'ok', message: 'Config valid', repairable: false };
}
