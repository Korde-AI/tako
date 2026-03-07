/**
 * Session integrity health check.
 *
 * Verifies session files are valid JSON, checks for corruption,
 * and reports session store health.
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import type { TakoConfig } from '../../config/schema.js';
import type { CheckResult } from '../doctor.js';

export async function checkSessions(config: TakoConfig): Promise<CheckResult> {
  const sessionDir = join(config.memory.workspace, '.sessions');

  // Check if session directory exists
  try {
    const s = await stat(sessionDir);
    if (!s.isDirectory()) {
      return {
        name: 'sessions',
        status: 'warn',
        message: `Session path is not a directory: ${sessionDir}`,
        repairable: true,
      };
    }
  } catch {
    // No session directory — no persisted sessions, that's OK
    return {
      name: 'sessions',
      status: 'ok',
      message: 'No persisted sessions (session directory not yet created)',
      repairable: false,
    };
  }

  // Scan session files
  let files: string[];
  try {
    files = await readdir(sessionDir);
  } catch (err) {
    return {
      name: 'sessions',
      status: 'error',
      message: `Cannot read session directory: ${err instanceof Error ? err.message : err}`,
      repairable: false,
    };
  }

  const jsonFiles = files.filter((f) => f.endsWith('.json'));
  if (jsonFiles.length === 0) {
    return {
      name: 'sessions',
      status: 'ok',
      message: 'Session store empty',
      repairable: false,
    };
  }

  let valid = 0;
  const corrupted: string[] = [];

  for (const file of jsonFiles) {
    try {
      const raw = await readFile(join(sessionDir, file), 'utf-8');
      const data = JSON.parse(raw);

      // Basic structure validation
      if (!data.id || !data.name || !data.createdAt || !Array.isArray(data.messages)) {
        corrupted.push(file);
        continue;
      }

      valid++;
    } catch {
      corrupted.push(file);
    }
  }

  if (corrupted.length > 0) {
    return {
      name: 'sessions',
      status: 'warn',
      message: `${valid} valid sessions, ${corrupted.length} corrupted: ${corrupted.join(', ')}`,
      repairable: true,
    };
  }

  return {
    name: 'sessions',
    status: 'ok',
    message: `${valid} sessions healthy`,
    repairable: false,
  };
}
