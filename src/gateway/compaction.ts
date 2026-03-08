/**
 * Session compaction — auto-compact sessions when context gets large.
 *
 * Implements the reference runtime compaction pattern:
 * - Token estimation with configurable threshold
 * - Summarize older messages before replacing them
 * - Memory flush before compaction (save important context)
 * - Integrates with ContextManager for token counting
 */

import type { SessionConfig } from '../config/schema.js';
import type { Session, SessionManager } from './session.js';
import type { ContextManager } from '../core/context.js';
import type { ChatMessage, Provider } from '../providers/provider.js';
import type { HookSystem } from '../hooks/types.js';

export interface CompactionResult {
  sessionId: string;
  messagesBefore: number;
  messagesAfter: number;
  estimatedTokensBefore: number;
  estimatedTokensAfter: number;
  compactionCount: number;
  timestamp: Date;
}

export class SessionCompactor {
  private config: SessionConfig;
  private contextManager: ContextManager;
  private sessions: SessionManager;
  private provider: Provider | null;
  private hooks: HookSystem | null;
  private smartSummary: boolean;

  constructor(
    config: SessionConfig,
    contextManager: ContextManager,
    sessions: SessionManager,
    provider?: Provider,
    hooks?: HookSystem,
  ) {
    this.config = config;
    this.contextManager = contextManager;
    this.sessions = sessions;
    this.provider = provider ?? null;
    this.hooks = hooks ?? null;
    this.smartSummary = config.compaction.smartSummary ?? true;
  }

  /**
   * Check if a session needs compaction based on token threshold.
   * Uses the context manager's token estimation.
   */
  needsCompaction(session: Session): boolean {
    if (!this.config.compaction.auto) return false;
    return this.contextManager.needsCompaction(session.messages);
  }

