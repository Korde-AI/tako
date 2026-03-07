/**
 * Tako 🐙 Interactive Onboarding Wizard
 *
 * Multi-provider setup with fallback chain and conversational identity builder:
 *   1. Provider dashboard — configure multiple providers
 *   2. Fallback model chain — up to 4 models
 *   3. Identity builder — conversational SOUL/IDENTITY/USER generation
 *   4. Channel setup — Discord / Telegram (integrated)
 *   5. Write config + workspace files
 */

import * as p from '@clack/prompts';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { TakoConfig, DiscordChannelConfig, TelegramChannelConfig } from '../config/schema.js';
import { DEFAULT_CONFIG } from '../config/schema.js';
import { writeAuthCredential, getAuthStatus, type ApiKeyCredential, type SetupTokenCredential } from '../auth/storage.js';
import { validateAnthropicSetupToken, runOAuthFlow, OAUTH_PROVIDERS } from '../auth/oauth.js';
import { LiteLLMProvider } from '../providers/litellm.js';

// ─── Provider definitions ────────────────────────────────────────────

interface AuthOption {
  value: string;
  label: string;
  hint: string;
}

interface ProviderDef {
  id: string;
  label: string;
  hint: string;
  envVar: string;
  authMethods: AuthOption[];
  models: { value: string; label: string; hint: string }[];
  verify: (apiKey: string) => Promise<{ ok: boolean; error?: string }>;
  /** Fetch available models dynamically from the API. Returns model IDs. */
  fetchModels?: (apiKey: string) => Promise<string[]>;
}

