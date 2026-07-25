# moss 计划完成门 + 规划质量校验实验 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 moss 主循环加计划完成门(直接做)+ 规划质量校验实验(default off、可 A/B),共用以 per-session PlanExecuteController store 重构为前提。

**Architecture:** 完成门 = `completionGate` 链/包装里的一个新 `evaluatePlanCompletionGate` 纯函数,查 `PlanExecuteController` 的 plan 步骤完整性,未完成则否决 + 注入 correction,escape hatch 走 `plan_step skip`。校验实验 = `plan action=approve` 时起 subagent critique,`MOSS_PLAN_VALIDATE` flag + `MIN_STEPS` 门槛控制,default off。两者共用 per-session controller store(把进程单例换成 `sessionKey→controller` 路由)。

**Tech Stack:** TypeScript(ESM)、Node ≥22.16、`node:test`/`node:assert`(测试文件为 `*.spec.mjs`,从 `dist/` 导入编译产物 —— 见现有 `test/plan-tools-nudge.spec.mjs`)、moss 现有 `subagent-runner`、`structured-output`。

## Global Constraints

- 测试用 `node --test` 跑,测试文件 `*.spec.mjs`,从 `../dist/...` 导入(必须先 `npm run build`)。现有范例:`packages/moss-agent/test/plan-tools-nudge.spec.mjs`。
- 主循环内核(`agent-loop.ts`/`agent-loop-response.ts` 的 LLM 调用与 tool 执行路径)**不动**,只通过 host `completionGate` 扩展点与 `plan` 工具接入。
- `PlanExecuteController` 业务逻辑(状态机/review/replan)**全不动**,只改"实例从哪来" + store 维护 `sessionKey→activePlanId` 映射。
- fail-open:任何 gate/critic 故障默认放行,不卡死任务。
- 每个 Task 结尾 commit。Commit message 用 conventional 格式 + `Co-Authored-By: Claude <noreply@anthropic.com>`。
- 提交前若在默认分支先开分支;当前已在 `feature/observability` 分支,可直接提交。

---

## File Structure

**新建:**
- `packages/moss-agent/src/plan-execute/plan-controller-store.ts` — per-session `PlanExecuteController` 路由 + `sessionKey→activePlanId` 映射。职责:实例获取 + active plan 路由,无业务逻辑。
- `packages/moss-agent/src/plan-execute/plan-completion-gate.ts` — `evaluatePlanCompletionGate(request, deps)` 纯函数。职责:查 plan 步骤完整性,未完成→否决。
- `packages/moss-agent/src/plan-execute/plan-critic-prompt.ts` — critic 的 system prompt。职责:prompt 文本。
- `packages/moss-agent/src/plan-execute/plan-critic.ts` — `runPlanCritique(...)` flag+门槛判定 + 起 subagent + 结构化 issues + fail-open。职责:校验实验入口。
- `packages/moss-agent/test/plan-controller-store.spec.mjs`
- `packages/moss-agent/test/plan-completion-gate.spec.mjs`
- `packages/moss-agent/test/plan-critic.spec.mjs`
- `scripts/bench-plan-validate.mjs` — A/B 对比脚本(≥3 次 off/on)。

**修改:**
- `packages/moss-agent/src/plan-execute/plan-tools.ts` — `getController()` → per-session store;`start`/`approve` 时 store 记 `activePlanIdOf[sessionKey]`;`approve` action 插入 critic。
- `packages/moss-agent/src/cli/coding-completion-gate.ts` — 链里新增 `evaluatePlanCompletionGate` 条目(`:2737` 附近)+ `deps` 注入。
- `packages/moss-agent/src/core/agent/moss-agent.ts` — `completionGate` 包装(`:1486`)新装 plan completion gate。
- `packages/moss-agent/src/plan-execute/index.ts` — 导出新模块。
- `docs/user-guide/19-plan-mode.md` — 文档:完成门行为 + 实验 flag。

---

## Task 1: per-session PlanExecuteController store

**Files:**
- Create: `packages/moss-agent/src/plan-execute/plan-controller-store.ts`
- Modify: `packages/moss-agent/src/plan-execute/plan-tools.ts:60-71` (移除进程单例,改用 store)
- Test: `packages/moss-agent/test/plan-controller-store.spec.mjs`
- Modify: `packages/moss-agent/src/plan-execute/index.ts` (导出)

**Interfaces:**
- Consumes: `PlanExecuteController`(`plan-execute-controller.ts`,业务逻辑不动)
- Produces:
  - `getPlanController(sessionKey: string): PlanExecuteController` — 按 session 取/建实例
  - `getSharedPlanController(): PlanExecuteController` — 无 session 兜底(向后兼容单 agent)
  - `setActivePlanId(sessionKey: string, planId: string): void`
  - `getActivePlanId(sessionKey: string): string | undefined`
  - `resetPlanControllerStoreForTests(): void` — 测试用清空
  - `getActivePlanForSession(sessionKey: string): Plan | null` — 便捷封装(`controller.getPlan(getActivePlanId(sessionKey))`)

- [ ] **Step 1: 写失败测试**

