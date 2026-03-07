/**
 * Spinner — octopus-themed loading animation.
 */

import React, { useState, useEffect } from 'react';
import { Text } from 'ink';
import { theme } from '../theme.js';

export interface OctoSpinnerProps {
  label?: string;
}

export const OctoSpinner: React.FC<OctoSpinnerProps> = ({ label = 'thinking' }) => {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame((prev) => (prev + 1) % theme.spinnerFrames.length);
    }, 120);
    return () => clearInterval(timer);
  }, []);

  return (
    <Text color={theme.thinking}>
      {theme.spinnerFrames[frame]} {label}
    </Text>
  );
};
