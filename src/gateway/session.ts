/**
 * Session management — create, resume, persist, compact sessions.
 *
 * Sessions are persisted per-agent as append-only JSONL transcripts:
 *   ~/.tako/agents/<agentId>/sessions/<sessionId>.jsonl
 *
 * A sessions.json index in each dir maps composite keys → session IDs.
 * Old session files are never deleted — only archived (removed from
 * active maps but kept on disk).
 */

import { readFile, writeFile, appendFile, readdir, mkdir, rename } from 'node:fs/promises';
import { join } from 'node:path';
import type { ChatMessage, ContentPart } from '../providers/provider.js';

// ─── Types ──────────────────────────────────────────────────────────

export interface Session {
  id: string;
  name: string;
  createdAt: Date;
  lastActiveAt: Date;
  messages: ChatMessage[];
  metadata: Record<string, unknown>;
}

export interface SessionCreateOpts {
  name?: string;
  metadata?: Record<string, unknown>;
}

// ─── JSONL line types ───────────────────────────────────────────────

interface JsonlHeader {
  type: 'session';
  version: 1;
  id: string;
  timestamp: string;
  agentId: string;
  name: string;
  metadata: Record<string, unknown>;
}

interface JsonlMessageLine {
  type: 'message';
  role: string;
  content: string | ContentPart[];
  name?: string;
  tool_call_id?: string;
  timestamp: string;
}

interface JsonlCompactionLine {
  type: 'compaction';
  trimmedCount: number;
  keepLast: number;
  timestamp: string;
}

type JsonlLine = JsonlHeader | JsonlMessageLine | JsonlCompactionLine;

// ─── Legacy JSON format (for migration) ─────────────────────────────

interface SerializedSession {
  id: string;
  name: string;
  createdAt: string;
  lastActiveAt: string;
  messages: ChatMessage[];
  metadata: Record<string, unknown>;
}

// ─── Index entry ────────────────────────────────────────────────────

interface IndexEntry {
  sessionId: string;
  updatedAt: number;
  sessionFile: string;
  chatType: string;
  agentId: string;
}

const SESSION_IDLE_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_AGENT = 'main';

// ─── SessionManager ─────────────────────────────────────────────────

export class SessionManager {
  private sessions = new Map<string, Session>();
  private dirty = new Set<string>();
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private indexDirty = false;

  /** Keyed sessions: maps composite keys to session IDs. */
  private keyIndex = new Map<string, string>();

  /** Per-agent session directories: agentId → absolute dir path */
  private agentDirs = new Map<string, string>();

  /** Fallback dir for sessions without a known agent. */
  private fallbackDir: string | null = null;

  /** Whether persistence has been enabled. */
  private persistEnabled = false;

  /** Tracks how many messages have been flushed to JSONL per session. */
  private lastFlushedIndex = new Map<string, number>();

  /**
   * Enable persistence with per-agent directories.
   * @param agentDirs Map of agentId → session directory path
   * @param fallbackDir Default dir for sessions that don't match any agent
   */
  async enablePersistence(
    agentDirs: Map<string, string> | Record<string, string>,
    fallbackDir?: string,
  ): Promise<void> {
    const dirs = agentDirs instanceof Map ? agentDirs : new Map(Object.entries(agentDirs));
    this.agentDirs = dirs;
    this.fallbackDir = fallbackDir ?? dirs.get(DEFAULT_AGENT) ?? null;
    this.persistEnabled = true;

    // Ensure all dirs exist
    for (const dir of dirs.values()) {
      await mkdir(dir, { recursive: true });
    }
    if (this.fallbackDir) {
      await mkdir(this.fallbackDir, { recursive: true });
    }

    console.log(`[session] Persistence enabled for ${dirs.size} agent(s): ${[...dirs.keys()].join(', ')}`);

    // Load sessions from all agent dirs
    for (const [agentId, dir] of dirs) {
      await this.loadFromDir(dir, agentId);
    }

    console.log(`[session] Loaded ${this.sessions.size} total sessions, ${this.keyIndex.size} key mappings`);

    // Write index files so subsequent restarts use the fast path
    if (this.keyIndex.size > 0) {
      await this.saveIndexFiles();
    }

    this.flushTimer = setInterval(() => {
      this.flushDirty().catch((err) => {
        console.error('[session] Flush error:', err instanceof Error ? err.message : err);
      });
    }, 10_000);
  }

  /** Register an additional agent directory at runtime. */
  async registerAgentDir(agentId: string, dir: string): Promise<void> {
    this.agentDirs.set(agentId, dir);
    await mkdir(dir, { recursive: true });
    await this.loadFromDir(dir, agentId);
  }

