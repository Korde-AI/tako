import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AgentLoop } from '../src/core/agent-loop.js';
import type { ChatChunk, ChatRequest, Provider } from '../src/providers/provider.js';

function makeFailingToolLoopProvider(): Provider {
  let callCount = 0;
  return {
    id: 'mock',
    async *chat(_req: ChatRequest): AsyncIterable<ChatChunk> {
      callCount += 1;
      if (callCount === 1) {
        yield {
          tool_calls: [{ id: 'tool-1', name: 'dummy_tool', input: {} }],
          done: true,
        };
        return;
      }
      const err = Object.assign(new Error('Internal server error'), { status: 500 });
      throw err;
    },
    models() { return []; },
    supports() { return true; },
  };
}

describe('AgentLoop failed-turn rollback', () => {
  it('removes partial user/tool history when a turn fails after tool execution begins', async () => {
    const loop = new AgentLoop(
      {
        provider: makeFailingToolLoopProvider(),
        toolRegistry: {
          getActiveTools: () => [{
            name: 'dummy_tool',
            description: 'Dummy tool',
            parameters: {},
          }],
          getTool: (name: string) => name === 'dummy_tool'
            ? { name, description: 'Dummy tool', parameters: {}, execute: async () => ({ success: true, output: 'ok' }) }
            : null,
        } as any,
        promptBuilder: {
          build: async () => 'system prompt',
          setTools: () => {},
          setSkills: () => {},
          setModel: () => {},
          setWorkingDir: () => {},
          setExecutionContext: () => {},
          setTimezoneContext: () => {},
        } as any,
        contextManager: {
          pruneMessages: (messages: any[]) => ({ messages, tokensSaved: 0 }),
        } as any,
      },
      { maxTurns: 3, maxToolCalls: 4, timeout: 30 },
    );

    const session = {
      id: 'session-1',
      name: 'test',
      createdAt: new Date(),
      lastActiveAt: new Date(),
      messages: [] as any[],
      metadata: {},
    };

    await assert.rejects(async () => {
      for await (const _ of loop.run(session as any, 'check repo')) {
        // consume
      }
    }, /Internal server error/);

    assert.deepEqual(session.messages, []);
  });
});
