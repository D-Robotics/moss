# Autopilot 合同：Moss 长程执行图与专家团

## 1. 目标与 Done（机器可判定）

- 问题本质：把分散、不可恢复、不可合并的 agent 工作转换为单一持久执行图与证据闭环。
- 自治级别：L3（合并和推送是扳机，但用户已在任务中显式授权）。
- Done = 下列验收器全绿 + `npm run verify` 全绿 + CI 全绿：
  - [ ] `acceptance/accept-01-execution-graph.sh`
  - [ ] `acceptance/accept-02-workspace-lease.sh`
  - [ ] `acceptance/accept-03-completion-arbiter.sh`
  - [ ] `acceptance/accept-04-product-surface.sh`

## 2. Non-goals

- 不实现分布式高可用、递归专家树、共享目录并行直写或外部工作流引擎。
- 不削弱现有工具安全、审批、插件原子生命周期与错误边界。

## 3. 改动范围与禁区

- 允许改：`packages/moss-agent/`、相关 docs、OpenSpec、API reports、benchmarks、changelog。
- 禁改清单：见 `no-touch.txt`。
- 契约冻结：本 OpenSpec 在实现期间只做纠错，不为让测试变绿而弱化验收。

## 4. Checklist

- [ ] T1 Execution Graph contracts and stores
- [ ] T2 DAG scheduler and recovery policy
- [ ] T3 Workspace Lease and guarded patch merge
- [ ] T4 Expert routing, synthesis, and completion arbiter
- [ ] T5 MossAgent, plugin, CLI/Web/TUI/ACP integration and migration
- [ ] T6 public API, docs, benchmarks, full verification, merge, push, CI

## 5. 风险与不确定

- Windows 无法在本机真跑；以路径单测和 GitHub Windows CI 作为平台证据。
- 真实模型场景依赖 provider 凭据；无凭据时必须明确 SKIP，不能用 fixture 冒充。

## 6. 扳机操作

- 合并到 `main` 与 push；用户已明确授权，仅在全量门全绿后执行。
- 不执行 npm publish、删除用户数据或生产部署。

## 7. 预算与阈值

- 最大阶段：6；每个阶段 focused tests 后提交可恢复绿点。
- 同一错误连续三次或连续两阶段全量门红即熔断并报告。

