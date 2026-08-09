# Adaptive Skill Composer

The Skill Composer selects an ordered set of skills from the live registry for
each task. It is an open-vocabulary component: newly installed and learned
skills participate through metadata after registry reload, without retraining
a fixed-label classifier. The feature is default-off during rollout, and the
existing matcher remains available as `legacy` mode.

## Recommended configuration

Add this nested object to `~/.config/moss/config.json` or `.moss/config.json`:

```json
{
  "skills": {
    "composer": {
      "enabled": true,
      "mode": "rules",
      "maxSkills": 4,
      "candidateLimit": 12,
      "deadlineMs": 750,
      "minScore": 0.08,
      "minConfidence": 0
    }
  }
}
```

| Mode           | Behavior                                                                       |
| -------------- | ------------------------------------------------------------------------------ |
| `legacy`       | Previous direct text matcher and immediate rollback mode.                      |
| `rules`        | Deterministic multilingual retrieval and dependency ordering; no model.        |
| `local-model`  | Registered optional local open-vocabulary provider, with rules fallback.       |
| `remote-model` | Registered optional remote provider, with rules fallback.                      |
| `auto`         | Select from runtime capabilities and budgets; board deployments stay on rules. |

`localModelEnabled` and `remoteModelEnabled` are explicit opt-ins. Provider
packages and model artifacts are lazy: core installation and `rules` mode do
not import, probe, download, or initialize them.

For robotics, use `rules` on a board to reserve CPU, memory, and accelerator
capacity for the workload. With `host-controls-board`, an optional composer can
run on the host while device and ROS operations remain on the board. Select
`local-model` on the board only after measuring cold start, memory, latency,
and concurrent robotics workload impact on that exact target.

## Skill metadata

All new fields are optional. Compact metadata is retrieved first; the full body
is loaded only after validation.

```yaml
---
name: deploy-camera-node
stable_id: workspace:deploy-camera-node
description: Deploy and verify an RDK ROS camera node.
summary: Prepare the board, deploy the node, and verify image publication.
trigger: [deploy camera, camera node, 部署相机节点]
tags: [rdk, ros, camera]
inputs: [board-identity, workspace-source]
outputs: [deployed-camera-node]
requires: [rdk-device]
after: [rdk-board-knowledge]
before: [verification-before-completion]
conflicts: []
requires_board: true
---
```

`stable_id` identifies a logical skill across body edits. Moss derives one if
it is omitted. A separate content hash invalidates retrieval caches when
metadata or enabled skills change. Unknown references, self references,
duplicate IDs, and dependency cycles produce registry diagnostics without
hiding unrelated valid skills.

## Optional provider contract

An optional provider receives the task, environment, budgets, and a bounded
list of live candidate metadata. It returns only names or stable IDs from that
list, plus confidence and reason codes. It must not use a fixed output-label
vocabulary, so a newly installed skill can participate immediately.

All provider output passes through shared validation. Timeout, abort,
initialization failure, malformed output, unknown skills, conflicts, and hard
dependency violations fall back once to rules. There is no model retry loop.

## Progressive disclosure and recovery

Only selected skill bodies are injected, in plan order. A high-confidence plan
suppresses the redundant catalog. `load_skill` remains available for explicit
recovery and SkillHub installation; loading an already active skill returns a
short status instead of injecting the body twice.

## Shadow mode and tracing

```json
{
  "skills": {
    "composer": {
      "enabled": true,
      "mode": "rules",
      "shadowMode": true,
      "shadowProvider": "remote-model",
      "remoteModelEnabled": true
    }
  }
}
```

Shadow mode traces a candidate plan while only the active plan controls
context. Traces contain provider, registry digest, bounded candidate IDs and
scores, final order, rejection, fallback, latency, and injected-size estimate.
They omit task text, descriptions, and skill bodies and sanitize detected
secrets. Evaluation scores composed plans separately from explicit
`load_skill` calls and supports provider, language, deployment, source,
task-class, and host/board segmentation. Passing gates only makes a provider
eligible for human review; it never promotes itself.

In one-shot `--output-format stream-json`, each attempted plan is emitted as a
machine-readable record before agent execution:

```json
{
  "type": "skill_composition",
  "subtype": "active",
  "session_id": "...",
  "trace": {
    "provider": "rules",
    "finalOrder": ["workspace:inspect", "builtin:planning"],
    "finalNames": ["inspect", "planning"],
    "cardinality": 2,
    "rejected": false,
    "latencyMs": 4,
    "injectedChars": 1820
  }
}
```

The skill-eval collector treats `trace.finalOrder` (or `finalNames` for legacy
task definitions) as the automatic selection result. Explicit `load_skill`
tool calls are reported as manual recovery and never convert a missed automatic
plan into a successful composition.

## Troubleshooting and rollback

- Empty plan: tune `minScore` or `minConfidence`, improve compact metadata, or
  use manual `load_skill` recovery.
- Missing board skill: connect the board and check `requires_board`.
- Provider fallback: verify artifact, network permission, budget, and deadline.
- Dependency warning: fix unknown references or remove the cycle.
- Roll back immediately by setting the mode to `legacy` or `enabled` to
  `false`. Skill files require no migration.
