/**
 * LiteLLM provider — universal proxy adapter.
 *
 * Connects to a LiteLLM proxy server and uses its OpenAI-compatible API.
 * Supports streaming via SSE and tool calling.
 */

import type {
  Provider,
  ChatRequest,
  ChatChunk,
  ChatMessage,
  ModelInfo,
  ToolCall,
  ToolDefinition,
} from './provider.js';
import type { LiteLLMConfig } from '../config/schema.js';

export class LiteLLMProvider implements Provider {
  id = 'litellm';
  private baseUrl: string;
  private apiKey: string;
  private modelName: string;
  private cachedModels: ModelInfo[] | null = null;

  constructor(opts?: { baseUrl?: string; apiKey?: string; model?: string }) {
    this.baseUrl = (opts?.baseUrl ?? process.env.LITELLM_BASE_URL ?? 'http://localhost:4000')
      .replace(/\/+$/, '')   // strip trailing slashes
      .replace(/\/v1$/, ''); // strip trailing /v1 — we add it ourselves
    this.apiKey = opts?.apiKey ?? process.env.LITELLM_API_KEY ?? '';
    this.modelName = opts?.model ?? 'default';
  }

  static fromConfig(config: LiteLLMConfig): LiteLLMProvider {
    return new LiteLLMProvider({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
    });
  }