`packages/moss-agent/test/plan-controller-store.spec.mjs`:
```js
#!/usr/bin/env node
import assert from 'node:assert/strict';
import {
  getPlanController,
  getSharedPlanController,
  setActivePlanId,
  getActivePlanId,
  getActivePlanForSession,
  resetPlanControllerStoreForTests,
} from '../dist/plan-execute/plan-controller-store.js';

// per-session: 不同 sessionKey 拿到不同实例
{
  resetPlanControllerStoreForTests();
  const a = getPlanController('sess-a');
  const b = getPlanController('sess-b');
  assert.notEqual(a, b, 'different sessionKeys get different controllers');
  assert.equal(getPlanController('sess-a'), a, 'same sessionKey returns same instance');
}

// activePlanId 按 session 隔离 —— A 的 gate 查不到 B 的 plan
{
  resetPlanControllerStoreForTests();
  const a = getPlanController('sess-a');
  const b = getPlanController('sess-b');
  const planA = a.createPlan('goal A', [{ step: 1, description: 'do A' }]);
  const planB = b.createPlan('goal B', [{ step: 1, description: 'do B' }]);
  setActivePlanId('sess-a', planA.id);
  setActivePlanId('sess-b', planB.id);
  assert.equal(getActivePlanId('sess-a'), planA.id);
  assert.equal(getActivePlanId('sess-b'), planB.id);
  // A 的 session 只看到 A 的 plan
  assert.equal(getActivePlanForSession('sess-a')?.id, planA.id);
  assert.equal(getActivePlanForSession('sess-a')?.goal, 'goal A');
  assert.equal(getActivePlanForSession('sess-b')?.id, planB.id);
  // 关键:A 查不到 B
  assert.notEqual(getActivePlanForSession('sess-a')?.id, planB.id);
}

// shared fallback: 无 session 兜底共享实例
{
  resetPlanControllerStoreForTests();
  const s1 = getSharedPlanController();
  const s2 = getSharedPlanController();
  assert.equal(s1, s2, 'shared fallback returns same instance');
}

// 未知 session: getActivePlanForSession 返回 null
{
  resetPlanControllerStoreForTests();
  assert.equal(getActivePlanForSession('nope'), null);
}
console.log('plan-controller-store: ok');
```

- [ ] **Step 2: 跑测试验证失败**

Run: `cd packages/moss-agent && npm run build && node --test test/plan-controller-store.spec.mjs`
Expected: FAIL,模块找不到(`ERR_MODULE_NOT_FOUND` for `plan-controller-store.js`)。

- [ ] **Step 3: 写最小实现**

`packages/moss-agent/src/plan-execute/plan-controller-store.ts`:
```ts
import { PlanExecuteController } from './plan-execute-controller.js';
import type { Plan } from './plan-execute-controller.js';

const DEFAULT_CONFIG = { maxReplans: 3, requireApproval: true, autoApproveSimple: true };

const sessionControllers = new Map<string, PlanExecuteController>();
let sharedController: PlanExecuteController | null = null;
const activePlanIdBySession = new Map<string, string>();

export function getPlanController(sessionKey: string): PlanExecuteController {
  let c = sessionControllers.get(sessionKey);
  if (!c) {
    c = new PlanExecuteController({ ...DEFAULT_CONFIG });
    sessionControllers.set(sessionKey, c);
  }
  return c;
}

export function getSharedPlanController(): PlanExecuteController {
  if (!sharedController) sharedController = new PlanExecuteController({ ...DEFAULT_CONFIG });
  return sharedController;
}

export function setActivePlanId(sessionKey: string, planId: string): void {
  activePlanIdBySession.set(sessionKey, planId);
}

export function getActivePlanId(sessionKey: string): string | undefined {
  return activePlanIdBySession.get(sessionKey);
}

export function getActivePlanForSession(sessionKey: string): Plan | null {
  const id = activePlanIdBySession.get(sessionKey);
  if (!id) return null;
  return getPlanController(sessionKey).getPlan(id);
}

export function resetPlanControllerStoreForTests(): void {
  sessionControllers.clear();
  activePlanIdBySession.clear();
  sharedController = null;
}
```

- [ ] **Step 4: 改 `plan-tools.ts` 用 store**

`packages/moss-agent/src/plan-execute/plan-tools.ts`:删掉 `:60-71` 的 `controllerInstance`/`getController`,改为:
```ts
import {
  getPlanController,
  getSharedPlanController,
  setActivePlanId,
} from './plan-controller-store.js';
```
把工具内 `const controller = getController();` 全部换成 `const controller = ctx.sessionKey ? getPlanController(ctx.sessionKey) : getSharedPlanController();`(`plan` 工具的 `execute(input, ctx)` 有 `ctx.sessionKey`;`plan_step` 工具 `execute(input, _ctx)` 改成 `execute(input, ctx)` 用 `ctx.sessionKey`)。

⚠️ `resetPlanControllerForTests`(`:122`)现状清的是 `controllerInstance`,现在改成转发到 store:`export function resetPlanControllerForTests(): void { resetPlanControllerStoreForTests(); }`(从 store 模块 import `resetPlanControllerStoreForTests`)。

- [ ] **Step 5: 在 `start`/`approve` 时记录 activePlanId**

`plan-tools.ts` 的 `plan` 工具 `start` 与 `approve` case 里,成功后(`controller.startExecution(...)` / `controller.approvePlan(...)` 返回 true)加:
```ts
if (ctx.sessionKey) setActivePlanId(ctx.sessionKey, input.planId);
```
（`approve` 在 `controller.approvePlan(input.planId)` 之后;`start` 在 `controller.startExecution(input.planId)` 之后。）

- [ ] **Step 6: 导出新模块**

`packages/moss-agent/src/plan-execute/index.ts`:在现有 export 块里加:
```ts
export {
  getPlanController,
  getSharedPlanController,
  setActivePlanId,
  getActivePlanId,
  getActivePlanForSession,
  resetPlanControllerStoreForTests,
} from './plan-controller-store.js';
```

- [ ] **Step 7: 跑测试验证通过**

Run: `cd packages/moss-agent && npm run build && node --test test/plan-controller-store.spec.mjs`
Expected: PASS,`plan-controller-store: ok`。

- [ ] **Step 8: 回归现有 plan-tools 测试**

Run: `cd packages/moss-agent && npm run build && node --test test/plan-tools-nudge.spec.mjs`
Expected: PASS(此测试只测 nudge 纯函数,不受 store 改动影响;确认没把 import 路径改坏)。

