/**
 * Browser tools — powered by agent-browser (Playwright-backed CLI).
 *
 * Replaces the old in-process Playwright integration with agent-browser,
 * a purpose-built headless browser CLI for AI agents.
 *
 * Tools:
 *   - browser_navigate(url)          — navigate to URL
 *   - browser_snapshot()             — get accessibility tree (refs for interaction)
 *   - browser_screenshot([path])     — capture PNG screenshot
 *   - browser_click(selector)        — click element (CSS selector or @ref)
 *   - browser_type(selector, text)   — type into element
 *   - browser_evaluate(js)           — run JS in page context
 *
 * agent-browser is installed as a project dependency and invoked via npx.
 * For advanced use (sessions, auth, network, tabs), use exec with agent-browser directly.
 *
 * See skills/agent-browser/SKILL.md for full command reference.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { Tool, ToolContext, ToolResult } from './tool.js';
import { checkNetworkPolicy } from '../core/security.js';

const execFileAsync = promisify(execFile);

// ─── Config ─────────────────────────────────────────────────────────

export interface BrowserConfig {
  /** Enable browser tools (default: true). */
  enabled: boolean;
  /** Run headless (default: true). */
  headless: boolean;
  /** Auto-close after idle duration in ms — not used directly, agent-browser daemon manages this. */
  idleTimeoutMs: number;
  /** Max output characters to prevent context flooding (default: 30000). */
  maxOutput?: number;
  /** Wrap page output in boundary markers for LLM safety (default: true). */
  contentBoundaries?: boolean;
}

// ─── Helpers ────────────────────────────────────────────────────────

async function runAgentBrowser(
  args: string[],
  config: BrowserConfig,
): Promise<ToolResult> {
  if (!config.enabled) {
    return { output: '', success: false, error: 'Browser tools are disabled in config.' };
  }

  const maxOutput = config.maxOutput ?? 30_000;

  // Build base args
  const baseArgs: string[] = [];
  if (!config.headless) baseArgs.push('--headed');
  if (config.contentBoundaries ?? true) baseArgs.push('--content-boundaries');
  baseArgs.push('--max-output', String(maxOutput));

  const fullArgs = [...baseArgs, ...args];

  // Linux/server environments need these flags for headless Chromium to work
  // without a display server or setuid sandbox
  const browserArgs = [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--disable-gpu',
    '--single-process',
  ].join(',');

  // agent-browser requires Node 18+. Use nvm Node 22 if system node is old.
  const nodeEnv: NodeJS.ProcessEnv = {
    ...process.env,
    FORCE_COLOR: '0',
    AGENT_BROWSER_ARGS: process.env.AGENT_BROWSER_ARGS ?? browserArgs,
  };

  // Resolve a Node 18+ binary via nvm if system node is too old
  const nvmNode22 = `${process.env.HOME}/.nvm/versions/node/v22.22.0/bin/node`;
  const nvmNpx22 = `${process.env.HOME}/.nvm/versions/node/v22.22.0/bin/npx`;
  const nodeMajor = parseInt(process.version.slice(1));
  const useNvm = nodeMajor < 18;
  const npxBin = useNvm ? nvmNpx22 : 'npx';

  try {
    const { stdout, stderr } = await execFileAsync(
      npxBin,
      ['agent-browser', ...fullArgs],
      {
        maxBuffer: 4 * 1024 * 1024,
        timeout: 30_000,
        env: nodeEnv,
      },
    );
    const output = stdout || stderr || '(no output)';
    return { output: output.trim(), success: true };
  } catch (err: unknown) {
    const e = err as { stdout?: string; stderr?: string; message?: string; code?: number };
    // exit code 1 from agent-browser usually means "no match" not a real error
    if (e.code === 1 && e.stdout) {
      return { output: e.stdout.trim() || '(no matches)', success: true };
    }
    const msg = e.stderr || e.message || String(err);
    return { output: '', success: false, error: `agent-browser failed: ${msg}` };
  }
}

// ─── Tool factory ───────────────────────────────────────────────────

export function createBrowserTools(config: BrowserConfig): Tool[] {
  const navigateTool: Tool = {
    name: 'browser_navigate',
    description: 'Navigate the browser to a URL. Launches the browser if not already open.',
    group: 'web',
    parameters: {
      type: 'object',
      properties: {
        url: { type: 'string', description: 'URL to navigate to' },
      },
      required: ['url'],
    },
    async execute(params: unknown): Promise<ToolResult> {
      const { url } = params as { url: string };

      const policyBlock = checkNetworkPolicy(url);
      if (policyBlock) {
        return { output: '', success: false, error: policyBlock };
      }

      return runAgentBrowser(['open', url], config);
    },
  };

  const snapshotTool: Tool = {
    name: 'browser_snapshot',
    description: [
      'Get the current page content as plain text (HTML stripped). Useful for reading rendered content.',
      'Uses agent-browser accessibility tree — returns interactive elements with refs (@e1, @e2, ...) for reliable interaction.',
      'After snapshot, use refs in browser_click/browser_type instead of CSS selectors.',
    ].join(' '),
    group: 'web',
    parameters: { type: 'object', properties: {} },
    async execute(): Promise<ToolResult> {
      // -i = interactive elements only, -c = compact, keeps output lean for AI
      return runAgentBrowser(['snapshot', '-i', '-c'], config);
    },
  };

  const screenshotTool: Tool = {
    name: 'browser_screenshot',
    description: 'Capture a PNG screenshot of the current page. Returns the file path.',
    group: 'web',
    parameters: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Output file path (default: /tmp/tako-screenshot.png)' },
      },
    },
    async execute(params: unknown): Promise<ToolResult> {
      const { path: outPath } = (params ?? {}) as { path?: string };
      const filePath = outPath ?? '/tmp/tako-screenshot.png';
      return runAgentBrowser(['screenshot', filePath], config);
    },
  };

  const clickTool: Tool = {
    name: 'browser_click',
    description: [
      'Click an element on the page by CSS selector or @ref from browser_snapshot.',
      'Prefer @ref (e.g. @e1) over CSS selectors — refs are from the latest snapshot and are more reliable.',
    ].join(' '),
    group: 'web',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector or @ref (e.g. "@e2") of element to click' },
      },
      required: ['selector'],
    },
    async execute(params: unknown): Promise<ToolResult> {
      const { selector } = params as { selector: string };
      return runAgentBrowser(['click', selector], config);
    },
  };

  const typeTool: Tool = {
    name: 'browser_type',
    description: [
      'Type text into an input field on the page.',
      'Use @ref from browser_snapshot (e.g. @e3) or a CSS selector.',
      'This clears the field first then fills it.',
    ].join(' '),
    group: 'web',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector or @ref (e.g. "@e3") of input element' },
        text: { type: 'string', description: 'Text to type' },
      },
      required: ['selector', 'text'],
    },
    async execute(params: unknown): Promise<ToolResult> {
      const { selector, text } = params as { selector: string; text: string };
      return runAgentBrowser(['fill', selector, text], config);
    },
  };

  const evaluateTool: Tool = {
    name: 'browser_evaluate',
    description: 'Run JavaScript in the browser page context and return the result.',
    group: 'web',
    parameters: {
      type: 'object',
      properties: {
        js: { type: 'string', description: 'JavaScript code to evaluate' },
      },
      required: ['js'],
    },
    async execute(params: unknown): Promise<ToolResult> {
      const { js } = params as { js: string };
      return runAgentBrowser(['eval', js], config);
    },
  };

  return [navigateTool, snapshotTool, screenshotTool, clickTool, typeTool, evaluateTool];
}
