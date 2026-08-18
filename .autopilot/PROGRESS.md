# PROGRESS

## 当前

- 下一项：T11 full verify, merge-main, push, and CI
- 最近绿 tag：autopilot/unify-long-horizon-green-010
- 备注：Execution Graph 已接入 Plan、TaskRun、后台任务、CLI/TUI/Web/ACP；真实验收 long_task_loop 与 subagents_concurrency 均为 10/10。

## 棒日志

| 棒  | 时间       | 认领项                                     | 门禁  | 证据                                      | 备注              |
| --- | ---------- | ------------------------------------------ | ----- | ----------------------------------------- | ----------------- |
| 001 | 2026-08-18 | T1 Execution Graph contracts and stores    | GREEN | `test/execution-graph.spec.mjs`           | 4/4 focused cases |
| 002 | 2026-08-18 | T2 DAG scheduler and recovery policy       | GREEN | `test/execution-graph-scheduler.spec.mjs` | 5/5 focused cases |
| 003 | 2026-08-18 | T3 Workspace Lease and guarded patch merge | GREEN | `test/workspace-lease.spec.mjs`           | 5/5 focused cases |
| 004 | 2026-08-18 | T4 Role routing, synthesis, completion     | GREEN | role/completion/plugin focused tests      | 11 focused cases  |
| 005 | 2026-08-18 | T5 Instance-owned durable state            | GREEN | durable agent + Plan isolation tests      | 2 focused cases   |
| 006 | 2026-08-18 | T6 CLI/TUI task control                    | GREEN | task controller/command tests             | 2 focused cases   |
| 007 | 2026-08-18 | T7 Web graph control and view              | GREEN | control plane + Playwright                | browser passed    |
| 008 | 2026-08-18 | T8 Plan/TaskRun graph projection           | GREEN | DAG + projection tests                    | 5 focused cases   |
| 009 | 2026-08-18 | T9 Durable background task projection      | GREEN | async task lifecycle tests                | 2 focused cases   |
| 010 | 2026-08-18 | T10 Legacy import + real acceptance        | GREEN | runtime evidence JSON                     | 10/10 + 10/10     |

## 仲裁队列

| 编号 | 类型 | 状态 | 摘要 |
| ---- | ---- | ---- | ---- |

## 打回记录

| 时间 | 打回内容 | 蒸馏成的验收器 |
| ---- | -------- | -------------- |
