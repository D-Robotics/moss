/**
 * TUI input handler — extracted from tui.ts to separate input-processing
 * concerns (keyboard dispatch, picker navigation, approval shortcuts, global
 * hotkeys) from rendering and state management.
 *
 * This module owns:
 * - {@link isLikelyMouseInput} — filters SGR/legacy mouse-report bytes
 * - {@link ApprovalChoice} + helpers — approval-prompt keyboard logic
 * - {@link handleGlobalInput} — the global useInput callback body (session
 *   picker, model picker, approval, Ctrl+O / Ctrl+D / Shift+Tab / Esc)
 */

// ─── types ───────────────────────────────────────────────────────────────────

/** Minimal key shape from Ink's useInput callback. */
export interface InputKey {
  escape?: boolean;
  upArrow?: boolean;
  downArrow?: boolean;
  leftArrow?: boolean;
  rightArrow?: boolean;
  return?: boolean;
  tab?: boolean;
  shift?: boolean;
  ctrl?: boolean;
  delete?: boolean;
}

/** Session picker state used by keyboard navigation. */
export interface SessionPickerState<S = unknown> {
  sessions: S[];
  selectedIndex: number;
}

/** Model picker state used by keyboard navigation. */
export interface ModelPickerState<M = unknown> {
  list: { choices: M[]; provider: string };
  selectedIndex: number;
}

/** Approval prompt state used by keyboard navigation. */
export interface ApprovalPromptState {
  resolve: (answer: string) => void;
  selectedIndex: number;
  question: string;
}

/** All dependencies the global input handler needs from the TUI component.
 *
 *  Setter types use `any` to stay free of React's Dispatch/SetStateAction
 *  types — this module owns input logic, not React type plumbing. The handler
 *  body is type-safe internally (it only passes well-typed values to setters).
 */
export interface GlobalInputDeps<S = unknown, M = unknown> {
  sessionPicker: SessionPickerState<S> | null;
  setSessionPicker: (updater: any) => void;
  modelPicker: ModelPickerState<M> | null;
  setModelPicker: (updater: any) => void;

  approval: ApprovalPromptState | null;
  setApproval: (updater: any) => void;

  input: string;
  setInput: (v: string) => void;
  setInputCursor: (updater: (prev: number) => number) => void;

  pendingAttachments: unknown[];
  setPendingAttachments: (v: any[]) => void;
  setPendingAttachmentBlocks: (v: any[]) => void;
  suppressedAutoAttachInputRef: { current: string | null };

  activeRunControllerRef: { current: unknown };

  runtime?: { deviceSession?: unknown };

  showFlash: (msg: string) => void;
  requestStop: () => void;
  addTranscript: (type: any, text: string) => void;
  switchModelForSession: (model: string, provider: string) => void;
  resumeSession: (session: any) => void | Promise<void>;
  setToolsExpanded: (updater: (prev: boolean) => boolean) => void;
  setInteractionMode: (updater: any) => void;

  disconnectDeviceForSession: (agent: any, runtime: any) => string;
  removeAttachmentRefsFromInput: (input: string) => string;
  clampPromptCursor: (input: string, cursor: number) => number;
  agent: any;
}

// ─── pure helpers ────────────────────────────────────────────────────────────

/** SGR/legacy mouse report bytes. Every useInput must ignore them so a stray
 *  wheel never types bytes or fires keys. */
