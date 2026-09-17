import { useEffect, useState } from 'react';
import { useStdout } from 'ink';

export interface TerminalSize {
  columns: number;
  rows: number;
}

export function useTerminalSize(): TerminalSize {
  const { stdout } = useStdout();
  const [size, setSize] = useState<TerminalSize>(() => ({
    columns: stdout?.columns ?? process.stdout.columns ?? 80,
    rows: stdout?.rows ?? process.stdout.rows ?? 24,
  }));

  useEffect(() => {
    if (!stdout || typeof stdout.on !== 'function') return undefined;
    const onResize = (): void => {
      const next = {
        columns: stdout.columns ?? 80,
        rows: stdout.rows ?? 24,
      };

      setSize((prev) => (prev.columns === next.columns && prev.rows === next.rows ? prev : next));
    };
    stdout.on('resize', onResize);
    return () => {
      stdout.off('resize', onResize);
    };
  }, [stdout]);

  return size;
}
