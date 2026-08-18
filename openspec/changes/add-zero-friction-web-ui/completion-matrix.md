# Moss Web completion matrix

This matrix is the acceptance source for the DeepSeek Harness parity change. The reference is
`deepseek-ai/deepseek-harness` at commit `47f943859bef60e4160492346772ded9b24f765a`. Reference source
and screenshots are evidence only; Moss keeps its own name, logo, copy, safety explanations, and
implementation.

The only accepted visible differences are Moss branding, Moss-only capabilities, and safety text
required by Moss. Every other difference needs an explicit entry in this file before release.

## Reference views

The visual suite owns three fixed viewports: desktop `1440x960`, narrow desktop `1120x800`, and
tablet `820x1180`. The complete suite covers the empty workbench, active run, expanded tool,
approval, plan, settings, plugin inventory, responsive conversation, component gallery, and modal;
the home shell is captured at all three widths. Reference images live under
`packages/moss-agent/test/visual/reference/deepseek-47f9438/`; Moss baselines live beside them under
`packages/moss-agent/test/visual/baseline/`.

## Completion rules

- `implemented` means the production browser path is wired to the real runtime.
- `tested` means a focused unit or HTTP test proves the behavior and a browser test proves the user
  path where one exists.
- `verified` means the fixed-viewport visual, keyboard, accessibility, Windows, security, and
  isolation gates required by that row pass.
- A row is complete only when all three columns are checked. A green CI run does not waive an
  unchecked row.

## Plan 0 — visual baseline

| Requirement                                                                         | Implemented | Tested | Verified |
| ----------------------------------------------------------------------------------- | ----------- | ------ | -------- |
| Reference commit and provenance are pinned                                          | [x]         | [x]    | [x]      |
| Desktop, narrow desktop, and tablet reference captures                              | [x]         | [x]    | [x]      |
| Empty, running, tool, approval, plan, settings, and plugin fixtures                 | [x]         | [x]    | [x]      |
| Layout, component, interaction, state, motion, responsive, and keyboard diff report | [x]         | [x]    | [x]      |

## Plan 1 — design system and shell

| Requirement                                                                                             | Implemented | Tested | Verified |
| ------------------------------------------------------------------------------------------------------- | ----------- | ------ | -------- |
| React and Vite remain inside `@rdk-moss/agent`                                                          | [x]         | [x]    | [x]      |
| Token-owned color, typography, spacing, radius, shadow, layer, width, and state                         | [x]         | [x]    | [x]      |
| Controlled Button, Input, Menu, Modal, Disclosure, Card, Tabs, Toast, Tooltip, Code, Diff, and Terminal | [x]         | [x]    | [x]      |
| Resizable three-column frame, independent collapse, concession, and persisted layout                    | [x]         | [x]    | [x]      |
| Mobile session and details drawers                                                                      | [x]         | [x]    | [x]      |
| Focus, scrollbars, empty, skeleton, offline, toast, and reduced-motion states                           | [x]         | [x]    | [x]      |
| Internal component gallery route                                                                        | [x]         | [x]    | [x]      |

## Plan 2 — sessions and workspaces

| Requirement                                                                             | Implemented | Tested | Verified |
| --------------------------------------------------------------------------------------- | ----------- | ------ | -------- |
| Workspace selector, session history/search/new/status/settings                          | [x]         | [x]    | [x]      |
| Resume, rename, Markdown export, confirmed delete, fork, and non-destructive rewind     | [x]         | [x]    | [x]      |
| Per-session draft, scroll, selected detail, and panel state                             | [x]         | [x]    | [x]      |
| Empty workspace, no session, loading failure, damaged history, and interrupted recovery | [x]         | [x]    | [x]      |

## Plan 3 — conversation

| Requirement                                                                        | Implemented | Tested | Verified |
| ---------------------------------------------------------------------------------- | ----------- | ------ | -------- |
| User, assistant, reasoning, retry, compaction, error, usage, and context meter     | [x]         | [x]    | [x]      |
| Markdown, code, table, JSON, diff, terminal, read, edit, search, and Web renderers | [x]         | [x]    | [x]      |
| Tool tree, running/success/failure states, summary, and details                    | [x]         | [x]    | [x]      |
| Attachments, images, produced files, download, copy, and feedback                  | [x]         | [x]    | [x]      |
| Durable cursor SSE reconnect and refresh attachment to an active run               | [x]         | [x]    | [x]      |

