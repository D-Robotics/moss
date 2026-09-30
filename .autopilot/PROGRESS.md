# PROGRESS — moss v0.14–v0.20 autopilot

## 棒日志

- 事故（10:57,自责记录）：goal-loop A/B 首跑期间我连续重建 worktree dist → off 臂 33 run 全部秒败（0 token）、on 臂 dist 缺失退出——违反"bench 运行中禁 build"自订规则。已重发 A/B 并冻结构建。教训：**任何 bench 从 worktree dist 跑数期间（含 bench:ab/bench:tb），worktree 禁 npm run build/test；需要验证时先跑完或用快照 dist。**

- sprint-000 (2026-09-30, 编排者)：合同建立。worktree=../moss-ap（分支 autopilot/v014-v020，基点 6d73392f）。RUNNER=self。主仓三臂 A/B 由并行会话运行中（cheap/balanced 已收，routing 进行中），主仓禁 build 至其结束。验收器 10 个建于 pending/（gate 只扫 acceptance/ 顶层文件），每棒随版本落地逐个上移。全部验收器已完成"先红"自检（见 evidence/sprint-000/）。
- sprint-001 (2026-09-30, T1 ✅)：0.14-S3 命令面止血。幽灵子命令（update/mcp/plugins/migrate/web/agent）经 isUnimplementedCommand 硬错退出 2；/steer /queue /history /resume /clear 从目录/补全/help 下架（/sessions 描述改指 moss resume --last）；删 input-queue.ts 死模块（含 barrel 导出与其全部测试段）。新 spec test/cli-command-surface.spec.mjs 先红（evidence/sprint-001-command-surface-red.log）后绿；cli-interactive-commands/onboarding/tui/tui-utils-core 同步修订。gate GREEN。tag autopilot/green-001。
- sprint-002 (~02:00, T2 部分)：SWE-bench 体系：锁定 100 实例子集（bench/boards/swebench-instances.json，官方镜像名+完整题目/测试补丁）；adapter（容器内 moss headless + node 运行时注入 + patch 提取）+ orchestrator（bench:swe，--dist 冻结快照防中途污染）；官方 swebench harness 判分链路打通；smoke3（无题面盲跑）被官方判分 resolved ✓。失败复盘：首跑 swe-base1 因并行拉镜像+任务并发→网关 ECONNRESET 全灭（126 errors/100 空 patch）；镜像拉取撞 Hub 匿名配额。修复：温和重拉（sleep 300 轮询）+ 串行化执行。
- sprint-003 (02:00, T4 ✅)：v0.15-S1 /goal 引擎。goal-loop.ts（验收命令经 runProcess、失败证据注入下轮、LoopState.acceptance 持久化+restore 携带）；LoopScheduler acceptance 门（通过→completed 跳过判官；失败→否决模型 DONE）；**顺手修真 bug**：streamChat 分支丢弃 done.stopReason → budget\_\* 熔断在真实路径失效（goal-loop spec 回归锁）；REPL /goal <goal> --accept "cmd" 接线+目录行。tag green-003。
- sprint-004 (02:38, T6 ✅)：v0.15-S3 hooks 一波。Stop/SubagentStop/PreCompact/PostCompact（config 面+shell 执行同构+阻断语义：Stop 非零→REPL 强制一次续跑，headless 报告）；Pre/PostCompact 挂入 core 既有 CompactHookRegistry（零 core 改动）；生命周期 runner 模块单例（setLifecycleHookRunner，仿 setCliApprovalAsker 模式）；headless goal-verify 回路（MOSS_GOAL_VERIFY_LOOP/CMD）。AGENTS.md 解冻修订（MCP/skills 移出禁入、TUI 翻案表述、bench:swe、结构导航四行）。tag green-004。
- sprint-005 (10:04, T5 ✅)：v0.15-S2 worktree 隔离并行子代理。worktree-isolation.ts（git worktree --detach 建租约、collect 为 binary patch 入 .moss/patches、apply --3way+成功后 git add 供后续 3way 取 ours、cleanup）；SubAgentConfig.worktree + fan_out/create_subagent 工具入参 + MOSS_WORKTREE_SUBAGENTS=1 默认开（full scope）；宿主 mergeWorkspacePatch 实现接 merge_subagent_patch 工具；runner 收集 lease 字段透传。测试揭示：3 行小文件双改同 hunk 必冲突（git 3way 语义），改为真实场景（远端区域→不同 hunk→干净合并）。tag green-005。
- sprint-006 (10:06, T7 接线)：bench-ab 增 goal-loop 引擎（on 臂 MOSS_GOAL_VERIFY_LOOP=1）；run-benchmark 注入每任务 MOSS_GOAL_VERIFY_CMD=node check.mjs + TASK_DIR/CANARY_DIR。tag green-006。
- 里程碑（10:22）：**v0.13.0 发布**。p4-full2 全量 bench（干净重跑，88d0b8b0，flash，samples=3）：easy 100 / hard 93.9 达线；三臂裁决已固化（routing DEFAULT-OFF）；verify+examples+契约 spec 绿。tag v0.13.0 已推 origin。accept-01 转绿上移。
- 进行中：T8 MCP 客户端（实现子 agent）；skills+net 策略已写（src/core/skills/、src/safety/net-allowlist.ts、skill-tool、3 个 SKILL.md、.gitignore 例外、双 spec）待 MCP 释放 cli-main 后统一接线；TUI 地基五件套+spec 已写待建；SWE 镜像慢拉中（52+/90）。

