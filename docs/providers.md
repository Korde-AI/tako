# Providers

Providers adapt LLM APIs into Tako's unified streaming interface.

## Anthropic (Built-in)

The primary provider with full native implementation.

**Configuration:**
```json
{
  "providers": {
    "primary": "anthropic/claude-sonnet-4-6"
  }
}
```

**Auth options:**
- **Setup token (OAuth):** `tako models auth login --provider anthropic`
- **API key:** `ANTHROPIC_API_KEY` env var or via `tako onboard`
- **Multi-key rotation:** `ANTHROPIC_API_KEYS=key1,key2` (comma-separated, rotated per request)

**Available models:**

| Model | Context | Max Output | Capabilities |
|-------|---------|------------|--------------|
| `claude-opus-4-6` | 200K | 32K | vision, tools, streaming |
| `claude-sonnet-4-6` | 200K | 8K | vision, tools, streaming |
| `claude-haiku-4-5` | 200K | 8K | vision, tools, streaming |

**Features:**
- Streaming via Server-Sent Events (SSE)
- Incremental tool call parsing (`input_json_delta`)
- System prompt extraction from message array
- Token usage tracking
- Tool use/result pairing repair for API compatibility

## OpenAI (Built-in)

OpenAI Chat Completions API support.

```json
{
  "providers": {
    "primary": "openai/gpt-5.2"
  }
}
```

**Auth:** `OPENAI_API_KEY` env var or `tako models auth login --provider openai`

## LiteLLM (Built-in)

Universal proxy adapter for 100+ providers via LiteLLM's OpenAI-compatible API.

```json
{
  "providers": {
    "primary": "litellm/anthropic/claude-sonnet-4-6",
    "litellm": {
      "baseUrl": "http://localhost:4000",
      "model": "anthropic/claude-sonnet-4-6"
    }
  }
}
```

**Features:**
- Preset endpoint support for popular proxies
- Dynamic model fetching from proxy `/models` endpoint
- Automatic retry on 400 errors (proxy warmup/transient failures)
- Message sanitization for proxy compatibility

**Setup:** `tako onboard` includes LiteLLM configuration with proxy URL and model selection.

## Custom Providers

Implement the `Provider` interface in `src/providers/provider.ts`:

```typescript
import type { Provider, ChatRequest, ChatChunk, ModelInfo } from './provider.js';

export class MyProvider implements Provider {
  id = 'my-provider';

  async *chat(req: ChatRequest): AsyncIterable<ChatChunk> {
    // Stream chunks from your API
    yield { text: 'Hello!', done: true };
  }

  models(): ModelInfo[] {
    return [{ id: 'my-model', name: 'My Model', provider: 'my-provider', context_window: 128000, max_output_tokens: 4096, capabilities: ['tools'] }];
  }

  supports(capability: string): boolean {
    return ['tools', 'streaming'].includes(capability);
  }
}
```
