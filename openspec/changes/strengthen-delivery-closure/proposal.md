# Change: strengthen the evidence-bound delivery closure

## Why

The durable execution graph can recover and schedule long-running work, but requirements,
clarifications, proposal approval, acceptance revisions, independent review, and the final delivery
report are not yet one traceable product workflow. Product surfaces also read legacy task projections
independently, which can disagree about whether work is complete.

## User outcome

- A delivery case advances from intake through clarification, proposal, execution, verification, and report.
- Every mutating node has revisioned acceptance criteria before it can be created.
- Changes to criteria invalidate old verdicts instead of silently reusing stale evidence.
- An independent read-only whole-change reviewer gates non-minimal delivery.
- Web and other hosts read and mutate the same execution projection and revision.
- The capability Web smoke exercises the real server with its Origin and CSRF contract.

## Non-goals

- Remote project management, multi-tenancy, a plugin marketplace, or a second delivery database.
- Copying Chorus source, visual assets, or AGPL-licensed implementation.
- Replacing deterministic verification with model judgment.

## Compatibility

`TaskRunLedger`, Goal, Plan, Loop, and `/api/tasks` remain compatibility adapters for one release
cycle. The new beta interfaces are additive under `@rdk-moss/agent/orchestration`.