## Plan 4 — interaction controls

| Requirement                                                 | Implemented | Tested | Verified |
| ----------------------------------------------------------- | ----------- | ------ | -------- |
| Approval and user-question composer takeover                | [x]         | [x]    | [x]      |
| Permission preset and plan/default/accept-edits modes       | [x]         | [x]    | [x]      |
| Todo, Goal, Queue, and Steering                             | [x]         | [x]    | [x]      |
| Slash commands, Skill/Subagent mention, and model selection | [x]         | [x]    | [x]      |
| Background jobs and workflow runs                           | [x]         | [x]    | [x]      |
| Trajectory, execution evidence, and completion-gate verdict | [x]         | [x]    | [x]      |

## Plan 5 — settings

| Requirement                                                               | Implemented | Tested | Verified |
| ------------------------------------------------------------------------- | ----------- | ------ | -------- |
| General, Models, Permissions, Skills, MCP, Plugins, and Runtime Inventory | [x]         | [x]    | [x]      |
| Shared label, help, dirty, validation, save, and error behavior           | [x]         | [x]    | [x]      |
| Write/delete-only API keys and plugin secrets                             | [x]         | [x]    | [x]      |
| CLI configuration parsing, defaults, and validation are reused            | [x]         | [x]    | [x]      |

## Plan 6 — plugins

| Requirement                                                                                        | Implemented | Tested | Verified |
| -------------------------------------------------------------------------------------------------- | ----------- | ------ | -------- |
| Manifest v1 with explicit local and exact-version npm install                                      | [x]         | [x]    | [x]      |
| CLI and Web add/remove/enable/disable/list/doctor                                                  | [x]         | [x]    | [x]      |
| Tool, Skill, Expert, Prompt, Command, Provider, MCP preset, config, and Web contributions          | [x]         | [x]    | [x]      |
| Navigation, session, message, tool, composer, details, and settings slots receive typed owner data | [x]         | [x]    | [x]      |
| JSON Schema settings use Moss controls; advanced UI is token scoped                                | [x]         | [x]    | [x]      |
| Failure isolation, last-good composition, and core startup survival                                | [x]         | [x]    | [x]      |

## Plan 7 — reload and gates

| Requirement                                                  | Implemented | Tested | Verified |
| ------------------------------------------------------------ | ----------- | ------ | -------- |
| Active-call leases and quiescent unload                      | [x]         | [x]    | [x]      |
| Runtime enable/disable/update and cache-busted client reload | [x]         | [x]    | [x]      |
| Fixed-viewport visual regression gate                        | [x]         | [x]    | [x]      |
| Built-in, official-plugin, and plugin-template token gate    | [x]         | [x]    | [x]      |
| Preview/default switch and one-release legacy rollback       | [x]         | [x]    | [x]      |

## Repository release gate

Completion additionally requires Playwright user journeys, keyboard and accessibility checks,
HTTP/SSE/plugin lifecycle/security/Windows/dual-instance coverage, focused tests for each slice, a
real browser run, `npm run check`, `npm run verify`, updated API reports and user documentation, and
an `Unreleased` changelog entry. The PR may only be called complete after every row above is checked
and the hosted CI result for the final pushed commit is green.

## Local verification evidence

- Plugin lifecycle and DSH compatibility: 10 focused test files passed.
- Web services, security, public API, capabilities, and Playwright: 13 focused test files passed.
- Real smoke: the bundled `official:deepseek-harness` source installed, enabled, passed doctor,
  and listed from an isolated config directory; the packaged CLI/PTY smoke passed.
- Full gate: `npm run verify` passed, including 9 core files, 295 agent files, 9 scaffold tests,
  API reports, TypeDoc, token/maintainability gates, and browser visual/accessibility coverage.
