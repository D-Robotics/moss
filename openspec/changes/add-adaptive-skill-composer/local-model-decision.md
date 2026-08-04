# Decision: do not add a local Composer model yet

Date: 2026-08-04

Status: accepted for this change; revisit after additional shadow data.

## Context

The deterministic open-vocabulary Composer now reaches 90.7% Set F1, 100% rejection accuracy, and zero dependency violations on 129 shadow samples. On a 3 GB RDK X5 it runs offline at 10.06 ms P95 and adds about 27-31 MB RSS. Standard Moss packaging contains no model artifact or native inference runtime.

Residual error is concentrated in exact cardinality and paraphrase coverage: full-suite Set Exact Match is 72.1%, held-out Set Exact Match is 57.1%, and held-out cardinality error is 0.571. These are real opportunities for a learned ranker, but they do not yet justify placing another model in the board runtime or core package.

## Decision

Do not train, bundle, or adopt a local model as a prerequisite for this rollout. Continue with the deterministic provider as the opt-in active path and keep the existing open-vocabulary provider adapter for host-side or remote shadow experiments.

## Revisit criteria

Prototype a local model only when new shadow data shows a persistent error cluster that compact metadata and deterministic retrieval cannot fix. Any candidate must:

- select exclusively from live candidate metadata, never a fixed class vocabulary;
- improve held-out Set F1 and Set Exact Match without lowering rejection accuracy below 90%;
- remain optional and absent from the core npm artifact;
- fall back to rules on timeout, malformed output, unknown skill, or failed validation;
- on RDK X5, stay below 25 ms P95 composition latency and 64 MB additional steady RSS, with an explicitly reviewed artifact budget;
- first run in shadow mode, preferably on the host in host-controls-board deployments.

The current evidence favors spending complexity on metadata quality, evaluation coverage, and semantic downstream verification before spending board memory and lifecycle cost on a model.
