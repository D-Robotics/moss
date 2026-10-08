/**
 * Structured approval view — the frozen interface between the approval policy
 * (src/cli/approval*.ts) and any UI that renders it.
 *
 * Why this exists: the policy already computes everything a rich dialog needs
 * (side-effect class, safety mode, sanitized input, real diff, scope), but it
 * used to flatten all of that into a prompt string that each UI had to re-parse.
 * The reference clients render a titled dialog with numbered options and a
 * footer, so the policy now hands the UI that exact structure.
 *
 * Dependency direction is frozen: `src/cli/tui/**` may import this module;
 * this module must never import from `src/cli/tui/**` (the ESLint boundary
 * rules enforce the layer order).
 */
import type { ApprovalDialog, CliToolApprovalPreview } from './approval.js';

/**
 * What the user chose. `amend` means "approve, but let me say something first"
 * (the reference's `Tab to amend`): the run continues and the UI stages the
 * composer for the user's follow-up.
 */
export type CliApprovalAnswer = 'y' | 'a' | 'n' | 'amend';

export interface CliApprovalOption {
  /** The key the dialog shows, e.g. `1`. */
  key: string;
  answer: CliApprovalAnswer;
  label: string;
}

export interface CliApprovalView {
  title: string;
  subject?: string;
  /** Detail/diff lines, already sanitized and capped by the policy. */
  preview?: string[];
  question: string;
  options: CliApprovalOption[];
  /** Footer hint; only keys that actually work are advertised. */
  footer: string;
}

export type CliApprovalViewAsker = (
  view: CliApprovalView,
  abortSignal?: AbortSignal
) => Promise<CliApprovalAnswer>;

export const CLI_APPROVAL_OPTIONS: readonly CliApprovalOption[] = [
  { key: '1', answer: 'y', label: 'Yes' },
  { key: '2', answer: 'a', label: "Yes, and don't ask again this session" },
  { key: '3', answer: 'n', label: 'No' },
];

/**
 * Footer: moss does not implement "amend" yet, so the hint advertises only the
 * keys that work. When an amend path exists, add it here rather than printing a
 * key that does nothing.
 */
export const CLI_APPROVAL_FOOTER = 'Esc to deny · ↑↓ then Enter';

let viewAsker: CliApprovalViewAsker | null = null;

/** Install the structured asker. Returns an uninstall function. */
export function setCliApprovalViewAsker(asker: CliApprovalViewAsker | null): () => void {
  viewAsker = asker;
  return () => {
    if (viewAsker === asker) viewAsker = null;
  };
}

export function getCliApprovalViewAsker(): CliApprovalViewAsker | null {
  return viewAsker;
}

/** Pure: policy payload -> renderable view. */
export function buildCliApprovalView(dialog: ApprovalDialog): CliApprovalView {
  // A6.52/53: option 2/3 labels describe what the answer ACTUALLY does for
  // this dialog's class (see describeApprovalDialog); the frozen defaults
  // remain the fallback for callers without a classified dialog.
  const options = CLI_APPROVAL_OPTIONS.filter(
    (option) => option.answer !== 'a' || dialog.trustOptionAvailable !== false
  ).map((option, index) => {
    const key = String(index + 1);
    if (option.answer === 'a' && dialog.trustOptionLabel) {
      return { ...option, key, label: dialog.trustOptionLabel };
    }
    if (option.answer === 'n' && dialog.denyOptionLabel) {
      return { ...option, key, label: dialog.denyOptionLabel };
    }
    return { ...option, key };
  });
  return {
    title: dialog.title,
    ...(dialog.subject ? { subject: dialog.subject } : {}),
    ...(dialog.detail.length > 0 ? { preview: dialog.detail } : {}),
    question: dialog.question,
    options,
    footer: CLI_APPROVAL_FOOTER,
  };
}

/** Normalise an answer from any UI (keys, letters, free text) to the contract. */
export function normalizeApprovalAnswer(raw: string): CliApprovalAnswer {
  const answer = raw.trim().toLowerCase();
  if (answer === 'y' || answer === 'yes' || answer === '1') return 'y';
  if (answer === 'a' || answer === 'always' || answer === '2') return 'a';
  if (answer === 'amend' || answer === 'tab') return 'amend';
  return 'n';
}

/** Does this answer let the tool run? */
export function approvalAnswerAllows(answer: CliApprovalAnswer): boolean {
  return answer === 'y' || answer === 'a' || answer === 'amend';
}

/** Does this answer also grant session-wide trust? */
export function approvalAnswerTrusts(answer: CliApprovalAnswer): boolean {
  return answer === 'a';
}

export type { ApprovalDialog, CliToolApprovalPreview };
