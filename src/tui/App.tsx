/**
 * App — Main Tako 🐙 TUI application.
 *
 * Composes Header, MessageList, InputBar, and StatusBar into
 * a full-screen terminal interface.
 */

import React, { useState, useCallback } from 'react';
import { Box, useApp } from 'ink';
import { Header } from './components/Header.js';
import { MessageList, type ChatMessage } from './components/MessageList.js';
import { InputBar } from './components/InputBar.js';
import { StatusBar } from './components/StatusBar.js';

export interface AgentChoice {
  id: string;
  description: string;
  role: string;
  isMain: boolean;
}

export interface AppConfig {
  version: string;
  model: string;
  toolCount: number;
  skillCount: number;
  channel: string;
  toolProfile: string;
  memoryStatus: string;
  /** All available models for /models switching */
  availableModels?: string[];
  /** All registered agents for /agent switching */
  agents?: AgentChoice[];
  /** Currently active agent ID */
  activeAgent?: string;
}

export interface AppCallbacks {
  onMessage: (text: string) => void;
  onCommand: (cmd: string, args: string) => void;
  onQuit: () => void;
  /** Switch active model at runtime. */
  onModelSwitch?: (modelRef: string) => void;
  /** Switch active agent at runtime. */
  onAgentSwitch?: (agentId: string) => void;
}

export interface TuiAppProps {
  config: AppConfig;
  callbacks: AppCallbacks;
}

