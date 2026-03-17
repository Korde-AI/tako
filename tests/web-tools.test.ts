import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { webFetchTool } from '../src/tools/web.js';

describe('web_fetch', () => {
  it('summarizes HTML instead of returning raw DOM', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = (async () => ({
      ok: true,
      headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      text: async () => '<!doctype html><html><head><title>Repo</title><meta name="description" content="Private repo"></head><body><h1>Hello</h1><script>ignore()</script><p>World</p></body></html>',
    })) as any;

    try {
      const result = await webFetchTool.execute({ url: 'https://github.com/example/repo' }, {} as any);
      assert.equal(result.success, true);
      assert.match(result.output, /Title: Repo/);
      assert.match(result.output, /Description: Private repo/);
      assert.match(result.output, /Text: .*Hello World/);
      assert.doesNotMatch(result.output, /<html>/i);
      assert.doesNotMatch(result.output, /<script>/i);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
