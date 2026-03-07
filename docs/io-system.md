# Tako I/O System Analysis

> Deep analysis of message flow, streaming architecture, backpressure handling,
> and error propagation through Tako's I/O pipeline.

---

## 1. Full I/O Flow Diagram

```
                              ┌──────────────────────┐
                              │     External World    │
                              │  (Discord, Telegram,  │
                              │   CLI stdin, WebSocket)│
                              └──────────┬───────────┘
                                         │
                    ┌────────────────────┼────────────────────┐
                    │                    │                    │
              ┌─────▼──────┐     ┌──────▼──────┐     ┌──────▼──────┐
              │ CLIChannel  │     │DiscordChan  │     │TelegramChan │
              │  (readline) │     │ (discord.js)│     │  (grammY)   │
              └─────┬──────┘     └──────┬──────┘     └──────┬──────┘
                    │                    │                    │
                    │  InboundMessage    │ InboundMessage     │ InboundMessage
                    │  { id, channelId,  │                    │
                    │    author, content }│                    │
                    └────────────────────┼────────────────────┘
                                         │
                              ┌──────────▼───────────┐
                              │   index.ts (router)   │
                              │  wireChannel()        │
                              │  onMessage handler    │
                              └──────────┬───────────┘
                                         │
                          ┌──────────────┼──────────────┐
                          │              │              │
                   hooks.emit     getSession()    hooks.emit
                   'message_     (Map lookup     'before_prompt_
                    received'    or create)        build'
                          │              │              │
                          └──────────────┼──────────────┘
                                         │
                              ┌──────────▼───────────┐
                              │     AgentLoop.run()   │
                              │   (AsyncGenerator)    │
                              └──────────┬───────────┘
                                         │
                    ┌────────────────────┼────────────────────┐
                    │                    │                    │
             PromptBuilder          ContextManager      ToolRegistry
             .build('full')         .needsCompaction()  .getActiveTools()
                    │                    │                    │
                    │  system prompt     │ token check        │ Tool[]
                    │  (up to 150KB)     │                    │
                    └────────────────────┼────────────────────┘
                                         │
                              ┌──────────▼───────────┐
                              │  AnthropicProvider    │
                              │    .chat(req)         │
                              │  (AsyncIterable)      │
                              └──────────┬───────────┘
                                         │
                              ┌──────────▼───────────┐
                              │  Anthropic SSE Stream │
                              │                       │
                              │  message_start        │
                              │  content_block_start  │
                              │  content_block_delta ─┼──► yield { text: "..." }
                              │  content_block_stop   │
                              │  message_delta        │
                              │  message_stop ────────┼──► yield { tool_calls, done }
                              └──────────┬───────────┘
                                         │
                              ┌──────────▼───────────┐
                              │  Tool Execution       │
                              │  (sequential loop)    │
                              │                       │
                              │  for (tc of calls) {  │
                              │    hooks: before_call │
                              │    tool.execute()     │
                              │    hooks: after_call  │
                              │    push toolMsg       │
                              │  }                    │
                              └──────────┬───────────┘
                                         │
                                         │ (loop back to Provider
                                         │  if tool_calls existed)
                                         │
                              ┌──────────▼───────────┐
                              │  Response Delivery    │
                              │                       │
                              │  CLI: stdout.write()  │
                              │  Discord: channel.send│
                              │  Telegram: api.send   │
                              │  Gateway: ws.send()   │
                              └──────────────────────┘
```

---

## 2. Message Flow — Detailed Trace

### Phase 1: Channel Intake

A message arrives at a channel adapter. Each adapter normalizes it into `InboundMessage`:

```
User types "hello" in Discord
  → discord.js Events.MessageCreate fires
  → DiscordChannel.convertInbound() creates:
    {
      id: "1234567890",
      channelId: "discord:987654321",
      author: { id: "user123", name: "alice" },
      content: "hello",
      attachments: [],
      timestamp: "2026-03-05T00:00:00.000Z"
    }
  → handler(inbound) called
```

