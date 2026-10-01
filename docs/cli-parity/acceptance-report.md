# moss CLI-parity — adversarial acceptance report

> **STATUS: round 4 (final pass, dist 05:06, spec r3.2) is at §11 — SATISFIED.**
> Rounds 1–3 (§1–§10) filed and re-verified the defect list; round 4 confirms D-15's fix and closes
> the loop. Every item — D-1…D-15, N-1, N-2, N-4, SI-2 — is reproduced closed on the frozen build
> (width 0/189 979, grapheme 0/5 804, 20/20 specs, 28 load-bearing mutation checks). The only
> follow-up is bookkeeping: r3.2's C19 / §0.6 D-15 cells still say OPEN and should be flipped (§11.5).

**Reviewer:** `verify-cli` (task-8). I wrote none of the implementation and did not read the
implementers' summaries as evidence: every row below was re-derived from the **built** CLI
(`dist/`, built 02:43, newer than every `src/` file) in a real PTY, from the dist modules driven
directly, or from a named spec that I mutation-checked.

**Frozen contract reviewed:** [`target-spec.md`](target-spec.md) r2 (196 rows: 52 P0, 75 `done`).
**Snapshot reviewed:** the working tree as of 03:0x (uncommitted v0.22 single-column shell:
`src/cli/tui/{app,transcript,composer,markdown,mentions,palette,text,help}.ts`, `src/cli/approval-view.ts`).

---

## 1. Verdict

**NOT SATISFIED.** I cannot sign this off.

| verdict                   | count | note                                                                                    |
| ------------------------- | ----- | --------------------------------------------------------------------------------------- |
| audited rows              | 80    | union of the 52 P0 rows and the 75 `done` rows (47 P0⊆done)                             |
| PASS                      | 73    | re-produced in a PTY or by a mutation-checked spec                                      |
| FAIL                      | 5     | A6, C17, I3, I5, I14                                                                    |
| PARTIAL (blocks sign-off) | 2     | B15, F3 (spec itself calls F3 `partial`)                                                |
| CANNOT-VERIFY             | 0     | inside the 80; 1 outside (L14 Windows) + 5 surfaces listed in §7                        |
| defects                   | 13    | 4 high, 5 medium, 4 low (with minimal repros in §3)                                     |
| spec-integrity findings   | 5     | missing spec files, dead frozen interface, stale cells, unpassable §Acceptance commands |

The 73 PASSes are real: the single-column shell, the marks, the palette, mentions, shell mode,
the approval dialog, todos, markdown, the transcript diff gutter, interrupt/resume, the command
registry (M1) and Ctrl+O's _forward-only_ mode all work. The four high-severity defects are the
reason I will not sign off: three of them corrupt or block what the user sees, and one makes a
printed affordance lie.

Evidence root: every claim cites a dump under `scratch/` (driver output) or a command I ran.
Harness: `python3 scratch/tui-drive.py --cols C --rows R --out scratch/<dir> --steps '<DSL>'`,
zero-cost model turns served by a local OpenAI-compatible stub (`scratch/verify-stub.mjs`,
port 8791, scenario driven by the prompt text) so **no API quota was spent on any probe**.

---

## 2. Per-row verification

Legend: ✅ PASS · ❌ FAIL · ◐ PARTIAL. "stale" = the status column disagrees with the shipped code
in the direction that _understates_ the implementation (§0.3 says report it, not argue from it).

The tables list the 80 audited rows; the handful of rows marked “stale” that are **outside** that set
(H2, E1-E4, E6, E5) are extra observations from the same probes and are not part of the tally.

### §A Layout & chrome

| row | P   | spec    | verdict | evidence / note                                                                                                                                                             |
| --- | --- | ------- | ------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | P0  | done    | ✅      | 3-line banner at boot, kept in scrollback — `scratch/vA/boot90.txt`                                                                                                         |
| A3  | P0  | done    | ✅      | one column, no panel/box; `layout.ts`/`panels.ts`/`overlays.ts` deleted — `scratch/vA2/*`                                                                                   |
| A4  | P0  | done    | ✅      | `⏺` / `⎿  ` at 2-space base, 5-space continuation — `scratch/vF2/dialog.txt`, `vG/todos.txt`                                                                                |
| A5  | P0  | done    | ✅      | exactly one blank line before every block — all shots                                                                                                                       |
| A6  | P0  | done    | ❌      | rules are full width **until the terminal grows**: then they stay at the old width until the next keystroke (D-1) — `scratch/vA5/grown-noinput.txt` vs `grown-afterkey.txt` |
| A7  | P0  | partial | ✅      | stale in the good direction: the hint row now carries the mode (`⏸ default mode on`) — `scratch/vF9/m0..m3.txt`                                                             |
| A8  | P0  | done    | ✅      | right-aligned `model · N% ctx · N tokens` + `● running` / `● waiting for you` — `scratch/vK/turn.txt`, `vF2/dialog.txt`                                                     |
| A9  | P0  | done    | ✅      | `❯ ` prompt glyph — every shot                                                                                                                                              |

### §B Composer & editing

| row | P   | spec    | verdict | evidence / note                                                                                                                                                                     |
| --- | --- | ------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| B1  | P0  | done    | ✅      | Ctrl+J inserts a newline, does not submit — `scratch/vB/multiline.txt`                                                                                                              |
| B2  | P0  | done    | ✅      | `\` + Enter inserts a newline — `scratch/vB2/backslash.txt`                                                                                                                         |
| B3  | P0  | partial | ✅      | stale in the good direction: `CSI 13;2u` (Shift+Enter) inserts a newline — `scratch/vB3/shifte.txt`                                                                                 |
| B4  | P0  | done    | ✅      | 2-space continuation rows — `scratch/vB/multiline.txt`                                                                                                                              |
| B5  | P0  | done    | ✅      | mid-line insert at the caret: `abX▌c` after `abc`+←+`X` — `scratch/vB/caret.txt`                                                                                                    |
| B8  | P2  | done    | ✅      | Ctrl+K deletes to end of line — `scratch/vB/ctrlK.txt`                                                                                                                              |
| B12 | P0  | done    | ✅      | bracketed paste stages ONE message and does not submit; the model receives the newline — `scratch/vP2/staged.txt` + stub log `"paste-line-one\npaste-line-two"` (echo caveat: D-10) |
| B15 | P1  | done    | ◐       | windowing/caret are real, but the row can exceed the terminal width for VS16 emoji (D-3) → `scratch/vW1/withemoji.txt`                                                              |
| B16 | P0  | done    | ✅      | single column, `❯`, 2-space continuations, dim placeholder, no border                                                                                                               |
| B17 | P0  | done    | ✅      | same evidence as B1/B3                                                                                                                                                              |
| B18 | P0  | done    | ✅      | same evidence as B12                                                                                                                                                                |
| B22 | P1  | done    | ✅      | Ctrl+D on an empty composer exits with code 0 — `scratch/vCD.log` (`process exited code=0`)                                                                                         |

### §C Slash-command palette

| row | P   | spec    | verdict | evidence / note                                                                                      |
| --- | --- | ------- | ------- | ---------------------------------------------------------------------------------------------------- |
| C1  | P0  | done    | ✅      | `/` opens the menu — `scratch/vC/menu.txt`                                                           |
| C2  | P0  | done    | ✅      | name + one-line description, name padded, row clipped — `scratch/vC/menu.txt`                        |
| C4  | P0  | done    | ✅      | selected row `fcyan`+bold, no background bar (pyte `.style`) — `scratch/vC/menu.style`               |
| C6  | P0  | done    | ✅      | live filter `/co` → compact/context/doctor — `scratch/vC/filtered.txt`                               |
| C7  | P1  | done    | ✅      | fuzzy rank, not alphabetical — `/m` → model, mode, compact, permissions — `scratch/vM3/mpalette.txt` |
| C8  | P0  | done    | ✅      | Esc closes and keeps `/context` in the composer — `scratch/vC/escd.txt`                              |
| C10 | P0  | done    | ✅      | ↑/↓ move and wrap (spec + `/m` selection)                                                            |
| C11 | P0  | done    | ✅      | Tab completes `/context` without running it — `scratch/vC/completed.txt`                             |
| C12 | P0  | done    | ✅      | Enter runs the highlighted command (`/con`+Enter → `⏺ Context`) — `scratch/vFin/paletteenter.txt`    |
| C14 | P0  | done    | ✅      | same accent as C4                                                                                    |
| C15 | P0  | done    | ✅      | same evidence as C6/C11                                                                              |
| C16 | P0  | done    | ✅      | same evidence as C8/C10                                                                              |
| C17 | P0  | partial | ❌      | `/help` advertises 28 commands, the `/` menu offers 17; 11 advertised ones are undiscoverable (D-8)  |

### §D Mentions · §E Bash mode · §F Approvals

| row       | P   | spec    | verdict            | evidence / note                                                                                                                                                                                                       |
| --------- | --- | ------- | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1        | P1  | done    | ✅                 | `@` opens the menu with dirs-first — `scratch/vD2/mentions.txt`                                                                                                                                                       |
| D3        | P1  | done    | ✅                 | live narrowing `alp` → `alpha.ts` — `scratch/vD2/mfiltered.txt`                                                                                                                                                       |
| D4        | P1  | done    | ✅                 | Esc closes, text kept                                                                                                                                                                                                 |
| D5        | P1  | done    | ✅                 | Tab completes `@alpha.ts` into the composer — `scratch/vD2/mcompleted.txt`; Enter then sends it — `scratch/vME/sent.txt`                                                                                              |
| D6        | P2  | done    | ✅                 | `abc@x` opens nothing; `@` after a space does — `scratch/vD6/d6strict.txt`                                                                                                                                            |
| F1        | P0  | done    | ✅                 | rule, bold title, subject, dashed rules around the preview, question, numbered options, footer — `scratch/vF2/dialog.txt`                                                                                             |
| F2        | P0  | done    | ✅                 | `Create file` / `Edit file` / `Bash command` — `vF2`, `vH`, `vI2`                                                                                                                                                     |
| F3        | P0  | partial | ◐                  | create/edit/`Do you want to proceed?` wordings are real; the network wording is absent because `web_fetch` never prompts (reads as P1 missing, unchanged)                                                             |
| F4        | P0  | done    | ✅                 | `1 Yes` / `2 Yes, and don't ask again this session` / `3 No`, `❯` on the selection                                                                                                                                    |
| F8        | P0  | done    | ✅                 | `1`, `3`, `y`, `a`, Esc exercised in the PTY — `scratch/vF3..vF7`; `2`/`n` share the branch                                                                                                                           |
| F12       | P0  | done    | ✅                 | the structured dialog reaches the view (title/subject/detail/question) — but the frozen view-asker port is dead code (SI-2)                                                                                           |
| F14       | P0  | done    | ✅                 | `inferSideEffectClass` returns `local_write` when metadata is absent (`approval.ts:140`) + observed prompts                                                                                                           |
| F21       | P2  | done    | ✅                 | footer advertises only working keys; Tab in the dialog is a no-op — `scratch/vF2/aftertab.txt` ≡ `dialog.txt`                                                                                                         |
| F22       | P1  | done    | ✅                 | readonly `read_file` raised no dialog while `edit_file` did — `scratch/vH2/after.txt`                                                                                                                                 |
| F23       | P1  | done    | ✅                 | `Edit file` dialog shows `- y / + Y-new-line / + 中文新增行` — `scratch/vH/dialog.txt`                                                                                                                                |
| E1-E4, E6 | P1  | missing | ✅                 | stale in the good direction: `!` swaps the glyph/hint, tints the rules, runs the command and appends `! cmd` + `⎿` rows; `/help` documents the 3 prefixes — `scratch/vE/shellmode.txt`, `vE/fail.txt`, `vZ3/help.txt` |
| E5        | P1  | missing | ✅ (still missing) | the shell result is **not** handed to the model in the same turn — `scratch/vC1/shelllong.txt` shows no assistant row after `! seq 1 60`; `app.ts` documents this as deliberate                                       |

