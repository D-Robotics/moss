# Claude Code CLI interaction surface (v2.1.285) — reverse-engineered from a real PTY

Ground truth for the moss CLI parity work. Every claim below is backed by a screen dump produced by
`scratch/tui-drive.py` driving `/opt/homebrew/bin/claude` (`Claude Code v2.1.285`) inside a real PTY,
or is explicitly marked **not verified**. Raw dumps live in `scratch/ccs-*` (gitignored).

## 0. Method, environment and how to reproduce

### 0.1 Harness

All captures use the existing PTY driver in this repo (`pyte` screen reconstruction, cell attributes
included):

```bash
CC="env -u NO_COLOR TERM=xterm-256color COLORTERM=truecolor \
  python3 scratch/tui-drive.py --bin /opt/homebrew/bin/claude --realhome \
  --workspace scratch/cc-ws"
# usage: $CC --cols 90 --rows 30 --out scratch/ccs-<name> --steps '<DSL>'
```

Step DSL: `wait:MS` · `shot:NAME` · `key:NAME` (`enter esc tab up down left right bs space pgup pgdn ctrl-<a-z>`) ·
`text:STR` · `raw:HEXBYTES` · `resize:COLSxROWS`. Dumps land in `<out>/NAME.txt` (plain screen) and
`<out>/NAME.style` (per-cell colour/attribute).

**Critical environment note (must be reproduced).** The parent shell of this agent has `NO_COLOR=1`
and `TERM=dumb`; the driver inherits the parent environment for `--bin`, so a plain invocation yields
a **completely attribute-free** screen. Every capture below was taken with `env -u NO_COLOR
TERM=xterm-256color COLORTERM=truecolor`. A first round of captures without this prefix was discarded
(`scratch/ccs-a1` vs the used `scratch/ccs-a1c`).

In quoted dumps, `…` marks either more rule characters than shown or an explicitly labelled run of elided
rows; every elision sits between two lines quoted from the same dump. Quoted blocks that appear inside a
bullet are shifted right by the markdown list indent (2 spaces); colour/attribute claims come from the
`.style` sidecar and the raw PTY bytes (`--rawlog`), not from the plain text. Line numbers shown as `NN|`
appear only in my analysis notes, never inside a quoted dump; quotes are otherwise verbatim.

### 0.2 Capture index (exact commands)

All commands are prefixed by the `CC` definition above.

| Dir                         | Command (arguments after `$CC`)                                                                                                                                                                                                                                                                                                      | What it proves                                 |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------- |
| `scratch/ccs-a1c`           | `--cols 90 --rows 30 --out scratch/ccs-a1c --steps 'wait:8000,shot:c-boot-90x30,resize:80x24,shot:c-80x24,resize:120x40,shot:c-120x40,resize:90x10,shot:c-90x10,key:ctrl-c'`                                                                                                                                                         | Layout/chrome at 4 sizes (§1)                  |
| `scratch/ccs-a2`            | `--cols 90 --rows 34 --out scratch/ccs-a2 --steps 'wait:7000,text:/,wait:1200,shot:m-slash,key:down,shot:m-slash-sel2,text:c,wait:800,shot:m-slash-filter-c,text:o,wait:800,shot:m-slash-filter-co,key:esc,wait:600,shot:m-slash-after-esc,text:@,wait:1500,shot:m-at,text:tui,wait:1200,shot:m-at-tui,key:esc,wait:500,key:ctrl-c'` | Slash menu, filtering, Esc (§3)                |
| `scratch/ccs-inv`           | 27 shots: `text:/` then per letter `a`–`z` (`text:<L>,wait:600,shot:inv-<L>,key:bs`), `--rawlog`                                                                                                                                                                                                                                     | Menu filtering + raw SGR bytes (§3)            |
| `scratch/ccs-scroll`        | `text:/` then `up,shot` ×4 and `down` ×5                                                                                                                                                                                                                                                                                             | Menu window/anchor behaviour (§3)              |
| `scratch/ccs-walk`          | `text:/` then `key:up` + `shot:wNNN` ×140 (script-generated)                                                                                                                                                                                                                                                                         | Full menu order + wrap-around (§3, §13)        |
| `scratch/ccs-s4`            | `--cols 120 --rows 60 … 'wait:7000,text:/,shot:s4-menu-120x60,key:esc,shot:s4-esc1,key:esc,shot:s4-esc2,…,raw:1b5b5a,shot:s4-mode1,…(×6)'`                                                                                                                                                                                           | Menu size cap, Esc semantics, shift+tab modes  |
| `scratch/ccs-s5a`,`-s5a3`   | `text:@…` variants                                                                                                                                                                                                                                                                                                                   | `@` mention menu (§4)                          |
| `scratch/ccs-s5b`           | `text:!,wait:900,shot:bash-prefix,text:ls,shot:bash-ls,key:enter,shot:bash-perm,…`                                                                                                                                                                                                                                                   | `!` bash mode (§5)                             |
| `scratch/ccs-s6`            | `text:?,shot:shortcuts`, then `ctrl-j` / `\`+`enter` / `raw:1b5b31333b3275` multiline tests, then `up`, `up`, `ctrl-r`                                                                                                                                                                                                               | Shortcuts panel, newline keys, history, Ctrl+R |
| `scratch/ccs-s7`            | `key:ctrl-t`, `/status`+`enter`, `abcdef`+`esc`+`esc`, `ctrl-d`                                                                                                                                                                                                                                                                      | Ctrl+T, /status, double-Esc, Ctrl+D            |
| `scratch/ccs-s8a`,`-s8c`    | `key:ctrl-c,shot` / `key:ctrl-c,key:ctrl-c,shot`                                                                                                                                                                                                                                                                                     | Ctrl+C semantics (§12)                         |
| `scratch/ccs-s8b`           | `--args=--resume`                                                                                                                                                                                                                                                                                                                    | Resume picker at startup (§12)                 |
| `scratch/ccs-t1`            | `--cols 100 --rows 40 … 'text:create demo/gamma.ts …;,key:enter,wait:15000,shot:t1-write-perm,key:tab,shot:t1-perm-tab,key:enter,…,text:append a second line …;,key:enter,shot:t1-edit-perm,key:enter,shot:t1-diff,key:ctrl-c'`                                                                                                      | Write/Edit permission dialogs + diff (§6, §8)  |
| `scratch/ccs-t2`            | `text:run seq 1 200 with the Bash tool and show me the raw output,key:enter,…,key:ctrl-o,shot:t2-ctrl-o`                                                                                                                                                                                                                             | Auto-approved Bash + `ctrl+o` verbose (§9)     |
| `scratch/ccs-t3`            | `text:use the Bash tool to run echo hello-moss,…` then `test:touch /tmp/moss-probe-1`… then `fetch https://example.com …`                                                                                                                                                                                                            | Bash + WebFetch permission dialogs (§6)        |
| `scratch/ccs-s9`            | `text:/cont`+`enter` (`/context`), `/usage`, `/autocompact`, `/exit`                                                                                                                                                                                                                                                                 | Context/usage/compact panels, exit (§11, §12)  |
| `scratch/ccs-s10`           | `text:/help`+`enter`, bracketed paste `raw:1b5b3230307e,text:alpha,raw:0a,text:beta,raw:1b5b3230317e`, `text:hello world,key:ctrl-s`                                                                                                                                                                                                 | /help panel, paste, Ctrl+S stash (§2, §9)      |
| `scratch/ccs-help`,`-help2` | `text:/help,key:enter,key:tab` then `key:down`+`shot` ×80 / `key:tab,key:right` then ×45                                                                                                                                                                                                                                             | Full command inventory (§13)                   |
| `scratch/ccs-t5`            | `text:Reply with markdown only. Use a heading. … No tools.,key:enter,…,key:esc,key:esc,shot:t5-escesc`                                                                                                                                                                                                                               | Markdown rendering (§10), Rewind (§12)         |
| `scratch/ccs-t6`            | `text:Use the TodoWrite tool …`                                                                                                                                                                                                                                                                                                      | TodoWrite availability (§7)                    |
| `scratch/ccs-t7`            | `raw:1b5b5a,raw:1b5b5a` (plan mode) + plan request                                                                                                                                                                                                                                                                                   | Plan mode + plan approval panel (§7)           |
| `scratch/ccs-s12`           | `text:/clear,key:enter`, `/resume`+`esc`, `text:remove the gamma2 line from demo/gamma.ts,…`                                                                                                                                                                                                                                         | /clear, in-session /resume, removed-line diff  |
| `scratch/ccs-s13`           | `text:abcd,key:left,key:left,text:X`, `ctrl-a`, `ctrl-e`, `ctrl-u`, `ctrl-w`                                                                                                                                                                                                                                                         | Composer editing keys (§2)                     |

