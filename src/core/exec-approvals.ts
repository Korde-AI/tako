/**
 * Exec approval system — require user confirmation for dangerous commands.
 *
 * Classifies commands by risk level and routes high-risk ones through
 * an approval flow before execution.
 */

export interface ApprovalConfig {
  /** Approval mode: 'off' | 'ask' | 'allowlist' | 'full' */
  mode: 'off' | 'ask' | 'allowlist' | 'full';
  /** Commands that always need approval */
  alwaysAsk: string[];
  /** Commands that are pre-approved (allowlist mode) */
  allowed: string[];
  /** Commands that are always blocked */
  blocked: string[];
  /** Timeout for approval request in ms (default: 60000) */
  timeoutMs: number;
  /** Auto-approve after N identical approvals in same session */
  autoApproveAfter?: number;
}

export type RiskLevel = 'safe' | 'moderate' | 'dangerous' | 'blocked';

export interface ApprovalRequest {
  id: string;
  command: string;
  riskLevel: RiskLevel;
  reason: string;
  sessionId: string;
  timestamp: number;
  status: 'pending' | 'approved' | 'denied' | 'timeout';
}

const DEFAULT_APPROVAL_CONFIG: ApprovalConfig = {
  mode: 'ask',
  alwaysAsk: [],
  allowed: [],
  blocked: [],
  timeoutMs: 60_000,
  autoApproveAfter: undefined,
};

// ─── Risk classification patterns ──────────────────────────────────

const BLOCKED_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\brm\s+-[^\s]*r[^\s]*f[^\s]*\s+\/\s*$/, reason: 'Recursive delete of root filesystem' },
  { pattern: /\brm\s+-[^\s]*f[^\s]*r[^\s]*\s+\/\s*$/, reason: 'Recursive delete of root filesystem' },
  { pattern: /\bformat\b/, reason: 'Disk format command' },
  { pattern: /\bdd\s+if=/, reason: 'Raw disk write (dd)' },
  { pattern: /\bmkfs\b/, reason: 'Filesystem creation' },
  { pattern: /:\(\)\{\s*:\|:&\s*\};:/, reason: 'Fork bomb' },
];

const DANGEROUS_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bsudo\b/, reason: 'Elevated privileges (sudo)' },
  { pattern: /\brm\s+-[^\s]*r[^\s]*f/, reason: 'Recursive force delete' },
  { pattern: /\bchmod\s+777\b/, reason: 'World-writable permissions' },
  { pattern: /\bcurl\b.*\|\s*\bbash\b/, reason: 'Remote code execution (curl | bash)' },
  { pattern: /\bwget\b.*\|\s*\bsh\b/, reason: 'Remote code execution (wget | sh)' },
  { pattern: /\bshutdown\b/, reason: 'System shutdown' },
  { pattern: /\breboot\b/, reason: 'System reboot' },
];

const MODERATE_PATTERNS: Array<{ pattern: RegExp; reason: string }> = [
  { pattern: /\bgit\s+push\s+--force\b/, reason: 'Force push (destructive)' },
  { pattern: /\bnpm\s+publish\b/, reason: 'Package publish' },
  { pattern: /\bdocker\s+rm\b/, reason: 'Docker container removal' },
  { pattern: /\bkill\s+-9\b/, reason: 'Force kill process' },
];

const SAFE_PATTERNS: RegExp[] = [
  /^\s*(ls|cat|echo|pwd|git\s+status|git\s+log|npm\s+test|node)\b/,
];

export class ExecApprovalManager {
  private config: ApprovalConfig;
  private pending: Map<string, ApprovalRequest>;
  private sessionApprovals: Map<string, Map<string, number>>; // sessionId -> command -> approval count

  constructor(config?: Partial<ApprovalConfig>) {
    this.config = { ...DEFAULT_APPROVAL_CONFIG, ...config };
    this.pending = new Map();
    this.sessionApprovals = new Map();
  }