### §G Todo · §H Diff · §I Output & verbose · §J Markdown · §K Status · §L Session · §M Commands

| row | P   | spec    | verdict     | evidence / note                                                                                                                                                                                                               |
| --- | --- | ------- | ----------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1  | P1  | done    | ✅          | live `✓ ◐ ○` checklist + `1/4 done` headline above the composer — `scratch/vG/todos.txt`                                                                                                                                      |
| G2  | P2  | done    | ✅          | in-flight row loud, completed rows dim+green (`.style`), pending dim                                                                                                                                                          |
| G3  | P2  | done    | ✅          | `TODO_PANEL_MAX_ROWS = 6` + `… N more` (spec + code)                                                                                                                                                                          |
| H1  | P0  | done    | ✅          | diff in the dialog, CJK-safe — `scratch/vH/dialog.txt`                                                                                                                                                                        |
| H2  | P1  | partial | ✅ (stale)  | the transcript gutter **is** produced (line-number gutter, `+`/`-`, `@@`, CJK) — `scratch/vH2/after.txt`; it needs no `diffLinesForApproval` call because `edit_file` embeds a preview. Content is corrupted on `/diff` (D-4) |
| I1  | P0  | done    | ✅          | 3-line preview + `… N more lines · ctrl+o` — `scratch/vI2/collapsed.txt`                                                                                                                                                      |
| I3  | P1  | done    | ❌          | Ctrl+O changes **nothing** on rows already committed (D-5) — `scratch/vI2/collapsed.txt` ≡ `verbose.txt`                                                                                                                      |
| I5  | P1  | done    | ❌          | reasoning appears only if verbose was on _before_ the row was committed — `scratch/vI5/quiet.txt` vs `verbose.txt`                                                                                                            |
| I10 | P0  | done    | ✅          | spinner + elapsed + `Esc to interrupt` — `scratch/vL/running.txt`                                                                                                                                                             |
| I13 | P0  | done    | ✅          | one column, prefix-distinguished — all shots                                                                                                                                                                                  |
| I14 | P0  | done    | ❌          | the `… N more lines · ctrl+o` marker's promise is unreachable for rendered output (same as I3)                                                                                                                                |
| J1  | P0  | done    | ✅          | headings/bullets/table/fence/hr/blockquote render, no raw `**`, `\|`, fences — `scratch/vJ/markdown.txt`                                                                                                                      |
| J3  | P1  | done    | ✅          | `┌ ts ───` / `└───` frame, body verbatim                                                                                                                                                                                      |
| J4  | P1  | done    | ✅          | pure `*italic*` row carries `italic: true` and reaches ink (`app.ts` `inkLine`); a bold+italic row drops italic by design (D-12)                                                                                              |
| J5  | P1  | done    | ✅          | markers kept, 2-cell nesting — `scratch/vJ/markdown.txt`                                                                                                                                                                      |
| J6  | P1  | done    | ✅          | box table, centred header, CJK columns align (`│ 中文  │ 2 …`)                                                                                                                                                                |
| J7  | P0  | done    | ✅          | width fuzz (187 639 line checks, 21 widths, 22 adversarial samples): `renderMarkdown` never overflows at any width ≥5 and never throws — `scratch/verify-width-audit.mjs`                                                     |
| J9  | P0  | done    | ✅          | `text_delta` streams into the live region — `scratch/vL/running.txt`                                                                                                                                                          |
| J10 | P1  | done    | ✅ (caveat) | inline-code cyan only on a whole-line code row; mixed prose loses it (D-12)                                                                                                                                                   |
| J12 | P1  | done    | ✅          | `tui-markdown` covers fenced blocks and is mutation-sensitive                                                                                                                                                                 |
| K1  | P0  | done    | ✅          | `0% ctx` from `llm_usage.contextTokens` — `scratch/vK/turn.txt`                                                                                                                                                               |
| K3  | P0  | done    | ✅          | `1.3k tokens` = 1234+56                                                                                                                                                                                                       |
| K5  | P1  | done    | ✅          | `applyAgentEvent` `case 'compaction'` → `summary` row; `tui-run-state` asserts it and is mutation-sensitive. Not PTY-exercised (no compaction event was produced)                                                             |
| L1  | P1  | done    | ✅          | `--continue` replayed the prior conversation (`resumed — replayed 4 rows`) — `scratch/vL1/replayed.txt`                                                                                                                       |
| L7  | P0  | done    | ✅          | `Esc to interrupt` + spinner — `scratch/vL/running.txt`                                                                                                                                                                       |
| L8  | P0  | done    | ✅          | Esc aborts the run — `scratch/vL/afteresc.txt`                                                                                                                                                                                |
| L10 | P0  | done    | ✅          | `/exit` → exit code 0 — `scratch/vLx2.log`                                                                                                                                                                                    |
| L13 | P0  | done    | ✅          | `MOSS_NO_TUI=1` in a PTY → readline REPL — `scratch/vNT/repl.txt`                                                                                                                                                             |
| L16 | P0  | done    | ✅          | prompt + completed rows survive the interrupt — `scratch/vL/afteresc.txt`                                                                                                                                                     |
| M1  | P0  | missing | ✅ (stale)  | all 28 advertised commands are dispatched; 23 exercised back-to-back in a PTY with **0** “unknown command” — `scratch/vM1/all.txt`, `vS`, `vX`, `vP`, `vDf`                                                                   |
| M5  | P2  | done    | ✅          | hidden commands rank last but are present (`/compact` visible in `/m`)                                                                                                                                                        |
| M8  | P1  | done    | ✅          | `✽ Thinking… (4s · 1 queued)` + hint `1 queued` — `scratch/vQ/queued.txt`                                                                                                                                                     |
| M9  | P2  | done    | ✅          | `/steer keep it short` during a run → `⏺ Steer / queued: keep it short` — `scratch/vQ/steer.txt`                                                                                                                              |

### Rows outside the audited set that the spec already declares `missing`/`partial`