  /** Stop background flush timer. */
  stopPersistence(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /** Create a new session. */
  create(opts?: SessionCreateOpts): Session {
    const id = crypto.randomUUID();
    const session: Session = {
      id,
      name: opts?.name ?? `session-${id.slice(0, 8)}`,
      createdAt: new Date(),
      lastActiveAt: new Date(),
      messages: [],
      metadata: opts?.metadata ?? {},
    };
    this.sessions.set(id, session);
    // -1 signals "header not yet written"
    this.lastFlushedIndex.set(id, -1);
    this.markDirty(id);
    return session;
  }

  /**
   * Get or create a session by composite key.
   * Key format: agent:<agentId>:<platform>:<type>:<target>
   */
  getOrCreate(key: string, opts?: SessionCreateOpts): Session & { isNew?: boolean } {
    const existingId = this.keyIndex.get(key);
    if (existingId) {
      const session = this.sessions.get(existingId);
      if (session) return Object.assign(session, { isNew: false });
    }

    const session = this.create(opts);
    this.keyIndex.set(key, session.id);
    session.metadata.sessionKey = key;
    this.indexDirty = true;
    this.markDirty(session.id);
    return Object.assign(session, { isNew: true });
  }

  /** Get a session by ID. */
  get(id: string): Session | undefined {
    return this.sessions.get(id);
  }

  /** Get a session by composite key. */
  getByKey(key: string): Session | undefined {
    const id = this.keyIndex.get(key);
    return id ? this.sessions.get(id) : undefined;
  }

  /** List all sessions. */
  list(): Session[] {
    return Array.from(this.sessions.values());
  }

  /** List sessions filtered by agent ID. */
  listByAgent(agentId: string): Session[] {
    return this.list().filter(
      (s) => (s.metadata.agentId ?? 'main') === agentId,
    );
  }

  /** Check if a session has been idle longer than the timeout (24h). */
  isIdle(session: Session): boolean {
    return Date.now() - session.lastActiveAt.getTime() > SESSION_IDLE_TIMEOUT_MS;
  }

  /** Return all sessions that have exceeded the idle timeout. */
  sweepIdle(): Session[] {
    const expired: Session[] = [];
    for (const session of this.sessions.values()) {
      if (this.isIdle(session)) {
        expired.push(session);
      }
    }
    return expired;
  }

  /** Append a message to a session. */
  addMessage(sessionId: string, message: ChatMessage): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    session.messages.push(message);
    session.lastActiveAt = new Date();
    this.markDirty(sessionId);
  }

  /**
   * Archive a session — remove from active maps, rename file for audit trail.
   * Files are never deleted, only renamed with a .deleted timestamp suffix.
   */
  archiveSession(id: string): boolean {
    const session = this.sessions.get(id);
    if (!session) return false;

    // Flush any pending writes before archiving
    if (this.dirty.has(id)) {
      this.appendToJSONL(session).catch(() => {});
      this.dirty.delete(id);
    }

    // Rename for audit trail instead of leaving unnamed
    this.renameSessionFile(session, 'deleted').catch(() => {});

    if (session.metadata.sessionKey) {
      this.keyIndex.delete(session.metadata.sessionKey as string);
      this.indexDirty = true;
    }

    this.sessions.delete(id);
    this.lastFlushedIndex.delete(id);
    return true;
  }

  /** Delete a session from active maps. File renamed with .deleted suffix. */
  delete(id: string): boolean {
    return this.archiveSession(id);
  }

  /**
   * Reset a session — rename the JSONL file with .reset suffix, clear messages.
   * Used by /new command. Full audit trail is preserved.
   */
  async resetSession(id: string): Promise<void> {
    const session = this.sessions.get(id);
    if (!session) return;

    // Flush pending writes before reset
    if (this.dirty.has(id)) {
      await this.appendToJSONL(session);
      this.dirty.delete(id);
    }

    // Rename old file for audit trail
    await this.renameSessionFile(session, 'reset');

    // Clear in-memory messages and start fresh
    session.messages.length = 0;
    session.lastActiveAt = new Date();
    this.lastFlushedIndex.set(id, -1); // signal "header not yet written"
    this.markDirty(id);
  }

