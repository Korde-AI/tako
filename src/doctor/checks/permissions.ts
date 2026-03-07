/**
 * File permissions health check.
 *
 * Checks config file, workspace, and session store permissions.
 */

import { stat, access, constants } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { TakoConfig } from '../../config/schema.js';
import type { CheckResult } from '../doctor.js';

export async function checkPermissions(config: TakoConfig): Promise<CheckResult> {
  const issues: string[] = [];

  // Check config file permissions (should not be world-readable if it contains tokens)
  try {
    const configPath = join(homedir(), '.tako', 'tako.json');
    const configStat = await stat(configPath);
    const mode = configStat.mode & 0o777;

    // Warn if group or world readable and tokens are configured
    const hasTokens = !!(config.channels.discord?.token || config.channels.telegram?.token || config.gateway.authToken);
    if (hasTokens && (mode & 0o044)) {
      issues.push(`~/.tako/tako.json is readable by others (mode: ${mode.toString(8)}) and contains tokens. Run: chmod 600 ~/.tako/tako.json`);
    }
  } catch {
    // No ~/.tako/tako.json — that's fine
  }

  // Check workspace directory is writable
  try {
    await access(config.memory.workspace, constants.W_OK | constants.R_OK);
  } catch {
    issues.push(`Workspace directory not writable: ${config.memory.workspace}`);
  }

  // Check session store directory (if it exists)
  const sessionDir = `${config.memory.workspace}/.sessions`;
  try {
    const sessionStat = await stat(sessionDir);
    if (sessionStat.isDirectory()) {
      await access(sessionDir, constants.W_OK | constants.R_OK);
    }
  } catch {
    // Session dir doesn't exist yet — that's fine
  }

  if (issues.length > 0) {
    return {
      name: 'permissions',
      status: 'warn',
      message: issues.join('; '),
      repairable: true,
    };
  }

  return { name: 'permissions', status: 'ok', message: 'File permissions OK', repairable: false };
}