I confirmed the _absence_ of A2, A10-A23, B6/B7/B9-B11/B13/B14/B19-B21, C3/C5/C9/C13/C18, D2/D7/D8,
F5/F6/F7/F9-F11/F13/F15-F20, G4-G9, H3-H9, I2/I4/I6-I9/I11/I12/I15, J2/J8/J11, K2/K4/K6-K15,
L2-L6/L9/L11/L12/L14/L15/L17-L23, M2-M4/M6/M7/M10-M12 where the table says so — **except** the
stale cells listed in SI-3, which are implemented already.

---

## 3. Defects (severity-ordered, minimal repros)

Each repro is a real command with a captured dump. `$PTY` = `python3 scratch/tui-drive.py`;
the stub config is `scratch/verify-config.json` (`MOSS_CONFIG_FILE`), which needs
`node scratch/verify-stub.mjs 8791` running.

### D-1 — HIGH — terminal resize is ignored until the next keystroke; shrinking corrupts the frame

```bash
$PTY --cols 80 --rows 24 --out scratch/vA5 --env "MOSS_CONFIG_FILE=$CFG" \
  --steps 'wait:2500,resize:120x40,wait:2500,shot:grown-noinput,text:x,wait:800,shot:grown-afterkey,key:ctrl-c'
```

- **Observed:** at `grown-noinput` every rule, the status row and the composer are still **80**
  cells wide in a 120-wide terminal; `grown-afterkey` (after one keystroke) is correctly 120 wide.
  Shrinking 120→80 (`scratch/vA2/80wait.txt`) leaves the old 120-wide chrome **and** the new
  80-wide chrome on screen at once, with an orphan status row and a stray 40-cell rule fragment.
- **Expected:** reflow on `SIGWINCH` with no user input. The reference CLI on the same harness
  (`$PTY --realhome --bin /opt/homebrew/bin/claude`, `scratch/vA-ref/`) repaints cleanly at 80 and
  120 — so this is the app, not the harness.
- **Root cause:** `app.ts` reads `columns = stdouts(stdout)` during a React render; ink's `resized`
  handler only re-runs layout + output, so the stale `columns` value survives until some state
  change forces a re-render (the spinner hides this during a run).
- **Spec:** A11 (partial), A6, and the §Acceptance §A command, which asserts “banner + rules +
  composer + hint present at all three sizes” — it fails as written.

### D-2 — HIGH — Ctrl+C during an approval leaves a zombie modal that blocks the composer

```bash
$PTY --cols 100 --rows 40 --workspace scratch/verify-ws --env "MOSS_CONFIG_FILE=$CFG" \
  --steps 'wait:2200,text:write a file now,key:enter,wait:6000,key:ctrl-c,wait:2500,shot:after,key:ctrl-c'
```

- **Observed** (`scratch/vF7/after.txt`): the run is over (`✻ Probing for 6s · interrupted`,
  `⎿ FAILED — … aborted_by_user`), but the dialog is still on screen with `Do you want to create
demo-write.txt?` / `❯ 1. Yes`, the status still says `● waiting for you`, and the hint still says
  `1/2/3 to answer`. Every subsequent keystroke is swallowed by the approval branch until the user
  answers the dead prompt.
- **Expected:** abort resolves the pending approval (deny + clear the dialog + `setApprovalPending(false)`).
- **Root cause:** the abort path never touches `pendingApprovalRef`/`setApproval`; only the unmount
  cleanup does (`app.ts:392-424`).
- **Spec:** F1/F8/F12 approval state machine; §Acceptance §F.

### D-3 — HIGH — the composer emits a line wider than the terminal for VS16 emoji

```bash
# cols=30: 27 'a' + U+2764 U+FE0F
$PTY --cols 30 --rows 20 --env "MOSS_CONFIG_FILE=$CFG" \
  --steps "wait:2200,text:aaaaaaaaaaaaaaaaaaaaaaaaaaa,shot:ctrl27,raw:E29DA4EFB88F,shot:withemoji,key:ctrl-c"
```

- **Observed:** `ctrl27` is one composer row; `withemoji` hard-wraps — `❯` alone on one row and
  `aaaaaaaaaaaaaaaaaaaaaaaaaaa❤` on the next, pushing the bottom chrome down (`scratch/vW1/`).
- **Expected:** the row stays inside the width (Claude Code wraps the same input).
- **Root cause:** `composer.ts` `wrapSpans`/`caretAt`/`offsetAt` sum `displayWidth` **per code point**;
  `'❤' + '\uFE0F'` sums to 1 while `displayWidth('❤️')` is 2 → the row is under-counted by one cell
  per emoji-presentation sequence (ZWJ families over-count and wrap early).
- **Fuzz evidence:** `node scratch/verify-width-audit.mjs` → 421 overflows, all in
  `renderComposer`/`composerEditor` (plus degenerate width-4 markdown); the only non-degenerate
  sample is `variation`. `renderMarkdown` is clean.
- **Spec:** B15 (P1 `done`), the cell-width contract behind J7/§0.3. `test/tui-composer.spec.mjs`
  covers CJK and a single-code-point emoji (📷) only, which is why this slipped through.

### D-4 — HIGH — `/diff` and `!` shell output silently corrupt long tokens, and `/diff` drops the head of a large diff

```bash
# A: in the moss repo itself
$PTY --cols 110 --rows 40 --workspace "$PWD" --env "MOSS_CONFIG_FILE=$CFG" \
  --steps 'wait:2500,text:/diff,key:enter,wait:4000,shot:diff,key:ctrl-c'
# B: the same helper, directly
$PTY --cols 100 --rows 30 --workspace scratch/verify-ws --env "MOSS_CONFIG_FILE=$CFG" \
  --steps 'wait:2200,text:! echo +process.env.MOSS_NO_BUNDLED_DEFAULT,key:enter,wait:1800,shot:bangcorrupt,key:ctrl-c'
```

- **Observed A** (`scratch/vDf/diff.txt`): the displayed diff contains
  `-import { TaskRuntime } from '../dist/core/task-runti me/runtime.js';`,
  `+process.env.MOSS_NO_BUN DLED_DEFAULT = '1';`, `'../dist/cli/tui/ help.js'`, and the **first
  visible line is a mid-line fragment** (`1  ldTuiHelpText } from …`) because the header was dropped.
- **Observed B** (`scratch/vFin/bangcorrupt.txt`): `! echo +process.env.MOSS_NO_BUNDLED_DEFAULT`
  prints `+process.env.MOSS_NO_BUN DLED_DEFAULT`.
- **Expected:** the transcript shows what the command actually printed; a truncation is announced.
- **Root cause (two, both in `src/cli/repl-process.ts`):**
  1. `runLocalShellCommand` pushes every chunk through `sanitizeRenderableText`
     (`repl-process.ts:72`) whose `breakLongTokens` inserts a space every 24 chars in any
     space-free run ≥33 chars that is not “copy-sensitive”. A leading `+`/`-`/quote defeats the
     copy-sensitive guard, so **diff lines are exactly the input that gets mangled**
     (reproduced directly against `dist/cli/terminal-text.js`).
  2. `appendLimited` keeps the **last** 40 000 chars (`repl-process.ts:6-14`), so a large
     `git diff` silently loses its `diff --git`/`---`/`+++`/`@@` head — which also destroys the
     gutter's line numbers (they become a synthetic 1,2,2,3… run).
- **Spec:** E4 (P1 `done`), M1/H2/H3, and the §Acceptance §M expectation that `/diff` shows the
  working-tree changes. Related low-severity rendering quirk: D-11.

### D-5 — MEDIUM-HIGH — the `ctrl+o` affordance printed in the transcript does nothing

```bash
$PTY --cols 100 --rows 34 --workspace scratch/verify-ws --env "MOSS_CONFIG_FILE=$CFG" \
  --steps 'wait:2200,text:run seq 1 200 now,key:enter,wait:6000,text:1,wait:8000,shot:collapsed,key:ctrl-o,shot:verbose,key:ctrl-c'
$PTY ... --steps 'wait:2200,key:ctrl-o,text:run seq 1 200 now,key:enter,wait:6000,text:1,wait:8000,shot:verbose-first,...'
```

- **Observed:** `scratch/vI2/collapsed.txt` ≡ `scratch/vI2/verbose.txt` byte-for-byte (the marker
  `… 150 more lines · ctrl+o` stays, the output stays collapsed). With ctrl+o pressed _before_ the
  run, the full output is committed (`scratch/vI3/verbose-first.txt`), and toggling it off does not
  re-collapse.
- **Expected:** pressing the advertised key reveals the hidden lines (R1 §9; I3/I14 are P0/P1 `done`).
- **Root cause:** committed rows live in ink `<Static>`, which never re-renders existing items when
  `verbose` flips — the toggle is forward-only, so the printed hint is a false affordance.
- **Spec:** I3, I14 (both `done`), I4 (`partial` — confirmed still silent: no `VERBOSE_FOOTER`, no
  right-aligned `verbose` marker in either shot).

### D-6 — MEDIUM — assistant prose across a tool call is concatenated into one run-on line