  /**
   * Rename a session's JSONL file with a suffix and ISO timestamp.
   * E.g. <id>.jsonl → <id>.jsonl.reset.2026-03-06T22-00-00.000Z
   */
  private async renameSessionFile(session: Session, suffix: string): Promise<void> {
    const dir = this.getDirForSession(session);
    if (!dir) return;

    const filePath = join(dir, `${session.id}.jsonl`);
    const timestamp = new Date().toISOString().replace(/:/g, '-');
    const newPath = `${filePath}.${suffix}.${timestamp}`;
    try {
      await rename(filePath, newPath);
      console.log(`[session] Renamed ${session.id}.jsonl → .${suffix}.${timestamp}`);
    } catch {
      // File may not exist yet (new session never flushed)
    }
  }

  /** Compact a session — trim old messages keeping the most recent. */
  async compact(sessionId: string, keepLast = 20): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    if (session.messages.length <= keepLast) return;

    const trimmedCount = session.messages.length - keepLast;
    const trimmed = session.messages.slice(-keepLast);

    const summaryMsg: ChatMessage = {
      role: 'system',
      content: `[${trimmedCount} earlier messages compacted]`,
    };

    session.messages = [summaryMsg, ...trimmed];
    session.metadata.lastCompactedAt = new Date().toISOString();
    session.metadata.compactedMessageCount =
      (session.metadata.compactedMessageCount as number ?? 0) + trimmedCount;