## Checklist 镜像（与 task.md §4 同步）

- [x] T1 0.14-S3 命令面止血（sprint-001 完成，tag green-001）
- [ ] T2 0.14-S1/S2 SWE-bench adapter+基线+确定性 ← 进行中（镜像/数据集/adapter 就绪，冒烟调试中）
- [ ] T3 0.14 收口（S0/S4）+v0.13.0/v0.14.0 tag ← 三臂数据已收（routing DEFAULT-OFF，证据已固化）；主仓 0.13.0 版本已提交（88d0b8b0），P4 门后台运行中
- [ ] T4-S7 v0.15（goal/worktree/hooks/A/B+SWE delta+tag）
- [ ] T8-T11 v0.16（MCP/skills/出网/T-Bench+tag）
- [ ] T12 v0.17 TUI 地基+tag
- [ ] T13 v0.18 TUI 控制面+tag
- [ ] T14 v0.19 TUI 多任务面+tag
- [ ] T15 v0.20 收口+tag
- [ ] T16 发布（合并/push/夜报/蒸馏）

## 仲裁队列

- 2026-09-30 12:22 收口序列归属裁定：goal 会话 93951f1c 单点执行收口（证据→accept 门→七 tag→合并推送→夜报）；执行会话 dd2046b5 只读观察，勿并行 tag/verify/合并/推送。详见 `arbitration/2026-09-30-closing-ownership.md`。

## 打回记录

（空）

## 下一棒

> **归属（见仲裁队列 2026-09-30 12:22）**：本节收口序列由 goal 会话 93951f1c 执行；其他会话只读观察。

**终局数据链（后台 scratch/swe-endgame.sh 已发射，等双条件：镜像齐 + goal-loop A/B 完）**，串行五段：

1. swe-base2（v014 快照，plain）→ 官方判分 → **v0.14 基线证据**（accept-02）
2. swe-v016（v016 快照，plain）→ 判分 → v0.16「SWE 不回退」门
3. swe-v015goal（v016 快照 + --goal-verify：实例 f2p 测试作验收命令）→ 判分 → v0.15「SWE ≥基线+3」门
4. swe-det1/det2（astropy 前 10×1）→ 判分对比 → 确定性 ≤1 差异
5. tb-base1（Terminal-Bench 40 任务）→ v0.16 TB 基线证据

**代码面已全部完成**（sprint-001..013，13 个绿 tag）：v0.14 止血+adapter / v0.15 goal+worktree+hooks1 / v0.16 MCP+skills+net+hooks2+TB / v0.17 TUI 地基 / v0.18 控制面+审批桥 / v0.19 多任务面 / v0.20 性能预算+命令遍历+Windows 回退标注。

**数据齐后的收口序列**：

- A/B json → deltaHard≥4 且 costRatio≤1.5 → v0.15 内部门
- swe-base2 判分 → 固化 swe-baseline.json + swe-det 对比 → swe-determinism.json → 上移 accept-02
- 每版门过 → package.json 版本逐版 bump + tag v0.14.0…v0.20.0（tag 前 npm run verify 必绿）
- v0.19 门补：easy 层抽样 5 任务（bench --task 抽 easy 名单 --samples 1）100%
- v0.20 门补：全量 bench 复跑（easy 100/hard≥93.9）+ SWE ≥ swe-v015goal 水平
- 全部 tag 后：合并 autopilot/v014-v020 → main（ff 或 merge commit），push main + 8 个 tag
- 夜报 reports/night-2026-09-30.md + 蒸馏候选