```bash
$PTY --cols 100 --rows 40 --workspace scratch/verify-ws --env "MOSS_CONFIG_FILE=$CFG" \
  --steps 'wait:2200,text:make a todo list with four items,key:enter,wait:7000,shot:todos,key:ctrl-c'
```

- **Observed:** `⏺ Planning the refactor.Todo list is live.` (`scratch/vG/todos.txt`) and
  `⏺ Reading first.Editing now.Edit complete.` (`scratch/vH2/after.txt`).
- **Expected:** separate paragraphs/rows — the pre-tool text belongs to the step that announced the
  tool call, the post-tool text to the answer.
- **Root cause:** `applyAgentEvent` accumulates every `text_delta` of a run into one
  `streamingText`, and `endRun` commits it as a single `assistant` row.
- **Spec:** I13 (one column, prefix-distinguished), J1, A5.

### D-7 — MEDIUM — one Ctrl+C on an idle composer quits and destroys the draft, while `/help` promises “press again to quit”

```bash
$PTY --cols 100 --rows 32 --env "MOSS_CONFIG_FILE=$CFG" --steps 'wait:2000,text:draft,key:ctrl-c'
```

- **Observed:** process exits 0 on the first press; the draft is gone (`scratch/vB21.log`).
  During a run the two-press behaviour is real (`scratch/vCC.log`: first press aborts, second exits).
- **Expected:** first press clears/cancels, second quits (B21/L9), or the help text says the truth.
- **Spec:** B21, L9 (P2 `missing`, §Z5 keeps Ctrl+D), but `tui/help.ts` is declared the single source
  of truth for advertised keys — and it advertises the unimplemented behaviour.

### D-8 — MEDIUM — the `/` menu and `/help` come from two registries and disagree

```bash
node -e "… HELP_COMMANDS ∩ commandRowsForSlashInput('/') …"   # see scratch/ for the transcript
$PTY --cols 100 --rows 34 --env "MOSS_CONFIG_FILE=$CFG" --steps 'wait:2200,text:/m,wait:800,shot:mpalette,key:esc,key:ctrl-c'
```

- **Observed:** `/help` advertises 28 commands; the `/` menu renders 21 registry rows, and
  `app.ts` filters them to the 17 that both registries know. **11 advertised commands never appear
  in the menu**: `/tasks /history /evidence /deployments /failures /resume /queue /steer /bg /subs
/mcp`. (`/loop /goal /task /init` are in the REPL registry and filtered out, so the menu is honest
  — the surface is simply missing.) For `/m`, the menu shows model/mode/compact/permissions and no
  `/mcp`.
- **Expected:** M3 — one registry so `/` and `/help` can never disagree.
- **Spec:** M3 (P1 partial), C17 (P0 partial), §Z3 (the Task-OS commands are moss-specific and
  therefore especially hard to discover).

### D-9 — MEDIUM — a deliberate Esc interrupt is reported as a red bold error

```bash
$PTY --cols 100 --rows 30 --workspace scratch/verify-ws --env "MOSS_CONFIG_FILE=$CFG" \
  --steps 'wait:2200,text:run slow now,key:enter,wait:3000,shot:running,key:esc,wait:2000,shot:afteresc,key:ctrl-c'
```

- **Observed:** `⏺ This operation was aborted` rendered `fredB` (red + bold), followed by
  `✻ Thinking for 3s · interrupted` (`scratch/vL/afteresc.style`, `afteresc.txt`).
- **Expected:** a quiet interrupt line; the user's own action is not a failure.
- **Spec:** L15 (wants a fixed-wording interrupt line), I9 (colour the tool bullet by outcome).

### D-10 — LOW-MEDIUM — a multi-line paste/draft is echoed as one squashed line

```bash
$PTY --cols 100 --rows 30 --workspace scratch/verify-ws --env "MOSS_CONFIG_FILE=$CFG" \
  --steps 'raw:1b5b3230307e,text:paste-line-one,raw:0a,text:paste-line-two,raw:1b5b3230317e,wait:700,key:enter,wait:3000,shot:sent,...'
```

- **Observed:** `❯ paste-line-one paste-line-two` for both the pasted message and a Ctrl+J draft
  (`scratch/vP2/sent.txt`, `typed.txt`). The **model receives the newline correctly**
  (`scratch/verify-stub.log` → `"paste-line-one\npaste-line-two"`), so this is an echo/readability
  defect only.
- **Root cause:** `renderTranscriptRow('user')` calls `wrap()`, which collapses all whitespace
  (`text.replace(/\s+/g,' ')`).
- **Spec:** B4's multi-line grammar, A4, L23 (replay).

### D-11 — LOW — `+`/`-`-leading shell output is rendered as a diff with a fabricated gutter number

```bash
$PTY ... --steps 'wait:2200,text:! echo +process.env.MOSS_NO_BUNDLED_DEFAULT,key:enter,wait:1800,shot:bangcorrupt,key:ctrl-c'
```

- **Observed:** `⎿   1 +process.env.MOSS_NO_BUN DLED_DEFAULT` — a one-line `echo` is classified as a
  unified diff and gets a synthetic line number.
- **Cause:** `hasDiffLines` treats any leading `+`/`-` as a diff, and `parseDiffLines` numbers lines
  it never saw a hunk header for.
- **Spec:** H2/I1.

### D-12 — LOW — per-line single style loses inline emphasis on mixed lines

```bash
node --input-type=module -e "import('./dist/cli/tui/markdown.js').then(m=>…)"
```

- **Observed:** `` `npm run build` `` alone → `color: 'cyan'`; `use \`npm run build\` now`→ no colour;`**bold** and _italic_ mixed`→`bold`only (italic dropped, by design`italic = !bold && …`).
- **Expected per J4/J10 (`done`):** bold, italic and inline code all emphasised.
- **Spec:** J4, J10 — the shipped behaviour is a documented weakening
  (`inlineStyle` = “the row style that best represents a line”), and `tui-markdown.spec.mjs` encodes
  the weaker expectation (`mixed[0].color === undefined`).

### D-13 — LOW — at 24×8 an approval dialog pushes the question and option 1 off-screen

`scratch/vF8/tinyappr.txt`: the visible frame starts at `2. Yes, and don't as…`; the title, subject,
preview, question and `1. Yes` are above the viewport. The composer/hint stay visible, so it
degrades rather than corrupts — but a security prompt whose question is off-screen is worth a
height budget. Spec: A12.

---

## 4. Spec-integrity findings

**SI-1 — 6 of the 8 spec files §Acceptance requires do not exist.** §Acceptance names
`tui-approval-view`, `tui-bash-mode`, `tui-diff-render`, `tui-verbose`, `tui-mode-cycling`,
`tui-resume-picker`; none is in `test/`. The implementers created differently-named specs
(`tui-cell-width`, `tui-composer`, `tui-modes`, `tui-palette`, `tui-registry`, `tui-run-state`,
`tui-shell`) plus `tui-markdown`/`tui-mentions`. The eight _named_ gates therefore cannot be run as
the spec instructs; only the last two exist by name.

**SI-2 — the frozen approvals interface (N1/N2) is not what shipped.** `setCliApprovalViewAsker`,
`buildCliApprovalView`, `CLI_APPROVAL_OPTIONS` and `CLI_APPROVAL_FOOTER` have **no production
caller** (`grep -rn` over `src/`); the shell installs the legacy `setCliApprovalAsker` and reads the
third `dialog` argument, and `tui/transcript.ts` defines its own `ApprovalView`
(`question/title/subject/preview/cursor`) with the footer and option list **hard-coded**, contrary to
N2's “payload `footer` verbatim, do not hard-code a footer in the renderer” and N1's frozen
`CliApprovalView`. Behaviour matches today, but the dead port and duplicated footer/options are
exactly the drift N2 exists to prevent. §N says such a change needs an explicit unfreeze.

**SI-3 — stale status cells (all “code is ahead of the table”, the direction §0.3 says to report).**
Implemented but marked `missing`/`partial`: **A7, B3, F9, F10, F11, E1-E4, E6, H2, M1** (and C17 is
_more_ implemented than “the shell can only run its hard-coded 16”). Marked `done` but **not** true:
**I3, I14** (ctrl+o), **I5**, **B15** (width), **A6/A11** (resize — `partial` understates it),
**J10** (mixed-line inline code). The spec table is therefore not a reliable checklist in either
direction.

**SI-4 — §Acceptance commands that cannot pass as written.**
§A (the three shots show duplicated/old-width chrome — D-1); §B (asserts double-Esc clears: it does
not — B9; Ctrl+U clears only the caret's logical line, not the whole draft); §D (the default harness
workspace is an empty temp dir, so no mention menu opens — my run needed a populated workspace);
§L (`text:/clear` answers `unknown command "/clear"` — L5). §Acceptance §I also sends
`run seq 1 200` twice and §E/§F/§G/§H/§J/§K/§M each spend a real model turn: all of them are
reproducible offline against a local OpenAI-compatible stub (I used
`scratch/verify-stub.mjs`; zero quota), which the spec should mention.

