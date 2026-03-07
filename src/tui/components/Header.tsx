/**
 * Header — Tako 🐙 compact header with cute pixel octopus.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';

export interface HeaderProps {
  version: string;
  model: string;
  toolCount: number;
  skillCount: number;
  activeAgent?: string;
  activeRole?: string;
}

export const Header: React.FC<HeaderProps> = ({ version, model, toolCount, skillCount, activeAgent, activeRole }) => {
  return (
    <Box flexDirection="column" paddingX={1}>
      <Box>
        <Box flexDirection="column" marginRight={1}>
          <Text color={theme.purple}> ▄███▄</Text>
          <Text color={theme.purple}> █ · · █</Text>
          <Text color={theme.purple}>  ▀█▀</Text>
          <Text color={theme.purple}> ▄▀ ▀▄</Text>
        </Box>
        <Box flexDirection="column" justifyContent="center">
          <Text color={theme.purple} bold>Tako <Text color={theme.textMuted}>v{version}</Text></Text>
          <Text color={theme.textMuted}>{model}  {toolCount} tools  {skillCount} skills</Text>
          {activeAgent && activeAgent !== 'main' && (
            <Text color={theme.teal}>◈ {activeAgent} <Text color={theme.textMuted}>[{activeRole ?? 'standard'}]</Text></Text>
          )}
        </Box>
      </Box>
      <Text> </Text>
    </Box>
  );
};
