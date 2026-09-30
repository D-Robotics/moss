# Autopilot 合同：moss v0.14–v0.20 全路线图执行

> 编排者 2026-09-30 填写。规划冻结于 `docs/superpowers/plans/2026-09-30-moss-v014-v020-roadmap.md`（只读参照，本合同是其执行态）。

## 1. 目标与 Done（机器可判定）

- 问题本质（一句话）：把已冻结的 v0.14–v0.20 七版路线图全部实现并过各自硬验收门，全部验证用 deepseek-flash@latest @ ai-api.d-robotics.cc，最终合并 main、推送、打齐 tag。
- 自治级别：L1（用户明示免询问 + 预授权 push/发布；扳机=tag 推送与 main 合并，用户目标中已授权）
- Done 定义 = 下列验收器全绿 + 全量门无新红 + 无越界（验收器随版本落地从 pending/ 上移到 acceptance/，成为后续回归门）：
  - [ ] `acceptance/accept-01-v013-release.sh` —— v0.13.0 tag+版本对齐+P4 证据+三臂裁决
  - [ ] `acceptance/accept-02-swebench-baseline.sh` —— SWE-bench 基线+确定性证据
  - [ ] `acceptance/accept-03-v014-gate.sh` —— 幽灵子命令非零退出（真跑）+死命令下架+tag v0.14.0+AGENTS.md 修订
  - [ ] `acceptance/accept-04-v015-goal.sh` —— goal/worktree/hooks spec+A/B ≥+4pt+SWE ≥+3pt+cost≤1.5×+tag
  - [ ] `acceptance/accept-05-v016-mcp.sh` —— MCP 双传输真连 spec+懒加载 <500token+3 skills+出网 spec+T-Bench 基线+SWE 不回退+tag
  - [ ] `acceptance/accept-06-v017-tui.sh` —— TUI PTY spec+smoke+Esc 中断/粘贴/resume 回放+tag+SDK 零 diff
  - [ ] `acceptance/accept-07-v018-tui.sh` —— steer/queue/后台/审批/用量 spec+tag
  - [ ] `acceptance/accept-08-v019-tui.sh` —— 会话/子代理/MCP 面板 spec+内部 bench 抽样+tag
  - [ ] `acceptance/accept-09-v020-final.sh` —— Windows 证据或如实标注+性能预算+全榜复核+全命令遍历+tag
  - [ ] `acceptance/accept-10-publish.sh` —— 七个 tag 齐+origin 同步+main 包含 v0.20.0+工作树净

## 2. Non-goals（本次明确不做）

- memory/跨会话自动记忆、插件市场、OS 级沙箱、remote-control/Web UI、client-server/LSP、mesh/orchestration、1M 上下文、训练/微调（路线图"全局明确不做"）
- 不改 bench/tasks/ 判分；不改内部 bench 夹具（能力必须真实提升）

## 3. 改动范围与禁区

