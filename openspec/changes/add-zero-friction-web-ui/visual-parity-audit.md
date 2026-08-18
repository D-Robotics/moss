# Moss Web visual parity audit

Reference: `deepseek-ai/deepseek-harness` commit
`47f943859bef60e4160492346772ded9b24f765a`. The reference was built from source and captured through
its fixture mode. Moss retains its own brand, copy, safety explanations, and implementation.

## Fixed viewports and fixtures

| Fixture         | Desktop 1440×960       | Narrow 1120×800                                  | Tablet 820×1180                                  | Moss assertion                                                |
| --------------- | ---------------------- | ------------------------------------------------ | ------------------------------------------------ | ------------------------------------------------------------- |
| Empty workbench | `desktop-home.png`     | `narrow-home.png`                                | `tablet-home.png`                                | Three columns concede in the order details → sidebar → center |
| Active run      | `desktop-running.png`  | responsive behavior covered by shell fixture     | responsive behavior covered by shell fixture     | Streaming and interruption remain visible after reconnect     |
| Expanded tool   | `desktop-tool.png`     | responsive behavior covered by shell fixture     | responsive behavior covered by shell fixture     | Summary stays in the timeline; full evidence opens in details |
| Approval        | `desktop-approval.png` | composer takeover covered by interaction fixture | composer takeover covered by interaction fixture | Focus enters the decision panel and returns to composer       |
| Plan            | `desktop-plan.png`     | responsive behavior covered by shell fixture     | responsive behavior covered by shell fixture     | Mode, todo state, and current step use shared status tokens   |
| Settings        | `desktop-settings.png` | settings navigation covered by keyboard fixture  | settings navigation uses a drawer                | Forms share label, help, dirty, validation, and save states   |
| Plugins         | `desktop-plugins.png`  | plugin cards use the narrow grid                 | plugin cards use the single-column grid          | Built-in and extension UI consume the same design system      |

The reference files live in `packages/moss-agent/test/visual/reference/deepseek-47f9438/`. Generated
Moss baselines and pixel diffs live in sibling `baseline/` and `diff/` directories. Reference images
are evidence for composition and interaction, not golden pixels: product branding and text differ, so
the automated gate compares Moss against reviewed Moss baselines while browser assertions compare
the structural rules below against the reference.

The reviewed Moss set is `desktop-home`, `desktop-running`, `desktop-tool`, `desktop-approval`,
`desktop-plan`, `desktop-settings`, `desktop-plugins`, `narrow-home`, `narrow-conversation`,
`tablet-home`, `tablet-gallery`, and `tablet-gallery-dialog`. The Playwright journey reaches each
state through the real loopback HTTP/SSE, approval, question, attachment, plugin, and layout paths.

## Parity matrix

| Surface             | Reference behavior                                                 | Moss contract                                                                    | Allowed difference                      |
| ------------------- | ------------------------------------------------------------------ | -------------------------------------------------------------------------------- | --------------------------------------- |
| Layout              | Persistent session rail, flexible conversation, contextual details | `AppFrame` owns widths, resize handles, collapse, concession, and mobile drawers | Moss product mark                       |
| Typography          | Compact sans-serif hierarchy and monospace evidence                | Public typography tokens; no component-local font scale                          | Installed platform font fallback        |
| Density             | Tight navigation and tool evidence, roomier reading column         | Public spacing/control-height tokens                                             | Safety copy may add one explanatory row |
| Shape and elevation | Low-radius controls, bordered cards, restrained overlays           | Public radius, border, shadow, and layer tokens                                  | None                                    |
| Color               | Neutral work surface with semantic status accents                  | Theme and semantic-state tokens, including focus and offline                     | Moss accent hue                         |
| Navigation          | Sidebar tasks/settings and contextual details                      | Same keyboard order, selected semantics, and responsive concession               | Moss-only destinations                  |
| Conversation        | User/assistant blocks, reasoning disclosure, tool tree, usage      | Typed timeline nodes and controlled renderers                                    | Moss tool/provider names                |
| Composer            | Prompt, attachments, modes, pending interaction takeover           | One composer state machine; approval/question prevents accidental send           | Required permission explanation         |
| Settings            | Section navigation and consistent forms                            | Seven stable sections and schema-generated plugin fields                         | Moss runtime inventory fields           |
| Plugin UI           | Contributions appear as native surfaces                            | Stable slots, owner metadata, token-scoped mount root, controlled schema forms   | Unsupported Cordis ABI is rejected      |
| Feedback            | Hover/focus/selected/disabled/loading/streaming/result states      | Central component/state tokens and ARIA live regions                             | None                                    |
| Motion              | Short transitions that communicate state                           | Motion tokens plus `prefers-reduced-motion` suppression                          | None                                    |
| Keyboard            | Logical tab order, visible focus, Escape dismissal                 | Focus trap/restore, disclosure semantics, skip link, keyboard resize             | None                                    |

## Release checks

- Component gallery exercises every controlled component and semantic state.
- Playwright executes fixed-viewport screenshots, keyboard-only journeys, responsive drawers,
  reconnect, approval/question takeover, settings validation, and plugin reload.
- Accessibility checks reject serious/critical violations and assert status announcements.
- The token scanner rejects hard-coded theme values in built-in client code, bundled plugin UI, and
  generated plugin templates.
- Any intentional divergence must be documented in this file and reviewed before its Moss baseline
  is updated.
