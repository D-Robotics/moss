## 1. Existing delivery truth

- [x] 1.1 Repair the capability demo Origin/CSRF flow through a shared authorized client.
- [x] 1.2 Add `smoke:web-capabilities` to the required verification path.

## 2. Delivery aggregate and acceptance

- [x] 2.1 Add risk-adaptive Delivery Case events and projection.
- [x] 2.2 Add revisioned acceptance contracts and stale-verdict invalidation.
- [x] 2.3 Enforce acceptance atomically for mutating graph and Plan creation.

## 3. Review and product seams

- [x] 3.1 Add independent review gating, fix nodes, and evidence-derived completion reports.
- [x] 3.2 Add shared Execution Query and revisioned Execution Action interfaces.
- [x] 3.3 Connect the Web control plane and delivery details UI to the shared projection.
- [x] 3.4 Replace native prompt/confirm interactions with Moss dialogs.

## 4. Evidence and delivery

- [x] 4.1 Add the five-run control/treatment Delivery Evidence Lab runner and result schema.
- [x] 4.2 Execute all seven scenarios as 70 real child runs and retain raw output, digests,
      failure classes, source revision, and aggregate metrics without presenting deterministic
      mechanism evidence as live-model benchmark quality.
- [x] 4.3 Update public API reports, Architecture, extension/user docs, README files, and changelog.
- [x] 4.4 Pass focused tests, both smokes, `npm run check`, and `npm run verify`; required CI is
      confirmed after the pushed commit.
