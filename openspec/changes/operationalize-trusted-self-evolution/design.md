## Context

The trusted loop now creates v2 Experience and TerminalVerdict evidence, learns from failed-to-recovered runs, publishes path-scoped learned Skills after independent proofs, and evaluates published patches with isolated control/treatment assignment. Production operation is still weak in four places: device fingerprints are normally computed without board/BSP facts, correction and safety metrics are partly inferred, experiment state has no CLI surface, and the real-board regression deliberately stops before publication.

The implementation must preserve the trust boundary. Raw device identity, host addresses, prompts, stdout, and credentials must not enter evolution logs. Missing identity must reduce eligibility rather than being guessed. Inspection commands must not mutate patch state.

## Goals / Non-Goals

**Goals:**

- Bind device learning and A/B outcomes to a versioned, privacy-preserving board environment identity.
- Expose experiment lifecycle, metrics, and effective thresholds through a read-only CLI surface.
- Record correction count and safety failure as structured trusted fields.
- Exercise the complete published-to-active and published-to-demoted/rollback lifecycle in deterministic integration tests.
- Keep v1 and existing v2 logs readable.

**Non-Goals:**

- Allocating proof across multiple Skills.
- Treating simulation success as real-device proof.
- Automatically mutating World-layer predicate names or bundled acceptance contracts.
- Running destructive or duplicate board actions solely to obtain paired samples.

## Decisions

### Device identity is collected by a fixed trusted probe

After a successful device connection, Moss will run one fixed read-only probe through the already established SSH session. It collects board model, OS image identity, kernel/BSP version, architecture, and optional firmware package version. The probe contains no model-, contract-, or user-controlled command fragments. Raw values remain in the in-memory runtime handle only; persisted records contain a versioned SHA-256 fingerprint and completeness status.

Local runs remain eligible with workspace plus runtime identity. Device runs require board model and at least one OS/BSP/firmware version signal; otherwise their fingerprint is `unknown` for automatic promotion and A/B purposes.

Alternative considered: derive identity only from workspace and `device` mode. Rejected because two boards or flashed images could share evidence. Using hostname/IP was rejected because it is sensitive and identifies a connection, not a reproducible environment.

### Experiment configuration is workspace-scoped and fail-closed

Optional `.moss/evolution.json` contains A/B thresholds. A pure loader validates finite ranges and returns conservative defaults plus diagnostics. Invalid values never loosen a guardrail: the affected value falls back to its default. No command in this change writes the file.

### `/evolution` is a read-only operator surface

The command registry will provide `status`, `experiments`, `patch <id>`, and `config`. Reports are built from append-only CandidatePatch and PatchExperiment logs. They show lifecycle, exposure counts, sample sufficiency, Wilson intervals, retries, tools, duration, tokens/cost, safety failures, and rollback state without displaying prompts, raw stdout, device identity, or host data.

### Safety and correction metrics become objective fields

`AcceptSpec.safetyCritical` is an optional World-authored marker. A failed marked terminal predicate produces `TerminalVerdictEntry.safetyFailed=true` with a stable reason code. The terminal gate records `correctionCount` from prior trusted failures plus the correction produced by the current failure. Experiment aggregation consumes these fields first and retains reason-text inference only for legacy v2 compatibility.

### Lifecycle tests use deterministic evidence, not fake assistant success

Integration tests create Plans through the real Plan tool path, append v2 Experience, produce v2 terminal outcomes, publish a learned artifact through the trusted coordinator, then supply deterministic arm outcomes. Test-only thresholds reduce sample counts; production defaults remain 20 per arm. Demotion tests assert the artifact rollback path, while activation tests assert future eligible runs receive treatment.

## Risks / Trade-offs

- **[Device probes differ across Linux images]** → Parse multiple stable sources, mark partial/unknown conservatively, and never guess missing fields.
- **[Extra SSH latency on connect]** → Probe once per connection and cache the in-memory result.
- **[Workspace config could weaken safety]** → Bound every numeric value and keep immediate safety demotion non-configurable.
- **[Legacy records lack structured safety/corrections]** → Read them for audit, use conservative fallback inference, and never rewrite history.
- **[Reports expose operational secrets]** → Render only identifiers, hashes, aggregate metrics, reason codes, and relative artifact state.

## Migration Plan

1. Add versioned identity/config/report types without changing existing log readers.
2. Populate identity on new device connections; existing sessions without identity remain ineligible for automatic device experiments.
3. Add optional terminal fields and prefer them in new outcomes.
4. Register read-only CLI inspection commands.
5. Deploy with existing experiment defaults; no historical backfill or state rewrite.

Rollback removes the new CLI and identity wiring. Existing optional fields and JSONL records remain readable by older code because unknown properties are ignored.

## Open Questions

- Which board-vendor package should be the preferred firmware identity source across all supported RDK generations?
- Should production deployments use fixed evaluation windows or a formal sequential test after enough real traffic is collected?