Total: **526 screen dumps** across 38 capture directories (`ls scratch/ccs-*/*.txt | wc -l`).

### 0.3 What is stock Claude Code vs this machine's configuration

The install under test is **not** a vanilla Claude Code: it runs with the user's real `$HOME`
(`--realhome`), model `glm-5.3` behind `ANTHROPIC_BASE_URL=https://ai-api.d-robotics.cc`, 43 skills,
3 custom agents, 1 failed MCP server, and at least two plugins (`cc-plugin-agents-md`, `Chorus`).
Consequences that matter for parity work:

- Session-start chrome contains plugin output, e.g. `⏺ cc-plugin-agents-md: no CLAUDE.md found; AGENTS.md loaded:` and
  `⎿ SessionStart:startup says: Chorus plugin: not configured (set CHORUS_URL and CHORUS_API_KEY)`. These are
  **host-specific**, and are quoted below only where the chrome matters; moss must not copy them.
- The permission modes cycled by shift+tab include `manual mode` and `auto mode`, which are **not** the
  stock four modes; see §6.4 and treat mode _names_ as configuration-dependent, mode _mechanism_ as real.
- Skill/plugin commands (`/chorus:*`, `/rdk-docs`, `/tdd`, …) appear in `/` and `/help`; the count 109
  is machine-specific, the _shape_ of the list is not.

## 1. Layout & chrome

Command (see table): `$CC --cols 90 --rows 30 --out scratch/ccs-a1c --steps 'wait:8000,shot:c-boot-90x30,resize:80x24,shot:c-80x24,resize:120x40,shot:c-120x40,resize:90x10,shot:c-90x10,key:ctrl-c'`

`scratch/ccs-a1c/c-boot-90x30.txt`, verbatim (30 rows, right-aligned status line shortened by one space
only where noted — actually quoted as-is):

```
 ▐▛███▛█   Claude Code v2.1.285
▝▜██████▀  glm-5.3 · API Usage Billing
 ▝▝   ▝▝   ~/Desktop/RDK_Studio/moss/scratch/cc-ws

  ⎿  SessionStart:startup says: Chorus plugin: not configured (set CHORUS_URL and
     CHORUS_API_KEY)

⏺ cc-plugin-agents-md: no CLAUDE.md found; AGENTS.md loaded:
  /Users/d-robotics/Desktop/RDK_Studio/moss/AGENTS.md
…
                                                                        ● high · /effort
──────────────────────────────────────────────────────────────────────────────────────────
❯ Try "write a test for index.ts"
──────────────────────────────────────────────────────────────────────────────────────────
  ⏸ manual mode on · ? for shortcuts · ← for agents
```

Observations, all directly readable in the dump and its `.style` sidecar:

- Row 1 is blank; rows 2–4 are the banner block: 3-line ASCII wordmark (orange `#d77757`, filled blocks
  painted on black), `Claude Code` in bold with version `v2.1.285` in grey, then `glm-5.3 · API Usage Billing`,
  then the cwd abbreviated with `~`.
- `⏺` marks a top-level message; `⎿` marks output/annotation attached to the line above (2-space indent,
  continuation lines indented 5 spaces as in the SessionStart block).
- The transcript is a single column printed into the terminal scrollback; there is **no box, no sidebar,
  no panel** in the normal state. Blocks are separated by one blank line.
- Above the composer there is a **full-width `─` rule**; below the composer a second full-width `─` rule;
  the row directly above the top rule carries **right-aligned contextual status**; the row below the
  bottom rule carries a **left-indented hint line** (2 spaces).
- Composer prompt glyph is `❯` followed by one space; when empty it shows a **contextual suggestion
  placeholder** (here `Try "write a test for index.ts"`; it changed per session to
  `Try "refactor index.ts"`, `Try "fix lint errors"`, `Try "create demo/delta.ts containing export const delta = 4;"`).
- Colours (from `c-boot-90x30.style`): rules `#888888`; banner `#d77757`; version/model/cwd status text
  `#999999`; the `● high · /effort` status `#999999`.

**Sizes.** `c-80x24.txt` (rows 20–24) — same five chrome rows, only the wrapping changes:

```
                                                              ● high · /effort
────────────────────────────────────────────────────────────────────────────────
❯ Try "write a test for index.ts"
────────────────────────────────────────────────────────────────────────────────
  ⏸ manual mode on · ? for shortcuts · ← for agents
```

`c-120x40.txt` (rows 37–40) — the SessionStart block no longer wraps
(`⎿ SessionStart:startup says: Chorus plugin: not configured (set CHORUS_URL and CHORUS_API_KEY)` on one
line) and the `● high · /effort` row is **absent at the moment of this shot**:

```
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
❯ Try "write a test for index.ts"
────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
  ⏸ manual mode on · ? for shortcuts · ← for agents
```

`c-90x10.txt` (all 10 rows) — with too little height the banner and early transcript scroll away, and
only the tail of the transcript plus composer remain:

```
  ⎿  SessionStart:startup says: Chorus plugin: not configured (set CHORUS_URL and
     CHORUS_API_KEY)

⏺ cc-plugin-agents-md: no CLAUDE.md found; AGENTS.md loaded:
  /Users/d-robotics/Desktop/RDK_Studio/moss/AGENTS.md

──────────────────────────────────────────────────────────────────────────────────────────
❯ Try "write a test for index.ts"
──────────────────────────────────────────────────────────────────────────
  ⏸ manual mode on · ? for shortcuts · ← for agents
```

The `● high · /effort` indicator is right-aligned just above the top rule and is **transient**: it is
present in the boot shot and in the first post-resize shot (`c-80x24`), and absent in later shots
(`c-120x40`, `c-90x10`) without any user action. Its colour is grey `#999999`; the row is reused for
other right-aligned hints (`ctrl+g to edit in Vim`, `Esc again to clear`, `● high · /effort · › stashed`).

## 2. Composer / input editing

- **Newline.** Three independent captures, all with `scratch/ccs-s6`:
  - `Ctrl+J` (`text:line-one,key:ctrl-j,text:line-two`) → `ml-ctrlj.txt`:
    ```
    ❯ line-one
      line-two
    ```
  - `\` then `Enter` (`text:line-one,text:\,key:enter,text:line-two`) → `ml-backslash.txt`, identical.
  - `Shift+Enter`, encoded as the Kitty/CSI-u form `raw:1b5b31333b3275` (`CSI 13;2u`) →
    `ml-shiftenter.txt`, composer shows an empty first line and `line-two` on the second line.
  - The built-in shortcuts panel (§9 command reference, `scratch/ccs-s6/shortcuts.txt`) documents it:
    `backslash (\) + return (⏎) for newline` and the `/help` panel renders it as `\⏎ for newline`.
  - Continuation lines are indented by 2 spaces under the `❯ `.
- **Cursor movement** (`scratch/ccs-s13`): `text:abcd,key:left,key:left,text:X` → `cursor-abXcd.txt` shows
  `❯ abXcd` (insertion at cursor), so left/right move a real cursor inside the line.
  `key:ctrl-a,text:Y` → `cursor-home.txt` `❯ YabXcd`; `key:ctrl-e,text:Z` → `cursor-end.txt` `❯ YabXcdZ`.
- **Kill/undo hints**: `key:ctrl-u` → `ctrl-u.txt` clears the whole line, restores the placeholder and shows
  the right-aligned hint `Ctrl+Y to paste deleted text`; `key:ctrl-w` on `hello world` → `ctrl-w.txt`
  `❯ hello` with the same hint. (Backspace after Ctrl+W did not visibly change the composer in
  `bs.txt`; **not verified** as a rule.)
- **Clear**: double-tap Esc (`scratch/ccs-s7`, `text:abcdef,key:esc,key:esc`) → `esc-double.txt` composer is
  empty again. The shortcuts panel names it `double tap esc to clear input`.
- **History.** `key:up` on an empty composer (`scratch/ccs-s6/hist-up.txt`) recalls the previous entry and
  renders a labelled rule above it:

  ```
  ─── History 7/7 ────────────────────────────────────────────────────────────────────────────────────
  ! ls
  ──────────────────────────────────────────────────────────────────────────────────────────────────────
    ! for shell mode
  ```

  (The recalled entry was a `!` bash-mode entry, hence the shell-mode hint.)

- **Ctrl+R prompt search** (`scratch/ccs-s6/ctrl-r.txt`) opens a full-height overlay, not a one-line prompt:

  ```
  ────────────────────────────────────────────────────────────────────────────────────────────────────
    Search prompts · everywhere
                                                       ╭───────────────────────────────────────────╮
                                                       │ tui-drive                                 │
      2mo ago  Help me fix the issues reported by /d…  │                                           │
      2mo ago  帮我再补充一点，每修改一个部分，需要…   │                                           │
      … (4 more rows elided)
    ❯ 1m ago   tui-drive                               ╰───────────────────────────────────────────╯
    ╭──────────────────────────────────────────────────────────────────────────────────────────────╮
    │ ⌕ tui-drive                                                                                  │
    ╰──────────────────────────────────────────────────────────────────────────────────────────────╯
    ↑/↓ to nav · Enter to use · Esc to cancel · ctrl+s to scope
  ```

- **Paste.** Bracketed paste (`raw:1b5b3230307e,text:alpha,raw:0a,text:beta,raw:1b5b3230317e`,
  `scratch/ccs-s10/paste.txt`) inserts two lines without submitting:
  ```
  ❯ alpha
    beta
  ```
- **Stash prompt.** `key:ctrl-s` on a non-empty composer (`scratch/ccs-s10/stash.txt`) empties the composer
  and marks the status row: `● high · /effort · › stashed`.
- **Image paste.** Documented by the built-in panels (`ctrl + v to paste images`) but **not exercised** —
  no image was pasted. **Not verified.**
- **`Ctrl+G` edit-in-$EDITOR / `Ctrl+Z` suspend / `Ctrl+Shift+_` undo**: only documented in the shortcuts
  panel; not exercised. **Not verified.**

## 3. Slash command menu

Commands: `scratch/ccs-a2`, `scratch/ccs-inv`, `scratch/ccs-scroll`, `scratch/ccs-walk`, `scratch/ccs-s4`, `scratch/ccs-s9`.

Typing `/` (`scratch/ccs-a2/m-slash.txt`, 90×34) inserts `/` into the composer and opens a menu directly
above the composer:

```
  /loop                              Run a prompt or slash command on a recurring
                                     interval (e.g. /loop 5m /foo). Omit the interval t…
  /qiaolong-mindset                  乔龙的个人思考与操作方法论 ——
                                     用第一性原理切入、思考清楚后落 spec 才动键盘、以证…
