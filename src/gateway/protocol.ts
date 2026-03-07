/**
 * Wire protocol types for the Tako Gateway WebSocket API.
 */

// ─── Client → Gateway ───────────────────────────────────────────────

export type ClientMessage =
  | { type: 'auth'; token: string }
  | { type: 'chat'; sessionId: string; content: string; attachments?: string[] }
  | { type: 'command'; cmd: string; args: string }
  | { type: 'session_create'; name?: string }
  | { type: 'session_resume'; sessionId: string }
  | { type: 'session_list' }
  | { type: 'status' }
  | { type: 'ping' };

// ─── Gateway → Client ───────────────────────────────────────────────

export type ServerMessage =
  | { type: 'auth_ok'; sessionId?: string }
  | { type: 'auth_error'; reason: string }
  | { type: 'chunk'; sessionId: string; text: string }
  | { type: 'text_delta'; content: string }
  | { type: 'text_done'; content: string }
  | { type: 'tool_start'; sessionId: string; name: string; params: unknown }
  | { type: 'tool_end'; sessionId: string; name: string; result: string }
  | { type: 'tool_call'; sessionId: string; name: string; params: unknown }
  | { type: 'tool_result'; sessionId: string; name: string; result: string }
  | { type: 'done'; sessionId: string; usage?: { prompt_tokens: number; completion_tokens: number } }
  | { type: 'error'; sessionId?: string; message: string }
  | { type: 'session_created'; sessionId: string; name: string }
  | { type: 'session_list'; sessions: SessionInfo[] }
  | { type: 'status_info'; model: string; tools: number; skills: number; uptime: number; channels: string[] }
  | { type: 'pong' };

export interface SessionInfo {
  id: string;
  name: string;
  createdAt: string;
  lastActiveAt: string;
  messageCount: number;
}

// ─── Gateway events (internal event bus) ────────────────────────────

export type GatewayEvent =
  | { type: 'client_connected'; clientId: string }
  | { type: 'client_disconnected'; clientId: string }
  | { type: 'session_created'; sessionId: string }
  | { type: 'session_ended'; sessionId: string }
  | { type: 'error'; error: Error };

export type EventHandler = (event: GatewayEvent) => void | Promise<void>;