    // Compaction requires full rewrite of the JSONL file
    await this.rewriteJsonl(session);
    this.lastFlushedIndex.set(sessionId, session.messages.length - 1);
  }

  /**
   * Rotate all active sessions — archive current ones and create fresh replacements.
   * Used for daily 4 AM reset. Old files stay on disk.
   */
  async rotateAllSessions(): Promise<{ archived: string[]; created: string[] }> {
    const archived: string[] = [];
    const created: string[] = [];

    // Snapshot current key→session pairs
    const entries = [...this.keyIndex.entries()];

    for (const [key, sessionId] of entries) {
      const session = this.sessions.get(sessionId);
      if (!session) continue;

      // Skip user-initiated channel sessions — they should persist indefinitely.
      // Only rotate sub-agent and ACP sessions which have a defined lifecycle.
      const isSubAgent = session.metadata.isSubAgent as boolean | undefined;
      const isAcp = session.metadata.isAcp as boolean | undefined;
      if (!isSubAgent && !isAcp) {
        continue; // user session — keep it alive, context compaction handles growth
      }

      // Flush pending writes
      if (this.dirty.has(sessionId)) {
        await this.appendToJSONL(session);
        this.dirty.delete(sessionId);
      }

      // Archive (file stays on disk)
      this.sessions.delete(sessionId);
      this.lastFlushedIndex.delete(sessionId);
      archived.push(sessionId);

      // Create fresh session with the same key
      const newSession = this.create({
        name: session.name,
        metadata: {
          agentId: session.metadata.agentId,
          channelType: session.metadata.channelType,
          channelTarget: session.metadata.channelTarget,
          rotatedFrom: sessionId,
        },
      });
      this.keyIndex.set(key, newSession.id);
      newSession.metadata.sessionKey = key;
      created.push(newSession.id);
    }

    this.indexDirty = true;
    await this.flushDirty();
    return { archived, created };
  }

  /** Flush all dirty sessions to disk. */
  async flushDirty(): Promise<void> {
    if (!this.persistEnabled || (this.dirty.size === 0 && !this.indexDirty)) return;

    const toFlush = Array.from(this.dirty);
    this.dirty.clear();

    for (const id of toFlush) {
      const session = this.sessions.get(id);
      if (!session) continue;
      await this.appendToJSONL(session);
    }

    // Persist the key index if it changed
    if (this.indexDirty) {
      await this.saveIndexFiles();
      this.indexDirty = false;
    }
  }

  /** Flush everything and clean up. */
  async shutdown(): Promise<void> {
    this.stopPersistence();
    await this.flushDirty();
  }

  private markDirty(id: string): void {
    if (this.persistEnabled) {
      this.dirty.add(id);
    }
  }

  /** Externally mark a session as needing persistence and flush immediately. */
  markSessionDirty(id: string): void {
    this.markDirty(id);
    // Flush immediately so sessions survive unexpected exits
    this.flushDirty().catch((err) => {
      console.error('[session] Flush error:', err instanceof Error ? err.message : err);
    });
  }

  /** Resolve the persist directory for a session based on its agentId. */
  private getDirForSession(session: Session): string | null {
    const agentId = (session.metadata.agentId as string) ?? DEFAULT_AGENT;
    return this.agentDirs.get(agentId) ?? this.fallbackDir;
  }

  /** Strip non-serializable runtime refs from metadata. */
  private stripRuntime(metadata: Record<string, unknown>): Record<string, unknown> {
    const { channelRef, executionContext, ...rest } = metadata;
    return rest;
  }

  // ─── JSONL persistence ────────────────────────────────────────────

  /** Append new messages to a session's JSONL transcript. */
  private async appendToJSONL(session: Session): Promise<void> {
    const dir = this.getDirForSession(session);
    if (!dir) return;

    const filePath = join(dir, `${session.id}.jsonl`);
    const lastIdx = this.lastFlushedIndex.get(session.id) ?? -1;

    let output = '';

    if (lastIdx === -1) {
      // New session — write header line
      const header: JsonlHeader = {
        type: 'session',
        version: 1,
        id: session.id,
        timestamp: session.createdAt.toISOString(),
        agentId: (session.metadata.agentId as string) ?? DEFAULT_AGENT,
        name: session.name,
        metadata: this.stripRuntime(session.metadata),
      };
      output += JSON.stringify(header) + '\n';
    }

    // Append only messages not yet flushed
    const startIdx = Math.max(0, lastIdx + 1);
    for (let i = startIdx; i < session.messages.length; i++) {
      const msg = session.messages[i];
      const line: JsonlMessageLine = {
        type: 'message',
        role: msg.role,
        content: msg.content,
        ...(msg.name ? { name: msg.name } : {}),
        ...(msg.tool_call_id ? { tool_call_id: msg.tool_call_id } : {}),
        timestamp: new Date().toISOString(),
      };
      output += JSON.stringify(line) + '\n';
    }

    if (output) {
      await appendFile(filePath, output, 'utf-8');
      this.lastFlushedIndex.set(session.id, session.messages.length - 1);
      console.log(`[session] Appended ${session.messages.length - startIdx} msg(s) to ${filePath}`);
    }
  }

  /** Atomic full rewrite of a JSONL file (used after compaction). */
  private async rewriteJsonl(session: Session): Promise<void> {
    const dir = this.getDirForSession(session);
    if (!dir) return;

    const filePath = join(dir, `${session.id}.jsonl`);
    const tmpPath = filePath + '.tmp';

    let output = '';

    // Header
    const header: JsonlHeader = {
      type: 'session',
      version: 1,
      id: session.id,
      timestamp: session.createdAt.toISOString(),
      agentId: (session.metadata.agentId as string) ?? DEFAULT_AGENT,
      name: session.name,
      metadata: this.stripRuntime(session.metadata),
    };
    output += JSON.stringify(header) + '\n';

    // Compaction marker
    const compactLine: JsonlCompactionLine = {
      type: 'compaction',
      trimmedCount: (session.metadata.compactedMessageCount as number) ?? 0,
      keepLast: session.messages.length,
      timestamp: new Date().toISOString(),
    };
    output += JSON.stringify(compactLine) + '\n';

    // All current messages
    for (const msg of session.messages) {
      const line: JsonlMessageLine = {
        type: 'message',
        role: msg.role,
        content: msg.content,
        ...(msg.name ? { name: msg.name } : {}),
        ...(msg.tool_call_id ? { tool_call_id: msg.tool_call_id } : {}),
        timestamp: new Date().toISOString(),
      };
      output += JSON.stringify(line) + '\n';
    }

    await writeFile(tmpPath, output, 'utf-8');
    await rename(tmpPath, filePath);
  }

  // ─── Index persistence ────────────────────────────────────────────

  /** Persist sessions.json index to each agent dir. */
  private async saveIndexFiles(): Promise<void> {
    // Group index entries by agent dir
    const perDir = new Map<string, Record<string, IndexEntry>>();

    for (const [key, sessionId] of this.keyIndex) {
      const session = this.sessions.get(sessionId);
      if (!session) continue;
      const dir = this.getDirForSession(session);
      if (!dir) continue;

      if (!perDir.has(dir)) perDir.set(dir, {});
      perDir.get(dir)![key] = {
        sessionId,
        updatedAt: session.lastActiveAt.getTime(),
        sessionFile: `${sessionId}.jsonl`,
        chatType: (session.metadata.channelType as string) ?? 'unknown',
        agentId: (session.metadata.agentId as string) ?? DEFAULT_AGENT,
      };
    }

    for (const [dir, entries] of perDir) {
      const indexPath = join(dir, 'sessions.json');
      await writeFile(indexPath, JSON.stringify(entries, null, 2), 'utf-8');
    }
  }

  // ─── Loading ──────────────────────────────────────────────────────

  /** Load sessions + index from a single agent directory. */
  private async loadFromDir(dir: string, agentId: string): Promise<void> {
    // Load sessions.json index first (fast key→id lookup)
    try {
      const indexRaw = await readFile(join(dir, 'sessions.json'), 'utf-8');
      const entries = JSON.parse(indexRaw) as Record<string, IndexEntry>;
      for (const [key, entry] of Object.entries(entries)) {
        this.keyIndex.set(key, entry.sessionId);
      }
    } catch {
      // No index file yet — will rebuild from session metadata
    }

    // Load individual session files
    let files: string[];
    try {
      files = await readdir(dir);
    } catch {
      return;
    }

    const loadedIds = new Set<string>();
    let loaded = 0;

    // Load .jsonl files first (preferred format)
    for (const file of files) {
      if (!file.endsWith('.jsonl')) continue;
      try {
        const session = await this.loadJsonlFile(dir, file);
        if (session) {
          this.sessions.set(session.id, session);
          this.lastFlushedIndex.set(session.id, session.messages.length - 1);
          loadedIds.add(session.id);
          if (session.metadata.sessionKey && !this.keyIndex.has(session.metadata.sessionKey as string)) {
            this.keyIndex.set(session.metadata.sessionKey as string, session.id);
          }
          loaded++;
        }
      } catch (err) {
        console.warn(`[session] Failed to load ${file}:`, err instanceof Error ? err.message : err);
      }
    }

    // Load legacy .json files (skip if already loaded via .jsonl)
    for (const file of files) {
      if (!file.endsWith('.json') || file === 'sessions.json') continue;
      const idFromFilename = file.replace('.json', '');
      if (loadedIds.has(idFromFilename)) continue;

      try {
        const session = await this.loadLegacyJsonFile(dir, file);
        if (session) {
          this.sessions.set(session.id, session);
          // Legacy sessions get -1 so they'll be fully written as JSONL on next flush
          this.lastFlushedIndex.set(session.id, -1);
          this.markDirty(session.id);
          loadedIds.add(session.id);
          if (session.metadata.sessionKey && !this.keyIndex.has(session.metadata.sessionKey as string)) {
            this.keyIndex.set(session.metadata.sessionKey as string, session.id);
          }
          loaded++;
        }
      } catch (err) {
        console.warn(`[session] Failed to load ${file}:`, err instanceof Error ? err.message : err);
      }
    }

    if (loaded > 0) {
      console.log(`[session]   ${agentId}: ${loaded} sessions from ${dir}`);
    }
  }

  /** Parse a JSONL transcript file and reconstruct a Session. */
  private async loadJsonlFile(dir: string, file: string): Promise<Session | null> {
    const raw = await readFile(join(dir, file), 'utf-8');
    const lines = raw.trim().split('\n').filter(Boolean);
    if (lines.length === 0) return null;

    let header: JsonlHeader | null = null;
    try {
      const firstLine = JSON.parse(lines[0]) as JsonlLine;
      if (firstLine.type !== 'session') {
        console.warn(`[session] Unexpected first line type in ${file}: ${firstLine.type}`);
        return null;
      }
      header = firstLine;
    } catch {
      console.warn(`[session] Malformed header in ${file}`);
      return null;
    }

    const messages: ChatMessage[] = [];
    let lastTimestamp = header.timestamp;

    for (let i = 1; i < lines.length; i++) {
      try {
        const parsed = JSON.parse(lines[i]) as JsonlLine;
        if (parsed.type === 'message') {
          messages.push({
            role: parsed.role as ChatMessage['role'],
            content: parsed.content,
            ...(parsed.name ? { name: parsed.name } : {}),
            ...(parsed.tool_call_id ? { tool_call_id: parsed.tool_call_id } : {}),
          });
          lastTimestamp = parsed.timestamp;
        }
        // 'compaction' lines are informational — messages array already reflects state
      } catch {
        // Skip malformed lines (crash recovery)
        console.warn(`[session] Skipping malformed line ${i + 1} in ${file}`);
      }
    }

    return {
      id: header.id,
      name: header.name,
      createdAt: new Date(header.timestamp),
      lastActiveAt: new Date(lastTimestamp),
      messages,
      metadata: header.metadata,
    };
  }

  /** Load a legacy full-JSON session file. */
  private async loadLegacyJsonFile(dir: string, file: string): Promise<Session | null> {
    const raw = await readFile(join(dir, file), 'utf-8');
    const data = JSON.parse(raw) as SerializedSession;
    return {
      id: data.id,
      name: data.name,
      createdAt: new Date(data.createdAt),
      lastActiveAt: new Date(data.lastActiveAt),
      messages: data.messages,
      metadata: data.metadata,
    };
  }
}
