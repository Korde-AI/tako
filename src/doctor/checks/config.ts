/**
 * Config validation health check.
 *
 * Parses tako.json and checks required fields, validates provider format,
 * gateway config, and channel configuration.
 */

import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { TakoConfig } from '../../config/schema.js';
import type { CheckResult } from '../doctor.js';
import { getRuntimePaths } from '../../core/paths.js';

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

  if (config.network?.hub) {
    const rawHub = config.network.hub.trim();
    const normalized = rawHub.includes('://') ? rawHub : `http://${rawHub}`;
    try {
      const url = new URL(normalized);
      if (!url.hostname || !url.port) {
        return {
          name: 'config',
          status: 'warn',
          message: `network.hub should include host and port, got "${config.network.hub}"`,
          repairable: false,
        };
      }
    } catch {
      return {
        name: 'config',
        status: 'warn',
        message: `network.hub is not a valid hub address: "${config.network.hub}"`,
        repairable: false,
      };
    }
  }

  // Try to parse the raw config file for syntax issues
  const configPath = getRuntimePaths().configFile;
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
  const paths = getRuntimePaths();
  if (config.network?.hub && !existsSync(paths.networkDir)) {
    issues.push(`network state directory does not exist yet at ${paths.networkDir}`);
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
