## Why

Moss can currently prove that a task recovered, but the learned patch retains little more than tool names such as `exec -> exec`; the real-board camera experiment therefore produced a valid but ineffective patch and an inconclusive A/B result. The loop now needs to preserve the actionable, safely reusable difference between failed and recovered traces and prove that the resulting knowledge improves held-out execution.

## What Changes

- Compile trusted failed/recovered traces into sanitized, parameterized `RecoveryRecipe` records with applicability, preconditions, operations, evidence checks, terminal acceptance, safety constraints, and provenance.
- Reject candidate knowledge that lacks procedural detail, adds no capability beyond the base Skill, or is overfit to one environment.
- Resolve recipe parameters only from trusted task and environment bindings and add freshness/content acceptance predicates required to detect stale or poisoned artifacts.
- Require held-out Shadow replay before publication and keep published recipe revisions immutable.
- Extend experiment decisions with preregistered success-superiority or success-noninferiority-plus-cost-superiority hypotheses.
- Add a safe RDK X5 camera output-path-collision scenario and require a balanced 20-per-arm real-board experiment before declaring the mechanism effective.

## Capabilities

### New Capabilities

- `actionable-recovery-recipes`: Trusted trace-diff compilation, sanitization, parameter binding, provenance, and recipe lifecycle.
- `knowledge-quality-gates`: Procedural-detail, novelty, subsumption, environment-generalization, and Shadow replay gates.
- `parameterized-artifact-acceptance`: Safe variable resolution plus freshness, digest, dimensions, and image-content predicates.
- `effectiveness-experiment-decisions`: Preregistered benefit hypotheses and exposure-clean real-board A/B activation decisions.

### Modified Capabilities

None. The repository currently has no synchronized main capability specs; the new capabilities extend the existing staged implementation without changing a published main spec.

## Impact

The change affects trusted learning and patch coordination, acceptance evaluation, memory injection, experiment assignment and analysis, CLI real-board benchmark scripts, JSONL evidence schemas, tests, and self-evolution operating documentation. Historical Experience, LearningEvent, patch, and experiment records remain readable; only new actionable recipes are eligible for the new publication path.