──────────────────────────────────────────────────────────────────────────────────────────
❯ /
──────────────────────────────────────────────────────────────────────────────────────────
  ⏸ manual mode on
```

- Format: 2-space indent, `/name`, name column padded to 34 characters, one-line description that wraps
  onto a continuation line aligned to the description column, truncated with `…` at the right edge.
- **The window is small and fixed-ish, not a full list.** At 90×34 the visible window is 4 rows; at
  100×50 it is rows 43–46 (4 rows); at 120×60 it is rows 53–56 (4 rows) — see
  `scratch/ccs-s4/s4-menu-120x60.txt`. Everything between the transcript and the menu stays blank, so the
  cap is the component's own, not the terminal height. Up to ~3 items (5 rows) fit when entries are one
  line each (`scratch/ccs-s4/s4-mode*.txt` area, and `scratch/ccs-scroll/up3.txt` shows three names).
- **Colours / selection** (raw bytes in `scratch/ccs-inv/raw.log`, styles in `scratch/ccs-a2/m-slash.style`):
  selected row is drawn in foreground `#b1b9f9` (`\x1b[38;2;177;185;249m/loop`), non-selected rows in
  `#999999`; **there is no background bar** — selection is a colour change. Matched characters are bold
  (`c` in `/cd` is `fb1b9f9B` while the rest of the name is not).
- **Filtering is inline** (composer keeps the typed text):
  `scratch/ccs-a2/m-slash-filter-c.txt`:
  ```
    /cd                                Move this session to a new working directory
    /copy                              Copy Claude's last response to clipboard (or /copy
                                       N for the Nth-latest)
    /clear                             Start a new session with empty context; previous
                                       session stays on disk (resumable with /resume)
  ❯ /c
  ```
  and `m-slash-filter-co.txt`:
  ```
    /copy                              Copy Claude's last response to clipboard (or /copy
                                       N for the Nth-latest)
    /color                             Set the prompt bar color for this session
    /config                            Open settings
  ❯ /co
  ```
  Note the order is **not** alphabetical (`/cd, /copy, /clear`; `/copy, /color, /config`) — matches are
  ranked (most-used/relevance first) with the matched substring bolded. The ranking rule itself is **not
  verified**, only the observed order.
- **Keys.** `esc` closes the menu and keeps the composer text (`scratch/ccs-a2/m-slash-after-esc.txt`
  still shows `❯ /co`); a second `esc` in the same state renders `Esc again to clear` right-aligned
  (`scratch/ccs-s4/s4-esc2.txt`). `up`/`down` move one entry and **wrap around**: walking `up` 140 times
  (`scratch/ccs-walk`) visits 109 distinct commands and then returns to the first entry
  (`w000 /loop → w111 /loop`, sequence file `scratch/ccs-slash-walk.txt`). `Enter` **runs** the
  highlighted command: `scratch/ccs-s9/cont-menu.txt` shows `/cont` filtered down to
  `/context  Visualize current context usage as a colored grid`, and after `Enter`,
  `scratch/ccs-s9/context-panel.txt` shows `❯ /context` plus the command's output.
- The menu is also where the inventory is enumerated; the ordered list from the `up` walk is in
  `scratch/ccs-slash-walk.txt` and the union inventory in `scratch/ccs-inventory-union.tsv` (§13).

## 4. `@`-mention / file references

Commands: `scratch/ccs-s5a` (`text:@`, `text:@scr`, `key:down`, `key:esc`, `key:ctrl-c`),
`scratch/ccs-s5a3` (`text:@tui-drive`, `key:tab`, `key:esc`).

Bare `@` (`scratch/ccs-s5a/at.txt`) opens a menu of files **and** agents above the composer:

```
  + .moss/
  * chorus:code-reviewer (agent) – Final ship-time review of an Idea's aggregate code change —…
  * chorus:proposal-reviewer (agent) – Review submitted Chorus proposals for quality — check docu…
  * chorus:task-reviewer (agent) – Review submitted Chorus tasks — verify implementation again…
  * claude (agent) – Catch-all for any task that doesn't fit a more specific age…
──────────────────────────────────────────────────────────────────────────────────────────
❯ @
```

- `+` prefixes filesystem paths (directories keep a trailing `/`), `*` prefixes agent references which
  are labelled `(agent) – <description>`.
- Typing narrows it live: `scratch/ccs-s5a/at-scr.txt` (filter `@scr`) shows
  `+ ../../scripts/`, `+ ../../scripts/lib/`, `+ ../../scripts/bench-ab.mjs`,
  `+ ../../scripts/run-benchmark.mjs`, `+ ../../scripts/lib/pr-title.mjs`; `scratch/ccs-s5a/at-dir.txt`
  (filter `@scan`) shows `../../test/oneshot-cancellation.spec.mjs`, `../../src/cli/tasks-commands.ts`,
  `../../src/core/agent/`, … Paths are rendered relative to the session cwd but the index reaches outside
  the workspace (up to the enclosing project root) — observed, not explained.
- `esc` closes the menu and keeps `@scr` in the composer (`scratch/ccs-s5a/at-esc.txt`).
- `Tab` **completes the highlighted entry into the composer**:
  `scratch/ccs-s5a3/at-tab.txt` composer becomes
  `❯ @/Users/d-robotics/.claude/skills/requesting-code-review/code-reviewer.md` (an entry outside the
  workspace is inserted as an absolute path). The `+`/`*` marker is not inserted.
- Fuzzy matching is loose: `@tui-drive` matched
  `/Users/d-robotics/.claude/skills/requesting-code-review/code-reviewer.md` and nothing else
  (`scratch/ccs-s5a3/at-file.txt`). Exact scoring is **not verified**.
- Bare `@` following existing text does **not** open the menu: with `/co` in the composer,
  `scratch/ccs-a2/m-at.txt` shows `❯ /co@` and no menu.

## 5. Bash mode (`!`) and other prefixes

Command: `scratch/ccs-s5b` — `'wait:7000,text:!,wait:900,shot:bash-prefix,text:ls,wait:900,shot:bash-ls,key:enter,wait:2500,shot:bash-perm,key:enter,wait:3500,shot:bash-ran,key:ctrl-c'`

`!` at position 0 switches the composer into shell mode (styles: the prompt glyph, both rules and the hint
all turn orange `#fd5db1`):

```
────────────────────────────────────────────────────────────────────────────────────────────────────
! Try "create a util logging.py that..."
────────────────────────────────────────────────────────────────────────────────────────────────────
  ! for shell mode
```

after typing `ls` (`bash-ls.txt`): `! ls` between the same orange rules, hint `! for shell mode`.

`Enter` executes the command immediately against the shell — `bash-perm.txt` shows it already in the
transcript, above the composer, followed by the model continuing the turn:

```
! ls
  ⎿  demo
     notes.md
```

```
✢ Elucidating…
```

