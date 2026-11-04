# Claude Code capability inventory (for Moss gap analysis)

- Date: 2026-11-04
- Subject: Anthropic Claude Code — CLI + Claude Desktop's built-in Code sessions
- Method: official documentation only. Every page was fetched from `code.claude.com/docs/en/<page>`
  (the Mintlify `.md` variant of `https://code.claude.com/docs/en/<page>`, same content, no
  JS shell). Pages are cited as their canonical HTML URL. Doc index:
  <https://code.claude.com/docs/llms.txt>
- Doc set observed: Claude Code v2.1.310–v2.1.317 era. Individual capabilities carry the minimum
  version the docs state, where they state one.
- Evidence convention: `[doc]` = stated in a fetched page (URL in the row). `[unverified]` = not
  found in official docs; either reverse-engineered elsewhere or simply undocumented. No
  speculation is included; where the docs are silent the row says so.
- Cross-reference: internal reverse-engineering of the Claude Code binary lives in
  [`../2026-11-04-cursor-claude-agent-design/claude-evidence.md`](../2026-11-04-cursor-claude-agent-design/claude-evidence.md).
  Where that file names an internal artifact the docs don't (e.g. the `skill_listing` /
  `dynamic_skill` attachment names) it is marked **[internal, not in docs]**.

---

## 0. One-page orientation

Claude Code's extension surface is **five independent mechanisms plus three policy layers**:

| Layer                  | Mechanism                                                                               | Loaded when                                     | Primary cost                                |
| :--------------------- | :-------------------------------------------------------------------------------------- | :---------------------------------------------- | :------------------------------------------ |
| Always-on instructions | `CLAUDE.md` hierarchy + `.claude/rules/*.md` + auto-memory `MEMORY.md`                  | session start, on demand for nested/path-scoped | full text, every turn                       |
| On-demand instructions | **skills** (`.claude/skills/*/SKILL.md`, `.claude/commands/*.md`)                       | listing always; body on invoke                  | listing budget = 1% of context window       |
| Isolated workers       | **subagents** (`.claude/agents/*.md`, built-ins), forked skills, agent teams, workflows | on delegation                                   | fresh context each; results summarized back |
| Deterministic control  | **hooks** (37 events, 5 handler types)                                                  | at the event                                    | process spawn + latency                     |
| Packaging              | **plugins** + marketplaces                                                              | when enabled                                    | names/descriptions every turn + processes   |
| Policy                 | permissions (modes + rules), sandbox, managed settings                                  | always                                          | none                                        |

