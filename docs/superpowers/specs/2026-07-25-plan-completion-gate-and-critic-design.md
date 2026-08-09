# moss 计划完成门 + 规划质量校验实验 设计

**Date**: 2026-07-25
**Status**: Design / 待 review
**Scope**: 给 moss 主循环加两层、彼此独立的能力 —— ① 计划完成门(直接做):有 approved/executing plan 但 steps 未完成时,否决模型提前完成;② 规划质量校验实验(可 A/B、default off):执行前用独立 subagent critique plan 质量。

## 目标

1. **完成门**:堵住长任务最常见的失败模式 —— 模型有 plan 但没执行完就声称 `end_turn` 收工。要求:未完成 → 硬否决;模型只能靠 `plan_step skip`(带理由)或真做完才能放行。
2. **规划质量校验实验**:验证「执行前用独立视角 critique 计划」到底有没有用。要求:default off、靠 flag 开启、仅长 plan 触发、能在现有 benchmark 上 A/B 对比(N≥3)再决定去留 —— 不靠"我觉得更好"拍脑袋。

核心理念:完成门是**确定性收益**(纯结构检查、零额外 LLM 成本)直接做;校验层是**不确定收益 + 确定成本**(额外一次带上下文的 LLM 调用)做成可验证实验,让数据说话。这正对应历史教训「凭假设改 loop 翻车、N≥3 才信」(见 `moss-discovery-failure-per-path-gap` 记忆)。

## 探明的事实(影响设计)

- 主循环内核是原生 `tool_use` 直链(`agent-loop-response.ts`),但外壳有大量宿主编排(nudge / guard / gate / steering)。`plan`/`plan_step` 是暴露给 LLM 的工具(`builtin.ts:504`),背后是 `PlanExecuteController`(`plan-execute-controller.ts`)。
- `PlanExecuteController.reviewPlan`(:157)**只做结构校验**(拓扑、空值、循环依赖),**不校验规划质量**(步骤是否遗漏、方向是否错、是否可行)。
- 主循环**无完成时完整性检查**:没有任何一处拦"approved plan 但 steps 没做完就完成"。`completionGate`(`agent-loop-response.ts:276`)能拿到 `messages` + `toolCallsByName`(能数 `plan_step`),但当前没人用它查 plan 完整性。
- `completionGate` 是官方 host 扩展点(`agent-loop-types.ts:110`),有 `retryLimit` 续命机制。**CLI 入口**(`cli-main.ts:650` 的 `createCliCompletionGate`)已是一条 ~30 个 `evaluate*` 门组成的链(`coding-completion-gate.ts:2737`),其中已有 `evaluatePlanEvalCompletionGate`(:2397 / :2748)——它拦的是「模型在 prose 里*声称* plan 完成/approved 但本轮根本没调 `plan`/`plan_step`」(turn-local 工具计数)。**MossAgent 入口**(`moss-agent.ts:1486` 的 `completionGate` 包装)只做 structured-output 校验再委托 `config.completionGate`,**完全不跑 CLI 链、对 plan 工具一无所知**。
- **关键区分(决定本设计的落点)**:`evaluatePlanEvalCompletionGate` 只看「本轮有没有调过 plan 工具」,**看不到 `PlanExecuteController` 状态** → 模型对 5 步 plan 只 `plan_step complete` 2 步就声称"execution complete"时,`usedPlan>0` → **放行**,半截 plan 漏过。本设计的完成门补的正是这个缺口(查**步骤实际完整性**,不是**本轮工具计数**)。两者互补、非重复。
- **因此两入口落点不同**:CLI 侧 = 在 `createCliCompletionGate` 链里**新增**一个 `evaluatePlanCompletionGate`(沿用 `evaluate*` 模式);MossAgent 侧 = 在其 `completionGate` 包装里**新装**这个 gate(因嵌入 host 当前对 plan 无任何处理)。完成门纯函数 `evaluatePlanCompletionGate(request, deps)` 共用,`deps` 注入 `getPlanController` 以查 plan 状态(CLI 链的 `evaluate*` 是纯函数无 deps,本 gate 因需查 controller 故带 deps 参数,在链组装处注入)。是完成门的自然落点,不改主循环内核。
- **`PlanExecuteController` 现是进程级隐藏单例**(`plan-tools.ts:60` 的 `controllerInstance`),多 session 共享一个实例、内部只一个 `activePlanId` 指针。嵌入场景多 MossAgent 同进程时,A/B session 会串读对方 plan。**这是落地完成门的硬前提重构**(见下「per-session controller store」)。
- `subagent-runner.ts` 存在且 thread `completionGate`,可起独立子循环做 critic —— 是校验实验"独立视角"的载体。
- plan-mode(`interactionMode === 'plan'`)是真实模式,有工具 allowlist(`approval.ts:445`)和 approve→落 default 的门(`plan-tools.ts:282`)。完成门与 plan-mode 正交,不依赖 mode。
- benchmark 已有 `benchmarks/agent-harness-real-world.mjs`(真实任务集),A/B 脚本可复用。