```
❯
────────────────────────────────────────────────────────────────────────────────────────────────────
  ⏸ manual mode on · esc to interrupt · ← for agents
```

So a shell-mode submission produces a `! <cmd>` transcript line, the `⎿`-indented output, and then a
normal model turn (spinner plus `esc to interrupt` in the hint line). Fenced other prefixes: the panels
document exactly three mode prefixes — `! for shell mode`, `/ for commands`, `@ for file paths`
(`scratch/ccs-s6/shortcuts.txt`), plus `/btw` advertised as a side-question command.

## 6. Permission / approval dialogs and permission modes

Commands: `scratch/ccs-t1` (Write, Edit), `scratch/ccs-t3` (Bash, WebFetch), `scratch/ccs-s4` (shift+tab).

A permission dialog is rendered **inline in the transcript**, between the tool-call header and the
composer, with a full-width `─` rule above it, a bold title, the target, a `╌`-dashed rule around the
content, a question line, a numbered option list with `❯` on the selection, and a footer.

### 6.1 File write — `scratch/ccs-t1/t1-write-perm.txt`

```
⏺ Write(demo/gamma.ts)

────────────────────────────────────────────────────────────────────────────────────────────────────
 Create file
 demo/gamma.ts
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
  1 export const gamma = 3;
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Do you want to create gamma.ts?
 ❯ 1. Yes
   2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this
      session (shift+tab)
   3. No

 Esc to cancel · Tab to amend
```

### 6.2 File edit — `scratch/ccs-t1/t1-edit-perm.txt`

Same shape, title `Edit file`, and the content block is the diff:

```
⏺ Update(demo/gamma.ts)

────────────────────────────────────────────────────────────────────────────────────────────────────
 Edit file
 demo/gamma.ts
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 1  export const gamma = 3;
 2 +export const gamma2 = 4;
╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
 Do you want to make this edit to gamma.ts?
 ❯ 1. Yes
   2. Yes, and switch to accept edits (auto-approve file edits and common file commands) for this
      session (shift+tab)
   3. No

 Esc to cancel · Tab to amend
```

### 6.3 Shell command — `scratch/ccs-t3/t3-bash-perm.txt`

Only **mutating** commands prompt: `use the Bash tool to run echo hello-moss` completed with no dialog
(`scratch/ccs-t3/t3-bash-small.txt` shows only `  Ran 1 shell command`), while `touch /tmp/moss-probe-1`
produced:

```
⏺ Creating /tmp/moss-probe-1 file
  ⎿  $ touch /tmp/moss-probe-1

────────────────────────────────────────────────────────────────────────────────────────────────────
 Bash command
 Tip: auto mode handles these prompts for you — choose "switch to auto mode" below

   touch /tmp/moss-probe-1
   Create /tmp/moss-probe-1 file

 Do you want to proceed?
 ❯ 1. Yes
   2. Yes, and always allow access to /tmp from this project
   3. Yes, and switch to auto mode · auto mode handles these prompts for you
   4. No

 Esc to cancel · Tab to amend
```

The tool-call header carries a human-readable description (`Creating /tmp/moss-probe-1 file`) with the
literal command on the `⎿` line (`$ touch /tmp/moss-probe-1`). After approval the same turn renders
`  Thought for 2s, ran 1 shell command` and the model's answer (`t3-bash-approved.txt`).

### 6.4 Network / high-risk (WebFetch) — `scratch/ccs-t3/t3-webfetch-perm.txt`

```
⏺ Fetch(https://example.com)

────────────────────────────────────────────────────────────────────────────────────────────────────
 Fetch

   url: https://example.com/
   prompt: What is the page title of this page?
   Claude wants to fetch content from example.com

 Do you want to allow Claude to fetch this content?
 ❯ 1. Yes
   2. Yes, and don't ask again for example.com
   3. No, and tell Claude what to do differently (esc)
```

Note this dialog has **three** options and a different "No" wording from 6.1–6.3. The capture used a
36-row terminal and the dialog filled it, so any footer row for this dialog was **below the viewport and
is not captured** (the file-modifying and shell dialogs do show `Esc to cancel · Tab to amend`, §6.5).

### 6.5 "Tab to amend"

`scratch/ccs-t1/t1-perm-tab.txt`: after `Tab`, option 1 becomes
`1. Yes, and tell Claude what to do next` and the footer drops `· Tab to amend` (leaving `Esc to cancel`).

### 6.6 Mode cycling (shift+tab)

`raw:1b5b5a` (`CSI Z`) cycles, and the hint line below the composer is the only indicator. Six
consecutive presses (`scratch/ccs-s4/s4-mode1.txt` … `s4-mode6.txt`):

| #   | Hint line (row below composer)            | Glyph colour |
| --- | ----------------------------------------- | ------------ |
| 0   | `⏸ manual mode on`                        | `#999999`    |
| 1   | `⏵⏵ accept edits on (shift+tab to cycle)` | `#af87ff`    |
| 2   | `⏸ plan mode on (shift+tab to cycle)`     | `#48968c`    |
| 3   | `⏵⏵ auto mode on (shift+tab to cycle)`    | `#ffc107`    |
| 4   | `⏸ manual mode on`                        | `#999999`    |
| 5   | `⏵⏵ accept edits on (shift+tab to cycle)` | `#af87ff`    |

So the cycle is `manual → accept edits → plan → auto → manual`, and every state except the initial
`manual` one appends `(shift+tab to cycle)`. `manual` and `auto` are host-configuration mode names
(§0.3); `accept edits` and `plan` match the stock names, and the permission-option text in §6.1/6.2
(`switch to accept edits … (shift+tab)`) confirms that shift+tab is the documented shortcut for
accept-edits.

## 7. Plan mode / todo list

Commands: `scratch/ccs-t7` (plan mode), `scratch/ccs-t6` (TodoWrite probe).

- Entering plan mode with two `shift+tab` presses changes the hint line and the composer placeholder
  (`scratch/ccs-t7/t7-planmode.txt`, rows 43–46):
  ```
  ──────────────────────────────────────────────────────────────────────────────────────────────────────
  ❯ Try "write a test for agent-loop.ts"
  ──────────────────────────────────────────────────────────────────────────────────────────────────────
    ⏸ plan mode on (shift+tab to cycle) · ← for agents
  ```
- In plan mode the answer is not printed as prose: it opens a plan approval panel
  (`scratch/ccs-t7/t7-plan.txt`):

  ```
    ⎿  /plan to preview
  ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔

    ──────────────────────────────────────────────────────────────────────────────────────────────────
     Ready to code?

     Here is Claude's plan:
    ╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌╌
     为 demo/alpha.ts 添加 subtract 函数

     Context
     demo/alpha.ts 目前只导出一个常量 alpha = 1。…
     改动
     文件：demo/alpha.ts（唯一需要修改的文件）
     …
     node --experimental-strip-types -e \
       "import('./demo/alpha.ts').then(m => console.log(m.subtract(5, 3), m.alpha))"                          ↓
    ──────────────────────────────────────────────────────────────────────────────────────────────────
     Claude has written up a plan and is ready to execute. Would you like to proceed?

     ❯ 1. Yes, and use auto mode
       2. Yes, manually approve edits
       3. Tell Claude what to change
          shift+tab to approve with this feedback

     ctrl+g to edit in Vim · ~/.claude/plans/plan-how-to-add-frolicking-lighthouse.md
  ```

  Facts readable here: scrollable plan body (overflow marker `↓` drawn at the right edge), a dashed
  `╌` rule delimiting the plan, three numbered choices, `shift+tab to approve with this feedback`, and
  the plan is persisted to `~/.claude/plans/<slug>.md` with the path shown in the footer.

- **Live todo checklist: no.** `TodoWrite` is **not** in this installation's tool list. Explicit probe
  (`scratch/ccs-t6`, prompt `Use the TodoWrite tool to create a todo list …`) returned
  `⏺ 当前会话里没有 TodoWrite 工具可用（我的工具列表中没有它）…`. So a live `☐/☒` checklist could not
  be observed here — **not verified**, and the plan panel above is the only structured "plan" surface seen.

## 8. Diff / edit rendering

Commands: `scratch/ccs-t1` (added line), `scratch/ccs-s12` (removed line).

The permission dialog itself renders the diff (§6.2). After approval the same diff is printed in the
transcript with a gain/loss summary (`scratch/ccs-t1/t1-diff.txt`):

```
⏺ Update(demo/gamma.ts)
  ⎿  Added 1 line
      1  export const gamma = 3;
      2 +export const gamma2 = 4;
```

and removal (`scratch/ccs-s12/remove-diff.txt`):

```
⏺ Update(demo/gamma.ts)
  ⎿  Removed 1 line
      1  export const gamma = 3;
      2 -export const gamma2 = 4;
```

Layout and colours (from `t1-diff.style` / `remove-perm.style`):

