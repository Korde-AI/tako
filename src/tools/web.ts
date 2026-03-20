/**
 * Web tools — web_search, web_fetch.
 * Kernel tools (always available).
 */

import type { Tool, ToolContext, ToolResult } from './tool.js';
import { checkNetworkPolicy } from '../core/security.js';

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#x27;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ');
}

function looksLikeHtml(text: string): boolean {
  return /<!doctype html|<html[\s>]|<head[\s>]|<body[\s>]/i.test(text);
}

function summarizeHtml(url: string, html: string): string {
  const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
  const metaDescription = html.match(/<meta[^>]+name=["']description["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i)?.[1]
    ?? html.match(/<meta[^>]+property=["']og:description["'][^>]+content=["']([\s\S]*?)["'][^>]*>/i)?.[1];

  const stripped = decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
      .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim(),
  );

  const lines = [
    `URL: ${url}`,
    title ? `Title: ${decodeHtmlEntities(title).replace(/\s+/g, ' ').trim()}` : null,
    metaDescription ? `Description: ${decodeHtmlEntities(metaDescription).replace(/\s+/g, ' ').trim()}` : null,
    stripped ? `Text: ${stripped.slice(0, 12000)}${stripped.length > 12000 ? '\n[...truncated]' : ''}` : null,
  ].filter(Boolean);

  return lines.join('\n');
}

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
  description: 'Fetch readable content from a URL. For HTML pages, returns extracted text and metadata rather than raw DOM.',
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
      const contentType = resp.headers.get('content-type') ?? '';
      const normalized = (contentType.includes('text/html') || looksLikeHtml(text))
        ? summarizeHtml(url, text)
        : text;
      const truncated = normalized.length > 12_000 ? normalized.slice(0, 12_000) + '\n[...truncated]' : normalized;
      return { output: truncated, success: resp.ok };
    } catch (err) {
      return { output: '', success: false, error: `web_fetch failed: ${err}` };
    }
  },
};

/** All web tools. */
export const webTools: Tool[] = [webSearchTool, webFetchTool];
