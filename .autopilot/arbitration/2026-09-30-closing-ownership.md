# 仲裁：v0.14–v0.20 收口序列归属（2026-09-30 12:22）

## 裁定

收口序列（证据固化 → accept-02..10 门 → v0.14.0..v0.20.0 七连 tag → 合并 main → push → 夜报）由 **goal 会话 93951f1c** 单点执行。

## 依据

- 用户于 2026-09-30 11:45 在 goal 会话下发"moss v0.14–v0.20 执行全景…请做完"（目标全文即本仓库 PROGRESS.md 下一棒的收口序列）。
- 执行会话（dd2046b5，即发射 endgame/慢拉/全量复跑的会话）的最后一轮已完成 v0.20 内部证据固化（0a89f19a，hard 90.9 校正、如实标注），其后处于等待状态。
- 两个会话同时执行收口会导致：重复 release commit、verify 双跑、tag/推送冲突。

## 对执行会话的要求

- 后台任务（swe-endgame / slowpull）继续运行，不动。
- 收到 endgame/swe 完成通知后**不要**自行 tag / bump / verify / 合并 / 推送 / 写夜报；只读观察。
- 如发现本裁定过时（goal 会话失联超过 2 小时无推进），在仲裁队列追加新条目再接管。

## 幕后接力（已由 goal 会话布防）

- 协调闸门：endgame 已 SIGSTOP 冻结，等"full-bench 收尾 且 镜像 missing=0"后自动放行（/tmp/moss-endgame-coordinator.sh）。
- 链尾接力：endgame 退出后自动跑 swe-v020（v0.20 tip 快照）+ 判分（/tmp/moss-swe-v020-tail.sh）。
- 噪声取证：full-bench-v020-r2（同快照第二次全量）进行中，用于 hard 87.9 vs 93.9 的噪声裁决。

## 补充裁决（2026-09-30 19:20，用户拍板）

- main 已并行推进"机器人闭环"方向（8 提交：device 子系统/task contract/evidence-gated acceptance），与 autopilot（24 提交，TUI/MCP/skills 线）分叉 96 文件。
- **用户裁定：外榜证据齐、门过后，按原计划合并 autopilot → main**——两线共存；合并时 AGENTS.md 手工调和（TUI/MCP/skills 解冻表述 + 设备子系统章节并存），机器人线提交完整保留。
- 已知障碍：主 worktree 有未提交 scripts/run-benchmark.mjs 改动（非本会话），合并前核对其归属。
