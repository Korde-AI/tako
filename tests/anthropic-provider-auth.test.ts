import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { AnthropicProvider } from '../src/providers/anthropic.js';

describe('AnthropicProvider bearer auth behavior', () => {
  it('does not attempt OAuth refresh for setup-token auth errors', async () => {
    const provider = new AnthropicProvider('sk-ant-oat01-test-setup-token');
    (provider as any).bearerToken = 'sk-ant-oat01-test-setup-token';
    (provider as any).bearerMethod = 'setup_token';

    const recovered = await (provider as any).tryRecoverAuth({
      status: 401,
      message: 'unauthorized',
    });

    assert.equal(recovered, false);
  });

  it('uses Claude Code headers for setup-token clients', () => {
    const provider = new AnthropicProvider('sk-ant-oat01-test-setup-token');

    const client = (provider as any).createClient('sk-ant-oat01-test-setup-token');
    const headers = (client as any)._options?.defaultHeaders;

    assert.equal(headers['x-app'], 'cli');
    assert.equal(headers['user-agent'], 'claude-cli/2.1.75');
    assert.match(headers['anthropic-beta'], /claude-code-20250219/);
    assert.match(headers['anthropic-beta'], /oauth-2025-04-20/);
  });

  it('prepends Claude Code identity for setup-token system prompts', () => {
    const provider = new AnthropicProvider('sk-ant-oat01-test-setup-token');

    const system = (provider as any).buildSystemParam('Project-specific instructions', 'none', true);

    assert.deepEqual(system, [
      {
        type: 'text',
        text: "You are Claude Code, Anthropic's official CLI for Claude.",
      },
      {
        type: 'text',
        text: 'Project-specific instructions',
      },
    ]);
  });

  it('normalizes Claude Code tool names for setup-token requests', () => {
    const provider = new AnthropicProvider('sk-ant-oat01-test-setup-token');

    const tool = (provider as any).convertTool({
      name: 'web_fetch',
      description: 'Fetch a web page',
      parameters: { type: 'object', properties: {}, required: [] },
    }, true);

    assert.equal(tool.name, 'WebFetch');
  });

  it('maps Claude Code tool names back to local tool names on responses', async () => {
    const provider = new AnthropicProvider('sk-ant-oat01-test-setup-token');
    (provider as any).bearerToken = 'sk-ant-oat01-test-setup-token';

    const chunks = [];
    const mockClient = {
      messages: {
        create: async function* () {
          yield {
            type: 'content_block_start',
            content_block: { type: 'tool_use', id: 'tool-1', name: 'WebFetch' },
          };
          yield {
            type: 'content_block_delta',
            delta: { type: 'input_json_delta', partial_json: '{}' },
          };
          yield { type: 'content_block_stop' };
          yield {
            type: 'message_stop',
          };
        },
      },
    };

    for await (const chunk of (provider as any).chatStreaming(
      mockClient,
      'claude-sonnet-4-6',
      '',
      [],
      [],
      {
        model: 'anthropic/claude-sonnet-4-6',
        messages: [],
        tools: [{ name: 'web_fetch', description: 'Fetch', parameters: { type: 'object', properties: {} } }],
        stream: true,
      },
    )) {
      chunks.push(chunk);
    }

    const done = chunks.find((chunk) => chunk.done);
    assert.equal(done?.tool_calls?.[0]?.name, 'web_fetch');
  });
});
