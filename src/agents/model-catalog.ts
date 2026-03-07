/**
 * Per-agent model catalog — cache available models with metadata.
 *
 * Stored at: ~/.tako/agents/<id>/agent/models.json
 *
 * Populated during onboard or when the agent first queries models.
 * Used by Model Picker and /models command.
 * Refresh on demand via `tako models --refresh`.
 */

import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';

// ─── Types ──────────────────────────────────────────────────────────

export type InputModality = 'text' | 'image' | 'audio' | 'video';

export interface ModelEntry {
  id: string;
  contextWindow?: number;
  maxTokens?: number;
  reasoning?: boolean;
  input?: InputModality[];
}

export interface ProviderModels {
  models: ModelEntry[];
  lastRefreshed?: string;
}

export interface ModelCatalog {
  providers: Record<string, ProviderModels>;
}

// ─── Paths ──────────────────────────────────────────────────────────

function getCatalogPath(agentId: string): string {
  return join(homedir(), '.tako', 'agents', agentId, 'agent', 'models.json');
}

// ─── Read / Write ───────────────────────────────────────────────────

export async function loadModelCatalog(agentId: string): Promise<ModelCatalog> {
  const filePath = getCatalogPath(agentId);
  if (!existsSync(filePath)) {
    return { providers: {} };
  }
  try {
    const raw = await readFile(filePath, 'utf-8');
    return JSON.parse(raw) as ModelCatalog;
  } catch {
    return { providers: {} };
  }
}

export async function saveModelCatalog(agentId: string, catalog: ModelCatalog): Promise<void> {
  const filePath = getCatalogPath(agentId);
  const dir = join(filePath, '..');
  await mkdir(dir, { recursive: true });
  await writeFile(filePath, JSON.stringify(catalog, null, 2) + '\n', 'utf-8');
}

/**
 * Update a single provider's model list in the catalog.
 */
export async function updateProviderModels(
  agentId: string,
  provider: string,
  models: ModelEntry[],
): Promise<void> {
  const catalog = await loadModelCatalog(agentId);
  catalog.providers[provider] = {
    models,
    lastRefreshed: new Date().toISOString(),
  };
  await saveModelCatalog(agentId, catalog);
}

/**
 * Get all models across all providers for an agent.
 */
export async function getAllModels(agentId: string): Promise<{ provider: string; model: ModelEntry }[]> {
  const catalog = await loadModelCatalog(agentId);
  const result: { provider: string; model: ModelEntry }[] = [];
  for (const [provider, data] of Object.entries(catalog.providers)) {
    for (const model of data.models) {
      result.push({ provider, model });
    }
  }
  return result;
}

/**
 * Find a specific model by ID across all providers.
 */
export async function findModel(
  agentId: string,
  modelId: string,
): Promise<{ provider: string; model: ModelEntry } | null> {
  const all = await getAllModels(agentId);
  return all.find((m) => m.model.id === modelId) ?? null;
}

/**
 * Seed the catalog with well-known Anthropic models.
 */
export function getDefaultAnthropicModels(): ModelEntry[] {
  return [
    { id: 'claude-sonnet-4-6', contextWindow: 200000, maxTokens: 8192, reasoning: false, input: ['text', 'image'] },
    { id: 'claude-haiku-4-5-20251001', contextWindow: 200000, maxTokens: 8192, reasoning: false, input: ['text', 'image'] },
    { id: 'claude-opus-4-6', contextWindow: 200000, maxTokens: 8192, reasoning: false, input: ['text', 'image'] },
  ];
}
