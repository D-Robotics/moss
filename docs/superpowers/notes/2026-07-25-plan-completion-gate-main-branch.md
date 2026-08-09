# 分支说明:feature/plan-completion-gate-main

**日期**: 2026-07-25
**基线**: `main` (commit `4e624a1`)
**PR 入口**: 从 main 开,base = `main`

只含**计划完成门**(及前提 per-session store 重构)。不含规划质量 critic、不含 A/B 协议、不含 spec/plan doc —— 那些在独立分支。本分支从 `main` 干净开,完成门单独进 main,不夹带 observability 分支上的其他工作(skill-eval/discovery 等)。

## 起点

「moss 主循环是否需要独立 Planner 规划校验层」——分析后确定性收益在「完成时强制 plan 执行完整」,不在「执行前校验质量」。本分支只做前者。

## 改了什么(5 个 commit)

### 1. per-session PlanExecuteController store(`8006fe6`,refactor)

把 `plan-tools.ts` 进程级单例换成按 `sessionKey` 路由的 store(`plan-controller-store.ts`),维护 `sessionKey → activePlanId` 映射。多 session 嵌入式 host 不再串读对方 active plan。完成门的前提。`PlanExecuteController` 业务逻辑不动。

### 2. 计划完成门(`f59f62b`,feat)

`evaluatePlanCompletionGate(request, deps)`:模型 `end_turn` 时若该 session 有 approved/executing 状态 plan 且 steps 未全做完(completed+skipped)→ 否决完成、注入 correction;逃生口 `plan_step skip` 带理由。接进 CLI `createCliCompletionGate` 链(排 `evaluatePlanEvalCompletionGate` 后)+ MossAgent `completionGate` 包装(无 structured-pending 分支)。fail-open 5 路径。类型干净(required→optional 子类型)。

### 3. MOSS_PLAN_GATE flag(`f758f0c`,feat)

default on。`=off` 可关做 A/B baseline。端到端验证:ON 拦+注入 correction,OFF 彻底 no-op。

### 4. 集成测试(`2bacf21`,test)

真起 MossAgent loop:create→approve+start→提前 end_turn→被否决→skip 两步→放行。

### 5. off vs on mock 对比(`6b2fcea`,test)

同一偷懒 mock:off 放行无 correction、on 拦住注入 correction。证明机制方向(非真实收益)。

## 测试

6 个相关 spec 全过(plan-controller-store / plan-completion-gate 9 case / -integ / -ab / plan-tools-nudge / interaction-mode-exit)。build + typecheck 干净。完成门不依赖 observability 任何东西,从 main 独立成立。

## 已知限制(诚实)

1. **完成门真实收益未经验证** — 机制 + 集成测试证明方向对,真实任务增益(真模型 + N≥3)未测;真 provider 试过 N=1 全噪声且烧 quota。`MOSS_PLAN_GATE` flag 留作后续真 A/B。
2. **retry 超限崩 run** — 模型死活不完成也不 skip,retry 用尽 `throw Completion rejected` 崩 run(平台既有 exhaustion 行为,非 force-complete)。
3. **shared/no-session plan 不受 gate 覆盖** — `ctx.sessionKey` 空时走 shared 兜底,gate 查不到 → fail-open 放行。CLI 总有 sessionKey,影响主要在无 sessionKey 嵌入 host。
4. tech-debt(文档级):CLI 路径 gate 在 chain 和 wrapper 各跑一次(幂等纯函数,仅冗余)。
