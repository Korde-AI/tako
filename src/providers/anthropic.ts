/**
 * Anthropic provider — native Anthropic API adapter.
 *
 * Uses @anthropic-ai/sdk with real streaming support.
 * Yields ChatChunks as text deltas arrive from the API.
 */

import Anthropic from '@anthropic-ai/sdk';
import type {
  MessageParam,
  TextBlockParam,
  ImageBlockParam,
  ToolUseBlockParam,
  ToolResultBlockParam,
  RawMessageStreamEvent,
} from '@anthropic-ai/sdk/resources/messages.js';
import type {
  Provider,
  ChatRequest,
  ChatChunk,
  ChatMessage,
  ModelInfo,
  ToolDefinition,
} from './provider.js';
import {
  resolveAuth,
  readAuthCredential,
  refreshOAuthToken,
  isTokenNearExpiry,
  type ResolvedAuth,
  type OAuthCredential,
} from '../auth/storage.js';
import { PromptCacheManager, type PromptCacheConfig } from './prompt-cache.js';

/**
 * A text block with optional cache_control for prompt caching.
 * The Anthropic API accepts this at runtime even though the SDK
 * types don't expose it on the non-beta TextBlockParam.
 */
interface CacheableTextBlock {
  type: 'text';
  text: string;
  cache_control?: { type: 'ephemeral' };
}

/** Cumulative cache usage stats across a session. */
export interface CacheStats {
  /** Total tokens written to cache. */
  cacheCreationTokens: number;
  /** Total tokens read from cache. */
  cacheReadTokens: number;
  /** Number of API calls that hit the cache. */
  cacheHits: number;
  /** Number of API calls that missed the cache. */
  cacheMisses: number;
}

export class AnthropicProvider implements Provider {
  id = 'anthropic';
  private apiKeys: string[];
  private authResolved = false;
  /** When set, the resolved auth is a Bearer token (setup_token / oauth), not an API key. */
  private bearerToken: string | null = null;
  /** Cumulative cache usage stats. */
  private cacheStats: CacheStats = { cacheCreationTokens: 0, cacheReadTokens: 0, cacheHits: 0, cacheMisses: 0 };
  /** Prompt cache manager for standalone cache stat tracking. */
  private promptCacheManager: PromptCacheManager;

  constructor(apiKey?: string, cacheConfig?: Partial<PromptCacheConfig>) {
    this.apiKeys = this.resolveApiKeys(apiKey);
    this.promptCacheManager = new PromptCacheManager(cacheConfig);
  }

  /** Get cumulative prompt cache statistics. */
  getCacheStats(): CacheStats {
    return { ...this.cacheStats };
  }

  /** Get the prompt cache manager for external stat tracking. */
  getPromptCacheManager(): PromptCacheManager {
    return this.promptCacheManager;
  }

  /** Lazily resolve auth — auth file takes priority over env vars. */
  private async ensureAuth(): Promise<void> {
    if (this.authResolved) return;
    this.authResolved = true;

    // Always check auth file first — it's the most intentional config (from onboard/CLI).
    // This overrides any env var keys that may be stale.
    const auth = await resolveAuth('anthropic');
    if (auth) {
      if (this.isOAuthToken(auth.token) || auth.method === 'setup_token' || auth.method === 'oauth') {
        this.bearerToken = auth.token;
        this.apiKeys = []; // Clear env-based keys
        console.log(`[anthropic] Using ${auth.method} auth from ${auth.source}`);
        return;
      }
      // Auth file has a regular API key — use it instead of env
      if (auth.source === 'auth_file') {
        this.apiKeys = [auth.token];
        console.log(`[anthropic] Using API key from auth file`);
        return;
      }
    }

    // Check if any existing key (from env) is actually an OAuth token
    if (this.apiKeys.length > 0 && this.isOAuthToken(this.apiKeys[0])) {
      this.bearerToken = this.apiKeys[0];
      this.apiKeys = [];
      return;
    }

    if (this.apiKeys.length === 0) {
      console.warn('[anthropic] No API key found. Set ANTHROPIC_API_KEY or run `tako models auth login --provider anthropic`.');
    }
  }

