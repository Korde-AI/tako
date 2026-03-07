/**
 * CLI: tako config — view and modify configuration.
 */

import { resolveConfig, patchConfig } from '../config/resolve.js';

/**
 * Get a value from a nested object by dot path.
 */
function getByPath(obj: unknown, path: string): unknown {
  const parts = path.split('.');
  let current: unknown = obj;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/**
 * Build a nested patch object from a dot path and value.
 * e.g. ('providers.primary', 'anthropic/claude-opus-4-6')
 * → { providers: { primary: 'anthropic/claude-opus-4-6' } }
 */
function buildPatch(path: string, value: unknown): Record<string, unknown> {
  const parts = path.split('.');
  let result: Record<string, unknown> = {};
  let current = result;
  for (let i = 0; i < parts.length - 1; i++) {
    const next: Record<string, unknown> = {};
    current[parts[i]] = next;
    current = next;
  }
  current[parts[parts.length - 1]] = value;
  return result;
}

/**
 * Try to parse a value as JSON; fall back to string.
 */
function parseValue(raw: string): unknown {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (raw === 'null') return null;
  if (/^\d+$/.test(raw)) return parseInt(raw, 10);
  if (/^\d+\.\d+$/.test(raw)) return parseFloat(raw);
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

export async function runConfig(args: string[]): Promise<void> {
  const subcommand = args[0] ?? 'file';

  switch (subcommand) {
    case 'file': {
      const config = await resolveConfig();
      if (config._configPath) {
        console.log(config._configPath);
      } else {
        console.log('No config file found — using built-in defaults.');
        console.log('Create one with: tako onboard');
      }
      break;
    }

    case 'get': {
      const path = args[1];
      if (!path) {
        console.error('Usage: tako config get <dot.path>');
        console.error('  Example: tako config get providers.primary');
        process.exit(1);
      }
      const config = await resolveConfig();
      const value = getByPath(config, path);
      if (value === undefined) {
        console.error(`No value at path: ${path}`);
        process.exit(1);
      }
      if (typeof value === 'object' && value !== null) {
        console.log(JSON.stringify(value, null, 2));
      } else {
        console.log(String(value));
      }
      break;
    }

    case 'set': {
      const path = args[1];
      const rawValue = args[2];
      if (!path || rawValue === undefined) {
        console.error('Usage: tako config set <dot.path> <value>');
        console.error('  Example: tako config set providers.primary anthropic/claude-opus-4-6');
        console.error('  Example: tako config set agent.timeout 300');
        process.exit(1);
      }
      const value = parseValue(rawValue);
      const patch = buildPatch(path, value);
      await patchConfig(patch);
      console.log(`Set ${path} = ${JSON.stringify(value)}`);
      break;
    }

    case 'unset': {
      const path = args[1];
      if (!path) {
        console.error('Usage: tako config unset <dot.path>');
        process.exit(1);
      }
      const patch = buildPatch(path, undefined);
      await patchConfig(patch);
      console.log(`Unset ${path}`);
      break;
    }

    case 'validate': {
      try {
        const config = await resolveConfig();
        // Basic validation checks
        const issues: string[] = [];

        if (!config.providers.primary) {
          issues.push('providers.primary is not set');
        }
        if (config.gateway.port < 1 || config.gateway.port > 65535) {
          issues.push(`gateway.port ${config.gateway.port} is out of range (1-65535)`);
        }
        if (!['minimal', 'coding', 'full'].includes(config.tools.profile)) {
          issues.push(`tools.profile "${config.tools.profile}" is invalid (expected: minimal, coding, full)`);
        }
        if (!['off', 'non-main', 'all'].includes(config.sandbox.mode)) {
          issues.push(`sandbox.mode "${config.sandbox.mode}" is invalid (expected: off, non-main, all)`);
        }
        if (!['none', 'adaptive', 'always'].includes(config.agent.thinking)) {
          issues.push(`agent.thinking "${config.agent.thinking}" is invalid (expected: none, adaptive, always)`);
        }

        if (issues.length > 0) {
          console.log('Config validation found issues:\n');
          for (const issue of issues) {
            console.log(`  ✗ ${issue}`);
          }
          process.exit(1);
        } else {
          console.log('✓ Config is valid.');
          if (config._configPath) {
            console.log(`  File: ${config._configPath}`);
          }
          console.log(`  Model: ${config.providers.primary}`);
          console.log(`  Gateway: ${config.gateway.bind}:${config.gateway.port}`);
          console.log(`  Tools: ${config.tools.profile}`);
          console.log(`  Sandbox: ${config.sandbox.mode}`);
        }
      } catch (err) {
        console.error(`Config validation failed: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      }
      break;
    }

    default:
      console.error(`Unknown config subcommand: ${subcommand}`);
      console.error('Available: file, get, set, unset, validate');
      process.exit(1);
  }
}
