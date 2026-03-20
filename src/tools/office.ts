import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Tool, ToolContext, ToolResult } from './tool.js';
import { resolvePathWithinAllowedRoot } from './root-policy.js';

const execFileAsync = promisify(execFile);

function decodeXmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, '\'');
}

export function extractPptxSlideTextFromXml(xml: string): string[] {
  const matches = Array.from(xml.matchAll(/<a:t>([\s\S]*?)<\/a:t>/g));
  return matches
    .map((match) => decodeXmlEntities(match[1]).trim())
    .filter(Boolean);
}

async function listZipEntries(path: string): Promise<string[]> {
  const { stdout } = await execFileAsync('unzip', ['-Z1', path], { maxBuffer: 4 * 1024 * 1024 });
  return stdout.split('\n').map((line) => line.trim()).filter(Boolean);
}

async function readZipEntry(path: string, entry: string): Promise<string> {
  const { stdout } = await execFileAsync('unzip', ['-p', path, entry], { maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' });
  return stdout;
}

const extractOfficeTextTool: Tool = {
  name: 'extract_office_text',
  description: 'Extract readable text from Office files stored locally, especially .pptx slide decks. Use this when a user uploads a PowerPoint and you need slide text or structure. Requires a local file path.',
  group: 'fs',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Absolute or relative local path to the Office file.' },
      kind: {
        type: 'string',
        enum: ['auto', 'pptx'],
        description: 'Document kind. Defaults to auto; currently pptx is supported.',
        default: 'auto',
      },
      maxSlides: {
        type: 'number',
        description: 'Maximum number of slides to extract for pptx files. Defaults to 20.',
        default: 20,
      },
    },
    required: ['path'],
  },
  async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
    const { path, kind = 'auto', maxSlides = 20 } = params as { path: string; kind?: 'auto' | 'pptx'; maxSlides?: number };
    const resolved = resolvePathWithinAllowedRoot(ctx, path);
    if (!resolved.ok) {
      return { output: '', success: false, error: resolved.error };
    }
    const fullPath = resolved.fullPath;
    const detectedKind = kind === 'auto' && fullPath.toLowerCase().endsWith('.pptx') ? 'pptx' : kind;
    if (detectedKind !== 'pptx') {
      return { output: '', success: false, error: 'extract_office_text currently supports pptx files only.' };
    }

    try {
      const entries = await listZipEntries(fullPath);
      const slideEntries = entries
        .filter((entry) => /^ppt\/slides\/slide\d+\.xml$/.test(entry))
        .sort((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        .slice(0, Math.max(1, Math.min(100, maxSlides)));

      if (slideEntries.length === 0) {
        return { output: 'No slide XML entries found in this pptx file.', success: false, error: 'no_slides_found' };
      }

      const sections: string[] = [];
      for (let i = 0; i < slideEntries.length; i++) {
        const xml = await readZipEntry(fullPath, slideEntries[i]);
        const lines = extractPptxSlideTextFromXml(xml);
        sections.push(`Slide ${i + 1}:\n${lines.length ? lines.join('\n') : '(no text found)'}`);
      }

      return {
        output: [
          `Extracted text from ${slideEntries.length} slide(s) in ${fullPath}.`,
          '',
          ...sections,
        ].join('\n'),
        success: true,
        data: { slideCount: slideEntries.length, path: fullPath },
      };
    } catch (err) {
      return {
        output: '',
        success: false,
        error: `Failed to extract office text from ${path}: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  },
};

export const officeTools: Tool[] = [extractOfficeTextTool];
