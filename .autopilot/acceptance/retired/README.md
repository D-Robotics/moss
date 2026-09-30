# 退役验收门台账（v0.14–v0.20 链式发布）

> 退役决定与口径见 [`docs/release-policy.md`](../../../docs/release-policy.md)（2026-10-01）。
> 这些门**不再参与发布判定**；脚本保持可执行，命令逐条登记在下面。
> 跑完任一门并留存证据后，可按 release-policy 第 3 条主张对应版本号。

全部脚本自述、真实证据文件与现状如下（"现状"列为 2026-10-01 复核结果，不是推测）：

| 门        | 门要求（脚本自述）                                                                                    | 现状                                                                                                                                              | 剩余阻塞                                                                                                   | 执行                                                                |
| --------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| accept-02 | SWE-bench 基线 + 确定性证据（实例数 ≥50、2 采样、重跑差异 ≤1）                                        | **未执行**                                                                                                                                        | 需 Docker 宿主 + 官方 swebench harness + 数据集/镜像配额；`swe-baseline.json`、`swe-determinism.json` 缺失 | `bash .autopilot/acceptance/retired/accept-02-swebench-baseline.sh` |
| accept-03 | v0.14 门：幽灵子命令非零退出 + 死命令下架 + input-queue 删除 + tag v0.14.0 + AGENTS.md                | 检查项**代码面已交付**（`moss mcp/plugins/migrate/web/agent/update` 硬错退出、`src/cli/input-queue.ts` 已删、AGENTS.md 已含解冻导航）             | 仅缺 tag（新口径不补）                                                                                     | 同上                                                                |
| accept-04 | v0.15 门：goal/worktree/hooks spec + A/B deltaHard≥4、cost≤1.5×（或已裁决偏差）+ SWE ≥ 基线+3pt + tag | 内部段**证据齐**：`ab-goal-loop.json` deltaHard=6，costRatio=1.58（已由用户裁决为偏差，脚本接受 `costAdjudicated`）；SWE 段缺失                   | `swe-baseline.json`、`swe-v015.json`；无 tag                                                               | 同上                                                                |
| accept-05 | v0.16 门：MCP 真连 + 懒加载 + skills 入库 + 出网 spec + T-Bench 基线 + SWE 不回退 + tag               | 内部段**证据齐**：`skills-bench-trigger.json` mechanismVerified=true、触发为诚实的负面（已裁决偏差，脚本接受 `adjudicatedDeviation`）；外部段缺失 | `swe-baseline.json`、`swe-v016.json`、`tbench-baseline.json`；无 tag                                       | 同上                                                                |
| accept-06 | v0.17 门：TUI PTY spec + smoke + tag 树含 tui 模块 + SDK 快照零 diff                                  | TUI 已交付并在 main 上由 TUI spec 家族 + smoke 覆盖；SDK 快照由 `test/sdk-contract.spec.mjs` 锁定                                                 | 仅缺 tag v0.17.0                                                                                           | 同上                                                                |
| accept-07 | v0.18 门：steer/queue/后台/审批/用量 spec + tag v0.18.0                                               | 已交付（`test/tui-control.spec.mjs` 等）                                                                                                          | 仅缺 tag v0.18.0                                                                                           | 同上                                                                |
| accept-08 | v0.19 门：会话/fork/子代理面板 spec + 内部 bench 抽样 + tag v0.19.0                                   | 证据齐：`bench-sample-v019.json` 5/5 PASS                                                                                                         | 仅缺 tag v0.19.0                                                                                           | 同上                                                                |
| accept-09 | v0.20 门：Windows 证据或如实标注 + 性能预算 + 全榜复核 + 全命令遍历 + tag v0.20.0                     | 证据大部齐：`windows-pty.json`（documentedFallback=true）、`perf-budget.json`（pass=true）、`full-bench-v020.json`（easy 100 / hard 90.9）        | `swe-v020.json`；无 tag                                                                                    | 同上                                                                |
| accept-10 | 发布门：七个版本 tag 齐 + origin 同步 + main 含 v0.20.0 + 工作树净                                    | **按新口径不适用**                                                                                                                                | —                                                                                                          | —                                                                   |

## 结论（为什么这条链停在这里）

链式发布的真实断点只有两类：

1. **外部榜单证据从未产出**（6 个文件：`swe-baseline` / `swe-determinism` / `swe-v015` / `swe-v016` / `swe-v020` / `tbench-baseline`）——
   需要 Docker 宿主、官方 harness、数据集与镜像配额，属于环境性阻塞，不是代码缺陷。
2. **tag 只在上一门通过后才允许打**，于是 tag 也被一并卡住；
   而代码面（含 TUI 与 Task OS）早已经 main 上的 spec / smoke / 内部 bench 验证。

因此 2026-10-01 的口径：代码面按 `npm run verify` 全绿发布（v0.21.0），
外部榜单证据缺位则**不主张**对应版本，而不是补打 tag 制造发布假象。