- [ ] **Step 9: Commit**

```bash
cd D:/moss-drobotics
git add packages/moss-agent/src/plan-execute/plan-controller-store.ts \
        packages/moss-agent/test/plan-controller-store.spec.mjs \
        packages/moss-agent/src/plan-execute/plan-tools.ts \
        packages/moss-agent/src/plan-execute/index.ts
git commit -m "refactor(plan): per-session PlanExecuteController store

Replace the process-wide singleton in plan-tools.ts with a sessionKey-routed
store. Multi-session embedded hosts no longer cross-read each other's active
plan. store maintains sessionKey->activePlanId; controller business logic
unchanged.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 2: 计划完成门(纯函数 + CLI 链 + MossAgent 包装)

**Files:**
- Create: `packages/moss-agent/src/plan-execute/plan-completion-gate.ts`
- Modify: `packages/moss-agent/src/cli/coding-completion-gate.ts:2737-2774` (链里新增条目 + deps 注入)
- Modify: `packages/moss-agent/src/core/agent/moss-agent.ts:1486-1498` (包装里新装)
- Modify: `packages/moss-agent/src/plan-execute/index.ts` (导出)
- Test: `packages/moss-agent/test/plan-completion-gate.spec.mjs`

**Interfaces:**
- Consumes: `getActivePlanForSession(sessionKey)`(Task 1);`Plan`/`PlanStep` 类型(`plan-execute-controller.ts`);CLI 侧 `CodingCompletionGateRequest`/`CodingCompletionGateResult`(`coding-completion-gate.ts` 顶部定义);agent-loop 侧 `completionGate` 的 request 类型(`agent-loop-types.ts:110`)
- Produces:
  - `evaluatePlanCompletionGate(request, deps): { ok: true } | { ok: false; reason: string; correction: string; retryLimit: number }`
    - `request: { sessionKey?: string; stopReason?: string }`(CLI 侧 `CodingCompletionGateRequest` 已有 `sessionKey`/`stopReason`;agent-loop 侧 request 也有,见 `agent-loop-types.ts:110`)
    - `deps: { getActivePlanForSession: (sessionKey: string) => Plan | null }`

- [ ] **Step 1: 写失败测试**

`packages/moss-agent/test/plan-completion-gate.spec.mjs`:
```js
#!/usr/bin/env node
import assert from 'node:assert/strict';
import { PlanExecuteController } from '../dist/plan-execute/plan-execute-controller.js';
import { evaluatePlanCompletionGate } from '../dist/plan-execute/plan-completion-gate.js';

// helper: 造一个 controller + plan,返回 {plan, getActive}
function makePlan({ steps, status, completeSteps = [], skipSteps = [] }) {
  const c = new PlanExecuteController({ maxReplans: 3, requireApproval: false, autoApproveSimple: false });
  const plan = c.createPlan('goal', steps.map((description, i) => ({ step: i + 1, description })));
  // 把 plan 推到目标状态前,先 approve + start
  c.approvePlan(plan.id);
  c.startExecution(plan.id);
  for (const n of completeSteps) c.completeStep(plan.id, n, 'out');
  for (const n of skipSteps) c.skipStep(plan.id, n, 'reason');
  // 强制设目标 status(若 complete/skip 已自然推到 completed 则跳过)
  if (status && plan.status !== status) plan.status = status;
  const getActive = () => plan;
  return { plan, getActive };
}

// Case 1: executing 状态,5 步只完成 2 → 否决
{
  const { getActive } = makePlan({
    steps: ['s1', 's2', 's3', 's4', 's5'],
    status: 'executing',
    completeSteps: [1, 2],
  });
  const r = evaluatePlanCompletionGate({ sessionKey: 's', stopReason: 'end_turn' }, { getActivePlanForSession: getActive });
  assert.equal(r.ok, false);
  assert.match(r.correction, /未完成|not.*complete|plan_step/i);
  assert.equal(r.retryLimit, 2);
}

// Case 2: 全部 complete → 放行
{
  const { getActive } = makePlan({
    steps: ['s1', 's2'],
    status: 'executing',
    completeSteps: [1, 2],
  });
  const r = evaluatePlanCompletionGate({ sessionKey: 's' }, { getActivePlanForSession: getActive });
  assert.equal(r.ok, true);
}

// Case 3: escape hatch — 未完成但全 skip 带理由 → 放行
{
  const { getActive } = makePlan({
    steps: ['s1', 's2', 's3'],
    status: 'executing',
    skipSteps: [2, 3], // 1 已由 startExecution 设为 in_progress,completeSteps 空
    completeSteps: [],
  });
  // startExecution 把 step1 设 in_progress;step1 既没 complete 也没 skip
  // 为测"全 skip 放行",把 step1 也 skip
  const c = new PlanExecuteController({ maxReplans: 3, requireApproval: false, autoApproveSimple: false });
  const plan = c.createPlan('goal', [{ step: 1, description: 's1' }, { step: 2, description: 's2' }]);
  c.approvePlan(plan.id); c.startExecution(plan.id);
  c.skipStep(plan.id, 1, 'r1'); c.skipStep(plan.id, 2, 'r2');
  const r = evaluatePlanCompletionGate({ sessionKey: 's' }, { getActivePlanForSession: () => plan });
  assert.equal(r.ok, true, 'all steps skipped with reason -> pass');
}

// Case 4: 无 active plan → 放行
{
  const r = evaluatePlanCompletionGate({ sessionKey: 's' }, { getActivePlanForSession: () => null });
  assert.equal(r.ok, true);
}

// Case 5: status 不是 approved/executing(如 completed/draft)→ 放行
{
  const { plan } = makePlan({ steps: ['s1', 's2'], status: 'completed', completeSteps: [1, 2] });
  const r = evaluatePlanCompletionGate({ sessionKey: 's' }, { getActivePlanForSession: () => plan });
  assert.equal(r.ok, true);
}

