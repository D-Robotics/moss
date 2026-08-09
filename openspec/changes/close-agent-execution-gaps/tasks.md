## 1. Runtime safety

- [x] 1.1 Default missing safety metadata to a reviewable mutation.
- [x] 1.2 Revalidate global-hook output.
- [x] 1.3 Reorder registry hooks before approval and validate their final output.
- [x] 1.4 Restrict automatic transient retries to explicitly readonly tools.

## 2. Regression evidence

- [x] 2.1 Add a neutral-name custom-tool Plan-mode negative case.
- [x] 2.2 Add global and registry hook schema-bypass negative cases.
- [x] 2.3 Add a negative case proving side-effecting tools execute at most once.
- [x] 2.4 Run clean-worktree `npm run verify`.
- [x] 2.5 Require cross-platform CI before merge.

## 3. Documentation

- [x] 3.1 Correct the deployment side-effect example.
- [x] 3.2 Document command prerequisites, outputs, side effects, and recovery.
