## Context

Moss is a cross-platform agent harness that can run on a developer host, control an RDK board from that host, or run fully on a board. Its skill library is live and extensible: builtins, bundled robotics skills, workspace/global `SKILL.md` files, SkillHub installs, and learned skills may appear without a release or retraining cycle.

Today, `SkillRegistry.matchByText` independently scores names, descriptions, triggers, and limited word overlap. TUI and one-shot paths inline at most three matched bodies and also expose a character-budgeted catalog. `load_skill` and agent-loop nudges provide recovery, but no shared component explicitly predicts the selected set, cardinality, and dependency order.

The SkillComposer paper demonstrates that these three decisions are coupled and that an ordered, variable-length plan can outperform fixed top-k retrieval. Its exact architecture assumes a fixed closed skill vocabulary and a required embedding encoder, which conflicts with Moss's dynamic library and board-first deployment constraints. This design adopts the structured-composition abstraction while replacing the fixed vocabulary and mandatory model with a provider architecture and deterministic baseline.

## Goals / Non-Goals

**Goals:**

- Produce one observable `SkillPlan` that jointly represents which skills, how many, and in what order.
- Keep every Moss installation functional offline and without model artifacts or native inference dependencies.
- Make deterministic composition the default for full board deployments and a reliable fallback everywhere.
- Allow optional local or remote open-vocabulary model providers on capable hosts and boards.
- Use the live registry so newly installed or learned skills can participate immediately.
- Incorporate task text, environment state, runtime policy, dependencies, conflicts, and prior plan prefix into composition.
- Reduce prompt cost through progressive disclosure and remove divergent selection behavior between TUI and one-shot paths.
- Support shadow evaluation and safe, reversible rollout.

**Non-Goals:**

- Training or shipping a neural composer in the first implementation phase.
- Bundling a large embedding checkpoint or inference runtime in the core npm package.
- Replacing `load_skill`, SkillHub, slash commands, or the skill-learning pipeline.
- Generating new skill bodies during composition.
- Treating a predicted plan as authorization to execute privileged tools.
- Reproducing the paper's fixed-ID decoder exactly.

## Decisions

### 1. Introduce a provider-neutral composition boundary

Add a `SkillComposer` interface under `src/skills`:

```ts
export interface SkillComposeInput {
  task: string;
  environment: SkillEnvironmentContext;
  skills: SkillMeta[];
  maxSkills: number;
}

export interface PlannedSkill {
  stableId: string;
  name: string;
  score: number;
  reasonCode: string;
}

export interface SkillPlan {
  skills: PlannedSkill[];
  confidence: number;
  rejected: boolean;
  provider: 'rules' | 'local-model' | 'remote-model' | 'fallback';
  diagnostics?: SkillPlanDiagnostics;
}

export interface SkillComposer {
  compose(input: SkillComposeInput, signal?: AbortSignal): Promise<SkillPlan>;
}
```

`SkillPlan.skills` is ordered, contains no duplicates, and may be empty. Stable IDs are recorded for traceability, while names remain the user-facing and `load_skill` compatibility key.

Alternative considered: retain independent `matchByText` calls in each UI. Rejected because it cannot express cardinality/order consistently and makes evaluation dependent on the entry point.

### 2. Use a staged composition pipeline

Every provider is wrapped by a shared orchestration pipeline:

1. Snapshot enabled skills from the live registry.
2. Filter ineligible skills using environment and runtime policy.
3. Retrieve a bounded candidate set from compact metadata.
4. Compose a variable-length ordered plan, including STOP/no-skill.
5. Validate identities, duplicates, conflicts, hard dependencies, and limits.
6. Fall back to the deterministic composer if the selected provider fails validation or runtime budgets.
7. Resolve full bodies only for the validated ordered plan.

This separates semantic prediction from hard safety and environment constraints. A model can recommend a skill but cannot bypass `requiresBoard`, disabled state, permissions, or approval policy.

### 3. Ship a deterministic open-vocabulary composer first

The mandatory provider uses compact, dependency-free retrieval and graph composition:

- Exact name/alias and trigger matches retain strong weights.
- TF-IDF unigram/bigram features score English and code-like metadata.
- Character bigram/trigram features provide Chinese and mixed-language coverage without a tokenizer dependency.
- Candidate documents use name, description, tags, triggers, and an optional compact summary, never the full body.
- Cardinality is variable: candidates must pass an absolute relevance threshold and a score-gap/coverage rule; zero skills is a valid result. `maxSkills` is a safety cap, not a target count.
- Hard dependency edges are topologically ordered. Workflow edges and retrieval score break ties. Cycles degrade to a stable order and emit diagnostics.
- Conflicting skills cannot coexist unless an explicit policy resolves the conflict.

The lexical prior follows the paper's finding that TF-IDF is a strong decode-time signal for short, syntactically specific skill metadata. The graph captures the paper's dependency-aware ordering without requiring a trained autoregressive decoder.

Alternative considered: embeddings as the mandatory baseline. Rejected because they add runtime, model-download, memory, and ARM compatibility costs and are not required to validate the composition abstraction.

### 4. Optional models operate over live candidates, not fixed classes

Local and remote providers receive the task, environment summary, and current candidate metadata and return names or stable IDs constrained to that candidate set. They may implement listwise generation, pairwise scoring, or a small autoregressive decoder, but their public contract is open-vocabulary: adding a valid skill does not require expanding a fixed output layer.

The provider result passes through the same validator and graph constraint layer as the rules result. New or out-of-distribution skills retain the deterministic lexical path, even when a model provider is active.