// Case 6: 无 sessionKey → fail-open 放行(嵌入式无 session 兜底)
{
  const r = evaluatePlanCompletionGate({}, { getActivePlanForSession: () => null });
  assert.equal(r.ok, true);
}

// Case 7: getActivePlanForSession 抛错 → fail-open 放行
{
  const r = evaluatePlanCompletionGate({ sessionKey: 's' }, { getActivePlanForSession: () => { throw new Error('boom'); } });
  assert.equal(r.ok, true);
}

console.log('plan-completion-gate: ok');
```

- [ ] **Step 2: 跑测试验证失败**

Run: `cd packages/moss-agent && npm run build && node --test test/plan-completion-gate.spec.mjs`
Expected: FAIL,`ERR_MODULE_NOT_FOUND` for `plan-completion-gate.js`。

- [ ] **Step 3: 写最小实现**

`packages/moss-agent/src/plan-execute/plan-completion-gate.ts`:
```ts
import type { Plan } from './plan-execute-controller.js';

export interface PlanCompletionGateRequest {
  sessionKey?: string;
  stopReason?: string;
}

export interface PlanCompletionGateDeps {
  getActivePlanForSession: (sessionKey: string) => Plan | null;
}

export type PlanCompletionGateResult =
  | { ok: true }
  | { ok: false; reason: string; correction: string; retryLimit: number };

const RETRY_LIMIT = 2;

export function evaluatePlanCompletionGate(
  request: PlanCompletionGateRequest,
  deps: PlanCompletionGateDeps,
): PlanCompletionGateResult {
  // 用户中止 → 放行(与 evaluatePlanEvalCompletionGate 一致)
  if (request.stopReason === 'aborted_by_user') return { ok: true };
  const sessionKey = request.sessionKey;
  if (!sessionKey) return { ok: true }; // 无 session: fail-open

  let plan: Plan | null;
  try {
    plan = deps.getActivePlanForSession(sessionKey);
  } catch {
    return { ok: true }; // 故障 fail-open
  }
  if (!plan) return { ok: true };
  if (plan.status !== 'approved' && plan.status !== 'executing') return { ok: true };

  const total = plan.steps.length;
  const done = plan.steps.filter(
    (s) => s.status === 'completed' || s.status === 'skipped',
  ).length;
  if (done >= total) return { ok: true };

  const unfinished = plan.steps
    .filter((s) => s.status !== 'completed' && s.status !== 'skipped')
    .map((s) => `Step ${s.step}: ${s.description}`)
    .join('\n');

  return {
    ok: false,
    reason: 'plan has unfinished steps',
    retryLimit: RETRY_LIMIT,
    correction:
      `[System] Plan ${plan.id} is ${plan.status} but ${total - done} step(s) remain unfinished:\n` +
      `${unfinished}\n` +
      `Continue executing the plan, or for each remaining step call plan_step action="skip" with a reason. ` +
      `Do not claim the task complete while the plan has unfinished steps.`,
  };
}
```

- [ ] **Step 4: 跑测试验证通过**

Run: `cd packages/moss-agent && npm run build && node --test test/plan-completion-gate.spec.mjs`
Expected: PASS,`plan-completion-gate: ok`。

- [ ] **Step 5: 接入 CLI 链**

`packages/moss-agent/src/cli/coding-completion-gate.ts`:在 `createCliCompletionGate` 的 chain 数组里(`:2737` 那个数组),在 `evaluatePlanEvalCompletionGate(request),`(:2748)那一行**之后**插入:
```ts
evaluatePlanCompletionGate(request, { getActivePlanForSession }),
```
文件顶部 import:
```ts
import { evaluatePlanCompletionGate } from '../plan-execute/plan-completion-gate.js';
import { getActivePlanForSession } from '../plan-execute/plan-controller-store.js';
```
`evaluatePlanCompletionGate` 返回 `{ok:true}|{ok:false,reason,correction,retryLimit}`,需与 `CodingCompletionGateResult` 兼容 —— 确认 `CodingCompletionGateResult` 的 false 分支含 `reason`/`correction`/`retryLimit`(读文件顶 type 定义;若字段名不同,在 `evaluatePlanCompletionGate` 与链之间加一层适配映射)。⚠️ `evaluate*` 链里其他成员是无 deps 纯函数,本 gate 带 deps,**直接传 `request` 与 `{ getActivePlanForSession }` 两个参数调用**,链里写法见上(非 `evaluatePlanCompletionGate(request)`)。

- [ ] **Step 6: 接入 MossAgent 包装**

`packages/moss-agent/src/core/agent/moss-agent.ts`(`:1486` 的 `completionGate: async (request) => {...}`):在 `if (!pending) { ... if (this.config.completionGate) return this.config.completionGate(request); return { ok: true }; }` 这段的 `return { ok: true }` 之前(即无 structured 校验、委托 host gate 之前),插入 plan completion gate:
```ts
if (request.sessionKey) {
  const planGate = evaluatePlanCompletionGate(
    { sessionKey: request.sessionKey, stopReason: request.stopReason },
    { getActivePlanForSession },
  );
  if (!planGate.ok) return planGate;
}
```
文件顶部 import:
```ts
import { evaluatePlanCompletionGate } from '../../plan-execute/plan-completion-gate.js';
import { getActivePlanForSession } from '../../plan-execute/plan-controller-store.js';
```
⚠️ 顺序:plan gate 在 structured-output 校验之**前**;若 structured pending,先走 structured(其有自己的 retry 语义),plan gate 这条只在无 pending 分支跑。确认 `request` 在该处有 `sessionKey`(读 `AgentLoopExtensions.completionGate` 的 request 类型 `agent-loop-types.ts:110`,有 `sessionKey`)。

- [ ] **Step 7: 导出 + 类型检查**

`packages/moss-agent/src/plan-execute/index.ts` 加:
```ts
export {
  evaluatePlanCompletionGate,
  type PlanCompletionGateRequest,
  type PlanCompletionGateDeps,
  type PlanCompletionGateResult,
} from './plan-completion-gate.js';
```
Run: `cd packages/moss-agent && npm run build && npm run typecheck -w @rdk-moss/agent`
Expected: 编译 + 类型检查通过(若 `CodingCompletionGateResult` 字段不匹配,在此暴露,回 Step 5 加适配)。

- [ ] **Step 8: 回归现有 completion-gate 测试**

Run: `cd packages/moss-agent && npm run build && node --test test/coding-completion-gate.spec.mjs`(若该文件存在;`ls test/ | grep completion` 确认文件名)
Expected: PASS(确认没破坏现有链)。

- [ ] **Step 9: Commit**

```bash
cd D:/moss-drobotics
git add packages/moss-agent/src/plan-execute/plan-completion-gate.ts \
        packages/moss-agent/test/plan-completion-gate.spec.mjs \
        packages/moss-agent/src/cli/coding-completion-gate.ts \
        packages/moss-agent/src/core/agent/moss-agent.ts \
        packages/moss-agent/src/plan-execute/index.ts
