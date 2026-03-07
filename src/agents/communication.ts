/**
 * Agent-to-Agent Communication — message passing between agents.
 *
 * Supports:
 * - Direct send: agent A → agent B (message processed as new user message)
 * - Broadcast: agent A → all agents
 * - History: stored in ~/.tako/agents/comms/<from>-<to>.jsonl
 */

import { appendFile, mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { homedir } from 'node:os';

// ─── Types ──────────────────────────────────────────────────────────

export interface AgentMessage {
  id: string;
  from: string;
  to: string;
  content: string;
  timestamp: number;
  replyTo?: string;
}

export interface CommsConfig {
  /** Enable agent communication (default: true). */
  enabled: boolean;
  /** Which agents can talk to whom. Empty = unrestricted. */
  allowList?: Record<string, string[]>;
}

export type MessageHandler = (toAgent: string, message: AgentMessage) => Promise<string>;

// ─── Agent Communication Hub ────────────────────────────────────────

export class AgentComms {
  private config: CommsConfig;
  private commsDir: string;
  private handler: MessageHandler | null = null;

  constructor(config: CommsConfig, commsDir?: string) {
    this.config = config;
    this.commsDir = commsDir ?? join(homedir(), '.tako', 'agents', 'comms');
  }

  /** Wire the message handler (called when a message needs to be processed by the receiving agent). */
  setHandler(handler: MessageHandler): void {
    this.handler = handler;
  }

  /**
   * Send a message from one agent to another.
   * Returns the receiving agent's response.
   */
  async send(
    fromAgent: string,
    toAgent: string,
    content: string,
    replyTo?: string,
  ): Promise<string> {
    if (!this.config.enabled) {
      throw new Error('Agent communication is disabled');
    }

    // Check allow list
    if (this.config.allowList) {
      const allowed = this.config.allowList[fromAgent];
      if (allowed && !allowed.includes(toAgent)) {
        throw new Error(`Agent ${fromAgent} is not allowed to message ${toAgent}`);
      }
    }

    const message: AgentMessage = {
      id: crypto.randomUUID(),
      from: fromAgent,
      to: toAgent,
      content,
      timestamp: Date.now(),
      replyTo,
    };

    // Persist to history
    await this.persistMessage(message);

    // Deliver to handler
    if (!this.handler) {
      throw new Error('No message handler configured — agent loop not started');
    }

    const response = await this.handler(toAgent, message);

    // Persist the response as a reply
    const reply: AgentMessage = {
      id: crypto.randomUUID(),
      from: toAgent,
      to: fromAgent,
      content: response,
      timestamp: Date.now(),
      replyTo: message.id,
    };
    await this.persistMessage(reply);

    return response;
  }

  /**
   * Broadcast a message from one agent to all agents.
   * Returns a map of agentId → response.
   */
  async broadcast(
    fromAgent: string,
    content: string,
    agentIds: string[],
  ): Promise<Map<string, string>> {
    const results = new Map<string, string>();

    for (const agentId of agentIds) {
      if (agentId === fromAgent) continue;
      try {
        const response = await this.send(fromAgent, agentId, content);
        results.set(agentId, response);
      } catch (err) {
        results.set(agentId, `[error: ${err instanceof Error ? err.message : String(err)}]`);
      }
    }

    return results;
  }

  /**
   * Get message history between two agents.
   */
  async getHistory(agentA: string, agentB: string, limit = 50): Promise<AgentMessage[]> {
    const messages: AgentMessage[] = [];

    // Check both directions
    for (const [from, to] of [[agentA, agentB], [agentB, agentA]]) {
      const filePath = this.getHistoryPath(from, to);
      try {
        const raw = await readFile(filePath, 'utf-8');
        for (const line of raw.trim().split('\n').filter(Boolean)) {
          try {
            messages.push(JSON.parse(line) as AgentMessage);
          } catch {
            // skip corrupt lines
          }
        }
      } catch {
        // No history file
      }
    }

    // Sort by timestamp and return last N
    messages.sort((a, b) => a.timestamp - b.timestamp);
    return messages.slice(-limit);
  }

  // ─── Private ────────────────────────────────────────────────────

  private async persistMessage(msg: AgentMessage): Promise<void> {
    const filePath = this.getHistoryPath(msg.from, msg.to);
    await mkdir(join(filePath, '..'), { recursive: true });
    await appendFile(filePath, JSON.stringify(msg) + '\n', 'utf-8');
  }

  private getHistoryPath(from: string, to: string): string {
    return join(this.commsDir, `${from}-${to}.jsonl`);
  }
}