  private extractModelId(model: string): string {
    const slash = model.indexOf('/');
    const extracted = slash >= 0 ? model.slice(slash + 1) : model;
    return extracted === 'default' ? this.modelName : extracted;
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
    const model = this.extractModelId(req.model);
    const messages = this.convertMessages(req.messages);

    // Ensure conversation doesn't end with assistant message (some proxies reject this)
    while (messages.length > 0 && messages[messages.length - 1].role === 'assistant') {
      messages.pop();
    }

    const tools = req.tools?.map((t) => this.convertTool(t));
    const shouldStream = req.stream !== false;

    const body: Record<string, unknown> = {
      model,
      messages,
      stream: shouldStream,
      ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      ...(req.max_tokens !== undefined ? { max_tokens: req.max_tokens } : {}),
      ...(req.stop ? { stop: req.stop } : {}),
      ...(tools && tools.length > 0 ? { tools, tool_choice: 'auto' } : {}),
    };

    if (shouldStream) {
      body.stream_options = { include_usage: true };
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.apiKey) {
      headers['Authorization'] = `Bearer ${this.apiKey}`;
    }

    // Debug: log message roles being sent
    if (process.env.TAKO_DEBUG) {
      const roles = messages.map((m) => m.role);
      console.error(`[litellm:debug] Sending ${roles.length} messages: [${roles.join(', ')}] to model=${model}`);
    }

    // Retry once on 400 errors (some proxies fail transiently on first request)
    let res: Response | null = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });

      if (res.ok) break;

      if (res.status === 400 && attempt === 0) {
        const errBody = await res.text();
        console.error(`[litellm] Retrying after 400 error (attempt ${attempt + 1}): ${errBody.slice(0, 120)}`);
        await new Promise((r) => setTimeout(r, 500));
        continue;
      }

      const errBody = await res.text();
      throw new Error(`[litellm] Proxy error (${res.status}): ${errBody}`);
    }

    if (!res || !res.ok) {
      throw new Error('[litellm] All retry attempts failed');
    }

    if (shouldStream) {
      yield* this.parseSSEStream(res);
    } else {
      const data = await res.json() as LiteLLMChatResponse;
      const choice = data.choices?.[0];
      const msg = choice?.message;

      const toolCalls: ToolCall[] = (msg?.tool_calls ?? []).map((tc) => {
        let input: unknown = {};
        try { input = JSON.parse(tc.function.arguments || '{}'); } catch { input = { _raw: tc.function.arguments }; }
        return { id: tc.id, name: tc.function.name, input };
      });

      yield {
        text: msg?.content ?? undefined,
        tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
        done: true,
        usage: data.usage ? {
          prompt_tokens: data.usage.prompt_tokens,
          completion_tokens: data.usage.completion_tokens,
          total_tokens: data.usage.total_tokens,
        } : undefined,
      };
    }
  }

  private async *parseSSEStream(res: Response): AsyncIterable<ChatChunk> {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const toolCallAccum: Map<number, { id: string; name: string; args: string }> = new Map();
    let usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number } | undefined;

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop()!;

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || trimmed === 'data: [DONE]') {
            if (trimmed === 'data: [DONE]') {
              const parsedToolCalls: ToolCall[] = [];
              for (const [, tc] of toolCallAccum) {
                let input: unknown = {};
                try { input = tc.args ? JSON.parse(tc.args) : {}; } catch { input = { _raw: tc.args }; }
                parsedToolCalls.push({ id: tc.id, name: tc.name, input });
              }

              yield {
                tool_calls: parsedToolCalls.length > 0 ? parsedToolCalls : undefined,
                done: true,
                usage,
              };
              return;
            }
            continue;
          }

          if (!trimmed.startsWith('data: ')) continue;
          const jsonStr = trimmed.slice(6);

          let chunk: LiteLLMStreamChunk;
          try {
            chunk = JSON.parse(jsonStr) as LiteLLMStreamChunk;
          } catch {
            continue;
          }

          if (chunk.usage) {
            usage = {
              prompt_tokens: chunk.usage.prompt_tokens,
              completion_tokens: chunk.usage.completion_tokens,
              total_tokens: chunk.usage.total_tokens,
            };
          }

          const delta = chunk.choices?.[0]?.delta;
          if (!delta) continue;

          if (delta.content) {
            yield { text: delta.content, done: false };
          }

          if (delta.tool_calls) {
            for (const tc of delta.tool_calls) {
              const existing = toolCallAccum.get(tc.index);
              if (!existing) {
                toolCallAccum.set(tc.index, {
                  id: tc.id ?? '',
                  name: tc.function?.name ?? '',
                  args: tc.function?.arguments ?? '',
                });
              } else {
                if (tc.id) existing.id = tc.id;
                if (tc.function?.name) existing.name = tc.function.name;
                if (tc.function?.arguments) existing.args += tc.function.arguments;
              }
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Fallback final chunk
    const parsedToolCalls: ToolCall[] = [];
    for (const [, tc] of toolCallAccum) {
      let input: unknown = {};
      if (tc.args) {
        try {
          input = JSON.parse(tc.args);
        } catch (e) {
          console.error(`[litellm] Failed to parse tool args for ${tc.name}: ${(e as Error).message}`);
          console.error(`[litellm] Raw args: ${tc.args.slice(0, 200)}`);
          // Try to salvage by wrapping in object
          try { input = JSON.parse(`{${tc.args}}`); } catch { input = { _raw: tc.args }; }
        }
      }
      parsedToolCalls.push({
        id: tc.id,
        name: tc.name,
        input,
      });
    }

    yield {
      tool_calls: parsedToolCalls.length > 0 ? parsedToolCalls : undefined,
      done: true,
      usage,
    };
  }

  models(): ModelInfo[] {
    if (this.cachedModels) return this.cachedModels;

    return [
      {
        id: this.modelName,
        name: this.modelName,
        provider: 'litellm',
        context_window: 128_000,
        max_output_tokens: 8_192,
        capabilities: ['text', 'tools', 'streaming'],
      },
    ];
  }

  supports(capability: string): boolean {
    return ['text', 'tools', 'streaming'].includes(capability);
  }

  /**
   * Test connection to the LiteLLM proxy.
   * Returns the list of available models or throws on failure.
   */
  async testConnection(): Promise<{ ok: boolean; models?: string[]; error?: string }> {
    try {
      const headers: Record<string, string> = {};
      if (this.apiKey) {
        headers['Authorization'] = `Bearer ${this.apiKey}`;
      }

      const res = await fetch(`${this.baseUrl}/v1/models`, { headers });
      if (!res.ok) {
        return { ok: false, error: `HTTP ${res.status}: ${await res.text()}` };
      }

      const data = await res.json() as { data?: { id: string }[] };
      const modelIds = (data.data ?? []).map((m) => m.id);

      // Cache discovered models
      if (modelIds.length > 0) {
        this.cachedModels = modelIds.map((id) => ({
          id,
          name: id,
          provider: 'litellm',
          context_window: 128_000,
          max_output_tokens: 8_192,
          capabilities: ['text', 'tools', 'streaming'],
        }));
      }

      return { ok: true, models: modelIds };
    } catch (err) {
      return { ok: false, error: `Connection failed: ${(err as Error).message}` };
    }
  }

  private convertMessages(msgs: ChatMessage[]): LiteLLMChatMessage[] {
    const result: LiteLLMChatMessage[] = [];

    for (const msg of msgs) {
      if (msg.role === 'system') {
        const text = msg.content == null
          ? ''
          : typeof msg.content === 'string'
            ? msg.content
            : msg.content.filter((p) => p.type === 'text').map((p) => (p as { type: 'text'; text: string }).text).join('\n');
        result.push({ role: 'system', content: text });
        continue;
      }

      if (msg.role === 'tool') {
        result.push({
          role: 'tool',
          content: msg.content == null
            ? ''
            : typeof msg.content === 'string'
              ? msg.content
              : JSON.stringify(msg.content),
          tool_call_id: msg.tool_call_id ?? '',
        });
        continue;
      }

      if (msg.role === 'assistant') {
        if (msg.content == null || typeof msg.content === 'string') {
          result.push({ role: 'assistant', content: msg.content ?? '' });
        } else {
          let text = '';
          const toolCalls: LiteLLMToolCallMessage[] = [];

          for (const part of msg.content) {
            if (part.type === 'text') {
              text += part.text;
            } else if (part.type === 'tool_use') {
              toolCalls.push({
                id: part.id,
                type: 'function',
                function: { name: part.name, arguments: JSON.stringify(part.input) },
              });
            }
          }

          result.push({
            role: 'assistant',
            content: text || null,
            tool_calls: toolCalls.length > 0 ? toolCalls : undefined,
          });
        }
        continue;
      }

      if (msg.role === 'user') {
        const text = msg.content == null
          ? ''
          : typeof msg.content === 'string'
            ? msg.content
            : msg.content.filter((p) => p.type === 'text').map((p) => (p as { type: 'text'; text: string }).text).join('\n');
        result.push({ role: 'user', content: text });
      }
    }

    return result;
  }

  private convertTool(tool: ToolDefinition): LiteLLMToolDef {
    return {
      type: 'function',
      function: {
        name: tool.name,
        description: tool.description,
        parameters: tool.parameters,
      },
    };
  }
}

// ─── LiteLLM API types (OpenAI-compatible) ──────────────────────────

interface LiteLLMChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: LiteLLMToolCallMessage[];
  tool_call_id?: string;
}

interface LiteLLMToolCallMessage {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface LiteLLMToolDef {
  type: 'function';
  function: { name: string; description: string; parameters: Record<string, unknown> };
}

interface LiteLLMChatResponse {
  choices?: { message?: { content?: string; tool_calls?: LiteLLMToolCallMessage[] } }[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

interface LiteLLMStreamChunk {
  choices?: { delta?: { content?: string; tool_calls?: LiteLLMStreamToolCall[] } }[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

interface LiteLLMStreamToolCall {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}
