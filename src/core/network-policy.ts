/**
 * Network Policy — controls which URLs/domains tools can access.
 *
 * Modes:
 * - 'blocklist': block listed domains (default — blocks private IPs + localhost)
 * - 'allowlist': only allow listed domains
 */

// ─── Types ──────────────────────────────────────────────────────────

export interface NetworkPolicyConfig {
  /** Policy mode. */
  mode: 'allowlist' | 'blocklist';
  /** Allowed domains (only used in 'allowlist' mode). */
  allowlist?: string[];
  /** Blocked domains (only used in 'blocklist' mode). */
  blocklist?: string[];
}

export interface NetworkCheckResult {
  /** Whether the request is allowed. */
  allowed: boolean;
  /** Reason for blocking. */
  reason?: string;
}

// ─── Default blocklist ──────────────────────────────────────────────

const DEFAULT_BLOCKLIST = [
  'localhost',
  '127.0.0.1',
  '0.0.0.0',
  '::1',
  'host.docker.internal',
  'metadata.google.internal',
  '169.254.169.254',
];

// ─── Private IP check ───────────────────────────────────────────────

function isPrivateIp(hostname: string): boolean {
  // IPv4 private ranges
  if (/^127\.\d+\.\d+\.\d+$/.test(hostname)) return true;
  if (/^10\.\d+\.\d+\.\d+$/.test(hostname)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(hostname)) return true;
  if (/^192\.168\.\d+\.\d+$/.test(hostname)) return true;
  if (/^169\.254\.\d+\.\d+$/.test(hostname)) return true;
  if (hostname === '0.0.0.0') return true;

  // IPv6 private ranges
  if (hostname === '::1') return true;
  if (/^fc00:/i.test(hostname)) return true;
  if (/^fd[0-9a-f]{2}:/i.test(hostname)) return true;
  if (/^fe80:/i.test(hostname)) return true;

  return false;
}

// ─── Network Policy ─────────────────────────────────────────────────

export class NetworkPolicy {
  private config: NetworkPolicyConfig;
  private blocklist: Set<string>;
  private allowlist: Set<string>;

  constructor(config: NetworkPolicyConfig) {
    this.config = config;
    this.blocklist = new Set([
      ...DEFAULT_BLOCKLIST,
      ...(config.blocklist ?? []),
    ]);
    this.allowlist = new Set(config.allowlist ?? []);
  }

  /**
   * Check if a URL is allowed by the network policy.
   */
  check(urlStr: string): NetworkCheckResult {
    let hostname: string;
    try {
      const url = new URL(urlStr);
      hostname = url.hostname;
    } catch {
      return { allowed: false, reason: `Invalid URL: ${urlStr}` };
    }

    if (this.config.mode === 'allowlist') {
      return this.checkAllowlist(hostname);
    } else {
      return this.checkBlocklist(hostname);
    }
  }

  /**
   * Check a hostname directly (without full URL parsing).
   */
  checkHost(hostname: string): NetworkCheckResult {
    if (this.config.mode === 'allowlist') {
      return this.checkAllowlist(hostname);
    } else {
      return this.checkBlocklist(hostname);
    }
  }

  // ─── Private ────────────────────────────────────────────────────

  private checkAllowlist(hostname: string): NetworkCheckResult {
    // In allowlist mode, everything is blocked unless explicitly allowed
    if (this.matchesList(hostname, this.allowlist)) {
      return { allowed: true };
    }
    return { allowed: false, reason: `Domain not in allowlist: ${hostname}` };
  }

  private checkBlocklist(hostname: string): NetworkCheckResult {
    // Always block private IPs regardless of blocklist
    if (isPrivateIp(hostname)) {
      return { allowed: false, reason: `Private/internal IP blocked: ${hostname}` };
    }

    // Check explicit blocklist
    if (this.matchesList(hostname, this.blocklist)) {
      return { allowed: false, reason: `Domain blocked: ${hostname}` };
    }

    return { allowed: true };
  }

  private matchesList(hostname: string, list: Set<string>): boolean {
    // Exact match
    if (list.has(hostname)) return true;

    // Wildcard match (e.g. *.internal)
    for (const entry of list) {
      if (entry.startsWith('*.')) {
        const suffix = entry.slice(1); // .internal
        if (hostname.endsWith(suffix)) return true;
      }
    }

    return false;
  }
}
