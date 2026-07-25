# 分支说明:feature/plan-completion-gate-only

**日期**: 2026-07-25
**基线分支**: `feature/observability` (commit `e7ac54a`)
**PR 入口**: https://github.com/D-Robotics/moss/pull/new/feature/plan-completion-gate-only

只含**计划完成门**(及其前提 per-session store 重构)。不含规划质量 critic、不含 A/B 协议——那些在独立分支 `feature/plan-completion-gate`,default off / 实验性,本分支不带入。

## 起点

「moss 主循环是否需要独立 Planner 规划校验层」——经分析,确定性收益在「完成时强制 plan 执行完整」,不在「执行前校验规划质量」。本分支只做前者。

## 改了什么(5 个 commit)

### 1. per-session PlanExecuteController store(`40d3a36`,refactor)
把 `plan-tools.ts` 里进程级单例换成按 `sessionKey` 路由的 store(`plan-controller-store.ts`),维护 `sessionKey → activePlanId` 映射。多 session 嵌入式 host 不再串读对方 active plan。是完成门的前提。`PlanExecuteController` 业务逻辑不动。多 session 隔离有测试。

### 2. 计划完成门本体(`99507a8`,feat)
`evaluatePlanCompletionGate(request, deps)`:模型 `end_turn` 时,若该 session 有 approved/executing 状态的 plan 且 steps 未全做完(completed+skipped)→ **否决完成**、注入 correction 逼模型继续;逃生口是 `plan_step skip` 带理由。接进 CLI `createCliCompletionGate` 链(排在 `evaluatePlanEvalCompletionGate` 后)+ MossAgent `completionGate` 包装(无 structured-pending 分支)。fail-open 覆盖 5 条路径(无 session/无 plan/状态不对/查 plan 抛错/用户中止)。类型干净(required→optional 子类型,无适配)。

### 3. MOSS_PLAN_GATE flag(`48de1f0`,feat)
default **on**(完成门是已上线功能)。`MOSS_PLAN_GATE=off` 可关,留作 A/B baseline。端到端验证:default ON 时未完成 plan 被拦 + 注入 correction;OFF 时彻底 no-op(不注入)。

### 4. 集成测试(`0a2e0b2`,test)
真起 MossAgent loop,mock provider 走 create→approve+start→提前 end_turn→被否决→skip 两步→放行。证明完成门端到端生效(否决→注入 correction→循环继续→放行)。

### 5. off vs on mock 对比(`5947bc0`,test)
同一"偷懒"mock(建 5 步 plan、做完 1 步就 end_turn)跑 off/on:off 放行无 correction、on 拦住注入 correction。证明机制方向对(注:非真实收益,因 mock 是固定偷懒非真模型)。

## 测试

6 个相关 spec 全过:plan-controller-store / plan-completion-gate(9 case)/ plan-completion-gate-integ / plan-completion-gate-ab / plan-tools-nudge / interaction-mode-exit。build + typecheck 干净。

## 已知限制(诚实)

1. **完成门真实收益未经验证**——逻辑 + 集成测试证明机制对,但真实任务里的增益(真实模型 + N≥3)未测;真 provider 试过 N=1 全噪声且烧 quota,没继续。`MOSS_PLAN_GATE` flag 留作后续真 A/B。
2. **retry 超限崩 run**——模型死活不完成也不 skip,retry 用尽会 `throw Completion rejected` 崩 run(平台既有 exhaustion 行为,非 force-complete;文档对齐了)。
3. **shared/no-session-controller plan 不受 gate 覆盖**——`ctx.sessionKey` 为空时走 shared 兜底,`setActivePlanId` 不记,gate 查不到(无 sessionKey → fail-open 放行)。CLI 总有 sessionKey,影响主要在无 sessionKey 的嵌入 host。
4. tech-debt(文档级):CLI 路径 gate 在 chain 和 wrapper 各跑一次(幂等纯函数,无副作用,仅冗余)。

## 与完整分支的区别

完整分支 `feature/plan-completion-gate` 还含:critic 实验框架(`3859849`,default off,runner 待接)+ A/B 协议 doc(`960b865`)+ final-review 修正(`c29dbbe`)。本 `*-only` 分支**不含**这些,纯完成门,适合先单独 review/合。
