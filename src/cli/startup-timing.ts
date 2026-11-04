/**
 * H2: opt-in phased startup timing.
 *
 * The TUI feels slow or fast based on things that happen before the first
 * prompt is drawn (config read, agent construction, skills discovery, prompt
 * assembly). `MOSS_STARTUP_TIMING=1` prints one stderr line with the elapsed
 * milliseconds at each phase, so a regression can be located instead of guessed
 * at, and so the composer-skeleton work (H1) can be scoped from measurements.
 *
 * Off by default; the line is written to stderr so `-p` stdout stays clean.
 */
export interface StartupTiming {
  readonly enabled: boolean;
  /** Record the elapsed time since process start under `label`. */
  mark(label: string): void;
  /** Print the collected phases once. Safe to call more than once. */
  finish(): void;
}

const TRUTHY = new Set(['1', 'true', 'yes', 'on']);

export function startupTimingEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = String(env.MOSS_STARTUP_TIMING ?? '')
    .trim()
    .toLowerCase();
  return TRUTHY.has(value);
}

export function createStartupTiming(env: NodeJS.ProcessEnv = process.env): StartupTiming {
  const enabled = startupTimingEnabled(env);
  const start = performance.now();
  const phases: Array<{ label: string; ms: number }> = [];
  let printed = false;
  return {
    enabled,
    mark(label: string): void {
      if (!enabled) return;
      phases.push({ label, ms: Math.round(performance.now() - start) });
    },
    finish(): void {
      if (!enabled || printed) return;
      printed = true;
      const parts = phases.map((phase) => `${phase.label}=${phase.ms}ms`);
      const total = Math.round(performance.now() - start);
      process.stderr.write(`[startup] timing: ${parts.join(' ')} total=${total}ms\n`);
    },
  };
}
