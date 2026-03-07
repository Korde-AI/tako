/**
 * Browser Control Tool — headless browser automation via Playwright.
 *
 * Tools:
 *   - browser_navigate(url) — go to URL
 *   - browser_snapshot() — get page content as markdown
 *   - browser_screenshot() — capture PNG screenshot
 *   - browser_click(selector) — click an element
 *   - browser_type(selector, text) — type into input
 *   - browser_evaluate(js) — run JS in page context
 *
 * Lazy initialization: browser starts on first tool call.
 * Auto-close: shuts down after 5 minutes of idle.
 */

import type { Tool, ToolContext, ToolResult } from './tool.js';
import { checkNetworkPolicy } from '../core/security.js';

// ─── Types ──────────────────────────────────────────────────────────

export interface BrowserConfig {
  /** Enable browser tools (default: true). */
  enabled: boolean;
  /** Run headless (default: true). */
  headless: boolean;
  /** Auto-close after idle duration in ms (default: 300000 = 5min). */
  idleTimeoutMs: number;
}

// Playwright types (optional dependency)
type Browser = { close: () => Promise<void> };
type Page = {
  goto: (url: string, opts?: unknown) => Promise<unknown>;
  content: () => Promise<string>;
  screenshot: (opts?: unknown) => Promise<Buffer>;
  click: (selector: string, opts?: unknown) => Promise<void>;
  fill: (selector: string, value: string) => Promise<void>;
  evaluate: (fn: string | Function) => Promise<unknown>;
  title: () => Promise<string>;
  url: () => string;
};

// ─── Browser Manager ────────────────────────────────────────────────

class BrowserManager {
  private browser: Browser | null = null;
  private page: Page | null = null;
  private config: BrowserConfig;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private playwright: unknown = null;

  constructor(config: BrowserConfig) {
    this.config = config;
  }

  /** Lazily initialize the browser. */
  async getPage(): Promise<Page> {
    this.resetIdleTimer();

    if (this.page) return this.page;

    // Dynamic import of playwright-core (optional peer dependency)
    let pw: any;
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      pw = await (Function('return import("playwright-core")')() as Promise<any>);
      this.playwright = pw;
    } catch {
      throw new Error(
        'playwright-core is not installed. Install it with: npm install playwright-core',
      );
    }

    try {
      this.browser = await pw.chromium.launch({
        headless: this.config.headless,
      });
      this.page = await (this.browser as any).newPage();
      return this.page!;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('Executable') || msg.includes('executable') || msg.includes('browserType.launch')) {
        throw new Error(
          'Chromium browser binary is missing. Run: npx playwright install chromium',
        );
      }
      throw new Error(`Failed to start browser: ${msg}`);
    }
  }

  /** Close the browser and clean up. */
  async close(): Promise<void> {
    if (this.idleTimer) {
      clearTimeout(this.idleTimer);
      this.idleTimer = null;
    }
    if (this.browser) {
      await this.browser.close();
      this.browser = null;
      this.page = null;
    }
  }

  private resetIdleTimer(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(() => {
      console.log('[browser] Auto-closing after idle timeout');
      this.close().catch(() => {});
    }, this.config.idleTimeoutMs);
  }
}

// ─── Tool factory ───────────────────────────────────────────────────

/** Create all browser control tools. */
export function createBrowserTools(config: BrowserConfig): Tool[] {
  const manager = new BrowserManager(config);

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
      if (!config.enabled) return { output: '', success: false, error: 'Browser tools disabled' };
      const { url } = params as { url: string };

      // Check network policy before navigating
      const policyBlock = checkNetworkPolicy(url);
      if (policyBlock) {
        return { output: '', success: false, error: policyBlock };
      }

      try {
        const page = await manager.getPage();
        await page.goto(url, { waitUntil: 'domcontentloaded' });
        const title = await page.title();
        return { output: `Navigated to ${url} — "${title}"`, success: true };
      } catch (err) {
        return { output: '', success: false, error: `Navigation failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };

  const snapshotTool: Tool = {
    name: 'browser_snapshot',
    description: 'Get the current page content as plain text (HTML stripped). Useful for reading rendered content.',
    group: 'web',
    parameters: { type: 'object', properties: {} },
    async execute(): Promise<ToolResult> {
      if (!config.enabled) return { output: '', success: false, error: 'Browser tools disabled' };
      try {
        const page = await manager.getPage();
        const html = await page.content();
        // Strip HTML tags for a plain text view
        const text = html
          .replace(/<script[\s\S]*?<\/script>/gi, '')
          .replace(/<style[\s\S]*?<\/style>/gi, '')
          .replace(/<[^>]+>/g, ' ')
          .replace(/\s+/g, ' ')
          .trim();
        const truncated = text.length > 30000 ? text.slice(0, 30000) + '\n[... truncated]' : text;
        return { output: `[${page.url()}]\n${truncated}`, success: true };
      } catch (err) {
        return { output: '', success: false, error: `Snapshot failed: ${err instanceof Error ? err.message : String(err)}` };
      }
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
    async execute(params: unknown, ctx: ToolContext): Promise<ToolResult> {
      if (!config.enabled) return { output: '', success: false, error: 'Browser tools disabled' };
      const { path: outPath } = (params ?? {}) as { path?: string };
      const filePath = outPath ?? '/tmp/tako-screenshot.png';
      try {
        const page = await manager.getPage();
        await page.screenshot({ path: filePath, fullPage: true });
        return { output: `Screenshot saved to ${filePath}`, success: true };
      } catch (err) {
        return { output: '', success: false, error: `Screenshot failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };

  const clickTool: Tool = {
    name: 'browser_click',
    description: 'Click an element on the page by CSS selector.',
    group: 'web',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of element to click' },
      },
      required: ['selector'],
    },
    async execute(params: unknown): Promise<ToolResult> {
      if (!config.enabled) return { output: '', success: false, error: 'Browser tools disabled' };
      const { selector } = params as { selector: string };
      try {
        const page = await manager.getPage();
        await page.click(selector);
        return { output: `Clicked: ${selector}`, success: true };
      } catch (err) {
        return { output: '', success: false, error: `Click failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };

  const typeTool: Tool = {
    name: 'browser_type',
    description: 'Type text into an input field on the page.',
    group: 'web',
    parameters: {
      type: 'object',
      properties: {
        selector: { type: 'string', description: 'CSS selector of input element' },
        text: { type: 'string', description: 'Text to type' },
      },
      required: ['selector', 'text'],
    },
    async execute(params: unknown): Promise<ToolResult> {
      if (!config.enabled) return { output: '', success: false, error: 'Browser tools disabled' };
      const { selector, text } = params as { selector: string; text: string };
      try {
        const page = await manager.getPage();
        await page.fill(selector, text);
        return { output: `Typed into ${selector}: "${text.slice(0, 50)}"`, success: true };
      } catch (err) {
        return { output: '', success: false, error: `Type failed: ${err instanceof Error ? err.message : String(err)}` };
      }
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
      if (!config.enabled) return { output: '', success: false, error: 'Browser tools disabled' };
      const { js } = params as { js: string };
      try {
        const page = await manager.getPage();
        const result = await page.evaluate(js);
        const output = typeof result === 'string' ? result : JSON.stringify(result, null, 2);
        return { output: output ?? '(undefined)', success: true };
      } catch (err) {
        return { output: '', success: false, error: `Evaluate failed: ${err instanceof Error ? err.message : String(err)}` };
      }
    },
  };

  return [navigateTool, snapshotTool, screenshotTool, clickTool, typeTool, evaluateTool];
}