**Key design**: All three channel adapters (CLI, Discord, Telegram) produce identical `InboundMessage` objects. The agent loop never sees channel-specific types.

### Phase 2: Session Resolution

In `index.ts`, the `wireChannel()` closure handles routing:

```typescript
function getSession(msg: InboundMessage) {
  const key = `${msg.channelId}:${msg.author.id}`;  // e.g. "discord:987654321:user123"
  let session = channelSessions.get(key);
  if (!session) {
    session = sessions.create({ name: `${msg.channelId}/${msg.author.name}` });
    channelSessions.set(key, session);
  }
  return session;
}
```

Sessions are keyed by `channelId:authorId`. A user on Discord gets a different session than the same concept on Telegram. Sessions persist to disk via `SessionManager` (JSON files in `.sessions/`).

### Phase 3: Agent Loop

`AgentLoop.run()` is an `AsyncGenerator` that yields text chunks:

```
1. Fire 'agent_start' hook
2. Fire 'before_prompt_build' hook
3. PromptBuilder.build({ mode: 'full' })
   → Read SOUL.md, IDENTITY.md, AGENTS.md, TOOLS.md, USER.md, HEARTBEAT.md, BOOTSTRAP.md
   → Read memory/MEMORY.md (curated memory)
   → Append skill instructions
   → Append runtime context (date, platform, workspace)
   → Concatenate with "---" separators (up to 150KB total)
4. Append user message to session.messages
5. Get tool definitions from ToolRegistry
6. LOOP (max 20 turns):
   a. Check context window (ContextManager.needsCompaction)
   b. Provider.chat() → stream chunks
      → yield text chunks as they arrive
      → accumulate tool_calls
   c. Append assistant message to session
   d. If no tool_calls → break
   e. Execute tools sequentially
      → Fire 'before_tool_call' for each
      → tool.execute(params, ctx)
      → Fire 'after_tool_call' for each
      → Append tool result messages to session
   f. Continue loop (next inference with tool results)
7. Fire 'agent_end' hook
```

### Phase 4: Response Delivery

For **CLI**: Text chunks are written to `stdout` immediately as they arrive from the generator:
```typescript
for await (const chunk of agentLoop.run(session, msg.content)) {
  process.stdout.write(chunk);  // Real-time streaming
}
```

For **Discord/Telegram**: The entire response is accumulated, then sent:
```typescript
let response = '';
for await (const chunk of agentLoop.run(session, msg.content)) {
  response += chunk;
}
if (response) {
  await channel.send({ target, content: response, replyTo: msg.id });
}
```

For **Gateway (WebSocket)**: Chunks are forwarded individually:
```typescript
for await (const chunk of this.deps.agentLoop.run(session, content)) {
  this.sendToClient(client, { type: 'chunk', sessionId, text: chunk });
}
this.sendToClient(client, { type: 'done', sessionId });
```

---

## 3. Streaming Architecture

### Anthropic SSE → AsyncIterable → Channel

The streaming pipeline has three stages:

```
Stage 1: Anthropic HTTP SSE
  ↓ HTTP chunked transfer encoding
  ↓ Server-Sent Events (text/event-stream)
  ↓ Event types: message_start, content_block_start,
  ↓              content_block_delta, content_block_stop,
  ↓              message_delta, message_stop

Stage 2: AnthropicProvider.chatStreaming()
  ↓ Parses SSE events into ChatChunk objects
  ↓ Text deltas yielded immediately: { text: "...", done: false }
  ↓ Tool call JSON accumulated incrementally (input_json_delta)
  ↓ Final chunk: { tool_calls: [...], done: true, usage: {...} }

Stage 3: AgentLoop.run()
  ↓ Re-yields text chunks from provider
  ↓ Accumulates tool calls
  ↓ On provider completion: executes tools, loops back

Stage 4: Channel delivery
  ↓ CLI: immediate stdout.write per chunk
  ↓ Discord/Telegram: accumulate full response, then send
  ↓ Gateway WS: forward each chunk as JSON frame
```