git commit -m "feat(plan): completion gate rejects premature end_turn with unfinished steps

evaluatePlanCompletionGate checks plan step completeness (not just whether
plan tools were called this turn like evaluatePlanEvalCompletionGate). Wired
into the CLI completion-gate chain and the MossAgent completionGate wrapper.
Escape hatch via plan_step skip with reason; fail-open on any fault.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 3: 规划质量校验实验(可 A/B,default off)

**Files:**
- Create: `packages/moss-agent/src/plan-execute/plan-critic-prompt.ts`
- Create: `packages/moss-agent/src/plan-execute/plan-critic.ts`
- Modify: `packages/moss-agent/src/plan-execute/plan-tools.ts:264-292` (`approve` case 插入 critic)
- Modify: `packages/moss-agent/src/plan-execute/index.ts` (导出)
- Test: `packages/moss-agent/test/plan-critic.spec.mjs`

**Interfaces:**
- Consumes: `PlanExecuteController.formatPlan`(`plan-execute-controller.ts:432`);`subagent-runner` 起子循环(读 `core/subagent/subagent-runner.ts` 现有 export,确认其 run 函数签名);`structured-output` 约束输出;`Plan`(controller)
- Produces:
  - `CRITIC_ENABLED`: 读取 `MOSS_PLAN_VALIDATE`(env,off 时返 false)
  - `CRITIC_MIN_STEPS`: 读取 `MOSS_PLAN_VALIDATE_MIN_STEPS`(default 5)
  - `shouldRunCritic(plan): boolean` — flag on 且 steps ≥ MIN_STEPS
  - `runPlanCritique(params): Promise<CritiqueResult>` — 起 subagent critique;fail-open
    - `params: { plan: Plan; taskText: string; sessionKey: string; ctx: ToolContext }`
    - `CritiqueResult = { ok: true } | { ok: false; issues: CritiqueIssue[]; summary: string }`
    - `CritiqueIssue = { step?: number; severity: 'high'|'medium'|'low'; problem: string; suggestedFix: string }`
  - `formatCritiqueForModel(result): string` — 把 issues 列成给模型的文本

- [ ] **Step 1: 写失败测试**

`packages/moss-agent/test/plan-critic.spec.mjs`:
```js
#!/usr/bin/env node
import assert from 'node:assert/strict';
import { PlanExecuteController } from '../dist/plan-execute/plan-execute-controller.js';
import { shouldRunCritic, formatCritiqueForModel } from '../dist/plan-execute/plan-critic.js';

// shouldRunCritic: steps < min(默认5) → false
{
  const c = new PlanExecuteController({ maxReplans: 3, requireApproval: false, autoApproveSimple: false });
  const plan = c.createPlan('g', [{ step: 1, description: 'a' }, { step: 2, description: 'b' }]);
  assert.equal(shouldRunCritic(plan), false, '2 steps < min 5 -> no critique');
}
// steps >= min → true
{
  const c = new PlanExecuteController({ maxReplans: 3, requireApproval: false, autoApproveSimple: false });
  const plan = c.createPlan('g', Array.from({ length: 6 }, (_, i) => ({ step: i + 1, description: 's' + (i + 1) })));
  assert.equal(shouldRunCritic(plan), true, '6 steps >= min 5 -> critique');
}

// formatCritiqueForModel: 把 issues 列成文本
{
  const text = formatCritiqueForModel({
    ok: false,
    summary: 'plan missing a verify step',
    issues: [{ step: 3, severity: 'high', problem: 'no verification', suggestedFix: 'add a test step' }],
  });
  assert.match(text, /needs revision|needs_review/i);
  assert.match(text, /no verification/);
  assert.match(text, /add a test step/);
}
// formatCritiqueForModel: ok 时返回安全文本
{
  const text = formatCritiqueForModel({ ok: true });
  assert.match(text, /approved|ok/i);
}
console.log('plan-critic: ok');
```
（`runPlanCritique` 涉及真实 subagent,集成测试在 Step 8 用 mock runner 单独覆盖,单元测试只测纯判定与格式化。）

- [ ] **Step 2: 跑测试验证失败**

Run: `cd packages/moss-agent && npm run build && node --test test/plan-critic.spec.mjs`
Expected: FAIL,`ERR_MODULE_NOT_FOUND` for `plan-critic.js`。

- [ ] **Step 3: 写 critic prompt**

