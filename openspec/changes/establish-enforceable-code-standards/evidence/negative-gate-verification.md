# Negative Gate Verification

Verified on 2026-08-09 with Node's test runner through `npm run test:standards`.
The suite passed 16/16 tests. Each negative test invokes the relevant gate with
an intentionally invalid fixture and asserts a non-zero result plus an actionable
diagnostic.

| Required failure mode | Regression coverage |
| --- | --- |
| Unformatted covered source | `scripts/test/formatting.test.mjs` |
| MJS lint error and warning-as-failure | `scripts/test/eslint-coverage.test.mjs` |
| Unhandled typed Promise | `scripts/test/eslint-coverage.test.mjs` |
| Reverse package dependency/import | `scripts/test/package-boundaries.test.mjs` |
| Missing policy file or stale npm command in documentation | `scripts/test/workspace-hygiene.test.mjs` |
| Legacy source growth, oversized new file, and stale ceiling | `scripts/test/maintainability.test.mjs` |
| Malformed TSDoc | `scripts/test/eslint-coverage.test.mjs` |
| Unreviewed public export inventory drift | `scripts/test/api-governance.test.mjs` |
| Unreviewed API report drift | `scripts/test/api-governance.test.mjs` |

Positive controls also confirm that formatted input, the approved dependency
direction, reduced maintainability ceilings, valid PR titles, and explicit API
report update mode are accepted.
