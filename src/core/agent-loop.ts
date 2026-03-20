/**
 * Agent loop — the CPU cycle.
 *
 * 1. Message arrives (from any Channel)
 * 2. Session resolved (or created)
 * 3. Context assembled (system prompt + dynamic skill injection + history + memory)
 * 4. Provider.chat() called (streaming)
 * 5. Tool calls executed (if any)
 * 6. Response streamed back through Channel
 * 7. Session persisted
 * 8. Memory updated (if needed)
 */

import type { Provider, ChatMessage, ToolCall, ContentPart } from '../providers/provider.js';
import type { ToolContext, ToolResult } from '../tools/tool.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { PromptBuilder } from './prompt.js';
import type { ContextManager } from './context.js';
import type { Session } from '../gateway/session.js';
import type { HookSystem } from '../hooks/types.js';
import type { SkillLoader } from '../skills/loader.js';
import type { SessionCompactor } from '../gateway/compaction.js';
import type { RetryQueue } from './retry-queue.js';
import type { ProgressTracker } from './progress.js';
import { buildSessionInitContext } from './session-init.js';
import type { SessionInitConfig, StreamingConfig } from '../config/schema.js';
import { ResponseStreamer, type StreamConfig } from './streaming.js';
import type { Channel } from '../channels/channel.js';
import { isToolAllowed, getRole } from '../agents/roles.js';
import { scanSecrets, checkRateLimit, sanitizeInput, getToolValidator } from './security.js';
import { parseCommand } from '../commands/parser.js';
import type { CommandRegistry } from '../commands/registry.js';
import { TypingManager } from './typing.js';
import { readFile } from 'node:fs/promises';
import { extractPdfContent } from '../media/pdf-extract.js';
import { ToolLoopDetector } from './tool-loop-detector.js';
import type { UsageTracker } from './usage-tracker.js';
import type { ThinkingManager } from './thinking.js';
import type { ReactionManager } from './reactions.js';
import type { TimezoneManager } from './timezone.js';
import { toCommandContext } from './execution-context.js';
import type { ExecutionContext } from './execution-context.js';

/** Sentinel yielded after each intermediate turn so callers can flush text. */

/** Configuration for the agent loop. */
export interface AgentLoopConfig {
  /** Max seconds before timeout */
  timeout: number;
  /** Max tool calls per turn */
  maxToolCalls: number;
  /** Max turns (inference + tool loop iterations) */
  maxTurns: number;
  /** Max output characters before truncation (default 50000) */
  maxOutputChars: number;
  /** Max output tokens per API call (passed to provider as max_tokens) */
  maxTokens?: number;
  /** Per-tool call hard timeout in ms (default 30000). Prevents a single stuck tool from blocking forever. */
  toolCallTimeoutMs?: number;
}

const DEFAULT_LOOP_CONFIG: AgentLoopConfig = {
  timeout: 600,
  maxToolCalls: 50,
  maxTurns: 20,
  maxOutputChars: 50_000,
  toolCallTimeoutMs: 30_000,
};

function detectImageMediaType(buffer: Buffer, fallback = 'image/png'): string {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buffer.length >= 8
    && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4E && buffer[3] === 0x47
    && buffer[4] === 0x0D && buffer[5] === 0x0A && buffer[6] === 0x1A && buffer[7] === 0x0A) return 'image/png';
  // JPEG: FF D8 FF
  if (buffer.length >= 3 && buffer[0] === 0xFF && buffer[1] === 0xD8 && buffer[2] === 0xFF) return 'image/jpeg';
  // GIF87a / GIF89a
  if (buffer.length >= 6) {
    const sig = buffer.subarray(0, 6).toString('ascii');
    if (sig === 'GIF87a' || sig === 'GIF89a') return 'image/gif';
  }
  // WEBP: RIFF....WEBP
  if (buffer.length >= 12
    && buffer.subarray(0, 4).toString('ascii') === 'RIFF'
    && buffer.subarray(8, 12).toString('ascii') === 'WEBP') return 'image/webp';
  return fallback;
}

/** MIME types for text-readable files that can be included inline. */
const TEXT_FILE_EXTENSIONS = new Set([
  '.txt', '.md', '.json', '.csv', '.xml', '.yaml', '.yml', '.toml',
  '.html', '.htm', '.css', '.js', '.ts', '.py', '.sh', '.log', '.ini', '.cfg',
]);

function isTextFile(filename?: string, mimeType?: string): boolean {
  if (mimeType?.startsWith('text/')) return true;
  if (mimeType === 'application/json' || mimeType === 'application/xml') return true;
  if (filename) {
    const ext = filename.slice(filename.lastIndexOf('.')).toLowerCase();
    return TEXT_FILE_EXTENSIONS.has(ext);
  }
  return false;
}

function isOfficeFile(filename?: string, mimeType?: string): boolean {
  const name = filename?.toLowerCase() ?? '';
  const mime = mimeType?.toLowerCase() ?? '';
  return (
    name.endsWith('.pptx')
    || name.endsWith('.docx')
    || name.endsWith('.xlsx')
    || mime === 'application/vnd.openxmlformats-officedocument.presentationml.presentation'
    || mime === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    || mime === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
  );
}

function isPdf(mimeType?: string, filename?: string): boolean {
  if (mimeType === 'application/pdf') return true;
  if (filename?.toLowerCase().endsWith('.pdf')) return true;
  return false;
}

