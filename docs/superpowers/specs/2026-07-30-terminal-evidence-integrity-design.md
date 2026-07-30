# Terminal Evidence Integrity Design

Date: 2026-07-30
Status: Approved

## Goal

Repair the trusted statistical root used by T3.3 drift calibration and T3.4 promotion. Terminal predicates must evaluate real execution evidence, audit failures must be recorded, and retries must not inflate proof counts.

## Scope

This change covers terminal verification, terminal-verdict persistence, aggregation, and focused regression tests.

It does not add new predicates, activate board-specific geometric contracts, implement T3.2 proposals, rewrite existing JSONL files, or materialize promoted contracts.

## Trusted Evidence Boundary

Add a narrow `TerminalExecutionEvidence` value carried by `CodingCompletionGateRequest`:

- `source`: the tool that produced the evidence
- `toolUseId`: optional stable tool-call identity
- `exitCode`: optional numeric process exit code
- `stdout`: captured standard output
- `stderr`: captured standard error

The completion response remains available for user-facing and semantic completion gates, but terminal `exit_code_zero` and `stdout_matches` predicates consume only structured execution evidence. The terminal verifier passes the evidence stdout as the predicate result and derives `reportedIsError` from the exit code. If a terminal contract needs process evidence and none is available, the predicate returns `unknown`; it never falls back to assistant prose.

File and device predicates continue to read their objective data sources directly and do not require process evidence.

## Evidence Extraction

The agent loop derives the latest completed execution evidence from the message history when building the completion-gate request. Only terminal tool results qualify. Still-running background starts, missing results, and assistant text do not qualify.

The extractor associates a tool result with its tool-use block, captures its tool name and ID, parses explicit process exit metadata when present, and preserves stdout/stderr text. If no trustworthy exit code is present, `exitCode` remains absent rather than inferred from success language.

## Terminal Verdict Ordering

For an executing plan, the arbitration wrapper performs these steps:

1. Load session experiences.
2. Verify `plan.terminalAccept` using objective file/device data and structured execution evidence.
3. Compute the single-step versus terminal arbitration result and drift observations.
4. Append one terminal verdict per referenced skill.
5. If all single-step checks passed but the terminal verdict failed, return the existing correction and block completion.
6. Otherwise fall through to the original completion gate.

Recording before the audit-failure return ensures failed terminal outcomes remain visible to drift and promotion statistics.

## Append-Only Identity Model

Extend new `TerminalVerdictEntry` records with optional identity fields:

- `taskId`: logical plan identity
- `attemptId`: one completion attempt, derived from plan, session, run, and turn
- `evidenceId`: the tool-use identity when execution evidence exists

The JSONL file remains append-only. Existing entries stay valid and are not rewritten.

## Read-Time Compatibility and Deduplication

Aggregation first canonicalizes records:

1. For new entries, repeated records with the same `attemptId` and skill collapse to the latest record.
2. Decided records with the same `evidenceId` and skill count as one proof even if submitted in multiple attempts.
3. Legacy entries without the new fields use their existing stable `id` as the compatibility identity. Repeated legacy IDs collapse; distinct legacy IDs remain independently auditable.
4. `unknown` entries remain visible in totals but never increase `proofCount`.
5. Malformed or identity-less records may be read for audit diagnostics but do not become promotable proof.

This preserves old logs while preventing retries over one execution result from creating multiple independent proofs.

## Error Handling

- Missing or incomplete execution evidence produces `unknown`, not `pass` or guessed `fail`.
- Log writes remain side effects: failures emit `memoryWarn` and do not crash completion handling.
- Malformed JSONL lines remain skipped.
- Aggregation is deterministic: latest-record selection uses timestamp when valid and input order as a stable fallback.
- Existing callers that do not provide execution evidence remain source-compatible.

## Tests

Focused tests must demonstrate:

1. Assistant prose cannot satisfy `stdout_matches` or `exit_code_zero` without structured evidence.
2. Structured stdout and exit code can satisfy or fail terminal predicates.
3. A single-step-all-pass/terminal-fail audit is appended before completion is blocked.
4. Repeating the same attempt does not increase proof count.
5. Reusing one evidence ID across attempts does not increase proof count.
6. New independent evidence IDs increase proof count.
7. Legacy entries remain readable and duplicate legacy IDs collapse.
8. Candidate thresholds and drift minimum-sample gates consume deduplicated proof counts.
9. The focused package tests and repository `npm run verify` pass.

## Success Criteria

- Terminal process predicates never consume assistant response text.
- Failed terminal audits are present in the terminal verdict log.
- Ten retries over one execution result cannot unlock a ten-proof promotion threshold.
- Existing terminal-verdict files need no migration and continue to load.
- No behavior changes occur for plans whose terminal predicates are file/device based.
