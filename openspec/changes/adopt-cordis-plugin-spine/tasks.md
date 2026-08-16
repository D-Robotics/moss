# Tasks

## Phase 0 — governance and contracts

- [x] Record upstream revision, license, local differences, owner, and sync rule.
- [x] Define ownership, staging, error, redaction, and teardown contracts.
- [x] Preserve `CapabilityPack` public stability and wrap invalid configuration.

## Phase 1 — lifecycle vertical slice

- [x] Add the vendored Cordis-derived effect scope.
- [x] Add `MossPluginHost`, plugin context, handle, state, and inspector.
- [x] Add scoped tool registration and inline skill registration.
- [x] Integrate plugin prompts and experts into `MossAgent`.
- [x] Integrate plugin skills into the composed runtime skill registry.
- [x] Await plugin teardown from runtime/agent close.
- [x] Dispose pack contributions installed into host-owned registries.

## Verification

- [x] Test reverse async teardown, failure aggregation, and idempotency.
- [x] Test tool/skill/expert/prompt composition and redacted inspection.
- [x] Test validation failure before publication and async setup rollback.
- [x] Test shared expert registry cleanup and structured constructor errors.
- [ ] Add active tool-call leases and unload quiescence before advertising HMR.
- [ ] Route every `load_skill` consumer through the shared SkillCatalog service.
- [ ] Add dependency/service injection and failed-update last-good rollback.
- [ ] Decide full Cordis Core vendoring only after the Phase 1 evidence review.