- Right-aligned line-number gutter, then a marker column: ` ` for context, `+` added, `-` removed; the
  context line keeps a leading space (` 1  export …`).
- Added line: whole row background `#022800` (very dark green), `+` in `#50c850`.
- Removed line: whole row background `#3d0100` (very dark red), `-` in `#dc5a5a`.
- Code is syntax-highlighted inside the diff (keywords `#f92672`, `const`/types `#66d9ef`, numbers
  `#be84ff`, plain text `#f8f8f2`).
- No truncation was observed for 2-line diffs; a truncation marker / `ctrl+o to expand` for long diffs was
  **not verified**. (For long tool output the expansion key is `ctrl+o`, see §9.)

## 9. Long tool output, collapsing, expanding

Commands: `scratch/ccs-t2` (`run seq 1 200 …`), `scratch/ccs-t3` (`echo`), `scratch/ccs-s10` (`?` panel).

- **Read-only shell commands are auto-approved and summarised.** `scratch/ccs-t3/t3-bash-small.txt`:

  ```
  ❯ use the Bash tool to run echo hello-moss

    Ran 1 shell command

  ⏺ 命令已执行，输出为 hello-moss，退出码 0。

  ✻ Brewed for 4s · done 1:42 AM
  ```

  The command block itself (`⏺ Bash(…)` + `⎿ hello-moss`) is **not** rendered in the default view; only
  a one-line activity summary (`Ran 1 shell command`, or `Read 1 file` in
  `scratch/ccs-s12/remove-perm.txt` row 14) is kept. File-modifying tool calls, by contrast, keep their
  full block (§8).

- **`ctrl+o` toggles a detailed transcript** (`scratch/ccs-t2/t2-ctrl-o.txt`): the composer disappears and
  the footer row becomes
  ```
  Showing detailed transcript · ctrl+o to toggle · ? for shortcuts                          verbose
  ```
  with the raw 200-line `seq` output scrolled in the body, the model's hidden reasoning line
  (`∴ Just show the raw output. It's already shown above in the tool result. Per instructions, respond
in Chinese.`) and a per-message attribution line (`01:41 AM zhipu/glm-5.3`). The shortcuts panel
  describes the key as `ctrl + o for verbose output` and `/help` as `ctrl + o for verbose output`.
- **Transcript search: not verified.** No search affordance was found in the default or verbose transcript
  (`ctrl+r` is prompt history search, §2; the `/help` and `?` panels list no transcript-search key).
  Ctrl+F / `/` inside the verbose transcript were not tested.
- **Task toggle `ctrl+t`**: pressed at boot in `scratch/ccs-s7` (`ctrl-t.txt`) with no visible change and
  no panel; the panel documents it as `ctrl + t to toggle tasks`. Effect **not verified** (nothing was
  running).

## 10. Markdown rendering in answers

Command: `scratch/ccs-t5` — prompt `Reply with markdown only. Use a heading. Then a bold word and an
italic word. Then a fenced code block in ts with two lines. Then a bullet list with three items. Then a
two column table with two rows. No tools.`

`scratch/ccs-t5/t5-markdown.txt` (rows 16–35):

```
⏺ 示例回复

  这是一个 加粗 且 斜体 的词。

  const greeting: string = "你好，moss";
  console.log(greeting);

  - 第一项：格式按要求组织
  - 第二项：不调用任何工具
  - 第三项：中文回复并保留技术术语

  ┌──────┬─────────────────────────────┐
  │ 项目 │            说明             │
  ├──────┼─────────────────────────────┤
  │ moss │ 跨平台 coding agent harness │
  ├──────┼─────────────────────────────┤
  │ TUI  │ ink 全屏壳（v0.22 起）      │
  └──────┴─────────────────────────────┘

✻ Cooked for 4s · done 1:47 AM
```

- `# heading` → bold + italic + underline on the text (`示例回复` has flags `B I U` in the style file), no
  `#` shown.
- `**bold**` → bold attribute only; `*italic*` → italic attribute only (markers removed).
- Fenced code block → fences removed, body indented 2 spaces, syntax-highlighted using the **16-colour
  ANSI palette** (`fblue`, `fcyan`, `fred`, `fbrown` in the style file) rather than truecolor.
- Bullet list → `- ` markers preserved, default colour.
- Table → real box-drawing table (`┌─┬─┐ / │ / ├─┼─┤ / └─┴─┘`) with centred header cells, default colour.
- No horizontal-rule, blockquote or nested-list markdown was tested. **Not verified.**

## 11. Status / context indicators

Commands: `scratch/ccs-s9` (`/context`, `/usage`, `/autocompact`), `scratch/ccs-s7` (`/status`).

- **`/context`** (`scratch/ccs-s9/context-panel.txt`) prints a coloured usage grid plus a category
  breakdown:

  ```
  ❯ /context
    ⎿  Context Usage
       ⛀ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁   glm-5.3
       ⛁ ⛀ ⛀ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁ ⛁   37k/200k tokens (18%)
       ⛀ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶
       ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶   Estimated usage by category
       ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶   ⛁ System prompt: 1.4k tokens (0.7%)
       ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶   ⛁ System tools: 21.2k tokens (10.6%)
       ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶   ⛁ Custom agents: 157 tokens (0.1%)
       ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶ ⛶   ⛁ Memory files: 12.1k tokens (6.0%)
       ⛶ ⛶ ⛶ ⛝ ⛝ ⛝ ⛝ ⛝ ⛝ ⛝   ⛁ Skills: 2.1k tokens (1.0%)
       ⛝ ⛝ ⛝ ⛝ ⛝ ⛝ ⛝ ⛝ ⛝ ⛝   ⛁ Messages: 46 tokens (0.0%)
                             ⛶ Free space: 130k (65.0%)
                             ⛝ Autocompact buffer: 33k tokens (16.5%)

       Auto-compact window: 200k tokens (default for an unrecognized model)

       Custom agents · .claude/agents/
       └ 3 agents · 157 tokens

       Memory files · /memory
       └ 4 files · 12.1k tokens

       Skills · /skills
       └ 43 skills · 2.1k tokens

       /context all to expand

        Suggestions
        ℹ Memory files using 12.1k tokens (6%) → save ~3.6k
          Largest: ~/AGENTS.md (6.7k), ~/Desktop/RDK_Studio/moss/AGENTS.md (4.4k),
       ~/.claude/projects/-Users-d-robotics-Desktop-RDK-Studio-moss/memory/MEMORY.md (907). Use
       /memory to review and prune stale entries.
  ```

- **`/usage`** (`scratch/ccs-s9/usage.txt`) is a tabbed panel (`Settings  Status   Config   Usage   Stats`)
  over a session block: `Total cost: $0.0000`, `Total duration (API): 0s`,
  `Total duration (wall): 15s`, `Total code changes: 0 lines added, 0 lines removed`,
  `Usage: 0 input, 0 output, 0 cache read, 0 cache write`, footer `Esc to cancel`.
- **`/status`** (`scratch/ccs-s7/status.txt`) prints a two-column key/value block: `Version: 2.1.285`,
  `Session name: /rename to add a name`, `Session ID: …`, `Session kind: interactive`,
  `Peer address: uds:/tmp/cc-socks/24733.sock`, `cwd: …`, `Auth token: ANTHROPIC_AUTH_TOKEN`,
  `Anthropic base URL: …`, `Model: glm-5.3`, `MCP servers: 1 failed · /mcp`, `Setting sources: User settings`,
  `Managed settings (remote): not fetched …`, `Organization policy: …`, `Auto mode server: Disabled`,
  footer `Esc to cancel`.
- **`/autocompact`** (`scratch/ccs-s9/autocompact.txt`) configures the auto-compact threshold:

  ```
    Auto-compact window
    Current setting: 200k tokens (default for an unrecognized model)

    This command configures when auto-compaction happens. The actual threshold is the minimum of
    this setting and your model's maximum context window.

    The auto setting picks a window tuned for your model and is strongly recommended for the best
    cost and performance. You can override it below.

    Select auto-compact window: auto

    ←/→ to adjust · Enter to apply · Esc to cancel
  ```

- The status row above the top rule carries a right-aligned effort indicator, e.g. `● high · /effort`
  (`scratch/ccs-a1c/c-boot-90x30.txt`), which is composable with other badges
  (`● high · /effort · › stashed`, `scratch/ccs-s10/stash.txt`).
- **Auto-compact notice** (the message shown when compaction actually triggers): **not verified** — no
  session came close to the 200k window. Only its configuration surface and reserved buffer
  (`Autocompact buffer: 33k tokens (16.5%)`) were observed.

## 12. Session lifecycle

