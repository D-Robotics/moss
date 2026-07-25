# 分支说明:feature/plan-completion-gate

**日期**: 2026-07-25
**基线分支**: `feature/observability` (commit `e7ac54a`)
**PR 入口**: https://github.com/D-Robotics/moss/pull/new/feature/plan-completion-gate

给 moss 主循环加两层 plan 完整性能力 + 一个可 A/B 的实验框架,共用以一个 per-session store 重构为前提。起点是「moss 主循环是否需要独立 Planner 规划校验层」这个问题——经分析拆成两个独立问题:**执行前校验规划质量**(实验性,default off)**完成时强制 plan 执行完整**(确定性收益,已上线)。

## 改了什么(8 个 commit)

### 1. per-session PlanExecuteController store(`1908392`,refactor)
把 `plan-tools.ts` 里进程级单例换成按 `sessionKey` 路由的 store(`plan-controller-store.ts`),维护 `sessionKey → activePlanId` 映射。多 session 嵌入式 host 不再串读对方 active plan。是完成门和 critic 的共同前提。`PlanExecuteController` 业务逻辑不动。多 session 隔离有测试。

### 2. 计划完成门(`4005b48`,feat + `3b10123` flag)
`evaluatePlanCompletionGate(request, deps)`:模型 `end_turn` 时,若该 session 有 approved/executing 状态的 plan 且 steps 未全做完(completed+skipped)→ **否决完成**、注入 correction 逼模型继续;逃生口是 `plan_step skip` 带理由。接进 CLI `createCliCompletionGate` 链(排在 `evaluatePlanEvalCompletionGate` 后)+ MossAgent `completionGate` 包装(无 structured-pending 分支)。fail-open 覆盖 5 条路径。类型干净(required→optional 子类型)。`MOSS_PLAN_GATE` flag(default on,off 可关做 A/B baseline)。

### 3. 规划质量校验 critic(`3859849`,feat,实验性 default off)
`plan-critic.ts` + `plan-critic-prompt.ts`:`MOSS_PLAN_VALIDATE` flag(默认关)+ `MOSS_PLAN_VALIDATE_MIN_STEPS`(默认 5)控制;挂在 `plan action=approve` 时起 subagent critique plan 质量,有 issues 则阻止 approve、回流给模型。`runPlanCritique` 带 injected `runSubagent`,fail-open。**真实 subagent runner 尚未接线**(`createSubAgentRunner` 是 host-deps 工厂,无 one-shot 入口可从工具调)——default off + fail-open 保证安全,接线是 deliberate follow-up。

### 4. A/B 验证协议(`960b865`,docs)
原计划写 off/on 脚本,实测发现 `agent-harness-real-world.mjs` 是 case 目录 + eval-harness(要真实 provider),非 plan 假设的 runner。降级成协议文档:指标(真完成率/平均轮数/额外 LLM 调用)、N≥3、≥8% 决策门槛、跑前定死。

### 5. final-review 修正(`c29dbbe`,docs)
spec §1 retry-budget 对齐现状(retry 超限 throw 崩 run,非放行);`lastRealUserTextFromContext` 标 STUB;plan checklist 改 criticModel 未预留。

### 6. 测试(`45ddca3` 集成 / `51f7002` off vs on)
- `plan-completion-gate-integ.spec.mjs`:真起 agent loop,否决→skip→放行闭环
- `plan-completion-gate-ab.spec.mjs`:mock 偷懒模型,off 放行 / on 拦住,证明机制方向(非真实收益)

## 测试

7 个相关 spec 全过:plan-controller-store / plan-completion-gate(9 case) / plan-completion-gate-integ / plan-completion-gate-ab / plan-critic / plan-tools-nudge / interaction-mode-exit。build + typecheck 干净。

## 已知限制 / 待办(非 blocker)

1. **critic 真实 subagent runner 未接线**——框架就位、default off、fail-open,但实验跑不了。需在 `moss-agent.ts` 加 host-provided `runSubagent` 注入点。
2. **A/B 协议待落地**——需先接 critic runner + 给 eval-harness 暴露 turns/critic-call 计数。
3. **完成门收益未经验证**——逻辑+集成测试证明机制对,但真实收益(真实任务、N≥3)未测;真 provider 试过 N=1 全是噪声且烧 quota。`MOSS_PLAN_GATE` flag 留作后续 A/B。
4. **完成门 retry 超限崩 run**——模型死活不完成也不 skip 会 `Completion rejected` throw(平台既有行为,spec 已对齐)。
5. tech-debt(M1/M4/M5,文档级):CLI 路径 gate 双执行(幂等无副作用);spec 承诺的 agent-loop 集成测试现已补(原 M4 已 close);shared/no-session-controller plan 不受 gate 覆盖(19-plan-mode.md 未注明)。