**SI-5 — §Acceptance's §E row expects `! for shell mode` as a hint while the spec's own §B/§C rows
assume B9/C9 exist.** Minor editorial: several areas' acceptance rows assert behaviour their own
item rows still call `missing`.

---

## 5. Mutation checks (non-vacuity)

I copied each spec to `scratch/mut-<name>.spec.mjs` (same directory depth, so `../dist` still
resolves), inverted one load-bearing expectation, ran it, and deleted the copy. `test/` was never
modified (`git status` confirms no `test/` change from me).

| spec                | mutated expectation                                    | result                                             |
| ------------------- | ------------------------------------------------------ | -------------------------------------------------- |
| tui-cell-width      | `displayWidth('相机')` 4 → 5                           | FAILS as expected (`CJK glyphs are 2 cells`)       |
| tui-composer        | caret insert `'hello Xworld'` → `'hello XWORLD'`       | FAILS as expected (`insert lands at the caret`)    |
| tui-markdown        | bold row text → keep the `**` markers                  | FAILS (`markers never reach the screen`)           |
| tui-mentions        | `mentionTokenAt('foo@bar')` `null` → a token           | FAILS (`an email-like @ is not a mention`)         |
| tui-palette         | `movePaletteSelection(2,3,1)` 0 → 3                    | FAILS (`down wraps`)                               |
| tui-run-state       | `streamingText` `'pong'` → `'PONG'`                    | FAILS (`answer stream holds only the answer`)      |
| tui-modes           | `interactionModeHint('default')` wording               | FAILS (hint wording)                               |
| tui-registry        | `commandBlockTitle('/status')` `'Status'` → `'STATUS'` | FAILS (`a command names its block`)                |
| tui-shell           | banner row count 3 → 4                                 | FAILS (`the banner is name / model·device / cwd`)  |
| tui-command-surface | expected `/status` block title → `^WrongTitle$`        | FAILS (`/status produced its inline block`)        |
| tui-app             | tool label `'Write(a.txt)'` → `'WRONG'`                | FAILS (`the tool label names the file it touches`) |

**Verdict on the specs:** all 11 are load-bearing (no vacuous assertion among the ones I mutated),
and `npm run test:filter --filter tui-` plus `approval-detail`/`cli-command-dispatcher`/
`cli-interactive-commands` passes 20/20 files. Their **blind spots** are what let the high-severity
defects through, and each blind
spot is now a defect row: no spec drives a resize (D-1), Ctrl+C with a dialog open (D-2), VS16/ZWJ
emoji through the composer (D-3), `/diff` on a large tree or a token with a `+`/quote prefix (D-4),
the _runtime_ effect of ctrl+o on committed rows (D-5), the two registries against each other (D-8),
or the transcript echo of multi-line input (D-10).

---

## 6. Honesty audit (§Z / `tui-command-surface`)

Adverts that **lie** (each is a defect above):

1. `… N more lines · ctrl+o` — pressing ctrl+o does nothing (D-5).
2. `Ctrl+C … press again to quit` — on an idle composer one press quits, with the draft (D-7).
3. `/diff` prints a `Diff` block that is a silently head-truncated, token-mangled diff (D-4).
4. A user interrupt is reported as a red bold error (D-9).

Adverts that hold (checked, not assumed):

- All 28 `/help` commands are dispatched; 23 typed back-to-back in a PTY produced **0** “unknown
  command”, each with its own named block (`scratch/vM1/all.txt`; `/status`, `/context`,
  `/permissions` inspected in full). `/quit`/`/exit` exits 0.
- The key table matches the implementation for `↑ ↓`, `← →`, Ctrl+A/W/U/K/L/O/D, Tab, Shift+Tab,
  `!`, `@`, `/`, and `?`+Enter (the `?` list itself renders; `scratch/vZ3/help.txt`).
- `/status`, `/context`, `/usage`, `/doctor`, `/permissions`, `/compact`, `/model` print real
  config/usage/result data (`/compact` says “No compaction needed.” with the real token count;
  `/model stub-model` really switches and a following turn really uses it — `scratch/vK/turn.txt`).
- `!` reports the true exit status: `⎿ (no output · exit 3)` plus `exit code 3` for a failing
  command (`scratch/vE/fail.txt`) and `(no output)` for a silent one.
- Mode cycling shows the real policy mode with the right colours (`fmagenta`/`fcyan`/`fbrightblack`)
  and only non-default modes append `(shift+tab to cycle)` — `scratch/vF9/*.style`.
- `MOSS_NO_TUI=1` really falls back to the readline REPL (`scratch/vNT/repl.txt`).
- No success message I exercised was a fixed string: approval outcomes come from the user's answer,
  `/rewind`/`/resume`/`/steer`/`/queue` report the real state, and the banner/status values track the
  configured model.

---

## 7. Limitations (what I could not verify)

- **L14 (Windows TUI routing)** — no Windows host. The spec itself calls it `unverified`.
- **K5, I5 reasoning-in-transcript end-to-end compaction** — verified through the module + a
  mutation-checked spec, not by producing a real compaction/`thinking` event from a real provider.
- **Real-provider behaviour** (streaming stalls, retry/error wording, `K15`) — out of scope by
  design: I spent **zero** API quota. Any claim about a specific provider gateway is unverified here.
- **/review's model turn content** — the block is reachable and named (`⏺ Review`), but I did not
  inspect the review prompt it dispatches.
- **Long-session scrollback/performance** — `tui-perf.spec.mjs` passed (10k rows: window projection
  1.34 ms, streaming 1.35 ms); I did not drive a 10k-row session through the PTY.
- **Full 196-row sweep** — I audited the 80 rows the task scoped (52 P0 ∪ 75 `done`). The remaining
  116 are `missing`/`partial` by the table; I spot-confirmed a representative set of _absences_
  (A2, B9, C9, D7, F5-F7, G4, H3, I4, J8, L5, L9, M2-M4) and the stale cells in SI-3 rather than
  re-proving each.

---

## 8. What would make me satisfied

1. **D-1:** reflow on `SIGWINCH` with no keystroke; no stale/duplicated frames on shrink. Gate: the
   §Acceptance §A command's three shots, plus a shrink shot, compared against
   `scratch/vA-ref/` (Claude Code).
2. **D-2:** aborting a run resolves the pending approval — dialog gone, `● waiting for you` gone,
   composer accepts input. Gate: a PTY test; add it to `tui-app`/`tui-shell`.
3. **D-3:** composer wrap measured on joined sequences (`displayWidth` of the accumulated span, or
   `Intl.Segmenter`); add a VS16/ZWJ corpus to `tui-composer`. Gate: zero overflows in
   `node scratch/verify-width-audit.mjs`.
4. **D-4:** `/diff` and `!` display stdout verbatim (no space injection inside a line — wrap by
   cells at render time instead) and announce truncation when output exceeds
   `LOCAL_SHELL_OUTPUT_LIMIT`. Gate: `scratch/vDf/diff.txt` and `scratch/vFin/bangcorrupt.txt`
   re-run clean.
5. **D-5:** ctrl+o re-renders already-committed output (pager or re-emission) so the printed marker
   tells the truth — or stop printing `ctrl+o`.
6. **D-8:** one registry for `/` and `/help` (M3); every advertised command reachable from the menu.
7. **D-6/D-10:** text segments across a tool call become separate rows; the transcript echo keeps
   newlines.
8. **D-7:** implement B21/L9 (clear first, double-press to quit) or correct `help.ts`.
9. **D-9:** a quiet interrupt line instead of a red bold error row.
10. **Spec hygiene:** re-freeze the status column to the verified state (SI-3), replace/land the six
    missing §Acceptance spec files (SI-1), fix the §Acceptance commands that cannot pass (§A/§B/§D/§L),
    and either wire the frozen N1/N2 approvals port or unfreeze §N with the shipped shape (SI-2).
11. Then re-run: the 11 mutation-checked specs, `node scratch/verify-width-audit.mjs`, and the
    §A/§F/§I PTY commands on the final build.

Until 1-5 and 10 are done I cannot call this CLI parity-complete: three of the four involve
user-visible corruption or a blocked input surface, and the fourth is a printed affordance that
does not work.

---

# 9. Round 2 — re-verification at the fix revision (INTERIM, no verdict)

**Revision audited:** `dist/` built **03:42** (newer than every `src/` file; no concurrent build),
status column scored against **`target-spec.md` r3** (03:49, 760 lines). Same method as round 1:
real PTY through `scratch/tui-drive.py`, a local OpenAI-compatible stub (zero API quota), module
probes against `dist/`, and assertion-inversion mutation checks on scratch copies of the specs.

## 9.1 Gates re-run

| gate                                                                                                      | result                                                                      |
| --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `node scratch/verify-width-audit.mjs`                                                                     | **189 605 checks, 0 overflows, 0 throws** (round 1: 421 overflows)          |
| `node scripts/run-package-tests.mjs --filter tui- --filter cli-output-integrity --filter approval-detail` | **20/20 files pass**, incl. the new `tui-resize` and `cli-output-integrity` |
| mutation checks (16 assertion inversions)                                                                 | **16/16 fail as expected** → every mutated gate is load-bearing             |
| `node scratch/verify-grapheme-clip.mjs` (new probe)                                                       | 5 804 checks → **65 cluster splits** (see N-2)                              |

