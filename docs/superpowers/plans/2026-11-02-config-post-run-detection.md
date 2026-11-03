# Config post-run detection implementation plan

> **For agentic workers:** Use the current runtime's plan-execution workflow to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Report changes to the active Moss configuration and credential files after an executed command, including paths constructed inside an interpreter.

**Architecture:** The CLI resolves the paths once using its existing trusted config resolution and passes only a fixed list of files through the tool context. The existing foreground/background snapshot comparison hashes newly watched files without retaining their contents; subagents inherit the list. This detects changes after execution and does not prevent or restore them.

**Tech Stack:** TypeScript, Node.js, existing `node:test` CLI and tool tests.

---

### Task 1: Reproduce the missing detection

**Files:** `test/aa-o130-process-block.spec.mjs`

- [x] Remove the existing test's `todo` option. Run `node --test --test-name-pattern='O130 L3 gap' test/aa-o130-process-block.spec.mjs`; expect exit 1 because the command modifies credentials and Moss reports exit 0.

### Task 2: Compare trusted configuration paths

**Files:** `src/cli-main.ts`, `src/core/tools/tool-types.ts`, `src/core/agent/moss-agent.ts`, `src/core/subagent/subagent-runner.ts`, `src/safety/protected-path-snapshot.ts`, `src/tools/builtin.ts`, `src/tools/background-exec.ts`.

- [x] Inject the resolved configuration file and fixed `configDir` files `config.json`, `credentials`, `.apikey-key`, `.env`, `mcp.json`, and `workspace-trust.json` as `protectedConfigPaths` in tool context; propagate to child contexts.
- [x] Extend the existing snapshot with fixed configuration paths; preserve the entire requested list for the after snapshot so creating a previously absent path is detected. Hash newly watched regular files and existing symlink targets without retaining contents; exclude these paths from the redaction image buffer.
- [x] Run the O130 test again; expect exit 0 and truthful modified-path reporting, with no claim of interception or restoration.

### Task 3: Check boundaries

**Files:** `test/aa-o130-process-block.spec.mjs` and an existing relevant snapshot/tool spec.

- [x] Verify an explicit config path, additions/deletions, symlink targets, unchanged runtime files, and foreground/background/subagent path propagation with focused checks; ensure reports contain no file contents.
- [x] Run formatting/typecheck and relevant focused tests. Report remaining limitations to the main agent; do not submit or push.
