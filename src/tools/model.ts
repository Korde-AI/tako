/**
 * set_model — agent tool for switching the active LLM model at runtime.
 */

import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import type { Tool, ToolResult, ToolContext } from './tool.js';
import { getRuntimePaths } from '../core/paths.js';

/**
 * Create the set_model tool.
 * Requires a reference to the agent loop's setModel function
 * so it can update the runtime model.
 */
export function createModelTool(deps: {
  setModel: (modelRef: string) => void;
  getModel: () => string;
}): Tool {
  return {
    name: 'set_model',
    description: 'Switch the active LLM model. Use when the user asks to change models or when a task needs a specific model.',
    group: 'runtime',
    parameters: {
      type: 'object',
      properties: {
        model: {
          type: 'string',
          description: 'Model reference (e.g. anthropic/claude-opus-4-6, openai/gpt-5.2, litellm/gemini-3-pro-preview)',
        },
      },
      required: ['model'],
    },
    async execute(params: unknown, _ctx: ToolContext): Promise<ToolResult> {
      const { model } = params as { model: string };

      if (!model || typeof model !== 'string') {
        return { output: 'Error: model parameter is required', success: false };
      }

      if (!model.includes('/')) {
        return {
          output: 'Error: model reference must be in format provider/model (e.g. anthropic/claude-opus-4-6)',
          success: false,
        };
      }

      const previousModel = deps.getModel();

      // Update runtime model
      deps.setModel(model);

      // Persist to tako.json
      const configPath = getRuntimePaths().configFile;
      if (existsSync(configPath)) {
        try {
          const raw = await readFile(configPath, 'utf-8');
          const config = JSON.parse(raw);
          config.providers = { ...config.providers, primary: model };
          await writeFile(configPath, JSON.stringify(config, null, 2) + '\n', 'utf-8');
        } catch {
          // Config write failed — runtime switch still applied
        }
      }

      return {
        output: `Model switched from ${previousModel} to ${model}`,
        success: true,
      };
    },
  };
}
