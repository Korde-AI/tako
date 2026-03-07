/**
 * Tako 🐙 Model Management CLI
 *
 * Commands:
 *   tako models list                        List available models for configured provider
 *   tako models set <model>                 Set active model
 *   tako models auth login --provider X     Interactive auth (API key, setup-token, or OAuth)
 *   tako models auth status                 Show auth status for all providers
 *   tako models auth logout --provider X    Remove stored auth
 *   tako models status                      Show current model + provider status
 */

import * as p from '@clack/prompts';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { TakoConfig } from '../config/schema.js';
import { resolveConfig } from '../config/resolve.js';
import {
  writeAuthCredential,
  removeAuthCredential,
  getAllAuthStatuses,
  getAuthStatus,
  type ApiKeyCredential,
  type SetupTokenCredential,
} from '../auth/storage.js';
import {
  validateAnthropicSetupToken,
  runOAuthFlow,
  OAUTH_PROVIDERS,
} from '../auth/oauth.js';

const PROVIDER_MODELS: Record<string, { value: string; label: string; hint: string }[]> = {
  anthropic: [
    { value: 'anthropic/claude-sonnet-4-6', label: 'claude-sonnet-4-6', hint: 'fast, recommended' },
    { value: 'anthropic/claude-opus-4-6', label: 'claude-opus-4-6', hint: 'powerful, slower' },
    { value: 'anthropic/claude-haiku-4-5', label: 'claude-haiku-4-5', hint: 'fastest, cheapest' },
  ],
  openai: [
    { value: 'openai/gpt-5.2', label: 'gpt-5.2', hint: 'latest, recommended' },
    { value: 'openai/gpt-5-mini', label: 'gpt-5-mini', hint: 'fast, affordable' },
    { value: 'openai/gpt-oss-120b', label: 'gpt-oss-120b', hint: 'open-source tier' },
    { value: 'openai-codex/gpt-5.3-codex', label: 'gpt-5.3-codex', hint: 'Codex OAuth, most powerful' },
    { value: 'openai-codex/gpt-5.2-codex', label: 'gpt-5.2-codex', hint: 'Codex OAuth' },
  ],
  litellm: [
    { value: 'litellm/default', label: 'default', hint: 'uses your LiteLLM config' },
  ],
};

const PROVIDER_ENV_VARS: Record<string, string> = {
  anthropic: 'ANTHROPIC_API_KEY',
  openai: 'OPENAI_API_KEY',
  litellm: 'LITELLM_API_KEY',
  custom: 'CUSTOM_API_KEY',
};

// Auth methods per provider
const PROVIDER_AUTH_METHODS: Record<string, { value: string; label: string; hint: string }[]> = {
  anthropic: [
    { value: 'api_key', label: 'API Key', hint: 'paste ANTHROPIC_API_KEY' },
    { value: 'setup_token', label: 'Setup Token', hint: 'from `claude setup-token`' },
  ],
  openai: [
    { value: 'api_key', label: 'API Key', hint: 'paste OPENAI_API_KEY' },
    { value: 'oauth', label: 'OAuth (Codex)', hint: 'browser login to ChatGPT' },
  ],
  'openai-codex': [
    { value: 'oauth', label: 'OAuth (Codex)', hint: 'browser login to ChatGPT' },
  ],
};

// ─── Config file helpers ─────────────────────────────────────────────

function getConfigPath(): string {
  return join(homedir(), '.tako', 'tako.json');
}

async function loadConfigFile(): Promise<Partial<TakoConfig>> {
  const configPath = getConfigPath();
  if (!existsSync(configPath)) return {};
  const raw = await readFile(configPath, 'utf-8');
  return JSON.parse(raw) as Partial<TakoConfig>;
}

async function saveConfigFile(config: Partial<TakoConfig>): Promise<void> {
  const configPath = getConfigPath();
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
}

// ─── Commands ────────────────────────────────────────────────────────

