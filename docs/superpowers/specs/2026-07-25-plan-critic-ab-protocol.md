# Plan-Quality Critic — A/B 验证协议

**Date**: 2026-07-25
**Status**: Protocol (执行前需接真实 provider)
**Related**: spec `docs/superpowers/specs/2026-07-25-plan-completion-gate-and-critic-design.md` §3 · plan `docs/superpowers/plans/2026-07-25-plan-completion-gate-and-critic.md` Task 4

## 为什么是协议文档而非脚本

原 plan Task 4 假设 `benchmarks/agent-harness-real-world.mjs` 导出一个可复用的 `runHarnessTask(task) → {turns, completed, ...}` runner。**实测发现该假设不成立**:

- `agent-harness-real-world.mjs` 导出的是 **case 目录**(`export const cases` + `export const benchmark`),每个 case 是产品契约(`prompt` + `expectedSignals` + `forbiddenSignals`,`status: 'not-run'`),**不是自执行任务**。
- 真正跑这些 case 的是 **eval harness**(`packages/moss-agent/src/eval/`: `eval-runner.ts` 的 `EvalSuiteConfig`/`EvalCase` + `metrics.ts` 的 `MetricFn` + judge),且运行需要**真实 LLM provider + model 配置**,不是单脚本能拉起的。

因此一个 standalone 脚本无法按原 plan 假设的方式直接 `run off vs on、数 turns`。本文件给出可对真实 eval harness 执行的 A/B 协议;待接上真实 provider 后即可落地为一个 `npm run` 脚本。这是 plan Task 4 Step 2 明确授权的降级路径(「若 benchmark 不导出可复用入口,本任务降级为"记录 A/B 协议"」)。

## 验证对象

- **实验层**:`MOSS_PLAN_VALIDATE` flag(plan-completion-gate-and-critic Task 3)。default off。
- **对照**:off(baseline,主线行为)vs on(experimental,critic 接上真实 subagent runner 后)。
- **前提**:critic 当前 `makeSubagentRunner` 是 throwing placeholder(Task 3 deliberate follow-up)。**A/B 必须在真实 subagent runner 接线完成后才有意义**——否则 on 路径恒 fail-open 到 approve,与 off 无差异,测不出任何信号。runner 接线是 A/B 的硬前置(见 spec §2「critic 怎么起」+ Task 3 follow-up)。

## 实验配置

| 项 | 值 |
|---|---|
| Benchmark | `benchmarks/agent-harness-real-world.mjs` 的 `cases`(200 个真实世界 acceptance 场景) |
| Runner | eval harness `packages/moss-agent/src/eval/eval-runner.ts`(`EvalSuiteConfig` → `EvalReport[]`),需接真实 provider/model |
| 长任务子集 | `cases` 中 step 数 ≥ `MOSS_PLAN_VALIDATE_MIN_STEPS`(default 5)者——需在 case 上标注 `minSteps` 或按 category 筛选(`coding_problem_solving`/`refactor` 等多步类) |
| 轮次 | off / on 各 ≥ **3** 次(对应 spec §3 与记忆 `moss-discovery-failure-per-path-gap` 的 N≥3 要求) |
| 随机性控制 | 同一 case 在 off/on 配对跑,seed 固定;critic 的额外 LLM 调用计入 `extraLlmCalls` |

## 指标(off vs on 各 N≥3,取均值与方差)

1. **长任务真完成率** = `passed && !incomplete` 的比例。`passed` 来自 `EvalResult.passed`(`eval-runner.ts`);`incomplete` 需在 metric 中加一条「计划步骤未全 complete/skip 却声称完成」的判定(可复用 Task 2 的 `evaluatePlanCompletionGate` 逻辑作为 metric fn)。
2. **完成时平均轮数** = 触发 `end_turn` 的 turn 数均值。eval harness 当前 `EvalResult` 有 `durationMs` 但**无 turns 字段**——需在 `eval-runner.ts`/`metrics.ts` 暴露 turn 计数(或从 `toolCallsUsed.length` 近似),作为 A/B 接线的一部分。
3. **额外 LLM 调用数** = critic subagent 调用次数。从 `metrics.ts` 注入一条计数(仅 on 路径累加)。

> 注:指标 2/3 需要对 eval harness 做小量扩展(暴露 turns + critic-call 计数),这是「接真实 provider」之外的另一项接线工作。完成后才能跑出完整三指标;在只接通指标 1 的情况下也能单独判定。

## 决策门槛(跑前定死,不靠事后解释)

长任务真完成率提升 **≥ 8%** **且** 完成时平均轮数**不上升**(on.avgTurns ≤ off.avgTurns) → **保留** critic 并考虑默认开;

否则 → **关掉当教训**,记进 MEMORY(与 `moss-discovery-failure-per-path-gap` revert 教训同格式:写明假设、N、实测结果、为什么没收益)。

8% 为候选阈值;跑完首轮后可据方差调整,但调整需在文档记录,不靠事后找理由。

## 落地步骤(待 runner 接线后)

1. 接通真实 subagent runner(Task 3 follow-up):在 `moss-agent.ts` 给 `plan` 工具注入一个 host-provided `runSubagent` 入口,替换 `plan-tools.ts` 的 throwing placeholder。验证 `MOSS_PLAN_VALIDATE=on` 时 critic 真实起 subagent、返回 issues。
2. 给 eval harness 暴露 turns 计数(指标 2)与 critic-call 计数(指标 3)。
3. 写 `scripts/bench-plan-validate.mjs`:import `cases` + `eval-runner`,按本协议跑 off/on 各 ≥3 次,输出三指标的均值/方差 + verdict。
4. 跑、据决策门槛判定、记录结果。

## 不在本协议内

- 不改 `PlanExecuteController`、不改主循环内核。
- criticModel 字段(spec §2 预留)的「换更强模型」实验留作后续——首轮同模型测「critic 这层本身有没有用」。
- 本协议不替代单元/集成测试;critic 的纯函数契约(`shouldRunCritic`/`runPlanCritique` fail-open)已由 Task 3 测试覆盖。本协议测的是端到端对真实任务的增益。
