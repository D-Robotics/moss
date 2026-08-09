# Clean-Checkout Verification

Verified on 2026-08-09 on Windows/PowerShell from the repository root.

1. `npm run clean` completed, followed by an explicit scan confirming that no
   package `dist` directory existed.
2. `npm ci` installed 341 packages from the lock file, ran the hook installer,
   and reported 0 vulnerabilities.
3. `npm run check` passed from that no-`dist` state. It ran formatting, lint,
   workspace type checking, boundaries, hygiene, maintainability, and all 16
   standards regression tests.
4. After another `npm run clean`,
   `npm run typecheck -w @rdk-moss/core` passed without declarations present.
5. After another `npm run clean`,
   `npm run typecheck -w @rdk-moss/agent` passed and its `pretypecheck` prepared
   core declarations automatically.
6. After another `npm run clean`, `npm run docs` completed for core and agent.
   Core generated documentation without warnings. Agent generated documentation
   with 0 errors and 88 pre-existing referenced-but-not-included symbol warnings;
   API Extractor reports, rather than TypeDoc warnings, are the enforced public
   API compatibility gate.

Generated `dist` and `docs-api` paths are ignored and are not part of the tracked
change.

## Full verification

`npm run verify` completed successfully in 258.4 seconds. It included the full
`check` command, validation of 200 benchmark cases, build plus all 34 governed API
entry-point reports, core tests, 257 passing agent test files, and the
`create-moss-app` contract tests.