export async function runModels(args: string[]): Promise<void> {
  const subcommand = args[0] ?? 'status';

  switch (subcommand) {
    case 'list':
      await modelsList();
      break;
    case 'set':
      await modelsSet(args[1]);
      break;
    case 'auth':
      await modelsAuthRouter(args.slice(1));
      break;
    case 'status':
      await modelsStatus();
      break;
    case 'refresh':
      await modelsRefresh();
      break;
    case 'fallbacks':
      await modelsFallbacks(args.slice(1));
      break;
    case 'aliases':
      await modelsAliases(args.slice(1));
      break;
    default:
      console.error(`Unknown models subcommand: ${subcommand}`);
      console.error('Available: list, set, auth, status, refresh, fallbacks, aliases');
      process.exit(1);
  }
}

// ─── Models refresh ──────────────────────────────────────────────────

async function modelsRefresh(): Promise<void> {
  const config = await resolveConfig();
  const { loadModelCatalog, saveModelCatalog } = await import('../agents/model-catalog.js');
  const catalog = await loadModelCatalog('main');

  // Re-stamp the provider models with current timestamp
  const provider = config.providers.primary.split('/')[0] ?? 'anthropic';
  const knownModels = PROVIDER_MODELS[provider] ?? [];

  if (knownModels.length > 0) {
    catalog.providers[provider] = {
      models: knownModels.map((m) => ({ id: m.value })),
      lastRefreshed: new Date().toISOString(),
    };
    await saveModelCatalog('main', catalog);
    console.log(`Refreshed ${knownModels.length} models for provider: ${provider}`);
  } else {
    console.log(`No known models for provider: ${provider}`);
  }

  // Show last refresh times
  for (const [prov, data] of Object.entries(catalog.providers)) {
    console.log(`  ${prov}: ${data.models.length} models (last refresh: ${data.lastRefreshed ?? 'unknown'})`);
  }
}

// ─── Models fallbacks ────────────────────────────────────────────────

async function modelsFallbacks(args: string[]): Promise<void> {
  const config = await resolveConfig();

  if (args.length === 0 || args[0] === 'show') {
    // Show current fallback chain
    console.log(`Primary model: ${config.providers.primary}`);
    if (config.providers.fallback && config.providers.fallback.length > 0) {
      console.log(`Fallback chain:`);
      for (let i = 0; i < config.providers.fallback.length; i++) {
        console.log(`  ${i + 1}. ${config.providers.fallback[i]}`);
      }
    } else {
      console.log('No fallback models configured.');
      console.log('\nSet fallbacks: tako models fallbacks set model1,model2');
    }
    return;
  }

  if (args[0] === 'set') {
    const models = args[1];
    if (!models) {
      console.error('Usage: tako models fallbacks set <model1,model2,...>');
      console.error('  Example: tako models fallbacks set anthropic/claude-haiku-4-5,anthropic/claude-sonnet-4-6');
      process.exit(1);
    }
    const chain = models.split(',').map((m) => m.trim());
    const { patchConfig: patchCfg } = await import('../config/resolve.js');
    await patchCfg({ providers: { fallback: chain } });
    console.log(`Fallback chain set: ${chain.join(' → ')}`);
    return;
  }

  console.error('Usage: tako models fallbacks [show|set <models>]');
  process.exit(1);
}

// ─── Models aliases ──────────────────────────────────────────────────