`packages/moss-agent/src/plan-execute/plan-critic-prompt.ts`:
```ts
export const PLAN_CRITIC_SYSTEM_PROMPT = `You are a plan critic. Given a task and an execution plan, find concrete quality problems:
- missing steps (e.g. no verification/test step before completion)
- wrong ordering or impossible dependencies
- steps that cannot succeed given the task
- vague steps with no clear outcome

Return ONLY a JSON object: {"ok": boolean, "summary": string, "issues": [{"step": number|null, "severity": "high"|"medium"|"low", "problem": string, "suggestedFix": string}]}.
If the plan is sound, return {"ok": true, "summary": "", "issues": []}.
Be specific. Do not praise. Do not invent problems to seem thorough.`;
```

- [ ] **Step 4: 写最小实现(判定 + 格式化 + fail-open runner)**

`packages/moss-agent/src/plan-execute/plan-critic.ts`:
```ts
import type { Plan } from './plan-execute-controller.js';
import { PlanExecuteController } from './plan-execute-controller.js';
import { PLAN_CRITIC_SYSTEM_PROMPT } from './plan-critic-prompt.js';
import { readEnv } from '../utils/env-compat.js';

export interface CritiqueIssue {
  step: number | null;
  severity: 'high' | 'medium' | 'low';
  problem: string;
  suggestedFix: string;
}
export type CritiqueResult = { ok: true } | { ok: false; summary: string; issues: CritiqueIssue[] };

export function criticEnabled(): boolean {
  const v = readEnv('MOSS_PLAN_VALIDATE');
  return Boolean(v) && /^(1|true|on|yes)$/i.test(String(v).trim());
}
export function criticMinSteps(): number {
  const v = Number(readEnv('MOSS_PLAN_VALIDATE_MIN_STEPS'));
  return Number.isFinite(v) && v > 0 ? v : 5;
}
export function shouldRunCritic(plan: Plan): boolean {
  if (!criticEnabled()) return false;
  return plan.steps.length >= criticMinSteps();
}

export function formatCritiqueForModel(result: CritiqueResult): string {
  if (result.ok) return '[plan: approved by critic]';
  const lines = ['[plan: needs revision]'];
  if (result.summary) lines.push(`Summary: ${result.summary}`);
  for (const iss of result.issues) {
    const loc = iss.step == null ? '(plan)' : `Step ${iss.step}`;
    lines.push(`- [${iss.severity}] ${loc}: ${iss.problem}`);
    lines.push(`  fix: ${iss.suggestedFix}`);
  }
  lines.push('Revise the plan (plan action="create" with revised steps) then action="approve".');
  return lines.join('\n');
}

// fail-open:任何故障 → { ok: true }(放行 approve,不阻塞执行)
export async function runPlanCritique(params: {
  plan: Plan;
  taskText: string;
  runSubagent: (input: { systemPrompt: string; userText: string }) => Promise<string>;
}): Promise<CritiqueResult> {
  try {
    const planText = PlanExecuteController.formatPlan(params.plan);
    const userText = `Task:\n${params.taskText}\n\nPlan:\n${planText}`;
    const raw = await params.runSubagent({ systemPrompt: PLAN_CRITIC_SYSTEM_PROMPT, userText });
    const parsed = JSON.parse(raw);
    if (parsed && parsed.ok === true) return { ok: true };
    if (parsed && Array.isArray(parsed.issues)) {
      return { ok: false, summary: String(parsed.summary ?? ''), issues: parsed.issues };
    }
    return { ok: true }; // 非预期格式 → 放行
  } catch {
    return { ok: true }; // 解析失败/超时 → 放行
  }
}
```
⚠️ `runPlanCritique` 通过 `params.runSubagent` 注入 runner(测试可 mock,生产由 `plan-tools.ts` 注入真实的 `subagent-runner` 调用)。这样 `plan-critic.ts` 不直接依赖 subagent-runner,可单元测试。

- [ ] **Step 5: 跑测试验证通过**

Run: `cd packages/moss-agent && npm run build && node --test test/plan-critic.spec.mjs`
Expected: PASS,`plan-critic: ok`。

- [ ] **Step 6: 在 `plan` 工具 approve case 插入 critic**

`packages/moss-agent/src/plan-execute/plan-tools.ts` 的 `approve` case(`:264`):在 `confirmPlanApprovalIfNeeded` 之后、`controller.approvePlan(input.planId)` 之前插入:
```ts
import { shouldRunCritic, runPlanCritique, formatCritiqueForModel } from './plan-critic.js';

// ...在 approve case 内,confirm 之后:
const planToCritic = controller.getPlan(input.planId);
if (planToCritic && shouldRunCritic(planToCritic)) {
  const result = await runPlanCritique({
    plan: planToCritic,
    taskText: lastRealUserTextFromContext(ctx), // 见下 helper
    runSubagent: makeSubagentRunner(ctx),       // 见下 helper
  });
  if (!result.ok) {
    return formatCritiqueForModel(result); // 阻止 approve,issues 回流给模型
  }
}
// 之后才 controller.approvePlan(...)
```
两个 helper(加在 `plan-tools.ts` 末尾):
- `lastRealUserTextFromContext(ctx)`:从 `ctx` 取最近真实 user text。读 `ToolContext` 定义(`core/tools/tool-types.ts`)看是否有 messages 访问;若无,返回空串(critic 仍可基于 planText 工作)。实现:
```ts
function lastRealUserTextFromContext(ctx: any): string {
  try {
    const msgs = ctx?.messages ?? ctx?.session?.messages;
    if (!Array.isArray(msgs)) return '';
    for (let i = msgs.length - 1; i >= 0; i--) {
      const m = msgs[i];
      if (m?.role !== 'user') continue;
      const t = typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.map((b) => b?.text ?? '').join('\n') : '';
      if (t && !t.startsWith('[System]')) return t;
    }
    return '';
  } catch { return ''; }
}
```
- `makeSubagentRunner(ctx)`:返回 `(input) => Promise<string>`,内部调真实 subagent-runner 起一轮 critic。读 `core/subagent/subagent-runner.ts` 现有 export(如 `runSubagent`/`createSubagent`),取其最简"一次性 prompt → assistant text"入口封装。**若该入口签名复杂/不确定**,本步先实现为抛 `Error('subagent runner not wired')` 并记 `// TODO(step6-followup): wire real runner`,Task 3 仍可过(因单元测试用 mock,且 `MOSS_PLAN_VALIDATE` 默认 off → 真实路径不触发)。真实 runner 接线作为 Task 3 收尾的明确 follow-up 步骤(见 Step 8)。
```ts
function makeSubagentRunner(_ctx: any): (input: { systemPrompt: string; userText: string }) => Promise<string> {
  return async (_input) => {
    // TODO(step6-followup): wire real subagent-runner (see Step 8).
    throw new Error('plan-critic subagent runner not wired');
  };
}
```

