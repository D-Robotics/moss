# Cordis lifecycle kernel (vendored adaptation)

- Upstream project: <https://github.com/cordiverse/cordis>
- Reviewed source distribution: `deepseek-ai/deepseek-harness`
- Reviewed Harness commit: `47f943859bef60e4160492346772ded9b24f765a`
- License: MIT; see [`LICENSE`](LICENSE)
- Moss owner: `@rdk-moss/agent/core/plugins`

This directory is the first audited vendoring slice, not a claim that Moss
already embeds the complete Cordis runtime. `effect-scope.ts` adapts Cordis
Fiber's owned, reverse-order, awaited disposer semantics behind a Moss-private
API. Moss does not yet vendor Cordis Context, Registry, Reflect, Events, Loader,
Include, or HMR.

Local differences from the reviewed source:

- no Proxy context or string-keyed service locator;
- no loader, JavaScript configuration, HMR, decorators, or module augmentation;
- errors cross the public runtime boundary as `MossError`;
- one scope has an explicit state machine and deterministic inspection labels;
- cleanup aggregates failures only after every disposer has run.

When this directory changes, update this manifest, retain the license, run the
plugin lifecycle specs, and review upstream lifecycle changes before syncing.