Alternative considered: a fixed classifier over current skill IDs. Rejected because SkillHub installs, workspace skills, and learned skills would be unselectable until retraining.

### 5. Preserve board positioning through deployment modes

Configuration supports `rules`, `local-model`, `remote-model`, and `auto` modes.

- `rules` is always available and is the default for full board execution.
- In host-controls-board deployments, composition runs on the host; the ordered execution guidance may target the board.
- `local-model` is opt-in and lazily loads separately installed artifacts. Core startup must not probe, download, or allocate model resources.
- `remote-model` requires explicit network/provider configuration and never becomes an implicit board dependency.
- `auto` selects a provider only after checking configured policy, platform support, artifact availability, memory/latency budgets, and network policy. Otherwise it selects `rules`.
- Any timeout, exception, malformed output, unknown skill, or failed validation immediately uses `rules` for the same request.

Model artifacts and inference runtimes are distributed separately from `@rdk-moss/agent`. This prevents npm package bloat and native-install failures on unsupported boards.

### 6. Extend metadata without breaking existing skills

Add optional fields to `SkillMeta` and accepted `SKILL.md` metadata:

- `stable_id`
- `inputs`, `outputs`
- `requires`, `before`, `after`
- `conflicts`
- `summary`

Missing fields produce current-compatible defaults. When `stable_id` is absent, Moss derives a deterministic ID from normalized source scope and skill name; content hash/version is recorded separately so edits do not silently change identity. Unknown references and dependency cycles produce diagnostics but do not make the registry unusable.

I/O overlap may create inferred soft edges; explicit `before`, `after`, and `requires` declarations remain authoritative. Workflow co-occurrence from successful traces can later adjust soft edge weights but cannot override hard constraints.

### 7. Unify injection and retain explicit recovery

Replace direct `buildMatchedSkillContext` selection in TUI and one-shot paths with a shared asynchronous `composeSkillPlan` call. Full bodies are loaded in plan order and inserted into the dynamic context bucket. The compact catalog is omitted when a high-confidence plan is available; it remains available for catalog questions and low-confidence recovery.

`load_skill` remains supported. If the requested skill is already present in the active plan, the tool returns a concise already-loaded result instead of duplicating the body. Manual loads are appended to trace state but are distinguished from composer selections.

Path-discovery nudges remain as a narrow recovery mechanism during migration. Their frequency can be reduced or disabled once plan recall is proven.

### 8. Make composition measurable before it controls behavior

Each plan emits a redacted trace record containing provider, candidate IDs/scores, final order, cardinality, rejection, fallback reason, latency, and injected character/token estimate. Full skill bodies and sensitive task content are not duplicated in telemetry.

The evaluation harness scores the actual composed plan separately from manual `load_skill` calls. Required metrics are Set F1, Set Exact Match, Recall@5, MRR, nDCG@5, cardinality error, dependency-violation rate, rejection accuracy, provider/fallback latency, injected token cost, and downstream verifier pass rate. Results are segmented by language, deployment mode, skill source, and board/host environment.

Shadow mode computes both active and candidate-provider plans while only the active plan affects context. Promotion requires explicit thresholds relative to the deterministic baseline; automatic promotion is out of scope.

## Risks / Trade-offs

- [Lexical retrieval misses paraphrases] → Keep manual/catalog recovery, add Chinese character features, mine failure cases, and allow optional semantic providers.
- [Automatic composition injects confidently wrong guidance] → Support zero-skill output, confidence thresholds, hard validation, shadow rollout, and downstream outcome evaluation.
- [Dependency metadata becomes stale] → Validate references on registry reload, expose diagnostics, and distinguish explicit hard edges from inferred soft edges.
- [Optional model consumes board resources needed by robotics workloads] → Default boards to rules, require opt-in budgets, lazy-load artifacts, apply strict timeouts, and fall back without retry loops.
- [Different providers produce inconsistent plans] → Use one provider-neutral plan schema and shared post-validation/order constraints.
- [Dynamic skill changes invalidate cached retrieval data] → Key caches by a registry snapshot digest and rebuild incrementally on registry reload.
- [Current evaluation's `load_skill`-only metric reports false failures] → Record composed/injected plans as the primary selection signal and keep manual loads as a separate measure.
- [More metadata burdens skill authors] → Keep every new field optional, derive safe defaults, and have skill-learning/tooling suggest metadata rather than require it.

## Migration Plan

1. Add metadata parsing, `SkillPlan` types, deterministic composer, and unit tests behind `skills.composer.enabled=false`.
2. Add tracing and harness scoring; run the composer in shadow mode against the existing injection path.
3. Enable deterministic composition for development/CI cohorts while retaining immediate legacy fallback.
4. Compare single-skill, multi-skill, rejection, RDK, Chinese/English, latency, token, and downstream metrics across at least three runs per task.
5. Make deterministic composition the default after rollout gates pass; keep `skills.composer.mode=legacy` for one release as rollback.
6. Add optional remote/local providers only after the core contract and fallback behavior are stable.
7. Remove or narrow redundant catalog injection and discovery nudges after compatibility telemetry confirms no regression.

Rollback consists of setting composer mode to `legacy` or disabling the feature flag; no skill files or learned data require migration back.

## Open Questions

- What initial promotion thresholds should be required for rejection accuracy and downstream pass rate?
- Should the first deterministic release cap plans at four or five skills for ordinary tasks, with a larger explicit override?
- Which board facts are already available synchronously at composition time, and which require a later re-plan?
- Should optional local-model artifacts be distributed by SkillHub, a dedicated model manager, or an existing RDK package channel?
- How long should `legacy` mode remain supported after deterministic composition becomes default?