  /**
   * Proactively refresh the OAuth token if it's near expiry.
   * Called before each API request when using a bearer token.
   */
  private async proactiveRefresh(): Promise<void> {
    if (!this.bearerToken) return;

    const cred = await readAuthCredential('anthropic');
    if (!cred) return;

    // Only OAuth credentials with expires_at can be proactively refreshed
    if (cred.auth_method === 'oauth' && cred.expires_at && isTokenNearExpiry(cred)) {
      console.log('[anthropic] Token near expiry, proactively refreshing...');
      const refreshed = await refreshOAuthToken('anthropic');
      if (refreshed) {
        this.bearerToken = refreshed.access_token;
      }
    }
  }

  /**
   * Attempt to recover from an auth error by refreshing the OAuth token
   * or falling back to env var API keys.
   * Returns true if a new credential was obtained and the request should be retried.
   */
  private async tryRecoverAuth(err: unknown): Promise<boolean> {
    if (!this.isAuthError(err)) return false;

    // 1. Try refreshing the OAuth token
    if (this.bearerToken) {
      console.warn('[anthropic] Auth error with OAuth token, attempting refresh...');
      const refreshed = await refreshOAuthToken('anthropic');
      if (refreshed) {
        this.bearerToken = refreshed.access_token;
        return true;
      }

      // 2. Refresh failed — fall back to env var keys
      const envKeys = this.resolveApiKeys();
      if (envKeys.length > 0 && !this.isOAuthToken(envKeys[0])) {
        console.warn('[anthropic] OAuth token invalid, falling back to env API key');
        this.bearerToken = null;
        this.apiKeys = envKeys;
        return true;
      }

      console.error(
        '[anthropic] OAuth token expired/revoked and no fallback API key available.\n' +
        '            Run `tako models auth login --provider anthropic` to re-authenticate.',
      );
    }

    return false;
  }

  /** Check if an error is an authentication/authorization error. */
  private isAuthError(err: unknown): boolean {
    if (!err || typeof err !== 'object') return false;
    const status = (err as { status?: number }).status;
    if (status === 401 || status === 403) return true;
    // Anthropic returns 400 with "invalid_request_error" for revoked tokens
    if (status === 400) {
      const msg = String((err as { message?: string }).message ?? '').toLowerCase();
      return msg.includes('invalid') || msg.includes('authentication') || msg.includes('unauthorized');
    }
    return false;
  }

  /**
   * Resolve API keys with rotation support.
   * Priority: explicit key > OPENCLAW_LIVE_ANTHROPIC_KEY > ANTHROPIC_API_KEYS > ANTHROPIC_API_KEY
   */
  private resolveApiKeys(explicit?: string): string[] {
    if (explicit) return [explicit];

    const keys: string[] = [];
    const seen = new Set<string>();
    const add = (k: string) => {
      const trimmed = k.trim();
      if (trimmed && !seen.has(trimmed)) {
        seen.add(trimmed);
        keys.push(trimmed);
      }
    };

    // Highest priority: live override
    if (process.env.OPENCLAW_LIVE_ANTHROPIC_KEY) {
      add(process.env.OPENCLAW_LIVE_ANTHROPIC_KEY);
    }

    // Comma/semicolon-separated key list
    if (process.env.ANTHROPIC_API_KEYS) {
      for (const k of process.env.ANTHROPIC_API_KEYS.split(/[,;]/)) {
        add(k);
      }
    }

    // Primary key
    if (process.env.ANTHROPIC_API_KEY) {
      add(process.env.ANTHROPIC_API_KEY);
    }

    // Numbered keys (ANTHROPIC_API_KEY_1, ANTHROPIC_API_KEY_2, ...)
    for (let i = 1; i <= 10; i++) {
      const val = process.env[`ANTHROPIC_API_KEY_${i}`];
      if (val) add(val);
    }

    return keys;
  }

