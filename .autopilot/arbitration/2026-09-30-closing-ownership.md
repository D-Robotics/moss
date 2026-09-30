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
