## 1. Safety contract

- [x] 1.1 Add a regression that fails while `fleet_batch` is Plan-mode allowed.
- [x] 1.2 Change `fleet_batch` to require leaving Plan mode and the normal approval path.
- [x] 1.3 Run the focused build and `batch-device` regression.
- [x] 1.4 Make `device_mutation` fail closed at the approval boundary even when tool metadata is accidentally permissive.
- [x] 1.5 Prove Plan denial and Execute dispatch through the real tool-call execution pipeline.

## 2. Repository entry contract

- [x] 2.1 Add lockfile-faithful setup and explicit success contracts to root `AGENTS.md`.
- [x] 2.2 Change README development setup to `npm ci` and distinguish fast from full verification.
- [x] 2.3 Extend workspace-policy tests with broken-command and valid-entry fixtures.

## 3. Verification and handoff

- [x] 3.1 Run workspace hygiene, standards tests, Agent package tests, and `git diff --check`.
      Clean detached worktree at candidate `9eaf5c54` passed the root `npm run verify`, including 259 Agent spec files, 9 core spec files, and 7 create-app cases.
- [x] 3.2 Run `npm run verify` and report any environment-dependent gaps exactly.
      macOS clean-checkout verification exited 0. Five real-board specs explicitly skipped because `MOSS_REALBOARD_TEST` / host opt-in was absent; the piped-stdin override-only subcase also reported SKIP while its containing regression passed. No required check was skipped.
- [x] 3.3 Update `CHANGELOG.md` and reconcile this checklist with observed evidence.
