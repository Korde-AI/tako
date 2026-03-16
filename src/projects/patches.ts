import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface WorktreeRepoStatus {
  root: string;
  isGitRepo: boolean;
  branch?: string;
  dirty?: boolean;
}

export async function getWorktreeRepoStatus(root: string): Promise<WorktreeRepoStatus> {
  try {
    const { stdout: inside } = await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root });
    if (inside.trim() !== 'true') {
      return { root, isGitRepo: false };
    }
    const [{ stdout: branchRaw }, { stdout: statusRaw }] = await Promise.all([
      execFileAsync('git', ['branch', '--show-current'], { cwd: root }),
      execFileAsync('git', ['status', '--porcelain'], { cwd: root }),
    ]);
    return {
      root,
      isGitRepo: true,
      branch: branchRaw.trim() || undefined,
      dirty: statusRaw.trim().length > 0,
    };
  } catch {
    return { root, isGitRepo: false };
  }
}

export async function createPatchFromWorktree(root: string): Promise<string> {
  const { stdout } = await execFileAsync('git', ['diff', '--binary', '--no-ext-diff', 'HEAD'], {
    cwd: root,
    maxBuffer: 4 * 1024 * 1024,
  });
  return stdout;
}

export async function applyPatchToWorktree(root: string, patchPath: string): Promise<{ applied: boolean; output: string }> {
  try {
    const { stdout, stderr } = await execFileAsync('git', ['apply', '--3way', patchPath], {
      cwd: root,
      maxBuffer: 4 * 1024 * 1024,
    });
    return { applied: true, output: [stdout, stderr].filter(Boolean).join('\n').trim() || 'Patch applied.' };
  } catch (err) {
    const output = err && typeof err === 'object'
      ? [String((err as { stdout?: unknown }).stdout ?? ''), String((err as { stderr?: unknown }).stderr ?? '')]
          .filter(Boolean)
          .join('\n')
          .trim()
      : '';
    return { applied: false, output: output || (err instanceof Error ? err.message : String(err)) };
  }
}