/** Download an attachment from URL or local path into a Buffer. */
async function downloadAttachment(source: string): Promise<{ buffer: Buffer; contentType?: string } | null> {
  try {
    if (source.startsWith('http://') || source.startsWith('https://')) {
      const resp = await fetch(source);
      if (!resp.ok) {
        console.warn(`[agent-loop] Failed to fetch attachment ${source}: HTTP ${resp.status}`);
        return null;
      }
      return {
        buffer: Buffer.from(await resp.arrayBuffer()),
        contentType: resp.headers.get('content-type') ?? undefined,
      };
    } else if (source.startsWith('file://')) {
      return { buffer: await readFile(new URL(source).pathname) };
    } else {
      return { buffer: await readFile(source) };
    }
  } catch (err) {
    console.warn(`[agent-loop] Failed to download attachment ${source}:`, err instanceof Error ? err.message : err);
    return null;
  }
}

/** Dependencies injected into the agent loop. */
export interface AgentLoopDeps {
  /** LLM provider for inference */
  provider: Provider;
  /** Registry of available tools */
  toolRegistry: ToolRegistry;
  /** System prompt builder */
  promptBuilder: PromptBuilder;
  /** Context window manager */
  contextManager: ContextManager;
  /** Lifecycle hook system */
  hooks?: HookSystem;
  /** Skill loader for dynamic injection based on message triggers */
  skillLoader?: SkillLoader;
  /** Model ID to use (e.g. 'anthropic/claude-sonnet-4-6') */
  model?: string;
  /** Agent workspace root path */
  workspaceRoot?: string;
  /** Session compactor for auto-compaction */
  compactor?: SessionCompactor;
  /** Retry queue for failed messages after failover exhaustion */
  retryQueue?: RetryQueue;
  /** Permission role name for the active agent (default: 'admin') */
  agentRole?: string;
  /** Active agent ID */
  agentId?: string;
  /** Command registry for built-in slash commands */
  commandRegistry?: CommandRegistry;
  /** Progress tracker for structured session progress */
  progressTracker?: ProgressTracker;
  /** Session init protocol configuration */
  sessionInitConfig?: SessionInitConfig;
  /** Response streaming configuration */
  streamingConfig?: StreamingConfig;
  /** Typing indicator manager */
  typingManager?: TypingManager;
  /** Tool loop detector */
  toolLoopDetector?: ToolLoopDetector;
  /** Channel reference for typing indicators */
  channel?: Channel;
  /** Usage tracker for token and cost monitoring */
  usageTracker?: UsageTracker;
  /** Thinking/reasoning control manager */
  thinkingManager?: ThinkingManager;
  /** Reaction feedback manager */
  reactionManager?: ReactionManager;
  /** Timezone manager for context injection */
  timezoneManager?: TimezoneManager;
  /** Shared/peer access override path for privileged tool requests */
  handleSharedAccessToolAuthorization?: (input: {
    session: Session;
    toolCall: ToolCall;
    roleName: string;
    userMessage: string;
    executionContext?: ExecutionContext;
    channel?: Channel;
  }) => Promise<{
    allow: boolean;
    approvalId?: string;
    toolResult?: ToolResult;
  } | null>;
}

export class AgentLoop {
  private config: AgentLoopConfig;
  private deps: AgentLoopDeps;

  constructor(deps: AgentLoopDeps, config?: Partial<AgentLoopConfig>) {
    this.deps = deps;
    this.config = { ...DEFAULT_LOOP_CONFIG, ...config };
  }

  /** Max tool result size before truncation (default 50KB). */
  private static readonly MAX_TOOL_RESULT_CHARS = 50_000;

  /**
   * Truncate oversized tool results using head+tail strategy.
   * Keeps first 80% and last 20% with a truncation marker in between.
   * This preserves error messages that typically appear at the end of output.
   */
  private truncateToolResult(output: unknown): string {
    const text = typeof output === 'string'
      ? output
      : output == null
        ? ''
        : (() => {
            try { return JSON.stringify(output); } catch { return String(output); }
          })();

    const maxChars = this.config.maxOutputChars ?? AgentLoop.MAX_TOOL_RESULT_CHARS;
    if (text.length <= maxChars) return text;

    const marker = '\n\n[… truncated middle section …]\n\n';
    const available = maxChars - marker.length;
    const headSize = Math.floor(available * 0.8);
    const tailSize = available - headSize;

    const head = text.slice(0, headSize);
    const tail = text.slice(text.length - tailSize);
    return head + marker + tail;
  }

  /** Switch the active model at runtime. */
  setModel(modelRef: string): void {
    this.deps.model = modelRef;
  }

  /** Get the current active model. */
  getModel(): string {
    return this.deps.model ?? 'anthropic/claude-sonnet-4-6';
  }

  /**
   * Sanitize messages for API compatibility:
   * - Merge consecutive user messages (some APIs reject this)
   * - Ensure conversation doesn't end with assistant (prefill rejection)
   * - Strip empty messages
   * - Repair tool_use/tool_result pairing (Anthropic requires each tool_result
   *   to have a matching tool_use in the previous assistant message)
   */
  private sanitizeMessages(messages: ChatMessage[]): ChatMessage[] {
    const result: ChatMessage[] = [];
    for (const msg of messages) {
      // Defensive: tolerate malformed history entries.
      if (!msg || typeof msg !== 'object') continue;

      // Normalize null/undefined content — Gemini and some other providers
      // return null content on tool-call-only assistant turns.
      if (msg.content == null) {
        // Keep the message if it has a role that carries other data (assistant with tool calls
        // is represented as content=null in the OpenAI/LiteLLM wire format but will have
        // tool_call_id or be reconstructed by repairToolPairing). Drop bare null-content
        // user/system messages entirely.
        if (msg.role === 'user' || msg.role === 'system') continue;
        // For assistant/tool roles, coerce to empty string so downstream doesn't crash.
        result.push({ ...msg, content: '' });
        continue;
      }

      // Skip empty text messages
      if (typeof msg.content === 'string' && !msg.content.trim() && msg.role !== 'system') continue;

      // Merge consecutive user messages
      const prev = result[result.length - 1];
      if (prev && prev.role === 'user' && msg.role === 'user'
        && typeof prev.content === 'string' && typeof msg.content === 'string') {
        prev.content = prev.content + '\n' + msg.content;
        continue;
      }
      result.push({ ...msg });
    }

    // Strip trailing assistant messages (prevents "prefill" errors)
    while (result.length > 0 && result[result.length - 1].role === 'assistant') {
      result.pop();
    }

    // Repair tool_use/tool_result pairing
    return this.repairToolPairing(result);
  }

