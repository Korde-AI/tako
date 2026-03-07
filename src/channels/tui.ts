/**
 * TUI channel — beautiful Ink-based terminal interface.
 *
 * Implements the Channel interface using an Ink (React) TUI
 * with gradient branding, styled messages, and /command support.
 * Falls back to CLIChannel if the terminal doesn't support it.
 */

import { render, type Instance } from 'ink';
import React from 'react';
import { TuiApp, type AppConfig, type AppCallbacks } from '../tui/App.js';
import type { Channel, InboundMessage, OutboundMessage, MessageHandler } from './channel.js';

export interface AgentInfo {
  id: string;
  description: string;
  role: string;
  isMain: boolean;
}

export interface TuiChannelOptions {
  version?: string;
  model?: string;
  toolCount?: number;
  skillCount?: number;
  toolProfile?: string;
  memoryStatus?: string;
  /** All available models for /models switching */
  availableModels?: string[];
  /** All registered agents for /agent switching */
  agents?: AgentInfo[];
  /** Callback to switch the active model at runtime */
  onModelSwitch?: (modelRef: string) => void;
  /** Callback to switch the active agent at runtime */
  onAgentSwitch?: (agentId: string) => void;
}

export class TUIChannel implements Channel {
  id = 'tui';
  private handlers: MessageHandler[] = [];
  private inkInstance: Instance | null = null;
  private options: TuiChannelOptions;

  constructor(opts?: TuiChannelOptions) {
    this.options = opts ?? {};
  }

  async connect(): Promise<void> {
    const config: AppConfig = {
      version: this.options.version ?? '0.0.1',
      model: this.options.model ?? 'anthropic/claude-sonnet-4',
      toolCount: this.options.toolCount ?? 0,
      skillCount: this.options.skillCount ?? 0,
      channel: 'tui',
      toolProfile: this.options.toolProfile ?? 'full',
      memoryStatus: this.options.memoryStatus ?? 'ready',
      availableModels: this.options.availableModels,
      agents: this.options.agents?.map((a) => ({
        id: a.id,
        description: a.description,
        role: a.role,
        isMain: a.isMain,
      })),
      activeAgent: 'main',
    };

    const callbacks: AppCallbacks & { onAgentSwitch?: (agentId: string) => void } = {
      onMessage: async (text: string) => {
        const msg: InboundMessage = {
          id: crypto.randomUUID(),
          channelId: 'tui',
          author: { id: 'local', name: 'user' },
          content: text,
          timestamp: new Date().toISOString(),
        };

        for (const handler of this.handlers) {
          try {
            await handler(msg);
          } catch (err) {
            // Show error in TUI
            const tui = (globalThis as any).__takoTui;
            if (tui) {
              tui.addMessage({
                id: crypto.randomUUID(),
                role: 'system',
                content: `Error: ${err instanceof Error ? err.message : String(err)}`,
                timestamp: new Date().toISOString(),
              });
              tui.setIsProcessing(false);
            }
          }
        }
      },
      onCommand: async (cmd: string, args: string) => {
        // Route commands as messages with / prefix for the agent loop to handle
        const msg: InboundMessage = {
          id: crypto.randomUUID(),
          channelId: 'tui',
          author: { id: 'local', name: 'user' },
          content: `/${cmd}${args ? ' ' + args : ''}`,
          timestamp: new Date().toISOString(),
        };

        for (const handler of this.handlers) {
          try {
            await handler(msg);
          } catch (err) {
            const tui = (globalThis as any).__takoTui;
            if (tui) {
              tui.addMessage({
                id: crypto.randomUUID(),
                role: 'system',
                content: `Error: ${err instanceof Error ? err.message : String(err)}`,
                timestamp: new Date().toISOString(),
              });
            }
          }
        }
      },
      onModelSwitch: this.options.onModelSwitch,
      onAgentSwitch: this.options.onAgentSwitch,
      onQuit: () => {
        this.disconnect().then(() => process.exit(0));
      },
    };

    // Render the Ink app
    const element = React.createElement(TuiApp, { config, callbacks });
    this.inkInstance = render(element);

    // Wait for the app to exit
    await this.inkInstance.waitUntilExit();
  }

  async disconnect(): Promise<void> {
    this.inkInstance?.unmount();
    this.inkInstance = null;
  }

  async send(msg: OutboundMessage): Promise<void> {
    const tui = (globalThis as any).__takoTui;
    if (!tui) {
      // Fallback: just print
      process.stdout.write(msg.content + '\n');
      return;
    }

    tui.addMessage({
      id: crypto.randomUUID(),
      role: 'agent' as const,
      content: msg.content,
      timestamp: new Date().toISOString(),
    });
    tui.setIsProcessing(false);
  }

  onMessage(handler: MessageHandler): void {
    this.handlers.push(handler);
  }
}
