# Code-standard negative fixtures

These data-only fixtures describe deliberately invalid mini-workspaces. Gate regression tests
materialize each `files` map in a temporary directory, run the relevant exported checker, and assert
the listed diagnostic. Keeping fixture contents inside JSON prevents the repository's live hygiene
check from mistaking deliberately broken documentation for real contributor guidance.

- `line-endings.json` proves CRLF and missing-final-newline detection is byte deterministic.
- `stale-policy-reference.json` proves missing local policy files and npm scripts are rejected.
- `reverse-package-dependency.json` proves core cannot depend on or import agent.
- `maintainability-growth.json` proves a legacy hotspot cannot exceed its recorded ceiling.

Each gate's regression test also contains a corresponding valid case so the fixture cannot pass
merely because the checker rejects every input.
