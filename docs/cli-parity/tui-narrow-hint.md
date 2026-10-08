# 窄终端提示行（有意变更）

计划 v3 P2（N12）改了提示行的截断契约。`test/tui-shell.spec.mjs` 里对 `renderHint` 的断言已经按这个契约改过，实现在 `src/cli/tui/transcript.ts` 的 `renderHint`。

宽终端（≥ 80 列）提示行仍带齐：模式名、`Esc to interrupt`、`? for shortcuts`、排队数、任务数。

窄终端不再把一行裁成半截词。整项按优先级丢掉，留下的项必须完整：

1. 模式名（任何宽度都留）
2. 当前能按的键（`Esc to interrupt`、审批的 `1/2/3`、`ctrl+o to expand`）
3. `? for shortcuts`（宽度 ≥ 60 才要求出现）
4. 排队数、任务数

40 列及更窄的运行中提示行必须仍能看到 `Esc to interrupt` 和模式名，并且单元格宽度不超过该行。

小于 40 列或小于 10 行时，全屏渲染器改为内联，并在 Ink 接管屏幕前在 stderr 打一行说明。
