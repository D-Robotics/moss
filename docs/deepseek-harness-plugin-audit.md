# DeepSeek Harness plugin compatibility audit

Audit date: 2026-08-18. Sources were read directly from GitHub. The official product reference is
[`deepseek-ai/deepseek-harness`](https://github.com/deepseek-ai/deepseek-harness); the ecosystem
inventory is
[`awesome-dsh-plugin/awesome-dsh-plugin`](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin).
At the audited revision the inventory contained 1,247 YAML entries. Its own warning is controlling:
listing means installability and maintenance checks, not a security review.

## Compatibility rule

An official DSH bundle targets Cordis, `cordis.patch.yml`, the `@deepseek-ai/dsh-*` host services,
and DSH client slots. Moss uses different runtime and Web contracts. It must therefore never execute
a DSH bundle as if the ABIs were interchangeable.

Moss imports only declarative contributions that can be mapped without changing their meaning:

- `SKILL.md` content becomes a Moss Skill with its contained source path recorded; license metadata
  remains an audit input and is not synthesized when the package does not declare it.
- MCP server declarations become an explicit Moss MCP preset.
- data-only command templates and JSON Schema configuration become their Moss equivalents.
- native DSH runtime, Cordis service, and client-slot modules are rejected with a precise
  compatibility diagnostic. They may be ported deliberately to Moss APIs after source review.

Installation stays explicit. Imported third-party JavaScript remains trusted code, not sandboxed
code. Moss runs it behind a termination-bounded Worker/RPC lifecycle so import/setup hangs cannot
block the core host, but that boundary is deliberately not described as a permission sandbox. A
catalog entry never grants automatic execution.

## Reviewed candidates

| Candidate                                      | License      | Decision                                           | Reason                                                                                                                                                                                                       |
| ---------------------------------------------- | ------------ | -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `HenryZ838978/deepseek-harness` 0.2.0          | MIT          | Bundled, disabled by default                       | Its protocol Skill is host-neutral. Moss also exposes its exact-version `@deepseek-harness/mcp@0.2.0` server as an MCP preset and a `deepseek-protocol` command.                                             |
| `awesome-dsh-plugin/dsh-find-plugin` 0.3.6     | MIT          | Do not execute; reuse catalog ideas                | It requires `@deepseek-ai/cordis` and `@deepseek-ai/dsh-tools`. Moss plugin discovery must use Moss manifests and explicit installs.                                                                         |
| `liuyuelintop/dsh-conversation-exporter` 0.2.0 | MIT          | Native Moss implementation retained                | The DSH client module depends on DSH runtime/conversation slots. Moss now provides server-owned Markdown export, avoiding a parallel exporter.                                                               |
| `Anionex/dsh-turn-rewind` 0.1.1                | BSD-3-Clause | Native Moss implementation retained                | Its persistent ledger is strong prior art, but its Cordis and DSH client ABI is incompatible. Moss uses its existing conversation/file checkpoints and exposes non-destructive rewind.                       |
| `AcidGr/dsh-web-mobile-fix` 1.0.2              | MIT          | Behavior ported into the Moss design system        | The package is a DSH CSS overlay. Moss implements first-class session/details drawers, settings layout, focus containment, and 44 px controls instead of loading a parallel theme.                           |
| `GooodWei/context-vista` 0.1.0                 | MIT          | Behavior ported into Moss conversation/details UI  | The package requires DSH commands, settings, locale, and conversation services. Moss renders its own durable usage/context projection and `/context` control.                                                |
| `HongMing-Huang/dsh-file-upload` 0.4.2         | MIT          | Capability ported behind Moss attachment contracts | Its document conversion is useful prior art, but the plugin depends on DSH Cordis credentials, filesystem, tools, runtime, and React 18. Moss keeps upload security and message persistence in its own host. |

## Rejected loading patterns

- A plugin declaring `dsh.bundle.patch` is not sufficient evidence of Moss compatibility.
- The compatibility reader audits the real `package.json + cordis.patch.yml` package shape. Optional
  `moss.dsh-adapter.json` is a Moss-owned data adapter, not a native DSH manifest or ABI claim.
- A package with `dsh.client.inject` cannot be mounted into a Moss ShadowRoot by renaming imports.
- Theme or layout plugins cannot inject global CSS; Moss tokens and controlled components remain the
  single design system.
- Marketplace or GitHub topic results are never auto-installed.
- Plugins without a verified license, exact source revision, manifest containment, side-effect
  metadata, or successful candidate activation remain disabled.

This audit is repeated before adding a bundled compatibility source. The completion gate verifies
that unsupported DSH bundles fail closed and that accepted Skill/MCP mappings are reversible and
owned by one plugin generation.