## 设计

### §1 完成门

**做什么**:模型 `end_turn` 且有可见答案、主循环即将 yield 前,查「该 session 是否存在 approved/executing 状态的 plan,且已完成 step < 总 step」。命中 → 否决完成、注入 correction;放行条件 = 已完成 step(completed + skipped)≥ 总 step。

**挂哪儿**:host 侧 `completionGate`,不改主循环内核。完成门逻辑做成独立纯函数 `evaluatePlanCompletionGate(request, deps)`,签名带 `deps: { getPlanController }`(因需查 plan 状态;区别于链里其他无 deps 的 `evaluate*`)。CLI 侧:在 `createCliCompletionGate` 链(`coding-completion-gate.ts:2737`)里**新增**一个条目(排在 `evaluatePlanEvalCompletionGate` 之后),`deps.getPlanController` 由链组装处从 per-session store 注入。MossAgent 侧:在其 `completionGate` 包装(`moss-agent.ts:1486`,structured-output 委托 `config.completionGate` 之前)**新装**这个 gate(嵌入 host 当前对 plan 无任何处理,必须新装才覆盖)。两处共用同一纯函数,不分叉。

**per-session controller store(硬前提重构)**:把 controller 实例管理从 `plan-tools.ts` 提到 `plan-controller-store.ts`,按 `sessionKey` 取实例(`Map<sessionKey, PlanExecuteController>`),无 sessionKey 时退回共享实例兜底(向后兼容)。`plan`/`plan_step` 工具改为 `getPlanController(ctx.sessionKey)`;controller 补一个「按 session 查 active plan」入口(store 维护 `sessionKey → activePlanId`)。**`PlanExecuteController` 业务逻辑(状态机/review/replan)全不动**,只改"实例从哪来" + 加一个查询入口。理由:完成门要查的是**本 session 自己的** plan,进程单例会跨 session 串读,使完成门变成"形式上查了、实际查错对象",重蹈 `moss-skill-eval-scoring-blindspot` 那条"判分盲区"覆辙。

**触发条件(精确)**:

- `getPlanController(sessionKey).getActivePlanForSession(sessionKey)` 存在 且 `status ∈ {approved, executing}`
- 已完成 step(`completed` + `skipped`)< 总 step
- → 否决,`correction` 文本明确列出未完成 step 描述 + "继续执行,或对每步用 `plan_step skip` 给理由"
- 已完成 step ≥ 总 step → 放行 `{ok: true}`

**escape hatch(硬否决但不僵死)**:逃生口收窄到 `plan_step skip`(带理由)。模型对每个未完成 step 显式 skip 并给理由,门才放行。满足"硬否决"强度,同时避免小任务被卡死,且保留可审计轨迹(每个 skip 带理由进 session)。

**retry 预算**:复用 completionGate 的 `retryLimit`,上限 2 次,防模型与门无限拉锯。超限 → 放行完成 + 记 telemetry `plan_incomplete_forced_complete`(走现有 `run_metrics`,不静默)。

### §2 规划质量校验(可 A/B 实验)

