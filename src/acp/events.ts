/**
 * ACP event parsing — converts JSON-line output from acpx into typed events.
 */

import {
  isRecord,
  asTrimmedString,
  asString,
  asOptionalString,
  asOptionalBoolean,
  type AcpxJsonObject,
  type AcpxErrorEvent,
} from './shared.js';

// ─── Event types ─────────────────────────────────────────────────

/** A runtime event emitted by acpx during a prompt turn. */
export type AcpRuntimeEvent =
  | { type: 'text_delta'; text: string; stream: 'output' | 'thought' }
  | { type: 'tool_call'; text: string; title: string; toolCallId?: string; status?: string }
  | { type: 'status'; text: string }
  | { type: 'done'; stopReason?: string }
  | { type: 'error'; message: string; code?: string; retryable?: boolean };

// ─── Error event extraction ──────────────────────────────────────

/** Extract an error event from a parsed JSON object, if present. */
export function toAcpxErrorEvent(value: unknown): AcpxErrorEvent | null {
  if (!isRecord(value)) return null;
  if (asTrimmedString(value.type) !== 'error') return null;
  return {
    message: asTrimmedString(value.message) || 'acpx reported an error',
    code: asOptionalString(value.code),
    retryable: asOptionalBoolean(value.retryable),
  };
}

// ─── JSON-line parsing ───────────────────────────────────────────

/** Parse a complete stdout blob of JSON lines into typed objects. */
export function parseJsonLines(value: string): AcpxJsonObject[] {
  const events: AcpxJsonObject[] = [];
  for (const line of value.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as unknown;
      if (isRecord(parsed)) events.push(parsed);
    } catch {
      // Ignore malformed lines
    }
  }
  return events;
}

// ─── Prompt event line parsing ───────────────────────────────────

function asOptionalFiniteNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

/** Parse a single JSON-line event from acpx prompt output. */
export function parsePromptEventLine(line: string): AcpRuntimeEvent | null {
  const trimmed = line.trim();
  if (!trimmed) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Non-JSON line — treat as status text
    return { type: 'status', text: trimmed };
  }

  if (!isRecord(parsed)) return null;

  // Resolve type from various acpx event formats
  const type = resolveEventType(parsed);
  const payload = parsed;

  switch (type) {
    case 'text': {
      const content = asString(payload.content);
      if (content == null || content.length === 0) return null;
      return { type: 'text_delta', text: content, stream: 'output' };
    }

    case 'thought': {
      const content = asString(payload.content);
      if (content == null || content.length === 0) return null;
      return { type: 'text_delta', text: content, stream: 'thought' };
    }

    case 'agent_message_chunk': {
      const text = resolveTextContent(payload);
      if (!text) return null;
      return { type: 'text_delta', text, stream: 'output' };
    }

    case 'agent_thought_chunk': {
      const text = resolveTextContent(payload);
      if (!text) return null;
      return { type: 'text_delta', text, stream: 'thought' };
    }

    case 'tool_call':
    case 'tool_call_update': {
      const title = asTrimmedString(payload.title) || 'tool call';
      const status = asTrimmedString(payload.status);
      const toolCallId = asOptionalString(payload.toolCallId);
      return {
        type: 'tool_call',
        text: status ? `${title} (${status})` : title,
        title,
        ...(toolCallId ? { toolCallId } : {}),
        ...(status ? { status } : {}),
      };
    }

    case 'usage_update': {
      const used = asOptionalFiniteNumber(payload.used);
      const size = asOptionalFiniteNumber(payload.size);
      const text = used != null && size != null
        ? `usage updated: ${used}/${size}`
        : 'usage updated';
      return { type: 'status', text };
    }

    case 'available_commands_update':
    case 'current_mode_update':
    case 'config_option_update':
    case 'session_info_update':
    case 'plan': {
      const text = resolveStatusText(type, payload);
      if (!text) return null;
      return { type: 'status', text };
    }

    case 'update': {
      const update = asTrimmedString(payload.update);
      if (!update) return null;
      return { type: 'status', text: update };
    }

    case 'done':
      return { type: 'done', stopReason: asOptionalString(payload.stopReason) };

    case 'error':
      return {
        type: 'error',
        message: asTrimmedString(payload.message) || 'acpx runtime error',
        code: asOptionalString(payload.code),
        retryable: asOptionalBoolean(payload.retryable),
      };

    default:
      return null;
  }
}

// ─── Internal helpers ────────────────────────────────────────────

function resolveEventType(parsed: Record<string, unknown>): string {
  // Check for structured session/update format
  const method = asTrimmedString(parsed.method);
  if (method === 'session/update') {
    const params = parsed.params;
    if (isRecord(params) && isRecord(params.update)) {
      const tag = asOptionalString(params.update.sessionUpdate);
      if (tag) return tag;
    }
  }

  // Check sessionUpdate tag
  const sessionUpdate = asOptionalString(parsed.sessionUpdate);
  if (sessionUpdate) return sessionUpdate;

  // Fall back to type field
  return asTrimmedString(parsed.type);
}

function resolveTextContent(payload: Record<string, unknown>): string | null {
  const contentRaw = payload.content;
  if (isRecord(contentRaw)) {
    const contentType = asTrimmedString(contentRaw.type);
    if (contentType && contentType !== 'text') return null;
    const text = asString(contentRaw.text);
    if (text && text.length > 0) return text;
  }
  const text = asString(payload.text);
  return (text && text.length > 0) ? text : null;
}

function resolveStatusText(
  type: string,
  payload: Record<string, unknown>,
): string | null {
  switch (type) {
    case 'available_commands_update': {
      const commands = Array.isArray(payload.availableCommands)
        ? payload.availableCommands
        : [];
      return commands.length > 0
        ? `available commands updated (${commands.length})`
        : 'available commands updated';
    }
    case 'current_mode_update': {
      const mode =
        asTrimmedString(payload.currentModeId) ||
        asTrimmedString(payload.modeId) ||
        asTrimmedString(payload.mode);
      return mode ? `mode updated: ${mode}` : 'mode updated';
    }
    case 'config_option_update': {
      const id = asTrimmedString(payload.id) || asTrimmedString(payload.configOptionId);
      const value = asTrimmedString(payload.currentValue) ||
        asTrimmedString(payload.value) ||
        asTrimmedString(payload.optionValue);
      if (id && value) return `config updated: ${id}=${value}`;
      if (id) return `config updated: ${id}`;
      return 'config updated';
    }
    case 'session_info_update':
      return asTrimmedString(payload.summary) ||
        asTrimmedString(payload.message) ||
        'session updated';
    case 'plan': {
      const entries = Array.isArray(payload.entries) ? payload.entries : [];
      const first = entries.find((e) => isRecord(e)) as Record<string, unknown> | undefined;
      return first ? asTrimmedString(first.content) || null : null;
    }
    default:
      return null;
  }
}
