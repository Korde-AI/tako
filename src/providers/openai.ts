/**
 * OpenAI provider — native OpenAI API adapter with streaming support.
 *
 * Supports authentication via:
 *   - OPENAI_API_KEY env var (API key)
 *   - ~/.tako/auth/openai.json (API key or OAuth token)
 *   - ~/.tako/auth/openai-codex.json (OAuth token for Codex)
 */

import type {
  Provider,
  ChatRequest,
  ChatChunk,
  ChatMessage,
  ModelInfo,
  ToolDefinition,
  ToolCall,
} from './provider.js';
import { resolveAuthToken } from '../auth/storage.js';
import { getValidOAuthToken } from '../auth/oauth.js';

export class OpenAIProvider implements Provider {
  id = 'openai';
  private apiKey: string;
  private authResolved = false;
  private baseUrl: string;

  constructor(opts?: { apiKey?: string; baseUrl?: string }) {
    this.apiKey = opts?.apiKey ?? process.env.OPENAI_API_KEY ?? '';
    this.baseUrl = opts?.baseUrl ?? 'https://api.openai.com';
  }

  private async ensureAuth(): Promise<void> {
    if (this.authResolved) return;
    this.authResolved = true;

    if (!this.apiKey) {
      // Try OAuth token (openai-codex)
      const oauthToken = await getValidOAuthToken('openai-codex');
      if (oauthToken) {
        this.apiKey = oauthToken;
        return;
      }

      // Try auth file (api_key)
      const token = await resolveAuthToken('openai');
      if (token) {
        this.apiKey = token;
      } else {
        console.warn('[openai] No API key found. Set OPENAI_API_KEY or run `tako models auth login --provider openai`.');
      }
    }
  }

  private extractModelId(model: string): string {
    const slash = model.indexOf('/');
    return slash >= 0 ? model.slice(slash + 1) : model;
  }

  async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
    await this.ensureAuth();

    const model = this.extractModelId(req.model);
    const messages = this.convertMessages(req.messages);
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