### Tool Call Streaming Detail

Tool calls are streamed incrementally from Anthropic:

```
content_block_start  → { type: "tool_use", id: "toolu_xxx", name: "read" }
input_json_delta     → '{"pa'
input_json_delta     → 'th": '
input_json_delta     → '"src/index.ts"}'
content_block_stop   → (tool call complete)
message_stop         → (parse accumulated JSON, emit as ToolCall)
```

The `AnthropicProvider` accumulates `inputJson` as a string and only parses it on `message_stop`. This means tool calls are not available until the full response is complete.

### Streaming Gaps

1. **Discord/Telegram don't stream**: They buffer the entire response. reference architecture's channel trait includes `send_draft()` / `update_draft()` / `finalize_draft()` for progressive updates — Tako doesn't have this yet.

2. **Tool results aren't streamed to WebSocket**: The Gateway sends `chunk` messages for text but doesn't emit `tool_call` / `tool_result` events (the protocol types exist but aren't used in `handleChat()`).

3. **No thinking stream**: When using extended thinking, thinking tokens aren't surfaced to the consumer.

---

## 4. Backpressure Analysis

### Does Tako Handle Slow Consumers?

**Short answer: No.** There is no backpressure mechanism.

### Analysis by Component

#### CLI Channel
- **Producer**: `agentLoop.run()` yields chunks
- **Consumer**: `process.stdout.write(chunk)`
- **Backpressure**: stdout is a writable stream with internal buffering. If the terminal can't keep up, `write()` returns `false`, but Tako ignores the return value. In practice, terminals are fast enough that this never matters.

#### Discord Channel
- **Producer**: Full response accumulated in string
- **Consumer**: `channel.send()` → Discord API HTTP POST
- **Backpressure**: Discord rate limits (5 messages/5 seconds per channel). Tako's `splitMessage()` sends chunks sequentially with `await`, so rate limits would cause the sender to wait. But there's no queue or retry — if Discord rejects, the error propagates up.

#### Telegram Channel
- **Producer**: Full response accumulated
- **Consumer**: `bot.api.sendMessage()` → Telegram Bot API
- **Backpressure**: Similar to Discord. Telegram rate limits are per-bot. No queue.

#### Gateway WebSocket
- **Producer**: `agentLoop.run()` yields chunks
- **Consumer**: `client.ws.send(JSON.stringify(msg))`
- **Backpressure**: The `ws` library buffers sends internally. If the WebSocket buffer fills (client can't drain fast enough), `send()` calls accumulate in memory. The only protection is the `readyState` check:
  ```typescript
  if (client.ws.readyState !== WebSocket.OPEN) break;
  ```
  This stops sending if the connection drops, but doesn't handle slow consumers.

### What Happens When a Channel Can't Keep Up?

1. **Memory grows**: Undelivered messages accumulate in Node.js heap
2. **Event loop blocks**: Sequential message sends block other handlers
3. **No circuit breaker**: A slow channel blocks the agent loop for that session (but not other sessions, since each session's handler runs independently)

### Recommendations

1. **Add WebSocket buffering limits**: Track `ws.bufferedAmount` and pause the generator if backlog exceeds a threshold
2. **Add channel send timeouts**: Wrap `channel.send()` with `AbortSignal.timeout()`
3. **Implement draft updates for Discord/Telegram**: Progressive message editing instead of buffering the full response
4. **Consider `for await` with buffering**: Use a bounded async queue between the generator and the consumer

---

## 5. Error Propagation

### Error Flow Diagram

```
Anthropic API Error
  ↓ thrown inside provider.chat() generator
  ↓ caught by for-await-of in AgentLoop.run()
  ↓ NOT caught — propagates out of the generator
  ↓
wireChannel handler catches it:
  catch (err) {
    console.error('[tako] Error:', err.message);
  }
  ↓ CLI: error printed, re-prompt shown
  ↓ Discord/Telegram: error logged, no response sent to user
  ↓ Gateway: caught in handleChat(), sent as { type: 'error' }
```

### Error Sources and Handling

| Error Source | Where Caught | User Impact |
|-------------|-------------|-------------|
| **API auth failure (401/403)** | `AnthropicProvider.wrapAuthError()` | Thrown, logged, no response |
| **API rate limit (429)** | `AnthropicProvider.chat()` — tries next key | Transparent if multiple keys, error if all exhausted |
| **API timeout** | Node.js fetch timeout | Thrown, no response |
| **Tool execution error** | `tool.execute()` returns `{ success: false }` | Model sees error, retries or reports |
| **JSON parse error (tool args)** | `JSON.parse(tc.inputJson)` in streaming | Thrown, breaks agent loop |
| **File read error (prompt)** | `PromptBuilder.loadFile()` returns `''` | Silent — missing file treated as empty |
| **Session not found** | Various — returns error result | Reported to client |
| **WebSocket disconnect** | `readyState` check in Gateway | Stops streaming, no cleanup |
| **Channel send failure** | Per-channel error handling | Logged, no retry |

### Error Handling Patterns

**Good patterns in Tako:**
1. **Graceful file missing**: `loadFile()` catches errors and returns empty string — missing workspace files don't crash
2. **Key rotation**: Anthropic provider tries multiple API keys before failing
3. **Tool error isolation**: A failing tool returns `ToolResult { success: false }` — the model sees the error and can retry or report it
4. **Auth error wrapping**: `wrapAuthError()` provides clear messages for 401/403

**Gaps in error handling:**
1. **No retry logic**: Network errors on provider calls are not retried
2. **Silent channel failures**: If Discord/Telegram `send()` fails, the user gets no response and no notification
3. **JSON parse crash**: If Anthropic sends malformed tool call JSON, `JSON.parse()` throws and breaks the loop — should catch and return error to model
4. **No error hook**: There's no `'error'` hook event for skills to observe
5. **Memory store errors are swallowed**: `HybridMemoryStore.initialize()` catches all errors silently — a corrupted index goes unnoticed

### Error Recovery Recommendations

1. **Add retry with exponential backoff** for provider API calls (network errors, 500s)
2. **Wrap JSON.parse in try/catch** in the streaming tool call accumulator
3. **Send error messages to channels** — if the agent loop fails, send a user-visible error like "Something went wrong, please try again"
4. **Add `'error'` hook event** — skills should be able to observe and react to errors
5. **Log + alert on repeated failures** — if the same provider/channel fails repeatedly, surface it in `tako doctor`

---

## 6. Data Contracts Between Layers

### Channel → Router

```typescript
InboundMessage {
  id: string         // platform-specific message ID
  channelId: string  // "cli" | "discord:{channelId}" | "telegram:{chatId}"
  author: { id: string; name: string }
  content: string    // plain text
  timestamp: string  // ISO-8601
}
```

### Router → Agent Loop

```typescript
// Passes:
session: Session      // from SessionManager
userMessage: string   // msg.content
// Returns:
AsyncIterable<string> // text chunks
```

### Agent Loop → Provider

```typescript
ChatRequest {
  model: string
  messages: ChatMessage[]  // system + history + user
  tools?: ToolDefinition[]
  stream: true
}
// Returns:
AsyncIterable<ChatChunk>  // text + tool_calls
```

### Agent Loop → Tools

```typescript
// Input:
params: unknown      // parsed from model's tool_call.input
ctx: ToolContext {
  sessionId: string
  workDir: string
  workspaceRoot: string
}
// Output:
ToolResult {
  output: string     // fed back to model
  success: boolean
}
```

### Gateway → WebSocket Client

```typescript
ServerMessage =
  | { type: 'chunk'; sessionId; text }    // streaming text
  | { type: 'done'; sessionId }           // response complete
  | { type: 'error'; sessionId; message } // error
  | { type: 'session_created'; ... }      // session lifecycle
```

---

*Analysis based on Tako v0.4.0 source code, March 2026.*