  /**
   * Repair tool_use/tool_result pairing in message history.
   * Anthropic requires every tool_result to have a matching tool_use
   * in the preceding assistant message, and vice versa.
   *
   * Based on reference runtime's repairToolUseResultPairing pattern.
   */
  private repairToolPairing(messages: ChatMessage[]): ChatMessage[] {
    const result: ChatMessage[] = [];

    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (!msg || typeof msg !== 'object') continue;

      if (msg.role !== 'assistant' || typeof msg.content === 'string') {
        // For tool results, verify they have a matching tool_use in a preceding assistant
        if (msg.role === 'tool' && msg.tool_call_id) {
          // Check if there's a matching tool_use in the previous assistant message
          const prevAssistant = [...result].reverse().find((m) => m.role === 'assistant');
          if (prevAssistant && Array.isArray(prevAssistant.content)) {
            const hasMatch = prevAssistant.content.some(
              (p) => p.type === 'tool_use' && p.id === msg.tool_call_id,
            );
            if (!hasMatch) {
              // Orphan tool_result — drop it
              continue;
            }
          }
        }
        result.push(msg);
        continue;
      }

      // Assistant message with content blocks — check for tool_use blocks
      const toolUseIds = new Set<string>();
      if (Array.isArray(msg.content)) {
        for (const part of msg.content) {
          if (part.type === 'tool_use') {
            toolUseIds.add(part.id);
          }
        }
      }

      result.push(msg);

      if (toolUseIds.size === 0) continue;

      // Collect subsequent tool results that match these tool_use IDs.
      // Scan past interleaved user messages — they can appear between
      // tool_use and tool_result when the message queue delivers a new
      // user message while a tool call is in flight.
      const foundIds = new Set<string>();
      const deferredUserMessages: ChatMessage[] = [];
      let j = i + 1;
      while (j < messages.length) {
        const candidate = messages[j];
        if (candidate.role === 'tool') {
          if (candidate.tool_call_id && toolUseIds.has(candidate.tool_call_id)) {
            foundIds.add(candidate.tool_call_id);
            result.push(candidate);
          }
          // Drop orphan tool results that don't match any tool_use
          j++;
        } else if (candidate.role === 'user' && foundIds.size < toolUseIds.size) {
          // User message arrived mid-tool-execution — defer it until after tool results
          deferredUserMessages.push(candidate);
          j++;
        } else {
          break;
        }
      }

      // Add synthetic results for any tool_use without a matching result
      for (const id of toolUseIds) {
        if (!foundIds.has(id)) {
          const toolUse = (msg.content as ContentPart[]).find(
            (p) => p.type === 'tool_use' && p.id === id,
          );
          const name = toolUse && 'name' in toolUse ? toolUse.name : 'unknown';
          result.push({
            role: 'tool',
            content: `[Tool result missing — ${name} was called but no result was recorded]`,
            tool_call_id: id,
          });
        }
      }

      // Re-insert any deferred user messages after tool results
      for (const deferred of deferredUserMessages) {
        result.push(deferred);
      }

      // Skip the tool results (and deferred messages) we already processed
      i = j - 1;
    }