- [ ] **Step 7: 导出**

`packages/moss-agent/src/plan-execute/index.ts` 加:
```ts
export {
  criticEnabled,
  criticMinSteps,
  shouldRunCritic,
  runPlanCritique,
  formatCritiqueForModel,
  type CritiqueIssue,
  type CritiqueResult,
} from './plan-critic.js';
export { PLAN_CRITIC_SYSTEM_PROMPT } from './plan-critic-prompt.js';
```

- [ ] **Step 8: mock runner 集成测试(issues 回流阻止 approve)**

`packages/moss-agent/test/plan-critic.spec.mjs` 末尾追加(用 `runPlanCritique` 直接测,注入 mock runner):
```js
// runPlanCritique: issues 非空 → ok:false
{
  const c = new PlanExecuteController({ maxReplans: 3, requireApproval: false, autoApproveSimple: false });
  const plan = c.createPlan('g', Array.from({ length: 6 }, (_, i) => ({ step: i + 1, description: 's' + (i + 1) })));
  const r = await runPlanCritique({
    plan,
    taskText: 'do the thing',
    runSubagent: async () => JSON.stringify({ ok: false, summary: 'no verify step', issues: [{ step: 5, severity: 'high', problem: 'no test', suggestedFix: 'add test' }] }),
  });
  assert.equal(r.ok, false);
  assert.equal(r.issues[0].problem, 'no test');
}
// runPlanCritique: subagent 抛错 → fail-open ok:true
{
  const c = new PlanExecuteController({ maxReplans: 3, requireApproval: false, autoApproveSimple: false });
  const plan = c.createPlan('g', Array.from({ length: 6 }, (_, i) => ({ step: i + 1, description: 's' + (i + 1) })));
  const r = await runPlanCritique({ plan, taskText: 't', runSubagent: async () => { throw new Error('boom'); } });
  assert.equal(r.ok, true, 'critic failure -> fail-open approve');
}
```
(`runPlanCritique` 需在测试顶部 import:补进 `import { shouldRunCritic, formatCritiqueForModel, runPlanCritique } from ...`)
Run: `cd packages/moss-agent && npm run build && node --test test/plan-critic.spec.mjs`
Expected: PASS。

- [ ] **Step 9: 文档**

`docs/user-guide/19-plan-mode.md` 末尾加一节:
```markdown
## Plan completion gate

When a plan is approved/started, Moss checks at completion time that all steps
are completed or explicitly skipped. If steps remain unfinished, completion is
rejected and the agent is told to continue or `plan_step skip` each remaining
step with a reason.

## Plan-quality critique (experimental, off by default)

Set `MOSS_PLAN_VALIDATE=on` to enable a pre-execute critique of plans with
`MOSS_PLAN_VALIDATE_MIN_STEPS` (default 5) or more steps. A separate subagent
reviews the plan for missing steps / wrong ordering and returns issues; the
agent must revise before `plan action=approve`. Off by default — this is an
A/B experiment; its retention is decided from benchmark data.
```

- [ ] **Step 10: 真实 subagent runner 接线(follow-up)**

读 `packages/moss-agent/src/core/subagent/subagent-runner.ts`,取其一次性 prompt→assistant text 入口,替换 Step 6 的 `makeSubagentRunner` 占位 throw 为真实调用。若该入口不存在或需要 host 级 deps(provider/sessionStore)难以在工具内构造,**记录为已知限制**并在 `plan-critic.ts` 顶部注释说明,保持 `MOSS_PLAN_VALIDATE` 默认 off,真实接线留作后续任务。验证:`MOSS_PLAN_VALIDATE=off`(默认)下 `plan action=approve` 行为与现状一致(不触发 critic)。

Run: `cd packages/moss-agent && npm run build && MOSS_PLAN_VALIDATE=off node --test test/plan-critic.spec.mjs`
Expected: PASS(off 默认,真实路径不触发)。

- [ ] **Step 11: Commit**

