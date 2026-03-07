/**
 * Heartbeat manager — periodic agent turns for proactive work.
 *
 * Implements the reference runtime heartbeat contract:
 * - Periodic agent turns at configured interval
 * - HEARTBEAT_OK response contract (ack stripped, reply dropped if ≤ maxChars)
 * - Active hours support (only run during configured window)
 * - HEARTBEAT.md workspace file read (skip if empty)
 * - Delivery routing: "none" (silent), "last" (last channel), or explicit
 * - Manual wake support
 */

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { HeartbeatConfig } from '../config/schema.js';
import type { AgentLoop } from './agent-loop.js';
import type { SessionManager, Session } from '../gateway/session.js';

/** Result of a heartbeat run. */
export interface HeartbeatResult {
  /** Whether the agent responded with HEARTBEAT_OK (acknowledgment). */
  isAck: boolean;
  /** Raw response text from the agent. */
  rawResponse: string;
  /** Cleaned response (HEARTBEAT_OK stripped). */
  deliverableText: string;
  /** Whether the response should be delivered (not suppressed). */
  shouldDeliver: boolean;
  /** Timestamp of the heartbeat run. */
  timestamp: Date;
}

/** Delivery handler called when heartbeat produces deliverable output. */
export type HeartbeatDeliveryHandler = (result: HeartbeatResult, target: string) => void;

export class HeartbeatManager {
  private timer: ReturnType<typeof setInterval> | null = null;
  private config: HeartbeatConfig;
  private agentLoop: AgentLoop | null = null;
  private sessions: SessionManager | null = null;
  private workspaceRoot: string;
  private heartbeatSession: Session | null = null;
  private running = false;
  private deliveryHandlers: HeartbeatDeliveryHandler[] = [];
  private lastChannel: string | null = null;
  private typingSuppressed = false;

  constructor(config: HeartbeatConfig, workspaceRoot: string) {
    this.config = config;
    this.workspaceRoot = workspaceRoot;
  }

  /** Inject dependencies after construction. */
  setDeps(agentLoop: AgentLoop, sessions: SessionManager): void {
    this.agentLoop = agentLoop;
    this.sessions = sessions;
  }

  /** Register a handler for deliverable heartbeat output. */
  onDelivery(handler: HeartbeatDeliveryHandler): void {
    this.deliveryHandlers.push(handler);
  }

  /** Track the last active channel for 'last' target routing. */
  setLastChannel(channel: string): void {
    this.lastChannel = channel;
  }

  /** Whether typing should be suppressed (heartbeat in progress). */
  isTypingSuppressed(): boolean {
    return this.typingSuppressed;
  }

  /** Start the heartbeat loop. */
  start(): void {
    const intervalMs = parseDuration(this.config.every);
    if (intervalMs <= 0) {
      console.log('[heartbeat] Disabled (every=0)');
      return;
    }

    this.running = true;
    this.timer = setInterval(() => {
      this.runHeartbeat().catch((err) => {
        console.error('[heartbeat] Error:', err instanceof Error ? err.message : err);
      });
    }, intervalMs);

    console.log(`[heartbeat] Started (every ${this.config.every}, target=${this.config.target})`);
  }

  /** Stop the heartbeat loop. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.running = false;
    console.log('[heartbeat] Stopped');
  }

  /** Manual wake — run heartbeat immediately outside the timer. */
  async wake(): Promise<HeartbeatResult | null> {
    return this.runHeartbeat();
  }

  /** Execute a single heartbeat run. */
  private async runHeartbeat(): Promise<HeartbeatResult | null> {
    if (!this.agentLoop || !this.sessions) {
      console.warn('[heartbeat] Not initialized (missing agentLoop or sessions)');
      return null;
    }

    // 1. Check active hours
    if (!this.isWithinActiveHours()) {
      return null;
    }

    // 2. Read HEARTBEAT.md — skip if empty
    const heartbeatContent = await this.readHeartbeatFile();
    if (heartbeatContent !== null && heartbeatContent.trim() === '') {
      return null;
    }

    // 3. Suppress typing during heartbeat
    this.typingSuppressed = true;

    try {
      // 4. Get or create heartbeat session
      const session = this.getHeartbeatSession();

      // 5. Run agent loop with heartbeat prompt
      let response = '';
      for await (const chunk of this.agentLoop.run(session, this.config.prompt)) {
        response += chunk;
      }

      // 6. Parse response: HEARTBEAT_OK contract
      const result = this.parseResponse(response);

      // 7. Route delivery
      if (result.shouldDeliver) {
        this.deliver(result);
      }

      return result;
    } finally {
      this.typingSuppressed = false;
    }
  }

