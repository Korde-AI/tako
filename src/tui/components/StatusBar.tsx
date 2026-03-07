/**
 * StatusBar — minimal bottom status indicator.
 * Only shows token usage when available, otherwise hidden.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';

export interface StatusBarProps {
  channel: string;
  toolProfile: string;
  memoryStatus: string;
  tokenUsage?: { input: number; output: number };
}

const formatTokens = (n: number): string => {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return `${n}`;
};

export const StatusBar: React.FC<StatusBarProps> = ({ tokenUsage }) => {
  if (!tokenUsage || (tokenUsage.input === 0 && tokenUsage.output === 0)) {
    return null;
  }

  return (
    <Box paddingX={1}>
      <Text color={theme.textMuted} dimColor>
        {formatTokens(tokenUsage.input)}↑ {formatTokens(tokenUsage.output)}↓
      </Text>
    </Box>
  );
};