  /**
   * Detect if a key is an OAuth/setup token (sk-ant-oat prefix).
   * These tokens require Bearer auth + special headers, matching
   * the pi-ai Anthropic provider pattern used by reference runtime.
   */
  private isOAuthToken(key: string): boolean {
    return key.includes('sk-ant-oat');
  }

  private createClient(apiKey: string): Anthropic {
    if (this.isOAuthToken(apiKey)) {
      // OAuth/setup tokens use Bearer auth with Claude Code identity headers.
      // This matches exactly how @mariozechner/pi-ai providers/anthropic.js
      // handles these tokens in reference runtime.
      return new Anthropic({
        apiKey: null as unknown as string,
        authToken: apiKey,
        dangerouslyAllowBrowser: true,
        defaultHeaders: {
          'accept': 'application/json',
          'anthropic-dangerous-direct-browser-access': 'true',
          'anthropic-beta': 'claude-code-20250219,oauth-2025-04-20,fine-grained-tool-streaming-2025-05-14',
          'user-agent': 'tako/0.0.1',
          'x-app': 'cli',
        },
      });
    }
    return new Anthropic({ apiKey });
  }

  /**
   * Extract the model ID from a "provider/model" ref.
   * e.g. "anthropic/claude-opus-4-6" -> "claude-opus-4-6"
   */
  private extractModelId(model: string): string {
    const slash = model.indexOf('/');
    return slash >= 0 ? model.slice(slash + 1) : model;
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
    await this.ensureAuth();

    const model = this.extractModelId(req.model);
    const { system, messages } = this.convertMessages(req.messages);
    const tools = req.tools?.map((t) => this.convertTool(t));
    const cacheRetention = req.cacheRetention ?? 'none';

    // Build system param: string or array with cache_control
    const systemParam = this.buildSystemParam(system, cacheRetention);

    // Inject cache_control on conversation prefix in 'long' mode
    if (cacheRetention === 'long') {
      this.injectConversationCacheBreakpoints(messages);
    }

    // Bearer token path (setup_token / oauth) — single token, no rotation
    if (this.bearerToken) {
      // Proactively refresh if near expiry
      await this.proactiveRefresh();

      const client = this.createClient(this.bearerToken);
      try {
        if (req.stream !== false) {
          yield* this.chatStreaming(client, model, systemParam, messages, tools, req);
        } else {
          yield* this.chatNonStreaming(client, model, systemParam, messages, tools, req);
        }
        return;
      } catch (err: unknown) {
        // Reactive: try refreshing/falling back on auth errors, then retry once
        const recovered = await this.tryRecoverAuth(err);
        if (recovered) {
          const retryToken = this.bearerToken ?? this.apiKeys[0];
          if (retryToken) {
            const retryClient = this.createClient(retryToken);
            try {
              if (req.stream !== false) {
                yield* this.chatStreaming(retryClient, model, systemParam, messages, tools, req);
              } else {
                yield* this.chatNonStreaming(retryClient, model, systemParam, messages, tools, req);
              }
              return;
            } catch (retryErr: unknown) {
              throw this.wrapAuthError(retryErr);
            }
          }
        }
        throw this.wrapAuthError(err);
      }
    }

    // Try each API key; rotate only on rate-limit errors
    const keys = this.apiKeys.length > 0 ? this.apiKeys : [''];
    let lastError: unknown;

    for (const key of keys) {
      try {
        const client = this.createClient(key);
        if (req.stream !== false) {
          yield* this.chatStreaming(client, model, systemParam, messages, tools, req);
        } else {
          yield* this.chatNonStreaming(client, model, systemParam, messages, tools, req);
        }
        return; // success
      } catch (err: unknown) {
        lastError = err;
        if (this.isRateLimitError(err) && keys.length > 1) {
          console.warn(`[anthropic] Rate-limited on key ...${key.slice(-4)}, trying next key`);
          continue;
        }
        // Non-rate-limit errors fail immediately
        throw this.wrapAuthError(err);
      }
    }

    throw this.wrapAuthError(lastError);
  }