  /** Parse a heartbeat response according to the HEARTBEAT_OK contract. */
  private parseResponse(raw: string): HeartbeatResult {
    const trimmed = raw.trim();
    const hasAck =
      trimmed.startsWith('HEARTBEAT_OK') || trimmed.endsWith('HEARTBEAT_OK');

    // Strip HEARTBEAT_OK from the response
    const cleaned = trimmed
      .replace(/^HEARTBEAT_OK\s*/i, '')
      .replace(/\s*HEARTBEAT_OK$/i, '')
      .trim();

    // If ack and remaining text is short, suppress delivery
    const shouldDeliver = hasAck
      ? cleaned.length > this.config.ackMaxChars
      : cleaned.length > 0;

    return {
      isAck: hasAck,
      rawResponse: raw,
      deliverableText: cleaned,
      shouldDeliver,
      timestamp: new Date(),
    };
  }

  /** Route delivery to the configured target. */
  private deliver(result: HeartbeatResult): void {
    let target = this.config.target;

    if (target === 'none') return;
    if (target === 'last') {
      target = this.lastChannel ?? 'none';
      if (target === 'none') return;
    }

    for (const handler of this.deliveryHandlers) {
      try {
        handler(result, target);
      } catch {
        // Don't let handler errors crash the heartbeat system
      }
    }
  }

  /** Check if the current time is within the active hours window. */
  private isWithinActiveHours(): boolean {
    if (!this.config.activeHours) return true;

    const { start, end, timezone } = this.config.activeHours;
    const now = new Date();

    // Get current time in the configured timezone
    const formatter = new Intl.DateTimeFormat('en-US', {
      hour: '2-digit',
      minute: '2-digit',
      hour12: false,
      timeZone: timezone ?? undefined,
    });

    const parts = formatter.formatToParts(now);
    const hour = parseInt(parts.find((p) => p.type === 'hour')?.value ?? '0', 10);
    const minute = parseInt(parts.find((p) => p.type === 'minute')?.value ?? '0', 10);
    const currentMinutes = hour * 60 + minute;

    const [startH, startM] = start.split(':').map(Number);
    const [endH, endM] = end.split(':').map(Number);
    const startMinutes = startH * 60 + startM;
    const endMinutes = endH * 60 + endM;

    if (startMinutes <= endMinutes) {
      return currentMinutes >= startMinutes && currentMinutes < endMinutes;
    }
    // Wraps midnight
    return currentMinutes >= startMinutes || currentMinutes < endMinutes;
  }

  /** Read HEARTBEAT.md from workspace. Returns null if file doesn't exist. */
  private async readHeartbeatFile(): Promise<string | null> {
    try {
      return await readFile(join(this.workspaceRoot, 'HEARTBEAT.md'), 'utf-8');
    } catch {
      return null;
    }
  }

  /** Get or create the dedicated heartbeat session. */
  private getHeartbeatSession(): Session {
    if (!this.heartbeatSession) {
      this.heartbeatSession = this.sessions!.create({
        name: 'heartbeat',
        metadata: { isHeartbeat: true },
      });
    }
    return this.heartbeatSession;
  }
}

/** Parse a duration string like "30m", "1h", "2h30m" into milliseconds. */
export function parseDuration(duration: string): number {
  if (!duration || duration === '0' || duration === '0m') return 0;

  let totalMs = 0;
  const hourMatch = duration.match(/(\d+)\s*h/i);
  const minMatch = duration.match(/(\d+)\s*m/i);
  const secMatch = duration.match(/(\d+)\s*s/i);

  if (hourMatch) totalMs += parseInt(hourMatch[1], 10) * 3600_000;
  if (minMatch) totalMs += parseInt(minMatch[1], 10) * 60_000;
  if (secMatch) totalMs += parseInt(secMatch[1], 10) * 1000;

  return totalMs;
}