```bash
cd D:/moss-drobotics
git add packages/moss-agent/src/plan-execute/plan-critic.ts \
        packages/moss-agent/src/plan-execute/plan-critic-prompt.ts \
        packages/moss-agent/test/plan-critic.spec.mjs \
        packages/moss-agent/src/plan-execute/plan-tools.ts \
        packages/moss-agent/src/plan-execute/index.ts \
        docs/user-guide/19-plan-mode.md
git commit -m "feat(plan): experimental plan-quality critic behind MOSS_PLAN_VALIDATE flag

Pre-execute subagent critique gated by MOSS_PLAN_VALIDATE (default off) +
MOSS_PLAN_VALIDATE_MIN_STEPS (default 5). Critique injected at plan
action=approve; issues block approve and flow back to the model. Fail-open
on any critic fault. Retention to be decided from A/B benchmark data.

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Task 4: A/B 验证脚本

**Files:**
- Create: `scripts/bench-plan-validate.mjs`

**Interfaces:**
- Consumes: `benchmarks/agent-harness-real-world.mjs` 的任务集与 runner(读其 export,复用其跑任务接口);`MOSS_PLAN_VALIDATE` env

- [ ] **Step 1: 读现有 benchmark 接口**

读 `benchmarks/agent-harness-real-world.mjs` 顶部 export,确认:任务列表数组、单任务运行函数(返回 turns/toolCalls/完成标志)。记下函数名与返回 shape。

- [ ] **Step 2: 写脚本**

`scripts/bench-plan-validate.mjs`:
```js
#!/usr/bin/env node
// A/B: 跑 agent-harness-real-world 任务集,off vs on(MOSS_PLAN_VALIDATE),各 N>=3 次,
// 输出 长 plan 任务的 真完成率 / 平均轮数 / 额外 LLM 调用数 的均值与方差。
// 用法: node scripts/bench-plan-validate.mjs [rounds]
import { runHarnessTask, TASKS } from '../benchmarks/agent-harness-real-world.mjs';

const ROUNDS = Math.max(3, Number(process.argv[2] ?? 3));
const longPlanTasks = TASKS.filter((t) => (t.minSteps ?? 0) >= 5); // 见 Step 1 确认字段名

function summarize(runs) {
  const mean = (xs) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const variance = (xs) => mean(xs.map((x) => (x - mean(xs)) ** 2));
  return {
    trueCompleteRate: mean(runs.map((r) => Number(r.completed && !r.incomplete))),
    avgTurns: mean(runs.map((r) => r.turns)),
    avgExtraLlmCalls: mean(runs.map((r) => r.extraLlmCalls ?? 0)),
    varianceTurns: variance(runs.map((r) => r.turns)),
  };
}

async function runSuite(envFlag) {
  process.env.MOSS_PLAN_VALIDATE = envFlag;
  const results = [];
  for (const task of longPlanTasks) {
    for (let i = 0; i < ROUNDS; i++) {
      results.push(await runHarnessTask(task)); // 字段名见 Step 1
    }
  }
  return summarize(results);
}

const off = await runSuite('off');
const on = await runSuite('on');
console.log(JSON.stringify({ rounds: ROUNDS, tasks: longPlanTasks.length, off, on }, null, 2));
// 决策门槛(跑前定):真完成率提升 >=8% 且平均轮数不上升 -> 保留,否则关掉记教训
const deltaComplete = on.trueCompleteRate - off.trueCompleteRate;
const verdict = deltaComplete >= 0.08 && on.avgTurns <= off.avgTurns ? 'KEEP' : 'REJECT';
console.log(`verdict: ${verdict} (Δcomplete=${(deltaComplete * 100).toFixed(1)}%)`);
```
⚠️ Step 1 确认 `runHarnessTask`/`TASKS`/`minSteps`/返回字段名是否如上;若不同,按实际改 import 与字段映射。若 benchmark 不导出可复用入口,本任务降级为"记录 A/B 协议 + 待 benchmark 暴露接口后接线"并在脚本顶部注释说明。

- [ ] **Step 3: 跑脚本(冒烟)**

Run: `cd D:/moss-drobotics && node scripts/bench-plan-validate.mjs 1`
Expected: 输出 JSON(哪怕 longPlanTasks 为空也要能跑通不崩;若崩在 import,回 Step 1 修正字段名)。

- [ ] **Step 4: Commit**

```bash
cd D:/moss-drobotics
git add scripts/bench-plan-validate.mjs
git commit -m "chore(bench): A/B script for plan-quality critic (off vs on, N>=3)

Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## Self-Review(已完成)

**1. Spec coverage:**
- per-session controller store(§1 硬前提)→ Task 1 ✓
- 完成门(§1,挂 completionGate、硬否决、skip 逃生口、retry 上限、fail-open、多 session 隔离测试)→ Task 2 ✓
- 校验实验(§2,flag + 仅长 plan、挂 approve、subagent critic、结构化 issues、不进可见消息、default off)→ Task 3 ✓。注:`criticModel` 字段**未预留**(spec §2 原提"预留",实现中未加)—— 首轮同模型测「critic 这层本身有没有用」;"换更强模型"实验留作后续(见 A/B 协议 doc「不在本协议内」)。真实 subagent runner 接线为 deliberate follow-up(Task 3 Step 6/10)。
- A/B 验证(§3,benchmark/指标/决策门槛 ≥8%)→ Task 4 ✓
- 文档 → Task 3 Step 9 ✓
- MossAgent 侧新装(plan 侧无现有处理)→ Task 2 Step 6 ✓

**2. Placeholder scan:** Task 3 Step 6 含一处显式 `TODO(step6-followup)`,这是**有意的**(真实 subagent runner 接线作为同 Task 的 Step 8/10 follow-up,非"以后再说"),且 `MOSS_PLAN_VALIDATE` 默认 off 保证主线不受影响。无其他 TBD。

**3. Type consistency:** `evaluatePlanCompletionGate(request, deps)` 签名在 Task 2 定义,Task 2 Step 5/6 两处调用签名一致;`getActivePlanForSession` 在 Task 1 定义、Task 2/3 复用,签名一致;`CritiqueResult`/`shouldRunCritic`/`runPlanCritique`/`formatCritiqueForModel` 在 Task 3 定义且测试与实现一致。

**已知限制(写入 spec 的 YAGNI 边界,非缺陷):**
- 真实 subagent runner 接线在 Task 3 Step 6 用占位 + Step 10 follow-up,因 `subagent-runner` 入口签名需读源确认;default off 保证不阻塞主线。
- A/B 脚本依赖 benchmark 导出可复用入口,Task 4 Step 1 先确认,不匹配则降级为协议文档。
