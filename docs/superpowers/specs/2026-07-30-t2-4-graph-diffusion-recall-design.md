# T2.4 Graph Diffusion Recall Channel Design

Date: 2026-07-30
Status: Approved (standing authorization)

## Goal

Complete the fourth HINDSIGHT recall channel — graph diffusion — and merge it into the existing RRF fusion in `MemoryManager.search`. Moss already has BM25 + semantic + RRF; this adds the graph-diffusion channel so memory recall surfaces topic-related siblings that may not lexically/semantically match the query but are linked via shared `topic`.

This is T2.4 on the roadmap (currently `[ ]` unimplemented). It is pure code (no hardware dependency), so it's an honest advance.

## Boundary

- Graph edges = shared `topic`. Entries with the same `topic` value are graph neighbors (siblings). No new fields added to `MemoryEntry` — `topic` already exists. Entries without a `topic` are not graph nodes (no diffusion from/to them).
- Diffusion: one hop only (siblings of seed entries). No multi-hop expansion this slice (keeps it bounded and avoids runaway fan-out; HINDSIGHT uses multi-hop but one-hop captures the value and is provably bounded).
- The diffusion channel merges into the existing RRF fusion (the same `k=60` reciprocal-rank pool), adding sibling scores. Siblings that already matched (BM25/semantic) are not double-counted; only NEW siblings discovered via the graph get added.
- Disabled when no `embeddingProvider` or no topic-grouped entries present (the graph is empty → no-op, existing behavior preserved).
- Does NOT change existing search results for queries where no topic-linked siblings exist (additive only).

## Architecture

In `MemoryManager.search`, after the BM25+semantic RRF fusion block, add a graph-diffusion step:

1. Collect seed ids = entries already in the fused result set (the RRF pool, top `limit*2`).
2. For each seed with a `topic`, find siblings = other filtered entries sharing that `topic` (one-hop graph neighbors).
3. Exclude siblings already in the result set (no double-count).
4. For each new sibling, compute a diffusion score = `seedScore * decay` (decay = 0.5 for one-hop; the sibling inherits a fraction of its seed's fused score, reflecting "related but less directly relevant").
5. Add siblings to the RRF pool with their diffusion score, then re-sort the merged pool by score.

This keeps the change localized to the search method and additive. The `topic`-sibling lookup is cheap (group entries by topic once).

## Failure Semantics

- No topic on any seed → no siblings → no-op (existing behavior).
- Sibling already in result → skipped (no double-count).
- Embedding provider absent → diffusion still runs (it only needs `topic`, not embeddings); the graph channel is independent of the semantic channel.

## Testing

TDD via `memory-search.spec.mjs` (extend) or a new `memory-graph-diffusion.spec.mjs`:

- Two entries share `topic: 'deploy'`; query matches one lexically → the other (sibling) appears in results even though it doesn't match the query.
- Sibling already matching → not double-counted (score not inflated).
- No `topic` on seed → no sibling surfaced (no-op).
- Entries with different topics → no cross-topic diffusion.
- Existing search behavior unchanged when no topic-linked siblings (regression).

## Follow-up

- Multi-hop diffusion (siblings of siblings, with decaying weight) — if one-hop proves valuable.
- Time-filter recall channel (the other missing HINDSIGHT channel, currently deferred).
- Cross-encoder re-rank (deferred per paper).
