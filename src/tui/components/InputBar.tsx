/**
 * InputBar — text input with animated tako prompt and tab-completion.
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import TextInput from 'ink-text-input';
import { theme } from '../theme.js';

// Animated tako face — idle blink cycle
const IDLE_FRAMES = ['◉‿◉', '◉‿◉', '◉‿◉', '◉◡◉', '◉_◉', '◉◡◉'];
const IDLE_INTERVAL = 600;

// Animated tako face — thinking wiggle cycle
const BUSY_FRAMES = ['◉~◉', '◉◡◉', '◉~◉', '◉‿◉'];
const BUSY_INTERVAL = 200;

const COMMANDS = [
  { name: '/help', description: 'Show available commands' },
  { name: '/status', description: 'Show runtime status' },
  { name: '/models', description: 'List/switch models' },
  { name: '/model', description: 'Current model info' },
  { name: '/agent', description: 'List/switch agents' },
  { name: '/tools', description: 'List loaded tools' },
  { name: '/skills', description: 'List loaded skills' },
  { name: '/memory', description: 'Memory status' },
  { name: '/session', description: 'Session info' },
  { name: '/clear', description: 'Clear chat history' },
  { name: '/quit', description: 'Exit Tako' },
];

export interface InputBarProps {
  onSubmit: (text: string) => void;
  isProcessing: boolean;
}

export const InputBar: React.FC<InputBarProps> = ({ onSubmit, isProcessing }) => {
  const [value, setValue] = useState('');
  const [showSuggestions, setShowSuggestions] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [frame, setFrame] = useState(0);
  const [inputKey, setInputKey] = useState(0);

  // Animate the tako prompt face
  const frames = isProcessing ? BUSY_FRAMES : IDLE_FRAMES;
  const interval = isProcessing ? BUSY_INTERVAL : IDLE_INTERVAL;

  useEffect(() => {
    setFrame(0);
    const timer = setInterval(() => {
      setFrame((prev) => (prev + 1) % frames.length);
    }, interval);
    return () => clearInterval(timer);
  }, [isProcessing, frames.length, interval]);

  const takoFace = frames[frame % frames.length];

  const suggestions = value.startsWith('/')
    ? COMMANDS.filter((cmd) => cmd.name.startsWith(value.toLowerCase()))
    : [];

  const handleChange = (val: string) => {
    setValue(val);
    // Show suggestions immediately when typing /
    if (val.startsWith('/')) {
      setShowSuggestions(true);
    } else {
      setShowSuggestions(false);
    }
    setSelectedIndex(0);
  };

  const handleSubmit = (val: string) => {
    // If autocomplete is open, ENTER selects the highlighted option
    if (showSuggestions && suggestions.length > 0) {
      const selected = suggestions[selectedIndex];
      if (selected) {
        setValue(selected.name + ' ');
        setInputKey((k) => k + 1);
        setShowSuggestions(false);
        setSelectedIndex(0);
        return;
      }
    }

    if (!val.trim()) return;
    onSubmit(val.trim());
    setValue('');
    setShowSuggestions(false);
    setSelectedIndex(0);
  };

  // Keyboard: TAB for autocomplete, arrows to navigate, ESC to dismiss
  useInput((input, key) => {
    if (key.escape) {
      setShowSuggestions(false);
      return;
    }

    if (key.tab) {
      if (!value.startsWith('/')) return;

      if (!showSuggestions) {
        // First TAB: open autocomplete or complete if only one match
        if (suggestions.length === 1) {
          setValue(suggestions[0].name + ' ');
          setInputKey((k) => k + 1);
          setShowSuggestions(false);
        } else if (suggestions.length > 1) {
          setShowSuggestions(true);
          setSelectedIndex(0);
        }
      } else {
        // Subsequent TABs: cycle through options
        if (suggestions.length > 0) {
          const nextIndex = (selectedIndex + 1) % suggestions.length;
          setSelectedIndex(nextIndex);
          setValue(suggestions[nextIndex].name + ' ');
          setInputKey((k) => k + 1);
        }
      }
      return;
    }

    if (!showSuggestions || suggestions.length === 0) return;

    if (key.upArrow) {
      setSelectedIndex((i) => (i > 0 ? i - 1 : suggestions.length - 1));
    } else if (key.downArrow) {
      setSelectedIndex((i) => (i < suggestions.length - 1 ? i + 1 : 0));
    }
  });

  return (
    <Box flexDirection="column">
      {/* Command autocomplete dropdown */}
      {showSuggestions && suggestions.length > 0 && (
        <Box flexDirection="column" paddingX={1} marginBottom={0}>
          {suggestions.slice(0, 6).map((cmd, i) => (
            <Box key={cmd.name}>
              <Text color={i === selectedIndex ? theme.cyan : theme.textMuted}>
                {i === selectedIndex ? '▸ ' : '  '}
              </Text>
              <Text color={i === selectedIndex ? theme.cyan : theme.textSecondary} bold={i === selectedIndex}>
                {cmd.name}
              </Text>
              <Text color={theme.textMuted}> {cmd.description}</Text>
            </Box>
          ))}
        </Box>
      )}

      {/* Input line with animated tako prompt */}
      <Box paddingX={1}>
        <Text color={isProcessing ? theme.thinking : theme.purple}>
          {takoFace}
        </Text>
        <Text color={isProcessing ? theme.thinking : theme.cyan}>
          {isProcessing ? ' thinking... ' : ' > '}
        </Text>
        {!isProcessing && (
          <TextInput
            key={inputKey}
            value={value}
            onChange={handleChange}
            onSubmit={handleSubmit}
            placeholder="Type a message or /command..."
          />
        )}
      </Box>
    </Box>
  );
};
