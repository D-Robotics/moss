## 1. Baseline and contracts

- [x] 1.1 Capture a reproducible pre-change baseline from the skill-eval suite for single-skill, multi-skill, rejection, Chinese/English, RDK, injected-size, latency, explicit `load_skill`, and downstream pass-rate metrics.
- [x] 1.2 Add `SkillComposeInput`, `SkillEnvironmentContext`, `PlannedSkill`, `SkillPlan`, diagnostics, provider mode, and `SkillComposer` interfaces under `packages/moss-agent/src/skills` and export them from the public skills entry point.
- [x] 1.3 Add configuration parsing and validation for `legacy`, `rules`, `local-model`, `remote-model`, `auto`, shadow mode, maximum skills, deadline, and optional resource budgets, with board-safe defaults.
- [x] 1.4 Add contract tests proving empty plans, unique ordered skills, bounded cardinality, abort handling, and provider-neutral serialization.

## 2. Skill metadata and registry snapshots

- [x] 2.1 Extend `SkillMeta` and frontmatter parsing with optional `stable_id`, `summary`, `inputs`, `outputs`, `requires`, `before`, `after`, and `conflicts` while preserving existing skill behavior.
- [x] 2.2 Implement deterministic derived stable IDs, separate content-version hashes, and a registry snapshot digest that changes when enabled skills or compact metadata change.
- [x] 2.3 Implement metadata reference validation and diagnostics for unknown references, self-references, invalid values, duplicate stable IDs, and dependency cycles without dropping unrelated valid skills.
- [x] 2.4 Update builtin and representative bundled RDK skills with explicit metadata for high-value workflows, including inspect-plan-refactor-verify and board-identify-connect-ROS/deploy chains.
- [x] 2.5 Update skill-learning promotion so learned skills receive or derive compact retrieval metadata and participate after registry reload.
- [x] 2.6 Add registry tests covering legacy files, body-only edits, stable identity, reload/cache invalidation, RDK metadata, cycles, conflicts, and newly promoted skills.

## 3. Deterministic candidate retrieval

- [x] 3.1 Implement a compact candidate-document builder using skill name, description, tags, triggers, aliases, and optional summary without reading full bodies.
- [x] 3.2 Implement cached TF-IDF unigram/bigram scoring for English and code-like metadata, keyed by registry snapshot digest.
- [x] 3.3 Implement Unicode character bigram/trigram scoring for Chinese and mixed-language tasks and combine it with exact name/alias/trigger weights.
- [x] 3.4 Apply enabled state, board availability, permissions, runtime policy, and other hard eligibility filters before candidates can enter a final plan.
- [x] 3.5 Add retrieval tests for exact triggers, paraphrases, Chinese prompts, noisy overlap, newly installed skills, disabled skills, board requirements, and no-match tasks.

## 4. Deterministic structured composition

- [x] 4.1 Implement the rules composer with a bounded candidate set, absolute relevance threshold, score-gap/coverage cardinality rule, configurable safety cap, and explicit zero-skill/STOP outcome.
- [x] 4.2 Build a dependency graph from explicit `requires`/`before`/`after`, inferred I/O overlap, and optional workflow edges, preserving hard versus soft edge semantics.
- [x] 4.3 Implement dependency-aware ordering with deterministic tie-breaking and conflict resolution; emit diagnostics and stable fallback behavior for cycles.
- [x] 4.4 Implement shared plan validation that rejects unknown identities, duplicates, ineligible skills, unresolved conflicts, cardinality overflow, and hard dependency violations.
- [x] 4.5 Add deterministic-composer tests for single, multi, no-skill, variable cardinality, dependency ordering, conflict resolution, cycle fallback, and repeatability across processes.

## 5. Runtime integration and progressive disclosure