async function modelsAliases(args: string[]): Promise<void> {
  const config = await resolveConfig();
  const overrides = (config.providers.overrides ?? {}) as Record<string, Record<string, unknown>>;
  const aliases = (overrides._aliases ?? {}) as Record<string, string>;

  if (args.length === 0 || args[0] === 'list') {
    if (Object.keys(aliases).length === 0) {
      console.log('No model aliases configured.');
      console.log('\nAdd one: tako models aliases set opus anthropic/claude-opus-4-6');
      return;
    }
    console.log('Model aliases:\n');
    for (const [alias, model] of Object.entries(aliases)) {
      console.log(`  ${alias} → ${model}`);
    }
    return;
  }

  if (args[0] === 'set') {
    const alias = args[1];
    const model = args[2];
    if (!alias || !model) {
      console.error('Usage: tako models aliases set <alias> <model>');
      console.error('  Example: tako models aliases set opus anthropic/claude-opus-4-6');
      process.exit(1);
    }
    aliases[alias] = model;
    const { patchConfig: patchCfg } = await import('../config/resolve.js');
    await patchCfg({ providers: { overrides: { _aliases: aliases } } });
    console.log(`Alias set: ${alias} → ${model}`);
    return;
  }

  if (args[0] === 'remove') {
    const alias = args[1];
    if (!alias) {
      console.error('Usage: tako models aliases remove <alias>');
      process.exit(1);
    }
    delete aliases[alias];
    const { patchConfig: patchCfg } = await import('../config/resolve.js');
    await patchCfg({ providers: { overrides: { _aliases: aliases } } });
    console.log(`Alias removed: ${alias}`);
    return;
  }

  console.error('Usage: tako models aliases [list|set <alias> <model>|remove <alias>]');
  process.exit(1);
}

// ─── Auth subcommand router ──────────────────────────────────────────

async function modelsAuthRouter(args: string[]): Promise<void> {
  const action = args[0] ?? 'status';

  // Parse --provider flag
  let providerName: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--provider' && args[i + 1]) {
      providerName = args[i + 1];
    }
  }

  switch (action) {
    case 'login':
      await authLogin(providerName);
      break;
    case 'logout':
      await authLogout(providerName);
      break;
    case 'status':
      await authStatus();
      break;
    default:
      // Legacy: `tako models auth <provider>` still works
      if (action && !action.startsWith('-')) {
        await authLogin(action);
      } else {
        await authStatus();
      }
  }
}

// ─── Auth login ──────────────────────────────────────────────────────