export function isLikelyMouseInput(s: string): boolean {
  if (!s) return false;
  return (
    s.includes('\x1b[<') ||
    s.includes('\x1b[M') ||
    /\[<\d+;\d+;\d+[Mm]/.test(s) ||
    /\[M...$/.test(s)
  );
}

// ─── approval helpers ────────────────────────────────────────────────────────

export interface ApprovalChoice {
  label: string;
  shortcut: string;
  decision: 'allow-once' | 'allow-always' | 'deny';
  description: string;
}

export const APPROVAL_CHOICES: ApprovalChoice[] = [
  {
    label: 'Approve once',
    shortcut: 'y',
    decision: 'allow-once',
    description: 'Allow only this tool call.',
  },
  {
    label: 'Always this scope',
    shortcut: 'a',
    decision: 'allow-always',
    description: 'Trust this scope for the current Moss session.',
  },
  {
    label: 'Deny',
    shortcut: 'n',
    decision: 'deny',
    description: 'Block the request and return control to the conversation.',
  },
];

export function clampApprovalChoiceIndex(index: number): number {
  return Math.max(0, Math.min(APPROVAL_CHOICES.length - 1, index));
}

export function approvalAnswerFromDecision(
  decision: 'allow-once' | 'allow-always' | 'deny'
): string {
  if (decision === 'allow-once') return 'y';
  if (decision === 'allow-always') return 'a';
  return '';
}

export function approvalAnswerForIndex(index: number): string {
  return approvalAnswerFromDecision(APPROVAL_CHOICES[clampApprovalChoiceIndex(index)].decision);
}

export function approvalChoicesForQuestion(question: string): ApprovalChoice[] {
  const workspaceScoped = /Scope:\s+workspace\b/i.test(question);
  return APPROVAL_CHOICES.map((choice) => {
    if (choice.decision !== 'allow-always') return choice;
    return workspaceScoped
      ? {
          ...choice,
          label: 'Always this workspace',
          description: 'Trust local operations in this workspace for the current Moss session.',
        }
      : choice;
  });
}

// ─── picker navigation primitives ────────────────────────────────────────────

function isPickerUp(key: InputKey, inputChar: string): boolean {
  return Boolean(key.upArrow || (key.ctrl && inputChar.toLowerCase() === 'p'));
}

function isPickerDown(key: InputKey, inputChar: string): boolean {
  return Boolean(key.downArrow || (key.ctrl && inputChar.toLowerCase() === 'n'));
}

function wrapIndex(current: number, length: number, delta: number): number {
  if (length === 0) return 0;
  return (current + delta + length) % length;
}

// ─── global input handler ────────────────────────────────────────────────────

/**
 * The body of the global `useInput` callback in MossTui.
 * Handles (in priority order): session picker → model picker → approval →
 * global hotkeys (Ctrl+O, Ctrl+D, Shift+Tab, Esc).
 *
 * Returns `true` if the key was consumed, `false` if it should bubble.
 */
export function handleGlobalInput<S, M>(
  inputChar: string,
  key: InputKey,
  deps: GlobalInputDeps<S, M>
): boolean {
  // ── Session picker ──────────────────────────────────────────────────────
  if (deps.sessionPicker) {
    const sessions = deps.sessionPicker.sessions;
    if (key.escape) {
      deps.setSessionPicker(() => null);
      deps.showFlash('session selection cancelled');
      return true;
    }
    if (isPickerUp(key, inputChar)) {
      deps.setSessionPicker((p: any) =>
        p ? { ...p, selectedIndex: wrapIndex(p.selectedIndex, sessions.length, -1) } : p
      );
      return true;
    }
    if (isPickerDown(key, inputChar)) {
      deps.setSessionPicker((p: any) =>
        p ? { ...p, selectedIndex: wrapIndex(p.selectedIndex, sessions.length, 1) } : p
      );
      return true;
    }
    if (key.return) {
      const session = sessions[Math.max(0, Math.min(sessions.length - 1, deps.sessionPicker.selectedIndex))];
      deps.setSessionPicker(() => null);
      if (session) void deps.resumeSession(session);
      return true;
    }
    return true; // swallow all other keys while picker is open
  }

  // ── Model picker ────────────────────────────────────────────────────────
  if (deps.modelPicker) {
    const choices = deps.modelPicker.list.choices;
    if (key.escape) {
      deps.setModelPicker(() => null);
      deps.showFlash('model selection cancelled');
      return true;
    }
    if (isPickerUp(key, inputChar)) {
      deps.setModelPicker((p: any) =>
        p ? { ...p, selectedIndex: wrapIndex(p.selectedIndex, choices.length, -1) } : p
      );
      return true;
    }
    if (isPickerDown(key, inputChar)) {
      deps.setModelPicker((p: any) =>
        p ? { ...p, selectedIndex: wrapIndex(p.selectedIndex, choices.length, 1) } : p
      );
      return true;
    }
    if (/^[1-9]$/.test(inputChar)) {
      const selected = Number.parseInt(inputChar, 10) - 1;
      const choice = choices[selected];
      if (choice) {
        deps.setModelPicker(() => null);
        // Caller's choice shape has `.model` and provider on the list
        deps.switchModelForSession(
          (choice as unknown as { model: string }).model,
          deps.modelPicker.list.provider
        );
      }
      return true;
    }
    if (key.return) {
      const choice = choices[Math.max(0, Math.min(choices.length - 1, deps.modelPicker.selectedIndex))];
      if (choice) {
        deps.setModelPicker(() => null);
        deps.switchModelForSession(
          (choice as unknown as { model: string }).model,
          deps.modelPicker.list.provider
        );
      }
      return true;
    }
    return true; // swallow while picker open
  }

  // ── Approval prompt ─────────────────────────────────────────────────────
  if (deps.approval) {
    if (key.escape) {
      deps.approval.resolve('');
      deps.setApproval(() => null);
      return true;
    }
    if (isPickerUp(key, inputChar) || key.leftArrow) {
      deps.setApproval((c: any) =>
        c
          ? { ...c, selectedIndex: wrapIndex(c.selectedIndex, APPROVAL_CHOICES.length, -1) }
          : c
      );
      return true;
    }
    if (isPickerDown(key, inputChar) || key.rightArrow) {
      deps.setApproval((c: any) =>
        c
          ? { ...c, selectedIndex: wrapIndex(c.selectedIndex, APPROVAL_CHOICES.length, 1) }
          : c
      );
      return true;
    }
    if (key.return) {
      deps.approval.resolve(approvalAnswerForIndex(deps.approval.selectedIndex));
      deps.setApproval(() => null);
      return true;
    }
    if (/^[1-3]$/.test(inputChar)) {
      deps.approval.resolve(approvalAnswerForIndex(Number.parseInt(inputChar, 10) - 1));
      deps.setApproval(() => null);
      return true;
    }
    // approvalKeyDecision lives in tui-utils.ts; we approximate the same
    // shortcut mapping here for the three approval decisions.
    const lower = inputChar.toLowerCase();
    if (lower === 'y') {
      deps.approval.resolve(approvalAnswerFromDecision('allow-once'));
      deps.setApproval(() => null);
      return true;
    }
    if (lower === 'a') {
      deps.approval.resolve(approvalAnswerFromDecision('allow-always'));
      deps.setApproval(() => null);
      return true;
    }
    if (lower === 'n') {
      deps.approval.resolve(approvalAnswerFromDecision('deny'));
      deps.setApproval(() => null);
      return true;
    }
    return true; // swallow while approval open
  }

  // ── Global hotkeys ──────────────────────────────────────────────────────
  const normalizedInput = inputChar.toLowerCase();

  // Ctrl+O — toggle tool expansion
  if (key.ctrl && (normalizedInput === 'o' || inputChar === '\u000f')) {
    deps.setToolsExpanded((prev) => {
      const next = !prev;
      deps.showFlash(next ? 'tools expanded' : 'tools collapsed');
      return next;
    });
    return true;
  }

  // Ctrl+D on empty idle prompt — disconnect from board session
  if (
    key.ctrl &&
    (normalizedInput === 'd' || inputChar === '\u0004') &&
    deps.input === '' &&
    !deps.activeRunControllerRef.current &&
    deps.runtime?.deviceSession
  ) {
    deps.addTranscript('system', deps.disconnectDeviceForSession(deps.agent, deps.runtime));
    deps.showFlash('disconnected from board');
    return true;
  }

  // Shift+Tab — cycle interaction mode (plan → default → acceptEdits → plan)
  if (key.tab && key.shift) {
    deps.setInteractionMode((m: any) => {
      const next = m === 'plan' ? 'default' : m === 'default' ? 'acceptEdits' : 'plan';
      deps.showFlash(`mode: ${next === 'acceptEdits' ? 'accept-edits' : next}`);
      return next;
    });
    return true;
  }

  // Esc — interrupt active run, or clear pending attachments while idle
  if (key.escape && deps.activeRunControllerRef.current) {
    deps.requestStop();
    return true;
  }
  if (key.escape && deps.pendingAttachments.length > 0) {
    const count = deps.pendingAttachments.length;
    deps.setPendingAttachments([]);
    deps.setPendingAttachmentBlocks([]);
    const nextInput = deps.removeAttachmentRefsFromInput(deps.input);
    deps.suppressedAutoAttachInputRef.current = nextInput.trim() || null;
    deps.setInput(nextInput);
    deps.setInputCursor((cursor) => deps.clampPromptCursor(nextInput, cursor));
    deps.addTranscript('system', `Cleared ${count} pending attachment${count === 1 ? '' : 's'}.`);
    deps.showFlash('attachments cleared');
    return true;
  }

  return false; // key not consumed — let it bubble to the input box
}