**一句话**:`plan action=approve` 时、真正开始执行前,起独立 subagent critique plan 质量,有 issues 则阻止 approve、把 issues 列给模型逼其改 plan。default off、flag 开启、仅长 plan 触发。

**触发点**:挂在 `plan` 工具 `approve` action(`plan-tools.ts:264`)——不挂 `create`。理由:`create` 只是起草模型可能自改,`approve` 是"要执行了"的不可逆点,在它拦才有意义,且与完成门形成「执行前校验质量 + 完成前校验完整性」两端闭环。`approve` 命中触发条件时,在 `confirmPlanApprovalIfNeeded` 之后、`controller.approvePlan` 之前插入校验;critic 返回 issues → 不调 `approvePlan`,返回 `[plan: needs revision]` + issues(复用现有 `review` action 返回格式 `plan-tools.ts:229`,改动最小),模型自然进入"改 plan 再 approve"。

**两个开关(flag + 仅长 plan)**:

```
MOSS_PLAN_VALIDATE=on|off   (default off)   总开关
MOSS_PLAN_VALIDATE_MIN_STEPS=5              触发门槛:plan steps ≥ N 才校验
```

- **off**:plan 工具行为完全等同现状,主线零影响 = A/B baseline。
- **on + steps < N**:不校验,直接 approve(短 plan 不付 critic 成本)。
- **on + steps ≥ N**:起 subagent critique。
- 门槛 N 本身是 A/B 变量:N 太大≈没实验,太小让短 plan 白跑 critic。首轮默认 N=5,跑完数据再调。

**critic 怎么起**:`subagent-runner.ts` 起独立子循环,喂入 任务原文(session 最近真实 user text)+ plan 全文(`PlanExecuteController.formatPlan`)+ 精简 critic system prompt,要求输出结构化 issues `[{step, severity, problem, suggestedFix}]`(走 `structured-output` 模块约束)。**模型**:default 同主模型;`plan-controller-store`/config 预留 `criticModel` 字段(空=同主模型),后续可换更强模型直接测"独立模型 critic 增益",无需再改架构——这是对抗"同模型 critic 放行"风险的设计余地。首轮先同模型,测"critic 这层本身有没有用"。

**输出去向**:critic issues **不进主对话流可见消息**(不污染用户看到的回答),作为 `plan` 工具返回值回给模型(模型看到 `[plan: needs revision]` + issues)。

### §3 错误处理(fail-open,统一原则)

两个模块都遵守「fault 时退回现状,不放大故障」——与 moss `flushAssistantBuffer`(:261)「单条失败跳过、不丢整轮」哲学一致。

**完成门**:gate 内部对所有外部依赖(controller 取不到、sessionKey 异常)try 兜底 → 出错默认放行 `{ok:true}`。坏的代价是"退回现状"(可能提前完成),远小于"卡死不让完成"。retry 超限 → 放行 + telemetry `plan_incomplete_forced_complete`。

**校验实验**:critic subagent 超时/失败/返回非结构化/解析失败 → 一律视为通过(放行 approve),不阻塞执行,记 `plan_validate_parse_failed` / `plan_validate_timeout` telemetry。flag off 时整条路径不执行,零错误面。

## 测试

**完成门**

- 单元:构造 controller + plan,模拟完成态(全完成/有未完成/有 failed step/有 skip step),断言 gate 的 ok/correction。escape hatch:未完成但全 skip 带理由→放行;未完成无 skip→否决。retry 上限:超限放行 + telemetry 标记。
- 集成:最小 agent loop,模型故意 plan 未完成就 `end_turn`,断言被否决、注入 correction、循环继续;`plan_step skip` 后再 `end_turn`,断言放行。
- **多 session 隔离(§1 重构存在的全部理由)**:两 sessionKey 各建 plan,断言 A 的 gate 查不到 B 的 plan。

**校验实验**

- 单元:flag off→approve 直接过、不调 subagent;flag on + steps<N→不调;flag on + steps≥N→调一次 mock critic,issues 非空→阻止 approve 返回 issues;critic 抛错→放行。
- 集成:mock subagent-runner,断言 issues 回流成 plan 工具返回值、模型进入"改 plan"。