Mutated gates: `tui-cell-width`, `tui-composer` (×2: caret insert, VS16 first-row width),
`tui-markdown`, `tui-mentions`, `tui-palette`, `tui-run-state`, `tui-modes`, `tui-registry`,
`tui-shell` (×3: banner rows, payload footer not hard-coded, interrupt wording), `tui-app`,
`tui-command-surface`, `tui-resize`, `cli-output-integrity`. r3's 13 named filters are all real
files (§Acceptance SI-1 from round 1 is resolved).

## 9.2 Verified closed (my own re-test)

| defect                        | how I re-tested it                                            | observed                                                                                                                                                                                                                                                                                                 |
| ----------------------------- | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D-1** resize                | `scratch/r1`: 80 → grow 120 → shrink 80, **no keystroke**     | rules `[80,80] → [120,120] → [80,80]`; grown screen = banner + status at 120 + both rules + composer + hint; shrunk screen = exactly one 2-rule chrome, no orphan status or stray fragment. Also holds **mid-run** (`scratch/rLive`: 100→130→60)                                                         |
| **D-2** approval zombie       | `scratch/r2`: dialog → Ctrl+C → type a new message            | dialog gone, `⎿ approval: no`, run `interrupted`, hint back to normal, `hello` then really runs (`⏺ Stub reply ok.`)                                                                                                                                                                                     |
| **D-3** VS16 width            | `scratch/r3` (the exact round-1 repro: 27×`a`+`❤️` @ cols 30) | composer wraps **at the cluster boundary** (`❯ aaa…a` / `  ❤`), no terminal hard-wrap; caret insert still `abX▌c`; Backspace deletes a whole ZWJ family in one press (`scratch/r3c`)                                                                                                                     |
| **D-5** ctrl+o                | `scratch/r5`                                                  | collapsed = `… 150 more lines · ctrl+o`; ctrl+o reveals the hidden tail and removes the marker; ctrl+o again re-collapses (`scratch/r5/recollapsed.txt`). Works during a run too (`scratch/rLive/verbose-run.txt`)                                                                                       |
| **D-9** interrupt             | `scratch/r9` + `.style`                                       | `interrupted — partial output kept` with **zero** style tags (no red, no bold); the old red-bold abort row is gone                                                                                                                                                                                       |
| **D-11** fabricated gutter    | module probe + PTY                                            | the exact quoted assertion `renderDiffGutter('+before\n@@ -5 +5 @@\n-after\n+after', 40)` gives `+before` a **blank** gutter and numbers the post-`@@` rows 5/5; a lone `+`/`-` line is no longer a diff at all; `! echo +process.env.X` now prints verbatim                                             |
| **D-4** output integrity      | `scratch/r4a/b/c`, `scratch/rBig`                             | `!` prints `+process.env.MOSS_NO_BUNDLED_DEFAULT` verbatim; small `/diff` intact (`---`/`+++`/`@@`, correct 1/1/2 gutter); 5 358-line `/diff` now starts with `… output truncated · 180965 chars (4635 lines) hidden` and its first content line is a whole line; `! seq 1 12000` announces the same way |
| **SI-2** frozen approval port | module probe of `renderApproval` with a custom payload        | payload `options` (`7. Seven yes`, `❯ 9. Custom no`) and `footer` render **verbatim**; with no payload it falls back to the frozen 3 options + `CLI_APPROVAL_FOOTER`; `app.ts:518` installs `setCliApprovalViewAsker`                                                                                    |

The D-2 rewrite did not regress the normal answers: `1` → `approval: yes`, `y` → yes, `a` →
`yes (session)`, Esc → `approval: no` + denial (`scratch/rA1…rA4`).

## 9.3 Still open at the fix revision (fresh repros)

r3 §0.6 marks D-6/D-7/D-10/D-12/D-13 unverified-or-open (honest) and D-8 **closed** (not verified by
me). My re-tests:

| defect                                 | verdict at 03:42                  | repro                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D-6** prose concatenated             | **OPEN**                          | `scratch/r6/todos.txt` → `⏺ Planning the refactor.Todo list is live.`; also `scratch/rA1/after.txt` → `⏺ Creating the file.Wrote it.`                                                                                                                                                                                                                                                                                                                                                                               |
| **D-7** idle Ctrl+C destroys the draft | **OPEN**                          | `scratch/r7.log`: `text:my-draft` + one Ctrl+C → `process exited code=0`; `HELP_KEYS` still prints `Ctrl+C interrupt the run · press again to quit` (`scratch/vZ3/help.txt`)                                                                                                                                                                                                                                                                                                                                        |
| **D-8** `/` menu vs `/help`            | **OPEN — r3's "closed" is wrong** | PTY `scratch/rD8/menu.txt`: 8 rows + `… 9 more` = **17**; node probe: `HELP_COMMANDS 28`, registry rows 21, intersection **17**, absent `/tasks /history /evidence /deployments /failures /resume /queue /steer /bg /subs /mcp`. `app.ts:1275-1278` still does `slashPaletteRows(input).filter(c => shellCommands.has(c))` — filtering by HELP_COMMANDS can only **remove** rows; it can never add the 11 the REPL registry lacks. r3 §0.6 and row C17 both cite this as the fix and as "both surfaces now list 28" |
| **D-10** multi-line echo squashed      | **OPEN**                          | `scratch/r10` → `❯ paste-line-one paste-line-two` and `❯ typed-one typed-two` (the model still receives the `\n`)                                                                                                                                                                                                                                                                                                                                                                                                   |
| **D-12** mixed-line emphasis           | **OPEN**                          | module probe: ``use `npm run build` now`` → no colour; `**bold** and *italic* mixed` → italic dropped; a whole-line code row is cyan                                                                                                                                                                                                                                                                                                                                                                                |
| **D-13** 24×8 approval                 | **OPEN**                          | `scratch/r13/tinyappr.txt` starts at `2. Yes, and don't as…` — title, subject, preview, question and `1. Yes` are off-screen                                                                                                                                                                                                                                                                                                                                                                                        |

## 9.4 New findings from this round

**N-1 (MEDIUM, pre-existing but now load-bearing) — `ask_user_question` is unanswerable in the TUI.**
The Lead's note says the legacy string port survives because it feeds `ask_user_question`; that
channel is mirrored from the approval asker (`approval.ts:123-125`), so a _clarifying multiple-choice
question_ is rendered by `legacyApprovalView` and then answered with the **approval vocabulary**.
Repro (`scratch/rAsk`): the model asks "Which deployment approach should I take?" with options 1-3;
the dialog shows the question and options as a preview, then `Do you want to proceed? / 1. Yes /
2. Yes, and don't ask again this session / 3. No`. Pressing `1` returns
`⎿ User has answered your questions: "Which deployment approach should I take?"="y"` — the chosen
option is discarded and the tool receives `y`. The numeric keys are bound to y/a/n, not to the
model's options, and `2` returns `a`. It predates the fix (the old asker also answered y/a/n), but
the new state machine is where it now lives, and it is the one path where "answer 1/2/3" means
something different from what the dialog implies.

**N-2 (LOW) — `clip()` still splits grapheme clusters.**
`terminal-text.ts:truncateTerminalText` is the one width walk that still iterates `Array.from(text)`
(code points). `scratch/verify-grapheme-clip.mjs`: 65 of 5 804 clips cut **inside** a cluster, e.g.
`clip('❤️'×12, 2)` → `"❤…"` (the VS16 is dropped, so the terminal paints text-presentation `❤`
instead of the emoji), `clip('🇨🇳'×12, 2)` → `"🇨…"` (half a regional-indicator pair), `clip('1️⃣'…, 2)`
→ `"1️…"`, `clip('क्षि'…, 2)` → `"क्ष…"` (vowel sign lost). No overflow (the widths stay in budget),
so this is glyph integrity, not frame corruption — but it contradicts the claim that _every_
width/clip walk is grapheme-based.

**N-3 (LOW, disclosed trade-off) — ctrl+o re-emits the whole transcript.**
Because the fix bumps the `<Static>` key, pressing ctrl+o writes every committed row into the
terminal **again**: `scratch/r5b/raw.log` (raw PTY bytes) contains `moss v0.21.0` twice and
`run seq 1 200 now` three times after a single toggle. The toggle is now honest (D-5 closed) and I
accept it, but on a long session ctrl+o floods scrollback with a duplicate copy; a pager (r3 row
I15) is the proper end state.

## 9.5 Verdict for this round: NOT SATISFIED — decline, holding for the next revision

Round 2 closes **D-1, D-2, D-3 (width contract), D-4, D-5, D-9, D-11 and SI-2** — verified by my own
PTY runs, module probes and 16 load-bearing mutation checks, with the audit now at 0/189 605 width
violations and 20/20 specs green. That is real, material progress.

