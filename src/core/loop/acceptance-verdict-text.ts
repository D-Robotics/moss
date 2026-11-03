/** Parse only the tool-generated header, never untrusted command output. */
export function parseAcceptanceVerdictText(
  text: string,
  taskId?: string
): { taskId: string; outcome: 'FAIL' | 'PASS' | 'PARTIAL' } | undefined {
  const match = /^Task acceptance \(([^)]*)\): (FAIL|PASS|PARTIAL)(?:\r?\n|$)/.exec(text);
  if (match) return { taskId: match[1]!, outcome: match[2] as 'FAIL' | 'PASS' | 'PARTIAL' };
  // Command verdicts carry no task ID; only attribute them to an explicit task ID.
  if (taskId && /^acceptance command failed \(exit [^\r\n)]*\)(?:\r?\n|$)/.test(text)) {
    return { taskId, outcome: 'FAIL' };
  }
  if (taskId && text === 'acceptance command exited 0') return { taskId, outcome: 'PASS' };
  return undefined;
}