**A/B 验证脚本**:`scripts/bench-plan-validate.mjs`,跑 off/on 对比(≥3 次、输出均值/方差),复用 `agent-harness-real-world.mjs`。能 `npm run` 跑出来,不是纸上理论。

### A/B 指标与决策门槛(跑前定死)

- **benchmark**:`benchmarks/agent-harness-real-world.mjs`。
- **指标**(off vs on 各跑 ≥3 次取均值/方差):
  1. 长 plan(≥N 步)任务的**真完成率**
  2. 完成时的**平均轮数**(校验若有效应减少中途纠偏轮,无效则只增不减)
  3. **额外 LLM 调用数**(critic 成本)
- **决策门槛**:长任务真完成率提升 ≥8% **且** 平均轮数不上升 → 保留并考虑默认开;否则 → 关掉当教训,记进 MEMORY(与 `moss-discovery-failure-per-path-gap` revert 教训同格式)。X=8% 为候选,写实现计划时定稿。

## 整体落点(文件清单)

```
新建:
  packages/moss-agent/src/plan-execute/plan-controller-store.ts    per-session controller + getter
  packages/moss-agent/src/plan-execute/plan-completion-gate.ts       完成门逻辑(纯函数)
  packages/moss-agent/src/plan-execute/plan-critic.ts                校验实验(critic subagent + flag)
  packages/moss-agent/src/plan-execute/plan-critic-prompt.ts         critic system prompt
  packages/moss-agent/src/plan-execute/plan-controller-store.test.ts
  packages/moss-agent/src/plan-execute/plan-completion-gate.test.ts
  packages/moss-agent/src/plan-execute/plan-critic.test.ts
  scripts/bench-plan-validate.mjs                                    A/B 对比脚本
改动:
  packages/moss-agent/src/plan-execute/plan-tools.ts   getController→per-session store;approve action 插入 critic
  packages/moss-agent/src/cli/coding-completion-gate.ts  并入完成门逻辑
  packages/moss-agent/src/core/agent/moss-agent.ts       completionGate 包装并入完成门
  packages/moss-agent/src/plan-execute/index.ts          导出新模块
  docs/user-guide/19-plan-mode.md                        文档:完成门行为 + 实验 flag
```

`PlanExecuteController` 本体不动业务逻辑。按 session 查 active plan 的入口**采用「store 维护 `sessionKey → activePlanId` 映射」方案**:controller 保持无 session 状态,store 负责路由(`getActivePlanForSession(sessionKey) = controller.getPlan(store.activePlanIdOf(sessionKey))`)。理由:controller 已有 `getPlan(planId)` 且逻辑无需改,session 路由是 store 的职责,边界清晰。`start`/`approve` 时由 store 记录 `activePlanIdOf[sessionKey]`。

## 顺序与依赖

1. **per-session controller store**(§1 硬前提,§2 也复用取 plan)
2. **完成门**(独立可发,无 flag,无外部依赖)—— 第 2 步即可独立验证有效
3. **校验实验 + A/B 脚本**(flag off,实验性)—— 第 3 步跑 A/B,数据决定去留
4. **文档**

完成门与校验实验**完全独立**:可单独 on/off、单独验证、单独决定去留。完成门直接做(确定性收益);校验靠数据决定(避免重蹈"凭假设改 loop"覆辙)。

## 不在本设计内(YAGNI)

- 不改 `PlanExecuteController` 业务逻辑(状态机/review/replan 全不动)。
- 不改主循环内核(`agent-loop.ts`/`agent-loop-response.ts` 的 LLM 调用与 tool 执行路径不动),只通过 host 扩展点接入。
- 不做形态 2(reviewPlan 加纯规则语义校验)和形态 3(事后复盘)—— 前者非"独立视角"且泛化差,后者时机不对。
- 不默认开启校验实验、不预置 critic 模型 —— 首轮同模型测"critic 这层本身有没有用",换模型留作后续。