async function authLogin(providerName?: string): Promise<void> {
  if (!providerName) {
    const choice = await p.select({
      message: 'Choose a provider to authenticate',
      options: [
        { value: 'anthropic', label: 'Anthropic', hint: 'API key or setup-token' },
        { value: 'openai', label: 'OpenAI', hint: 'API key or OAuth' },
        { value: 'openai-codex', label: 'OpenAI Codex (OAuth)', hint: 'browser login' },
        { value: 'litellm', label: 'LiteLLM', hint: 'proxy API key' },
        { value: 'custom', label: 'Custom', hint: 'OpenAI-compatible' },
      ],
    });
    if (p.isCancel(choice)) { p.cancel('Cancelled.'); process.exit(0); }
    providerName = choice;
  }

  // Choose auth method if multiple available
  const authMethods = PROVIDER_AUTH_METHODS[providerName];
  let authMethod = 'api_key';

  if (authMethods && authMethods.length > 1) {
    const choice = await p.select({
      message: 'How do you want to authenticate?',
      options: authMethods.map((m) => ({
        value: m.value,
        label: m.label,
        hint: m.hint,
      })),
    });
    if (p.isCancel(choice)) { p.cancel('Cancelled.'); process.exit(0); }
    authMethod = choice;
  } else if (authMethods && authMethods.length === 1) {
    authMethod = authMethods[0].value;
  }

  // Execute auth method
  if (authMethod === 'oauth') {
    const oauthKey = providerName === 'openai' ? 'openai-codex' : providerName;
    if (!OAUTH_PROVIDERS[oauthKey]) {
      console.error(`OAuth not configured for ${providerName}.`);
      process.exit(1);
    }

    const result = await runOAuthFlow(oauthKey, {
      log: (msg) => console.log(msg),
      prompt: async (message) => {
        const code = await p.text({ message, validate: (v) => v ? undefined : 'Required' });
        if (p.isCancel(code)) return null;
        return code;
      },
    });

    if (result) {
      console.log(`\nOAuth authentication successful for ${providerName}!`);
      console.log(`Token stored in ~/.tako/auth/${oauthKey}.json`);
    }
    return;
  }

  if (authMethod === 'setup_token') {
    p.log.info('Run `claude setup-token` in another terminal to get a setup token.');
    const tokenInput = await p.password({
      message: 'Paste your setup token:',
      validate: (val) => validateAnthropicSetupToken(val ?? ''),
    });
    if (p.isCancel(tokenInput)) { p.cancel('Cancelled.'); process.exit(0); }

    const credential: SetupTokenCredential = {
      provider: 'anthropic',
      auth_method: 'setup_token',
      setup_token: tokenInput.trim(),
      created_at: Date.now(),
    };
    await writeAuthCredential(credential);
    console.log('\nSetup token stored in ~/.tako/auth/anthropic.json');
    return;
  }

  // Standard API key flow
  const envVar = PROVIDER_ENV_VARS[providerName] ?? `${providerName.toUpperCase()}_API_KEY`;

  if (process.env[envVar]) {
    console.log(`${envVar} is already set in your environment.`);
    const replace = await p.confirm({
      message: 'Replace it in ~/.tako/auth/?',
      initialValue: false,
    });
    if (p.isCancel(replace) || !replace) return;
  }

  const apiKey = await p.password({
    message: `Enter your ${providerName} API key:`,
    validate: (val) => val ? undefined : 'API key is required',
  });
  if (p.isCancel(apiKey)) { p.cancel('Cancelled.'); process.exit(0); }

  // Store in auth file
  const credential: ApiKeyCredential = {
    provider: providerName,
    auth_method: 'api_key',
    api_key: apiKey,
    created_at: Date.now(),
  };
  await writeAuthCredential(credential);

  // Also save to .env for backward compat
  const takoDir = join(homedir(), '.tako');
  const envPath = join(takoDir, '.env');
  let envContent = '';
  if (existsSync(envPath)) {
    envContent = await readFile(envPath, 'utf-8');
  }

  const envLine = `${envVar}=${apiKey}`;
  const regex = new RegExp(`^${envVar}=.*$`, 'm');
  if (regex.test(envContent)) {
    envContent = envContent.replace(regex, envLine);
  } else {
    envContent = envContent ? envContent.trimEnd() + '\n' + envLine + '\n' : envLine + '\n';
  }
  await writeFile(envPath, envContent, 'utf-8');

  console.log(`\nAPI key saved to ~/.tako/auth/${providerName}.json and ~/.tako/.env`);
}

// ─── Auth logout ─────────────────────────────────────────────────────

async function authLogout(providerName?: string): Promise<void> {
  if (!providerName) {
    const choice = await p.select({
      message: 'Choose a provider to log out from',
      options: [
        { value: 'anthropic', label: 'Anthropic' },
        { value: 'openai', label: 'OpenAI' },
        { value: 'openai-codex', label: 'OpenAI Codex' },
        { value: 'litellm', label: 'LiteLLM' },
      ],
    });
    if (p.isCancel(choice)) { p.cancel('Cancelled.'); process.exit(0); }
    providerName = choice;
  }

  const removed = await removeAuthCredential(providerName);
  if (removed) {
    console.log(`Auth credentials removed for ${providerName}.`);
  } else {
    console.log(`No stored credentials found for ${providerName}.`);
  }

  // Note about env vars
  const envVar = PROVIDER_ENV_VARS[providerName] ?? `${providerName.toUpperCase()}_API_KEY`;
  if (process.env[envVar]) {
    console.log(`Note: ${envVar} is still set in your environment. Unset it manually if needed.`);
  }
}

// ─── Auth status ─────────────────────────────────────────────────────

