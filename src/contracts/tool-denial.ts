/**
 * Why a tool call was denied.
 *
 * A denial is not one event: the user declining, the interaction mode blocking,
 * a configured policy/protected-path rule, and "nobody can be asked in this run"
 * all read the same to the model unless the decision point says which one it
 * was — and each implies a different correct next action. The class travels with
 * the approval decision (`ToolApprovalDecision.denialClass`) and is rendered by
 * `deniedToolResultText`, so the guidance in the tool result cannot contradict
 * the reason the host produced.
 */
export type DenialClass = 'user' | 'mode' | 'policy' | 'headless';

const DENIAL_CLASSES: ReadonlySet<string> = new Set<DenialClass>([
  'user',
  'mode',
  'policy',
  'headless',
]);

export function isDenialClass(value: unknown): value is DenialClass {
  return typeof value === 'string' && DENIAL_CLASSES.has(value);
}
