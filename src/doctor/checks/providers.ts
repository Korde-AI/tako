/**
 * Provider connectivity health check.
 *
 * Checks API key presence and tests actual connectivity
 * by making a minimal API call.
 */

import type { TakoConfig } from '../../config/schema.js';
import type { CheckResult } from '../doctor.js';

export async function checkProviders(config: TakoConfig): Promise<CheckResult> {
  const [providerName] = config.providers.primary.split('/');

  // Check for API keys (including fallback env var names)
  const keyMap: Record<string, string[]> = {
    anthropic: ['ANTHROPIC_API_KEY', 'OPENCLAW_LIVE_ANTHROPIC_KEY', 'ANTHROPIC_API_KEYS'],
    openai: ['OPENAI_API_KEY'],
    litellm: ['LITELLM_API_KEY'],
  };

  const envVars = keyMap[providerName] ?? [];
  const foundKey = envVars.find((v) => process.env[v]);

  if (envVars.length > 0 && !foundKey) {
    return {
      name: 'providers',
      status: 'error',
      message: `Missing API key for "${providerName}". Set one of: ${envVars.join(', ')}`,
      repairable: false,
    };
  }

  // Test actual API connectivity for Anthropic
  if (providerName === 'anthropic' && foundKey) {
    try {
      const apiKey = process.env[foundKey]!;
      // Make a minimal API call to verify the key works
      const response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-haiku-4-5-20251001',
          max_tokens: 1,
          messages: [{ role: 'user', content: 'hi' }],
        }),
        signal: AbortSignal.timeout(10_000),
      });

      if (response.status === 401 || response.status === 403) {
        return {
          name: 'providers',
          status: 'error',
          message: `Anthropic API key invalid (HTTP ${response.status})`,
          repairable: false,
        };
      }

      if (response.status === 429) {
        return {
          name: 'providers',
          status: 'warn',
          message: 'Anthropic API key valid but rate-limited',
          repairable: false,
        };
      }

      // 200 or other non-auth errors mean the key is valid
      return {
        name: 'providers',
        status: 'ok',
        message: `Provider "${providerName}" connected successfully`,
        repairable: false,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('timeout') || msg.includes('abort')) {
        return {
          name: 'providers',
          status: 'warn',
          message: `Provider "${providerName}" key found but API timed out`,
          repairable: false,
        };
      }
      return {
        name: 'providers',
        status: 'warn',
        message: `Provider "${providerName}" key found but connectivity check failed: ${msg}`,
        repairable: false,
      };
    }
  }

  return {
    name: 'providers',
    status: 'ok',
    message: `Provider "${providerName}" key found (${foundKey})`,
    repairable: false,
  };
}