  /**
   * Build the system parameter for the API call.
   * When caching is enabled, returns an array of text blocks with cache_control
   * on the last block. When disabled, returns the plain string.
   */
  private buildSystemParam(
    system: string,
    cacheRetention: 'none' | 'short' | 'long',
  ): string | CacheableTextBlock[] {
    if (!system || cacheRetention === 'none') {
      return system;
    }

    // Split into blocks and mark the last one as cacheable.
    // The cache key is based on exact content match up to the
    // cache_control breakpoint, so placing it at the end of the
    // system prompt caches the entire system prompt.
    return [{
      type: 'text' as const,
      text: system,
      cache_control: { type: 'ephemeral' as const },
    }];
  }

  /**
   * Inject cache_control breakpoints on conversation prefix (long mode).
   * Marks the last user message in the history as a cache breakpoint,
   * so the conversation prefix up to that point is cached.
   */
  private injectConversationCacheBreakpoints(messages: MessageParam[]): void {
    // Find the last user message and mark its last content block as cacheable
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role !== 'user') continue;

      if (typeof msg.content === 'string') {
        // Convert to array form so we can add cache_control
        msg.content = [{
          type: 'text' as const,
          text: msg.content,
          cache_control: { type: 'ephemeral' as const },
        }] as unknown as Array<TextBlockParam>;
      } else if (Array.isArray(msg.content) && msg.content.length > 0) {
        const lastBlock = msg.content[msg.content.length - 1];
        if (lastBlock.type === 'text' || lastBlock.type === 'tool_result') {
          (lastBlock as unknown as { cache_control?: { type: string } }).cache_control = { type: 'ephemeral' };
        }
      }
      break;
    }
  }

  private isRateLimitError(err: unknown): boolean {
    if (err && typeof err === 'object') {
      const status = (err as { status?: number }).status;
      if (status === 429) return true;
      const msg = String((err as { message?: string }).message ?? '').toLowerCase();
      if (msg.includes('rate_limit') || msg.includes('quota') || msg.includes('resource exhausted')) {
        return true;
      }
    }
    return false;
  }

  private wrapAuthError(err: unknown): Error {
    if (err && typeof err === 'object') {
      const status = (err as { status?: number }).status;
      if (status === 401 || status === 403) {
        const hint = this.bearerToken
          ? 'Setup token may be expired or invalid. Run `tako models auth login --provider anthropic` to refresh.'
          : 'Check your ANTHROPIC_API_KEY or run `tako models auth login --provider anthropic`.';
        return new Error(
          `[anthropic] Authentication failed (HTTP ${status}). ${hint}`,
          { cause: err },
        );
      }
    }
    if (err instanceof Error) return err;
    return new Error(String(err));
  }

  private async *chatStreaming(
    client: Anthropic,
    model: string,
    system: string | CacheableTextBlock[],
    messages: MessageParam[],
    tools: Anthropic.Tool[] | undefined,
    req: ChatRequest,
  ): AsyncIterable<ChatChunk> {
    // Build system param — use array form for cache_control, string/undefined otherwise
    const systemValue = Array.isArray(system)
      ? system as unknown as Array<TextBlockParam>
      : (system || undefined);

    const stream = await client.messages.create({
      model,
      max_tokens: req.max_tokens ?? 16_384,
      system: systemValue,
      messages,
      tools: tools && tools.length > 0 ? tools : undefined,
      temperature: req.temperature,
      stop_sequences: req.stop,
      stream: true,
    });

    // Track tool calls being built incrementally
    const toolCalls: { id: string; name: string; inputJson: string }[] = [];
    let currentToolIndex = -1;
    let inputTokens = 0;
    let outputTokens = 0;
    let cacheCreationTokens = 0;
    let cacheReadTokens = 0;

    for await (const event of stream as AsyncIterable<RawMessageStreamEvent>) {
      switch (event.type) {
        case 'message_start': {
          if (event.message.usage) {
            inputTokens = event.message.usage.input_tokens;
            // Extract cache metrics from the usage object (present when caching is active)
            const usage = event.message.usage as unknown as Record<string, unknown>;
            cacheCreationTokens = (usage.cache_creation_input_tokens as number) ?? 0;
            cacheReadTokens = (usage.cache_read_input_tokens as number) ?? 0;
          }
          break;
        }

        case 'content_block_start': {
          if (event.content_block.type === 'tool_use') {
            currentToolIndex = toolCalls.length;
            toolCalls.push({
              id: event.content_block.id,
              name: event.content_block.name,
              inputJson: '',
            });
          }
          break;
        }

        case 'content_block_delta': {
          if (event.delta.type === 'text_delta') {
            yield { text: event.delta.text, done: false };
          } else if (event.delta.type === 'input_json_delta' && currentToolIndex >= 0) {
            toolCalls[currentToolIndex].inputJson += event.delta.partial_json;
          }
          break;
        }

        case 'content_block_stop': {
          if (currentToolIndex >= 0) {
            currentToolIndex = -1;
          }
          break;
        }

        case 'message_delta': {
          if (event.usage) {
            outputTokens = event.usage.output_tokens;
          }
          break;
        }

        case 'message_stop': {
          // Update cumulative cache stats
          this.updateCacheStats(cacheCreationTokens, cacheReadTokens);

          // Final chunk with any accumulated tool calls
          const parsedToolCalls = toolCalls.map((tc) => ({
            id: tc.id,
            name: tc.name,
            input: tc.inputJson ? JSON.parse(tc.inputJson) : {},
          }));

          yield {
            tool_calls: parsedToolCalls.length > 0 ? parsedToolCalls : undefined,
            done: true,
            usage: {
              prompt_tokens: inputTokens,
              completion_tokens: outputTokens,
              total_tokens: inputTokens + outputTokens,
              ...(cacheCreationTokens > 0 ? { cache_creation_input_tokens: cacheCreationTokens } : {}),
              ...(cacheReadTokens > 0 ? { cache_read_input_tokens: cacheReadTokens } : {}),
            },
          };
          break;
        }
      }
    }
  }

  private async *chatNonStreaming(
    client: Anthropic,
    model: string,
    system: string | CacheableTextBlock[],
    messages: MessageParam[],
    tools: Anthropic.Tool[] | undefined,
    req: ChatRequest,
  ): AsyncIterable<ChatChunk> {
    const systemValue = Array.isArray(system)
      ? system as unknown as Array<TextBlockParam>
      : (system || undefined);

    const response = await client.messages.create({
      model,
      max_tokens: req.max_tokens ?? 16_384,
      system: systemValue,
      messages,
      tools: tools && tools.length > 0 ? tools : undefined,
      temperature: req.temperature,
      stop_sequences: req.stop,
    });

    let text = '';
    const toolCalls: { id: string; name: string; input: unknown }[] = [];

    for (const block of response.content) {
      if (block.type === 'text') {
        text += block.text;
      } else if (block.type === 'tool_use') {
        toolCalls.push({ id: block.id, name: block.name, input: block.input });
      }
    }

    // Extract cache metrics
    const usage = response.usage as unknown as Record<string, unknown>;
    const cacheCreationTokens = (usage.cache_creation_input_tokens as number) ?? 0;
    const cacheReadTokens = (usage.cache_read_input_tokens as number) ?? 0;
    this.updateCacheStats(cacheCreationTokens, cacheReadTokens);

    yield {
      text: text || undefined,
      tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
      done: true,
      usage: {
        prompt_tokens: response.usage.input_tokens,
        completion_tokens: response.usage.output_tokens,
        total_tokens: response.usage.input_tokens + response.usage.output_tokens,
        ...(cacheCreationTokens > 0 ? { cache_creation_input_tokens: cacheCreationTokens } : {}),
        ...(cacheReadTokens > 0 ? { cache_read_input_tokens: cacheReadTokens } : {}),
      },
    };
  }

  /** Update cumulative cache stats and log hit/miss. */
  private updateCacheStats(creation: number, read: number): void {
    this.cacheStats.cacheCreationTokens += creation;
    this.cacheStats.cacheReadTokens += read;
    if (read > 0) {
      this.cacheStats.cacheHits++;
    } else if (creation > 0) {
      this.cacheStats.cacheMisses++;
    }

    // Also update the PromptCacheManager stats
    this.promptCacheManager.updateStats({
      cache_creation_input_tokens: creation,
      cache_read_input_tokens: read,
    });

    if (creation > 0 || read > 0) {
      const total = this.cacheStats.cacheHits + this.cacheStats.cacheMisses;
      const hitRate = total > 0 ? ((this.cacheStats.cacheHits / total) * 100).toFixed(0) : '0';
      console.log(
        `[anthropic:cache] ${read > 0 ? 'HIT' : 'MISS'} — ` +
        `created: ${creation}, read: ${read} tokens ` +
        `(session hit rate: ${hitRate}%, total saved: ${this.cacheStats.cacheReadTokens} tokens)`,
      );
    }
  }

  models(): ModelInfo[] {
    return [
      {
        id: 'claude-opus-4-6',
        name: 'Claude Opus 4.6',
        provider: 'anthropic',
        context_window: 200_000,
        max_output_tokens: 32_000,
        capabilities: ['text', 'vision', 'tools', 'streaming'],
      },
      {
        id: 'claude-sonnet-4-6',
        name: 'Claude Sonnet 4.6',
        provider: 'anthropic',
        context_window: 200_000,
        max_output_tokens: 16_384,
        capabilities: ['text', 'vision', 'tools', 'streaming'],
      },
      {
        id: 'claude-haiku-4-5',
        name: 'Claude Haiku 4.5',
        provider: 'anthropic',
        context_window: 200_000,
        max_output_tokens: 8_192,
        capabilities: ['text', 'vision', 'tools', 'streaming'],
      },
    ];
  }

  supports(capability: string): boolean {
    return ['text', 'vision', 'tools', 'streaming'].includes(capability);
  }

  /**
   * Convert Tako's ChatMessage[] to Anthropic's format.
   * Extracts system messages, converts tool messages to tool_result blocks.
   */
  private convertMessages(msgs: ChatMessage[]): {
    system: string;
    messages: MessageParam[];
  } {
    let system = '';
    const messages: MessageParam[] = [];

    for (const msg of msgs) {
      if (msg.role === 'system') {
        const text = typeof msg.content === 'string'
          ? msg.content
          : msg.content.filter((p) => p.type === 'text').map((p) => (p as { type: 'text'; text: string }).text).join('\n');
        system += (system ? '\n\n' : '') + text;
        continue;
      }

      if (msg.role === 'tool') {
        // Tool results -> user message with tool_result content block
        const toolResultBlock: ToolResultBlockParam = {
          type: 'tool_result',
          tool_use_id: msg.tool_call_id ?? '',
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
        };
        const prev = messages[messages.length - 1];
        if (prev && prev.role === 'user' && Array.isArray(prev.content)) {
          (prev.content as Array<TextBlockParam | ToolResultBlockParam>).push(toolResultBlock);
        } else {
          messages.push({ role: 'user', content: [toolResultBlock] });
        }
        continue;
      }

      if (msg.role === 'assistant') {
        if (typeof msg.content === 'string') {
          messages.push({ role: 'assistant', content: msg.content });
        } else {
          const blocks: Array<TextBlockParam | ToolUseBlockParam> = [];
          for (const part of msg.content) {
            if (part.type === 'text') {
              blocks.push({ type: 'text', text: part.text });
            } else if (part.type === 'tool_use') {
              blocks.push({ type: 'tool_use', id: part.id, name: part.name, input: part.input });
            }
          }
          messages.push({ role: 'assistant', content: blocks });
        }
        continue;
      }

      if (msg.role === 'user') {
        if (typeof msg.content === 'string') {
          messages.push({ role: 'user', content: msg.content });
        } else {
          const blocks: Array<TextBlockParam | ImageBlockParam> = [];
          for (const part of msg.content) {
            if (part.type === 'text') {
              blocks.push({ type: 'text', text: part.text });
            } else if (part.type === 'image_base64') {
              // Base64-encoded image — native Anthropic format
              const mediaType = part.media_type as ImageBlockParam.Source['media_type'];
              blocks.push({
                type: 'image',
                source: { type: 'base64', media_type: mediaType, data: part.data },
              });
            } else if (part.type === 'document') {
              // PDF document — send as native Anthropic document block
              blocks.push({
                type: 'document',
                source: {
                  type: 'base64',
                  media_type: part.source.media_type,
                  data: part.source.data,
                },
              } as unknown as TextBlockParam);
            } else if (part.type === 'image_url') {
              // Fallback: image_url parts should have been converted to base64
              // in agent-loop, but log a warning if we see one here
              console.warn('[anthropic] Received image_url content part — images should be base64-encoded. Skipping.');
            }
          }
          messages.push({ role: 'user', content: blocks });
        }
        continue;
      }
    }

    // Validate: every assistant tool_use must have a matching tool_result
    // in the immediately following user message. If missing, inject one.
    for (let i = 0; i < messages.length; i++) {
      const msg = messages[i];
      if (msg.role !== 'assistant' || typeof msg.content === 'string') continue;

      const toolUseIds: string[] = [];
      for (const block of msg.content as Array<TextBlockParam | ToolUseBlockParam>) {
        if (block.type === 'tool_use') {
          toolUseIds.push(block.id);
        }
      }
      if (toolUseIds.length === 0) continue;

      // Check next message for tool_result blocks
      const next = messages[i + 1];
      const existingResultIds = new Set<string>();
      if (next && next.role === 'user' && Array.isArray(next.content)) {
        for (const block of next.content as Array<TextBlockParam | ToolResultBlockParam>) {
          if (block.type === 'tool_result') {
            existingResultIds.add(block.tool_use_id);
          }
        }
      }

      // Find missing tool_result blocks
      const missing = toolUseIds.filter((id) => !existingResultIds.has(id));
      if (missing.length > 0) {
        const missingBlocks: ToolResultBlockParam[] = missing.map((id) => ({
          type: 'tool_result' as const,
          tool_use_id: id,
          content: 'Error: tool result was not recorded',
        }));

        if (next && next.role === 'user' && Array.isArray(next.content)) {
          // Append missing results to existing user message
          (next.content as Array<TextBlockParam | ToolResultBlockParam>).push(...missingBlocks);
        } else {
          // Insert a new user message with tool_result blocks
          messages.splice(i + 1, 0, { role: 'user', content: missingBlocks });
        }
      }
    }

    return { system, messages };
  }

  /** Convert a Tako ToolDefinition to an Anthropic Tool. */
  private convertTool(tool: ToolDefinition): Anthropic.Tool {
    return {
      name: tool.name,
      description: tool.description,
      input_schema: {
        type: 'object' as const,
        ...(tool.parameters as Record<string, unknown>),
      },
    };
  }
}