  /** Check if a command needs approval. Returns null if auto-approved. */
  checkCommand(command: string, sessionId: string): ApprovalRequest | null {
    if (this.config.mode === 'off') return null;

    const { level, reason } = this.classifyRisk(command);

    // Safe commands never need approval
    if (level === 'safe') return null;

    // Blocked commands get an immediate blocked request (no approval possible)
    if (level === 'blocked') {
      const req: ApprovalRequest = {
        id: crypto.randomUUID().slice(0, 8),
        command,
        riskLevel: level,
        reason,
        sessionId,
        timestamp: Date.now(),
        status: 'denied',
      };
      return req;
    }

    // In allowlist mode, check if command is pre-approved
    if (this.config.mode === 'allowlist') {
      const isAllowed = this.config.allowed.some(pattern =>
        command.includes(pattern) || new RegExp(pattern).test(command),
      );
      if (isAllowed) return null;
    }

    // Check auto-approve threshold
    if (this.config.autoApproveAfter !== undefined) {
      const sessionMap = this.sessionApprovals.get(sessionId);
      if (sessionMap) {
        const count = sessionMap.get(command) ?? 0;
        if (count >= this.config.autoApproveAfter) return null;
      }
    }

    // In 'full' mode, everything non-safe needs approval
    // In 'ask' mode, dangerous/moderate need approval
    if (this.config.mode === 'full' || level === 'dangerous' || level === 'moderate') {
      // Check alwaysAsk overrides
      const forceAsk = this.config.alwaysAsk.some(pattern =>
        command.includes(pattern),
      );

      // In ask mode, moderate commands don't need approval unless in alwaysAsk
      if (this.config.mode === 'ask' && level === 'moderate' && !forceAsk) {
        return null;
      }

      const req: ApprovalRequest = {
        id: crypto.randomUUID().slice(0, 8),
        command,
        riskLevel: level,
        reason,
        sessionId,
        timestamp: Date.now(),
        status: 'pending',
      };
      this.pending.set(req.id, req);
      return req;
    }

    return null;
  }

  /** Classify command risk level. */
  classifyRisk(command: string): { level: RiskLevel; reason: string } {
    // Check user-configured blocked list first
    for (const pattern of this.config.blocked) {
      if (command.includes(pattern) || new RegExp(pattern).test(command)) {
        return { level: 'blocked', reason: `Blocked by policy: ${pattern}` };
      }
    }

    // Check built-in blocked patterns
    for (const { pattern, reason } of BLOCKED_PATTERNS) {
      if (pattern.test(command)) {
        return { level: 'blocked', reason };
      }
    }

    // Check dangerous patterns
    for (const { pattern, reason } of DANGEROUS_PATTERNS) {
      if (pattern.test(command)) {
        return { level: 'dangerous', reason };
      }
    }

    // Check moderate patterns
    for (const { pattern, reason } of MODERATE_PATTERNS) {
      if (pattern.test(command)) {
        return { level: 'moderate', reason };
      }
    }

    // Check safe patterns
    for (const pattern of SAFE_PATTERNS) {
      if (pattern.test(command)) {
        return { level: 'safe', reason: 'Known safe command' };
      }
    }

    // Default: safe for unknown commands (ExecSafety handles blocking)
    return { level: 'safe', reason: 'No risk patterns matched' };
  }

  /** Resolve a pending approval. */
  resolve(requestId: string, decision: 'approved' | 'denied'): void {
    const req = this.pending.get(requestId);
    if (!req) return;

    req.status = decision;
    this.pending.delete(requestId);

    // Track approval count for auto-approve
    if (decision === 'approved' && this.config.autoApproveAfter !== undefined) {
      if (!this.sessionApprovals.has(req.sessionId)) {
        this.sessionApprovals.set(req.sessionId, new Map());
      }
      const sessionMap = this.sessionApprovals.get(req.sessionId)!;
      const count = sessionMap.get(req.command) ?? 0;
      sessionMap.set(req.command, count + 1);
    }
  }

  /** Get pending approval for a session. */
  getPending(sessionId: string): ApprovalRequest | undefined {
    for (const req of this.pending.values()) {
      if (req.sessionId === sessionId && req.status === 'pending') {
        return req;
      }
    }
    return undefined;
  }

  /** Format approval request as a user-facing message. */
  formatRequest(req: ApprovalRequest): string {
    const riskLabel = req.riskLevel.toUpperCase();
    const lines = [
      `⚠️  Command requires approval [${riskLabel}]`,
      `Command: ${req.command}`,
      `Reason:  ${req.reason}`,
      ``,
      `Reply with:`,
      `  /approve ${req.id} allow    — execute this command`,
      `  /approve ${req.id} deny     — block this command`,
      `  /approve ${req.id} allow-always — approve and auto-approve future identical commands`,
    ];
    return lines.join('\n');
  }
}