Commands: `scratch/ccs-s8b` (`--resume`), `scratch/ccs-s12` (`/clear`, in-session `/resume`),
`scratch/ccs-t5` (Esc Esc → Rewind), `scratch/ccs-s8a/-s8c` (Ctrl+C), `scratch/ccs-s7` (Ctrl+D),
`scratch/ccs-s9` (`/exit`).

- **Startup resume picker** (`$CC --args=--resume …`, `scratch/ccs-s8b/resume.txt`):

  ```
  ────────────────────────────────────────────────────────────────────────────────────────────────────
    Resume session (1 of 36)
    ╭──────────────────────────────────────────────────────────────────────────────────────────────╮
    │ ⌕ Search…                                                                                    │
    ╰──────────────────────────────────────────────────────────────────────────────────────────────╯
      moss

    ❯ (session)
      now · main · 3.8KB

      (session)
      28 seconds ago · main · 3.1KB
      … (2 more entries elided)
      ! ls
      1 minute ago · main · 120.1KB

      tui-drive
      2 minutes ago · main · 143.8KB
    ↓ (session)
      3 minutes ago · main · 4.9KB

      Ctrl+A to show all projects · Ctrl+B to only show current branch · Ctrl+W to show all
      worktrees · Space to preview · Ctrl+R to rename · Type to search · Esc to cancel
  ```

  Entries are grouped per project, titled by their first prompt (or `(session)`), with
  `<relative time> · <branch> · <size>`; `❯` is the selection, `↓` the overflow marker; `Esc` cancels
  (process exited code=1).

- **In-session `/resume`** (`scratch/ccs-s12/resume-in-session.txt`) shows the same picker with live
  titles (`demo/alpha.ts 的 subtract 函数规划`, `TodoWrite 重构待办清单`, `Markdown 格式演示`) and, on
  `Esc`, prints the command result `⎿ Resume cancelled` under `❯ /resume`.
- **`/clear`** (`scratch/ccs-s12/clear-done.txt`) empties the transcript (banner stays, a single
  `❯ /clear` line remains) and restores the empty-composer chrome.
- **Esc Esc → Rewind** (`scratch/ccs-t5/t5-escesc.txt`) opens a full-width checklist panel:

  ```
  ▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔
     Rewind

     Restore the code and/or conversation to the point before…

       Reply with markdown only. Use a heading. Then a bold word and an italic word. Then a fenced code bl…
       No code changes

     ❯ (current)


     Enter to continue · Esc to cancel
  ```

- **Interrupt while running**: the hint line becomes `⏸ manual mode on · esc to interrupt · ← for agents`
  and a spinner line appears above it (`✢ Elucidating…`, `✢ Burrowing…`, `✳ Gusting… (6s · thinking)`) —
  see `scratch/ccs-s5b/bash-perm.txt`, `scratch/ccs-s5a2/at-enter.txt`, `scratch/ccs-s5b/bash-ran.txt`.
  Only the single-`Esc` interrupt hint was observed; whether Esc twice during a run means anything
  different was **not verified**.
- **Ctrl+C**: one press at an empty composer produced no visible state change two seconds later
  (`scratch/ccs-s8a/ctrlc1.txt`); a second press 2 s later still did not exit
  (`ctrlc2.txt`). Two presses 0.35 s apart **did exit** — the harness printed
  `[harness] process exited code=0 after shot:ctrlc-rapid` (`scratch/ccs-s8c`). So exit requires a rapid
  double press; the exact window is **not verified**.
- **Ctrl+D**: a single press at an empty composer did **not** exit
  (`scratch/ccs-s7/after-ctrld.txt`; the process was still alive when the harness later sent Ctrl+C).
  **Not verified** as an exit key.
- **`/exit`**: exits cleanly — harness printed `[harness] process exited code=0 after wait:2000`
  (`scratch/ccs-s9`).

## 13. Slash command inventory

Two independent captures agree exactly on **109 commands**:

1. `scratch/ccs-walk` — filter-free menu walk (`/` then 140 × `up`, shot per press).
2. `scratch/ccs-help` + `scratch/ccs-help2` — the `/help` panel's `Commands` tab (80 commands, walk with
   80 × `down`) and `Custom commands` tab (29 more, walk with 45 × `down`). The panel labels itself
   `Browse default commands` / `Browse custom commands` and shows overflow counters
   (`↓ 68 more below`, `↓ 14 more below`).

The `/help` panel tabs themselves (`scratch/ccs-s10/help-panel.txt`):

```
▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔▔
   Help  General   Commands   Custom commands

   Claude understands your codebase, makes edits with your permission, and executes commands —
   right from your terminal.

   New here? Run /powerup to learn the features most people miss.

   Shortcuts
   ! for shell mode          double tap esc to clear input        ctrl + shift + _ to undo
   / for commands            shift + tab to auto-accept edits     ctrl + z to suspend
   @ for file paths          ctrl + o for verbose output          ctrl + v to paste images
   /btw for side question    ctrl + t to toggle tasks             opt + p to switch model
                             \⏎ for newline                       ctrl + s to stash prompt
                                                                  ctrl + g to edit in $EDITOR
                                                                  /keybindings to customize

   For more help: https://code.claude.com/docs/en/overview

   Something else? Use /feedback to report bugs or request features.

   Esc to cancel
```

Full inventory. Names and descriptions are verbatim from the panel, including its own truncation `…`;
only the column padding was normalised (the panel pads the name column to a fixed width, this list pads
to a common column). Source of truth: `scratch/ccs-inventory-union.tsv`, produced by merging the two
`/help` tab walks, and it agrees name-for-name with the independent `/`-menu walk (`scratch/ccs-walk`).

**Built-in `Commands` tab (80)** — `scratch/ccs-help`:

```text
/add-dir                        Add a new working directory
/artifact-diagramming           Diagramming know-how for Artifacts - when a picture earns its place, how to draw one that shows the…
/autocompact                    Set how full the context gets before auto-summarizing
/background                     Send this session to the background and free the terminal
/batch                          Research and plan a large-scale change, then execute it in parallel across 5–30 isolated worktree a…
/branch                         Create a branch of the current conversation at this point
/btw                            Ask a quick side question without interrupting the main conversation
/bug                            Report a bug or share your conversation
/cd                             Move this session to a new working directory
/claude-api                     Reference for the Claude API / Anthropic SDK — model ids, pricing, params, streaming, tool use, MCP…
/clear                          Start a new session with empty context; previous session stays on disk (resumable with /resume)
/code-review                    Review the current diff, or a PR number/branch/path target, for correctness bugs (plus reuse/simpli…
/color                          Set the prompt bar color for this session
/compact                        Free up context by summarizing the conversation so far
/config                         Open settings
/context                        Visualize current context usage as a colored grid
/copy                           Copy Claude's last response to clipboard (or /copy N for the Nth-latest)
/dataviz                        Use this skill whenever you are about to create ANY chart, graph, plot, dashboard, or data visualiz…
/debug                          Enable debug logging for this session and help diagnose issues
/deep-research                  Deep research harness — fan-out web searches, fetch sources, adversarially verify claims, synthesiz…
/design                         Grant or revoke Claude agent access to your Design projects
/design-login                   Authorize design-system access for /design-sync with your claude.ai account
/design-sync                    Push a React design system to claude.ai/design. This runs a converter that bundles the real compone…
/diff                           Toggle the diff panel showing uncommitted changes
/doctor                         Health-check the user's Claude Code setup and fix issues: diagnose installation health — what the `…
/effort                         Set effort level for model usage
/exit                           Exit the CLI
/export                         Export the current conversation to a file or clipboard
/fast                           Toggle fast mode (Opus)
/feedback                       Send feedback to Anthropic or report a bug
/fewer-permission-prompts       Scan your transcripts for common read-only Bash and MCP tool calls, then add a prioritized allowlis…
/focus                          Toggle focus view: just your prompt, summary, and response
/fork                           Copy this conversation into a new background session and keep working here
/goal                           Set a goal Claude checks before stopping
/help                           Show help and available commands
/hooks                          View hook configurations for tool events
/ide                            Manage IDE integrations and show status
/import                         Import config from another AI coding agent
/init                           Initialize a new CLAUDE.md file with codebase documentation
/insights                       Generate a report analyzing your Claude Code sessions
/keybindings                    Open your keyboard shortcuts file
/list-agents                    List subagents, teammates, and other Claude sessions you can message
/login                          Sign in with your Anthropic account
/logout                         Sign out from your Anthropic account
/loop                           Run a prompt or slash command on a recurring interval (e.g. /loop 5m /foo). Omit the interval to le…
/mcp                            Manage MCP servers
/memory                         Edit CLAUDE.md files and memory settings
/mobile                         Show QR code to download the Claude mobile app
/model                          Set the AI model for Claude Code (currently glm-5.3)
/output-style                   List output styles or switch to one
/permissions                    Manage allow and deny tool permission rules
/plan                           Enable plan mode or view the current session plan
/plugin                         Manage Claude Code plugins
/powerup                        Discover Claude Code features through quick interactive lessons
/radio                          Listen to Claude FM lo-fi radio
/recap                          Generate a one-line session recap now
/release-notes                  View release notes
/reload-plugins                 Activate pending plugin changes in the current session
/reload-skills                  Pick up skills added or changed on disk during this session
/rename                         Rename the current conversation
/resume                         Resume a previous conversation
/rewind                         Restore the code and/or conversation to a previous point
/run                            Launch and drive this project's app to see a change working. Use when asked to run, start, or scree…
/run-skill-generator            Author or improve the run-<unit> skill - a per-project skill that tells agents how to build, launch…
/sandbox                        ◯ sandbox disabled (⏎ to configure)
/scroll-speed                   Adjust mouse wheel scroll speed
/security-review                Complete a security review of the pending changes on the current branch
/simplify                       Review the changed code for reuse, simplification, efficiency, and altitude cleanups, then apply th…
/skills                         List available skills
/status                         Show Claude Code status including version, model, account, API connectivity, and tool statuses
/statusline                     Set up Claude Code's status line UI
/stickers                       Order Claude Code stickers
/subtask                        Send a subagent off with your full context; its result comes back here
/tasks                          View and manage everything running in the background
/team-onboarding                Help teammates ramp on Claude Code with a guide from your usage
/terminal-setup                 Install Shift+Enter key binding for newlines
/theme                          Change the theme
/tui                            Set the terminal UI renderer (default | fullscreen)
/update-config                  Use this skill to configure the Claude Code harness via settings.json. Automated behaviors ("from n…
/usage                          Show session cost, plan usage, and activity stats
```

**`Custom commands` tab (29)** — `scratch/ccs-help2`:

```text
/agent-browser                  Browser automation CLI for AI agents. Use when the user needs to interact with websites, including …
/aily-cli-runtime               检查本机 Aily CLI runtime、daemon 与 adapter 的只读运行状态。用户要求自查、诊断安装或确认 adapter …
/architecture-patterns          Implement proven backend architecture patterns including Clean Architecture, Hexagonal Architecture…
/chorus:brainstorm              (chorus) Optional divergent-then-convergent dialogue for fuzzy ideas. Invoked from the idea skill a…
/chorus:chorus                  (chorus) Chorus AI Agent collaboration platform — overview, common tools, setup, and routing to sta…
/chorus:develop                 (chorus) Chorus Development workflow — claim tasks, report work, manage sessions, and integrate wit…
/chorus:idea                    (chorus) Chorus Idea workflow — claim ideas, run elaboration rounds, and prepare for proposal creat…
/chorus:openspec-aware          (chorus) Opt-in OpenSpec-mode authoring for Chorus PM workflows in Claude Code. Detects the local `…
/chorus:proposal                (chorus) Chorus Proposal workflow — create proposals with document and task drafts, manage dependen…
/chorus:quick-dev               (chorus) Quick Task workflow — skip Idea→Proposal, create tasks directly, execute, and verify.
/chorus:review                  (chorus) Chorus Review workflow — approve/reject proposals, verify tasks, and manage project govern…
/chorus:yolo                    (chorus) Full-auto AI-DLC pipeline — from prompt to done. Automates the entire Idea -> Proposal -> …
/code-review:code-review        (code-review) Code review a pull request
/executing-plans                Use when you have a written implementation plan to execute in a separate session with review checkp…
/frontend-design                Create distinctive, production-grade frontend interfaces with high design quality. Use this skill w…
/grill-with-docs                Grilling session that challenges your plan against the existing domain model, sharpens terminology,…
/handoff                        Compact the current conversation into a handoff document for another agent to pick up. (user)
/impeccable                     Use when the user wants to design, redesign, shape, critique, audit, polish, clarify, distill, hard…
/improve-codebase-architecture  Find deepening opportunities in a codebase, informed by the domain language in CONTEXT.md and the d…
/javascript-testing-patterns    Implement comprehensive testing strategies using Jest, Vitest, and Testing Library for unit tests, …
/nodejs-backend-patterns        Build production-ready Node.js backend services with Express/Fastify, implementing middleware patte…
/qiaolong-autopilot             乔龙的全自动化执行协议（可执行）。当用户要求无人值守、夜跑、长跑、全自动完成任务，或发起 /loop、/go…
/qiaolong-mindset               乔龙的个人思考与操作方法论 —— 用第一性原理切入、思考清楚后落 spec 才动键盘、以证据代替论断、以沉没…
/rdk-docs                       Retrieves official D-Robotics RDK documentation from developer.d-robotics.cc. Forum posts are optio…
/requesting-code-review         Use when completing tasks, implementing major features, or before merging to verify work meets requ…
/robogo-quantization            Operates the RoboGO web quantization tool (robogo.d-robotics.cc/quantization-tools) to create X/S-s…
/systematic-debugging           Use when encountering any bug, test failure, or unexpected behavior, before proposing fixes (user)
/tdd                            Test-driven development with red-green-refactor loop. Use when user wants to build features or fix …
/writing-plans                  Use when you have a spec or requirements for a multi-step task, before touching code (user)
```

Alias annotations are part of the command rendering in the `/` menu: `/exit (quit)`,
`/rewind (undo)`, `/resume (continue)` (`scratch/ccs-s9/cont-menu.txt`), `/plugin (marketplace)`,
`/rename (name)`, `/chorus:yolo (yolo)`.

## A. Binary verification checklist — "moss MUST …"

Grouped by the 13 areas. Each line is testable by driving the moss CLI in a PTY and inspecting the
screen (screen text and/or cell attributes).

**A1 Layout & chrome**

1. moss MUST print a multi-line startup banner (wordmark + product name/version + model + working
   directory) before the transcript, and it MUST remain in the scrollback after the first turn.
2. moss MUST print transcript messages in one column with no persistent side panel, sidebar, or
   full-screen box in the normal state.
3. moss MUST prefix top-level agent messages with `⏺` and attached output/annotations with `⎿` indented
   2 spaces (continuation lines 5 spaces).
4. moss MUST separate transcript blocks with exactly one blank line.
5. moss MUST draw a full-width rule directly above the composer and another directly below it.
6. moss MUST show a left-indented (2 spaces) hint row below the composer containing the current mode.
7. moss MUST show contextual right-aligned status text on the row immediately above the top rule.
8. moss MUST show a composer prompt glyph `❯` followed by a space.
9. moss MUST show a contextual suggestion placeholder in the empty composer (not a static string).
10. moss MUST reflow banner/transcript/hint content at 80×24, 120×40 without breaking the composer
    (composer + 2 rules + hint always visible).
11. moss MUST degrade gracefully at ~10 rows: keep transcript tail + rules + composer + hint visible and
    let earlier content scroll away.

**A2 Composer / input editing**

12. moss MUST insert a newline (not submit) on Ctrl+J.
13. moss MUST insert a newline (not submit) on `\` followed by Enter.
14. moss MUST insert a newline on Shift+Enter when the terminal encodes it as `CSI 13;2u`.
15. moss MUST render multi-line input as continuation lines indented 2 spaces under `❯ `.
16. moss MUST support a movable cursor inside the composer (Left/Right) with insertion at the cursor.
17. moss MUST support Ctrl+A (line start) and Ctrl+E (line end).
18. moss MUST clear the whole composer on Ctrl+U and show a "Ctrl+Y to paste deleted text" hint.
19. moss MUST delete the previous word on Ctrl+W.
20. moss MUST clear the composer on a double tap of Esc.
21. moss MUST recall the previous submission on Up and render a `History n/N` rule above the composer.
22. moss MUST provide Ctrl+R prompt search with a search input box, match list, and a
    `↑/↓ to nav · Enter to use · Esc to cancel` footer.
23. moss MUST handle bracketed paste of multi-line text as literal content without submitting.
24. moss MUST stash the current prompt on Ctrl+S and mark it in the status row (`› stashed`).

**A3 Slash command menu**

25. moss MUST open a command menu when `/` is typed as the first character.
26. moss MUST list commands as `/name` + description, name column padded, description wrapping to the
    description column and truncated with `…` at the right edge.
27. moss MUST cap the visible menu window at roughly 5 rows and scroll it with Up/Down, independent of
    terminal height.
28. moss MUST highlight the selected command by foreground colour (distinct from the `#999999` of
    unselected rows) rather than by a background bar.
29. moss MUST render matched characters of the query in bold inside each row.
30. moss MUST filter the list as the user types after `/`, keeping the raw text in the composer.
31. moss MUST order filtered results by relevance/frecency rather than alphabetically.
32. moss MUST close the menu on Esc while keeping the composer text.
33. moss MUST show a right-aligned `Esc again to clear` affordance on a second Esc.
34. moss MUST move the selection one entry per Up/Down and wrap around at both ends.
35. moss MUST run the highlighted command on Enter (not merely complete it).