    return result;
  }

  /**
   * Run the agent loop for a single turn.
   * Yields text chunks as they stream from the provider.
   * Dynamically injects matching skill instructions based on the user message.
   */
  /** Set the active channel for typing/reactions (call before run). */
  setChannel(channel: Channel): void {
    this.deps.channel = channel;
  }

  async *run(session: Session, userMessage: string, attachments?: Array<{ type: string; url?: string; filename?: string; mimeType?: string }>): AsyncIterable<string> {
    const { provider, toolRegistry, promptBuilder, contextManager, hooks, skillLoader } = this.deps;
    const baselineMessages = session.messages.slice();
    const baselineLastActiveAt = session.lastActiveAt;

    // 1. Fire agent_start hook
    if (hooks) {
      await hooks.emit('agent_start', {
        event: 'agent_start',
        sessionId: session.id,
        data: {
          userMessage,
          agentId: this.deps.agentId,
          principalId: session.metadata?.principalId,
          principalName: session.metadata?.principalName,
        },
        timestamp: Date.now(),
      });
    }

    // 1a. Rate limiting check
    const authorId = session.metadata?.principalId as string | undefined
      ?? session.metadata?.authorId as string | undefined;
    const channelId = session.metadata?.channelId as string | undefined;
    if (authorId && channelId) {
      const rateLimitMsg = checkRateLimit(authorId, channelId);
      if (rateLimitMsg) {
        yield rateLimitMsg;
        return;
      }
    }

    // 1a2. Input sanitization
    const sanitized_input = sanitizeInput(userMessage);
    if (sanitized_input.blocked) {
      yield 'Your message was blocked by security policy.';
      return;
    }
    userMessage = sanitized_input.text;

    // New inbound user turn supersedes pending retries for this session.
    this.deps.retryQueue?.cancelSession(session.id);

    // 1a3. Start typing indicator
    const chatId = session.metadata?.channelTarget as string ?? session.metadata?.channelId as string ?? session.id;
    if (this.deps.typingManager && this.deps.channel) {
      this.deps.typingManager.start(this.deps.channel, chatId);
    }

    try {
      // 1b. React with 👀 (received)
      const messageId = session.metadata?.messageId as string | undefined;
    if (this.deps.reactionManager && this.deps.channel && messageId) {
      await this.deps.reactionManager.react(this.deps.channel, chatId, messageId, 'received');
    }

    // 1c. Check if message is a command
    const parsed = parseCommand(userMessage);
    if (parsed) {
      // /think <level> — set thinking level for this session
      if (parsed.command === 'think' && this.deps.thinkingManager) {
        const levels = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;
        const level = parsed.args.trim().toLowerCase();
        if (levels.includes(level as typeof levels[number])) {
          this.deps.thinkingManager.setLevel(session.id, level as typeof levels[number]);
          this.deps.typingManager?.stop(chatId);
          yield `Thinking level set to **${level}** for this session.`;
          return;
        }
        this.deps.typingManager?.stop(chatId);
        yield `Invalid thinking level. Use one of: ${levels.join(', ')}`;
        return;
      }

      // Built-in commands (/help, /status, etc.)
      if (this.deps.commandRegistry) {
        const executionContext = session.metadata?.executionContext as import('./execution-context.js').ExecutionContext | undefined;
        const builtinResult = await this.deps.commandRegistry.handle(userMessage, {
          ...(executionContext
            ? toCommandContext({ ...executionContext, sessionId: session.id })
            : {
                channelId: session.metadata?.channelId as string ?? '',
                authorId: session.metadata?.authorId as string ?? '',
                authorName: session.metadata?.authorName as string ?? '',
                principalId: session.metadata?.principalId as string | undefined,
                principalName: session.metadata?.principalName as string | undefined,
                projectId: session.metadata?.projectId as string | undefined,
                projectSlug: session.metadata?.projectSlug as string | undefined,
                projectRole: session.metadata?.projectRole as string | undefined,
                agentId: this.deps.agentId ?? '',
              }),
          session,
        });
        if (builtinResult !== null) {
          this.deps.typingManager?.stop(chatId);
          yield builtinResult;
          return;
        }
      }

    }

    // 1d. Transition reaction to processing
    if (this.deps.reactionManager && this.deps.channel && messageId) {
      await this.deps.reactionManager.transition(this.deps.channel, chatId, messageId, 'received', 'processing');
    }

    // 2. Build system prompt
    if (hooks) {
      await hooks.emit('before_prompt_build', {
        event: 'before_prompt_build',
        sessionId: session.id,
        data: {},
        timestamp: Date.now(),
      });
    }

    // Inject self-awareness context into prompt builder
    promptBuilder.setTools(toolRegistry.getActiveTools());
    if (skillLoader) {
      promptBuilder.setSkills(skillLoader.getAll());
    }
    if (this.deps.model) {
      promptBuilder.setModel(this.deps.model);
    }
    if (this.deps.workspaceRoot) {
      promptBuilder.setWorkingDir(this.deps.workspaceRoot);
    }
    promptBuilder.setExecutionContext(
      session.metadata?.executionContext as import('./execution-context.js').ExecutionContext | null ?? null,
    );
    // Inject timezone context
    if (this.deps.timezoneManager) {
      promptBuilder.setTimezoneContext(this.deps.timezoneManager.getContextString());
    }

    let systemPrompt = await promptBuilder.build({ mode: 'full' });

    // Dynamic skill injection: check trigger conditions against the user message
    if (skillLoader) {
      const matchingSkills = skillLoader.getMatchingSkills(userMessage);
      for (const skill of matchingSkills) {
        // Avoid duplicating instructions already in the base prompt
        const snippet = skill.instructions.slice(0, 100);
        if (!systemPrompt.includes(snippet)) {
          systemPrompt += `\n\n---\n\n# Skill: ${skill.manifest.name}\n\n${skill.instructions}`;
        }
      }
    }

    // Inject skill instructions from command dispatch (if applicable)
    const injectedInstructions = session.metadata?._injectedSkillInstructions as string | undefined;
    const injectedSkillName = session.metadata?._injectedSkillName as string | undefined;
    if (injectedInstructions && injectedSkillName) {
      const snippet = injectedInstructions.slice(0, 100);
      if (!systemPrompt.includes(snippet)) {
        systemPrompt += `\n\n---\n\n# Skill: ${injectedSkillName}\n\n${injectedInstructions}`;
      }
      // Clean up metadata
      delete session.metadata?._injectedSkillInstructions;
      delete session.metadata?._injectedSkillName;
    }

    const projectBackgroundSummary = session.metadata?.projectBackgroundSummary as string | undefined;
    if (projectBackgroundSummary?.trim()) {
      systemPrompt += `\n\n---\n\n# Project Background\n\n${projectBackgroundSummary}`;
    }

    // 3. Append user message to session (with attachments as content blocks)
    const imageAttachments = attachments?.filter((a) => (a.type === 'image' || a.mimeType?.startsWith('image/')) && a.url) ?? [];
    const fileAttachments = attachments?.filter((a) =>
      a.url && a.type !== 'image' && !a.mimeType?.startsWith('image/')
      && (a.type === 'file' || isPdf(a.mimeType, a.filename) || isTextFile(a.filename, a.mimeType))
    ) ?? [];
    const opaqueFileAttachments = attachments?.filter((a) =>
      a.url && a.type !== 'image' && !a.mimeType?.startsWith('image/')
      && !isPdf(a.mimeType, a.filename) && !isTextFile(a.filename, a.mimeType)
    ) ?? [];

    const extraParts: import('../providers/provider.js').ContentPart[] = [];
    let textPrefix = '';

    // Process image attachments → base64 content parts
    for (const a of imageAttachments) {
      const dl = await downloadAttachment(a.url!);
      if (!dl) continue;
      const mediaType = detectImageMediaType(dl.buffer, a.mimeType || dl.contentType || 'image/png');
      extraParts.push({
        type: 'image_base64',
        media_type: mediaType,
        data: dl.buffer.toString('base64'),
      });
    }

    // Process file attachments → PDF document parts or text prefix
    for (const a of fileAttachments) {
      const dl = await downloadAttachment(a.url!);
      if (!dl) continue;

      if (isPdf(a.mimeType ?? dl.contentType, a.filename)) {
        console.log(`[agent-loop] Processing PDF attachment: ${a.filename ?? 'unknown.pdf'}`);
        // Send as native document content part (Anthropic supports this)
        extraParts.push({
          type: 'document',
          source: {
            type: 'base64',
            media_type: 'application/pdf',
            data: dl.buffer.toString('base64'),
          },
        });
      } else if (isTextFile(a.filename, a.mimeType ?? dl.contentType)) {
        console.log(`[agent-loop] Processing text attachment: ${a.filename ?? 'unknown.txt'}`);
        const text = dl.buffer.toString('utf-8');
        textPrefix += `[Attached file: ${a.filename ?? 'file'}]\n${text}\n\n`;
      }
    }

    // Surface opaque attachments like .pptx/.docx/.xlsx as local artifacts the model can inspect with tools.
    for (const a of opaqueFileAttachments) {
      const filePath = a.url ?? '';
      const descriptor = [
        `Attached file available locally: ${a.filename ?? 'file'}`,
        a.mimeType ? `type=${a.mimeType}` : null,
        filePath ? `path=${filePath}` : null,
      ].filter(Boolean).join(', ');
      const hint = isOfficeFile(a.filename, a.mimeType)
        ? 'This is an Office document. Use the extract_office_text tool on the local path to read its contents.'
        : 'Use file or exec tools if you need to inspect this attachment.';
      textPrefix += `[${descriptor}]\n${hint}\n\n`;
    }

    // Build the user message
    const finalMessage = textPrefix
      ? textPrefix + (userMessage || '')
      : (userMessage || (extraParts.length > 0 ? 'What is in this file?' : ''));

    if (extraParts.length > 0) {
      const contentParts: import('../providers/provider.js').ContentPart[] = [
        { type: 'text', text: finalMessage },
        ...extraParts,
      ];
      session.messages.push({ role: 'user', content: contentParts });
    } else {
      session.messages.push({ role: 'user', content: finalMessage });
    }

    // 4. Assemble context
    const messages: ChatMessage[] = [
      { role: 'system', content: systemPrompt },
      ...session.messages,
    ];

    // 5. Get tool definitions
    const tools = toolRegistry.getActiveTools().map((t) => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters as Record<string, unknown>,
    }));

    // 6. Agent loop (may iterate if tool calls occur)
    let turns = 0;
    let emergencyCompacted = false;
    while (turns < this.config.maxTurns) {
      turns++;

      // Progressive pruning before compaction to reduce context pressure.
      const pruningResult = contextManager.pruneMessages(session.messages);
      if (pruningResult.tokensSaved > 0) {
        session.messages = pruningResult.messages;
        messages.length = 0;
        messages.push({ role: 'system', content: systemPrompt }, ...session.messages);
      }

      if (this.deps.compactor && this.deps.compactor.needsCompaction(session)) {
        const compactionResult = await this.deps.compactor.checkAndCompact(session);
        // Rebuild messages array from compacted session
        messages.length = 0;
        messages.push({ role: 'system', content: systemPrompt }, ...session.messages);

        // Inject session init context after compaction
        if (compactionResult && this.deps.progressTracker) {
          const initContext = await buildSessionInitContext(
            this.deps.progressTracker,
            this.deps.sessionInitConfig,
          );
          const initMsg: ChatMessage = { role: 'system', content: initContext };
          session.messages.push(initMsg);
          messages.push(initMsg);
        }
      }

      const model = this.deps.model ?? 'anthropic/claude-sonnet-4-6';

      // Sanitize messages: merge consecutive same-role messages for API compatibility
      const sanitized = this.sanitizeMessages(messages);

      let fullText = '';
      let pendingToolCalls: ToolCall[] = [];
      const turnStartMs = Date.now();
      let lastUsage: import('../providers/provider.js').UsageStats | undefined;

      // Set up streaming if a channel is available and streaming is enabled
      const streamingCfg = this.deps.streamingConfig;
      const channelRef = session.metadata?.channelRef as Channel | undefined;
      const channelTarget = session.metadata?.channelTarget as string | undefined;
      // reference runtime-style default: streaming off unless explicitly enabled in config
      const streamEnabled = streamingCfg?.enabled === true && channelRef && channelTarget;

      let streamer: ResponseStreamer | undefined;
      if (streamEnabled) {
        const maxLen = channelRef.id === 'telegram' ? 4096 : 2000;
        streamer = new ResponseStreamer(
          {
            enabled: true,
            minChunkSize: streamingCfg?.minChunkSize ?? 50,
            flushIntervalMs: streamingCfg?.flushIntervalMs ?? 500,
            maxMessageLength: maxLen,
          },
          { channelId: channelTarget, channel: channelRef },
        );
      }

      // Collect chunks — only yield text to caller on final turn (no tool calls)
      const chunks: string[] = [];
      try {
        for await (const chunk of provider.chat({
          model,
          messages: sanitized,
          tools: tools.length > 0 ? tools : undefined,
          stream: true,
          ...(this.config.maxTokens != null && { max_tokens: this.config.maxTokens }),
        })) {
          if (chunk.text) {
            fullText += chunk.text;
            chunks.push(chunk.text);
            // Push to streamer for real-time delivery
            if (streamer) {
              await streamer.push(chunk.text);
            }
          }
          if (chunk.tool_calls) {
            pendingToolCalls.push(...chunk.tool_calls);
          }
          if (chunk.done && chunk.usage) {
            lastUsage = chunk.usage;
          }
        }
      } catch (err) {
        // Cancel streamer on error
        if (streamer) await streamer.cancel();

        const errMsg = err instanceof Error ? err.message : String(err);
        const isContextOverflow = /prompt is too long|too many tokens|maximum.*tokens|context length/i.test(errMsg);

        // Emergency compaction: if provider rejects due to context overflow,
        // compact immediately and retry this turn once.
        if (isContextOverflow && this.deps.compactor && !emergencyCompacted) {
          emergencyCompacted = true;
          console.warn(`[compaction] Emergency compaction triggered for session ${session.id}: ${errMsg.slice(0, 160)}`);
          try {
            await this.deps.compactor.compact(session, 12);
            // Rebuild conversation with compacted session and retry.
            messages.length = 0;
            messages.push({ role: 'system', content: systemPrompt }, ...session.messages);
            continue;
          } catch (compactErr) {
            console.error('[compaction] Emergency compaction failed:', compactErr instanceof Error ? compactErr.message : compactErr);
          }
        }

        // All model providers failed — enqueue for retry if available
        if (this.deps.retryQueue) {
          this.deps.retryQueue.enqueue({
            userMessage,
            sessionId: session.id,
            channelId: session.metadata?.channelId as string | undefined,
            messageId: session.metadata?.messageId as string | undefined,
            channel: session.metadata?.channelRef as import('../channels/channel.js').Channel | undefined,
          });
        }
        this.deps.typingManager?.stop(chatId);
        // Transition reaction to failed
        if (this.deps.reactionManager && this.deps.channel && messageId) {
          await this.deps.reactionManager.transition(this.deps.channel, chatId, messageId, 'processing', 'failed');
        }
        throw err;
      }

      // Finish streaming for this turn (flush remaining buffer)
      if (streamer) {
        await streamer.finish();
      }

      // Record usage for this turn
      if (this.deps.usageTracker && lastUsage) {
        const cachedTokens = (lastUsage.cache_read_input_tokens ?? 0);
        this.deps.usageTracker.record({
          sessionId: session.id,
          model,
          provider: model.includes('/') ? model.split('/')[0] : 'unknown',
          timestamp: Date.now(),
          inputTokens: lastUsage.prompt_tokens,
          outputTokens: lastUsage.completion_tokens,
          cachedTokens,
          totalTokens: lastUsage.total_tokens,
          durationMs: Date.now() - turnStartMs,
        });
      }

      // Scan model output for secrets before yielding
      if (fullText) {
        const scannedText = scanSecrets(fullText);
        if (scannedText !== fullText) {
          // Rebuild chunks from scanned text
          chunks.length = 0;
          chunks.push(scannedText);
          fullText = scannedText;
        }
      }

      // Only yield text from the final turn (no pending tool calls).
      // Intermediate turns often repeat the same intro text before each tool call,
      // which clutters the output. The final turn has the actual response.
      if (pendingToolCalls.length === 0 && !fullText && turns > 1) {
        // Final turn after tool calls produced no text — yield a minimal acknowledgment
        // so the user isn't left with silence.
        console.warn(`[agent-loop] Turn ${turns}: no text after tool calls (${chunks.length} chunks, fullText empty)`);
        if (!streamer) yield '✅ Done.';
      }
      if (pendingToolCalls.length === 0 && !streamer) {
        let emitted = 0;
        for (const c of chunks) {
          const remaining = this.config.maxOutputChars - emitted;
          if (remaining <= 0) {
            yield '\n\n[Output truncated — response exceeded character limit]';
            break;
          }
          const accepted = c.length <= remaining ? c : c.slice(0, remaining);
          yield accepted;
          emitted += accepted.length;
          if (accepted.length < c.length) {
            yield '\n\n[Output truncated — response exceeded character limit]';
            break;
          }
        }
      }

      // Append assistant message to session history.
      // For intermediate turns (with tool calls), strip the preamble text to prevent
      // context pollution — the model sees its own repeated intros and reinforces them.
      // Only keep tool_use blocks in intermediate turns; final turn keeps full text.
      if (fullText || pendingToolCalls.length > 0) {
        const contentParts: ContentPart[] = [];
        if (pendingToolCalls.length > 0) {
          // Intermediate turn: replace verbose preamble with a short marker.
          // This prevents the model from seeing N copies of "I'll help you..." in context.
          contentParts.push({ type: 'text', text: '[Calling tools]' });
        } else if (fullText) {
          contentParts.push({ type: 'text', text: fullText });
        }
        for (const tc of pendingToolCalls) {
          contentParts.push({ type: 'tool_use', id: tc.id, name: tc.name, input: tc.input });
        }
        const assistantMsg: ChatMessage = {
          role: 'assistant',
          content: pendingToolCalls.length > 0 ? contentParts : fullText,
        };
        session.messages.push(assistantMsg);
        messages.push(assistantMsg);
      }

      if (pendingToolCalls.length === 0) break;

      // Execute tool calls
      const executionContext = session.metadata?.executionContext as import('./execution-context.js').ExecutionContext | undefined;
      const roleName = (
        typeof executionContext?.metadata?.['effectiveAgentRole'] === 'string'
          ? String(executionContext.metadata['effectiveAgentRole'])
          : this.deps.agentRole
      ) ?? 'admin';
      const role = getRole(roleName);
      const allowedToolRoot = executionContext?.allowedToolRoot
        ?? executionContext?.projectRoot
        ?? this.deps.workspaceRoot
        ?? process.cwd();
      const toolCtx: ToolContext = {
        sessionId: session.id,
        workDir: allowedToolRoot,
        workspaceRoot: this.deps.workspaceRoot ?? process.cwd(),
        allowedToolRoot,
        agentId: this.deps.agentId,
        agentRole: roleName,
        channelType: session.metadata?.channelType as string | undefined,
        channelTarget: session.metadata?.channelTarget as string | undefined,
        channel: session.metadata?.channelRef as unknown,
        executionContext,
      };

      for (const tc of pendingToolCalls) {
        let approvedSharedAccessId: string | undefined;
        // Check for tool loops before execution
        if (this.deps.toolLoopDetector) {
          const loopWarning = this.deps.toolLoopDetector.recordAndCheck(
            session.id,
            tc.name,
            (tc.input ?? {}) as Record<string, unknown>,
          );
          if (loopWarning) {
            const loopMsg: ChatMessage = { role: 'system', content: loopWarning };
            session.messages.push(loopMsg);
            messages.push(loopMsg);

            const toolMsg: ChatMessage = {
              role: 'tool',
              content: loopWarning,
              tool_call_id: tc.id,
            };
            session.messages.push(toolMsg);
            messages.push(toolMsg);
            continue;
          }
        }

        // Check role-based permissions before execution
        if (role && !isToolAllowed(role, tc.name)) {
          const override = this.deps.handleSharedAccessToolAuthorization
            ? await this.deps.handleSharedAccessToolAuthorization({
                session,
                toolCall: tc,
                roleName,
                userMessage,
                executionContext,
                channel: session.metadata?.channelRef as Channel | undefined,
              })
            : null;
          if (override?.allow) {
            approvedSharedAccessId = override.approvalId;
          } else {
            const deniedResult: ToolResult = override?.toolResult ?? {
              output: `Permission denied: agent role "${roleName}" cannot use tool "${tc.name}"`,
              success: false,
            };

            if (hooks) {
              await hooks.emit('after_tool_call', {
                event: 'after_tool_call',
                sessionId: session.id,
                data: {
                  toolName: tc.name,
                  params: tc.input,
                  result: deniedResult,
                  agentId: this.deps.agentId,
                  principalId: session.metadata?.principalId,
                  principalName: session.metadata?.principalName,
                  projectId: session.metadata?.projectId,
                  projectSlug: session.metadata?.projectSlug,
                  sharedSessionId: session.metadata?.sharedSessionId,
                  participantIds: session.metadata?.participantIds,
                  denied: true,
                  denialType: override?.approvalId ? 'shared_task_approval' : 'role',
                  peerApprovalId: override?.approvalId,
                },
                timestamp: Date.now(),
              });
            }

            const toolMsg: ChatMessage = {
              role: 'tool',
              content: deniedResult.output,
              tool_call_id: tc.id,
            };
            session.messages.push(toolMsg);
            messages.push(toolMsg);
            continue;
          }
        }
        if (hooks) {
          await hooks.emit('before_tool_call', {
            event: 'before_tool_call',
            sessionId: session.id,
            data: {
              toolName: tc.name,
              params: tc.input,
              agentId: this.deps.agentId,
              principalId: session.metadata?.principalId,
              principalName: session.metadata?.principalName,
              projectId: session.metadata?.projectId,
              projectSlug: session.metadata?.projectSlug,
              sharedSessionId: session.metadata?.sharedSessionId,
              participantIds: session.metadata?.participantIds,
              peerApprovalId: approvedSharedAccessId,
            },
            timestamp: Date.now(),
          });
        }

        // Validate tool arguments before execution
        const validator = getToolValidator();
        if (validator && tc.input && typeof tc.input === 'object') {
          const input = tc.input as Record<string, unknown>;
          // Validate path arguments
          if (typeof input.path === 'string') {
            const pathCheck = validator.validatePathWithinRoot(
              input.path, toolCtx.workDir,
              ['write', 'edit', 'apply_patch'].includes(tc.name),
              allowedToolRoot,
            );
            if (!pathCheck.allowed) {
              const deniedResult: ToolResult = {
                output: `Blocked: ${pathCheck.blockReason}`,
                success: false,
                error: pathCheck.blockReason,
              };
              if (hooks) {
                await hooks.emit('after_tool_call', {
                  event: 'after_tool_call',
                  sessionId: session.id,
                  data: {
                    toolName: tc.name,
                    params: tc.input,
                    result: deniedResult,
                    denied: true,
                    denialType: 'path',
                    allowedToolRoot,
                    attemptedPath: input.path,
                    agentId: this.deps.agentId,
                    principalId: session.metadata?.principalId,
                    principalName: session.metadata?.principalName,
                    projectId: session.metadata?.projectId,
                    projectSlug: session.metadata?.projectSlug,
                    sharedSessionId: session.metadata?.sharedSessionId,
                    participantIds: session.metadata?.participantIds,
                  },
                  timestamp: Date.now(),
                });
              }
              const toolMsg: ChatMessage = {
                role: 'tool',
                content: `Blocked: ${pathCheck.blockReason}`,
                tool_call_id: tc.id,
              };
              session.messages.push(toolMsg);
              messages.push(toolMsg);
              continue;
            }
          }
          // Validate command arguments
          if (typeof input.command === 'string' && ['exec', 'process'].includes(tc.name)) {
            const cmdCheck = validator.validateCommandWithinRoot(input.command, allowedToolRoot);
            if (!cmdCheck.allowed) {
              const deniedResult: ToolResult = {
                output: `Blocked: ${cmdCheck.blockReason}`,
                success: false,
                error: cmdCheck.blockReason,
              };
              if (hooks) {
                await hooks.emit('after_tool_call', {
                  event: 'after_tool_call',
                  sessionId: session.id,
                  data: {
                    toolName: tc.name,
                    params: tc.input,
                    result: deniedResult,
                    denied: true,
                    denialType: 'command',
                    allowedToolRoot,
                    agentId: this.deps.agentId,
                    principalId: session.metadata?.principalId,
                    principalName: session.metadata?.principalName,
                    projectId: session.metadata?.projectId,
                    projectSlug: session.metadata?.projectSlug,
                    sharedSessionId: session.metadata?.sharedSessionId,
                    participantIds: session.metadata?.participantIds,
                  },
                  timestamp: Date.now(),
                });
              }
              const toolMsg: ChatMessage = {
                role: 'tool',
                content: `Blocked: ${cmdCheck.blockReason}`,
                tool_call_id: tc.id,
              };
              session.messages.push(toolMsg);
              messages.push(toolMsg);
              continue;
            }
          }
          // Validate URL arguments
          if (typeof input.url === 'string' && ['web_fetch', 'browser_navigate'].includes(tc.name)) {
            const urlCheck = validator.validateUrl(input.url);
            if (!urlCheck.allowed) {
              const toolMsg: ChatMessage = {
                role: 'tool',
                content: `Blocked: ${urlCheck.blockReason}`,
                tool_call_id: tc.id,
              };
              session.messages.push(toolMsg);
              messages.push(toolMsg);
              continue;
            }
          }
        }

        const tool = toolRegistry.getTool(tc.name);
        let result: ToolResult;
        const defaultTimeoutMs = this.config.toolCallTimeoutMs ?? 30_000;
        // Long-running tools get extended timeout (ACP sessions, sub-agent spawns)
        const LONG_RUNNING_TOOLS = new Set(['sessions_spawn', 'acp_spawn', 'acp_session_start', 'acp_session_send']);
        const toolTimeoutMs = LONG_RUNNING_TOOLS.has(tc.name) ? Math.max(defaultTimeoutMs, 120_000) : defaultTimeoutMs;
        try {
          if (tool) {
            // Race the tool against a hard timeout so a single stuck call
            // cannot block the entire agent loop indefinitely.
            result = await Promise.race([
              tool.execute(tc.input, toolCtx),
              new Promise<ToolResult>((_, reject) =>
                setTimeout(
                  () => reject(new Error(`Tool "${tc.name}" timed out after ${toolTimeoutMs}ms`)),
                  toolTimeoutMs,
                ),
              ),
            ]);
          } else {
            result = { output: `Unknown tool: ${tc.name}`, success: false };
          }
        } catch (err) {
          result = {
            output: `Error executing ${tc.name}: ${err instanceof Error ? err.message : String(err)}`,
            success: false,
            error: err instanceof Error ? err.message : String(err),
          };
        }

        if (hooks) {
          await hooks.emit('after_tool_call', {
            event: 'after_tool_call',
            sessionId: session.id,
            data: {
              toolName: tc.name,
              params: tc.input,
              result,
              agentId: this.deps.agentId,
              principalId: session.metadata?.principalId,
              principalName: session.metadata?.principalName,
              projectId: session.metadata?.projectId,
              projectSlug: session.metadata?.projectSlug,
              sharedSessionId: session.metadata?.sharedSessionId,
              participantIds: session.metadata?.participantIds,
              peerApprovalId: approvedSharedAccessId,
            },
            timestamp: Date.now(),
          });
        }

        const toolOutput = this.truncateToolResult(result.output);

        // Detect "[Tool result missing]" pattern — stalled execution environment.
        // After N consecutive missing results, bail out of the tool loop entirely.
        if (this.deps.toolLoopDetector && toolOutput.includes('[Tool result missing]')) {
          const bailWarning = this.deps.toolLoopDetector.recordMissingResult(session.id, tc.name);
          if (bailWarning) {
            const toolMsg: ChatMessage = {
              role: 'tool',
              content: toolOutput,
              tool_call_id: tc.id,
            };
            session.messages.push(toolMsg);
            messages.push(toolMsg);

            const warnMsg: ChatMessage = { role: 'system', content: bailWarning };
            session.messages.push(warnMsg);
            messages.push(warnMsg);

            // Force the loop to end after this tool — push remaining tool results
            // as synthetic missing entries, then break.
            for (const remaining of pendingToolCalls.slice(pendingToolCalls.indexOf(tc) + 1)) {
              session.messages.push({
                role: 'tool',
                content: '[Tool result missing — execution aborted due to stall]',
                tool_call_id: remaining.id,
              });
            }
            pendingToolCalls = [];
            break;
          }
        }

        const toolMsg: ChatMessage = {
          role: 'tool',
          content: toolOutput,
          tool_call_id: tc.id,
        };
        session.messages.push(toolMsg);
        messages.push(toolMsg);
      }

      pendingToolCalls = [];
    }

      // Stop typing indicator
      this.deps.typingManager?.stop(chatId);

      // Transition reaction to completed
      if (this.deps.reactionManager && this.deps.channel && messageId) {
        await this.deps.reactionManager.transition(this.deps.channel, chatId, messageId, 'processing', 'completed');
      }

      // Clear tool loop history for this session turn
      this.deps.toolLoopDetector?.clearSession(session.id);

      if (hooks) {
        await hooks.emit('agent_end', {
          event: 'agent_end',
          sessionId: session.id,
          data: {
            turns,
            agentId: this.deps.agentId,
            model: this.getModel(),
            principalId: session.metadata?.principalId,
            principalName: session.metadata?.principalName,
            projectId: session.metadata?.projectId,
            projectSlug: session.metadata?.projectSlug,
            sharedSessionId: session.metadata?.sharedSessionId,
            participantIds: session.metadata?.participantIds,
          },
          timestamp: Date.now(),
        });
      }
    } catch (err) {
      // A failed turn must not leave partial tool traces or duplicated user messages
      // in session history. Later retries/new questions should see only committed turns.
      session.messages = baselineMessages;
      session.lastActiveAt = baselineLastActiveAt;
      this.deps.toolLoopDetector?.clearSession(session.id);
      throw err;
    } finally {
      // Safety: always clear typing interval even if any unexpected error escapes.
      this.deps.typingManager?.stop(chatId);
    }
  }
}
