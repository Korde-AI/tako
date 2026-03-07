/**
 * Auto-repair actions for the doctor.
 */

import { mkdir, writeFile, chmod } from 'node:fs/promises';
import { join } from 'node:path';

/** Ensure a directory exists with correct permissions. */
export async function ensureDir(path: string, mode?: number): Promise<void> {
  await mkdir(path, { recursive: true });
  if (mode !== undefined) {
    await chmod(path, mode);
  }
}

/** Create a missing workspace file with default content. */
export async function createDefaultFile(
  workspacePath: string,
  filename: string,
  content: string,
): Promise<void> {
  const filePath = join(workspacePath, filename);
  await writeFile(filePath, content, 'utf-8');
}

/** Fix file permissions (e.g. config should be 600). */
export async function fixPermissions(path: string, mode: number): Promise<void> {
  await chmod(path, mode);
}

/** Rebuild a corrupted vector index. */
export async function rebuildVectorIndex(_workspacePath: string): Promise<void> {
  // TODO: Clear and re-index all workspace files
}

/** Generate a random auth token. */
export function generateAuthToken(): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
}
