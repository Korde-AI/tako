/**
 * WORKFLOW.md loader — parse front matter + prompt template.
 * Supports hot-reload via fs.watch.
 */

import { readFileSync, existsSync, watchFile, unwatchFile } from 'node:fs';
import type { GitHubIssue, WorkflowDefinition } from './types.js';

/**
 * Parse YAML-like frontmatter from a WORKFLOW.md file.
 * We parse a simple subset: key: value, key: [array], nested objects.
 * Falls back to empty config if parsing fails.
 */
function parseFrontmatter(raw: string): { config: Record<string, unknown>; body: string } {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!match) {
    return { config: {}, body: raw };
  }

  const [, yamlBlock, body] = match;
  const config: Record<string, unknown> = {};

  // Simple line-by-line YAML parser (handles flat keys, arrays, nested one level)
  const lines = yamlBlock.split('\n');
  let currentKey = '';
  let currentObj: Record<string, unknown> | null = null;

  for (const line of lines) {
    // Skip empty lines and comments
    if (!line.trim() || line.trim().startsWith('#')) continue;

    // Nested key (indented)
    const nestedMatch = line.match(/^  (\w[\w_]*)\s*:\s*(.*)$/);
    if (nestedMatch && currentKey && currentObj) {
      const [, key, val] = nestedMatch;
      currentObj[key] = parseYamlValue(val);
      config[currentKey] = currentObj;
      continue;
    }

    // Top-level key
    const topMatch = line.match(/^(\w[\w_]*)\s*:\s*(.*)$/);
    if (topMatch) {
      const [, key, val] = topMatch;
      const trimmed = val.trim();

      // Check if this starts a nested block (value is empty or |)
      if (!trimmed || trimmed === '|') {
        currentKey = key;
        currentObj = {};
        if (trimmed === '|') {
          // Multi-line scalar — collect indented lines
          const idx = lines.indexOf(line);
          const multiLines: string[] = [];
          for (let i = idx + 1; i < lines.length; i++) {
            if (lines[i].startsWith('  ')) {
              multiLines.push(lines[i].slice(2));
            } else {
              break;
            }
          }
          config[key] = multiLines.join('\n');
          currentKey = '';
          currentObj = null;
        }
        continue;
      }

      currentKey = '';
      currentObj = null;
      config[key] = parseYamlValue(trimmed);
    }
  }

  return { config, body: body.trim() };
}

/** Parse a simple YAML value (string, number, boolean, array). */
function parseYamlValue(raw: string): unknown {
  const trimmed = raw.trim();
  if (!trimmed) return '';

  // Boolean
  if (trimmed === 'true') return true;
  if (trimmed === 'false') return false;

  // Number
  if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10);
  if (/^\d+\.\d+$/.test(trimmed)) return parseFloat(trimmed);

  // JSON array
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) {
    try {
      return JSON.parse(trimmed);
    } catch {
      return trimmed;
    }
  }

  // Quoted string
  if ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'"))) {
    return trimmed.slice(1, -1);
  }

  return trimmed;
}

/** Slugify a string for use in branch names and directory names. */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50);
}

export class WorkflowLoader {
  /** Load WORKFLOW.md from a path. */
  load(path: string): WorkflowDefinition {
    if (!existsSync(path)) {
      return { config: {}, promptTemplate: '' };
    }
    const raw = readFileSync(path, 'utf-8');
    const { config, body } = parseFrontmatter(raw);
    return { config, promptTemplate: body };
  }

  /** Render prompt template with issue variables. */
  renderPrompt(template: string, issue: GitHubIssue, attempt?: number): string {
    if (!template) return '';
    const titleSlug = slugify(issue.title);
    return template
      .replace(/\{\{issue\.number\}\}/g, String(issue.number))
      .replace(/\{\{issue\.title\}\}/g, issue.title)
      .replace(/\{\{issue\.body\}\}/g, issue.body ?? '')
      .replace(/\{\{issue\.labels\}\}/g, issue.labels.join(', '))
      .replace(/\{\{issue\.title_slug\}\}/g, titleSlug)
      .replace(/\{\{attempt\}\}/g, String(attempt ?? 1));
  }

  /** Watch for changes and reload. */
  watch(path: string, onChange: (def: WorkflowDefinition) => void): void {
    if (!existsSync(path)) return;
    watchFile(path, { interval: 2000 }, () => {
      try {
        const def = this.load(path);
        onChange(def);
      } catch {
        // Ignore parse errors during hot-reload
      }
    });
  }

  /** Stop watching a path. */
  unwatch(path: string): void {
    unwatchFile(path);
  }
}
