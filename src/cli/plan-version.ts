/**
 * Plan approval versioning.
 *
 * `exit_plan` stamps the submitted summary with a `version <sha12>` line. The TUI
 * approval gate must echo *that* version, not a hash of whatever assistant row
 * happens to be last: the approval then names one specific plan, and after it is
 * consumed the next plan needs its own `exit_plan` (and therefore its own
 * approval). This is the text-only equivalent of Claude Code binding
 * `plan_approval_response` to the request id; there is no id in prose, so the
 * hash is the closest honest handle.
 */
import crypto from 'node:crypto';

const PLAN_VERSION_RE = /version ([0-9a-f]{12})/;

/** The version `exit_plan` returned for this run, if any. */
export function extractPlanVersion(text: string): string | undefined {
  return PLAN_VERSION_RE.exec(text)?.[1];
}

/** Fallback for a plan the model wrote without calling `exit_plan`. */
export function fallbackPlanVersion(planText: string): string | undefined {
  const trimmed = planText.trim();
  if (!trimmed) return undefined;
  return crypto.createHash('sha256').update(trimmed, 'utf8').digest('hex').slice(0, 12);
}

/** The version to show in the approval receipt for the plan on screen. */
export function approvalPlanVersion(
  submittedVersion: string | undefined,
  planText: string
): string {
  return submittedVersion ?? fallbackPlanVersion(planText) ?? 'unknown';
}