The single most important structural fact for gap analysis: **custom slash commands no longer
exist as a separate subsystem**. Anthropic merged them into skills — _"Custom commands have been
merged into skills. A file at `.claude/commands/deploy.md` and a skill at
`.claude/skills/deploy/SKILL.md` both create `/deploy` and work the same way."_
(<https://code.claude.com/docs/en/skills>)

---

## 1. Skills

Primary source: <https://code.claude.com/docs/en/skills>
Also: <https://code.claude.com/docs/en/claude-directory>, <https://code.claude.com/docs/en/context-window>,
<https://code.claude.com/docs/en/env-vars>

### 1.1 File format and parsing rules

| Capability            | Mechanism (exact)                                                                                                                   | Source                                           | Design rationale                                                        |
| :-------------------- | :---------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------- | :---------------------------------------------------------------------- |
| Skill unit            | Directory containing `SKILL.md`; directory name (or frontmatter `name`) is the command                                              | [skills](https://code.claude.com/docs/en/skills) | discoverability: one folder = one `/command`                            |
| Frontmatter           | YAML between `---` markers; **read only when the opening `---` is line 1**                                                          | [skills](https://code.claude.com/docs/en/skills) | determinism — avoids treating a Markdown rule line as frontmatter       |
| Unknown fields        | Silently ignored, no error, no warning                                                                                              | [skills](https://code.claude.com/docs/en/skills) | forward compatibility across versions                                   |
| Malformed YAML        | Skill still loads with **no fields set**; `/name` works but Claude can't match `description`                                        | [skills](https://code.claude.com/docs/en/skills) | fail-open on authoring errors so a typo doesn't hide the skill entirely |
| Booleans              | Accept `yes/no/on/off/1/0` in any case, plus `true/false`                                                                           | [skills](https://code.claude.com/docs/en/skills) | [inferred] YAML-1.1 tolerance                                           |
| Body size guidance    | "Keep `SKILL.md` under 500 lines"                                                                                                   | [skills](https://code.claude.com/docs/en/skills) | token cost — body stays in context once loaded                          |
| Reserved folder names | `synced` (claude.ai sync), `anthropic-skills` / `anthropic-skills:*` (outside a plugin)                                             | [skills](https://code.claude.com/docs/en/skills) | namespace safety for account-synced content                             |
| Illegal name chars    | zero-width space, control chars, private-use/unassigned glyphs, bidi controls, non-plain spaces, `<`, `>` — skill **does not load** | [skills](https://code.claude.com/docs/en/skills) | prevents spoofed/invisible command names                                |

### 1.2 Frontmatter reference (complete key list)

| Key                        | Type / values                              | Effect                                                                                                         | Source                                           |
| :------------------------- | :----------------------------------------- | :------------------------------------------------------------------------------------------------------------- | :----------------------------------------------- |
| `name`                     | string                                     | `/`-menu command name; defaults to directory name. In plugins it becomes the segment after `plugin:`           | [skills](https://code.claude.com/docs/en/skills) |
| `description`              | string, recommended                        | Used by Claude to decide relevance. If omitted, first non-empty body line is used                              | [skills](https://code.claude.com/docs/en/skills) |
| `when_to_use`              | string                                     | Appended to `description` in the listing; counts toward the same cap                                           | [skills](https://code.claude.com/docs/en/skills) |
| `argument-hint`            | string                                     | Autocomplete hint, e.g. `[issue-number]`                                                                       | [skills](https://code.claude.com/docs/en/skills) |
| `arguments`                | space-separated string or YAML list        | Declares named positional args for `$name`                                                                     | [skills](https://code.claude.com/docs/en/skills) |
| `disable-model-invocation` | bool, default `false`                      | Claude cannot invoke it; removes description from context; also blocks subagent preload and scheduled-task use | [skills](https://code.claude.com/docs/en/skills) |
| `user-invocable`           | bool, default `true`                       | `false` hides from `/` menu; only Claude can invoke                                                            | [skills](https://code.claude.com/docs/en/skills) |
| `allowed-tools`            | space/comma string or YAML list            | Pre-approves listed tools **for the invoking turn only**; does not restrict the tool pool                      | [skills](https://code.claude.com/docs/en/skills) |
| `disallowed-tools`         | same                                       | Removes tools from the pool while the skill is active (turn-scoped)                                            | [skills](https://code.claude.com/docs/en/skills) |
| `model`                    | alias, full ID, or `inherit`               | Overrides model for the rest of the turn (or for the fork)                                                     | [skills](https://code.claude.com/docs/en/skills) |
| `effort`                   | `low\|medium\|high\|xhigh\|max`            | Effort for the rest of the turn; **not** overridable past `CLAUDE_CODE_EFFORT_LEVEL`                           | [skills](https://code.claude.com/docs/en/skills) |
| `context`                  | `fork`                                     | Runs the skill as a forked subagent                                                                            | [skills](https://code.claude.com/docs/en/skills) |
| `agent`                    | `Explore\|Plan\|general-purpose\|<custom>` | Subagent type for `context: fork`; default `general-purpose`                                                   | [skills](https://code.claude.com/docs/en/skills) |
| `background`               | bool, default `true`                       | With `context: fork`, `false` makes the invoker wait                                                           | [skills](https://code.claude.com/docs/en/skills) |
| `hooks`                    | hook config                                | Registers hooks for the **rest of the session** from invocation                                                | [hooks](https://code.claude.com/docs/en/hooks)   |
| `paths`                    | glob string/list                           | Auto-activation limited to matching files, relative to cwd                                                     | [skills](https://code.claude.com/docs/en/skills) |
| `shell`                    | `bash` (default) / `powershell`            | Shell for injected commands                                                                                    | [skills](https://code.claude.com/docs/en/skills) |
| `metadata`                 | free-form map                              | Read by your tooling only; non-map values dropped                                                              | [skills](https://code.claude.com/docs/en/skills) |
| `license`                  | string                                     | Agent Skills spec field; accepted, not acted on                                                                | [skills](https://code.claude.com/docs/en/skills) |
| `compatibility`            | string ≤ 500 chars                         | Agent Skills spec field; accepted, not acted on                                                                | [skills](https://code.claude.com/docs/en/skills) |

Fields **not** available on the legacy `.claude/commands/*.md` form: `name`, `paths`. Everything
else is identical. (<https://code.claude.com/docs/en/skills>)

Portability constraint: when a skill is uploaded to claude.ai / the Skills API, only the six Agent
Skills fields are allowed — `name`, `description`, `license`, `compatibility`, `metadata`,
`allowed-tools` — and any other key is a **hard error**, e.g.
`Unexpected key(s) in SKILL.md frontmatter: argument-hint`. Claude Code-only body features such as
dynamic context injection do not work there. (<https://code.claude.com/docs/en/skills>)

### 1.3 Discovery directories and precedence

| Location       | Path                                                                   | Scope                                                    | Source                                           |
| :------------- | :--------------------------------------------------------------------- | :------------------------------------------------------- | :----------------------------------------------- |
| Enterprise     | `.claude/skills/<name>/SKILL.md` inside the managed settings directory | all users on deployed machines                           | [skills](https://code.claude.com/docs/en/skills) |
| Personal       | `~/.claude/skills/<name>/SKILL.md`                                     | all your projects, not cloud/Cowork                      | [skills](https://code.claude.com/docs/en/skills) |
| Project        | `.claude/skills/<name>/SKILL.md`                                       | this repo; commit it                                     | [skills](https://code.claude.com/docs/en/skills) |
| Nested         | `<subdir>/.claude/skills/<name>/SKILL.md`                              | sessions in/below `<subdir>`; loads lazily               | [skills](https://code.claude.com/docs/en/skills) |
| Additional dir | `<dir>/.claude/skills/...` for `--add-dir` / `/add-dir`                | that session                                             | [skills](https://code.claude.com/docs/en/skills) |
| Plugin         | `<plugin>/skills/<name>/SKILL.md`                                      | wherever the plugin is enabled, as `/plugin:skill`       | [skills](https://code.claude.com/docs/en/skills) |
| account-synced | `~/.claude/skills/synced/`                                             | claude.ai-enabled skills, namespaced `anthropic-skills:` | [skills](https://code.claude.com/docs/en/skills) |

Name-collision precedence: **enterprise > personal > project**; a skill beats a same-named file in
`.claude/commands/`; a user/project skill replaces a bundled skill but **not** its aliases; plugin
skills are namespaced and never collide. (<https://code.claude.com/docs/en/skills>)

Nested discovery mechanics: project skills are loaded from `.claude/skills/` in the start directory
and **every parent up to the repo root** — so starting in `packages/frontend/` still gets root
skills. Skills in directories _below_ the start point do not load at startup; they load the first
time Claude reads or edits a file there, and until then they are absent from `/`. `/add-dir`
forces earlier loading (v2.1.257+). In a `git worktree` session the parent walk stops at the
worktree root; on v2.1.277+, if the worktree has no `.claude/skills`, the main checkout's project
skills load instead.
(<https://code.claude.com/docs/en/skills>, <https://code.claude.com/docs/en/worktrees>)

Command-name derivation, exhaustively:

| Layout                                                                  | Command                                                                                               |
| :---------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------- |
| `.claude/skills/deploy-staging/SKILL.md`                                | `/deploy-staging`, or `/deploy` with `name: deploy`                                                   |
| `apps/web/.claude/skills/deploy/SKILL.md` (clash)                       | `/apps/web:deploy`                                                                                    |
| `../cli/.claude/skills/verify/SKILL.md` with `--add-dir ../cli` (clash) | `/cli:verify` (v2.1.309+)                                                                             |
| `.claude/commands/deploy.md`                                            | `/deploy`                                                                                             |
| `.claude/commands/frontend/component.md`                                | `/frontend:component`                                                                                 |
| `my-plugin/skills/review/SKILL.md`                                      | `/my-plugin:review` (or `/my-plugin:fancy` with `name: fancy`); bare `/fancy` also works unless taken |
| synced account skill `deploy`                                           | `/anthropic-skills:deploy`, or `/deploy` when free                                                    |

(<https://code.claude.com/docs/en/skills>)

### 1.4 Progressive disclosure — the three tiers, with numbers

| Tier                | What is in context                                       | Cost control                                                                                                                | Source                                                                                                 |
| :------------------ | :------------------------------------------------------- | :-------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------- |
| 1. Listing          | Every skill **name**, plus `description` + `when_to_use` | Budget = **1% of the model's context window**; fallback **8,000 characters**; per-entry text capped at **1,536 characters** | [skills](https://code.claude.com/docs/en/skills), [env-vars](https://code.claude.com/docs/en/env-vars) |
| 2. Body             | Full rendered `SKILL.md`                                 | Enters as one message and **stays across later turns**; no re-read from disk                                                | [skills](https://code.claude.com/docs/en/skills)                                                       |
| 3. Supporting files | `reference.md`, `examples.md`, `scripts/*`               | Read on demand via normal tools, because `SKILL.md` links them                                                              | [skills](https://code.claude.com/docs/en/skills)                                                       |

Overflow behavior at tier 1: the listing **always keeps every name**, but drops _descriptions_
starting with the **least-invoked** skills, so frequently used skills keep their full text. A
warning goes to the debug log. Tunables: `skillListingBudgetFraction` (e.g. `0.02` = 2%),
`SLASH_COMMAND_TOOL_CHAR_BUDGET` (fixed character count), `skillListingMaxDescChars`. The
`/context` "Skills" row reports post-budget size. (<https://code.claude.com/docs/en/skills>)

> On the `skill_listing` / `dynamic_skill` question: **official docs never use those names.** They
> describe the same two behaviors — a per-turn listing of names + descriptions, and mid-session
> discovery of skills that appear below the start directory. The internal attachment names
> `skill_listing` (text: _"The following skills are available for use with the Skill tool:"_) and
> `dynamic_skill` (_"New skills discovered in `<dir>`, now available via the Skill tool"_) come from
> binary reverse-engineering, documented in
> [`claude-evidence.md` §A3](../2026-11-04-cursor-claude-agent-design/claude-evidence.md)
> **[internal, not in docs]**. Treat the mechanism as documented and the identifiers as
> implementation detail.

Descendant-invocation reality: the tool Claude calls is the **`Skill` tool**, and permission rules
are written against it (`Skill(commit)`, `Skill(review-pr *)`, deny `Skill` to disable all).
A few built-in commands are reachable through it (`/init`, `/security-review`); `/compact` is not.
(<https://code.claude.com/docs/en/skills>, <https://code.claude.com/docs/en/permissions>)

### 1.5 Argument substitution

| Placeholder             | Expands to                                             | Source                                           |
| :---------------------- | :----------------------------------------------------- | :----------------------------------------------- |
| `$ARGUMENTS`            | full argument string as typed                          | [skills](https://code.claude.com/docs/en/skills) |
| `$ARGUMENTS[N]`         | 0-based positional argument                            | [skills](https://code.claude.com/docs/en/skills) |
| `$N`                    | shorthand for `$ARGUMENTS[N]` (`$0` = first)           | [skills](https://code.claude.com/docs/en/skills) |
| `$name`                 | named args from the `arguments` list, mapped in order  | [skills](https://code.claude.com/docs/en/skills) |
| `${CLAUDE_SESSION_ID}`  | current session id                                     | [skills](https://code.claude.com/docs/en/skills) |
| `${CLAUDE_EFFORT}`      | `low\|medium\|high\|xhigh\|max`                        | [skills](https://code.claude.com/docs/en/skills) |
| `${CLAUDE_SKILL_DIR}`   | directory of the `SKILL.md` (plugin: the skill subdir) | [skills](https://code.claude.com/docs/en/skills) |
| `${CLAUDE_PROJECT_DIR}` | project root                                           | [skills](https://code.claude.com/docs/en/skills) |
| `${CLAUDE_PLUGIN_ROOT}` | plugin install dir (plugin skills only)                | [skills](https://code.claude.com/docs/en/skills) |
| `${CLAUDE_PLUGIN_DATA}` | plugin persistent data dir (plugin skills only)        | [skills](https://code.claude.com/docs/en/skills) |

Exact edge semantics — these are the ones an implementer gets wrong:

- Indexed args use **shell-style quoting**: `/my-skill "hello world" second` → `$0` = `hello world`.
- Missing **indexed** placeholder stays **literal** (`$2` printed as `$2`); a missing **named**
  placeholder expands to the **empty string**.
- If **no** placeholder receives the arguments, Claude Code appends a line `ARGUMENTS: <value>`.
- Injected argument values are **not** re-scanned for `$1` / `$ARGUMENTS`; `${CLAUDE_*}` variables
  _are_ still substituted afterward.
- Escape with a single backslash (`\$1.00`); `\\$1` leaves both backslashes and still expands.
- `${CLAUDE_SKILL_DIR}` and `${CLAUDE_PROJECT_DIR}` are substituted in **two** places: body text
  and `Bash(...)` rules inside `allowed-tools` — that pairing is what lets a bundled script run
  unprompted. (<https://code.claude.com/docs/en/skills>)

Stacking: at the terminal prompt, `/write-tests /fix-issue 123` expands up to **6** stacked
user-invocable skills; the trailing text is `$ARGUMENTS` for each. Expansion stops at the first
non-skill token, at a forked skill, or at a skill whose args may start with another command
(`/loop`). Through `claude -p` or the SDK only the **first** skill loads.
(<https://code.claude.com/docs/en/skills>)

### 1.6 Dynamic context injection (`!`)

| Aspect         | Exact behavior                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Source                                           |
| :------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------- |
| Inline syntax  | `` !`<command>` `` — recognized only at **line start or immediately after whitespace**; `KEY=!`cmd`` stays literal                                                                                                                                                                                                                                                                                                                                                                                                           | [skills](https://code.claude.com/docs/en/skills) |
| Multi-line     | Fenced block opened with ` ```! `                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | [skills](https://code.claude.com/docs/en/skills) |
| Execution      | Runs **before** the content is sent; output replaces the placeholder as plain text                                                                                                                                                                                                                                                                                                                                                                                                                                           | [skills](https://code.claude.com/docs/en/skills) |
| Single pass    | Output is not re-scanned, so a command cannot emit a placeholder for a later pass                                                                                                                                                                                                                                                                                                                                                                                                                                            | [skills](https://code.claude.com/docs/en/skills) |
| Failure        | **Any** failure aborts the whole invocation (`Shell command failed for pattern "..."`), Claude never sees the body. bash: non-zero = failure, with a carveout treating exit 1 from search/comparison commands as a normal result                                                                                                                                                                                                                                                                                             | [skills](https://code.claude.com/docs/en/skills) |
| Timeout        | Bash tool default, **2 minutes**; a command the Bash tool auto-backgrounds still renders, reporting the move; otherwise killed and the invocation aborts                                                                                                                                                                                                                                                                                                                                                                     | [skills](https://code.claude.com/docs/en/skills) |
| Output ceiling | Past the Bash inline ceiling the text arrives as a file path + short preview                                                                                                                                                                                                                                                                                                                                                                                                                                                 | [skills](https://code.claude.com/docs/en/skills) |
| Permissions    | **Never prompts during render.** Each command is checked against permission rules first; a deny aborts (`Shell command permission check failed for pattern "..."`); outside auto mode anything that isn't `allow` aborts, **including a rule that would normally ask**. In auto mode the command doesn't abort: the skill loads with an instruction telling Claude to run that command first, and Claude's own call then goes through the classifier. Pre-approve with `allowed-tools`; deny and ask rules still override it | [skills](https://code.claude.com/docs/en/skills) |
| Kill switch    | `"disableSkillShellExecution": true` replaces each command with `[shell command execution disabled by policy]`; bundled and managed skills unaffected; claude.ai-synced skills never run commands locally (v2.1.228+)                                                                                                                                                                                                                                                                                                        | [skills](https://code.claude.com/docs/en/skills) |
| stderr         | Default bash shell merges stderr into stdout, so it appears in the injected text                                                                                                                                                                                                                                                                                                                                                                                                                                             | [skills](https://code.claude.com/docs/en/skills) |

Design rationale (stated): the pattern makes the skill "grounded in your actual working tree rather
than what Claude can guess from open files." The permission rule — _no prompting during render,
deny wins_ — exists so a repository-committed skill can't pop a prompt the user would rubber-stamp.
(<https://code.claude.com/docs/en/skills>)

### 1.7 `allowed-tools` grant semantics (precise)

- Grants permission **during the turn that invokes the skill**; the grant **clears when you send
  your next message**, even though the body stays in context.
- It does **not** restrict the tool pool — every tool remains callable; unlisted tools fall back to
  normal permission settings.
- Deny and ask rules **override** `allowed-tools`, always.
- "Workspace trust doesn't gate this field" — a project skill's `allowed-tools` applies even in
  `-p` in a never-trusted folder. Docs explicitly warn to review a repo's skills before running
  Claude Code there.
- Enterprise overrides: `allowManagedPermissionRulesOnly` makes Claude Code **ignore**
  `allowed-tools` in project/personal skills (v2.1.282+); `strictPluginOnlyCustomization`
  containing `hooks` strips `allowed-tools` from skills that declare `hooks`.
- For session-long pre-approval, the docs direct you to permission allow rules instead.

(<https://code.claude.com/docs/en/skills>)

### 1.8 Forked execution

`context: fork` starts a subagent of type `agent` (default `general-purpose`) whose prompt is the
skill body. Key corrections the docs make explicitly:

- It is **not** a fork of the conversation: the subagent does **not** see your history. _"Despite
  the name…"_. Use a conversation fork when history matters.
- Async by default (`background: true`); the result arrives later. Set `background: false` to wait.
  Forced waiting: `-p`/SDK, `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`, a still-running earlier
  invocation of the same skill, a scheduled-task firing with the skill as its prompt.
- Backgrounded forks get the **narrower background-subagent tool set**.
- A backgrounded forked skill's edits land **outside the session's checkpoints**; `/rewind` won't
  restore them (use git).
- Docs warn `context: fork` is only sensible for skills that contain an actual task, not a style
  guide.

(<https://code.claude.com/docs/en/skills>, <https://code.claude.com/docs/en/checkpointing>)

### 1.9 Lifecycle, dedupe, and compaction

| Behavior                        | Exact rule                                                                                                                                                                                   | Source                                                                                                             |
| :------------------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------- |
| Re-invocation, identical render | Claude Code inserts a short "already loaded" note **instead of** a second copy                                                                                                               | [skills](https://code.claude.com/docs/en/skills)                                                                   |
| Re-invocation, different render | Full content appended again (args changed, or injection produced new output)                                                                                                                 | [skills](https://code.claude.com/docs/en/skills)                                                                   |
| After auto-compaction           | Most recent invocation of each invoked skill is re-attached, keeping the **first 5,000 tokens** of each, total budget **25,000 tokens**, filled newest-first so old skills can drop entirely | [skills](https://code.claude.com/docs/en/skills), [context-window](https://code.claude.com/docs/en/context-window) |
| Truncation direction            | Keeps the **start** of the file — hence "put the most important instructions near the top"                                                                                                   | [context-window](https://code.claude.com/docs/en/context-window)                                                   |
| `hooks` frontmatter             | Registered on invoke, persist for the session; `once: true` removes after first **successful** run                                                                                           | [hooks](https://code.claude.com/docs/en/hooks)                                                                     |
| Hook limits per source          | Max **1,024 hooks** and **16,384 characters** of matchers per skill source per session (v2.1.304+)                                                                                           | [hooks](https://code.claude.com/docs/en/hooks)                                                                     |

### 1.10 Visibility overrides and cost auditing

`skillOverrides` in settings writes four states — `"on"` (name+description), `"name-only"`,
`"user-invocable-only"` (hidden from Claude, still in `/`), `"off"` (hidden everywhere, including the
Remote Control and Agent SDK command lists). `/skills` writes it to
`.claude/settings.local.json` with Space/Esc. It does **not** apply to plugin skills (use
`/plugin`). (<https://code.claude.com/docs/en/skills>)

Auditing tools: `/doctor` estimates listing cost; `/skill-doctor` (v2.1.252+) reports per-skill
context cost and usage, flags never-invoked skills, and in `-p` mode prints as text; `/context`
shows the post-budget Skills row.
(<https://code.claude.com/docs/en/skills>)

Bundled skills (prompt-based, not fixed logic): `/doctor`, `/code-review`, `/batch`, `/debug`,
`/loop`, `/claude-api`, `/run`, `/verify`, `/run-skill-generator`, `/deep-research`,
`/workflow-authoring` (only when workflows are on). `disableBundledSkills` turns them off;
`DISABLE_DOCTOR_COMMAND` or `{"doctor":"off"}` hides `/doctor` itself.
(<https://code.claude.com/docs/en/skills>)

### 1.11 Skills vs slash commands vs subagents — the decision table

| Want                                                               | Use                                      | Why (docs)                                                                                          |
| :----------------------------------------------------------------- | :--------------------------------------- | :-------------------------------------------------------------------------------------------------- |
| A procedure Claude should follow, possibly auto-triggered          | Skill                                    | body loads only when used                                                                           |
| An action **you** trigger, never Claude                            | Skill + `disable-model-invocation: true` | "You don't want Claude deciding to deploy because your code looks ready"                            |
| Background knowledge Claude should have but users shouldn't invoke | Skill + `user-invocable: false`          | —                                                                                                   |
| A helper with its own model, tools, permissions, context           | Subagent                                 | separate context window; result returns to caller                                                   |
| Something that must happen every time                              | Hook                                     | "Claude Code runs a hook every time its event occurs… whether or not Claude is following the skill" |
| Always-loaded project facts                                        | CLAUDE.md                                | loaded every session                                                                                |
| Tool access / blocking                                             | Permission rules                         | deterministic                                                                                       |

(<https://code.claude.com/docs/en/skills>, <https://code.claude.com/docs/en/output-styles>,
<https://code.claude.com/docs/en/features-overview>)

---

## 2. Slash commands and custom commands

Primary source: <https://code.claude.com/docs/en/skills> (custom commands live here now),
<https://code.claude.com/docs/en/commands> (built-in command list)

| Capability              | Mechanism                                                                                                                                                                                                                                                      | Source                                                                                                                                                           | Rationale                                                                   |
| :---------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------------------------- | :-------------------------------------------------------------------------- |
| Custom command file     | `.claude/commands/<name>.md` → `/name`; subdirectory path becomes a `:` namespace (`frontend/component.md` → `/frontend:component`)                                                                                                                            | [skills](https://code.claude.com/docs/en/skills)                                                                                                                 | [inferred] directory = namespace keeps flat file naming                     |
| Frontmatter             | **Same table as skills minus `name` and `paths`** — including `description`, `argument-hint`, `allowed-tools`, `model`                                                                                                                                         | [skills](https://code.claude.com/docs/en/skills)                                                                                                                 | unification; one mental model                                               |
| Legacy status           | "the older format and still works… Prefer a skill for new work, since skills also support supporting files"                                                                                                                                                    | [skills](https://code.claude.com/docs/en/skills)                                                                                                                 | supporting files are the one thing a flat file can't do                     |
| Collision               | If a skill and a command file share a name, the **skill** wins                                                                                                                                                                                                 | [skills](https://code.claude.com/docs/en/skills)                                                                                                                 | —                                                                           |
| Positional args         | `$1`, `$2`, `$ARGUMENTS`, `$ARGUMENTS[N]` — see §1.5                                                                                                                                                                                                           | [skills](https://code.claude.com/docs/en/skills)                                                                                                                 | —                                                                           |
| Bash execution          | `` !`cmd` `` / ` ```! ` fences — see §1.6                                                                                                                                                                                                                      | [skills](https://code.claude.com/docs/en/skills)                                                                                                                 | —                                                                           |
| File refs `@path`       | `@` is a **prompt-level** mechanism, not a command-frontmatter one: `@path` mentions files, `@server:protocol://path` mentions MCP resources, `@agent-<name>` mentions a subagent, and `@` opens the typeahead. Command bodies can use it like any prompt text | [permissions](https://code.claude.com/docs/en/permissions), [mcp](https://code.claude.com/docs/en/mcp), [sub-agents](https://code.claude.com/docs/en/sub-agents) | —                                                                           |
| `@` and permissions     | `Read(path)` deny rules apply to `@file` mentions, pasted image paths, and `@`-mentioned directories                                                                                                                                                           | [permissions](https://code.claude.com/docs/en/permissions)                                                                                                       | trust: mentioning a file is still a read                                    |
| Menu matching           | Filters as you type; highlights only on prefix or word-boundary matches, ignoring `:`, `_`, `-`; a typo highlights nothing and Enter submits verbatim ("Unknown command")                                                                                      | [commands](https://code.claude.com/docs/en/commands)                                                                                                             | determinism — never silently run a near-miss                                |
| Hidden commands         | Some (`/heapdump`) never appear on partial match; the full name still runs                                                                                                                                                                                     | [commands](https://code.claude.com/docs/en/commands)                                                                                                             | —                                                                           |
| MCP prompts as commands | `/server:prompt` in the menu, or `/mcp__server__prompt`; args split on whitespace                                                                                                                                                                              | [mcp](https://code.claude.com/docs/en/mcp)                                                                                                                       | —                                                                           |
| Shell mode              | Input prefixed `!` runs directly, bypassing Claude's approval, and the output is added to context; Claude then **responds automatically** unless `respondToBashCommands: false`                                                                                | [interactive-mode](https://code.claude.com/docs/en/interactive-mode)                                                                                             | cost note in docs: "The response costs the same as sending a normal prompt" |

Note on `@path` in command frontmatter: there is **no documented frontmatter key** that wires a
file reference; the docs' file-reference surface is the `@` prompt syntax plus `allowed-tools`
pre-approval. Anything claiming a `files:`-style frontmatter key is [unverified].

---

## 3. Hooks

Primary source: <https://code.claude.com/docs/en/hooks>. Practical recipes:
<https://code.claude.com/docs/en/hooks-guide>

### 3.1 Event catalogue (37 events, verbatim list)

| Event                                | Fires when                                                          | Can block?                               | Matcher field                                                              |
| :----------------------------------- | :------------------------------------------------------------------ | :--------------------------------------- | :------------------------------------------------------------------------- |
| `SessionStart`                       | session begins or resumes                                           | no (stderr to user)                      | `startup\|resume\|clear\|compact\|fork`                                    |
| `Setup`                              | `--init-only`, or `--init`/`--maintenance` in `-p`                  | no                                       | `init\|maintenance`                                                        |
| `InstructionsLoaded`                 | a CLAUDE.md / `.claude/rules/*.md` loads                            | no (ignored)                             | `session_start\|nested_traversal\|path_glob_match\|include\|compact`       |
| `UserPromptSubmit`                   | prompt submitted, before Claude sees it; also on self-started turns | **yes** — prompt never reaches Claude    | none                                                                       |
| `UserPromptExpansion`                | a typed command expands into a prompt                               | **yes**                                  | command name                                                               |
| `MessageDisplay`                     | while assistant text is displayed                                   | no                                       | none                                                                       |
| `PreToolUse`                         | before a tool call executes                                         | **yes**                                  | tool name                                                                  |
| `PermissionRequest`                  | a tool call needs a permission decision                             | no (exit 2 not honored; use `decision`)  | tool name                                                                  |
| `PermissionDenied`                   | auto mode denies a call                                             | no (use `retry: true`)                   | tool name                                                                  |
| `PostToolUse`                        | after a call succeeds                                               | no (stderr shown to Claude)              | tool name                                                                  |
| `PostToolUseFailure`                 | after a call fails                                                  | no                                       | tool name                                                                  |
| `PostToolBatch`                      | after a parallel batch resolves, before next model call             | **yes** — stops the loop                 | none                                                                       |
| `Notification`                       | Claude Code sends a notification                                    | no                                       | notification type (12 values)                                              |
| `SubagentStart`                      | subagent spawned                                                    | no                                       | agent type                                                                 |
| `SubagentStop`                       | subagent finishes                                                   | **yes** — prevents stopping              | agent type                                                                 |
| `TaskCreated` / `TaskCompleted`      | task created / marked done                                          | **yes** (rollback / prevent)             | none                                                                       |
| `Stop`                               | Claude finishes responding                                          | **yes** — continues the conversation     | none                                                                       |
| `StopFailure`                        | turn ends on an API error                                           | no (output ignored)                      | 13 error types                                                             |
| `TeammateIdle`                       | an agent-team teammate is about to idle                             | **yes**                                  | none                                                                       |
| `ConfigChange`                       | a config file changes mid-session                                   | **yes** (except `policy_settings`)       | `user_settings\|project_settings\|local_settings\|policy_settings\|skills` |
| `CwdChanged`                         | working directory changes                                           | no                                       | no matcher support                                                         |
| `DirectoryAdded`                     | `/add-dir` or SDK `register_repo_root`                              | no                                       | `slash_command\|register_repo_root`                                        |
| `FileChanged`                        | a watched file changes on disk                                      | no                                       | literal filenames                                                          |
| `WorktreeCreate` / `WorktreeRemove`  | worktree create/remove                                              | **yes** — any non-zero exit fails the op | —                                                                          |
| `PreCompact` / `PostCompact`         | before / after compaction                                           | **yes** / no                             | `manual\|auto`                                                             |
| `PreModelSwitch` / `PostModelSwitch` | before / after a model switch                                       | **yes** / no                             | canonical model name                                                       |
| `Elicitation` / `ElicitationResult`  | MCP server requests user input / user answers                       | **yes**                                  | MCP server name                                                            |
| `SessionEnd`                         | session terminates                                                  | no                                       | `clear\|resume\|logout\|prompt_input_exit\|other`                          |

(<https://code.claude.com/docs/en/hooks>)

Cadence taxonomy stated in the docs: **per session** (`SessionStart`/`SessionEnd`), **per turn**
(`UserPromptSubmit`/`Stop`/`StopFailure`), **per tool call** (`PreToolUse`/`PostToolUse`, except
`EndConversation` which skips both). Everything else is standalone async or sequential.
(<https://code.claude.com/docs/en/hooks>)

### 3.2 Matcher semantics (this is where implementations drift)

| Matcher value                                     | Evaluation                                                                | Example                                                                        | Source                                         |
| :------------------------------------------------ | :------------------------------------------------------------------------ | :----------------------------------------------------------------------------- | :--------------------------------------------- |
| `"*"`, `""`, omitted                              | match all                                                                 | —                                                                              | [hooks](https://code.claude.com/docs/en/hooks) |
| only letters, digits, `_`, `-`, spaces, `,`, `\|` | **exact string**, or a list separated by `\|` or `,` with optional spaces | `Bash`; `Edit\|Write`; `Edit, Write`; `code-reviewer`                          | [hooks](https://code.claude.com/docs/en/hooks) |
| any other character                               | **JavaScript `RegExp.prototype.test`, unanchored**                        | `^Notebook`; `mcp__memory__.*`; `Edit.*` matches `Edit` **and** `NotebookEdit` | [hooks](https://code.claude.com/docs/en/hooks) |

Consequences an implementer must copy:

- `FileChanged` and `StopFailure` use a **narrower** exact set — letters, digits, `_`, `|` only. A
  hyphen, space, or comma puts those two on the regex path, and only `|` separates alternatives.
- A matcher on an event **without** matcher support is **silently ignored** (no error).
- MCP tools match as `mcp__<server>__<tool>`; to match a whole server you **must** write
  `mcp__memory__.*` — `mcp__memory` alone is an exact string and matches nothing.
- Plugin-bundled MCP servers get a **scoped** segment:
  `mcp__plugin_<plugin-name>_<server-name>__<tool>`, so a matcher written against the bare server
  key never fires.
- Per-handler `if` narrows further using **permission rule syntax** (`"Bash(git *)"`,
  `"Edit(*.ts)"`), takes exactly **one** rule (no `&&`/`||`/list), and is only evaluated on tool
  events — on other events a hook with `if` **never runs**.
- `if` on Bash is best-effort: leading `VAR=value` is stripped, subcommands inside `&&`/`;` and
  inside `$()`/backticks are checked, and when Claude Code can't determine the subcommands it runs
  the hook **anyway**. Docs: "use the permission system rather than a hook to enforce a hard allow
  or deny."

(<https://code.claude.com/docs/en/hooks>)

### 3.3 Handler types and common fields

Five handler types: `command` (shell, JSON on stdin), `http` (POST, JSON body in = JSON body out),
`mcp_tool` (calls an MCP tool; its text output is treated like stdout), `prompt` (single-turn model
evaluation, returns JSON), `agent` (spawns a subagent that may use Read/Grep/Glob — **experimental**).

| Field               | Default / values                                                                                                                                                                                                                                                                          | Source                                         |
| :------------------ | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------- |
| `type`              | required, one of the five                                                                                                                                                                                                                                                                 | [hooks](https://code.claude.com/docs/en/hooks) |
| `if`                | one permission rule; tool events only                                                                                                                                                                                                                                                     | [hooks](https://code.claude.com/docs/en/hooks) |
| `timeout` (seconds) | **600** for command/http/mcp_tool; **30** for prompt; **60** for agent. Lowered to **30** on `UserPromptSubmit`, `PreModelSwitch`, `PostModelSwitch`; **10** on `MessageDisplay`. `SessionEnd` hooks share a **1.5 s** budget, raised to match an explicit longer timeout, capped at 60 s | [hooks](https://code.claude.com/docs/en/hooks) |
| `statusMessage`     | spinner text while it runs                                                                                                                                                                                                                                                                | [hooks](https://code.claude.com/docs/en/hooks) |
| `once`              | `true` = removed after first **successful** run; honored **only** in skill frontmatter                                                                                                                                                                                                    | [hooks](https://code.claude.com/docs/en/hooks) |
| `async`             | command hooks only; run in background; **timeout not enforced**                                                                                                                                                                                                                           | [hooks](https://code.claude.com/docs/en/hooks) |
| `onFailure`         | `"block"` makes a failed/timed-out command or HTTP hook block the action (v2.1.295+)                                                                                                                                                                                                      | [hooks](https://code.claude.com/docs/en/hooks) |

### 3.4 Exit-code conventions (including the trap)

| Exit                            | Meaning            | Effect                                                                                         | Source                                         |
| :------------------------------ | :----------------- | :--------------------------------------------------------------------------------------------- | :--------------------------------------------- |
| **0**                           | success            | JSON fields, if valid, are applied; action proceeds unless they block                          | [hooks](https://code.claude.com/docs/en/hooks) |
| **2**                           | blocking error     | stops the action **on events that can block**; reason = stderr (or the JSON decision's reason) | [hooks](https://code.claude.com/docs/en/hooks) |
| **anything else** (incl. **1**) | non-blocking error | action **proceeds**; a `<hook name> hook error` notice appears; first stderr line is shown     | [hooks](https://code.claude.com/docs/en/hooks) |

> The documented trap: _"Exit code 1 without valid JSON output is a non-blocking error… even though
> 1 is the conventional Unix failure code. If your hook is meant to enforce a policy, use `exit 2`."_
> (<https://code.claude.com/docs/en/hooks>)

Stdout × exit-code matrix (verbatim semantics):

| stdout                            | exit 0                                          | exit 2                                                  | other                                                |
| :-------------------------------- | :---------------------------------------------- | :------------------------------------------------------ | :--------------------------------------------------- |
| valid JSON object                 | success, fields apply                           | blocking; fields read but **cannot override** the block | success — **exit code ignored**, fields alone decide |
| unparseable / schema-invalid JSON | non-blocking error (notice carries the message) | blocking; stderr is the reason                          | non-blocking error                                   |
| plain text / empty                | success                                         | blocking; stderr is the reason                          | non-blocking error, first stderr line shown          |

Plus per-event carve-outs: `WorktreeCreate`/`WorktreeRemove` fail on **any** non-zero exit;
`Stop`/`SubagentStop`/`TaskCompleted` and a plugin's `UserPromptSubmit` treat exit 2 + a
"file missing" stderr as non-blocking; `Elicitation`/`ElicitationResult` only apply
`hookSpecificOutput` on exit 0; `StopFailure` discards JSON entirely except side-effect fields like
`terminalSequence`. (<https://code.claude.com/docs/en/hooks>)

Output classification rules (exact, for exit-0 JSON): stdout counts as JSON only when it is **one**
JSON object with nothing but whitespace around it. An array, a quoted string, or two independent
JSON lines are **plain text**; a single line inside such a block that sets a field makes the whole
thing a **parse failure**. (<https://code.claude.com/docs/en/hooks>)

Which events surface plain stdout to Claude: only `UserPromptSubmit`, `UserPromptExpansion`,
`SessionStart`, `PostModelSwitch`. Everything else goes to the debug log.
(<https://code.claude.com/docs/en/hooks>)

### 3.5 JSON output contract

| Field                 | Meaning                                      | Notes                                                                                                                         | Source                                         |
| :-------------------- | :------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------- |
| `continue`            | `false` stops Claude entirely after the hook | **takes precedence over any event-specific decision**                                                                         | [hooks](https://code.claude.com/docs/en/hooks) |
| `stopReason`          | shown to the user when `continue:false`      | stays in the conversation, so Claude sees it if the conversation resumes                                                      | [hooks](https://code.claude.com/docs/en/hooks) |
| `suppressOutput`      | accepted but **has no effect**               | —                                                                                                                             | [hooks](https://code.claude.com/docs/en/hooks) |
| `systemMessage`       | warning shown to the user                    | can arrive as `SDKInformationalMessage` in stream-json                                                                        | [hooks](https://code.claude.com/docs/en/hooks) |
| `terminalSequence`    | escape sequence emitted by Claude Code       | allowlist: OSC `0/1/2/9/99/777` + BEL; anything else → field ignored. This is the endorsed replacement for writing `/dev/tty` | [hooks](https://code.claude.com/docs/en/hooks) |
| `decision` / `reason` | top-level block for some events              | `PostToolUse`, `Stop`, etc.                                                                                                   | [hooks](https://code.claude.com/docs/en/hooks) |
| `hookSpecificOutput`  | nested object; **requires `hookEventName`**  | `PreToolUse`, `PermissionRequest`, etc.                                                                                       | [hooks](https://code.claude.com/docs/en/hooks) |

Size cap: `additionalContext`, `systemMessage`, `initialUserMessage` and plain stdout are each
capped at **10,000 characters**, measured per string (not per event). Over the cap, output is saved
to a file in the session directory and replaced by the path plus a **2,000-character** preview, and
**Claude is not asked to read it**. Unlike the Bash ceiling there is **no setting to raise it**.
(<https://code.claude.com/docs/en/hooks>)

### 3.6 PreToolUse decision control

| Field                      | Values                                | Notes                                                                                                                                                                                                                  | Source                                         |
| :------------------------- | :------------------------------------ | :--------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------- |
| `permissionDecision`       | `allow` \| `deny` \| `ask` \| `defer` | `allow` skips the prompt **except** for actions no mode auto-approves, network-path reads, SDK `always_ask` tools; `AskUserQuestion`/`ExitPlanMode` need `updatedInput` **paired** with `allow`; `defer` requires `-p` | [hooks](https://code.claude.com/docs/en/hooks) |
| `permissionDecisionReason` | string                                | `ask` → shown in the prompt; `deny` → shown to Claude; `allow`/`defer` → debug log only                                                                                                                                | [hooks](https://code.claude.com/docs/en/hooks) |
| `updatedInput`             | full replacement object               | **Replaces the entire input** — include unchanged fields. Permission rules and Bash auto-background eligibility are evaluated against the **returned** input                                                           | [hooks](https://code.claude.com/docs/en/hooks) |
| `additionalContext`        | string                                | added beside the tool result; ignored for `defer`                                                                                                                                                                      | [hooks](https://code.claude.com/docs/en/hooks) |

Precedence across multiple `PreToolUse` hooks: **`deny` > `defer` > `ask` > `allow`**.
Deprecated: top-level `decision`/`reason` for this event (`approve`→`allow`, `block`→`deny`).
`defer` round-trip: turn ends with `stop_reason: "tool_deferred"` and the SDK result carries
`deferred_tool_use {id, name, input}`; the caller resumes with `claude -p --resume <session-id>` and
the same tool call fires `PreToolUse` again, now returning `allow` + `updatedInput`.
(<https://code.claude.com/docs/en/hooks>)

### 3.7 Blocking versus the permission system

Documented precedence rules that matter for a reimplementation:

- A `PreToolUse` hook **does not bypass** permission rules: deny rules still block, ask rules still
  prompt, **regardless** of `"allow"` from the hook.
- A hook that exits 2 stops the call **before** permission rules are evaluated, so a blocking hook
  beats an allow rule.
- In **plan mode**, a hook's `"allow"` has no effect on a non-read-only call (except
  `ExitPlanMode` + `updatedInput`); `updatedInput` is still applied.
- A **timed-out** hook on `PreToolUse` does **not** block — the call proceeds through normal
  permissions. Docs: "don't count on a stalled hook to act as a gate." Use `onFailure: "block"`.
- Backgrounded-process hooks: print the decision **before** starting the background job and redirect
  its stdout/stderr, else Claude Code refuses with `refusing to honor the suspect capture`.

(<https://code.claude.com/docs/en/hooks>, <https://code.claude.com/docs/en/permissions>)

### 3.8 Locations and precedence

| Location                      | Scope                        | Source                                         |
| :---------------------------- | :--------------------------- | :--------------------------------------------- |
| `~/.claude/settings.json`     | all your projects            | [hooks](https://code.claude.com/docs/en/hooks) |
| `.claude/settings.json`       | project, committable         | [hooks](https://code.claude.com/docs/en/hooks) |
| `.claude/settings.local.json` | project, personal            | [hooks](https://code.claude.com/docs/en/hooks) |
| managed policy settings       | org-wide                     | [hooks](https://code.claude.com/docs/en/hooks) |
| plugin `hooks/hooks.json`     | while plugin enabled         | [hooks](https://code.claude.com/docs/en/hooks) |
| skill frontmatter             | rest of session after invoke | [hooks](https://code.claude.com/docs/en/hooks) |
| subagent frontmatter          | while that subagent runs     | [hooks](https://code.claude.com/docs/en/hooks) |

Hook entries **merge** across levels rather than replacing. `allowManagedHooksOnly` (managed) blocks
all user/project/local/plugin hooks except force-enabled managed plugins, and also narrows
`statusLine` / `fileSuggestion` / `subagentStatusLine` to managed settings. `disableAllHooks` can't
disable managed hooks from outside managed settings. `allowedHttpHookUrls` and
`httpHookAllowedEnvVars` gate HTTP handlers from **every** source.
(<https://code.claude.com/docs/en/hooks>)

### 3.9 Practical use cases the docs endorse

Format after every edit (`PostToolUse` + `Edit|Write`); block destructive commands
(`PreToolUse` + `if: "Bash(rm *)"`); validate/lint gates; re-inject context after compaction
(`SessionStart` matching `compact`); terminal notifications (`terminalSequence`);
direnv-style env refresh (`CwdChanged`); auto-approve or gate MCP writes
(`mcp__.*__write.*`); enforce quality gates in agent teams (`TeammateIdle`, `TaskCompleted`);
roll back task creation (`TaskCreated` exit 2); prompt-time policy (`UserPromptSubmit`);
CI one-time setup (`Setup`).
(<https://code.claude.com/docs/en/hooks>, <https://code.claude.com/docs/en/hooks-guide>)

---

## 4. Subagents / agents

Primary source: <https://code.claude.com/docs/en/sub-agents>

### 4.1 Built-in types

| Type                | Model                                  | Tools                            | Startup context                    | Notes                                                                                                            |
| :------------------ | :------------------------------------- | :------------------------------- | :--------------------------------- | :--------------------------------------------------------------------------------------------------------------- |
| `Explore`           | main model (Fable caveat)              | read-only; Write/Edit **denied** | **skips CLAUDE.md and git status** | thoroughness parameter: quick / medium / very thorough; one-shot, **returns no agent ID** so it can't be resumed |
| `Plan`              | inherits main                          | read-only                        | **skips CLAUDE.md and git status** | used inside plan mode; one-shot, no ID                                                                           |
| `general-purpose`   | `CLAUDE_CODE_SUBAGENT_MODEL` else main | every subagent tool              | full CLAUDE.md + git status        | the resumable default                                                                                            |
| `claude`            | follows the subagent model order       | all subagent tools               | full                               | catch-all; default agent for a dispatched background session                                                     |
| `statusline-setup`  | Sonnet                                 | —                                | —                                  | used by `/statusline`                                                                                            |
| `claude-code-guide` | Haiku                                  | —                                | —                                  | answers questions about Claude Code                                                                              |

Design rationale (stated): Explore and Plan start without CLAUDE.md and git status _"to keep
research fast and inexpensive."_ User/project subagents load both unless `omitClaudeMd: true`.
(<https://code.claude.com/docs/en/sub-agents>)

Kill switches: deny the `Agent` tool (blocks all delegation); deny a specific type in
`permissions.deny`; `CLAUDE_CODE_DISABLE_EXPLORE_PLAN_AGENTS=1` (v2.1.198+);
`CLAUDE_AGENT_SDK_DISABLE_BUILTIN_AGENTS=1` (non-interactive/SDK only).
(<https://code.claude.com/docs/en/sub-agents>)

### 4.2 File format and complete frontmatter

`.claude/agents/*.md` (project), `~/.claude/agents/` (user), managed dir (enterprise),
`<plugin>/agents/` (plugin). Only `name` and `description` are required. **Field names use
camelCase** (unlike skills' kebab-case) and unrecognized fields are silently ignored; `--debug`
reports up to five unrecognized top-level fields (v2.1.296+).

| Field                   | Values                                                                             | Behavior                                                                                                                       | Source                                                   |
| :---------------------- | :--------------------------------------------------------------------------------- | :----------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------- |
| `name`                  | ≤ 256 chars, no `:` (reserved for plugin scoping)                                  | exposed as `agent_type` to hooks                                                                                               | [sub-agents](https://code.claude.com/docs/en/sub-agents) |
| `description`           | string                                                                             | delegation signal; "use proactively" encourages auto-delegation                                                                | [sub-agents](https://code.claude.com/docs/en/sub-agents) |
| `tools`                 | comma string or list                                                               | omitted = every subagent tool; a list where **no** entry resolves fails to launch (`agent would be spawned with zero tools`)   | [sub-agents](https://code.claude.com/docs/en/sub-agents) |
| `disallowedTools`       | same format                                                                        | removed from the inherited/specified list; an entry **with** a specifier (`Bash(git push *)`) still removes the **whole tool** | [sub-agents](https://code.claude.com/docs/en/sub-agents) |
| `model`                 | `sonnet\|opus\|haiku\|fable\|<full id>\|inherit`                                   | omitted → subagent model order                                                                                                 | [sub-agents](https://code.claude.com/docs/en/sub-agents) |
| `permissionMode`        | `default`(`manual`), `acceptEdits`, `auto`, `dontAsk`, `bypassPermissions`, `plan` | **ignored for plugin subagents**; frequently overridden by the main mode (see 4.4)                                             | [sub-agents](https://code.claude.com/docs/en/sub-agents) |
| `maxTurns`              | int                                                                                | output returned marked **partial**; resumable (v2.1.246+)                                                                      | [sub-agents](https://code.claude.com/docs/en/sub-agents) |
| `autoCompactWindow`     | 100000–1000000                                                                     | per-subagent auto-compact threshold (v2.1.296+)                                                                                | [sub-agents](https://code.claude.com/docs/en/sub-agents) |
| `skills`                | list                                                                               | **full content** injected at startup, not just descriptions                                                                    | [sub-agents](https://code.claude.com/docs/en/sub-agents) |
| `mcpServers`            | names or inline defs                                                               | scoped MCP for this subagent; ignored for plugin subagents                                                                     | [sub-agents](https://code.claude.com/docs/en/sub-agents) |
| `hooks`                 | hook config                                                                        | scoped to the subagent; ignored for plugin subagents                                                                           | [sub-agents](https://code.claude.com/docs/en/sub-agents) |
| `memory`                | `user\|project\|local`                                                             | persistent memory scope across sessions                                                                                        | [sub-agents](https://code.claude.com/docs/en/sub-agents) |
| `background`            | bool                                                                               | `true` keeps it backgrounded even when Claude asks to wait                                                                     | [sub-agents](https://code.claude.com/docs/en/sub-agents) |
| `omitClaudeMd`          | bool                                                                               | drops user/project/local CLAUDE.md (managed still loads)                                                                       | [sub-agents](https://code.claude.com/docs/en/sub-agents) |
| `effort`                | level                                                                              | overrides session effort, not the env var                                                                                      | [sub-agents](https://code.claude.com/docs/en/sub-agents) |
| `isolation`             | `worktree`                                                                         | temporary git worktree, branched from the **default branch**, cleaned up if unchanged                                          | [sub-agents](https://code.claude.com/docs/en/sub-agents) |
| `color`                 | 8 named colors                                                                     | display only                                                                                                                   | [sub-agents](https://code.claude.com/docs/en/sub-agents) |
| `initialPrompt`         | string                                                                             | auto-submitted first turn when run as the **main** session agent (`--agent`)                                                   | [sub-agents](https://code.claude.com/docs/en/sub-agents) |
| `experimental.cacheTtl` | `5m\|1h`                                                                           | prompt-cache lifetime for this subagent's requests (v2.1.248+)                                                                 | [sub-agents](https://code.claude.com/docs/en/sub-agents) |

> Field-name detail worth copying verbatim: subagents use `disallowedTools` (camelCase), skills use
> `disallowed-tools` (kebab). Both exist; mixing them fails silently.

### 4.3 Auto-selection versus explicit invocation

| Path                | Mechanism                                                                                                                                                     | Source                                                   |
| :------------------ | :------------------------------------------------------------------------------------------------------------------------------------------------------------ | :------------------------------------------------------- |
| Automatic           | Claude decides from the task description in your request, the subagent `description`, and current context; "use proactively" in the description encourages it | [sub-agents](https://code.claude.com/docs/en/sub-agents) |
| Explicit by mention | `@agent-<name>` in the prompt guarantees that subagent runs (the type, not the prompt — Claude still writes the task)                                         | [sub-agents](https://code.claude.com/docs/en/sub-agents) |
| Explicit by tool    | Agent tool with `subagent_type`; omitting it fails with `subagent_type is required` when no `general-purpose` exists                                          | [sub-agents](https://code.claude.com/docs/en/sub-agents) |
| Main session agent  | `--agent` flag or the `agent` setting; `initialPrompt` applies                                                                                                | [sub-agents](https://code.claude.com/docs/en/sub-agents) |

Cost lever: the **combined** descriptions are shown to Claude, and a startup warning fires past
**15,000 tokens** — every subagent still loads.
(<https://code.claude.com/docs/en/sub-agents>)

### 4.4 Permission-mode interaction (non-obvious precedence)

- Main in `bypassPermissions` / `acceptEdits` / `auto` → subagent runs in **that** mode and the
  subagent's `permissionMode` is **ignored** (under auto, the classifier uses the **main**
  conversation's block/allow rules and also reviews the subagent's final report).
- Main in `plan` → subagent stays in plan mode whatever you set; setting `dontAsk` additionally
  turns plan-mode prompts into denials.
- Main in `default`/`dontAsk` → the subagent's `permissionMode` applies, **except** `bypassPermissions`
  (v2.1.267+) and `auto` when auto isn't available to it.
  (<https://code.claude.com/docs/en/sub-agents>)

### 4.5 Context isolation — exactly what crosses the boundary

Included at startup: the agent's **own** system prompt (not Claude Code's) + appended environment
details; the delegation message; the full CLAUDE.md hierarchy (managed, user, project, local,
AGENTS.md) unless Explore/Plan/`omitClaudeMd`; a **git status snapshot**; preloaded skill bodies;
a **sibling roster** system reminder (only if `SendMessage` is in its tools and another named agent
exists).

Excluded: your conversation history, skills you already invoked, files Claude already read, the
**output style**, the main conversation's **auto memory**, and the parent's context-window size.
(<https://code.claude.com/docs/en/sub-agents>)

### 4.6 Foreground vs background

| Aspect      | Foreground                         | Background                                                                                |
| :---------- | :--------------------------------- | :---------------------------------------------------------------------------------------- |
| Default     | `-p`/SDK: Claude may wait          | **subagents Claude spawns from the main conversation start in the background by default** |
| Blocking    | blocks the conversation            | runs concurrently                                                                         |
| Permissions | prompts pass through as they occur | prompts surface in the **main** session naming the subagent; Esc denies that one call     |
| Tool set    | full                               | **smaller** built-in tool set, except conversation forks and resumed foreground subagents |
| Results     | returned                           | arrive as a **completion notification in a later turn**                                   |

Opt-outs: `CLAUDE_CODE_FORK_SUBAGENT=0` (turn fork mode off so Claude can wait),
`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` (Claude always waits; also removes Ctrl+B and background
bash). (<https://code.claude.com/docs/en/sub-agents>,
<https://code.claude.com/docs/en/interactive-mode>)

### 4.7 Parallelism, limits, resumption

| Topic              | Exact rule                                                                                                                                                                                                                                       | Source                                                   |
| :----------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------- |
| Concurrency cap    | **20** running subagents by default; the 21st fails with `Concurrent subagent limit reached` and tells Claude not to retry. Change with `CLAUDE_CODE_MAX_CONCURRENT_SUBAGENTS` (v2.1.217+). Ultracode sessions are exempt                        | [sub-agents](https://code.claude.com/docs/en/sub-agents) |
| Who occupies slots | Agent-tool subagents; `/subtask` forks take a slot but are never blocked; resuming a finished subagent takes a fresh slot **without** checking the limit, so resumes can exceed it                                                               | [sub-agents](https://code.claude.com/docs/en/sub-agents) |
| Depth              | separate nesting-depth limit for subagents spawning subagents                                                                                                                                                                                    | [sub-agents](https://code.claude.com/docs/en/sub-agents) |
| Total              | **no** limit on subagents spawned over a session                                                                                                                                                                                                 | [sub-agents](https://code.claude.com/docs/en/sub-agents) |
| Resumption         | every invocation is a **new instance**; Claude resumes via `SendMessage` with the agent ID or name; resumed runs keep the **full history** including tool calls and reasoning, keep the original tool set, and can reuse the warmed prompt cache | [sub-agents](https://code.claude.com/docs/en/sub-agents) |
| Not resumable      | `Explore` and `Plan` (no agent ID returned)                                                                                                                                                                                                      | [sub-agents](https://code.claude.com/docs/en/sub-agents) |
| Identity check     | `SendMessage` verifies a name still reaches the same agent; if a newer agent took the name it **refuses** and reports the new target; the check is scoped to the conversation and resets on `/clear`                                             | [sub-agents](https://code.claude.com/docs/en/sub-agents) |
| Transcripts        | `~/.claude/projects/{project}/{sessionId}/subagents/agent-{agentId}.jsonl` (+ `.meta.json`); unaffected by main-conversation compaction; deleted after `cleanupPeriodDays` (30 d)                                                                | [sub-agents](https://code.claude.com/docs/en/sub-agents) |
| Hygiene            | an agent message never counts as user approval and can never change a subagent's permissions, CLAUDE.md, or config                                                                                                                               | [sub-agents](https://code.claude.com/docs/en/sub-agents) |

### 4.8 Conversation forks (distinct from subagents)

`/subtask` forks the **current conversation**: the child inherits the parent's conversation and
system prompt, so the output style **does** apply. Fork mode is on by default in interactive
sessions; `CLAUDE_CODE_FORK_SUBAGENT=0` turns it off, and a fork can be observed/steered while
running. (<https://code.claude.com/docs/en/sub-agents>)

---

## 5. Plugins and marketplaces

Primary sources: <https://code.claude.com/docs/en/plugins/overview>,
<https://code.claude.com/docs/en/plugins/components>,
<https://code.claude.com/docs/en/plugins/manifest-reference>,
<https://code.claude.com/docs/en/plugins/marketplace-reference>,
<https://code.claude.com/docs/en/plugins/loading>,
<https://code.claude.com/docs/en/plugins/install>,
<https://code.claude.com/docs/en/plugins/security>

### 5.1 Structure

```
my-plugin/
├── .claude-plugin/plugin.json     # manifest; only "name" required
├── skills/<name>/SKILL.md         # → /my-plugin:<name>
├── commands/<name>.md             # legacy single-file commands
├── agents/<name>.md               # subagents → @agent-my-plugin:<name>
├── hooks/hooks.json               # {"hooks": {...}} — same schema as settings
├── .mcp.json                      # MCP servers (scoped mcp__plugin_<plugin>_<server>__*)
├── output-styles/<name>.md
├── bin/                           # added to the Bash tool's PATH
├── monitors / lsp servers / mods  # additional component types
└── scripts/                       # referenced via ${CLAUDE_PLUGIN_ROOT}
```

Component types the docs enumerate: skills, commands, agents, hooks, a hooks module (a **mod**),
MCP servers, LSP servers, executables (`bin/`), default settings, themes and output styles,
channels, monitors. (<https://code.claude.com/docs/en/plugins/components>)

`plugin.json` example and rules: `name` required; `version` pins users to that version until you
change it; Claude Code **loads a plugin without a manifest**. Unknown keys are ignored rather than
rejected; `claude plugin validate` reports them as warnings.
(<https://code.claude.com/docs/en/plugins/components>,
<https://code.claude.com/docs/en/plugins/marketplace-reference>)

### 5.2 `marketplace.json`

Location: `.claude-plugin/marketplace.json` in the marketplace root; relative plugin sources resolve
from the **marketplace root**, not from `.claude-plugin/`. One registration per `name` per user.

Required: `name`, `owner` (with `owner.name`), `plugins` (array; each entry validated
independently, so one bad entry doesn't fail the catalog).

| Top-level field                       | Purpose                                                                  | Source                                                                                 |
| :------------------------------------ | :----------------------------------------------------------------------- | :------------------------------------------------------------------------------------- |
| `name`                                | identifier: letters/digits/`.`/`_`/`-`, must start alphanumeric, no `..` | [marketplace-reference](https://code.claude.com/docs/en/plugins/marketplace-reference) |
| `owner`                               | `{name, email?, url?}`                                                   | same                                                                                   |
| `plugins`                             | array of entries                                                         | same                                                                                   |
| `metadata.pluginRoot`                 | base dir for bare source names (v2.1.239+)                               | same                                                                                   |
| `forceRemoveDeletedPlugins`           | uninstall on users' machines when removed from `plugins`                 | same                                                                                   |
| `allowCrossMarketplaceDependenciesOn` | which marketplaces may supply dependencies                               | same                                                                                   |
| `renames`                             | former `name` → current name, or `null`                                  | same                                                                                   |
| `$schema`, `description`, `version`   | editor/autocomplete and display                                          | same                                                                                   |

Per-entry fields: `name` (install/enable key — may differ from the manifest name), `source`
(required), `description`, `version` (manifest wins), `category`, `tags`, `strict` (default
`true`), `relevance`, `dependencies`, `defaultEnabled` (default `true`), `displayName`, `metadata`,
`headers`, `headersHelper`.

Source kinds: relative path, `github`, `url`, `git-subdir`, `npm`, `archive` (with optional
`sha256` pin), `command`. Each has its own field set under "Plugin sources".
(<https://code.claude.com/docs/en/plugins/marketplace-reference>)

Reserved-name defense (worth copying — it's an anti-impersonation layer, not cosmetics): official
names (`claude-code-marketplace`, `claude-plugins-official`, `anthropic-marketplace`,
`agent-skills`, …), community names (`claude-community`, `claude-plugins-community`), plugin
directory names, names that impersonate an official marketplace or contain non-ASCII, alternate
spellings differing by a trailing dot or a non-underscore symbol in place of a hyphen, JS object
member names (`constructor`, `toString`, …), `claudeai-*`, and `npm`/`pip`/`uv`/`cargo`/`github`/`gh`
in any casing. Impersonation is checked on **source** too: an official name whose source is outside
`github.com/anthropics/` stops loading.
(<https://code.claude.com/docs/en/plugins/marketplace-reference>,
<https://code.claude.com/docs/en/plugins/security>)

### 5.3 Install / enable flow and scopes

| Step                       | Command / key                                                                                                                                                      | Source                                                                         |
| :------------------------- | :----------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------------------------------------- |
| Add a catalog              | `/plugin marketplace add <owner>/<repo>` (or a path/URL)                                                                                                           | [install](https://code.claude.com/docs/en/plugins/install)                     |
| Install                    | `/plugin install <name>@<marketplace>`                                                                                                                             | [install](https://code.claude.com/docs/en/plugins/install)                     |
| Enable/disable in settings | `enabledPlugins: {"<name>@<marketplace>": true}`                                                                                                                   | [loading](https://code.claude.com/docs/en/plugins/loading)                     |
| CLI equivalents            | `claude plugin install` / `enable` / `disable` / `uninstall` / `list --json` / `validate`                                                                          | [plugins/cli-reference](https://code.claude.com/docs/en/plugins/cli-reference) |
| Scopes                     | **user** (all projects on this machine), **project** (via committed `.claude/settings.json`; each collaborator still installs locally), **local** (you, this repo) | [plugins/overview](https://code.claude.com/docs/en/plugins/overview)           |
| Plugin id                  | `<name>@<origin>` where origin ∈ marketplace name \| `inline` \| `skills-dir` \| `synced`                                                                          | [loading](https://code.claude.com/docs/en/plugins/loading)                     |
| Repo sharing               | list it under `enabledPlugins` in `.claude/settings.json`, or place it under `.claude/skills/`; `.claude/plugins/` is **not** scanned                              | [loading](https://code.claude.com/docs/en/plugins/loading)                     |
| Self-hosting a plugin      | a skill folder with `.claude-plugin/plugin.json` loads as `<name>@skills-dir` (needs workspace trust in a project)                                                 | [skills](https://code.claude.com/docs/en/skills)                               |

Naming/namespacing: components are namespaced by the **manifest** name, while install/enable keys
and the cache directory use the **marketplace entry** name — and the docs call out that these can
differ. Skills → `/plugin:skill`; agents → `@agent-plugin:name`; plugin MCP tools →
`mcp__plugin_<plugin>_<server>__<tool>`.
(<https://code.claude.com/docs/en/plugins/loading>,
<https://code.claude.com/docs/en/hooks>)

### 5.4 Trust and security model

| Risk                                | Documented behavior                                                                                      | Source                                                               |
| :---------------------------------- | :------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------- |
| Hooks / monitors / MCP / LSP / mods | run with **your full user permissions**, **outside the sandbox**; "what the plugin runs, it runs as you" | [plugins/security](https://code.claude.com/docs/en/plugins/security) |
| `bin/`                              | added to the **Bash tool's** PATH (and PowerShell's PATH only outside the sandbox)                       | [plugins/security](https://code.claude.com/docs/en/plugins/security) |
| Skills/commands/agents              | enter context as **instructions**, influencing what Claude does with existing tools                      | [plugins/security](https://code.claude.com/docs/en/plugins/security) |
| Auto-update                         | files you reviewed can change on disk in the background                                                  | [plugins/security](https://code.claude.com/docs/en/plugins/security) |
| Permission rules                    | cover **Claude's tool calls**, not code the plugin runs itself                                           | [plugins/security](https://code.claude.com/docs/en/plugins/security) |

The install-time trust warning (verbatim, same for every marketplace): _"Make sure you trust a
plugin before installing, updating, or using it. Anthropic does not control what MCP servers,
files, or other software are included in plugins and cannot verify that they will work as intended
or that they won't change."_ Managed settings can append org text via `pluginTrustMessage`.
Refusals (not warnings): untrusted source for an official/community name; `archive` `sha256`
mismatch (`Plugin archive integrity check failed`).
(<https://code.claude.com/docs/en/plugins/security>)

Per-turn cost of an enabled plugin: name + description for every skill, agent, and command Claude
can invoke; MCP cost follows tool search; plus always-running MCP servers and hooks. Docs provide
a **Context cost** estimate in Anthropic's marketplace, and flag "Not used recently" plugins.
(<https://code.claude.com/docs/en/plugins/overview>)

---

## 6. Context and memory

Primary sources: <https://code.claude.com/docs/en/memory>,
<https://code.claude.com/docs/en/context-window>,
<https://code.claude.com/docs/en/prompt-caching>,
<https://code.claude.com/docs/en/claude-directory>

### 6.1 CLAUDE.md hierarchy

| Scope          | Location                                                                                                                                           | Shared with                    | Source                                           |
| :------------- | :------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------- | :----------------------------------------------- |
| Managed policy | macOS `/Library/Application Support/ClaudeCode/CLAUDE.md`; Linux/WSL `/etc/claude-code/CLAUDE.md`; Windows `C:\Program Files\ClaudeCode\CLAUDE.md` | whole org                      | [memory](https://code.claude.com/docs/en/memory) |
| User           | `~/.claude/CLAUDE.md`                                                                                                                              | you, all projects              | [memory](https://code.claude.com/docs/en/memory) |
| Project        | `./CLAUDE.md` or `./.claude/CLAUDE.md`                                                                                                             | team via git                   | [memory](https://code.claude.com/docs/en/memory) |
| Local          | `./CLAUDE.local.md`                                                                                                                                | you, this project (gitignored) | [memory](https://code.claude.com/docs/en/memory) |
| Rules          | `.claude/rules/*.md`, optionally `paths:`-scoped                                                                                                   | team                           | [memory](https://code.claude.com/docs/en/memory) |

Load semantics — **concatenate, never override**: cwd and every ancestor directory are loaded;
ordering is root → cwd, and within a directory `CLAUDE.local.md` comes **after** `CLAUDE.md`, so the
most specific/most personal text is read last. Subdirectory files load **on demand**, when Claude
first reads/edits a file there (a `cat`/`head` of a single file counts as a read).
Block-level HTML comments are **stripped** before injection (comments inside code blocks survive).
(<https://code.claude.com/docs/en/memory>)

Path-scoped rules: `paths:` frontmatter with globs relative to the rule's base directory (project
root for project rules, primary working directory for user rules); brace expansion supported, with
a shared budget of **1,000 expanded patterns and 4 MiB** per rule; a pattern that would exceed the
budget is used unexpanded (so its literal braces match nothing); `[` needs escaping as `\[`.
`paths` is the **only** field read from rule frontmatter.
(<https://code.claude.com/docs/en/memory>)

Compaction interaction (important, and easy to miss): **project-root CLAUDE.md and unscoped rules
are re-injected from disk after compaction**, but **path-scoped rules and nested CLAUDE.md files are
summarized away** with message history. Docs' advice: if a rule must survive, drop `paths:` or move
it to the root CLAUDE.md. (<https://code.claude.com/docs/en/context-window>)

### 6.2 `@import`

| Rule             | Value                                                                                                                                                     | Source                                           |
| :--------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------- |
| Syntax           | `@path/to/file` anywhere in the file                                                                                                                      | [memory](https://code.claude.com/docs/en/memory) |
| Resolution       | relative to the **importing file**, not cwd; absolute allowed                                                                                             | [memory](https://code.claude.com/docs/en/memory) |
| Depth            | recursive, **max 4 hops**                                                                                                                                 | [memory](https://code.claude.com/docs/en/memory) |
| Spaces           | escape each space with a backslash (`@Design\ Docs/x.md`); a quoted path is **not** imported at all                                                       | [memory](https://code.claude.com/docs/en/memory) |
| Exclusions       | parsing skips code spans and fenced blocks, so `` `@README` `` stays literal                                                                              | [memory](https://code.claude.com/docs/en/memory) |
| External imports | an import resolving **outside the working directory** triggers a one-time approval dialog listing the files; declining disables them permanently          | [memory](https://code.claude.com/docs/en/memory) |
| Extra dirs       | `--add-dir` does **not** load that dir's CLAUDE.md unless `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`                                                | [memory](https://code.claude.com/docs/en/memory) |
| Size caps        | CLAUDE.md loads whole up to **4 MiB** per file (larger → skipped entirely); subdirectory CLAUDE.md and path-scoped rules have smaller limits of their own | [memory](https://code.claude.com/docs/en/memory) |

Rationale (stated): the approval dialog exists _"to protect you from files other people commit to a
shared project"_; user-scope files you wrote yourself load their imports without a dialog.
(<https://code.claude.com/docs/en/memory>)

### 6.3 Auto memory (`MEMORY.md`)

| Aspect          | Exact                                                                                                                                                                       | Source                                           |
| :-------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------------- |
| What            | Claude-written notes, four `type`s: `user`, `feedback`, `project`, `reference`                                                                                              | [memory](https://code.claude.com/docs/en/memory) |
| Location        | `~/.claude/projects/<project>/memory/` — keyed on the **git repo**, so all worktrees/subdirs share one                                                                      | [memory](https://code.claude.com/docs/en/memory) |
| Layout          | `MEMORY.md` index + one topic file per memory                                                                                                                               | [memory](https://code.claude.com/docs/en/memory) |
| Loaded at start | **first 200 lines or first 25 KB** of `MEMORY.md`, whichever comes first                                                                                                    | [memory](https://code.claude.com/docs/en/memory) |
| Topic files     | not loaded at startup; read on demand with normal tools                                                                                                                     | [memory](https://code.claude.com/docs/en/memory) |
| Write feedback  | after a write, Claude Code checks the limits and **reminds Claude to shorten**; an over-limit write still succeeds but returns an error telling Claude to rewrite the index | [memory](https://code.claude.com/docs/en/memory) |
| Provenance      | when a memory file starts with frontmatter, a `modified` ISO-8601 field is recorded                                                                                         | [memory](https://code.claude.com/docs/en/memory) |
| Retention       | memory files are **excluded** from the `cleanupPeriodDays` transcript sweep                                                                                                 | [memory](https://code.claude.com/docs/en/memory) |
| Toggles         | `/memory` toggle → `autoMemoryEnabled` in `~/.claude/settings.json`; `autoMemoryDirectory`; `CLAUDE_CODE_DISABLE_AUTO_MEMORY=1`                                             | [memory](https://code.claude.com/docs/en/memory) |
| Scope           | machine-local; not shared across machines or cloud; **not** loaded into subagents (except forks); a subagent's own memory is a separate directory via its `memory` field    | [memory](https://code.claude.com/docs/en/memory) |
| Default         | **on** in local sessions; **off** by default in self-hosted environments                                                                                                    | [memory](https://code.claude.com/docs/en/memory) |

`/memory` browses and opens memory files, toggles auto memory, and lists loaded CLAUDE.md files.
(<https://code.claude.com/docs/en/memory>)

### 6.4 Compaction — exactly what is preserved

| Mechanism                                    | After compaction                                                                                                                                  | Source                                                           |
| :------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------ | :--------------------------------------------------------------- |
| System prompt and output style               | still apply                                                                                                                                       | [context-window](https://code.claude.com/docs/en/context-window) |
| Project-root CLAUDE.md and unscoped rules    | **re-injected from disk**                                                                                                                         | same                                                             |
| Auto memory                                  | **re-injected from disk**                                                                                                                         | same                                                             |
| Skill descriptions                           | rebuilt from current skills and re-injected (v2.1.304+)                                                                                           | same                                                             |
| Git status snapshot                          | a **fresh** one is read, if the session started with one                                                                                          | same                                                             |
| Plan Claude wrote in plan mode               | **re-injected from disk**                                                                                                                         | same                                                             |
| `paths:`-scoped rules                        | reloaded on demand (i.e. lost until re-triggered)                                                                                                 | same                                                             |
| Nested CLAUDE.md                             | reloaded on demand                                                                                                                                | same                                                             |
| Files Claude read/edited                     | **up to five re-read**, most recently modified first; a file over 5,000 tokens comes back as a path reference (`Referenced file`) not its content | same                                                             |
| Invoked skill bodies                         | re-injected, capped at **5,000 tokens per skill** / **25,000 total**, oldest dropped first, truncation keeps the **start**                        | same                                                             |
| Background commands and background subagents | **keep running**; Claude is reminded which ones so it doesn't duplicate                                                                           | same                                                             |
| Context added by hooks earlier               | summarized with the rest                                                                                                                          | same                                                             |
| `SessionStart` hooks matching `compact`      | run, output added to the compacted context                                                                                                        | same                                                             |

Triggers and knobs: automatic near the limit; `/compact [focus instructions]` to steer the summary;
`/autocompact <tokens>` (e.g. `500k`) to move the threshold; `/rewind` → "Summarize from here" /
"Summarize up to here"; `/clear` between unrelated tasks; delegate big reads to subagents.
The summarization request inherits the session's **extended thinking** setting (v2.1.198+).
(<https://code.claude.com/docs/en/context-window>)

Prompt-caching consequences the docs call out: a **model switch forces a slow uncached turn**;
CLAUDE.md edits don't apply mid-session; `/compact` has a cost; subagents can keep the parent's
warmed cache. (<https://code.claude.com/docs/en/prompt-caching>)

---

## 7. Checkpoints, background tasks, task lists, plan mode

### 7.1 Checkpoints / rewind

| Aspect         | Exact                                                                                                                                        | Source                                                         |
| :------------- | :------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------- |
| Trigger        | automatically before each prompt that starts a turn                                                                                          | [checkpointing](https://code.claude.com/docs/en/checkpointing) |
| Coverage       | changes made by Claude's **file editing tools** only                                                                                         | same                                                           |
| Retention      | snapshots for the **100 most recent** checkpoints per session; stored with the conversation, so `/rewind` works after resume                 | same                                                           |
| Entry points   | `/rewind`, or `Esc` `Esc` when the prompt input is empty                                                                                     | same                                                           |
| Actions        | Restore code **and** conversation · Restore conversation · Restore code · Summarize from here · Summarize up to here · Never mind            | same                                                           |
| Guidance       | type instructions next to a Summarize row ("add context (optional)") to steer the summary                                                    | same                                                           |
| Cross-`/clear` | the menu gains a `/resume <session-id> (previous session)` entry until you exit or resume another session                                    | same                                                           |
| Not covered    | Bash-command changes, subagent edits, external changes, messages sent mid-turn, symlinks/hard links; "not a replacement for version control" | same                                                           |
| Failure mode   | if snapshots were swept (`cleanupPeriodDays`, ~30 d), rewinding can fail with `No files were restored`                                       | same                                                           |

### 7.2 Background tasks

| Aspect               | Exact                                                                                                                                                                            | Source                                                               |
| :------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------- |
| Trigger              | Claude asks for a background run, or **Ctrl+B** moves a running Bash invocation to the background (tmux: press twice)                                                            | [interactive-mode](https://code.claude.com/docs/en/interactive-mode) |
| Handle               | a background **task ID** returned immediately                                                                                                                                    | same                                                                 |
| Output               | written to a **file** Claude retrieves with Read                                                                                                                                 | same                                                                 |
| Timeout              | a command that hits its timeout is **auto-moved to the background** instead of dying — **except** commands starting with `sleep`                                                 | same                                                                 |
| Limits               | terminated if output exceeds **5 GB**; local sessions have **no time limit**; unattended sessions (`-p`, cloud) stop at a background time limit                                  | same                                                                 |
| Lifecycle            | cleaned up when Claude Code exits (including `setsid`/`timeout` descendants); survive if the session is merely backgrounded                                                      | same                                                                 |
| Memory pressure      | on macOS/Linux, tasks are stopped under critical memory pressure if the session has been idle ≥ 30 min and no turn/subagent runs; `CLAUDE_CODE_DISABLE_BG_SHELL_PRESSURE_REAP=1` | same                                                                 |
| Subagent interaction | a background command started by a **foreground** subagent ends when that subagent's run ends                                                                                     | same                                                                 |
| Kill switch          | `CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1` (also removes Ctrl+B, background skills, and makes Claude wait for subagents)                                                           | same                                                                 |

### 7.3 Task lists (`TodoWrite` vs the Task tools)

| Tool                                                 | Status                                                                                                                                                                                                                                                                                            | Source                                                             |
| :--------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :----------------------------------------------------------------- |
| `TodoWrite`                                          | "manages the session task checklist"; **disabled by default in favor of** `TaskCreate`/`TaskGet`/`TaskList`/`TaskUpdate`; re-enable with `CLAUDE_CODE_ENABLE_TASKS=0`                                                                                                                             | [tools-reference](https://code.claude.com/docs/en/tools-reference) |
| `TaskCreate` / `TaskGet` / `TaskUpdate` / `TaskList` | default task-tracking set where the tools are available                                                                                                                                                                                                                                           | [tools-reference](https://code.claude.com/docs/en/tools-reference) |
| Model gating                                         | task tools are on **by default only on Opus 4.7, Sonnet 4.6, Haiku 4.5 and earlier**. On newer models Claude Code **omits them** — stated reason: "On newer models, Claude keeps track of multi-step work without a written checklist, and the tools' definitions and reminders take up context." | [tools-reference](https://code.claude.com/docs/en/tools-reference) |
| Opt-in on other models                               | `CLAUDE_CODE_ENABLE_TODO_TOOLS=1`, or naming a tool in `--allowedTools`, or `--tools`; SDK: `allowedTools` / `tools`                                                                                                                                                                              | [tools-reference](https://code.claude.com/docs/en/tools-reference) |
| Always present                                       | background sessions and cloud sessions provide the tools on every model                                                                                                                                                                                                                           | [tools-reference](https://code.claude.com/docs/en/tools-reference) |
| Subagents/teammates                                  | a subagent gets them only if the session has them; an in-process teammate likewise; a split-pane teammate inherits `--tools` and deny rules, **not** `--allowedTools`                                                                                                                             | [tools-reference](https://code.claude.com/docs/en/tools-reference) |

That model-gated removal is a notable design choice: the harness _drops_ its own scaffolding, with
context cost as the stated reason. (<https://code.claude.com/docs/en/tools-reference>)

### 7.4 Plan mode

| Aspect                | Exact                                                                                                                                                                                                                                                                               | Source                                                               |
| :-------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------- |
| Entry                 | `Shift+Tab`, `/plan` (single prompt), or `claude --permission-mode plan`; `defaultMode: "plan"` for a project default                                                                                                                                                               | [permission-modes](https://code.claude.com/docs/en/permission-modes) |
| Effect                | Claude researches, runs read-only shell, and **writes a plan**; source edits stay blocked until approval (except in interactive sessions where bypass permissions is available)                                                                                                     | same                                                                 |
| Shell during planning | interactive + bypass available → neither classifier nor prompt; else auto mode available and `useAutoModeDuringPlan` on (default) → classifier reviews commands; else anything outside the read-only set **prompts**                                                                | same                                                                 |
| Approval              | `ExitPlanMode` tool presents the plan; options: _Yes, and use auto mode_ (or _auto-accept edits_ / _switch to BYPASS_) · _Yes, manually approve edits_ · _No, keep planning_; `Ctrl+G` opens the plan in `$EDITOR`; `showClearContextOnPlanAccept` adds an approve-and-clear option | same                                                                 |
| Exit                  | approving exits plan mode **into the chosen permission mode**; `Shift+Tab` again exits without approving                                                                                                                                                                            | same                                                                 |
| Hook interaction      | a `PreToolUse` `"allow"` cannot approve a non-read-only call in plan mode; `ExitPlanMode` + `updatedInput` still runs                                                                                                                                                               | [permissions](https://code.claude.com/docs/en/permissions)           |
| Compaction            | the plan is **re-injected from disk** after compaction                                                                                                                                                                                                                              | [context-window](https://code.claude.com/docs/en/context-window)     |
| Prompt delta          | **[unverified]** — the docs do not publish what plan mode adds to the system prompt. What is documented is the tool-level contract (`ExitPlanMode`), read-only enforcement, and plan persistence. Anything about a specific plan-mode prompt section would be inference.            | —                                                                    |

---

## 8. Permissions and sandboxing

### 8.1 Modes

| Mode (config value)                                         | Runs without asking                                                                      | Notes                                                                                                                            | Source                                                               |
| :---------------------------------------------------------- | :--------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------- |
| `default` (UI name: **Manual**, `manual` accepted as alias) | reads only                                                                               | `manual` is accepted anywhere the value is typed                                                                                 | [permission-modes](https://code.claude.com/docs/en/permission-modes) |
| `acceptEdits`                                               | reads, file edits, common filesystem commands (`mkdir`, `touch`, `mv`, `cp`, …)          |                                                                                                                                  | same                                                                 |
| `plan`                                                      | reads + classifier-approved commands when auto mode is available                         |                                                                                                                                  | same                                                                 |
| `auto`                                                      | everything, with background classifier checks                                            |                                                                                                                                  | same                                                                 |
| `dontAsk`                                                   | reads inside working dirs + pre-approved tools; anything that would prompt is **denied** | `AskUserQuestion`, `requiresUserInteraction` MCP tools, network-path reads, org-`ask` connector tools are denied even if allowed | same                                                                 |
| `bypassPermissions`                                         | everything                                                                               | warn: isolated containers/VMs only; allow rules have **no effect**; deny rules still block                                       | same                                                                 |

Cross-cutting rules stated in the docs: **writes to protected paths are never auto-approved** except
under `bypassPermissions` (and plan-mode sessions where bypass is available); modes set the baseline
and rules layer on top; **deny rules block in every mode**; deny/ask rules never apply to
`EndConversation` while any other tool remains. (<https://code.claude.com/docs/en/permission-modes>)

### 8.2 Rule syntax

Format: `Tool` or `Tool(specifier)`; parentheses inside the specifier are literal.
(<https://code.claude.com/docs/en/permissions>)

| Form                            | Matches                                                                                                                                                | Source                                                     |
| :------------------------------ | :----------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------- |
| `Bash`                          | all Bash calls (deny form removes the tool from context)                                                                                               | [permissions](https://code.claude.com/docs/en/permissions) |
| `Bash(*)`                       | equivalent to `Bash`                                                                                                                                   | same                                                       |
| `Bash(npm run build)`           | exactly that command                                                                                                                                   | same                                                       |
| `Bash(git log *)`               | prefix family; `*` matches any text **including spaces**                                                                                               | same                                                       |
| `Read(./.env)`                  | that path                                                                                                                                              | same                                                       |
| `WebFetch(domain:example.com)`  | that domain                                                                                                                                            | same                                                       |
| `Tool(param:value)`             | a **top-level input parameter**, exact value; `*` allowed as a value wildcard — **deny and ask rules only**, allow rules use each tool's own specifier | same                                                       |
| `Skill(name)` / `Skill(name *)` | exact / prefix skill invocation                                                                                                                        | [skills](https://code.claude.com/docs/en/skills)           |
| `Agent(model:opus)`             | Agent calls requesting that model tier                                                                                                                 | [permissions](https://code.claude.com/docs/en/permissions) |

Documented hazards to preserve:

- **Wildcard placement is a security property.** `Bash(git log *)` limits to `git log`; `Bash(git *)`
  allows every git command. Claude Code **warns at startup** about an allow rule with `*` before the
  subcommand (`Bash(git * main)`).
- **Primary content fields can't be parameter-matched** — `command`, `file_path`, `path`,
  `notebook_path`, `url` are rejected for `Tool(param:)` because a compound command would bypass it;
  the docs require `Bash(rm *)` instead.
- A `mcp__` rule **with parentheses** in a settings file is **skipped** (invalid-settings dialog),
  because parameter matching on MCP tools is only available through `--disallowedTools`.
- A parameter the model omits is never matched; values compare literally before normalization
  (`Agent(model:opus)` matches the alias, not a full ID).
- Rule labels must be **canonical tool names**: `Stop Task` doesn't match; it's `TaskStop`.

(<https://code.claude.com/docs/en/permissions>)

Precedence: **deny → ask → allow**, with deny winning globally; hook `allow` does not override deny
or ask; a blocking hook (exit 2) beats an allow rule.
(<https://code.claude.com/docs/en/permissions>)

Working directories: `permissions.additionalDirectories` and `--add-dir` grant **file access, not
configuration** — an added directory does not contribute skills/commands/agents unless
`project` settings sources are enabled for it; `permissions.blockReadsOutsideWorkingDirectories`
gates file-tool reads/writes; `/cd` moves the session.
(<https://code.claude.com/docs/en/permissions>)

### 8.3 Sandbox

Primary source: <https://code.claude.com/docs/en/sandboxing>. Comparison of isolation options:
<https://code.claude.com/docs/en/sandbox-environments>

| Aspect                | Exact                                                                                                                                                                                                                                                                                                           | Source                                                   |
| :-------------------- | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------- |
| Default               | **off**; enable with `/sandbox` or `sandbox.enabled: true`                                                                                                                                                                                                                                                      | [sandboxing](https://code.claude.com/docs/en/sandboxing) |
| Implementation        | macOS **Seatbelt**; Linux/WSL2 **bubblewrap + socat** (+ seccomp filter, `ripgrep`); built on the open-source `@anthropic-ai/sandbox-runtime`                                                                                                                                                                   | same                                                     |
| Writes                | working directory, a per-user temp directory, directories you added; **protected paths stay write-denied**                                                                                                                                                                                                      | same                                                     |
| Reads                 | most of the machine, **including `~/.ssh` and `~/.aws/credentials`** — restricting reads is opt-in via `filesystem.denyRead` / `credentials`                                                                                                                                                                    | same                                                     |
| Network               | no direct route; all connections via a local proxy that checks each host against `network.allowedDomains`, which **starts empty**                                                                                                                                                                               | same                                                     |
| Env vars              | inherited from Claude Code, including secrets, unless scrubbed                                                                                                                                                                                                                                                  | same                                                     |
| Outside the sandbox   | built-in file/web tools (they follow permission rules instead), command hooks, local MCP servers, plugin monitors, LSP servers, status line, `apiKeyHelper`, `!` shell-mode commands (most sessions), `excludedCommands`, unsandboxed retries                                                                   | same                                                     |
| Modes                 | **auto-allow** (sandboxed command approved with no prompt) vs **regular** (all Bash goes through permissions even when sandboxed)                                                                                                                                                                               | same                                                     |
| Auto-allow exceptions | Bash deny-rule matches still block; `rm`/`rmdir` on a **critical path** still goes through the normal flow; content-scoped ask rules (`Bash(git push *)`) still prompt; a bare `Bash` ask rule is skipped for sandboxed commands but not in plan mode; Monitor-tool commands are never auto-approved            | same                                                     |
| Escape hatch          | Claude may retry with `dangerouslyDisableSandbox` after a sandbox failure (the denied host is named in the result so Claude sees it). Approval differs by mode; `dontAsk` denies it; a matching allow rule also approves the retry; ask rule on `Bash(dangerouslyDisableSandbox:true)` catches it in every mode | same                                                     |
| Strict mode           | `"allowUnsandboxedCommands": false` ignores `dangerouslyDisableSandbox`; `failIfUnavailable` makes a sandbox-start failure fatal                                                                                                                                                                                | same                                                     |
| Credential protection | `credentials` settings can mask env vars, re-sign AWS requests, and mask credential files                                                                                                                                                                                                                       | same                                                     |

Design rationale (stated by consequence): auto-allow mode is _"independent of your permission
mode"_ — sandboxed Bash runs automatically even in Manual mode, because the boundary, not the
prompt, is doing the work. The read default (most of the machine) is deliberately permissive; the
write and network defaults are the tight ones.
(<https://code.claude.com/docs/en/sandboxing>)

---

## 9. MCP

Primary source: <https://code.claude.com/docs/en/mcp>. Quickstart:
<https://code.claude.com/docs/en/mcp-quickstart>

### 9.1 Transports and configuration scopes

| Transport                    | How                                                                                                           | Source                                     |
| :--------------------------- | :------------------------------------------------------------------------------------------------------------ | :----------------------------------------- |
| `http` (remote, recommended) | `claude mcp add --transport http <name> <url>`                                                                | [mcp](https://code.claude.com/docs/en/mcp) |
| `sse` (remote, legacy)       | `--transport sse`                                                                                             | same                                       |
| `ws` (remote WebSocket)      | `--transport ws`                                                                                              | same                                       |
| `stdio` (local)              | `claude mcp add <name> -- <command> [args...]`; Claude Code stops the server per its documented teardown rule | same                                       |

| Scope     | Storage                       | Reach                                                     | Source                                     |
| :-------- | :---------------------------- | :-------------------------------------------------------- | :----------------------------------------- |
| `local`   | `~/.claude.json`, per project | you, this project                                         | [mcp](https://code.claude.com/docs/en/mcp) |
| `project` | `.mcp.json` at the repo root  | committable, whole team (first use needs workspace trust) | same                                       |
| `user`    | `~/.claude.json`, global      | you, all projects                                         | same                                       |

Precedence: local > project > user, by server name. Env expansion in `.mcp.json` supports `${VAR}`
and `${VAR:-default}`; unset-without-default and empty-string cases have documented behavior, and
resolved/unresolved references are shown in `/mcp` and CLI output.
(<https://code.claude.com/docs/en/mcp>)

Plugin-provided servers are scoped as `mcp__plugin_<plugin-name>_<server-name>__<tool>`, which is
also what hook matchers must target. (<https://code.claude.com/docs/en/mcp>)

### 9.2 Tool search / lazy loading (the context lever)

| Aspect              | Exact                                                                                                                                                                                                                 | Source                                     |
| :------------------ | :-------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :----------------------------------------- |
| Default             | **on** — MCP tools are deferred and discovered on demand                                                                                                                                                              | [mcp](https://code.claude.com/docs/en/mcp) |
| What loads at start | **tool names + server instructions** only                                                                                                                                                                             | same                                       |
| No fixed cap        | "Claude Code doesn't impose a fixed per-server tool cap; the practical limit is your context window budget"                                                                                                           | same                                       |
| Description limits  | **4,096 chars** for server instructions and for any tool that loads upfront; **16,384 chars** for a tool loaded through tool search; `CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH` sets **both** to one number (v2.1.280+) | same                                       |
| Per-tool override   | `_meta["anthropic/alwaysLoad"]` = `true` (load upfront) / `false` (stay deferred — only effective when the server arrives via `--mcp-config`, SDK, or a plugin)                                                       | same                                       |
| Per-server override | `alwaysLoad` / `defer` on the server config; `ENABLE_TOOL_SEARCH=auto` has a size threshold below which tools stay deferred                                                                                           | same                                       |
| Config switch       | `ENABLE_TOOL_SEARCH`                                                                                                                                                                                                  | same                                       |
| Known gap           | not supported on Microsoft Foundry-on-Azure; Claude Code detects the rejection and loads tools upfront (the variable cannot override)                                                                                 | same                                       |

Rationale (stated): _"Tool search keeps MCP context usage low by deferring tool definitions until
Claude needs them… adding more MCP servers has minimal impact on your context window."_
(<https://code.claude.com/docs/en/mcp>)

### 9.3 Elicitation, resources, prompts

| Capability                 | Exact                                                                                                                                                                                                                   | Source                                         |
| :------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------- |
| Elicitation modes          | **form** (server-defined fields) and **url** (open a link; the URL is passed to the OS handler and capped — ~8,000 chars with no escapes, ~4,000 for heavily percent-escaped URLs, because each escaped char counts ×4) | [mcp](https://code.claude.com/docs/en/mcp)     |
| Declared client capability | `elicitation: {form: {}, url: {}}` on protocol revision 2026-07-28 and, from v2.1.287, on older revisions for stdio/sse/http/ws servers in the user's own config; elsewhere bare `elicitation: {}` = form-only          | same                                           |
| Auto-answering             | the `Elicitation` / `ElicitationResult` hooks                                                                                                                                                                           | [hooks](https://code.claude.com/docs/en/hooks) |
| Resources                  | `@` typeahead lists them; reference as `@server:protocol://resource/path`                                                                                                                                               | [mcp](https://code.claude.com/docs/en/mcp)     |
| Prompts as commands        | `/servername:promptname (MCP)` in the menu, or `/mcp__servername__promptname`; arguments split on whitespace; result injected into the conversation                                                                     | same                                           |
| Output limits              | MCP results have a size ceiling with a per-tool override, and a Bash-style spill to a file                                                                                                                              | same                                           |
| Tool metadata              | `requiresUserInteraction` forces a prompt even on a hook `allow`; tools can be marked safe-to-retry; names longer than **128 chars** and root-level `anyOf`/`oneOf` schemas have documented handling                    | same                                           |
| Server-side tasks          | long MCP calls can become server tasks with status messages, stop/result, and "make Claude wait" semantics                                                                                                              | same                                           |
| Claude Code as MCP server  | yes, documented, including reading a background command's output as an MCP client                                                                                                                                       | same                                           |

---

## 10. Output styles, status line, model routing, cost, telemetry

### 10.1 Output styles

Source: <https://code.claude.com/docs/en/output-styles>

| Aspect          | Exact                                                                                                                                                                      |
| :-------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Built-ins       | `Default` (no style instructions), `Proactive`, `Concise`, `Explanatory`, `Learning`                                                                                       |
| Custom location | `~/.claude/output-styles/`, `.claude/output-styles/` (every nested `.claude/output-styles` up to the repo root; closest wins), managed dir, or a plugin's `output-styles/` |
| Frontmatter     | `name`, `description`, `keep-coding-instructions`, `force-for-plugin` (plugin only)                                                                                        |
| Key semantics   | `keep-coding-instructions: true` keeps Claude Code's built-in software-engineering section; leaving it out **removes** that section from the full system prompt            |
| Injection       | the active style's instructions are sent **with every request**; applies to the main conversation and to forks, not to other subagents                                     |
| Switch          | `/output-style <name>` or `/config`; takes effect on the next message; edited files need a restart                                                                         |

Design note (stated): "An output style gives Claude instructions to follow. It doesn't guarantee
that something always happens or never happens" — for guarantees the docs redirect to hooks.

### 10.2 Status line

Source: <https://code.claude.com/docs/en/statusline>

| Aspect          | Exact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| :-------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Config          | `statusLine: {type: "command", command, padding, refreshInterval}` in user or project settings                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Contract        | Claude Code runs the command, passes **JSON on stdin**, renders **stdout** (multi-line = multi-row), sets `COLUMNS`/`LINES`                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Update triggers | session start; new assistant message; `/compact` finish; permission-mode change; vim-mode toggle; `command` change; `refreshInterval`; rate-limit `resets_at`; cache `expires_at`                                                                                                                                                                                                                                                                                                                                                                                    |
| Debounce        | **300 ms**; a changed `command` bypasses it; an in-flight script is cancelled by a newer update                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Cost            | "runs locally and does not consume API tokens"                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Notable fields  | `model.*`, `cwd`, `workspace.project_dir`, `workspace.added_dirs`, `workspace.git_worktree`, `workspace.repo.{host,owner,name}`, `cost.total_cost_usd`, `cost.total_duration_ms`, `cost.total_api_duration_ms`, `context_window.*` (size, used/remaining %, `current_usage`), `exceeds_200k_tokens`, `rate_limits.{five_hour,seven_day,spend_limit}.*`, `prompt_cache.*`, `session_id`, `session_name`, `prompt_id`, `version`, `output_style.name`, `vim.mode`, `effort.level`, `thinking.enabled`, `pr.{number,url,review_state,kind}`, `worktree.*`, `agent.name` |
| Notifications   | `terminalSequence` shares the status-line row with hook notifications                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

### 10.3 Model routing

Sources: <https://code.claude.com/docs/en/model-config>, <https://code.claude.com/docs/en/sub-agents>

| Capability              | Exact                                                                                                                                                                                                         | Source                                                                   |
| :---------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | :----------------------------------------------------------------------- |
| Aliases                 | `default`, `best`, `fable`, `sonnet`, `opus`, `haiku`, `sonnet[1m]`, `opus[1m]`, `opusplan`                                                                                                                   | [model-config](https://code.claude.com/docs/en/model-config)             |
| `opusplan`              | Opus during plan mode, then **Sonnet for execution**                                                                                                                                                          | same                                                                     |
| Per-agent model         | subagent `model:` field; `CLAUDE_CODE_SUBAGENT_MODEL` for the default; "run every subagent on one model" override                                                                                             | [sub-agents](https://code.claude.com/docs/en/sub-agents)                 |
| Skill-scoped model      | skill `model:` for the rest of the turn; with `context: fork` it sets the **fork's** model                                                                                                                    | [skills](https://code.claude.com/docs/en/skills)                         |
| Effort resolution order | 1) `CLAUDE_CODE_EFFORT_LEVEL` 2) in-session pick 3) `--effort` 4) settings (`modelSettings` per model / `effortLevel`) 5) model default (`high`, except Opus/Sonnet/Haiku 5.5 = `medium`, Opus 4.7 = `xhigh`) | [model-config](https://code.claude.com/docs/en/model-config)             |
| Effort fallback         | an unsupported level falls back to the highest supported level at or below it (`xhigh`→`high` on Opus 4.6)                                                                                                    | same                                                                     |
| Effort persistence      | `Enter` saves as default; `s` applies to this session only (v2.1.257+); `max` is session-only unless set via the env var; saved per model under `modelSettings`                                               | same                                                                     |
| Fallback chain          | `fallbackModel` (ordered; taken whole from the highest-precedence file) + automatic model fallback with effort rules, ask-before-switching, and Bedrock/Vertex/Foundry support                                | same                                                                     |
| Restriction             | `availableModels` / `deniedModels` allowlist+denylist; `enforceAvailableModels`; a managed `model` is a **starting default, not a lock**                                                                      | [settings](https://code.claude.com/docs/en/settings)                     |
| Ultracode               | `/effort ultracode` or `"ultracode": true` → Claude orchestrates **dynamic workflows** at the session's effort; `--effort ultracode` also sets `xhigh`                                                        | [model-config](https://code.claude.com/docs/en/model-config)             |
| Advisor                 | a stronger "advisor" model consulted at key moments (`advisorModel`)                                                                                                                                          | [settings-reference](https://code.claude.com/docs/en/settings-reference) |

### 10.4 Cost and usage display

Sources: <https://code.claude.com/docs/en/costs>, <https://code.claude.com/docs/en/statusline>

| Surface                | What it shows                                                                                                                                                              | Details                                                                                                                                                              |
| :--------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/usage` Session block | total cost USD, API duration, wall duration, lines added/removed, per-model input/output/cache read/cache write                                                            | computed **client-side at list price** unless a `modelPricing` table is in effect, in which case `Total cost` is annotated `at your organization's configured rates` |
| Reset behavior         | totals reset when `/clear` starts a new session                                                                                                                            | v2.1.211+                                                                                                                                                            |
| Data-residency         | a 1.1× rate is applied to that response's tokens and also counts toward `--max-budget-usd`                                                                                 |                                                                                                                                                                      |
| Spinner token count    | `… (10m 27s · ↓ 5.5k tokens)` = **output produced this turn** (text, tool calls, thinking, foreground subagent output); excludes input; resets each turn and on compaction |                                                                                                                                                                      |
| Status line            | `cost.total_cost_usd`, `cost.total_duration_ms`, `cost.total_api_duration_ms`, `cost.total_lines_added/removed`                                                            |                                                                                                                                                                      |
| Plan usage             | `/usage` shows plan bars, a 7-day breakdown, and (v2.1.305+) recommendations; `/doctor` can apply some                                                                     |                                                                                                                                                                      |

### 10.5 Telemetry / OpenTelemetry

Source: <https://code.claude.com/docs/en/monitoring-usage>

| Aspect                | Exact                                                                                                                                                                                                                                                             |
| :-------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Enable                | `CLAUDE_CODE_ENABLE_TELEMETRY=1`                                                                                                                                                                                                                                  |
| Exporters             | `OTEL_METRICS_EXPORTER` ∈ `otlp\|prometheus\|console\|none`; `OTEL_LOGS_EXPORTER` ∈ `otlp\|console\|none`                                                                                                                                                         |
| Endpoint / protocol   | `OTEL_EXPORTER_OTLP_ENDPOINT`, `OTEL_EXPORTER_OTLP_PROTOCOL`, `OTEL_EXPORTER_OTLP_HEADERS`; mTLS supported                                                                                                                                                        |
| Intervals             | `OTEL_METRIC_EXPORT_INTERVAL` (default 60000 ms), `OTEL_LOGS_EXPORT_INTERVAL` (default 5000 ms)                                                                                                                                                                   |
| Verification          | look for `claude_code.session.count` (metrics) or `claude_code.user_prompt` (logs); `[3P telemetry]` prefixes export failures                                                                                                                                     |
| Metrics               | `claude_code.session.count`, `.lines_of_code.count`, `.pull_request.count`, `.commit.count`, `.cost.usage` (USD), `.token.usage`, `.code_edit_tool.decision`, `.active_time.total` (s)                                                                            |
| Standard attributes   | `session.id`, `app.version`, `app.entrypoint`, `organization.id`, `user.account_uuid`, `user.account_id`, `user.id` (local random, in `~/.claude.json`), `user.email`, `terminal.type`, `OTEL_RESOURCE_ATTRIBUTES`, `vcs.*` (opt-in, v2.1.269+), `ccr.session.id` |
| Event-only attributes | `prompt.id` (correlates a prompt with all following events), `workspace.host_paths`, `workflow.run_id` + `workflow.name`, `agent_id` + `parent_agent_id` (v2.1.310+)                                                                                              |
| Traces                | **beta** — span hierarchy with span attributes                                                                                                                                                                                                                    |
| Cardinality           | `OTEL_LOG_TOOL_DETAILS`, per-attribute include flags, metric cardinality controls                                                                                                                                                                                 |
| Admin                 | fully configurable through managed settings `env`; the OTLP destination can be locked by managed settings                                                                                                                                                         |
| Redaction             | for tool details: `skill.name` is reported verbatim only for built-in/bundled/user/official-marketplace plugins, otherwise `"third-party"`                                                                                                                        |

---

## 11. Settings

Sources: <https://code.claude.com/docs/en/settings>,
<https://code.claude.com/docs/en/settings-reference>,
<https://code.claude.com/docs/en/managed-settings>,
<https://code.claude.com/docs/en/env-vars>

### 11.1 Files and precedence

| Level          | File                                                                                              | Affects                                                                          |
| :------------- | :------------------------------------------------------------------------------------------------ | :------------------------------------------------------------------------------- |
| Managed        | `managed-settings.json` (per-OS system dir), MDM profile, server-managed settings, gateway policy | everyone deployed to                                                             |
| Command line   | `--settings <file-or-json>`                                                                       | this session                                                                     |
| Project local  | `.claude/settings.local.json`                                                                     | you, this project (auto-added to global git excludes when Claude Code writes it) |
| Shared project | `.claude/settings.json`                                                                           | everyone in the folder / the clone                                               |
| User           | `~/.claude/settings.json`                                                                         | you, all projects                                                                |

Order, highest first: **managed → command line → project local → shared project → user**.
Lists **merge** rather than override (`permissions.allow` from several files combines). Four
exceptions to list-merging: `fallbackModel` (ordered, taken whole), `modelPicker` (whole value from
highest of managed/`--settings`/user; project+local ignored), `availableModels` (managed value
applies as-is and non-managed additions are ignored), `modelSettings` (resolved per model).
(<https://code.claude.com/docs/en/settings>)

Environment variables are **not a level in this stack**. When a behavior has both a shell variable
and a settings key, which wins is decided **per pair**: `ANTHROPIC_MODEL` overrides `model` from any
file, while `ANTHROPIC_DEFAULT_MODEL` applies only when no file sets `model`. An `env` block in a
settings file is an ordinary key and follows the levels.
(<https://code.claude.com/docs/en/settings>, <https://code.claude.com/docs/en/env-vars>)

A documented nuance worth copying: for a few security-sensitive keys, Claude Code honors a **stricter
value from a lower level** over a managed value — the "Exceptions to managed settings precedence"
section. (<https://code.claude.com/docs/en/settings>)

### 11.2 Managed settings delivery

| Mechanism      | Where                                                                                                                                                                                  | Notes                                                                        |
| :------------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | :--------------------------------------------------------------------------- |
| File           | macOS `/Library/Application Support/ClaudeCode/managed-settings.json`; Linux/WSL `/etc/claude-code/managed-settings.json`; Windows `C:\Program Files\ClaudeCode\managed-settings.json` | endpoint-managed                                                             |
| MDM            | OS policy channel                                                                                                                                                                      | endpoint-managed; Windows inherits into WSL via `wslInheritsWindowsSettings` |
| Server-managed | fetched from the claude.ai console                                                                                                                                                     | reaches cloud sessions; the only mechanism that does                         |
| Gateway        | per IdP group                                                                                                                                                                          | the only mechanism with per-group targeting today                            |
| Helper program | `policyHelper`, `managedSourcesBehavior`                                                                                                                                               | computed policy                                                              |

When several mechanisms are present, Claude Code by default uses **one** and ignores the others, with
a documented combination order and an opt-in to apply every source.
(<https://code.claude.com/docs/en/managed-settings>)

"Permission rule files" in the sense Moss may be looking for do not exist as a separate artifact:
permission rules live **inside** `settings.json` under `permissions.{allow,ask,deny,additionalDirectories}`
plus the mode/`defaultMode` keys, and are merged across levels. The only separate rule _files_ are
`.claude/rules/*.md`, which are **instructions** (memory), not permissions. Org-level restriction
knobs that substitute for rule files: `allowManagedPermissionRulesOnly`,
`allowManagedHooksOnly`, `strictPluginOnlyCustomization`, `disableBypassPermissionsMode`,
`enabledPlugins`, `availableModels`, `strictKnownMarketplaces` / `blockedMarketplaces`.
(<https://code.claude.com/docs/en/settings>,
<https://code.claude.com/docs/en/managed-settings>,
<https://code.claude.com/docs/en/permissions>)

### 11.3 Settings surface size

`settings-reference` documents the full key list (hundreds of keys, grouped as Model and responses /
Interface / Permissions and sandboxing / …), with per-key Scope and override notes. Env vars get a
parallel reference. Notable keys an implementer will care about: `permissions`,
`defaultMode`, `disableBypassPermissionsMode`, `allowManagedPermissionRulesOnly`,
`allowManagedHooksOnly`, `disableAllHooks`, `allowedHttpHookUrls`, `httpHookAllowedEnvVars`,
`sandbox.*` (`enabled`, `failIfUnavailable`, `bwrapPath`, `filesystem.*`, `network.*`,
`credentials`), `statusLine`, `subagentStatusLine`, `outputStyle`, `modelSettings`, `effortLevel`,
`fallbackModel`, `availableModels`, `deniedModels`, `modelPricing`, `enabledPlugins`,
`extraKnownMarketplaces`, `skillOverrides`, `skillListingBudgetFraction`,
`skillListingMaxDescChars`, `disableBundledSkills`, `autoMemoryEnabled`, `autoMemoryDirectory`,
`claudeMdExcludes`, `includeGitInstructions`, `cleanupPeriodDays`, `autoCompactWindow`,
`useAutoModeDuringPlan`, `respondToBashCommands`, `pluginTrustMessage`, `ultracode`.
(<https://code.claude.com/docs/en/settings-reference>)

---

## 12. Multi-agent surface (teams, workflows, agent view)

### 12.1 The four ways to run more than one agent

| Feature           | What it is                           | Who decides what runs next | Where intermediate results live | Scale                           | Source                                                 |
| :---------------- | :----------------------------------- | :------------------------- | :------------------------------ | :------------------------------ | :----------------------------------------------------- |
| Subagents         | a worker Claude spawns               | Claude, turn by turn       | Claude's context                | a few per turn                  | [workflows](https://code.claude.com/docs/en/workflows) |
| Skills            | instructions Claude follows          | Claude                     | Claude's context                | same as subagents               | same                                                   |
| Agent teams       | a lead supervising peer sessions     | the lead, turn by turn     | a shared task list              | a handful of long-running peers | same                                                   |
| Dynamic workflows | a **JS script** the runtime executes | **the script**             | **script variables**            | **dozens to hundreds per run**  | same                                                   |

That table is the cleanest statement of Anthropic's own taxonomy and is worth copying wholesale.

### 12.2 Agent teams

**Experimental and disabled by default**: `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`.
(<https://code.claude.com/docs/en/agent-teams>)

| Component   | Mechanism                                                                                                                                                                                                                                   |
| :---------- | :------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Lead        | the main session                                                                                                                                                                                                                            |
| Teammates   | separate Claude Code instances, each with its own context; can be defined by subagent definitions                                                                                                                                           |
| Task list   | shared; teammates claim and complete items; dependencies unblock automatically                                                                                                                                                              |
| Mailbox     | `~/.claude/teams/{team-name}/inboxes/{agent-name}.json`; validated on read, malformed entries dropped                                                                                                                                       |
| Team config | `~/.claude/teams/{team-name}/config.json` — runtime state (session IDs, tmux panes), removed at session end, **must not be hand-edited**                                                                                                    |
| Task dir    | `~/.claude/tasks/{team-name}/` — persists after the session, governed by `cleanupPeriodDays`                                                                                                                                                |
| Team naming | `session-` + first 8 chars of the session ID                                                                                                                                                                                                |
| Spawn rule  | the Agent tool with a `name` creates a teammate, without user confirmation (unless it's a fork or passes `isolation`); Claude also names ordinary subagents, so teams can form unintentionally — there is a documented way to turn that off |
| Modes       | in-process vs split-pane (split-pane inherits `--tools` and deny rules, **not** `--allowedTools`)                                                                                                                                           |
| Hooks       | `TeammateIdle`, `TaskCreated`, `TaskCompleted` are the documented quality-gate points                                                                                                                                                       |
| Cost        | docs state teams use **significantly more tokens**; a dedicated "Agent team token costs" section exists in the cost docs                                                                                                                    |
| Limits      | documented limitations around session resumption, task coordination, and shutdown                                                                                                                                                           |

### 12.3 Dynamic workflows

A JavaScript script orchestrating many subagents, executed by a runtime **in the background** while
the session stays responsive. Available on paid plans, API, Bedrock, Vertex, Foundry. Saved scripts
live in `.claude/workflows/*.js`; plugins can ship them. Because the plan is code, the orchestration
is **repeatable** and **resumable in the same session**, and it can encode adversarial cross-review
(agents challenge each other's findings) rather than just parallelism.
Telemetry tags the run with `workflow.run_id` / `workflow.name`.
(<https://code.claude.com/docs/en/workflows>, <https://code.claude.com/docs/en/monitoring-usage>)

### 12.4 Agent view and cross-session messaging

`agent view` dispatches and monitors many sessions from one screen, showing what each is doing and
which need input; it can be entered from inside a session. Cross-session messaging lets Claude list
and message your other sessions on this machine or others, using the same `SendMessage` tool that
resumes subagents. (<https://code.claude.com/docs/en/agent-view>,
<https://code.claude.com/docs/en/cross-session-messaging>,
<https://code.claude.com/docs/en/sub-agents>)

---

## 13. Design rationale — what the docs actually justify

Only rows where the docs (or the engineering-adjacent docs pages) state a reason. Everything else in
this note is marked `[inferred]` inline.

| Decision                                                                 | Stated rationale                                                                                                                               | Source                                                               |
| :----------------------------------------------------------------------- | :--------------------------------------------------------------------------------------------------------------------------------------------- | :------------------------------------------------------------------- |
| Skill body loads only on use                                             | "Unlike CLAUDE.md content, a skill's body loads only when it's used, so long reference material costs almost nothing until you need it"        | [skills](https://code.claude.com/docs/en/skills)                     |
| `disable-model-invocation` exists                                        | side-effect workflows: "You don't want Claude deciding to deploy because your code looks ready"                                                | [skills](https://code.claude.com/docs/en/skills)                     |
| Skill listing budget = 1% of context                                     | overflow drops descriptions of the **least-invoked** skills, so popular ones keep their keywords                                               | [skills](https://code.claude.com/docs/en/skills)                     |
| Dynamic context injection runs before the model sees the skill           | so the response is "grounded in your actual working tree rather than what Claude can guess from open files"                                    | [skills](https://code.claude.com/docs/en/skills)                     |
| Injection never prompts                                                  | a deny rule aborts; anything not pre-approved aborts — keeps repo-committed skills from prompting                                              | [skills](https://code.claude.com/docs/en/skills)                     |
| Explore/Plan skip CLAUDE.md and git status                               | "to keep research fast and inexpensive"                                                                                                        | [sub-agents](https://code.claude.com/docs/en/sub-agents)             |
| Subagents are background by default                                      | keep the main conversation responsive; results arrive later                                                                                    | [sub-agents](https://code.claude.com/docs/en/sub-agents)             |
| Task tools removed on newer models                                       | "On newer models, Claude keeps track of multi-step work without a written checklist, and the tools' definitions and reminders take up context" | [tools-reference](https://code.claude.com/docs/en/tools-reference)   |
| MCP tool search on by default                                            | "keeps MCP context usage low… adding more MCP servers has minimal impact on your context window"                                               | [mcp](https://code.claude.com/docs/en/mcp)                           |
| External `@import` needs approval                                        | "to protect you from files other people commit to a shared project"                                                                            | [memory](https://code.claude.com/docs/en/memory)                     |
| Compaction re-injects CLAUDE.md / memory / plan / skills from disk       | they're derivable artifacts, so summarization can drop them and restore them cheaply                                                           | [context-window](https://code.claude.com/docs/en/context-window)     |
| Sandbox auto-allow works independently of permission mode                | the boundary replaces the prompt, cutting prompt fatigue without losing the guarantee                                                          | [sandboxing](https://code.claude.com/docs/en/sandboxing)             |
| Hook instead of instruction for guarantees                               | "Claude Code runs a hook every time its event occurs… whether or not Claude is following the skill"                                            | [skills](https://code.claude.com/docs/en/skills)                     |
| Marketplace reserved/impersonation names                                 | anti-spoofing: an official name from a non-`anthropics` source **stops loading**                                                               | [plugins/security](https://code.claude.com/docs/en/plugins/security) |
| Managed settings outrank everything                                      | compliance: security policy must beat personal config                                                                                          | [settings](https://code.claude.com/docs/en/settings)                 |
| Permission rules are deny-first and evaluated regardless of hook `allow` | preserves org deny rules as an absolute floor                                                                                                  | [permissions](https://code.claude.com/docs/en/permissions)           |
| Plan mode blocks edits                                                   | propose-then-approve; the plan is re-read from disk after compaction                                                                           | [permission-modes](https://code.claude.com/docs/en/permission-modes) |
| Workflows exist alongside teams                                          | "A workflow moves the plan into code… Claude's context holds only the final answer"                                                            | [workflows](https://code.claude.com/docs/en/workflows)               |
| Ultracode                                                                | decides _when_ to spend the extra tokens, rather than always                                                                                   | [model-config](https://code.claude.com/docs/en/model-config)         |

---

## 14. What a competing harness would need to copy vs. what is Claude-specific

### 14.1 Copy — mechanisms with no Claude dependency, where the design is the value

1. **Skill = directory + `SKILL.md`, three disclosure tiers, and an explicit listing budget.**
   The budget number matters more than the format: _1% of context window, 8,000-char fallback,
   1,536 chars per entry, drop descriptions least-invoked-first_. Any harness with a `skills/`
   directory and no budget will silently starve its own triggers.
2. **Merge slash commands into skills, then keep the legacy path working.** Two subsystems that do
   the same thing is the state Anthropic explicitly left behind. If Moss has `/commands` and skills
   as separate loaders, that's duplicated surface.
3. **`allowed-tools` as a turn-scoped, non-restricting pre-approval**, cleared on the next user
   message, with deny/ask rules overriding it and **no** prompting during render.
4. **Argument substitution with the exact edge semantics**: missing indexed placeholder stays
   literal, missing named placeholder becomes empty, unreferenced args appended as
   `ARGUMENTS: <value>`, args not re-scanned, `\$` escaping.
5. **Dynamic context injection (`` !`cmd` ``) that aborts the whole invocation on failure** and is
   permission-checked before running. The abort-on-failure rule is what makes it trustworthy.
6. **Hooks: `exit 2` = block, everything else = non-blocking, with a per-event block table.** Copy
   the table, not just the convention — "which events can block" is the actual contract. Copy the
   `exit 1` trap warning verbatim; it costs nothing and prevents a whole class of silent
   policy-bypass bugs.
7. **Hook matcher semantics**: exact-string vs unanchored-JS-regex decided by the _characters in the
   matcher_, `|`/`,` list forms, explicit warning that a matcher on a non-matcher event is silently
   ignored.
8. **`PreToolUse` four-outcome decision with `deny > defer > ask > allow` precedence**, plus
   `updatedInput` **replacing** the whole input object (and permission/auto-background decisions
   being evaluated against the replaced input).
9. **Hook output caps and spill behavior** (10,000 chars per string, 2,000-char preview, no knob).
   Uncapped hook output is an unbounded context injection vector.
10. **Subagent frontmatter with a per-agent `permissionMode` _and_ a documented precedence ladder
    against the main mode.** The ladder (bypass/acceptEdits/auto override; plan overrides all;
    `bypassPermissions` never escalates from a subagent) is the security-relevant part.
11. **"What loads at startup" as an explicit, written list** — own system prompt, delegation
    message, CLAUDE.md hierarchy, git status, preloaded skills, sibling roster — plus the exclusion
    list (output style, auto memory, parent window size). Cheap to implement, very hard to guess.
12. **Concurrency cap (20) + no total cap + resumes bypassing the cap**, and the rule that an agent
    message is never user approval and can never change permissions/config.
13. **Compaction survival table.** Copy the _categories_: re-inject-from-disk (CLAUDE.md, memory,
    plan, skill listing), re-read-recent-files (5, most recently modified, >5k tokens → path only),
    re-attach-skill-bodies (5k/skill, 25k total, newest first, keep the head).
14. **Checkpoint = snapshot before each turn-starting prompt, 100 deep, with `restore code`,
    `restore conversation`, and `summarize from/up to here` as separate actions**, plus an explicit
    non-coverage list. The four-way separation (code vs conversation vs summary vs both) is the
    useful part.
15. **Background task handle = ID + output file**, timeout auto-promotes to background (except
    `sleep`), 5 GB cap, cleanup on exit.
16. **Sandbox as a separate boundary from permissions**, with writes-tight / reads-loose / network
    via allowlisted proxy, and auto-allow independent of the permission mode.
17. **MCP tool search on by default**, names + server instructions only at startup, per-tool
    `alwaysLoad` opt-out, and different description length limits for deferred vs upfront tools.
18. **Permission rule syntax hazards as first-class warnings**: wildcard placement, parameter
    matching limited to deny/ask and to non-primary fields, canonical tool names only.
19. **Marketplace identity defense** (reserved names, impersonation check by _source_, alternate
    spellings, integrity pins).
20. **Settings precedence with list-merge semantics and per-pair env-var precedence.** The
    "lists merge, they don't override" rule is unusual and load-bearing.
21. **Status line as a JSON-on-stdin/stdout subprocess with a 300 ms debounce** and a documented
    field list — a cheap, extremely effective extensibility seam.
22. **`terminalSequence` instead of `/dev/tty`.** Hooks have no controlling terminal; making the
    harness emit the escape sequence removes a whole class of races and Windows bugs.
23. **OTel as the only telemetry contract**, with `prompt.id` correlation and a documented metric
    set.
24. **Output styles with `keep-coding-instructions`** — the ability to change _voice_ without
    changing _engineering discipline_ is the one non-obvious design detail there.

### 14.2 Claude-specific — don't port, or port only with the dependency made explicit

| Capability                                                                                                                       | Why it doesn't transfer as-is                                                                                                                                                 |
| :------------------------------------------------------------------------------------------------------------------------------- | :---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Everything gated on `claude.ai` account sync (`~/.claude/skills/synced/`, `anthropic-skills:` namespace, `@synced` plugins)      | requires Anthropic's SaaS identity and sync service                                                                                                                           |
| Bundled skills (`/doctor`, `/code-review`, `/batch`, `/loop`, `/claude-api`, `/deep-research`, `/verify`)                        | prompt content tuned to Claude models; the _mechanism_ (bundled prompt-based skills that shadow built-ins but not their aliases) is portable                                  |
| Model aliases `fable`/`opus`/`sonnet`/`haiku`/`[1m]`, `opusplan`, effort levels `low…max`/`ultracode`, `advisorModel`, fast mode | Anthropic model line and pricing; the _shape_ (alias table + per-model effort with fallback + ordered fallback chain) is portable                                             |
| `modelPricing`, data-residency 1.1×                                                                                              | Anthropic list prices                                                                                                                                                         |
| `CLAUDE_CODE_*` and `ANTHROPIC_*` env var names                                                                                  | naming, not mechanism                                                                                                                                                         |
| Auto mode's server-side classifier                                                                                               | server-side review is part of the Claude API offering; docs describe client behavior only                                                                                     |
| Cloud/desktop/IDE/Remote Control surfaces, Projects, artifacts, Chrome, computer use, Slack, agent view                          | product surfaces, not harness capability                                                                                                                                      |
| Plugin marketplace ecosystem (official/community catalogs, `claude-plugins-official`)                                            | content + hosting; the manifest/marketplace schema is portable                                                                                                                |
| Auto memory's exact storage layout and 200-line/25 KB read limits                                                                | the numbers are Anthropic's hedges; the pattern (index file loaded, topic files on demand, write-time reminders, `modified` stamp, excluded from retention sweep) is portable |
| `Explore`/`Plan` skipping CLAUDE.md                                                                                              | tied to Claude Code's specific prompt layering; the _rule_ ("cheap research agents get a minimal context") is portable                                                        |

### 14.3 Things the docs do **not** settle (open questions for the gap analysis)

- **Plan-mode prompt content** — the docs specify the tool contract (`ExitPlanMode`), read-only
  enforcement, and post-compaction re-injection, but never the prompt delta. [unverified]
- **`skill_listing` / `dynamic_skill` identifiers** — mechanism is documented; the attachment names
  are only in binary RE. [internal, not in docs]
- **Exact auto-compaction thresholds per model** — the docs point at
  "Default auto-compact thresholds" in `model-config` but present them relative to the model roster
  rather than as a formula; treat any single number as model-version-bound.
- **Any frontmatter key for `@path` file references in commands** — none exists in the docs. The
  `@` surface is prompt syntax.
- **Whether hooks can mutate `updatedInput` outside `PreToolUse`** — the docs place `updatedInput`
  under `PreToolUse` only.
- **Team-scale limits** (teammate count) — the docs give qualitative limits ("a handful") and
  documented resumption/coordination limitations, not numbers.

---

## Appendix A. Source list (all fetched)

- <https://code.claude.com/docs/llms.txt> — doc index
- <https://code.claude.com/docs/en/skills>
- <https://code.claude.com/docs/en/commands>
- <https://code.claude.com/docs/en/sub-agents>
- <https://code.claude.com/docs/en/agents>
- <https://code.claude.com/docs/en/agent-teams>
- <https://code.claude.com/docs/en/agent-view>
- <https://code.claude.com/docs/en/workflows>
- <https://code.claude.com/docs/en/hooks>
- <https://code.claude.com/docs/en/hooks-guide>
- <https://code.claude.com/docs/en/memory>
- <https://code.claude.com/docs/en/context-window>
- <https://code.claude.com/docs/en/prompt-caching>
- <https://code.claude.com/docs/en/checkpointing>
- <https://code.claude.com/docs/en/interactive-mode>
- <https://code.claude.com/docs/en/permission-modes>
- <https://code.claude.com/docs/en/permissions>
- <https://code.claude.com/docs/en/sandboxing>
- <https://code.claude.com/docs/en/sandbox-environments>
- <https://code.claude.com/docs/en/mcp>
- <https://code.claude.com/docs/en/output-styles>
- <https://code.claude.com/docs/en/statusline>
- <https://code.claude.com/docs/en/model-config>
- <https://code.claude.com/docs/en/costs>
- <https://code.claude.com/docs/en/monitoring-usage>
- <https://code.claude.com/docs/en/settings>
- <https://code.claude.com/docs/en/settings-reference>
- <https://code.claude.com/docs/en/managed-settings>
- <https://code.claude.com/docs/en/env-vars>
- <https://code.claude.com/docs/en/tools-reference>
- <https://code.claude.com/docs/en/claude-directory>
- <https://code.claude.com/docs/en/cli-reference>
- <https://code.claude.com/docs/en/glossary>
- <https://code.claude.com/docs/en/plugins/overview>
- <https://code.claude.com/docs/en/plugins/create>
- <https://code.claude.com/docs/en/plugins/components>
- <https://code.claude.com/docs/en/plugins/install>
- <https://code.claude.com/docs/en/plugins/security>
- <https://code.claude.com/docs/en/plugins/manifest-reference>
- <https://code.claude.com/docs/en/plugins/marketplace-reference>
- <https://code.claude.com/docs/en/plugins/loading>
- <https://code.claude.com/docs/en/plugins/create-marketplace>

## Appendix B. Verification status per area

| Area                                         | Status                                              | Note                                                                           |
| :------------------------------------------- | :-------------------------------------------------- | :----------------------------------------------------------------------------- |
| Skills format/discovery/tiers/args/injection | verified                                            | complete frontmatter table + numbers                                           |
| Commands                                     | verified                                            | merged-into-skills confirmed; legacy frontmatter = skills minus `name`/`paths` |
| Hooks events/matchers/exit codes/JSON        | verified                                            | 37 events, per-event block table, field table                                  |
| Subagents                                    | verified                                            | full frontmatter, permission precedence, startup context, limits               |
| Plugins/marketplaces                         | verified                                            | both schemas, scopes, ids, trust text                                          |
| Memory/context/compaction                    | verified                                            | hierarchy, imports, `MEMORY.md`, survival table                                |
| Checkpoints/background/todos/plan mode       | verified except plan-mode prompt delta [unverified] |
| Permissions/sandbox                          | verified                                            | rule syntax, hazards, Seatbelt/bubblewrap, modes                               |
| MCP                                          | verified                                            | transports, scopes, tool search numbers, elicitation, resources/prompts        |
| Output styles/statusline/model/cost/OTel     | verified                                            | field lists and metric names                                                   |
| Settings                                     | verified                                            | precedence, merge rules, managed delivery, key inventory                       |
| Agent teams/workflows                        | verified                                            | experimental flag, architecture, artifact paths                                |
