/**
 * Shared "edited code but never verified" signal for the REPL and the TUI.
 * A long run can finish with a confident answer after `multi_edit` of several
 * TS files; the old REPL check only looked at `input.path`, so that batch
 * never counted, and the TUI never said anything at all.
 */

const CODE_EDIT_TOOLS = new Set([
  'write_file',
  'edit_file',
  'multi_edit',
  'apply_patch',
  'move_file',
]);

const JS_TS_PATH = /\.[cm]?[jt]sx?$/;

const TEST_COMMAND_RE =
  /\b(npm (run )?test|npm t|yarn test|pnpm test|node\s+--test|pytest|vitest|jest|mocha|go test|cargo test|make test|npm run (build|typecheck|lint)|tsc)\b/;

const VERIFY_TOOLS = new Set(['run_tests', 'verify_fix', 'code_diagnostics']);

export interface VerifyHintState {
  editedJsTs: boolean;
  ranTests: boolean;
}

function stringPaths(input: Record<string, unknown> | undefined): string[] {
  if (!input) return [];
  const paths: string[] = [];
  if (typeof input.path === 'string') paths.push(input.path);
  if (typeof input.from === 'string') paths.push(input.from);
  if (typeof input.to === 'string') paths.push(input.to);
  if (Array.isArray(input.edits)) {
    for (const edit of input.edits) {
      if (
        edit &&
        typeof edit === 'object' &&
        typeof (edit as { path?: unknown }).path === 'string'
      ) {
        paths.push((edit as { path: string }).path);
      }
    }
  }
  return paths;
}

/** Record one tool call against the verify-hint flags. */
export function noteToolForVerifyHint(
  state: VerifyHintState,
  toolName: string,
  input: Record<string, unknown> | undefined
): void {
  if (CODE_EDIT_TOOLS.has(toolName)) {
    if (stringPaths(input).some((filePath) => JS_TS_PATH.test(filePath))) {
      state.editedJsTs = true;
    }
  }
  if (VERIFY_TOOLS.has(toolName)) {
    state.ranTests = true;
    return;
  }
  if (toolName === 'exec' || toolName === 'exec_background' || toolName === 'device_exec') {
    const command = input?.command;
    if (typeof command === 'string' && TEST_COMMAND_RE.test(command)) state.ranTests = true;
  }
}

export function needsTestHint(state: VerifyHintState): boolean {
  return state.editedJsTs && !state.ranTests;
}
