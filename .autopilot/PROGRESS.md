# PROGRESS — moss v0.14–v0.20 autopilot

## 棒日志

- sprint-000 (2026-09-30, 编排者)：合同建立。worktree=../moss-ap（分支 autopilot/v014-v020，基点 6d73392f）。RUNNER=self。主仓三臂 A/B 由并行会话运行中（cheap/balanced 已收，routing 进行中），主仓禁 build 至其结束。验收器 10 个建于 pending/（gate 只扫 acceptance/ 顶层文件），每棒随版本落地逐个上移。全部验收器已完成"先红"自检（见 evidence/sprint-000/）。

## Checklist 镜像（与 task.md §4 同步）

- [ ] T1 0.14-S3 命令面止血
- [ ] T2 0.14-S1/S2 SWE-bench adapter+基线+确定性
- [ ] T3 0.14 收口（S0/S4）+v0.13.0/v0.14.0 tag
- [ ] T4-S7 v0.15（goal/worktree/hooks/A/B+SWE delta+tag）
- [ ] T8-T11 v0.16（MCP/skills/出网/T-Bench+tag）
- [ ] T12 v0.17 TUI 地基+tag
- [ ] T13 v0.18 TUI 控制面+tag
- [ ] T14 v0.19 TUI 多任务面+tag
- [ ] T15 v0.20 收口+tag
- [ ] T16 发布（合并/push/夜报/蒸馏）

## 仲裁队列

（空）

## 打回记录

（空）

## 下一棒

T1 0.14-S3 命令面止血：改 src/cli/args.ts 幽灵子命令、interactive-commands 目录、删 input-queue.ts，先写红 spec 再修绿。
