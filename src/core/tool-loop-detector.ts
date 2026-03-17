/**
 * Tool loop detector — detect when agent is stuck calling the same tool repeatedly.
 *
 * Monitors tool call patterns within a session turn. If the same tool is called
 * with similar arguments more than N times, it breaks the loop by injecting
 * a warning into the context.
 */

import { createHash } from 'node:crypto';

export interface LoopDetectorConfig {
  /** Enable loop detection (default: true) */
  enabled: boolean;
  /** Max identical tool calls before breaking (default: 3) */
  maxRepetitions: number;
  /** Max similar tool calls (same tool, different args) before warning (default: 5) */
  maxSimilarCalls: number;
  /** Window of recent tool calls to consider (default: 10) */
  windowSize: number;
}

const DEFAULT_CONFIG: LoopDetectorConfig = {
  enabled: true,
  maxRepetitions: 3,
  maxSimilarCalls: 5,
  windowSize: 10,
};

interface ToolCallRecord {
  toolName: string;
  argsHash: string;
  timestamp: number;
}

export class ToolLoopDetector {
  private config: LoopDetectorConfig;
  private history: Map<string, ToolCallRecord[]> = new Map();

  constructor(config?: Partial<LoopDetectorConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
  }

  /**
   * Record a missing tool result and check if we should bail.
   * Gemini/LiteLLM sometimes returns "[Tool result missing]" strings as tool output.
   * After N consecutive missing results, we inject a warning and break the loop.
   */
  recordMissingResult(sessionId: string, toolName: string): string | null {
    if (!this.config.enabled) return null;

    const key = `missing:${sessionId}`;
    const records = this.history.get(key) ?? [];
    records.push({ toolName, argsHash: 'missing', timestamp: Date.now() });
    if (records.length > this.config.windowSize) {
      records.splice(0, records.length - this.config.windowSize);
    }
    this.history.set(key, records);

    const missingCount = records.filter((r) => r.argsHash === 'missing').length;
    if (missingCount >= this.config.maxRepetitions) {
      return `⚠️ Multiple tool calls returned "[Tool result missing]" (${missingCount} times). This usually means the execution environment is stalled. Stopping the current task to avoid an infinite loop. Please let the user know and ask for guidance.`;
    }
    return null;
  }

  /**
   * Record a tool call and check for loops.
   * Returns a warning message if a loop is detected, null otherwise.
   */
  recordAndCheck(sessionId: string, toolName: string, args: Record<string, unknown>): string | null {
    if (!this.config.enabled) return null;

    const records = this.history.get(sessionId) ?? [];
    const argsHash = this.hashArgs(args);

    // Add new record
    records.push({ toolName, argsHash, timestamp: Date.now() });

    // Trim to window size
    if (records.length > this.config.windowSize) {
      records.splice(0, records.length - this.config.windowSize);
    }

    this.history.set(sessionId, records);

    // Check for identical loop (same tool + same args)
    if (this.checkIdenticalLoop(records, toolName, argsHash)) {
      const count = records.filter((r) => r.toolName === toolName && r.argsHash === argsHash).length;
      return `⚠️ Tool loop detected: you've called \`${toolName}\` ${count} times with identical arguments. This suggests you're stuck. Try a different approach or ask the user for help.`;
    }

    // Check for similar loop (same tool, different args)
    if (this.checkSimilarLoop(records, toolName)) {
      const count = records.filter((r) => r.toolName === toolName).length;
      return `⚠️ Tool loop detected: you've called \`${toolName}\` ${count} times in the recent window. Consider whether you're making progress or if you should try a different approach.`;
    }

    return null;
  }

  /** Clear history for a session (on new turn). Clears both call history and missing-result counter. */
  clearSession(sessionId: string): void {
    this.history.delete(sessionId);
    this.history.delete(`missing:${sessionId}`);
  }

  /** Clear all history. */
  clear(): void {
    this.history.clear();
  }

  /** Get loop stats for a session. */
  stats(sessionId: string): { totalCalls: number; uniqueTools: number; repetitions: Map<string, number> } {
    const records = this.history.get(sessionId) ?? [];
    const repetitions = new Map<string, number>();
    for (const r of records) {
      repetitions.set(r.toolName, (repetitions.get(r.toolName) ?? 0) + 1);
    }
    return {
      totalCalls: records.length,
      uniqueTools: repetitions.size,
      repetitions,
    };
  }

  private hashArgs(args: Record<string, unknown>): string {
    const sorted = JSON.stringify(args, Object.keys(args).sort());
    return createHash('sha256').update(sorted).digest('hex').slice(0, 16);
  }

  private checkIdenticalLoop(records: ToolCallRecord[], toolName: string, argsHash: string): boolean {
    const count = records.filter((r) => r.toolName === toolName && r.argsHash === argsHash).length;
    return count >= this.config.maxRepetitions;
  }

  private checkSimilarLoop(records: ToolCallRecord[], toolName: string): boolean {
    const count = records.filter((r) => r.toolName === toolName).length;
    return count >= this.config.maxSimilarCalls;
  }
}