    const res = await fetch(`${this.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const errBody = await res.text();
      if (res.status === 401 || res.status === 403) {
        throw new Error(`[openai] Authentication failed (HTTP ${res.status}). Check your API key.`);
      }
      throw new Error(`[openai] API error (${res.status}): ${errBody}`);
    }

    if (shouldStream) {
      yield* this.parseSSEStream(res);
    } else {
      const data = await res.json() as OpenAIChatResponse;
      const choice = data.choices?.[0];
      const msg = choice?.message;

      const toolCalls: ToolCall[] = (msg?.tool_calls ?? []).map((tc) => ({
        id: tc.id,
        name: tc.function.name,
        input: JSON.parse(tc.function.arguments || '{}'),
      }));

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
              // Emit final chunk
              const parsedToolCalls: ToolCall[] = [];
              for (const [, tc] of toolCallAccum) {
                parsedToolCalls.push({
                  id: tc.id,
                  name: tc.name,
                  input: tc.args ? JSON.parse(tc.args) : {},
                });
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

          let chunk: OpenAIStreamChunk;
          try {
            chunk = JSON.parse(jsonStr) as OpenAIStreamChunk;
          } catch {
            continue;
          }

          // Capture usage from the final chunk
          if (chunk.usage) {
            usage = {
              prompt_tokens: chunk.usage.prompt_tokens,
              completion_tokens: chunk.usage.completion_tokens,
              total_tokens: chunk.usage.total_tokens,
            };
          }

          const delta = chunk.choices?.[0]?.delta;
          if (!delta) continue;

          // Text content
          if (delta.content) {
            yield { text: delta.content, done: false };
          }

          // Tool call deltas
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

    // If we exit the loop without [DONE], emit a final chunk
    const parsedToolCalls: ToolCall[] = [];
    for (const [, tc] of toolCallAccum) {
      parsedToolCalls.push({
        id: tc.id,
        name: tc.name,
        input: tc.args ? JSON.parse(tc.args) : {},
      });
    }

    yield {
      tool_calls: parsedToolCalls.length > 0 ? parsedToolCalls : undefined,
      done: true,
      usage,
    };
  }

  models(): ModelInfo[] {
    return [
      {
        id: 'gpt-5.2',
        name: 'GPT-5.2',
        provider: 'openai',
        context_window: 200_000,
        max_output_tokens: 32_000,
        capabilities: ['text', 'vision', 'tools', 'streaming'],
      },
      {
        id: 'gpt-5-mini',
        name: 'GPT-5 Mini',
        provider: 'openai',
        context_window: 200_000,
        max_output_tokens: 16_384,
        capabilities: ['text', 'vision', 'tools', 'streaming'],
      },
      {
        id: 'gpt-oss-120b',
        name: 'GPT-OSS 120B',
        provider: 'openai',
        context_window: 128_000,
        max_output_tokens: 16_384,
        capabilities: ['text', 'vision', 'tools', 'streaming'],
      },
      {
        id: 'gpt-5.3-codex',
        name: 'GPT-5.3 Codex',
        provider: 'openai-codex',
        context_window: 200_000,
        max_output_tokens: 32_000,
        capabilities: ['text', 'vision', 'tools', 'streaming'],
      },
      {
        id: 'gpt-5.2-codex',
        name: 'GPT-5.2 Codex',
        provider: 'openai-codex',
        context_window: 200_000,
        max_output_tokens: 32_000,
        capabilities: ['text', 'vision', 'tools', 'streaming'],
      },
    ];
  }

  supports(capability: string): boolean {
    return ['text', 'vision', 'tools', 'streaming'].includes(capability);
  }

  private convertMessages(msgs: ChatMessage[]): OpenAIChatMessage[] {
    const result: OpenAIChatMessage[] = [];

    for (const msg of msgs) {
      if (msg.role === 'system') {
        const text = typeof msg.content === 'string'
          ? msg.content
          : msg.content.filter((p) => p.type === 'text').map((p) => (p as { type: 'text'; text: string }).text).join('\n');
        result.push({ role: 'system', content: text });
        continue;
      }

      if (msg.role === 'tool') {
        result.push({
          role: 'tool',
          content: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content),
          tool_call_id: msg.tool_call_id ?? '',
        });
        continue;
      }

      if (msg.role === 'assistant') {
        if (typeof msg.content === 'string') {
          result.push({ role: 'assistant', content: msg.content });
        } else {
          let text = '';
          const toolCalls: OpenAIToolCallMessage[] = [];

          for (const part of msg.content) {
            if (part.type === 'text') {
              text += part.text;
            } else if (part.type === 'tool_use') {
              toolCalls.push({
                id: part.id,
                type: 'function',
                function: {
                  name: part.name,
                  arguments: JSON.stringify(part.input),
                },
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
        const text = typeof msg.content === 'string'
          ? msg.content
          : msg.content.filter((p) => p.type === 'text').map((p) => (p as { type: 'text'; text: string }).text).join('\n');
        result.push({ role: 'user', content: text });
        continue;
      }
    }

    return result;
  }

  private convertTool(tool: ToolDefinition): OpenAIToolDef {
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

// ─── OpenAI API types ───────────────────────────────────────────────

interface OpenAIChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | null;
  tool_calls?: OpenAIToolCallMessage[];
  tool_call_id?: string;
}

interface OpenAIToolCallMessage {
  id: string;
  type: 'function';
  function: { name: string; arguments: string };
}

interface OpenAIToolDef {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

interface OpenAIChatResponse {
  choices?: { message?: { content?: string; tool_calls?: OpenAIToolCallMessage[] } }[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

interface OpenAIStreamChunk {
  choices?: { delta?: { content?: string; tool_calls?: OpenAIStreamToolCall[] } }[];
  usage?: { prompt_tokens: number; completion_tokens: number; total_tokens: number };
}

interface OpenAIStreamToolCall {
  index: number;
  id?: string;
  function?: { name?: string; arguments?: string };
}
