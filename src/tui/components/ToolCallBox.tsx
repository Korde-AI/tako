/**
 * ToolCallBox — boxed display for tool invocations and results.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { theme } from '../theme.js';

export interface ToolCallBoxProps {
  toolName: string;
  params?: Record<string, unknown>;
  result?: string;
  status?: 'running' | 'success' | 'error';
}

export const ToolCallBox: React.FC<ToolCallBoxProps> = ({
  toolName,
  params,
  result,
  status = 'success',
}) => {
  const statusIcon = status === 'running' ? theme.icons.toolRun : status === 'success' ? theme.icons.toolOk : theme.icons.toolErr;
  const statusColor = status === 'running' ? theme.thinking : status === 'success' ? theme.success : theme.error;
  const borderColor = status === 'error' ? theme.error : theme.ocean;

  return (
    <Box
      flexDirection="column"
      paddingX={1}
      marginX={2}
      marginY={0}
    >
      {/* ── Header ────────────────────────────────────── */}
      <Box>
        <Text color={statusColor}>{statusIcon} </Text>
        <Text color={theme.toolCall} bold>{theme.icons.tool} {toolName}</Text>
      </Box>

      {/* ── Params (compact) ──────────────────────────── */}
      {params && Object.keys(params).length > 0 && (
        <Box paddingLeft={2}>
          <Text color={theme.textMuted} dimColor>
            {Object.entries(params)
              .map(([k, v]) => `${k}: ${typeof v === 'string' ? v : JSON.stringify(v)}`)
              .join(', ')}
          </Text>
        </Box>
      )}

      {/* ── Result ────────────────────────────────────── */}
      {result && (
        <Box paddingLeft={2} marginTop={0}>
          <Text color={theme.toolResult}>
            {result.length > 200 ? result.slice(0, 200) + '…' : result}
          </Text>
        </Box>
      )}
    </Box>
  );
};
