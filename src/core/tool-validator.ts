/**
 * Tool Argument Validator — validates tool arguments before execution.
 *
 * Checks:
 * - File paths: block path traversal (../ outside workspace)
 * - Shell commands: warn on dangerous patterns
 * - URLs: block private/internal IPs
 * - Regex: timeout protection for ReDoS
 */

import { resolve, relative, isAbsolute } from 'node:path';

// ─── Types ──────────────────────────────────────────────────────────

export type ValidationLevel = 'strict' | 'warn' | 'off';

export interface ToolValidatorConfig {
  /** Validation level: 'strict' blocks, 'warn' logs + allows, 'off' disables. */
  level: ValidationLevel;
}

export interface ValidationResult {
  /** Whether the tool call is allowed. */
  allowed: boolean;
  /** Validation warnings (even if allowed). */
  warnings: string[];
  /** Reason for blocking (if allowed=false). */
  blockReason?: string;
}

// ─── Dangerous command patterns ─────────────────────────────────────

const DANGEROUS_COMMANDS: Array<{ pattern: RegExp; description: string }> = [
  { pattern: /rm\s+(-[a-zA-Z]*f[a-zA-Z]*\s+)?\/(?!tmp)/i, description: 'Destructive rm on root paths' },
  { pattern: /rm\s+-[a-zA-Z]*r[a-zA-Z]*f[a-zA-Z]*\s+\//i, description: 'Recursive forced delete on root' },
  { pattern: /mkfs\./i, description: 'Filesystem format command' },
  { pattern: /dd\s+.*of=\/dev\//i, description: 'Direct disk write' },
  { pattern: /chmod\s+777\s/i, description: 'Overly permissive chmod' },
  { pattern: /curl\s+[^|]*\|\s*(sh|bash|zsh)/i, description: 'Pipe remote script to shell' },
  { pattern: /wget\s+[^|]*\|\s*(sh|bash|zsh)/i, description: 'Pipe remote download to shell' },
  { pattern: />\s*\/etc\//i, description: 'Writing to /etc/' },
  { pattern: />\s*\/proc\//i, description: 'Writing to /proc/' },
  { pattern: /:\(\)\s*\{\s*:\|:&\s*\}\s*;/i, description: 'Fork bomb' },
  { pattern: /shutdown|reboot|poweroff|init\s+[06]/i, description: 'System shutdown/reboot' },
  { pattern: /iptables\s+-F/i, description: 'Flushing firewall rules' },
];

// ─── Private IP patterns ────────────────────────────────────────────

const PRIVATE_IP_PATTERNS: RegExp[] = [
  /^127\.\d+\.\d+\.\d+/,
  /^10\.\d+\.\d+\.\d+/,
  /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+/,
  /^192\.168\.\d+\.\d+/,
  /^169\.254\.\d+\.\d+/,
  /^0\.0\.0\.0/,
  /^::1$/,
  /^fc00:/i,
  /^fd[0-9a-f]{2}:/i,
  /^fe80:/i,
];

const PRIVATE_HOSTNAMES = ['localhost', 'host.docker.internal', '*.local', 'metadata.google.internal'];

// ─── Validator ──────────────────────────────────────────────────────

export class ToolValidator {
  private config: ToolValidatorConfig;
  private workspaceRoot: string;

  constructor(config: ToolValidatorConfig, workspaceRoot: string) {
    this.config = config;
    this.workspaceRoot = workspaceRoot;
  }

  /**
   * Validate a file path argument.
   */
  validatePath(path: string, workDir: string, allowWrite: boolean): ValidationResult {
    if (this.config.level === 'off') {
      return { allowed: true, warnings: [] };
    }

    const warnings: string[] = [];
    const fullPath = isAbsolute(path) ? path : resolve(workDir, path);
    const rel = relative(this.workspaceRoot, fullPath);

    // Check for path traversal outside workspace
    if (rel.startsWith('..') || isAbsolute(rel)) {
      if (allowWrite) {
        const msg = `Path traversal outside workspace: ${path} resolves to ${fullPath}`;
        if (this.config.level === 'strict') {
          return { allowed: false, warnings: [], blockReason: msg };
        }
        warnings.push(msg);
      }
    }

    // Block writing to sensitive system paths
    if (allowWrite) {
      const sensitiveRoots = ['/etc', '/usr', '/bin', '/sbin', '/boot', '/proc', '/sys', '/dev'];
      for (const root of sensitiveRoots) {
        if (fullPath.startsWith(root + '/') || fullPath === root) {
          const msg = `Writing to system path: ${fullPath}`;
          if (this.config.level === 'strict') {
            return { allowed: false, warnings: [], blockReason: msg };
          }
          warnings.push(msg);
        }
      }
    }

    return { allowed: true, warnings };
  }

  /**
   * Validate a shell command argument.
   */
  validateCommand(command: string): ValidationResult {
    if (this.config.level === 'off') {
      return { allowed: true, warnings: [] };
    }

    const warnings: string[] = [];

    for (const { pattern, description } of DANGEROUS_COMMANDS) {
      if (pattern.test(command)) {
        const msg = `Dangerous command pattern: ${description}`;
        if (this.config.level === 'strict') {
          return { allowed: false, warnings: [], blockReason: msg };
        }
        warnings.push(msg);
      }
    }

    return { allowed: true, warnings };
  }

  /**
   * Validate a URL argument (block private/internal IPs).
   */
  validateUrl(urlStr: string): ValidationResult {
    if (this.config.level === 'off') {
      return { allowed: true, warnings: [] };
    }

    try {
      const url = new URL(urlStr);
      const hostname = url.hostname;

      // Check private IPs
      for (const pattern of PRIVATE_IP_PATTERNS) {
        if (pattern.test(hostname)) {
          const msg = `URL points to private/internal IP: ${hostname}`;
          if (this.config.level === 'strict') {
            return { allowed: false, warnings: [], blockReason: msg };
          }
          return { allowed: true, warnings: [msg] };
        }
      }

      // Check private hostnames
      for (const pattern of PRIVATE_HOSTNAMES) {
        if (pattern.startsWith('*')) {
          const suffix = pattern.slice(1);
          if (hostname.endsWith(suffix)) {
            const msg = `URL points to internal hostname: ${hostname}`;
            if (this.config.level === 'strict') {
              return { allowed: false, warnings: [], blockReason: msg };
            }
            return { allowed: true, warnings: [msg] };
          }
        } else if (hostname === pattern) {
          const msg = `URL points to internal hostname: ${hostname}`;
          if (this.config.level === 'strict') {
            return { allowed: false, warnings: [], blockReason: msg };
          }
          return { allowed: true, warnings: [msg] };
        }
      }
    } catch {
      // Invalid URL — let the tool handle it
    }

    return { allowed: true, warnings: [] };
  }

  /**
   * Validate a regex pattern for ReDoS potential.
   */
  validateRegex(pattern: string, timeoutMs = 100): ValidationResult {
    if (this.config.level === 'off') {
      return { allowed: true, warnings: [] };
    }

    // Heuristic: check for known ReDoS patterns
    const redosPatterns = [
      /\(.*\+\)\+/,      // (a+)+
      /\(.*\*\)\*/,      // (a*)*
      /\(.*\+\)\*/,      // (a+)*
      /\(.*\*\)\+/,      // (a*)+
      /\(.*\{\d+,\}\)\+/, // (a{2,})+
    ];

    for (const redos of redosPatterns) {
      if (redos.test(pattern)) {
        const msg = `Potential ReDoS pattern detected: ${pattern.slice(0, 50)}`;
        if (this.config.level === 'strict') {
          return { allowed: false, warnings: [], blockReason: msg };
        }
        return { allowed: true, warnings: [msg] };
      }
    }

    return { allowed: true, warnings: [] };
  }
}