**A4 `@` mentions**

36. moss MUST open a mention menu when `@` starts a token and the composer is otherwise empty.
37. moss MUST mark directories with a trailing `/` and agents with `(agent) – <description>`.
38. moss MUST narrow mentions live as more characters are typed after `@`.
39. moss MUST close the mention menu on Esc while keeping the typed text.
40. moss MUST complete the highlighted mention into the composer on Tab, without running it.
41. moss MUST NOT open the mention menu when `@` is typed after existing text.

**A5 Bash mode**

42. moss MUST switch to shell mode when `!` is the first composer character.
43. moss MUST change the composer prompt glyph to `!` and colour the prompt/rules/hint with a distinct
    shell-mode colour.
44. moss MUST show the hint `! for shell mode` while in shell mode.
45. moss MUST execute the command on Enter and print `! <cmd>` plus `⎿`-indented output in the transcript.
46. moss MUST hand the shell result to the model in the same turn (spinner + `esc to interrupt`).
47. moss MUST document exactly three input prefixes: `!` shell, `/` commands, `@` file paths.

**A6 Permission dialogs / modes**

48. moss MUST render permission dialogs inline in the transcript (rule, bold title, target, dashed rules,
    question, numbered options, footer), not as a separate screen.
49. moss MUST name file-creation dialogs `Create file`, file-change dialogs `Edit file`, shell dialogs
    `Bash command`, and network dialogs `Fetch`.
50. moss MUST ask `Do you want to create <name>?` / `Do you want to make this edit to <name>?` /
    `Do you want to proceed?` / `Do you want to allow Claude to fetch this content?` respectively.
51. moss MUST always offer a plain `Yes` as option 1, a session/pattern "don't ask again" option, and a
    `No` option, with `❯` marking the selection.
52. moss MUST offer a "switch to accept edits for this session (shift+tab)" option on file dialogs and an
    "always allow access to <dir> from this project" option on shell dialogs.
53. moss MUST use the wording `No, and tell Claude what to do differently (esc)` on network dialogs.
54. moss MUST show the footer `Esc to cancel · Tab to amend` on file/shell dialogs and change option 1 to
    `Yes, and tell Claude what to do next` when Tab is pressed.
55. moss MUST NOT prompt for read-only shell commands, and MUST summarise them as `<n> shell command(s)`.
56. moss MUST cycle permission modes on shift+tab and display the active mode in the hint line.
57. moss MUST append `(shift+tab to cycle)` to every mode label except the default one.
58. moss MUST colour the mode label per mode and keep it visible at all times.

**A7 Plan mode / todos**

59. moss MUST enter plan mode via shift+tab and label it `plan mode on` in the hint line.
60. moss MUST render the plan in a bordered panel titled `Ready to code?` with `Here is Claude's plan:`.
61. moss MUST delimit the plan body with a dashed rule and show an overflow marker at the right edge when
    the plan is taller than the viewport.
62. moss MUST offer three plan decisions: proceed with auto mode, proceed with manual approval, or
    `Tell Claude what to change`, plus `shift+tab to approve with this feedback`.
63. moss MUST persist the plan to a file and print its path in the plan panel footer.
64. moss MUST keep todo rendering consistent with tool exposure: with a todo tool present it MUST render a
    live checklist whose marks change as work proceeds, and with no todo tool present it MUST render no
    checklist at all. (Parity fact: Claude Code 2.1.285 as installed takes the negative branch —
    `TodoWrite` is absent from its tool list, `scratch/ccs-t6`.)

**A8 Diff / edit rendering**

65. moss MUST render file edits as a diff with a right-aligned line-number gutter and a ` `/`+`/`-`
    marker column.
66. moss MUST render added rows with a dark-green row background and a green `+`.
67. moss MUST render removed rows with a dark-red row background and a red `-`.
68. moss MUST print a gain summary under the tool header (`Added N line(s)` / `Removed N line(s)`).
69. moss MUST syntax-highlight code inside the diff.

**A9 Long output & expansion**

70. moss MUST collapse tool activity to a one-line summary in the default view (`Ran 1 shell command`,
    `Read 1 file`) while keeping file-modification blocks fully rendered.
71. moss MUST toggle a detailed transcript on Ctrl+O showing full tool output.
72. moss MUST, in the detailed transcript, replace the composer with a footer
    `Showing detailed transcript · ctrl+o to toggle · ? for shortcuts` plus a right-aligned `verbose`.
73. moss MUST reveal the model's hidden reasoning in the detailed transcript.
74. moss MUST support toggling the background-task view with Ctrl+T.

**A10 Markdown rendering**

75. moss MUST render headings as bold+italic+underlined text without the `#`.
76. moss MUST render `**bold**` as bold and `*italic*` as italic with the markers removed.
77. moss MUST render fenced code blocks by removing the fences, indenting the body and syntax-highlighting it.
78. moss MUST render bullet lists with `- ` markers.
79. moss MUST render markdown tables as box-drawing tables with centred header cells.
80. moss MUST style each of these with cell attributes that survive on a colour terminal.

**A11 Status / context**

81. moss MUST expose a context-usage view (`/context`-equivalent) containing a grid, `used/total tokens (%)`,
    and a per-category token breakdown.
82. moss MUST show the auto-compact buffer as a named category in that breakdown.
83. moss MUST expose a usage/cost view with total cost, API duration, wall duration, code-change line
    counts and input/output/cache token counts.
84. moss MUST expose a status view with version, session id/kind, cwd, model, and MCP server health.
85. moss MUST expose an auto-compact threshold setting with `←/→ to adjust · Enter to apply · Esc to cancel`.
86. moss MUST show a right-aligned effort indicator (`● high · /effort`) above the composer and allow it
    to compose with other badges (`· › stashed`).
87. moss MUST label the context view's expansion affordance (`/context all to expand`) and show
    `/memory`, `/skills` style drill-down groups with an item count and token count.

**A12 Session lifecycle**

88. moss MUST provide a startup resume picker listing sessions grouped by project, each with a title
    (first prompt), relative age, branch, and size, plus a `⌕ Search…` box.
89. moss MUST document the picker keys in its footer
    (`Ctrl+A … Ctrl+B … Ctrl+W … Space to preview · Ctrl+R to rename · Type to search · Esc to cancel`).
90. moss MUST support `/resume` inside a session and report the cancellation as
    `⎿ Resume cancelled` when Esc is pressed.
91. moss MUST clear the transcript on `/clear` while keeping the banner.
92. moss MUST open a Rewind panel on Esc-Esc after a turn, listing restore points with
    `Enter to continue · Esc to cancel`.
93. moss MUST show `esc to interrupt` plus a spinner line while a turn is running.
94. moss MUST exit on a rapid double Ctrl+C (testable: process exit code 0).
95. moss MUST exit cleanly on `/exit`.
96. moss MUST NOT exit on a single Ctrl+D at an empty composer.

**A13 Slash command inventory**

97. moss MUST enumerate its complete command set in a `/help`-style panel with tabs
    (`Help · Commands · Custom commands`).
98. moss MUST show per-tab overflow counters (`↓ N more below`) while scrolling.
99. moss MUST list each command as `/name` on one line with an indented description line.
100.  moss MUST render `/`-menu and `/help` inventories from the same registry so the names agree exactly.
101.  moss MUST display alias annotations next to aliased commands (`/resume (continue)`, `/exit (quit)`).
102.  moss MUST keep sorting stable between the `/` menu and the `/help` list (both captures agreed on 109
      names on this machine).

## B. Explicitly not verified

- Whether Esc pressed twice during a running turn differs from one Esc (only `esc to interrupt` seen).
- The exact time window for the double-Ctrl+C exit.
- Image paste (Ctrl+V) with a real image — only the `ctrl + v to paste images` hint was captured.
- Ctrl+G edit-in-`$EDITOR`, Ctrl+Z suspend, Ctrl+Shift+\_ undo — documented by Claude Code only.
- Transcript search keys (Ctrl+F, `/` inside the detailed transcript) — no affordance found.
- The auto-compact notice text shown when compaction actually fires (context never filled).
- Behaviour of Ctrl+T with background tasks actually running.
- Diff truncation / `ctrl+o to expand` for very long diffs (2-line diffs only).
- Markdown features other than heading/bold/italic/code fence/bullet/table (blockquote, hr, nested list,
  links).
- The mention-menu fuzzy-match scoring rule (only an observed loose match).
- The exact ranking rule of the `/` command list (only observed ordering).
- TodoWrite/live-checklist rendering — the tool is absent from this install's tool list, so moss parity
  here must be decided by the team, not derived from this capture.
