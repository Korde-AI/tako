/**
 * MessageList — scrollable chat history with styled messages.
 * All content is LEFT-ALIGNED.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';

export interface ChatMessage {
  id: string;
  role: 'user' | 'agent' | 'tool' | 'system' | 'thinking';
  content: string;
  toolName?: string;
  timestamp?: string;
}

export interface MessageListProps {
  messages: ChatMessage[];
  maxVisible?: number;
}

const formatTime = (ts?: string): string => {
  if (!ts) return '';
  const d = new Date(ts);
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
};

const UserMessage: React.FC<{ msg: ChatMessage }> = ({ msg }) => (
  <Box marginY={0} paddingX={1}>
    <Text color={theme.textMuted}>{formatTime(msg.timestamp)} </Text>
    <Text color={theme.userMsg}>{theme.icons.user} </Text>
    <Text color={theme.userMsg}>{msg.content}</Text>
  </Box>
);

const AgentMessage: React.FC<{ msg: ChatMessage }> = ({ msg }) => (
  <Box flexDirection="column" marginY={0} paddingX={1}>
    <Box>
      <Text color={theme.textMuted}>{formatTime(msg.timestamp)} </Text>
      <Text color={theme.agentMsg}>{theme.icons.agent} </Text>
    </Box>
    <Box paddingLeft={3}>
      <Text color={theme.agentMsg}>{msg.content}</Text>
    </Box>
  </Box>
);

const ToolMessage: React.FC<{ msg: ChatMessage }> = ({ msg }) => (
  <Box flexDirection="column" marginY={0} paddingX={1}>
    <Box>
      <Text color={theme.textMuted}>   </Text>
      <Text color={theme.toolCall}>{theme.icons.tool} {msg.toolName ?? 'tool'}</Text>
    </Box>
    <Box paddingLeft={3}>
      <Text color={theme.toolResult}>{msg.content}</Text>
    </Box>
  </Box>
);

const ThinkingMessage: React.FC<{ msg: ChatMessage }> = ({ msg }) => (
  <Box marginY={0} paddingX={1}>
    <Text color={theme.textMuted}>   </Text>
    <Text color={theme.thinking} italic>{theme.icons.thinking} {msg.content}</Text>
  </Box>
);

const SystemMessage: React.FC<{ msg: ChatMessage }> = ({ msg }) => (
  <Box marginY={0} paddingX={1}>
    <Text color={theme.textMuted} dimColor>{theme.icons.system} {msg.content}</Text>
  </Box>
);

export const MessageList: React.FC<MessageListProps> = ({ messages, maxVisible = 20 }) => {
  const visible = messages.slice(-maxVisible);

  return (
    <Box flexDirection="column" flexGrow={1} paddingY={0}>
      {visible.length === 0 ? (
        <Box paddingX={1} paddingY={1}>
          <Text color={theme.textMuted}>
            {theme.icons.agent} Ready. Type a message or /help for commands.
          </Text>
        </Box>
      ) : (
        visible.map((msg) => {
          switch (msg.role) {
            case 'user':
              return <UserMessage key={msg.id} msg={msg} />;
            case 'agent':
              return <AgentMessage key={msg.id} msg={msg} />;
            case 'tool':
              return <ToolMessage key={msg.id} msg={msg} />;
            case 'thinking':
              return <ThinkingMessage key={msg.id} msg={msg} />;
            case 'system':
              return <SystemMessage key={msg.id} msg={msg} />;
            default:
              return null;
          }
        })
      )}
    </Box>
  );
};