export const TuiApp: React.FC<TuiAppProps> = ({ config, callbacks }) => {
  const { exit } = useApp();
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [tokenUsage, setTokenUsage] = useState<{ input: number; output: number } | undefined>();
  const [currentModel, setCurrentModel] = useState(config.model);
  const [activeAgent, setActiveAgent] = useState(config.activeAgent ?? 'main');
  const [activeRole, setActiveRole] = useState('admin');

  const addMessage = useCallback((msg: ChatMessage) => {
    setMessages((prev) => [...prev, msg]);
  }, []);

  const clearMessages = useCallback(() => {
    setMessages([]);
  }, []);

  const handleSubmit = useCallback((text: string) => {
    // Handle /commands
    if (text.startsWith('/')) {
      const [cmd, ...rest] = text.slice(1).split(/\s+/);
      const args = rest.join(' ');

      if (cmd === 'quit' || cmd === 'exit') {
        callbacks.onQuit();
        exit();
        return;
      }

      if (cmd === 'new') {
        clearMessages();
        addMessage({
          id: crypto.randomUUID(),
          role: 'system',
          content: 'New session started',
          timestamp: new Date().toISOString(),
        });
        callbacks.onCommand('new', args);
        return;
      }

      if (cmd === 'clear') {
        clearMessages();
        addMessage({
          id: crypto.randomUUID(),
          role: 'system',
          content: 'Chat cleared',
          timestamp: new Date().toISOString(),
        });
        return;
      }

      if (cmd === 'help') {
        addMessage({
          id: crypto.randomUUID(),
          role: 'system',
          content: [
            'Available commands:',
            '  /help     — Show this help',
            '  /new      — Start a new session',
            '  /status   — Runtime status',
            '  /models   — List/switch models',
            '  /model    — Current model info',
            '  /agent    — List/switch agents',
            '  /skills   — List skills',
            '  /memory   — Memory status',
            '  /session  — Session info',
            '  /tools    — List tools',
            '  /clear    — Clear chat',
            '  /quit     — Exit Tako',
          ].join('\n'),
          timestamp: new Date().toISOString(),
        });
        return;
      }

      if (cmd === 'status') {
        addMessage({
          id: crypto.randomUUID(),
          role: 'system',
          content: [
            `Model: ${currentModel}`,
            `Tools: ${config.toolCount}`,
            `Skills: ${config.skillCount}`,
            `Channel: ${config.channel}`,
            `Profile: ${config.toolProfile}`,
            `Memory: ${config.memoryStatus}`,
          ].join('\n'),
          timestamp: new Date().toISOString(),
        });
        return;
      }

      if (cmd === 'model') {
        addMessage({
          id: crypto.randomUUID(),
          role: 'system',
          content: `Current model: ${currentModel}`,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      if (cmd === 'models') {
        if (args) {
          // Switch model: /models <ref> or /models <number>
          const models = config.availableModels ?? [config.model];
          const idx = parseInt(args, 10);
          let target: string | undefined;
          if (!isNaN(idx) && idx >= 1 && idx <= models.length) {
            target = models[idx - 1];
          } else if (args.includes('/')) {
            target = args;
          } else {
            // Try matching partial name
            target = models.find((m) => m.includes(args));
          }
          if (target) {
            callbacks.onModelSwitch?.(target);
            addMessage({
              id: crypto.randomUUID(),
              role: 'system',
              content: `Model switched to ${target}`,
              timestamp: new Date().toISOString(),
            });
          } else {
            addMessage({
              id: crypto.randomUUID(),
              role: 'system',
              content: `Model not found: ${args}. Use /models to see available models.`,
              timestamp: new Date().toISOString(),
            });
          }
        } else {
          // List models
          const models = config.availableModels ?? [config.model];
          const lines = models.map((m, i) =>
            `  ${i + 1}. ${m}${m === currentModel ? '  ← current' : ''}`
          );
          addMessage({
            id: crypto.randomUUID(),
            role: 'system',
            content: ['Available models:', ...lines, '', 'Switch: /models 2 or /models openai/gpt-5.2'].join('\n'),
            timestamp: new Date().toISOString(),
          });
        }
        return;
      }

      if (cmd === 'agent' || cmd === 'agents') {
        const agents = config.agents ?? [];
        if (args) {
          // Switch agent
          const target = agents.find((a) => a.id === args) ?? agents[parseInt(args, 10) - 1];
          if (target) {
            callbacks.onAgentSwitch?.(target.id);
            setActiveAgent(target.id);
            setActiveRole(target.role);
            addMessage({
              id: crypto.randomUUID(),
              role: 'system',
              content: `Switched to agent: ${target.id} (${target.role})`,
              timestamp: new Date().toISOString(),
            });
          } else {
            addMessage({
              id: crypto.randomUUID(),
              role: 'system',
              content: `Agent not found: ${args}. Use /agent to see available agents.`,
              timestamp: new Date().toISOString(),
            });
          }
        } else {
          // List agents
          if (agents.length === 0) {
            addMessage({
              id: crypto.randomUUID(),
              role: 'system',
              content: 'No agents registered. Use the root agent to create agents.',
              timestamp: new Date().toISOString(),
            });
          } else {
            const lines = agents.map((a, i) =>
              `  ${i + 1}. ${a.id} [${a.role}]${a.isMain ? ' ← root' : ''}${a.id === config.activeAgent ? ' ← active' : ''}\n     ${a.description || '(no description)'}`
            );
            addMessage({
              id: crypto.randomUUID(),
              role: 'system',
              content: ['Registered agents:', ...lines, '', 'Switch: /agent 2 or /agent research-bot'].join('\n'),
              timestamp: new Date().toISOString(),
            });
          }
        }
        return;
      }

      if (cmd === 'tools') {
        addMessage({
          id: crypto.randomUUID(),
          role: 'system',
          content: `${config.toolCount} tools loaded (profile: ${config.toolProfile})`,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      if (cmd === 'skills') {
        addMessage({
          id: crypto.randomUUID(),
          role: 'system',
          content: `${config.skillCount} skills loaded`,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      if (cmd === 'memory') {
        addMessage({
          id: crypto.randomUUID(),
          role: 'system',
          content: `Memory: ${config.memoryStatus}`,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      if (cmd === 'session') {
        addMessage({
          id: crypto.randomUUID(),
          role: 'system',
          content: `Channel: ${config.channel}\nMessages: ${messages.length}`,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Unknown command — show error locally, don't send to agent
      addMessage({
        id: crypto.randomUUID(),
        role: 'system',
        content: `Unknown command: /${cmd}. Type /help for available commands.`,
        timestamp: new Date().toISOString(),
      });
      return;
    }

    // Regular message
    addMessage({
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      timestamp: new Date().toISOString(),
    });

    setIsProcessing(true);
    callbacks.onMessage(text);
  }, [callbacks, exit, addMessage, clearMessages]);

  // Expose methods for the TUI channel to call
  (globalThis as any).__takoTui = {
    addMessage,
    clearMessages,
    setIsProcessing,
    setTokenUsage,
  };

  return (
    <Box flexDirection="column" height="100%">
      {/* ── Header ───────────────────────────────────────── */}
      <Header
        version={config.version}
        model={currentModel}
        toolCount={config.toolCount}
        skillCount={config.skillCount}
        activeAgent={activeAgent}
        activeRole={activeRole}
      />

      {/* ── Message area ─────────────────────────────────── */}
      <MessageList messages={messages} />

      {/* ── Input ────────────────────────────────────────── */}
      <InputBar onSubmit={handleSubmit} isProcessing={isProcessing} />

      <StatusBar
        channel={config.channel}
        toolProfile={config.toolProfile}
        memoryStatus={config.memoryStatus}
        tokenUsage={tokenUsage}
      />
    </Box>
  );
};
