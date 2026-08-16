# DeepSeek Harness Web architecture review

Reviewed upstream: `deepseek-ai/deepseek-harness` at `47f943859bef60e4160492346772ded9b24f765a` (MIT).

## Product lesson

The upstream Web product is not a large page attached to an agent loop. `apps/web/src/main.ts` is a thin entry while `packages/client/ui-*` contributes layout, conversation, trajectory, tools, jobs, sub-agents, goals, settings, and plugin inventory. React renders reference-stable stores; host session events remain the source of truth.

Its information architecture is useful for Moss: workspace and session navigation on the left, conversation or trajectory in the center, selected-event details on the right, and a composer that keeps model, access mode, plan, context, and stop state visible. Long tasks expose tool timing, token usage, background work, sub-agent activity, pending interaction, and terminal state instead of one ambiguous loading flag.

## Engineering lesson

- Append-only events use monotonic sequence numbers and explicit history/live reconciliation.
- Projections fold stable business IDs instead of scanning DOM or mutable registries.
- UI slots are owned effects: declaration, contribution, rollback, and disposal follow plugin lifecycle.
- Deterministic replay providers and seeded logs test long histories; upstream includes an 88-turn browser scenario.
- Accessibility snapshots assert roles, labels, status, and actions rather than CSS class names.

## Moss decision

Moss adopts these methods and creates its own visual expression. It does not copy upstream CSS, components, icons, or assets. The first slice is a React-free projection and standalone Moss shell. Remote commands, reconnect/resume, typed client slots, and browser bundles wait for an ordered runtime protocol and tool-call quiescence.

The controlling plan is `openspec/changes/unify-runtime-plugin-drive/`. It places execution, composition, and presentation in separate planes and requires CLI/Web/embedding parity before calling the product “everything is a plugin.”
