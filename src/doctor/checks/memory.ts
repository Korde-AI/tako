/**
 * Memory/workspace health check.
 *
 * Verifies workspace exists, required files are readable,
 * and memory directory is functional.
 */

import { access, stat, readdir, constants } from 'node:fs/promises';
import { join } from 'node:path';
import type { TakoConfig } from '../../config/schema.js';
import type { CheckResult } from '../doctor.js';

export async function checkMemory(config: TakoConfig): Promise<CheckResult> {
  const wsPath = config.memory.workspace;

  // Check workspace directory exists
  try {
    const s = await stat(wsPath);
    if (!s.isDirectory()) {
      return {
        name: 'memory',
        status: 'error',
        message: `Workspace path is not a directory: ${wsPath}`,
        repairable: true,
      };
    }
  } catch {
    return {
      name: 'memory',
      status: 'error',
      message: `Workspace directory not found: ${wsPath}`,
      repairable: true,
    };
  }

  // Check workspace is readable and writable
  try {
    await access(wsPath, constants.R_OK | constants.W_OK);
  } catch {
    return {
      name: 'memory',
      status: 'error',
      message: `Workspace directory not readable/writable: ${wsPath}`,
      repairable: true,
    };
  }

  // Check key files exist
  const requiredFiles = ['AGENTS.md', 'SOUL.md', 'IDENTITY.md'];
  const missing: string[] = [];
  for (const f of requiredFiles) {
    try {
      await access(join(wsPath, f), constants.R_OK);
    } catch {
      missing.push(f);
    }
  }

  if (missing.length > 0) {
    return {
      name: 'memory',
      status: 'warn',
      message: `Missing workspace files: ${missing.join(', ')}`,
      repairable: true,
    };
  }

  // Check memory subdirectory
  const memoryDir = join(wsPath, 'memory');
  try {
    const memStat = await stat(memoryDir);
    if (memStat.isDirectory()) {
      const files = await readdir(memoryDir);
      const mdFiles = files.filter((f) => f.endsWith('.md'));
      return {
        name: 'memory',
        status: 'ok',
        message: `Workspace healthy (${mdFiles.length} memory files)`,
        repairable: false,
      };
    }
  } catch {
    // memory/ doesn't exist yet — not critical
  }

  return { name: 'memory', status: 'ok', message: 'Workspace healthy', repairable: false };
}