const PROVIDERS: ProviderDef[] = [
  {
    id: 'anthropic',
    label: 'Anthropic (Claude)',
    hint: 'API key or setup-token',
    envVar: 'ANTHROPIC_API_KEY',
    authMethods: [
      { value: 'api_key', label: 'API Key', hint: 'paste ANTHROPIC_API_KEY' },
      { value: 'setup_token', label: 'Setup Token', hint: 'from `claude setup-token`' },
    ],
    models: [
      // Fallback models if API fetch fails
      { value: 'anthropic/claude-sonnet-4-6', label: 'claude-sonnet-4-6', hint: 'fast, recommended' },
      { value: 'anthropic/claude-opus-4-6', label: 'claude-opus-4-6', hint: 'powerful, slower' },
      { value: 'anthropic/claude-haiku-4-5', label: 'claude-haiku-4-5', hint: 'fastest, cheapest' },
    ],
    verify: async (apiKey: string) => {
      const extractError = (body: unknown): string => {
        if (!body || typeof body !== 'object') return 'unknown error';
        const b = body as Record<string, unknown>;
        const e = b.error;
        if (typeof e === 'string') return e;
        if (e && typeof e === 'object') {
          const m = (e as Record<string, unknown>).message;
          if (typeof m === 'string') return m;
          return JSON.stringify(e);
        }
        if (typeof b.message === 'string') return b.message;
        return 'unknown error';
      };

      try {
        const headers: Record<string, string> = {
          'anthropic-version': '2023-06-01',
        };

        // Detect OAuth token vs API key
        if (apiKey.includes('sk-ant-oat')) {
          headers['authorization'] = `Bearer ${apiKey}`;
          headers['anthropic-beta'] = 'claude-code-20250219,oauth-2025-04-20';
        } else {
          headers['x-api-key'] = apiKey;
        }

        // reference runtime-style: verify key with /v1/models first (not model-dependent)
        const modelsRes = await fetch('https://api.anthropic.com/v1/models', { headers });
        if (modelsRes.ok) return { ok: true };
        if (modelsRes.status === 401 || modelsRes.status === 403) {
          return { ok: false, error: 'Invalid API key' };
        }

        // Fallback probe: /v1/messages to differentiate auth vs payload issues
        const msgRes = await fetch('https://api.anthropic.com/v1/messages', {
          method: 'POST',
          headers: { ...headers, 'content-type': 'application/json' },
          body: JSON.stringify({
            model: 'claude-sonnet-4-6',
            max_tokens: 1,
            messages: [{ role: 'user', content: 'hi' }],
          }),
        });

        if (msgRes.ok) return { ok: true };
        if (msgRes.status === 401 || msgRes.status === 403) {
          return { ok: false, error: 'Invalid API key' };
        }
        if (msgRes.status === 400) {
          // Auth is valid; request payload/model may be wrong
          return { ok: true };
        }

        const body = await msgRes.json().catch(() => ({}));
        return { ok: false, error: `API returned ${msgRes.status}: ${extractError(body)}` };
      } catch (err) {
        return { ok: false, error: `Connection failed: ${(err as Error).message}` };
      }
    },
    fetchModels: async (apiKey: string) => {
      try {
        const headers: Record<string, string> = { 'anthropic-version': '2023-06-01' };
        if (apiKey.includes('sk-ant-oat')) {
          headers['authorization'] = `Bearer ${apiKey}`;
          headers['anthropic-beta'] = 'claude-code-20250219,oauth-2025-04-20';
        } else {
          headers['x-api-key'] = apiKey;
        }
        const res = await fetch('https://api.anthropic.com/v1/models', { headers });
        if (!res.ok) return [];
        const data = await res.json() as { data?: { id: string }[] };
        return (data.data ?? []).map((m) => m.id).filter((id) => id.includes('claude'));
      } catch {
        return [];
      }
    },
  },
  {
    id: 'openai',
    label: 'OpenAI (GPT)',
    hint: 'API key or OAuth',
    envVar: 'OPENAI_API_KEY',
    authMethods: [
      { value: 'api_key', label: 'API Key', hint: 'paste OPENAI_API_KEY' },
      { value: 'oauth', label: 'OAuth (Codex)', hint: 'browser login to ChatGPT' },
    ],
    models: [
      // Fallback models if API fetch fails
      { value: 'openai/gpt-5.2', label: 'gpt-5.2', hint: 'latest' },
      { value: 'openai/gpt-5-mini', label: 'gpt-5-mini', hint: 'fast' },
      { value: 'openai-codex/gpt-5.3-codex', label: 'gpt-5.3-codex', hint: 'Codex OAuth, most powerful' },
      { value: 'openai-codex/gpt-5.2-codex', label: 'gpt-5.2-codex', hint: 'Codex OAuth' },
    ],
    verify: async (apiKey: string) => {
      try {
        const res = await fetch('https://api.openai.com/v1/models', {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (res.ok) return { ok: true };
        if (res.status === 401) return { ok: false, error: 'Invalid API key' };
        return { ok: false, error: `API returned ${res.status}` };
      } catch (err) {
        return { ok: false, error: `Connection failed: ${(err as Error).message}` };
      }
    },
    fetchModels: async (apiKey: string) => {
      try {
        const res = await fetch('https://api.openai.com/v1/models', {
          headers: { Authorization: `Bearer ${apiKey}` },
        });
        if (!res.ok) return [];
        const data = await res.json() as { data?: { id: string }[] };
        const NON_CHAT = ['dall-e', 'davinci', 'babbage', 'whisper', 'tts-', 'text-embedding', 'text-moderation', 'canary', 'audio'];
        return (data.data ?? [])
          .map((m) => m.id)
          .filter((id) => !NON_CHAT.some((prefix) => id.startsWith(prefix)))
          .sort((a, b) => {
            // Priority sort: gpt-5 first, then codex, then gpt-4, then rest
            const priority = (m: string) => {
              if (m.includes('gpt-5')) return 0;
              if (m.includes('codex')) return 1;
              if (m.includes('gpt-4o')) return 2;
              if (m.includes('gpt-4')) return 3;
              if (m.includes('o3') || m.includes('o4')) return 4;
              return 5;
            };
            return priority(a) - priority(b) || a.localeCompare(b);
          });
      } catch {
        return [];
      }
    },
  },
  {
    id: 'litellm',
    label: 'LiteLLM (proxy to 100+ providers)',
    hint: 'OpenAI-compatible proxy',
    envVar: 'LITELLM_API_KEY',
    authMethods: [
      { value: 'proxy', label: 'Proxy connection', hint: 'base URL + optional API key' },
    ],
    models: [],
    verify: async (_apiKey: string) => ({ ok: true }),
  },
  {
    id: 'custom',
    label: 'Custom (OpenAI-compatible endpoint)',
    hint: 'Any OpenAI-compatible API',
    envVar: 'CUSTOM_API_KEY',
    authMethods: [
      { value: 'api_key', label: 'API Key', hint: 'paste API key' },
    ],
    models: [],
    verify: async (_apiKey: string) => ({ ok: true }),
  },
];

// ─── State tracked during onboarding ─────────────────────────────────

interface ConfiguredProvider {
  id: string;
  /** How this provider was authenticated. */
  source?: string;
  apiKey?: string;
  litellmEndpointName?: string;
  litellmBaseUrl?: string;
  litellmModel?: string;
  /** All selected models from the LiteLLM proxy */
  litellmModels?: string[];
  customBaseUrl?: string;
}

// ─── Main onboard flow ──────────────────────────────────────────────

export async function runOnboard(): Promise<void> {
  const takoDir = join(homedir(), '.tako');
  const configPath = join(takoDir, 'tako.json');

  p.intro('◉‿◉ Tako Setup');

  // Load existing config if re-running
  let existingConfig: Partial<TakoConfig> = {};
  if (existsSync(configPath)) {
    try {
      existingConfig = JSON.parse(await readFile(configPath, 'utf-8')) as Partial<TakoConfig>;
    } catch { /* ignore invalid config */ }
    p.log.info('Found existing config at ~/.tako/tako.json — you can update it.');
  }

  // ── Step 1: Multi-provider dashboard ──────────────────────────────

  const configured: ConfiguredProvider[] = [];

  // Pre-populate from existing config
  if (existingConfig.providers?.primary) {
    const existingPrimary = existingConfig.providers.primary.split('/')[0];
    if (PROVIDERS.some((prov) => prov.id === existingPrimary) && !configured.some((c) => c.id === existingPrimary)) {
      configured.push({ id: existingPrimary });
    }
  }
  if (existingConfig.providers?.fallback) {
    for (const fb of existingConfig.providers.fallback) {
      const fbProvider = fb.split('/')[0];
      if (PROVIDERS.some((prov) => prov.id === fbProvider) && !configured.some((c) => c.id === fbProvider)) {
        configured.push({ id: fbProvider });
      }
    }
  }
  // Restore LiteLLM config from existing tako.json
  const existingLitellm = (existingConfig.providers as unknown as Record<string, unknown>)?.litellm as { name?: string; baseUrl?: string; apiKey?: string; model?: string; models?: string[] } | undefined;
  if (existingLitellm?.baseUrl) {
    const existing = configured.find((c) => c.id === 'litellm');
    if (existing) {
      // Merge litellm-specific fields into the bare entry added from primary/fallback
      existing.litellmEndpointName = existing.litellmEndpointName ?? existingLitellm.name;
      existing.litellmBaseUrl = existing.litellmBaseUrl ?? existingLitellm.baseUrl;
      existing.apiKey = existing.apiKey ?? existingLitellm.apiKey;
      existing.litellmModel = existing.litellmModel ?? existingLitellm.model;
      existing.litellmModels = existing.litellmModels ?? existingLitellm.models;
    } else {
      configured.push({
        id: 'litellm',
        litellmEndpointName: existingLitellm.name,
        apiKey: existingLitellm.apiKey,
        litellmBaseUrl: existingLitellm.baseUrl,
        litellmModel: existingLitellm.model,
        litellmModels: existingLitellm.models,
      });
    }
  }

  // Also check auth status for all providers
  for (const prov of PROVIDERS) {
    const status = await getAuthStatus(prov.id);
    if (status.authenticated && !configured.some((c) => c.id === prov.id)) {
      const sourceLabel = status.source === 'env' ? 'env var'
        : status.method === 'oauth' ? 'OAuth'
        : status.method === 'setup_token' ? 'setup token'
        : status.method === 'api_key' ? 'API key'
        : 'auth file';
      configured.push({ id: prov.id, source: sourceLabel });
    }
  }

  // Provider dashboard loop
  let providersDone = false;
  while (!providersDone) {
    // Build dashboard display
    const dashLines = PROVIDERS.map((prov) => {
      const conf = configured.find((c) => c.id === prov.id);
      const icon = conf ? '✅' : '⬜';
      const status = conf
        ? `configured (${conf.source ?? 'API key'})`
        : 'not configured';
      return `  ${prov.label.padEnd(35)} ${icon} ${status}`;
    });

    p.log.message(
      ['', '◉‿◉ Tako Provider Setup', '', '  Provider                            Status', '  ' + '─'.repeat(50), ...dashLines, ''].join('\n'),
    );

    const action = await p.select({
      message: 'What would you like to do?',
      options: [
        ...PROVIDERS.map((prov) => {
          const isConfigured = configured.some((c) => c.id === prov.id);
          return {
            value: prov.id,
            label: isConfigured ? `Re-configure ${prov.label}` : `Configure ${prov.label}`,
            hint: prov.hint,
          };
        }),
        { value: '__continue__', label: 'Continue →', hint: configured.length > 0 ? `${configured.length} provider(s) ready` : 'at least 1 provider required' },
      ],
    });

    if (p.isCancel(action)) { p.cancel('Setup cancelled.'); process.exit(0); }

    if (action === '__continue__') {
      if (configured.length === 0) {
        p.log.warn('You need at least one configured provider to continue.');
        continue;
      }
      providersDone = true;
    } else {
      const result = await configureProvider(action);
      if (result) {
        // Replace or add
        const idx = configured.findIndex((c) => c.id === result.id);
        if (idx >= 0) configured[idx] = result;
        else configured.push(result);
        // Debug: show what was saved
        if (result.id === 'litellm') {
          p.log.info(`[debug] LiteLLM saved to configured: baseUrl=${result.litellmBaseUrl}, models=${result.litellmModels?.join(', ')}`);
        }
      }
    }
  }

  // ── Step 2: Fallback model chain ──────────────────────────────────

  // Collect all available models from configured providers
  const modelSpinner = p.spinner();
  modelSpinner.start('Fetching available models from configured providers...');
  const availableModels = await collectAvailableModels(configured);
  modelSpinner.stop(`Found ${availableModels.length} models from ${configured.length} provider(s).`);

  const modelChain: string[] = existingConfig.providers?.primary
    ? [existingConfig.providers.primary, ...(existingConfig.providers.fallback ?? [])]
    : [];

  // Filter out models from providers that are no longer configured
  const configuredIds = new Set(configured.map((c) => c.id));
  const validChain = modelChain.filter((m) => configuredIds.has(m.split('/')[0]));

  // Initialize chain
  const chain: (string | null)[] = [
    validChain[0] ?? null,
    validChain[1] ?? null,
    validChain[2] ?? null,
    validChain[3] ?? null,
  ];

  let chainDone = false;
  while (!chainDone) {
    const labels = ['Primary', 'Fallback', 'Fallback', 'Fallback'];
    const chainLines = chain.map((model, i) => {
      const num = i + 1;
      const label = labels[i];
      const display = model ?? '(none)';
      const icon = model ? '✅' : '';
      return `  ${num}. ${label.padEnd(10)} ${display.padEnd(35)} ${icon}`;
    });

    p.log.message(
      ['', 'Set up your model fallback chain (up to 4):', '', ...chainLines, ''].join('\n'),
    );

    const slotOptions = chain.map((model, i) => ({
      value: String(i),
      label: model ? `Change slot ${i + 1}: ${model}` : `Set slot ${i + 1} (${labels[i]})`,
    }));

    const chainAction = await p.select({
      message: 'What would you like to do?',
      options: [
        ...slotOptions,
        { value: '__continue__', label: 'Continue →', hint: chain[0] ? 'primary model set' : 'primary model required' },
      ],
    });

    if (p.isCancel(chainAction)) { p.cancel('Setup cancelled.'); process.exit(0); }

    if (chainAction === '__continue__') {
      if (!chain[0]) {
        p.log.warn('A primary model is required.');
        continue;
      }
      chainDone = true;
    } else {
      const slotIdx = parseInt(chainAction, 10);
      const modelOptions = availableModels.map((m) => ({
        value: m.value,
        label: m.label,
        hint: m.hint,
      }));

      if (slotIdx > 0) {
        modelOptions.push({ value: '__clear__', label: '(none) — remove this fallback', hint: '' });
      }

      const chosen = await p.select({
        message: `Choose model for slot ${slotIdx + 1}:`,
        options: modelOptions,
      });

      if (p.isCancel(chosen)) continue;

      if (chosen === '__clear__') {
        chain[slotIdx] = null;
      } else if (chosen === '__custom__') {
        const customId = await p.text({
          message: 'Enter model ID (e.g. anthropic/claude-sonnet-4-6):',
          validate: (val) => val?.includes('/') ? undefined : 'Format: provider/model-name',
        });
        if (p.isCancel(customId)) continue;
        chain[slotIdx] = customId;
      } else {
        chain[slotIdx] = chosen;
      }
    }
  }

  const primaryModel = chain[0]!;
  const fallbackModels = chain.slice(1).filter((m): m is string => m !== null);

  // ── Step 3: Conversational identity builder ───────────────────────

  p.log.message('\n◉‿◉ Let\'s get to know each other!\n');

  const ownerName = await p.text({
    message: 'What\'s your name?',
    placeholder: 'Your name',
    validate: (val) => val ? undefined : 'Name is required',
  });
  if (p.isCancel(ownerName)) { p.cancel('Setup cancelled.'); process.exit(0); }

  p.log.info(`Nice to meet you, ${ownerName}!`);

  const agentName = await p.text({
    message: 'What should I call myself?',
    placeholder: 'Tako',
    defaultValue: 'Tako',
    validate: (val) => val ? undefined : 'Name is required',
  });
  if (p.isCancel(agentName)) { p.cancel('Setup cancelled.'); process.exit(0); }

  const personality = await p.text({
    message: 'Any personality traits you\'d like me to have? (Enter to skip)',
    placeholder: 'e.g. Direct, nerdy, proactive',
    defaultValue: '',
  });
  if (p.isCancel(personality)) { p.cancel('Setup cancelled.'); process.exit(0); }

  // ── Step 4: Channel setup ─────────────────────────────────────────

  // Detect existing channel config
  const hasExistingDiscord = !!(existingConfig.channels as Record<string, unknown>)?.discord;
  const hasExistingTelegram = !!(existingConfig.channels as Record<string, unknown>)?.telegram;
  const existingChannels = [
    ...(hasExistingDiscord ? ['Discord'] : []),
    ...(hasExistingTelegram ? ['Telegram'] : []),
  ];

  let discordConfig: DiscordChannelConfig | undefined =
    hasExistingDiscord ? (existingConfig.channels as Record<string, DiscordChannelConfig>).discord : undefined;
  let telegramConfig: TelegramChannelConfig | undefined =
    hasExistingTelegram ? (existingConfig.channels as Record<string, TelegramChannelConfig>).telegram : undefined;

  // Build options based on existing config
  const channelOptions: { value: string; label: string; hint: string }[] = [
    { value: 'keep', label: `Keep current (${existingChannels.length > 0 ? existingChannels.join(' + ') : 'CLI only'})`, hint: 'no changes' },
    { value: 'cli', label: 'CLI only', hint: existingChannels.length > 0 ? 'removes existing channels' : 'start chatting right away' },
    { value: 'discord', label: 'Discord bot', hint: hasExistingDiscord ? 'reconfigure' : 'requires bot token' },
    { value: 'telegram', label: 'Telegram bot', hint: hasExistingTelegram ? 'reconfigure' : 'requires bot token from @BotFather' },
    { value: 'both', label: 'Discord + Telegram', hint: 'set up both' },
  ];

  // Remove 'keep' option if no existing config
  if (!hasExistingDiscord && !hasExistingTelegram) {
    channelOptions.shift();
  }

  const channelChoice = await p.select({
    message: 'Set up messaging channels?',
    options: channelOptions,
  });
  if (p.isCancel(channelChoice)) { p.cancel('Setup cancelled.'); process.exit(0); }

  if (channelChoice === 'keep') {
    // Keep existing — do nothing
  } else if (channelChoice === 'cli') {
    discordConfig = undefined;
    telegramConfig = undefined;
  } else {
    if (channelChoice === 'discord' || channelChoice === 'both') {
      const result = await setupDiscord();
      if (!result) { p.cancel('Setup cancelled.'); process.exit(0); }
      discordConfig = result;
    }
    if (channelChoice === 'telegram' || channelChoice === 'both') {
      const result = await setupTelegram();
      if (!result) { p.cancel('Setup cancelled.'); process.exit(0); }
      telegramConfig = result;
    }
  }

  // ── Step 5: Deployment mode ─────────────────────────────────────

  const deployMode = await p.select({
    message: 'How will you run Tako?',
    options: [
      { value: 'local', label: 'Locally', hint: 'recommended for development' },
      { value: 'docker', label: 'Docker', hint: 'recommended for production/servers' },
    ],
  });
  if (p.isCancel(deployMode)) { p.cancel('Setup cancelled.'); process.exit(0); }

  // ── Step 6: Build config ──────────────────────────────────────────

  // Find litellm config if litellm is configured
  const litellmConfigured = configured.find((c) => c.id === 'litellm');

  // Debug: log litellm config detection
  if (litellmConfigured) {
    p.log.info(`LiteLLM config found: baseUrl=${litellmConfigured.litellmBaseUrl ?? '(none)'}, endpoint=${litellmConfigured.litellmEndpointName ?? '(none)'}, models=${litellmConfigured.litellmModels?.join(', ') ?? '(none)'}`);
  } else if (primaryModel.startsWith('litellm/')) {
    p.log.warn('Primary model uses litellm/ prefix but no LiteLLM provider was configured!');
    p.log.warn('The LiteLLM endpoint config will NOT be saved. Please configure LiteLLM first.');
  }

  // Also scan configured array for any litellm entries with models but no baseUrl
  // This catches the case where litellm models were selected from collectAvailableModels
  // but the user didn't explicitly configure litellm as a provider
  const litellmFromModels = primaryModel.startsWith('litellm/') || fallbackModels.some((m: string) => m.startsWith('litellm/'));
  if (litellmFromModels && !litellmConfigured?.litellmBaseUrl) {
    p.log.warn('⚠ LiteLLM models are in your chain but no LiteLLM endpoint is configured.');
    p.log.warn('  These models will NOT work without a LiteLLM proxy endpoint.');
    p.log.warn('  Go back and configure LiteLLM first, or change your primary model.');
  }

  const config: TakoConfig = {
    ...DEFAULT_CONFIG,
    providers: {
      primary: primaryModel,
      ...(fallbackModels.length > 0 ? { fallback: fallbackModels } : {}),
      ...(litellmConfigured?.litellmBaseUrl ? {
        litellm: {
          name: litellmConfigured.litellmEndpointName || 'LiteLLM',
          baseUrl: litellmConfigured.litellmBaseUrl,
          apiKey: litellmConfigured.apiKey || undefined,
          model: litellmConfigured.litellmModel ?? 'default',
          ...(litellmConfigured.litellmModels && litellmConfigured.litellmModels.length > 1
            ? { models: litellmConfigured.litellmModels }
            : {}),
        },
      } : {}),
    },
    channels: {
      ...(discordConfig ? { discord: discordConfig } : {}),
      ...(telegramConfig ? { telegram: telegramConfig } : {}),
    },
    memory: {
      workspace: '~/.tako/workspace',
    },
  };

  // ── Validate: ensure litellm config is present if litellm models are used ──
  if (config.providers.primary.startsWith('litellm/') && !config.providers.litellm) {
    p.log.error('Your primary model uses LiteLLM but no LiteLLM endpoint was configured!');
    p.log.error('This would result in a broken config. Please go back and configure LiteLLM first.');
    p.log.info(`Debug: configured providers = [${configured.map((c) => `${c.id}(baseUrl=${c.litellmBaseUrl ?? 'none'})`).join(', ')}]`);
    p.cancel('Config validation failed.');
    process.exit(1);
  }

  // ── Step 6: Write config + workspace files ────────────────────────

  const writeSpinner = p.spinner();
  writeSpinner.start('Writing configuration...');

  await mkdir(takoDir, { recursive: true });
  await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');

  // Bootstrap workspace
  const workspaceDir = join(takoDir, 'workspace');
  await mkdir(workspaceDir, { recursive: true });
  await mkdir(join(workspaceDir, 'memory', 'daily'), { recursive: true });
  await mkdir(join(workspaceDir, '.sessions'), { recursive: true });

  // Generate SOUL.md
  const traits = personality ? personality.split(',').map((t) => t.trim()).filter(Boolean) : [];
  const traitSection = traits.length > 0
    ? `\n## Personality\n\n${traits.map((t) => `- **${t}**`).join('\n')}\n`
    : '';
  const soulMd = `# Soul

You are ${agentName} 🐙, a general-purpose AI agent. You can do anything — research, coding, writing, analysis, automation. You're the core OS agent with pluggable skill arms for any task.

Use your name "${agentName}" when introducing yourself. Avoid using emojis excessively — use them sparingly if at all.
${traitSection}
## Approach

- Think step-by-step before multi-step actions
- Use the right tool for each task — don't over-engineer
- Learn from mistakes, store the lesson in memory
- Keep responses focused and relevant
- When uncertain, ask rather than guess
`;

  // Generate IDENTITY.md
  const identityMd = `# Identity

- **Name:** ${agentName}
- **Version:** 0.0.1
- **Type:** Agent OS (Agent-as-CPU architecture)
- **Owner:** ${ownerName}
- **Providers:** ${configured.map((c) => c.id).join(', ')}
- **Primary Model:** ${primaryModel}
- **Channels:** ${['CLI', ...(discordConfig ? ['Discord'] : []), ...(telegramConfig ? ['Telegram'] : [])].join(', ')}
- **Architecture:** Provider → Agent Loop → Tools/Skills → Channel
`;

  // Generate USER.md
  const userMd = `# User Profile

## Owner

- **Name:** ${ownerName}

## Preferences

- (populated over time)
`;

  await writeFile(join(workspaceDir, 'SOUL.md'), soulMd, 'utf-8');
  await writeFile(join(workspaceDir, 'IDENTITY.md'), identityMd, 'utf-8');
  await writeFile(join(workspaceDir, 'USER.md'), userMd, 'utf-8');

  writeSpinner.stop('Config saved to ~/.tako/tako.json');

  // ── Welcome outro ─────────────────────────────────────────────────

  const channels = ['CLI', ...(discordConfig ? ['Discord'] : []), ...(telegramConfig ? ['Telegram'] : [])];
  const fallbackDisplay = fallbackModels.length > 0 ? fallbackModels.join(' → ') : '(none)';

  p.note(
    [
      `Name:     ${agentName}`,
      `Owner:    ${ownerName}`,
      `Model:    ${primaryModel}`,
      `Fallback: ${fallbackDisplay}`,
      `Channels: ${channels.join(', ')}`,
    ].join('\n'),
    '◉‿◉ All set! Here\'s your Tako:',
  );

  if (deployMode === 'docker') {
    p.outro(
      [
        'To run with Docker:',
        '  1. cd to the tako project directory',
        '  2. ./docker-setup.sh   (or: docker compose up -d)',
        '',
        'Gateway will be at http://127.0.0.1:18790',
      ].join('\n'),
    );
  } else {
    p.outro("Run 'tako start' to begin chatting! 🐙");
  }
}

// ─── Provider configuration ──────────────────────────────────────────

async function configureProvider(providerId: string): Promise<ConfiguredProvider | null> {
  const provider = PROVIDERS.find((prov) => prov.id === providerId)!;

  p.log.info(`Configuring ${provider.label}...`);

  if (provider.id === 'litellm') {
    const result = await setupLiteLLM();
    if (!result) return null;
    return { id: 'litellm', apiKey: result.apiKey, litellmEndpointName: result.endpointName, litellmBaseUrl: result.baseUrl, litellmModel: result.model, litellmModels: result.models };
  }

  if (provider.id === 'custom') {
    const baseUrl = await p.text({
      message: 'Enter your API base URL:',
      placeholder: 'https://api.example.com/v1',
      validate: (val) => {
        if (!val) return 'URL is required';
        try { new URL(val); } catch { return 'Invalid URL'; }
        return undefined;
      },
    });
    if (p.isCancel(baseUrl)) return null;

    const keyInput = await p.password({
      message: 'API key (leave empty if none):',
    });
    if (p.isCancel(keyInput)) return null;

    if (keyInput) {
      const credential: ApiKeyCredential = {
        provider: 'custom',
        auth_method: 'api_key',
        api_key: keyInput,
        created_at: Date.now(),
      };
      await writeAuthCredential(credential);
    }

    p.log.success(`Custom provider configured (${baseUrl}).`);
    return { id: 'custom', customBaseUrl: baseUrl };
  }

  // Standard provider (Anthropic, OpenAI)
  let apiKey = '';
  let authMethod = 'api_key';

  if (provider.authMethods.length > 1) {
    const choice = await p.select({
      message: 'How do you want to authenticate?',
      options: provider.authMethods.map((m) => ({
        value: m.value,
        label: m.label,
        hint: m.hint,
      })),
    });
    if (p.isCancel(choice)) return null;
    authMethod = choice;
  }

  if (authMethod === 'oauth') {
    const oauthProviderKey = provider.id === 'openai' ? 'openai-codex' : provider.id;
    if (OAUTH_PROVIDERS[oauthProviderKey]) {
      const result = await runOAuthFlow(oauthProviderKey, {
        log: (msg) => p.log.info(msg),
        prompt: async (message) => {
          const code = await p.text({ message, validate: (v) => v ? undefined : 'Required' });
          if (p.isCancel(code)) return null;
          return code;
        },
      });
      if (!result) return null;
      p.log.success('OAuth authentication successful! Token stored.');
    } else {
      p.log.error(`OAuth not configured for ${provider.id}.`);
      return null;
    }
  } else if (authMethod === 'setup_token') {
    p.log.info('Run `claude setup-token` in another terminal to get a setup token.');
    const tokenInput = await p.password({
      message: 'Paste your setup token:',
      validate: (val) => validateAnthropicSetupToken(val ?? ''),
    });
    if (p.isCancel(tokenInput)) return null;

    const credential: SetupTokenCredential = {
      provider: 'anthropic',
      auth_method: 'setup_token',
      setup_token: tokenInput.trim(),
      created_at: Date.now(),
    };
    await writeAuthCredential(credential);
    apiKey = tokenInput.trim(); // Store for dynamic model fetching
    p.log.success('Setup token stored.');
  } else {
    // API key flow
    apiKey = process.env[provider.envVar] ?? '';

    if (apiKey) {
      const useExisting = await p.confirm({
        message: `Found ${provider.envVar} in environment. Use it?`,
        initialValue: true,
      });
      if (p.isCancel(useExisting)) return null;
      if (!useExisting) apiKey = '';
    }

    if (!apiKey) {
      const keyInput = await p.password({
        message: `Paste your ${provider.label} API key:`,
        validate: (val) => {
          if (!val || val.trim().length === 0) return 'API key is required';
          return undefined;
        },
      });
      if (p.isCancel(keyInput)) return null;
      apiKey = keyInput;
    }

    // Verify key
    const verifySpinner = p.spinner();
    verifySpinner.start('Verifying API key...');
    const verification = await provider.verify(apiKey);

    if (!verification.ok) {
      verifySpinner.stop(`Key verification failed: ${verification.error}`);
      const continueAnyway = await p.confirm({
        message: 'Continue with this key anyway?',
        initialValue: false,
      });
      if (p.isCancel(continueAnyway) || !continueAnyway) return null;
    } else {
      verifySpinner.stop(`Key verified! Connected to ${provider.label}.`);
    }

    // Store credential
    const credential: ApiKeyCredential = {
      provider: provider.id,
      auth_method: 'api_key',
      api_key: apiKey,
      created_at: Date.now(),
    };
    await writeAuthCredential(credential);

    // Also write to .env for backward compat
    const takoDir = join(homedir(), '.tako');
    const envPath = join(takoDir, '.env');
    let envContent = '';
    if (existsSync(envPath)) {
      envContent = await readFile(envPath, 'utf-8');
    }
    const envLine = `${provider.envVar}=${apiKey}`;
    const regex = new RegExp(`^${provider.envVar}=.*$`, 'm');
    if (regex.test(envContent)) {
      envContent = envContent.replace(regex, envLine);
    } else {
      envContent = envContent ? envContent.trimEnd() + '\n' + envLine + '\n' : envLine + '\n';
    }
    await mkdir(takoDir, { recursive: true });
    await writeFile(envPath, envContent, 'utf-8');
  }

  p.log.success(`${provider.label} configured.`);
  return { id: provider.id, apiKey: apiKey || undefined };
}

// ─── Model collection ────────────────────────────────────────────────

async function collectAvailableModels(configured: ConfiguredProvider[]): Promise<{ value: string; label: string; hint: string }[]> {
  const models: { value: string; label: string; hint: string }[] = [];
  for (const cp of configured) {
    const prov = PROVIDERS.find((p) => p.id === cp.id);
    if (!prov) continue;

    // Try to fetch models dynamically from the API
    if (prov.fetchModels && cp.apiKey) {
      try {
        const fetched = await prov.fetchModels(cp.apiKey);
        if (fetched.length > 0) {
          models.push(...fetched.map((m) => ({
            value: `${cp.id}/${m}`,
            label: m,
            hint: cp.id,
          })));
          continue; // Skip hardcoded fallback
        }
      } catch {
        // Fall through to hardcoded models
      }
    }

    // Fallback to hardcoded model list
    if (prov.models.length > 0) {
      models.push(...prov.models);
    } else if (cp.id === 'litellm' && (cp.litellmModels?.length || cp.litellmModel)) {
      const litellmModels = cp.litellmModels ?? (cp.litellmModel ? [cp.litellmModel] : []);
      for (const lm of litellmModels) {
        models.push({ value: `litellm/${lm}`, label: lm, hint: 'LiteLLM proxy' });
      }
    } else if (cp.id === 'custom') {
      models.push({ value: 'custom/default', label: 'custom model', hint: 'custom endpoint' });
    }
  }

  // Add Codex OAuth models if authenticated
  const codexAuth = await getAuthStatus('openai-codex');
  if (codexAuth.authenticated && !models.some((m) => m.value.includes('codex'))) {
    models.push(
      { value: 'openai-codex/gpt-5.3-codex', label: 'gpt-5.3-codex', hint: 'Codex OAuth' },
      { value: 'openai-codex/gpt-5.2-codex', label: 'gpt-5.2-codex', hint: 'Codex OAuth' },
    );
  }

  // Add a "custom model" option at the end
  models.push({ value: '__custom__', label: 'Enter model ID manually', hint: 'provider/model-name' });

  return models;
}

// ─── LiteLLM setup ──────────────────────────────────────────────────

async function setupLiteLLM(): Promise<{ endpointName: string; baseUrl: string; apiKey: string; model: string; models: string[] } | null> {
  // Step 1: Choose endpoint preset or enter custom
  const PRESETS = [
    { value: 'local', label: 'Local LiteLLM (localhost:4000)', hint: 'self-hosted proxy' },
    { value: 'ohmygpt', label: 'OhMyGPT', hint: 'https://api.ohmygpt.com' },
    { value: 'openrouter', label: 'OpenRouter', hint: 'https://openrouter.ai/api' },
    { value: 'together', label: 'Together AI', hint: 'https://api.together.xyz' },
    { value: 'custom', label: 'Custom endpoint...', hint: 'enter URL manually' },
  ];

  const PRESET_URLS: Record<string, string> = {
    local: 'http://localhost:4000',
    ohmygpt: 'https://api.ohmygpt.com',
    openrouter: 'https://openrouter.ai/api',
    together: 'https://api.together.xyz',
  };

  const endpointChoice = await p.select({
    message: 'Choose an endpoint:',
    options: PRESETS,
  });
  if (p.isCancel(endpointChoice)) return null;

  let baseUrl: string;
  let endpointName: string;

  if (endpointChoice === 'custom') {
    const customUrl = await p.text({
      message: 'Endpoint URL:',
      placeholder: 'https://api.example.com/v1',
      validate: (val) => {
        if (!val) return 'URL is required';
        try { new URL(val); } catch { return 'Invalid URL'; }
        return undefined;
      },
    });
    if (p.isCancel(customUrl)) return null;
    baseUrl = customUrl;

    const customName = await p.text({
      message: 'Endpoint name (for display):',
      placeholder: 'my-proxy',
      validate: (val) => val ? undefined : 'Name is required',
    });
    if (p.isCancel(customName)) return null;
    endpointName = customName;
  } else {
    baseUrl = PRESET_URLS[endpointChoice]!;
    endpointName = PRESETS.find((p) => p.value === endpointChoice)!.label;
  }

  // Strip trailing /v1 to avoid double path
  baseUrl = baseUrl.replace(/\/+$/, '').replace(/\/v1$/, '');

  // Step 2: API key
  const apiKey = await p.text({
    message: `API key for ${endpointName} (leave empty if none):`,
    placeholder: '',
    defaultValue: '',
  });
  if (p.isCancel(apiKey)) return null;

  // Test connection
  const testSpinner = p.spinner();
  testSpinner.start('Testing connection...');

  const litellm = new LiteLLMProvider({ baseUrl, apiKey: apiKey || undefined });
  const result = await litellm.testConnection();

  if (result.ok) {
    testSpinner.stop(`Connected! Found ${result.models?.length ?? 0} models on proxy.`);
    if (result.models && result.models.length > 0) {
      p.log.info(`Available models: ${result.models.slice(0, 10).join(', ')}${(result.models.length > 10 ? '...' : '')}`);
    }
  } else {
    testSpinner.stop(`Connection test failed: ${result.error}`);
    const continueAnyway = await p.confirm({
      message: 'Continue anyway?',
      initialValue: false,
    });
    if (p.isCancel(continueAnyway) || !continueAnyway) return null;
  }

  // Choose or enter model name — filter to chat-capable models, show all
  let model: string;
  const NON_CHAT_PREFIXES = ['dall-e', 'davinci', 'babbage', 'whisper', 'tts-', 'text-embedding', 'text-moderation'];
  const chatModels = (result.ok && result.models)
    ? result.models.filter((m) => !NON_CHAT_PREFIXES.some((prefix) => m.startsWith(prefix)))
    : [];

  if (chatModels.length > 0) {
    // Sort: gpt-4o and claude models first, then alphabetical
    const priority = (m: string) => {
      if (m.includes('gpt-4o')) return 0;
      if (m.includes('claude')) return 1;
      if (m.includes('gpt-4')) return 2;
      return 3;
    };
    chatModels.sort((a, b) => priority(a) - priority(b) || a.localeCompare(b));

    const modelChoice = await p.select({
      message: `Choose a model (${chatModels.length} chat models found):`,
      options: [
        ...chatModels.map((m) => ({ value: m, label: m })),
        { value: '__custom__', label: 'Enter model name manually' },
      ],
    });
    if (p.isCancel(modelChoice)) return null;

    if (modelChoice === '__custom__') {
      const customModel = await p.text({
        message: 'Model name:',
        validate: (val) => val ? undefined : 'Model name is required',
      });
      if (p.isCancel(customModel)) return null;
      model = customModel;
    } else {
      model = modelChoice;
    }
  } else {
    const customModel = await p.text({
      message: 'Model name:',
      placeholder: 'gpt-4o',
      validate: (val) => val ? undefined : 'Model name is required',
    });
    if (p.isCancel(customModel)) return null;
    model = customModel;
  }

  // Multi-model selection: ask to add more models from the proxy
  const allModels = [model];
  if (chatModels.length > 1) {
    let addMore = true;
    while (addMore) {
      const wantMore = await p.confirm({
        message: 'Add more models from this proxy?',
        initialValue: false,
      });
      if (p.isCancel(wantMore) || !wantMore) {
        addMore = false;
        break;
      }

      const remaining = chatModels.filter((m) => !allModels.includes(m));
      if (remaining.length === 0) {
        p.log.info('No more models available.');
        break;
      }

      const extraModel = await p.select({
        message: `Add another model (${allModels.length} selected so far):`,
        options: [
          ...remaining.map((m) => ({ value: m, label: m })),
          { value: '__done__', label: 'Done — no more models' },
        ],
      });
      if (p.isCancel(extraModel) || extraModel === '__done__') {
        addMore = false;
      } else {
        allModels.push(extraModel);
        p.log.info(`Added: ${extraModel} (${allModels.length} total)`);
      }
    }
  }

  const modelDisplay = allModels.length > 1
    ? `${allModels.length} models: ${allModels.join(', ')}`
    : `model: ${model}`;
  p.log.success(`${endpointName} configured (${baseUrl}, ${modelDisplay}).`);
  return { endpointName, baseUrl, apiKey: apiKey ?? '', model, models: allModels };
}

// ─── Channel setup helpers ──────────────────────────────────────────

async function setupDiscord(): Promise<DiscordChannelConfig | null> {
  p.log.info([
    'Discord Bot Setup',
    '',
    '  1. Go to https://discord.com/developers/applications',
    '  2. Create a New Application → Bot tab → Copy token',
    '',
    '  Required Bot Permissions (OAuth2 → URL Generator):',
    '    ✦ Send Messages        ✦ Read Message History',
    '    ✦ Create Public Threads ✦ Send Messages in Threads',
    '    ✦ Manage Channels       ✦ Embed Links',
    '    ✦ Attach Files          ✦ Add Reactions',
    '    ✦ Use Slash Commands    ✦ Read Messages/View Channels',
    '',
    '  Required Privileged Intents (Bot tab → toggle ON):',
    '    ✦ MESSAGE CONTENT INTENT (required to read messages)',
    '    ✦ SERVER MEMBERS INTENT  (optional, for member info)',
    '',
    '  Adding bot to server:',
    '    Go to OAuth2 → URL Generator → check "bot" + "applications.commands"',
    '    → select the permissions above → copy the invite URL → open in browser',
  ].join('\n'));

  const token = await p.password({
    message: 'Discord bot token:',
    validate: (val) => val ? undefined : 'Token is required',
  });
  if (p.isCancel(token)) return null;

  // Verify Discord token
  const spinner = p.spinner();
  spinner.start('Verifying Discord token...');
  try {
    const res = await fetch('https://discord.com/api/v10/users/@me', {
      headers: { Authorization: `Bot ${token}` },
    });
    if (res.ok) {
      const bot = await res.json() as { username: string; discriminator: string };
      spinner.stop(`Connected! Bot: ${bot.username}#${bot.discriminator}`);
    } else {
      spinner.stop('Token verification failed. You can fix this later.');
    }
  } catch {
    spinner.stop('Could not reach Discord API. Token saved anyway.');
  }

  const guilds = await p.text({
    message: 'Restrict to specific guild IDs? (comma-separated, or leave empty for all)',
    placeholder: 'Leave empty for all guilds',
    defaultValue: '',
  });
  if (p.isCancel(guilds)) return null;

  return {
    token,
    ...(guilds && guilds.trim() ? { guilds: guilds.split(',').map((g) => g.trim()) } : {}),
  };
}

async function setupTelegram(): Promise<TelegramChannelConfig | null> {
  p.log.info('Telegram Bot Setup — get a token from @BotFather on Telegram');

  const token = await p.password({
    message: 'Telegram bot token:',
    validate: (val) => val ? undefined : 'Token is required',
  });
  if (p.isCancel(token)) return null;

  // Verify Telegram token
  const spinner = p.spinner();
  spinner.start('Verifying Telegram token...');
  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/getMe`);
    if (res.ok) {
      const data = await res.json() as { result: { username: string } };
      spinner.stop(`Connected! Bot: @${data.result.username}`);
    } else {
      spinner.stop('Token verification failed. You can fix this later.');
    }
  } catch {
    spinner.stop('Could not reach Telegram API. Token saved anyway.');
  }

  const allowedUsers = await p.text({
    message: 'Restrict to specific user IDs? (comma-separated, or leave empty for all)',
    placeholder: 'Leave empty to allow all users',
    defaultValue: '',
  });
  if (p.isCancel(allowedUsers)) return null;

  return {
    token,
    ...(allowedUsers && allowedUsers.trim()
      ? { allowedUsers: allowedUsers.split(',').map((u) => u.trim()) }
      : {}),
  };
}
