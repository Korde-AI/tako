/**
 * Image tool — vision/image analysis.
 * Kernel tool (always available when provider supports vision).
 *
 * Sends images to the current LLM provider's vision API for analysis.
 * Supports both local files (base64 encoded) and URLs.
 */

import { readFile } from 'node:fs/promises';
import { resolve, extname } from 'node:path';
import type { Tool, ToolContext, ToolResult } from './tool.js';
import type { Provider, ChatMessage, ContentPart } from '../providers/provider.js';

// ─── MIME type mapping ──────────────────────────────────────────────

const EXT_TO_MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
};

// ─── Provider reference ─────────────────────────────────────────────

let imageProvider: Provider | null = null;
let imageModel: string = 'anthropic/claude-sonnet-4-6';

/** Set the provider used for image analysis. */
export function setImageProvider(provider: Provider, model?: string): void {
  imageProvider = provider;
  if (model) imageModel = model;
}

// ─── Image params ───────────────────────────────────────────────────

interface ImageParams {
  path?: string;
  url?: string;
  prompt?: string;
}

export const imageTool: Tool = {
  name: 'image',
  description: 'Analyze an image file or URL using vision capabilities. Returns a text description or answers questions about the image.',
  group: 'image',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Local file path to an image' },
      url: { type: 'string', description: 'URL of an image' },
      prompt: { type: 'string', description: 'What to analyze about the image (default: "Describe this image in detail")' },
    },
  },

  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { path, url, prompt } = params as ImageParams;

    if (!path && !url) {
      return { output: '', success: false, error: 'Either path or url is required' };
    }

    if (!imageProvider) {
      return { output: '', success: false, error: 'No provider configured for image analysis' };
    }

    const analysisPrompt = prompt ?? 'Describe this image in detail.';

    try {
      const contentParts: ContentPart[] = [
        { type: 'text', text: analysisPrompt },
      ];

      if (path) {
        const fullPath = resolve(ctx.workDir, path);
        const data = await readFile(fullPath);
        const ext = extname(fullPath).toLowerCase();
        const mediaType = EXT_TO_MIME[ext] ?? 'image/png';
        contentParts.push({
          type: 'image_base64',
          media_type: mediaType,
          data: data.toString('base64'),
        });
      } else if (url) {
        const resp = await fetch(url);
        if (!resp.ok) {
          return { output: '', success: false, error: `Failed to fetch image: HTTP ${resp.status}` };
        }
        const buffer = Buffer.from(await resp.arrayBuffer());
        const mediaType = resp.headers.get('content-type') ?? 'image/png';
        contentParts.push({
          type: 'image_base64',
          media_type: mediaType,
          data: buffer.toString('base64'),
        });
      }

      const messages: ChatMessage[] = [
        { role: 'user', content: contentParts },
      ];

      let result = '';
      for await (const chunk of imageProvider.chat({
        model: imageModel,
        messages,
        stream: true,
      })) {
        if (chunk.text) {
          result += chunk.text;
        }
      }

      return {
        output: result || '[No analysis returned]',
        success: true,
      };
    } catch (err) {
      return {
        output: '',
        success: false,
        error: `Image analysis failed: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

/** All image tools. */
export const imageTools: Tool[] = [imageTool];