- [x] 5.1 Add a composer orchestrator that snapshots the live registry, invokes the configured provider with an `AbortSignal`, validates output, and falls back to the rules composer with a reason code.
- [x] 5.2 Replace direct `buildMatchedSkillContext` selection in one-shot execution with the shared orchestrator while preserving `legacy` mode for rollback.
- [x] 5.3 Replace direct `buildMatchedSkillContext` selection in TUI execution with the same orchestrator and confirm both entry points produce identical plans for identical inputs and environment.
- [x] 5.4 Resolve and inject full skill bodies only for the validated plan, in plan order, and suppress the compact catalog when a high-confidence plan makes it redundant.
- [x] 5.5 Track the active plan per run so `load_skill` avoids duplicate body injection while retaining manual load, SkillHub-install recovery, and explicit catalog behavior.
- [x] 5.6 Narrow path-discovery and post-install nudges to cases not already covered by the active plan and prevent repeated composer/load retry loops.
- [x] 5.7 Add integration tests for TUI, one-shot, manual loads, SkillHub install/reload, prompt-cache dynamic context, low-confidence recovery, and legacy rollback.

## 6. Optional provider framework and board safeguards

- [x] 6.1 Implement provider registration and lazy resolution so optional local/remote providers are not imported, initialized, downloaded, or probed in `rules` mode.
- [x] 6.2 Implement `auto` provider selection from explicit policy, deployment topology, platform/runtime support, artifact availability, network permission, and configured latency/memory budgets.
- [x] 6.3 Implement timeout, abort, malformed-output, unknown-skill, and validation-failure fallbacks to the deterministic provider without retry loops.
- [x] 6.4 Implement shadow mode that computes and traces an optional candidate provider plan while only the active plan controls context.
- [x] 6.5 Define an open-vocabulary local/remote provider adapter that accepts live candidate metadata and returns constrained names/stable IDs rather than fixed classifier labels.
- [x] 6.6 Add tests proving core installation and board startup require no model artifact or native inference package, and that host-controls-board composition executes on the host.
- [x] 6.7 Add provider conformance tests using fake fast, slow, failing, malformed, fixed-vocabulary, and unseen-skill providers.

## 7. Observability and evaluation

- [x] 7.1 Emit redacted composition trace records with provider, registry digest, candidate identities/scores, final order, cardinality, rejection, fallback, latency, and injected-size estimate.
- [x] 7.2 Apply existing secret-redaction and bounded-output policies and verify traces never persist full skill bodies or detected secrets.
- [x] 7.3 Update the skill-eval collector and scorer to evaluate actual composed/injected plans separately from explicit `load_skill` calls.
- [x] 7.4 Implement Set F1, Set Exact Match, Recall@5, MRR, nDCG@5, cardinality error, dependency-violation rate, rejection accuracy, latency, fallback rate, injected token estimate, and downstream pass-rate reporting.
- [x] 7.5 Segment reports by provider, language, deployment mode, skill source, single/multi/no-skill class, and host/board environment.
- [x] 7.6 Add shadow-comparison reports and configurable promotion gates that never promote a provider automatically.

## 8. Rollout and documentation

- [x] 8.1 Run the deterministic composer in shadow mode against the captured baseline for at least three attempts per task and document regressions, confidence thresholds, cardinality limits, and dependency failures.
- [x] 8.2 Tune only on the designated training/validation tasks, freeze parameters, and run a held-out evaluation before enabling deterministic composition for development cohorts.
- [x] 8.3 Verify offline board behavior, cold-start time, steady-state memory, composition latency, model-free installation, and concurrent robotics workload impact on representative supported boards.
- [x] 8.4 Enable rules composition behind a default-off feature flag, exercise legacy rollback, then make it default only after explicit review of quality, rejection, downstream, token, and board-resource gates.
- [x] 8.5 Document the Composer architecture, configuration modes, metadata schema, board/host deployment recommendations, optional provider contract, tracing, troubleshooting, and rollback procedure.
- [x] 8.6 Publish a follow-up decision record for whether to train or adopt a local open-vocabulary model, based on measured residual errors and board resource budgets rather than making it a prerequisite for this change.
