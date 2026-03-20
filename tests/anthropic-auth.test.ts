import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { rename } from 'node:fs/promises';
import { join } from 'node:path';

import { resolveAuth } from '../src/auth/storage.js';
import { getRuntimePaths } from '../src/core/paths.js';

describe('Anthropic auth resolution', () => {
  it('prefers ANTHROPIC_SETUP_TOKEN from env as setup_token auth', async () => {
    const prevSetup = process.env['ANTHROPIC_SETUP_TOKEN'];
    const prevApi = process.env['ANTHROPIC_API_KEY'];
    const authFile = join(getRuntimePaths().authDir, 'anthropic.json');
    const backupFile = join(getRuntimePaths().authDir, 'anthropic.json.test-backup');
    process.env['ANTHROPIC_SETUP_TOKEN'] = 'sk-ant-oat01-test-token-value';
    delete process.env['ANTHROPIC_API_KEY'];

    try {
      if (existsSync(authFile)) {
        await rename(authFile, backupFile);
      }
      const resolved = await resolveAuth('anthropic');
      assert.ok(resolved);
      assert.equal(resolved?.method, 'setup_token');
      assert.equal(resolved?.token, 'sk-ant-oat01-test-token-value');
      assert.equal(resolved?.source, 'env');
    } finally {
      if (existsSync(backupFile)) {
        await rename(backupFile, authFile);
      }
      if (prevSetup === undefined) delete process.env['ANTHROPIC_SETUP_TOKEN'];
      else process.env['ANTHROPIC_SETUP_TOKEN'] = prevSetup;
      if (prevApi === undefined) delete process.env['ANTHROPIC_API_KEY'];
      else process.env['ANTHROPIC_API_KEY'] = prevApi;
    }
  });
});