- 允许改：src/**、test/**（新增为主）、scripts/\*\*、eslint.config.mjs、package.json、AGENTS.md、docs/superpowers/plans/2026-09-30-moss-v014-v020-roadmap.md（仅追加"执行记录"）
- 禁改：见 `no-touch.txt`（bench/tasks/、examples/、cli-headless-json-contract spec、历史规划文档）
- 契约冻结：`CONTRACT_PATHS="test/cli-headless-json-contract.spec.mjs"`
- SDK 快照（test/sdk-contract.spec.mjs）不冻结但受 semver 纪律：只能随"故意的公共面变更"同 commit 更新，禁止为绿灯单独改快照
- 主工作区 /Users/d-robotics/Desktop/RDK_Studio/moss 在三臂 A/B（并行会话）结束前禁止 build/test；一切实现在本 worktree

## 4. Checklist（一棒 ≈ 一项；RUNNER=self：由 goal 会话逐棒执行，磁盘态为真相）

- [ ] T1 0.14-S3 命令面止血：幽灵子命令非零退出+报错；/steer /history /resume /queue /clear 下架；删 input-queue.ts；先红后绿 spec
- [ ] T2 0.14-S1/S2 SWE-bench adapter：锁定子集入库+bench:swe+1 实例端到端+基线报告+10 实例确定性 ≤1
- [ ] T3 0.14 收口：S0 三臂收数+P4 门（全量 bench 新模型）+v0.13.0 tag（主仓）+S4 AGENTS.md+v0.14.0 tag
- [ ] T4 0.15-S1 /goal 引擎（goal-loop.ts+CLI+loop-scheduler 升级+单测两分支）
- [ ] T5 0.15-S2 worktree 并行子代理（不互踩单测+merge）
- [ ] T6 0.15-S3 hooks 一波（Stop/SubagentStop/PreCompact/PostCompact 阻断/放行 spec）
- [ ] T7 0.15-S4 A/B（hard ≥+4pt，cost ≤1.5×）+SWE ≥+3pt+v0.15.0 tag
- [ ] T8 0.16-S1/S2 MCP 客户端（stdio+streamable HTTP 真连 2 参照 server+懒加载 <500 token）
- [ ] T9 0.16-S3 轻量 skills（registry+skill 工具+3 真实 skills 入库+1 个被 bench 触发）
- [ ] T10 0.16-S4 网络出网策略（net.allowHosts 越权拒/放行 spec）
- [ ] T11 0.16-S5 hooks 二波+Terminal-Bench 基线+SWE 不回退+v0.16.0 tag
- [ ] T12 0.17 TUI 地基（骨架+回退链+Esc 中断+粘贴 50 行=1 turn+resume 回放+SDK 零 diff）+v0.17.0 tag
- [ ] T13 0.18 TUI 控制面（steer 接线+queue+后台面板+审批卡片+用量）+v0.18.0 tag
- [ ] T14 0.19 TUI 多任务面（会话/fork+子代理面板+MCP 管理+rewind 升级+bench 抽样）+v0.19.0 tag
- [ ] T15 0.20 收口（Windows 三例或如实标注+性能预算+全榜复核+全命令遍历）+v0.20.0 tag
- [ ] T16 发布：合并 main+push+tag 推送+夜报+蒸馏

## 5. 风险与不确定

- SWE-bench 官方镜像为 x86_64，arm64+colima 下 QEMU 仿真慢/盘大 → 验证方式：先 1 实例端到端测单实例成本，再定子集规模（≥50，若环境不可行如实记录口径调整）；roadmap 已有 50 实例回退预案
- 三臂 A/B 由并行会话在主仓进行（12:29 起跑）→ 收数以 bench/results/ab-model-routing-\*.json 出现为准备；不影响 worktree 实施
- goal 引擎榜单 delta 可能不达 +3pt → 按路线图预案：引擎按数据定默认开关，归因后仍不达则发版标注"效率门未过"，0.16 从错误分析要增量
- RUNNER=self 偏离协议的 relay 全新会话模型 → 结构性补偿：每棒从磁盘读态、上下文 65% 即收尾、gate/绿 tag 纪律不变
- ink 依赖与 Node 22.16/24 兼容性 → 0.17 首日 spike，失败则仲裁记录换方案（blessed 已排除）

## 6. 扳机操作（执行棒只准备、不执行——本任务用户已预授权，由编排者在 T16 统一执行）

- push origin main + 七个版本 tag 推送；npm publish 不适用（private 包，发布=版本+tag）

## 7. 预算与阈值

- 最大棒数：24；单棒上下文 65% 即收尾落盘
- 熔断：CONSEC_RED ≥2 / 同签名 3 次 / diff 膨胀绿灯不增 → reset 到最近绿 tag + fuse 报告
- 全量门：每 5 棒 + 每版本 tag 前 `npm run verify` 必绿
- 仲裁默认动作：L1 超时按建议选项执行（记录进 arbitration/）
