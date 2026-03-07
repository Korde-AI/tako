/**
 * Browser layer health check.
 *
 * Verifies Playwright runtime import and best-effort browser binary availability.
 */

import { existsSync } from 'node:fs';
import type { TakoConfig } from '../../config/schema.js';
import type { CheckResult } from '../doctor.js';

export async function checkBrowser(config: TakoConfig): Promise<CheckResult> {
  if (config.tools.browser?.enabled === false) {
    return {
      name: 'browser',
      status: 'ok',
      message: 'Browser layer disabled by config',
      repairable: false,
    };
  }

  let playwright: any;
  try {
    playwright = await (Function('return import("playwright-core")')() as Promise<any>);
  } catch {
    return {
      name: 'browser',
      status: 'warn',
      message: 'playwright-core not installed (install: npm i playwright-core)',
      repairable: false,
    };
  }

  try {
    const path = playwright.chromium.executablePath();
    if (!path || !existsSync(path)) {
      return {
        name: 'browser',
        status: 'warn',
        message: 'Playwright imported but Chromium binary not found (run: npx playwright install chromium)',
        repairable: false,
      };
    }
    return {
      name: 'browser',
      status: 'ok',
      message: `Browser layer ready (chromium: ${path})`,
      repairable: false,
    };
  } catch (err) {
    return {
      name: 'browser',
      status: 'warn',
      message: `Playwright available but browser binary check failed: ${err instanceof Error ? err.message : String(err)}`,
      repairable: false,
    };
  }
}
