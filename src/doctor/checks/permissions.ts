/**
 * File permissions health check.
 *
 * Checks config file, workspace, and session store permissions.
 */

import { stat, access, constants } from 'node:fs/promises';
import type { TakoConfig } from '../../config/schema.js';
import type { CheckResult } from '../doctor.js';
import { getRuntimePaths } from '../../core/paths.js';
import { ProjectRegistry } from '../../projects/registry.js';
import { resolveProjectRoot } from '../../projects/root.js';

export async function checkPermissions(config: TakoConfig): Promise<CheckResult> {
  const issues: string[] = [];
  const paths = getRuntimePaths();

  // Check config file permissions (should not be world-readable if it contains tokens)
  try {
    const configPath = paths.configFile;
    const configStat = await stat(configPath);
    const mode = configStat.mode & 0o777;

    // Warn if group or world readable and tokens are configured
    const hasTokens = !!(config.channels.discord?.token || config.channels.telegram?.token || config.gateway.authToken);
    if (hasTokens && (mode & 0o044)) {
      issues.push(`${configPath} is readable by others (mode: ${mode.toString(8)}) and contains tokens. Run: chmod 600 ${configPath}`);
    }
  } catch {
    // No config file in the current home — that's fine
  }

  try {
    await access(paths.networkDir, constants.R_OK | constants.W_OK);
  } catch {
    issues.push(`Network state directory not readable/writable: ${paths.networkDir}`);
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

  try {
    const projects = new ProjectRegistry(paths.projectsDir);
    await projects.load();
    for (const project of projects.list()) {
      const projectRoot = resolveProjectRoot(paths, project);
      try {
        await access(projectRoot, constants.R_OK | constants.W_OK);
      } catch {
        issues.push(`Project root not readable/writable for ${project.slug}: ${projectRoot}`);
      }
    }
  } catch {
    issues.push(`Could not inspect project roots under ${paths.projectsDir}`);
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
