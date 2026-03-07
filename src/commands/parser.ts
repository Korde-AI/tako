/**
 * Command parser — extracts /command and args from user messages.
 */

/**
 * Parsed command from a user message.
 */
export interface ParsedCommand {
  /** Command name without the leading / */
  command: string;
  /** Everything after the command name (trimmed) */
  args: string;
  /** Original message text */
  raw: string;
}

/**
 * Parse a message for a /command invocation.
 * Returns null if the message is not a command.
 *
 * Matches messages starting with / followed by a-z0-9_.
 * Special: `/skill <name> [input]` is parsed with command='skill'.
 */
export function parseCommand(message: string): ParsedCommand | null {
  const trimmed = message.trim();
  if (!trimmed.startsWith('/')) return null;

  const match = trimmed.match(/^\/([a-z0-9_]+)(?:\s+(.*))?$/s);
  if (!match) return null;

  return {
    command: match[1],
    args: (match[2] ?? '').trim(),
    raw: trimmed,
  };
}

// ─── Approval command ──────────────────────────────────────────────

export interface ApproveCommandArgs {
  requestId: string;
  decision: 'allow' | 'deny' | 'allow-always';
}

/**
 * Parse `/approve <id> allow|deny|allow-always` command.
 * Returns null if the message is not an approve command.
 */
export function parseApproveCommand(parsed: ParsedCommand): ApproveCommandArgs | null {
  if (parsed.command !== 'approve') return null;

  const match = parsed.args.match(/^(\S+)\s+(allow|deny|allow-always)$/);
  if (!match) return null;

  return {
    requestId: match[1],
    decision: match[2] as 'allow' | 'deny' | 'allow-always',
  };
}
