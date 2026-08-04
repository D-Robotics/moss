## Context

The first three self-evolution stages established task-scoped evidence, failure/recovery events, conservative candidate promotion, multi-Skill attribution, and exposure-aware A/B reporting. A real RDK X5 camera trial proved those boundaries work, but also exposed a semantic bottleneck: `LearningEvent.toolSequence` stores only tool names, so the published patch added `exec -> exec` while omitting the corrected assumption, arguments, applicability, and acceptance evidence. Both A/B arms succeeded and Treatment cost more; the system correctly stayed Shadow but did not become more capable.

The fourth stage must turn objective trace differences into a safe executable knowledge unit and separately prove that the unit improves held-out behavior. Historical schemas remain readable and the model cannot become the source of truth for commands, success, or promotion.

## Goals / Non-Goals

**Goals:**

- Persist actionable, sanitized, parameterized recovery knowledge with evidence provenance.
- Reject content-poor, redundant, unsafe, or overfit candidates before publication.
- Validate recipes through held-out Shadow replay and exact exposure receipts.
- Evaluate benefit using either success superiority or success noninferiority plus cost superiority.
- Demonstrate or conservatively reject usefulness on a safe RDK X5 camera stale-artifact scenario.

**Non-Goals:**

- Arbitrary shell-program synthesis or execution of model-authored commands.
- Automatic mutation of base `SKILL.md` or `ACCEPTANCE.json` files.
- Cross-device generalization from a single board family.
- Causal proof for multi-Skill plans.
- Relaxing existing completion, safety, or rollback gates.

## Decisions

### Add `RecoveryRecipe` beside, not inside, prose observations

An append-only recipe log stores typed selectors, failure signatures, operations, bindings, predicates, constraints, and source IDs. Learning observations continue to provide concise prompt context, while published learned Skill content is rendered from a validated recipe. This avoids treating prose summaries as executable truth. Embedding raw commands in LearningEvent was rejected because it would duplicate sensitive traces and make schema evolution unsafe.

### Compile through an operation adapter registry

The generic compiler correlates failed and recovered Experience records and delegates recognized operations to allowlisted adapters. The first adapter covers RDK camera capture and emits typed operations such as probe sensor, capture frame, select a run-fresh size-valid YUV, convert NV12, and validate JPEG. Values become placeholders resolved from trusted bindings. Unrecognized or ambiguous traces stay auditable but cannot publish. A free-form model compiler was rejected because sanitization after generation is not a reliable trust boundary.

### Use structural quality and subsumption checks

Quality checks require operations, bindings, evidence predicates, failure-specific novelty, and independent evidence. Base Skill subsumption uses normalized operation and invariant tokens, not prose similarity alone. A model may explain a rejection but cannot override it. This deliberately favors false negatives over publishing inert or dangerous knowledge.

### Extend acceptance with non-shell artifact predicates

Freshness, size, digest, dimensions, and image-content checks execute in the verifier implementation, with variables resolved from a typed binding map. Predicate values are never concatenated into shell commands. The camera content metric uses deterministic decoded-pixel variation or entropy and records only the metric and digest.

### Separate training, Shadow, and A/B evidence

Recipe source IDs form the training set. Shadow replay must use disjoint task/run/attempt/evidence IDs. A/B begins only after Shadow passes and freezes the recipe revision and hypothesis before the first eligible outcome. Exact receipt matching prevents prompt injection from being mistaken for treatment exposure.

### Support two activation hypotheses

`success_superiority` retains the existing primary success-effect decision. `success_noninferiority_cost_superiority` requires a frozen success noninferiority margin plus statistically and practically meaningful improvement in selected retry, tool, time, or token metrics. Multiple cost metrics use a preregistered rule rather than post-hoc selection. Safety failures, contamination, unknown environment, and new failure classes veto activation.

### Use an output-path collision as the bounded real-board proof

Before each held-out camera task the harness occupies the required `/tmp/photo.jpg` target with a benchmark-owned empty directory. Terminal acceptance still requires a real JPEG. Training recoveries establish the missing invariants: inspect target type, remove only the exact empty collision, convert to a unique staging path, validate it, and then promote it to the requested path. The empty directory is removed during recovery or cleanup and no device configuration or firmware is changed. This scenario tests a real class of automation failure while remaining reversible.

## Risks / Trade-offs

- [The first adapter is device-specific] -> Keep the recipe schema generic, isolate adapters, and report the bounded scope of the proof.
- [Base agent may already handle the output collision] -> Pre-register the scenario and terminal checks; if Control also handles it cheaply, report no benefit instead of weakening Control.
- [Twenty tasks per arm are slow] -> Bootstrap and Shadow first, stop early only for safety/contamination or a deterministic implementation defect, and preserve resumable outcomes.
- [Image-content thresholds can reject dark scenes] -> Calibrate a conservative threshold from pre-experiment board samples and freeze it before eligible outcomes.
- [Parameterized operations could expand command authority] -> Resolve only typed allowlisted fields and execute through existing tool/safety boundaries.

## Migration Plan

1. Add optional recipe and experiment fields with backward-compatible readers.
2. Keep existing tool-sequence candidates auditable but make them ineligible for actionable publication.
3. Compile new recipes only from new trusted evidence; do not synthesize recipes from historical prose.
4. Run unit and integration tests, then safe real-board Shadow replay.
5. Run the frozen balanced A/B experiment; activate only on a passing decision.
6. Roll back by disabling actionable recipe exposure; append-only records and existing learned artifacts remain readable.

## Open Questions

- Which additional device Skill adapters should follow the camera proof is intentionally deferred until the bounded experiment establishes value.
