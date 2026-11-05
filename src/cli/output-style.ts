/**
 * Output styles (D15): change the voice, keep the engineering discipline.
 *
 * Ported from Claude Code's output styles, where the non-obvious design detail is
 * `keep-coding-instructions`: a style may change how the agent talks to the user
 * without weakening tool contracts, verification, or safety rules. Here the style
 * is an *additive* dynamic prompt layer — it never replaces the base prompt or the
 * soul/identity layers — so removing the layer restores the default voice exactly.
 *
 * `default` installs no layer at all (zero tokens, zero prompt churn). The two
 * named styles explain themselves to the model; none of them relaxes the L1
 * completion gate, approval rules, or the "no claim without evidence" contract.
 *
 * Selection precedence: `MOSS_OUTPUT_STYLE` > `outputStyle` in the config file >
 * `default`. The CLI writes the config key with `moss config set outputStyle`.
 */

export type OutputStyleName = 'default' | 'explanatory' | 'learning';

export const OUTPUT_STYLE_NAMES: readonly OutputStyleName[] = [
  'default',
  'explanatory',
  'learning',
];

const STYLE_LAYERS: Record<Exclude<OutputStyleName, 'default'>, string> = {
  explanatory: [
    'The `explanatory` output style is active.',
    'Explain the reasoning behind your work as you go: why this approach, what tradeoffs it',
    'involves, and what you verified. Keep every explanation tied to the actual change (no',
    'generic tutorials), and skip the commentary for trivial edits. Coding discipline, tool',
    'contracts, approval rules, and safety rules still apply unchanged — this style changes',
    'your voice, not your engineering standards.',
  ].join(' '),
  learning: [
    'The `learning` output style is active.',
    'Teach while you work: name the concepts involved and, where useful, point out a small',
    'next step the user can try themselves. Do not withhold working code the task needs, and',
    'do not turn the task into homework. Coding discipline, tool contracts, approval rules,',
    'and safety rules still apply unchanged — this style changes your voice, not your',
    'engineering standards.',
  ].join(' '),
};

let current: OutputStyleName = 'default';
const listeners = new Set<(style: OutputStyleName) => void>();

/** Parse a stored/env value; unknown values are ignored by the caller. */
export function parseOutputStyle(value: string | undefined): OutputStyleName | undefined {
  const normalized = String(value ?? '')
    .trim()
    .toLowerCase();
  if (normalized === '') return undefined;
  return (OUTPUT_STYLE_NAMES as readonly string[]).includes(normalized)
    ? (normalized as OutputStyleName)
    : undefined;
}

export function currentOutputStyle(): OutputStyleName {
  return current;
}

/** Set the process-wide style and notify prompt owners (TUI/REPL switch in place). */
export function setOutputStyle(style: OutputStyleName): void {
  if (current === style) return;
  current = style;
  for (const listener of listeners) listener(style);
}

export function subscribeOutputStyle(listener: (style: OutputStyleName) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** Empty string for `default`, so callers can remove the layer instead of setting empty text. */
export function buildOutputStyleLayer(style: OutputStyleName): string {
  return style === 'default' ? '' : STYLE_LAYERS[style];
}
