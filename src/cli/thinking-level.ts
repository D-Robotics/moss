import type { ThinkingLevel } from '../provider/pi-ai-types.js';

/**
 * The reasoning level this interactive session asks the model for.
 *
 * `config.reasoning` is the configured level. `/thinking` and the TUI's
 * `thinking.cycle` key put a session level on top of it, and `null` means "back
 * to the configured one". The state lives in the CLI layer because that is
 * where both surfaces assemble the options of a turn: `runOneShot` for the REPL
 * and `streamTurn` in the TUI shell. It is per process, so it is not written
 * anywhere and a resumed session starts from the configured level again.
 *
 * The levels and their order are Pi's, so a user who cycles there cycles the
 * same way here.
 */
export const THINKING_CYCLE: readonly ThinkingLevel[] = [
  'off',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
];

let sessionLevel: ThinkingLevel | null = null;

export function getSessionThinkingLevel(): ThinkingLevel | null {
  return sessionLevel;
}

export function setSessionThinkingLevel(level: ThinkingLevel | null): void {
  sessionLevel = level;
}

/**
 * The level a word names. `null` is the configured level (`default` or nothing),
 * `undefined` is a word that names no level.
 */
export function parseThinkingLevel(word: string): ThinkingLevel | null | undefined {
  const value = word.trim().toLowerCase();
  if (value === '' || value === 'default') return null;
  return (THINKING_CYCLE as readonly string[]).includes(value)
    ? (value as ThinkingLevel)
    : undefined;
}

/** The next level of the cycle. The configured level comes before `off`. */
export function nextThinkingLevel(current: ThinkingLevel | null): ThinkingLevel {
  if (current === null) return THINKING_CYCLE[0];
  return THINKING_CYCLE[(THINKING_CYCLE.indexOf(current) + 1) % THINKING_CYCLE.length] ?? 'off';
}

/**
 * The run option that carries the level. A caller that set its own `reasoning`
 * keeps it (`null` included, which the agent reads as "no reasoning for this
 * run"); otherwise the session level goes out, and nothing does when the
 * session follows the config.
 */
export function sessionReasoningOption(explicit?: ThinkingLevel | null): {
  reasoning?: ThinkingLevel | null;
} {
  if (explicit !== undefined) return { reasoning: explicit };
  return sessionLevel ? { reasoning: sessionLevel } : {};
}