Six defects I filed in round 1 are **still reproducible at the fix revision**: **D-6, D-7, D-8
(falsely marked closed in r3), D-10, D-12, D-13** — plus new findings **N-1** (ask_user_question gets
`y` instead of the chosen option) and **N-2** (clip splits clusters). Per the Lead's instruction I
decline again and hold the final verdict until `dist` is frozen after the fixer's revision.

To sign off I need, on the frozen revision:

1. **D-8** `/` menu and `/help` from one registry (the menu must offer all 28; r3 must stop recording
   this as closed) — and **D-7** either B21/L9 implemented or `HELP_KEYS` corrected (an advert that
   lies is the one thing I will not wave through).
2. **D-6** prose split per tool call, and **D-10** newlines preserved in the echo.
3. **D-12** mixed-row emphasis, and **D-13** a height budget for the approval dialog at ≤10 rows.
4. **N-1** `ask_user_question` answered as a choice (its own key vocabulary), not as an approval.
5. **N-2** grapheme-safe `clip()` (the last code-point walk), and a decision recorded for N-3.
6. Re-run: `scratch/verify-width-audit.mjs`, `scratch/verify-grapheme-clip.mjs`, the 13 r3 filters,
   the §A/§F/§I PTY commands, and the honesty audit (`/help` text vs. behaviour).

## 9.6 r3's rewritten §Acceptance reviewer commands — executed

I ran the rewritten commands from r3's table as a reviewer would (stub where a model turn is named;
`scratch/acc-*`):

- **§A** — boot `[90,90]`; after `resize:60x20` the newest chrome is `[60,60,60]` and after
  `resize:110x32` `[60,110,110]` (one leftover row from the pre-resize frame remains in scrollback,
  the new frame is already the new width **with no keystroke**); banner, composer and hint survive.
  **Passes as written** (round-1 SI-4 for §A resolved by D-1).
- **§B** — Ctrl+J gives two rows, `CSI 13;2u` gives a third, continuations are 2-space, Ctrl+U clears
  the logical line, mid-line insert lands at the caret. **Passes**, with one documentation nit: the
  row's prose still expects `abXcd` while its own key sequence (`abc`, ←, ←, `X`) produces `aXbc`
  (`scratch/acc-B/caret.txt`). The behaviour is right; the expected string is stale.
- **§D** — a populated workspace is now explicitly required, and it works: `@demo/` (dir) /
  `@notes.md` / `@demo/alpha.ts`, `@alp` → `@demo/alpha.ts`, Tab completes. **Passes.**
- **§I** — `! seq 1 60` collapses to `⎿ 1 / … 57 more lines · ctrl+o`, Ctrl+O reveals the committed
  tail (the 50s/60 are on screen), Ctrl+O again restores the marker. **Passes.**
- r3 correctly forbids the two unpassable round-1 assertions: B9 double-Esc in §B and `/clear` in §L
  (both still `missing`). SI-4 is resolved except for the §B expected-string nit above.

---

# 10. Round 3 — final pass on the frozen revision (dist 04:45)

**Revision:** `dist/` built **04:45**, newer than every `src/` file (no writer active).
**Method:** unchanged — real PTY (`scratch/tui-drive.py`), local stub (zero quota), module probes
against `dist/`, assertion-inversion mutation checks on scratch copies (never `test/`).

## 10.1 Gates

| gate                                                                                                      | result                                                               |
| --------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| `node scratch/verify-width-audit.mjs`                                                                     | **189 979 checks, 0 overflow, 0 throw**                              |
| `node scratch/verify-grapheme-clip.mjs` (N-2 probe)                                                       | **5 804 checks, 0 split cluster, 0 overflow** (round 2: 65 splits)   |
| `node scripts/run-package-tests.mjs --filter tui- --filter cli-output-integrity --filter approval-detail` | **20/20 files pass**                                                 |
| mutation checks this round (9 new + 3 key round-2)                                                        | **12/12 fail as expected** — every mutated assertion is load-bearing |

Mutated this round: `tui-composer` N-2 cluster clip; `tui-shell` D-7 arming wording, D-10 line break,
D-13 3-row budget keys, D-12 heading row-style, N-1 option render, D-6 non-concatenation, N-4 answer
head; `tui-command-surface` D-8 "menu offers every advertised command (28 of 28)";
`tui-resize` grow width; `cli-output-integrity` no-space; `tui-composer` VS16 first row.

## 10.2 Every item from the final-pass list — verified closed by my own probes

| item                                  | fresh evidence (this revision)                                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **D-6** prose flush                   | `scratch/fD6/todos.txt`: `⏺ Planning the refactor.` / `⏺ Todo Write` / `⎿ 1/4 done` / `⏺ Todo list is live.` — four rows, no run-on                                                                                                                                                                                                                                              |
| **D-7** two-press Ctrl+C              | `scratch/fD7`: first press keeps `my-draft` and shows `press Ctrl+C again to quit`; second press exits 0. `scratch/fD7b`: during a run the first press still interrupts. The `HELP_KEYS` advert is now true                                                                                                                                                                      |
| **D-8** one command list              | `scratch/fPal/menu.txt` (bare `/`): 8 rows + `… 20 more` = **28**; `shellPaletteRows('/')` = 28; `/m` now includes `/mcp`; mutation `advertised+1` fails with `28 of 28`. `/clear /loop /goal /task /init` are **not** advertised (module probe)                                                                                                                                 |
| **D-10** multi-line echo              | `scratch/fD10`: `❯ paste-line-one` / `  paste-line-two`; same for a Ctrl+J draft                                                                                                                                                                                                                                                                                                 |
| **D-12** per-run emphasis             | `scratch/fD12/markdown.style` on one mixed row: `bold`→`B`, `italic`→`I`, `inline code`→`fcyan`; heading row bold, quote dim (spec `§2f` asserts the real escapes)                                                                                                                                                                                                               |
| **D-13** 24×8 approval                | `scratch/fD13/tinyappr.txt`: `Do you want to create …` + `❯ 1. Yes · 2. Yes, and…` + footer + composer + hint; `scratch/fD13b` at 30×10                                                                                                                                                                                                                                          |
| **N-1** question answerable           | `scratch/fN1`: real options, `2` → `="In-place restart"`; `scratch/fN1b` Esc → decline path; `scratch/fN1c` free text; `scratch/fN1d` **no-option** question renders `type your answer below` and returns `deploy-host-01`; `scratch/fN1e/f` `multi_select` types `1,3` → `="Unit tests, Typecheck"` (digits do not answer early)                                                |
| **N-2** grapheme clip                 | probe 0 splits; `clip('❤️'×12,2) === '…'` (mutation-checked)                                                                                                                                                                                                                                                                                                                     |
| **N-4** answer head                   | `scratch/fD12/markdown.txt` starts at `⏺ Verification heading` + the whole first paragraph (round 1 showed `⏺ ith bold, …`)                                                                                                                                                                                                                                                      |
| **D-1/D-2/D-3/D-4/D-5/D-9/D-11/SI-2** | re-checked on this build: `tui-resize` + `cli-output-integrity` + `tui-shell` mutation-checked and green; `scratch/fZ` (Ctrl+C during approval → no dialog/`waiting for you`, next message runs); `scratch/fI2` (collapsed `… 57 more lines` → ctrl+o reveals through line 60 → ctrl+o restores the marker); `scratch/fI` (`interrupted — partial output kept`, style tags `[]`) |
| **Regression sweep**                  | `scratch/fReg1` visible-row palette Enter → `⏺ Model`; `fReg2` `@alpha.ts` mention + Tab + Enter; `fReg3` `! exit 3` → `(no output · exit 3)` + `exit code 3`; `fReg4` Ctrl+D → exit 0                                                                                                                                                                                           |

## 10.3 DEFECT D-15 (new, MEDIUM-HIGH) — the `/` menu highlights one command and runs another

The D-8 expansion to 28 rows exposed a selection/display divergence that no spec covers:
`renderSlashPalette` renders `rows.slice(0, PALETTE_MAX_ROWS)` and clamps the `❯` marker to the
_visible_ window, while `app.ts` keeps the real cursor over all 28 rows and Tab/Enter act on
`paletteRows[paletteSelection]`. There is no scroll offset, so the highlight sticks on row 7.

```bash
# 8x Down, then Enter
python3 scratch/tui-drive.py --cols 100 --rows 40 --env "MOSS_CONFIG_FILE=$CFG" \
  --out scratch/fPal2 --steps 'wait:2500,text:/,wait:700,key:down,key:down,key:down,key:down,key:down,key:down,key:down,key:down,wait:400,shot:highlighted,key:enter,wait:1500,shot:ran,key:ctrl-c'
```

- **Observed:** the screen highlights `❯ /sessions  list saved conversations` (row 7), and Enter runs
  `⏺ Doctor` (row 8). With 10× Down the highlight is still `/sessions` while **Tab completes
  `/quickstart`** (row 10) into the composer (`scratch/fPal/aftertab.txt`). Up from row 0 wraps to
  `/mcp`, whose highlight also clamps to row 7.
