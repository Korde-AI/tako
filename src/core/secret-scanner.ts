/**
 * Secret Scanner — detects and redacts secrets in agent output before delivery.
 *
 * Scans for: API keys, private keys, tokens, passwords.
 * Actions: 'redact' (default), 'block', 'warn'.
 */

// ─── Types ──────────────────────────────────────────────────────────

export interface SecretScannerConfig {
  /** Enable secret scanning (default: true). */
  enabled: boolean;
  /** Action on detection: 'redact' replaces, 'block' stops delivery, 'warn' logs only. */
  action: 'redact' | 'block' | 'warn';
}

export interface ScanResult {
  /** The (possibly redacted) text. */
  text: string;
  /** Whether any secrets were found. */
  hasSecrets: boolean;
  /** List of detected secret types. */
  detections: SecretDetection[];
}

export interface SecretDetection {
  type: string;
  offset: number;
  length: number;
  redacted: string;
}

// ─── Patterns ───────────────────────────────────────────────────────

interface SecretPattern {
  type: string;
  regex: RegExp;
  label: string;
}

const SECRET_PATTERNS: SecretPattern[] = [
  // API keys
  { type: 'anthropic_key', regex: /sk-ant-[a-zA-Z0-9_-]{20,}/g, label: 'REDACTED:anthropic_key' },
  { type: 'openai_key', regex: /sk-[a-zA-Z0-9]{20,}/g, label: 'REDACTED:openai_key' },
  { type: 'aws_key', regex: /AKIA[0-9A-Z]{16}/g, label: 'REDACTED:aws_key' },
  { type: 'github_token', regex: /gh[pousr]_[a-zA-Z0-9]{36,}/g, label: 'REDACTED:github_token' },
  { type: 'github_classic', regex: /ghp_[a-zA-Z0-9]{36}/g, label: 'REDACTED:github_token' },

  // Bearer tokens (JWT-like)
  { type: 'bearer_token', regex: /Bearer\s+ey[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}\.[a-zA-Z0-9_-]{20,}/g, label: 'REDACTED:bearer_token' },

  // JWT standalone
  { type: 'jwt', regex: /eyJ[a-zA-Z0-9_-]{10,}\.eyJ[a-zA-Z0-9_-]{10,}\.[a-zA-Z0-9_-]{10,}/g, label: 'REDACTED:jwt' },

  // Private keys
  { type: 'rsa_key', regex: /-----BEGIN RSA PRIVATE KEY-----[\s\S]*?-----END RSA PRIVATE KEY-----/g, label: 'REDACTED:rsa_private_key' },
  { type: 'openssh_key', regex: /-----BEGIN OPENSSH PRIVATE KEY-----[\s\S]*?-----END OPENSSH PRIVATE KEY-----/g, label: 'REDACTED:openssh_key' },
  { type: 'ec_key', regex: /-----BEGIN EC PRIVATE KEY-----[\s\S]*?-----END EC PRIVATE KEY-----/g, label: 'REDACTED:ec_private_key' },
  { type: 'generic_key', regex: /-----BEGIN PRIVATE KEY-----[\s\S]*?-----END PRIVATE KEY-----/g, label: 'REDACTED:private_key' },

  // Discord / Telegram tokens
  { type: 'discord_token', regex: /[MN][A-Za-z\d]{23,}\.[\w-]{6}\.[\w-]{27,}/g, label: 'REDACTED:discord_token' },
  { type: 'telegram_token', regex: /\d{8,10}:[a-zA-Z0-9_-]{35}/g, label: 'REDACTED:telegram_token' },

  // Slack tokens
  { type: 'slack_token', regex: /xox[bpors]-[0-9]{10,13}-[0-9]{10,13}-[a-zA-Z0-9]{24,}/g, label: 'REDACTED:slack_token' },

  // Password patterns in assignments
  { type: 'password_assign', regex: /(?:password|passwd|pwd|secret|api_key|apikey|auth_token)\s*[=:]\s*['"][^'"]{8,}['"]/gi, label: 'REDACTED:credential' },

  // AWS secret key
  { type: 'aws_secret', regex: /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY)\s*[=:]\s*['"]?[A-Za-z0-9/+=]{40}['"]?/g, label: 'REDACTED:aws_secret' },

  // Generic long hex strings that look like API keys (40+ chars)
  { type: 'hex_secret', regex: /(?:token|secret|key|api_key)\s*[=:]\s*['"]?[a-f0-9]{40,}['"]?/gi, label: 'REDACTED:hex_token' },
];

// ─── Scanner ────────────────────────────────────────────────────────

export class SecretScanner {
  private config: SecretScannerConfig;

  constructor(config: SecretScannerConfig) {
    this.config = config;
  }

  /**
   * Scan text for secrets and optionally redact them.
   */
  scan(text: string): ScanResult {
    if (!this.config.enabled) {
      return { text, hasSecrets: false, detections: [] };
    }

    const detections: SecretDetection[] = [];
    let redacted = text;

    for (const pattern of SECRET_PATTERNS) {
      // Reset regex state
      pattern.regex.lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = pattern.regex.exec(text)) !== null) {
        detections.push({
          type: pattern.type,
          offset: match.index,
          length: match[0].length,
          redacted: `[${pattern.label}]`,
        });
      }
    }

    if (detections.length === 0) {
      return { text, hasSecrets: false, detections: [] };
    }

    // Sort detections by offset descending for safe replacement
    if (this.config.action === 'redact') {
      const sorted = [...detections].sort((a, b) => b.offset - a.offset);
      for (const det of sorted) {
        redacted =
          redacted.slice(0, det.offset) +
          det.redacted +
          redacted.slice(det.offset + det.length);
      }
    }

    return {
      text: this.config.action === 'redact' ? redacted : text,
      hasSecrets: true,
      detections,
    };
  }

  /**
   * Quick check — does this text contain any secrets?
   */
  hasSecrets(text: string): boolean {
    if (!this.config.enabled) return false;

    for (const pattern of SECRET_PATTERNS) {
      pattern.regex.lastIndex = 0;
      if (pattern.regex.test(text)) return true;
    }
    return false;
  }
}
