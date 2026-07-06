import React, { useState, useEffect } from 'react';
import { Text } from 'ink';
import { legacyTheme as theme } from '../theme/theme.js';

// CC-style braille spinner — matches WorkingIndicator in tui.ts
const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const PULSE_FRAMES = [
  ' ', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█',
  '▇', '▆', '▅', '▄', '▃', '▂', '▁',
];

export function StreamingSpinner({
  active = true,
}: {
  active?: boolean;
  /** @deprecated no-op, kept for API compat */
  showDots?: boolean;
}): React.ReactElement {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!active) return;
    const interval = setInterval(() => setTick((prev) => prev + 1), 80);
    return () => clearInterval(interval);
  }, [active]);

  if (!active) return React.createElement(Text, null, '');

  const spinner = SPINNER_FRAMES[tick % SPINNER_FRAMES.length] ?? '⠋';
  return React.createElement(Text, { color: theme.accent, bold: true }, ` ${spinner} `);
}

export function ToolPulse({
  active = true,
  toolName,
}: {
  active?: boolean;
  toolName?: string;
}): React.ReactElement {
  const [tick, setTick] = useState(0);

  useEffect(() => {
    if (!active) return;
    const interval = setInterval(() => setTick((prev) => prev + 1), 100);
    return () => clearInterval(interval);
  }, [active]);

  if (!active) return React.createElement(Text, null, '');

  const pulse = PULSE_FRAMES[tick % PULSE_FRAMES.length];
  const label = toolName ? ` ${toolName}` : '';
  return React.createElement(Text, { color: theme.tool }, `${pulse}${label}`);
}