- **Expected:** the highlighted row is the row Tab/Enter act on — either scroll the window
  (`rows.slice(offset, offset + maxRows)` with `offset` tracking the cursor) or clamp the cursor to
  the visible rows.
- **Why it matters:** a user browses with ↓ (the `… 20 more` marker invites exactly that) and then
  runs a command they never saw highlighted. That is the "advert lies / wrong action" class.
- **Spec:** C3/C13 are `partial` ("the window is fixed, not height-derived" / "scrolling beyond that")
  so _no scrolling_ is acknowledged — but a marker that says row 7 while Enter runs row 8 is a defect,
  not a deferred feature. No spec drives the app cursor past the visible window: `tui-palette`
  only exercises `selected: 0/1`, which is why 181 specs are green.

## 10.4 Documentation staleness (not functional)

r3's §0.6 table and row C17 still record **D-6/D-7/D-8/D-10/D-12/D-13 as open/unverified** and C17
still says "**17 of 28** discoverable". On this build all six are closed and the menu offers **28 of
28**. The spec now understates the implementation; §0.3's rule ("a status cell that cannot be
re-derived must be updated") applies in this direction too. Separately, r3 §Acceptance §B's prose
still expects `abXcd` while its own key sequence produces `aXbc` (§9.6).

## 10.5 Round-3 verdict: NOT SATISFIED — one functional item remains (D-15)

Everything on the Lead's final list is genuinely closed and independently reproduced: D-1…D-13
(except the new D-15), N-1, N-2, N-4 and SI-2. 189 979 width checks clean, the grapheme probe down
from 65 splits to 0, 20/20 specs, 25 mutation checks across rounds 2–3 all load-bearing, and the
advertised key/command surface is now honest (the Ctrl+C two-press wording is true, `/diff`/`!`
output is verbatim and announces truncation, interrupt is quiet, no unadvertised command is offered).

I decline a fifth time on exactly one point, because it is the failure mode the product owner's bar
is about: **the `/` menu can execute a command other than the one it highlights (D-15)**. Fix and
re-freeze, and the sign-off criteria below are otherwise met.

To declare me satisfied I need, on the next frozen revision:

1. **D-15** — the `/` menu's highlight and its Tab/Enter target are the same row beyond
   `PALETTE_MAX_ROWS` (scroll window or clamped cursor), with a spec that drives the app cursor past
   the visible window and asserts highlighted == executed.
2. **r3 documentation** — §0.6 and C17 updated to the verified state (they currently understate
   D-6/D-7/D-8/D-10/D-12/D-13 and say 17 of 28), and the §B `abXcd` prose corrected.
3. N-3 recorded as an accepted product decision (it already is, per the Lead).

Then I re-run: width audit, grapheme probe, the 13 r3 filters, the §A/§F/§I §Acceptance commands,
the D-15 probe, and the honesty audit — and if they are clean I will sign plainly.

---

# 11. Round 4 — D-15 fixed; final pass (dist 05:06, spec r3.2)

**Revision:** `dist/` built **05:06**, newer than every `src/` file (frozen, no writer active).
`target-spec.md` r3.2 (808 lines, 202 items). Same method: real PTY, local stub (zero quota),
module probes against `dist/`, scratch-copy mutation checks.

## 11.1 Gates

| gate                                                     | result                                                                                                                           |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| width audit                                              | **189 979 checks, 0 overflow, 0 throw**                                                                                          |
| grapheme probe (N-2)                                     | **5 804 checks, 0 split cluster, 0 overflow**                                                                                    |
| `--filter tui- … cli-output-integrity … approval-detail` | **20/20 files pass**                                                                                                             |
| mutation checks this round                               | 2 new D-15 assertions + re-confirmation of N-2/D-7/D-10/D-13/D-12/N-1/D-6/N-4/D-8/resize/output-integrity → **all load-bearing** |

## 11.2 D-15 closed — evidence

The fix is in `app.ts` only (`palette.ts` untouched): `paletteWindowOffset(selected,total,maxRows)` +
`paletteFrameRows(rows,offset,maxRows)` hand the renderer the _window_ with
`selected: paletteSelection - offset`, so the marker index **is** the acted index.

- **Contract, independent matrix:** 721 valid `(total, selected, maxRows)` combinations → **0
  violations** of `frame[selected-offset] === rows[selected]`, and 0 offset-bound violations
  (`offset ≤ max(0, total-maxRows)`, `offset = 0` while `selected < maxRows`).
- **Rendered marker vs acted row:** all **28/28** selections → the `❯` row equals
  `paletteRows[selected]`.
- **PTY (the round-3 repro, all pass):**
  - `/` + ↓×8 → marks `❯ /doctor`, **Enter runs `⏺ Doctor`** (`scratch/gD15a`) — round 3 marked
    `/sessions` and ran `/doctor`.
  - `/` + ↓×8 → **Tab completes `/doctor`** (`scratch/gD15b`) — round 3 completed `/quickstart`.
  - `/` + ↑ (wrap to index 27) → marks `❯ /mcp`, **Enter runs `⏺ mcp`** (`scratch/gD15c`).
  - `/` + ↓×27 (scroll to the end) → marks `❯ /mcp`, Enter runs `⏺ mcp` (`scratch/gD15d`).
  - Filtered `/co` (3 rows) → ↓ then Enter runs `⏺ Context` (`scratch/gD15e`); typing after
    scrolling resets the window (8×↓ then `c` → `❯ /compact`, Enter → `⏺ Compact`, `scratch/gEDGE`);
    Esc still keeps the typed `/` (`scratch/gEDGE2`).
- **Sibling claim checked:** the `@` mention menu cannot diverge — `filterMentions` caps at
  `MENTION_MAX_ROWS = 6`, so `renderMentionMenu`'s slice is a no-op and the cursor wraps inside the
  6 visible rows (in the repo root, `@` + ↓×9 → the marker wraps to the first row, 6 rows total;
  `scratch/gMENT`). I agree with the Lead's assessment: no defect there.
- Spec-side: `test/tui-command-surface.spec.mjs` now has the pure contract (`row 9 scrolls the
window`), the mounted ↓×8→Enter case (`❯ /doctor`, not `/sessions`) and the marker-follows-cursor
  case; both pure assertions I mutated fail as expected.

## 11.3 r3.2 §Acceptance commands — executed

§A (boot `[90,90]`, shrink `[60,60]` + one scrollback row, grow `[110,110]`), §F mode cycle
(`accept-edits → plan → default`, cycle hint on non-default), §I (`… 57 more lines · ctrl+o` →
Ctrl+O reveals through line 60 → marker restored), §M (`/status → ⏺ Status`, `/permissions` prints its
real block — confirmed at 70 rows and in the raw byte stream, `/mode → ⏺ Mode`) — all pass as
written. §B's expected string is now correctly `aXbc`.

## 11.4 Honesty audit (final)

- 28 advertised command usages = 28 menu rows = 28 dispatched (`shellPaletteRows('/')`,
  `tui-command-surface`); `/clear /loop /goal /task /init /attach /config` are **not** advertised.
- `HELP_KEYS` `Ctrl+C interrupt the run · press again to quit` is **true** (idle: first press arms
  and keeps the draft, second exits; run: first press interrupts). `Ctrl+D` quits (exit 0), `?` opens
  the list, `!` reports real exit codes, `/exit` exits 0, `ctrl+o` really expands, the interrupt line
  is quiet, `/diff`/`!` output is verbatim with an announced truncation.
- No remaining advert lies that I could find.

## 11.5 Remaining item — documentation only

r3.2's **C19** row and the **§0.6 D-15 row** still read `missing — OPEN (MEDIUM-HIGH)`: they were
written at 04:58, before the fix, and r3.2's own churn warning says "Re-probe D-15 before sign-off" —
which I have now done, and it is closed. Those two cells should be flipped to `done` so the frozen
spec does not contradict the verified build (`claude-surface` owns that document; I may not edit it).
Nothing else in r3.2 understates or overstates the code as far as I can re-derive it.

One P3 cosmetic note, not a defect: the `… N more` counter is the total not-displayed count, so it
reads `… 20 more` at every scroll offset (including the tail, where those rows are above). The number
is truthful; only the direction is implicit.

## 11.6 Round-4 verdict: SATISFIED

On the frozen revision (dist 05:06) I reproduced **every** item and every previously open defect —
D-1…D-15, N-1, N-2, N-4, SI-2 — with my own PTY runs, module probes and 28 load-bearing mutation
checks across rounds 2–4. The width audit is 0/189 979, the grapheme probe 0/5 804, 20/20 specs
pass, the r3.2 reviewer commands execute, and the advertised key/command surface is honest.

**I am satisfied that the moss CLI matches the frozen spec on the axes I audited.** The only
follow-up is the C19/§0.6 status flip above — bookkeeping, not behaviour — and N-3, which is a
recorded product decision. I would not withhold sign-off on the product for a stale status cell;
flip it and the frozen document and the build agree.