async function authStatus(): Promise<void> {
  console.log('Tako 🐙 Auth Status\n');

  const statuses = await getAllAuthStatuses();

  for (const status of statuses) {
    const icon = status.authenticated ? '✓' : '✗';
    const methodLabel = status.method ?? 'none';
    const sourceLabel = status.source
      ? ` (${status.source.replace('_', ' ')})`
      : '';
    const expiryLabel = status.expired
      ? ' [EXPIRED]'
      : status.expires_at
        ? ` [expires ${new Date(status.expires_at * 1000).toLocaleDateString()}]`
        : '';

    console.log(`  ${icon} ${status.provider}: ${status.authenticated ? 'authenticated' : 'not configured'} — ${methodLabel}${sourceLabel}${expiryLabel}`);
  }

  console.log('\nUse `tako models auth login --provider <name>` to authenticate.');
  console.log('Use `tako models auth logout --provider <name>` to remove credentials.');
}

// ─── Models list / set / status (unchanged) ──────────────────────────

async function modelsList(): Promise<void> {
  const config = await resolveConfig();
  const [providerName] = config.providers.primary.split('/');

  console.log(`Provider: ${providerName}\n`);

  const models = PROVIDER_MODELS[providerName];
  if (!models) {
    console.log(`No predefined models for provider "${providerName}".`);
    console.log(`Current model: ${config.providers.primary}`);
    return;
  }

  const current = config.providers.primary;
  for (const m of models) {
    const marker = m.value === current ? '●' : '○';
    console.log(`  ${marker} ${m.label} (${m.hint})`);
  }
  console.log(`\nUse 'tako models set <provider/model>' to change.`);
}

async function modelsSet(modelRef?: string): Promise<void> {
  if (!modelRef) {
    // Interactive selection
    const config = await resolveConfig();
    const [providerName] = config.providers.primary.split('/');
    const models = PROVIDER_MODELS[providerName];

    if (!models || models.length === 0) {
      console.error('No models available. Specify model directly: tako models set <provider/model>');
      process.exit(1);
    }

    const choice = await p.select({
      message: 'Choose a model',
      options: models.map((m) => ({
        value: m.value,
        label: m.label,
        hint: m.hint,
      })),
    });
    if (p.isCancel(choice)) { p.cancel('Cancelled.'); process.exit(0); }
    modelRef = choice;
  }

  if (!modelRef.includes('/')) {
    console.error('Model reference must be in format: provider/model');
    console.error('Example: anthropic/claude-sonnet-4-6');
    process.exit(1);
  }

  const fileConfig = await loadConfigFile();
  fileConfig.providers = { ...fileConfig.providers, primary: modelRef };
  await saveConfigFile(fileConfig);
  console.log(`Model set to: ${modelRef}`);
}

async function modelsStatus(): Promise<void> {
  const config = await resolveConfig();
  const [providerName, modelName] = config.providers.primary.split('/');

  console.log('Tako 🐙 Model Status\n');
  console.log(`Provider: ${providerName}`);
  console.log(`Model:    ${modelName}`);
  if (config.providers.fallback?.length) {
    console.log(`Fallback: ${config.providers.fallback.join(' → ')}`);
  }

  // Show auth status for current provider
  const status = await getAuthStatus(providerName);
  const icon = status.authenticated ? '✓' : '✗';
  const methodLabel = status.method ?? 'none';
  const sourceLabel = status.source ? ` (${status.source.replace('_', ' ')})` : '';
  console.log(`\nAuth: ${icon} ${status.authenticated ? 'authenticated' : 'not configured'} — ${methodLabel}${sourceLabel}`);

  if (!status.authenticated) {
    console.log(`\nRun \`tako models auth login --provider ${providerName}\` to authenticate.`);
  }

  // LiteLLM-specific status
  if (providerName === 'litellm' && config.providers.litellm) {
    console.log(`\nLiteLLM proxy: ${config.providers.litellm.baseUrl}`);
    console.log(`LiteLLM model: ${config.providers.litellm.model}`);
  }
}
