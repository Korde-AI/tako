/**
 * Exec safety — command validation, dangerous command detection,
 * working directory restrictions, timeout enforcement, and output limits.
 *
 * This module sits between the agent's exec tool call and actual shell
 * execution. It validates commands against safety rules before they run.
 */

import { resolve, relative } from 'node:path';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

// ─── Dangerous command patterns ──────────────────────────────────────

/** Patterns that match commands known to be destructive or dangerous. */
const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; description: string; severity: 'block' | 'warn' }> = [
  // Filesystem destruction
  { pattern: /\brm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?(-[a-zA-Z]*r[a-zA-Z]*\s+)?\/\s*$/, description: 'rm on root filesystem', severity: 'block' },
  { pattern: /\brm\s+.*-[a-zA-Z]*r[a-zA-Z]*f|rm\s+.*-[a-zA-Z]*f[a-zA-Z]*r/, description: 'Recursive force delete', severity: 'warn' },
  { pattern: /\bmkfs\b/, description: 'Filesystem format command', severity: 'block' },
  { pattern: /\bdd\s+.*of=\/dev\//, description: 'Direct disk write via dd', severity: 'block' },
  { pattern: />\s*\/dev\/[sh]d[a-z]/, description: 'Direct write to disk device', severity: 'block' },

  // System modification
  { pattern: /\bchmod\s+.*-R\s+.*\//, description: 'Recursive permission change on root-level path', severity: 'warn' },
  { pattern: /\bchown\s+.*-R\s+.*\//, description: 'Recursive ownership change on root-level path', severity: 'warn' },

  // Docker destruction
  { pattern: /\bdocker\s+rm\s+.*-f/, description: 'Force remove Docker container', severity: 'warn' },
  { pattern: /\bdocker\s+system\s+prune/, description: 'Docker system prune', severity: 'warn' },
  { pattern: /\bdocker\s+volume\s+rm/, description: 'Docker volume removal', severity: 'warn' },

  // Git destruction
  { pattern: /\bgit\s+push\s+.*--force\b/, description: 'Git force push', severity: 'warn' },
  { pattern: /\bgit\s+reset\s+--hard\b/, description: 'Git hard reset', severity: 'warn' },
  { pattern: /\bgit\s+clean\s+.*-f/, description: 'Git clean (force)', severity: 'warn' },

  // Data exfiltration
  { pattern: /\bcurl\s+.*-d\s+.*@/, description: 'curl posting file contents', severity: 'warn' },
  { pattern: /\bwget\s+.*--post-file/, description: 'wget posting file contents', severity: 'warn' },

  // Process/system
  { pattern: /\bkill\s+-9\s+1\b/, description: 'Kill init process', severity: 'block' },
  { pattern: /\bshutdown\b/, description: 'System shutdown command', severity: 'block' },
  { pattern: /\breboot\b/, description: 'System reboot command', severity: 'block' },
  { pattern: /:(){ :\|:& };:/, description: 'Fork bomb', severity: 'block' },

  // Credential/secret access
  { pattern: /\bcat\s+.*\.env\b/, description: 'Reading .env file (may contain secrets)', severity: 'warn' },
  { pattern: /\bcat\s+.*credentials/, description: 'Reading credentials file', severity: 'warn' },
  { pattern: /\bcat\s+.*\/etc\/shadow/, description: 'Reading shadow password file', severity: 'block' },
  { pattern: /\bcat\s+.*id_rsa/, description: 'Reading SSH private key', severity: 'warn' },
];

// ─── Types ───────────────────────────────────────────────────────────

/** Result of validating a command. */
export interface ExecValidation {
  /** Whether the command is allowed to execute. */
  allowed: boolean;
  /** List of warnings about the command (non-blocking). */
  warnings: string[];
  /** Block reason if not allowed. */
  blockReason?: string;
  /** Sanitized/modified command (if any changes were made). */
  command: string;
  /** Effective timeout to use. */
  timeout: number;
  /** Effective max output size to use. */
  maxOutputSize: number;
}

/** Options for exec safety validation. */
export interface ExecSafetyOptions {
  /** Allowed workspace root (commands must stay within). */
  workspaceRoot?: string;
  /** Working directory for the command. */
  workDir?: string;
  /** Max timeout in ms (enforced ceiling). */
  maxTimeout?: number;
  /** Default timeout in ms. */
  defaultTimeout?: number;
  /** Max output buffer size in bytes. */
  maxOutputSize?: number;
  /** Whether to allow commands outside the workspace. */
  allowOutsideWorkspace?: boolean;
}

const DEFAULT_OPTIONS: Required<ExecSafetyOptions> = {
  workspaceRoot: process.cwd(),
  workDir: process.cwd(),
  maxTimeout: 120_000,
  defaultTimeout: 30_000,
  maxOutputSize: 1024 * 1024,
  allowOutsideWorkspace: false,
};

// ─── ExecSafety class ────────────────────────────────────────────────

/**
 * ExecSafety — validates and constrains shell command execution.
 *
 * Checks:
 * 1. Dangerous command detection (block or warn)
 * 2. Working directory restrictions
 * 3. Timeout enforcement (clamped to max)
 * 4. Output size limits
 */
export class ExecSafety {
  private options: Required<ExecSafetyOptions>;

  constructor(options?: ExecSafetyOptions) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Validate a command before execution.
   *
   * @param command - Shell command string
   * @param requestedTimeout - Timeout requested by the caller
   * @returns Validation result with allowed status, warnings, and effective params
   */
  validate(command: string, requestedTimeout?: number): ExecValidation {
    const warnings: string[] = [];
    let blocked = false;
    let blockReason: string | undefined;

    // 1. Check against dangerous patterns
    for (const { pattern, description, severity } of DANGEROUS_PATTERNS) {
      if (pattern.test(command)) {
        if (severity === 'block') {
          blocked = true;
          blockReason = `Blocked: ${description}`;
          break;
        } else {
          warnings.push(`Warning: ${description}`);
        }
      }
    }

    // 2. Check working directory constraints
    if (!this.options.allowOutsideWorkspace && this.options.workDir) {
      const cdMatch = command.match(/\bcd\s+([^\s;&|]+)/);
      if (cdMatch) {
        const targetDir = resolve(this.options.workDir, cdMatch[1]);
        const rel = relative(this.options.workspaceRoot, targetDir);
        if (rel.startsWith('..')) {
          warnings.push(`Warning: "cd ${cdMatch[1]}" navigates outside workspace root`);
        }
      }
    }

    // 3. Enforce timeout ceiling
    const effectiveTimeout = Math.min(
      requestedTimeout ?? this.options.defaultTimeout,
      this.options.maxTimeout,
    );

    // 4. Output size limit
    const maxOutputSize = this.options.maxOutputSize;

    return {
      allowed: !blocked,
      warnings,
      blockReason,
      command,
      timeout: effectiveTimeout,
      maxOutputSize,
    };
  }

  /**
   * Check if a specific command is dangerous (quick check, no full validation).
   */
  isDangerous(command: string): boolean {
    return DANGEROUS_PATTERNS.some(
      ({ pattern, severity }) => severity === 'block' && pattern.test(command),
    );
  }

  /**
   * Get all warnings for a command without blocking.
   */
  getWarnings(command: string): string[] {
    const warnings: string[] = [];
    for (const { pattern, description } of DANGEROUS_PATTERNS) {
      if (pattern.test(command)) {
        warnings.push(description);
      }
    }
    return warnings;
  }

  // ─── Script content pinning (bun/deno run) ─────────────────────

  /** Approved script hashes: command string → SHA-256 hex digest. */
  private pinnedScripts = new Map<string, string>();

  /**
   * Extract the script file path from a bun/deno run command.
   * Returns null if the command is not a script run command.
   */
  extractScriptPath(command: string): string | null {
    const match = command.match(/\b(?:bun|deno)\s+run\s+([^\s;&|]+)/);
    if (!match) return null;
    const scriptPath = match[1];
    // Skip URLs and flags
    if (scriptPath.startsWith('-') || scriptPath.startsWith('http')) return null;
    return resolve(this.options.workDir, scriptPath);
  }

  /**
   * Compute SHA-256 hash of a file's contents.
   * Returns null if the file cannot be read.
   */
  private hashFile(filePath: string): string | null {
    try {
      const content = readFileSync(filePath);
      return createHash('sha256').update(content).digest('hex');
    } catch {
      return null;
    }
  }

  /**
   * Pin a script at approval time. Call this when the user approves
   * a `bun run <file>` or `deno run <file>` command.
   * Returns the hash, or null if the file couldn't be read.
   */
  pinScript(command: string): string | null {
    const scriptPath = this.extractScriptPath(command);
    if (!scriptPath) return null;
    const hash = this.hashFile(scriptPath);
    if (hash) {
      this.pinnedScripts.set(command, hash);
    }
    return hash;
  }

  /**
   * Verify a pinned script hasn't changed since approval.
   * Returns true if safe to execute, false if tampered or missing.
   * Returns true for non-script commands (no pinning needed).
   */
  verifyPinnedScript(command: string): { ok: boolean; reason?: string } {
    const scriptPath = this.extractScriptPath(command);
    if (!scriptPath) return { ok: true }; // Not a script command

    const pinnedHash = this.pinnedScripts.get(command);
    if (!pinnedHash) return { ok: true }; // Not pinned (legacy approval)

    const currentHash = this.hashFile(scriptPath);
    if (!currentHash) {
      return { ok: false, reason: `Script file not found or unreadable: ${scriptPath}` };
    }
    if (currentHash !== pinnedHash) {
      this.pinnedScripts.delete(command); // Invalidate the pin
      return { ok: false, reason: `Script content changed after approval (${scriptPath}). Re-approval required.` };
    }
    return { ok: true };
  }

  /**
   * Clear a pinned script (e.g. after execution or revocation).
   */
  clearPin(command: string): void {
    this.pinnedScripts.delete(command);
  }

  /** Update the workspace root. */
  setWorkspaceRoot(root: string): void {
    this.options.workspaceRoot = root;
  }

  /** Update the working directory. */
  setWorkDir(dir: string): void {
    this.options.workDir = dir;
  }
}
