# Proposal: harden Moss delivery quality and user journeys

## Why

Moss currently loses stable error identity at the streaming seam, treats undecryptable ciphertext as a usable credential, does not route oneshot SIGINT through runtime cancellation, permits cross-process session overwrite, and can scaffold or publish incompatible package pairs. These are observable reliability failures rather than style debt.

## Outcome

Create deep Modules for structured error outcomes, encrypted credential loading and durable writes, cancellation ownership, crash-recoverable session ownership, and coordinated package release sets. Each Module exposes one testable interface and keeps rendering or transport details in adapters. Official release mutation is serialized by a trusted workflow, with a recovery journal persisted before registry mutation and recovery that distinguishes a committed release from a partial promotion.

## Non-goals

- No weakening of approval, safety precedence, SSE terminal validation, or active-lock behavior.
- No npm publish or dist-tag mutation from this source-hardening change. Source merge/push is
  qualified separately by the repository verification and review gates.
- No public contract break without API report and migration evidence.
