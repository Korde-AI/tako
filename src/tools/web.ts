/**
 * Web tools — web_search, web_fetch.
 * Kernel tools (always available).
 */

import type { Tool, ToolContext, ToolResult } from './tool.js';
import { checkNetworkPolicy } from '../core/security.js';

// ─── web_search ─────────────────────────────────────────────────────

interface WebSearchParams {
  query: string;
  limit?: number;
}

export const webSearchTool: Tool = {
  name: 'web_search',
  description: 'Search the internet for information.',
  group: 'web',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query' },
      limit: { type: 'number', description: 'Max results (default: 5)' },
    },
    required: ['query'],
  },

  async execute(params: unknown, _ctx: ToolContext): Promise<ToolResult> {
    const { query, limit } = params as WebSearchParams;
    const maxResults = limit ?? 5;
    try {
      // Use DuckDuckGo HTML lite — no API key required
      const searchUrl = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`;
      const resp = await fetch(searchUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (compatible; Tako/1.0)',
        },
      });
      if (!resp.ok) {
        return { output: '', success: false, error: `Search request failed: ${resp.status}` };
      }
      const html = await resp.text();

      // Parse search results from DuckDuckGo HTML lite response
      const results: { title: string; url: string; snippet: string }[] = [];
      const resultBlocks = html.split('<div class="links_main links_deep result__body">');

      for (let i = 1; i < resultBlocks.length && results.length < maxResults; i++) {
        const block = resultBlocks[i];

        // Extract title
        const titleMatch = block.match(/<a[^>]*class="result__a"[^>]*>([^<]*(?:<[^>]*>[^<]*)*)<\/a>/);
        const title = titleMatch
          ? titleMatch[1].replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').trim()
          : '';

        // Extract URL from result__url or href
        const urlMatch = block.match(/href="\/\/duckduckgo\.com\/l\/\?uddg=([^&"]+)/);
        const url = urlMatch ? decodeURIComponent(urlMatch[1]) : '';

        // Extract snippet
        const snippetMatch = block.match(/<a class="result__snippet"[^>]*>([\s\S]*?)<\/a>/);
        const snippet = snippetMatch
          ? snippetMatch[1].replace(/<[^>]*>/g, '').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim()
          : '';

        if (title || url) {
          results.push({ title, url, snippet });
        }
      }

      if (results.length === 0) {
        return { output: `No results found for: ${query}`, success: true };
      }

      const formatted = results.map((r, i) =>
        `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`
      ).join('\n\n');

      return { output: formatted, success: true };
    } catch (err) {
      return { output: '', success: false, error: `web_search failed: ${err}` };
    }
  },
};

// ─── web_fetch ──────────────────────────────────────────────────────

interface WebFetchParams {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}

export const webFetchTool: Tool = {
  name: 'web_fetch',
  description: 'Fetch content from a URL.',
  group: 'web',
  parameters: {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to fetch' },
      method: { type: 'string', description: 'HTTP method (default: GET)' },
      headers: { type: 'object', description: 'Request headers' },
      body: { type: 'string', description: 'Request body' },
    },
    required: ['url'],
  },

  async execute(params: unknown, _ctx: ToolContext): Promise<ToolResult> {
    const { url, method, headers, body } = params as WebFetchParams;

    // Check network policy before fetching
    const policyBlock = checkNetworkPolicy(url);
    if (policyBlock) {
      return { output: '', success: false, error: policyBlock };
    }

    try {
      const resp = await fetch(url, {
        method: method ?? 'GET',
        headers,
        body,
      });
      const text = await resp.text();
      // Truncate large responses
      const truncated = text.length > 50_000 ? text.slice(0, 50_000) + '\n[...truncated]' : text;
      return { output: truncated, success: resp.ok };
    } catch (err) {
      return { output: '', success: false, error: `web_fetch failed: ${err}` };
    }
  },
};

/** All web tools. */
export const webTools: Tool[] = [webSearchTool, webFetchTool];