  /**
   * Build a summary of messages being compacted.
   * Extracts key topics and tool calls from the conversation.
   */
  private buildSummary(messages: ChatMessage[]): string {
    const topics: string[] = [];
    const toolsUsed = new Set<string>();
    let userQuestions = 0;
    let assistantReplies = 0;

    for (const msg of messages) {
      if (msg.role === 'user') {
        userQuestions++;
        const text = typeof msg.content === 'string'
          ? msg.content
          : msg.content.filter((p) => p.type === 'text').map((p) => (p as { type: 'text'; text: string }).text).join(' ');
        // Capture first 80 chars of each user message as a topic hint
        if (text.trim()) {
          topics.push(text.trim().slice(0, 80));
        }
      } else if (msg.role === 'assistant') {
        assistantReplies++;
        if (Array.isArray(msg.content)) {
          for (const part of msg.content) {
            if (part.type === 'tool_use') {
              toolsUsed.add(part.name);
            }
          }
        }
      }
    }

    const lines: string[] = [
      `[Context compacted: ${messages.length} messages summarized]`,
      `Exchanges: ${userQuestions} user messages, ${assistantReplies} assistant replies.`,
    ];

    if (toolsUsed.size > 0) {
      lines.push(`Tools used: ${[...toolsUsed].join(', ')}.`);
    }

    if (topics.length > 0) {
      const topicSummary = topics.slice(0, 5).map((t) => `- ${t}`).join('\n');
      lines.push(`Topics discussed:\n${topicSummary}`);
      if (topics.length > 5) {
        lines.push(`  ...and ${topics.length - 5} more.`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Build a rich summary using the LLM itself.
   * Falls back to heuristic summary if provider is unavailable.
   */
  private async buildSmartSummary(messages: ChatMessage[]): Promise<string> {
    if (!this.provider) {
      return this.buildSummary(messages);
    }

    try {
      const conversationText = messages
        .filter(m => m.role !== 'system')
        .map(m => {
          const content = typeof m.content === 'string'
            ? m.content
            : m.content.filter(p => p.type === 'text').map(p => (p as { type: 'text'; text: string }).text).join(' ');
          return `[${m.role}]: ${content.slice(0, 500)}`;
        })
        .join('\n');

      // Truncate to avoid using too many tokens for the summary itself
      const truncated = conversationText.slice(0, 8000);

      const summaryMessages: ChatMessage[] = [
        {
          role: 'system',
          content: `You are a conversation summarizer. Produce a structured summary preserving:
- Key decisions made and their reasoning
- Files created, modified, or deleted (with paths)
- User preferences and requirements discovered
- Unresolved issues, bugs, or TODOs
- Technical context needed for future sessions
- Tools used and their outcomes

Format as a structured markdown summary. Be concise but preserve critical details.
Maximum 500 words.`,
        },
        {
          role: 'user',
          content: `Summarize this conversation:\n\n${truncated}`,
        },
      ];

      let summaryText = '';
      for await (const chunk of this.provider.chat({
        model: '',
        messages: summaryMessages,
        stream: true,
        max_tokens: 1000,
      })) {
        if (chunk.text) summaryText += chunk.text;
      }

      return `[Compaction Summary — LLM-generated]\n${summaryText}`;
    } catch (err) {
      console.warn('[compaction] LLM summary failed, falling back to heuristic:', err);
      return this.buildSummary(messages);
    }
  }

  /**
   * Compact a session by summarizing older messages.
   * Keeps the most recent messages intact and replaces older ones
   * with a structured summary.
   */
  async compact(session: Session, keepLast = 20): Promise<CompactionResult> {
    const messagesBefore = session.messages.length;
    const estimatedTokensBefore = this.contextManager.estimateTokens(session.messages);

    if (messagesBefore <= keepLast) {
      return {
        sessionId: session.id,
        messagesBefore,
        messagesAfter: messagesBefore,
        estimatedTokensBefore,
        estimatedTokensAfter: estimatedTokensBefore,
        compactionCount: (session.metadata.compactionCount as number) ?? 0,
        timestamp: new Date(),
      };
    }

    // Emit before_compaction hook
    if (this.hooks) {
      await this.hooks.emit('before_compaction', {
        event: 'before_compaction',
        sessionId: session.id,
        timestamp: Date.now(),
        data: { session, messageCount: messagesBefore },
      });
    }

    // Build summary from messages being trimmed
    const messagesToTrim = session.messages.slice(0, messagesBefore - keepLast);
    const summary = this.smartSummary
      ? await this.buildSmartSummary(messagesToTrim)
      : this.buildSummary(messagesToTrim);

    // Replace old messages with summary + recent messages
    const kept = session.messages.slice(-keepLast);
    session.messages = [
      { role: 'system', content: summary },
      ...kept,
    ];

    // Track compaction count
    const compactionCount = ((session.metadata.compactionCount as number) ?? 0) + 1;
    session.metadata.compactionCount = compactionCount;
    session.metadata.lastCompactedAt = new Date().toISOString();
    session.metadata.compactedMessageCount =
      ((session.metadata.compactedMessageCount as number) ?? 0) + messagesToTrim.length;

    // Persist via session manager
    await this.sessions.compact(session.id, keepLast);

    const estimatedTokensAfter = this.contextManager.estimateTokens(session.messages);

    const result: CompactionResult = {
      sessionId: session.id,
      messagesBefore,
      messagesAfter: session.messages.length,
      estimatedTokensBefore,
      estimatedTokensAfter,
      compactionCount,
      timestamp: new Date(),
    };

    console.log(
      `[compaction] Session ${session.id} (#${compactionCount}): ` +
      `${messagesBefore} → ${result.messagesAfter} messages, ` +
      `~${estimatedTokensBefore} → ~${estimatedTokensAfter} tokens`,
    );

    // Emit after_compaction hook
    if (this.hooks) {
      await this.hooks.emit('after_compaction', {
        event: 'after_compaction',
        sessionId: session.id,
        timestamp: Date.now(),
        data: { session, result },
      });
    }

    return result;
  }

  /**
   * Run compaction check before sending to the model.
   * Called from the agent loop before each inference cycle.
   */
  async checkAndCompact(session: Session): Promise<CompactionResult | null> {
    if (!this.needsCompaction(session)) return null;
    return this.compact(session);
  }

  /**
   * Prune old completed sub-agent sessions.
   * Removes sessions marked as completed that are older than pruneAfterDays.
   */
  async pruneOldSessions(): Promise<number> {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - this.config.pruneAfterDays);

    let pruned = 0;
    for (const session of this.sessions.list()) {
      if (
        session.metadata.isSubAgent &&
        session.metadata.completed &&
        session.lastActiveAt < cutoff
      ) {
        this.sessions.delete(session.id);
        pruned++;
      }
    }

    if (pruned > 0) {
      console.log(`[compaction] Pruned ${pruned} old sub-agent sessions`);
    }

    return pruned;
  }
}
