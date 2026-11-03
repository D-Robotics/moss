# Live Interaction Mode Implementation Plan

> **For agentic workers:** Use the current runtime's plan-execution workflow to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Switching from startup `full` to `manual`, `acceptEdits`, or `plan` must actually change the next tool approval decision to match the mode shown in the CLI.

**Architecture:** The CLI already resolves startup flags and configuration into one interaction mode and supplies a live mode getter to its approval hook. Treat that supplied getter as authoritative for live sessions; retain the legacy constructor / auto-approval behavior for callers that do not supply a live getter, and retain deny rules and the read-only ceiling.

**Tech Stack:** TypeScript, Node.js 22, existing CLI permission engine and PTY-based interaction.

---

### Task 1: Make live mode transitions control approval

**Files:**

- Modify: `src/cli/approval.ts`
- Test: `test/cli-permission-live-mode.spec.mjs`

- [x] **Step 1: Reproduce a startup-full session.** Create an approval hook with `mode='full-access'`, `approvalPolicy='never'` and a live mode getter. Verify a `write_file` request is auto-approved in `full`, prompts in `manual`, is auto-approved in `acceptEdits`, and is blocked in `plan`; switching back to `full` auto-approves again.
- [x] **Step 2: Run the failing test.** Run `node --test test/cli-permission-live-mode.spec.mjs`; the pre-fix hook incorrectly auto-approves in `manual` and `plan`.
- [x] **Step 3: Resolve the mode once per call.** If `setInteractionModeResolver` or `options.interactionMode` supplies a live mode, use it. Otherwise preserve the old `mode` / `approvalPolicy` / auto-approval environment behavior for legacy hosts. Apply the existing read-only ceiling and deny rules after resolving the mode.
- [x] **Step 4: Rebuild and verify.** Run the new test, `cli-permission-defaults`, `cli-permission-mode-engine`, and relevant device approval tests. Exercise a real TUI switch to manual with a real model and decline a write; confirm no file is created.
- [x] **Step 5: Clarify the live permissions view.** Show the current mode separately from the configured default and label startup-only configuration values; cover `/permissions --verbose` after a mode switch and verify the real TUI output.

### Task 2: Keep approval grants aligned with the displayed scope

**Files:** `src/cli/approval.ts`, `src/cli/approval-view.ts`, `src/cli/device-safety-prompt.ts`, `src/cli/permission-rules.ts`, `src/cli/commands/registry.ts`, `src/cli-main.ts`, `src/tools/file-based-tools.ts`, and the `cli-permission-*` and `file-based-tool-registration` specs.

- [x] Reproduce and fix ordinary device approval granting all commands, and show destructive or sensitive warnings even when an ask rule matched. Explicit allow rules retain their existing behavior.
- [x] Ensure ask rules prompt on every call and do not create hidden grants. Display session grants through the CLI registry and let users remove them; explain that separately saved rules survive.
- [x] Resolve numeric answers against the options actually displayed. Do not claim that a request is auto-approved when an ask rule or hook requires confirmation.
- [x] Prevent a workspace file-based tool from silently replacing an already registered tool, while retaining SDK hosts' explicit registry behavior.
- [x] Verify the regression tests with Node 22, including the pre-fix failures. Persisted legacy file-tool allow rules remain plain tool-name rules; SDK hosts that replace tool implementations must manage their own approval boundary.
