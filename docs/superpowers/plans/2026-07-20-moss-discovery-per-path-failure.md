# moss discovery per-path failure counting 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 `tool-loop-guard` 的 discovery 工具失败计数按 path 隔离,使「错路径 read 失败」不污染「对路径 read」,消除 moss-eval L3-02 暴露的 ~15 步绕弯。

**Architecture:** 仅改 `packages/moss-agent/src/core/tools/tool-loop-guard.ts` 一处模块:加一个 state 字段 `byDiscoveryPathFailure` + 一个提取函数 `collectDiscoveryTargetKeys`,在 `recordToolLoopOutcome`/`shouldShortCircuitToolCall` 里对 `DISCOVERY_TOOLS` 走 per-path 分支(完全类比已有的 `byEditPathFailure`/`byWebFetchUrlFailure`),并调整守卫消息。签名不变,下游 `agent-loop-tool-execution.ts` 无需改。

**Tech Stack:** TypeScript、`node:test` + `node:assert/strict`(.spec.mjs,跑 dist)。

**Spec:** `docs/superpowers/specs/2026-07-20-moss-discovery-per-path-failure-design.md`

## Global Constraints

- 改动隔离在 `packages/moss-agent/src/core/tools/tool-loop-guard.ts`(+ 一个新测试 spec)。**不改** `DISCOVERY_TOOLS` 成员、**不改** `DEFAULT_DISCOVERY_FAILURE_LIMIT = 2` 阈值、**不改**其他守卫(identical-input / single-tool / total / web_search variation / web_fetch per-URL / surgical-edit per-path)。
- discovery 工具失败改 per-path 后,**不 bump** `byToolFailure`(类比 surgical-edit line 291-292 注释的原则)。无 path 可 key 时回落 tool-level,不丢信号。
- key 策略(区分对待,spec 已定稿):`read_file`/`list_directory`/`device_file_read`/`device_file_list` 按 `normalizePathKey(path)`;`search_code`/`search_files` 按 `normalizePathKey(path ?? '.') :: pattern/glob`。
- 复用现有 `normalizePathKey`(line 145)做归一化,不新写。
- 测试用 `node:test`,放在 `packages/moss-agent/test/tool-loop-guard-discovery-per-path.spec.mjs`,从 `../dist/core/tools/tool-loop-guard.js` 导入。运行方式:`cd packages/moss-agent && npm run build && node ../../scripts/run-package-tests.mjs`(或单独 `node --test test/tool-loop-guard-discovery-per-path.spec.mjs`)。
- 每 Task 结尾 commit。在 `D:\moss-drobotics` 仓库,新分支 `fix/moss-discovery-per-path`(从 main)。

---

## File Structure

- Modify: `packages/moss-agent/src/core/tools/tool-loop-guard.ts`(state + 函数 + 消息)
- Create: `packages/moss-agent/test/tool-loop-guard-discovery-per-path.spec.mjs`(新测试)

---

## Task 0: 建分支 + 确认基线可跑

**Files:** 无文件改动,仅 git 操作 + 跑一次现有测试确认绿。

**Interfaces:** 产出一个干净的 `fix/moss-discovery-per-path` 分支,基线测试绿。

- [ ] **Step 1: 从 main 建分支**

```bash
cd /d/moss-drobotics
git checkout main
git pull --ff-only 2>/dev/null
git checkout -b fix/moss-discovery-per-path
```

- [ ] **Step 2: 确认 moss-agent 能 build + 现有测试绿(基线)**

```bash
cd packages/moss-agent
npm run build 2>&1 | tail -5
node ../../scripts/run-package-tests.mjs 2>&1 | tail -15
```
Expected: build 无 TS 错误;测试全过(pass)。记下过测试数,作为回归基线。若 build 失败,先修环境(非本计划范围),不要继续。

- [ ] **Step 3: 确认 guard 模块当前导出**

```bash
cd /d/moss-drobotics
grep -n "^export " packages/moss-agent/src/core/tools/tool-loop-guard.ts
```
Expected: 导出 `ToolLoopGuardState`/`collectSurgicalEditPathKeys`/`createToolLoopGuardState`/`isSoftToolFailureResult`/`recordToolLoopOutcome`/`formatToolLoopGuardMessage`/`shouldShortCircuitToolCall`。确认这些是后续 Task 要改/扩展的对象。

无需 commit(本 Task 无代码改动)。

---

## Task 1: 加 state 字段 + collectDiscoveryTargetKeys 提取函数

**Files:**
- Modify: `packages/moss-agent/src/core/tools/tool-loop-guard.ts`(state 类型 + 初始化 + 新函数)

**Interfaces:**
- `ToolLoopGuardState` 新增 `byDiscoveryPathFailure: Map<string, number>`。
- 新增导出 `collectDiscoveryTargetKeys(input?: Record<string, unknown>): string[]`(供测试 + 后续 Task 用)。

- [ ] **Step 1: 给 ToolLoopGuardState 加字段**

Read `packages/moss-agent/src/core/tools/tool-loop-guard.ts`,在 `byEditPathFailure` 字段后(line ~121)加:

```typescript
  /**
   * Per-path discovery failures (read_file / search_code / search_files /
   * list_directory / device_file_*). Mirrors byEditPathFailure: a wrong-path
   * read failure must NOT block reads of other paths. read_file/list_directory
   * key by path only; search_code/search_files key by path+pattern (a missed
   * search is a pattern problem, not a path problem).
   */
  byDiscoveryPathFailure: Map<string, number>;
```

- [ ] **Step 2: createToolLoopGuardState 初始化新字段**

在 `createToolLoopGuardState()`(line ~195)的 `byEditPathFailure: new Map(),` 后加:

```typescript
    byDiscoveryPathFailure: new Map(),
```

- [ ] **Step 3: 新增 collectDiscoveryTargetKeys 函数**

在 `collectSurgicalEditPathKeys` 函数后(line ~193)新增导出函数:

```typescript
/**
 * Discovery target keys for per-path failure isolation. Mirrors
 * collectSurgicalEditPathKeys but for read_file / search_code / search_files /
 * list_directory / device_file_read / device_file_list.
 *
 * - read_file / list_directory / device_file_read / device_file_list: key by
 *   path only (failure = wrong path).
 * - search_code / search_files: key by path+pattern (both use `input.pattern`;
 *   search_files's "Glob pattern" is also the `pattern` field — verified in
 *   search-tools.ts). Failure = missed search, a pattern problem; different
 *   searches must not poison each other.
 * path defaults to '.' (matches tool default) when absent.
 * Returns [] when no usable path — caller falls back to tool-level counting.
 * @internal exported for tests
 */
export function collectDiscoveryTargetKeys(input?: Record<string, unknown>): string[] {
  if (!input || typeof input !== 'object') return [];
  const rawPath = typeof input.path === 'string' && input.path.trim()
    ? input.path
    : '.';
  const pathKey = normalizePathKey(rawPath);
  // search_code & search_files both use input.pattern (search_files calls it
  // "Glob pattern" but the field is `pattern`, not `glob`).
  if (typeof input.pattern === 'string') {
    return [`${pathKey}::${input.pattern}`];
  }
  return [pathKey];
}
```

- [ ] **Step 4: build + 自检导出**

```bash
cd /d/moss-drobotics/packages/moss-agent
npm run build 2>&1 | tail -5
node --input-type=module -e "import('./dist/core/tools/tool-loop-guard.js').then(m=>console.log('exports:',Object.keys(m).filter(k=>/discovery|Discovery/i.test(k))))"
```
Expected: build 无错;输出含 `collectDiscoveryTargetKeys`(注:`byDiscoveryPathFailure` 是 type 字段,不在 Object.keys)。

- [ ] **Step 5: Commit**

```bash
cd /d/moss-drobotics
git add packages/moss-agent/src/core/tools/tool-loop-guard.ts
git commit -m "feat(tool-loop-guard): add byDiscoveryPathFailure state + collectDiscoveryTargetKeys"
```

---

## Task 2: recordToolLoopOutcome 走 per-path(不 bump tool-level)

**Files:**
- Modify: `packages/moss-agent/src/core/tools/tool-loop-guard.ts`(`recordToolLoopOutcome` 函数,line ~263)

**Interfaces:** `recordToolLoopOutcome` 签名不变。对 `DISCOVERY_TOOLS` 中的工具,失败只计 `byDiscoveryPathFailure`,不 bump `byToolFailure`。

- [ ] **Step 1: 在 surgical-edit 分支后插入 discovery 分支**

Read `recordToolLoopOutcome`(line ~263)。现有结构(简化):
```typescript
  if (!isError && !isSoftToolFailureResult(resultText)) return;
  // ... web_fetch per-URL ...
  if (SURGICAL_EDIT_TOOLS.has(toolName)) {
    // ... byEditPathFailure, return ...
  }
  state.byToolFailure.set(toolName, (state.byToolFailure.get(toolName) ?? 0) + 1);
```
在 `SURGICAL_EDIT_TOOLS` 分支后、`state.byToolFailure.set(...)` 前,插入(完全类比 surgical-edit 写法):

```typescript
  // Discovery per-path: a wrong-path read failure must NOT block reads of
  // other paths. Mirror surgical-edit — do NOT bump tool-level failure, or
  // one path's retries block the whole tool (see byEditPathFailure rationale).
  if (DISCOVERY_TOOLS.has(toolName)) {
    const targetKeys = collectDiscoveryTargetKeys(input);
    if (targetKeys.length > 0) {
      for (const key of targetKeys) {
        state.byDiscoveryPathFailure.set(
          key,
          (state.byDiscoveryPathFailure.get(key) ?? 0) + 1,
        );
      }
      return;
    }
    // No usable path — fall through to tool-level (don't drop the signal).
  }
  state.byToolFailure.set(toolName, (state.byToolFailure.get(toolName) ?? 0) + 1);
```

- [ ] **Step 2: build**

```bash
cd /d/moss-drobotics/packages/moss-agent
npm run build 2>&1 | tail -5
```
Expected: 无 TS 错误。

- [ ] **Step 3: 冒烟 — 错路径失败不再 bump tool-level**

```bash
cd /d/moss-drobotics/packages/moss-agent
node --input-type=module -e "
  const m = await import('./dist/core/tools/tool-loop-guard.js');
  const s = m.createToolLoopGuardState();
  // read_file fails on wrong path A, twice
  m.recordToolLoopOutcome(s, 'read_file', true, undefined, { path: 'wrong/a.ts' });
  m.recordToolLoopOutcome(s, 'read_file', true, undefined, { path: 'wrong/a.ts' });
  console.log('byToolFailure read_file =', s.byToolFailure.get('read_file') ?? 0, '(want 0)');
  console.log('byDiscoveryPathFailure has wrong/a.ts =', s.byDiscoveryPathFailure.get('wrong/a.ts'), '(want 2)');
"
```
Expected: `byToolFailure read_file = 0`(关键:不再 bump tool-level),`byDiscoveryPathFailure has wrong/a.ts = 2`。

- [ ] **Step 4: Commit**

```bash
cd /d/moss-drobotics
git add packages/moss-agent/src/core/tools/tool-loop-guard.ts
git commit -m "feat(tool-loop-guard): discovery failures count per-path, not tool-level"
```

---

## Task 3: shouldShortCircuitToolCall 改 per-path 判断

**Files:**
- Modify: `packages/moss-agent/src/core/tools/tool-loop-guard.ts`(`shouldShortCircuitToolCall`,line ~591)

**Interfaces:** 签名不变。对 discovery 工具,失败判断从 `byToolFailure` 改为 `byDiscoveryPathFailure`(per-path);无 path 时回落 tool-level。

- [ ] **Step 1: 在 surgical-edit per-path 分支后加 discovery per-path 判断**

Read `shouldShortCircuitToolCall`(line ~591)。现有 `effectiveFailureLimit` 对 discovery 工具已是 `DEFAULT_DISCOVERY_FAILURE_LIMIT=2`(line ~619-622)。在 surgical-edit per-path 分支(line ~626-634)后、`web_search hasSufficientRssNewsEvidence` 分支(line ~636)前,插入(类比 surgical-edit line 626-634 + web_fetch line 652-663):

```typescript
  // Discovery per-path failure: block only the specific path/target that has
  // failed repeatedly, not the whole tool. A different path stays at 0 and is
  // never blocked by other paths' failures (mirror surgical-edit per-path).
  if (DISCOVERY_TOOLS.has(toolName) && effectiveFailureLimit !== undefined) {
    const targetKeys = collectDiscoveryTargetKeys(input);
    if (targetKeys.length > 0) {
      for (const key of targetKeys) {
        const pathFails = state.byDiscoveryPathFailure.get(key) ?? 0;
        if (pathFails >= effectiveFailureLimit) {
          return `discovery on ${key} has failed ${pathFails} time(s) in this user turn`;
        }
      }
      // Has path key(s) and under threshold — do NOT use tool-level failure
      // for discovery tools anymore; fall through to identical/single/total
      // guards below.
    }
    // No usable path → fall through to tool-level byToolFailure (compat).
  }
```

- [ ] **Step 2: 调整 tool-level 失败判断,排除 discovery 工具**

现有 tool-level 失败判断(line ~664):
```typescript
  } else if (effectiveFailureLimit !== undefined && failureCount >= effectiveFailureLimit) {
    return `${toolName} has failed ${failureCount} time(s) in this user turn`;
  }
```
这行在 `web_fetch` 的 `else if` 里。确认 discovery 工具有 path key 时已被上面的新分支 `return null`-ish 拦截(走到这里时 pathFails 未超阈,继续往下);无 path key 时才落到这里。逻辑成立 —— 但需确认 discovery 工具不会既进新分支又被这行误拦。验证:有 path 的 discovery 调用,`failureCount`(byToolFailure)现在永远是 0(因 Task 2 不再 bump),所以这行对 discovery 不会误触发。**无需改这行**,但 Task 4 测试要覆盖该不变量。

- [ ] **Step 3: build + 冒烟:错路径阻断对路径、不阻断对路径**

```bash
cd /d/moss-drobotics/packages/moss-agent
npm run build 2>&1 | tail -3
node --input-type=module -e "
  const m = await import('./dist/core/tools/tool-loop-guard.js');
  const s = m.createToolLoopGuardState();
  // read_file fails on wrong path A twice
  m.recordToolLoopOutcome(s, 'read_file', true, undefined, { path: 'wrong/a.ts' });
  m.recordToolLoopOutcome(s, 'read_file', true, undefined, { path: 'wrong/a.ts' });
  // 3rd call on SAME wrong path → blocked (per-path threshold 2)
  const sameBlock = m.shouldShortCircuitToolCall(s, 'read_file', { path: 'wrong/a.ts' });
  console.log('same wrong path blocked?', sameBlock !== null, '|', sameBlock);
  // call on DIFFERENT (correct) path → NOT blocked
  const diffBlock = m.shouldShortCircuitToolCall(s, 'read_file', { path: 'src/calc.ts' });
  console.log('different path blocked?', diffBlock !== null, '| want false');
"
```
Expected: `same wrong path blocked? true`(per-path 阈值生效),`different path blocked? false`(关键修复:对路径不被误断)。

- [ ] **Step 4: Commit**

```bash
cd /d/moss-drobotics
git add packages/moss-agent/src/core/tools/tool-loop-guard.ts
git commit -m "feat(tool-loop-guard): short-circuit discovery per-path, not per-tool"
```

---

## Task 4: 守卫消息改成「此路径,换路径」

**Files:**
- Modify: `packages/moss-agent/src/core/tools/tool-loop-guard.ts`(`formatToolLoopGuardMessage`,line ~308)

**Interfaces:** `formatToolLoopGuardMessage` 签名不变。新增匹配 `discovery on <key> has failed N time` 的消息分支(类比 web_fetch per-URL line 327-334)。

- [ ] **Step 1: 在 formatToolLoopGuardMessage 加 discovery 分支**

Read `formatToolLoopGuardMessage`(line ~308)。在 web_fetch per-URL 分支(line ~327 `if (/^web_fetch on .+ has failed/)`)后、edit thrash 分支(line ~335)前,插入(照抄 web_fetch 文案结构):

```typescript
  if (/^discovery on .+ has failed \d+ time/.test(reason)) {
    return [
      `[moss-agent] Tool loop guard stopped another ${toolName} call: ${reason}.`,
      'This specific path/target is not returning usable results — STOP retrying THIS path.',
      'Other paths are fine: you may read/search a different path, or use a different discovery tool.',
      'If the path was wrong, fix the path. Never invent file contents you did not actually read.',
    ].join(' ');
  }
```

- [ ] **Step 2: build + 冒烟消息**

```bash
cd /d/moss-drobotics/packages/moss-agent
npm run build 2>&1 | tail -3
node --input-type=module -e "
  const m = await import('./dist/core/tools/tool-loop-guard.js');
  const msg = m.formatToolLoopGuardMessage('discovery on src/calc.ts has failed 2 time(s) in this user turn', 'read_file');
  console.log(msg);
"
```
Expected: 消息含「This specific path/target」+「Other paths are fine」,且不再出现旧的「Discovery is failing repeatedly — STOP retrying the same list/search」(旧 discovery 消息分支 line 555-562 的 reason 是 `read_file has failed N time`,与新 reason `discovery on ...` 不同,不冲突)。

- [ ] **Step 3: 确认旧 discovery 消息分支不再被触发**

旧分支(line ~553-562)匹配 `reason` 含 `has failed \d+ time` 且 `read_file/list_directory/...`。新 reason 是 `discovery on <key> has failed`,旧分支的 `if (toolName === 'list_directory' || ...)` 在 `has failed \d+ time` 大分支内 —— 但新 reason 的 toolName 仍是 `read_file` 等,会进旧分支吗?验证:

```bash
node --input-type=module -e "
  const m = await import('./dist/core/tools/tool-loop-guard.js');
  // 新 reason 应命中 Step1 的新分支,不进旧 line 553 分支
  console.log(m.formatToolLoopGuardMessage('discovery on src/calc.ts has failed 2 time(s) in this user turn', 'read_file').slice(0,60));
"
```
Expected: 命中新分支(消息以 `[moss-agent]...This specific path` 开头)。若命中旧分支(消息含「Discovery is failing repeatedly」),说明 Step1 分支位置/正则需前移 —— 把新分支移到函数最前(`fresh-news` 判断之后、web_fetch 之前)。

- [ ] **Step 4: Commit**

```bash
cd /d/moss-drobotics
git add packages/moss-agent/src/core/tools/tool-loop-guard.ts
git commit -m "feat(tool-loop-guard): per-path discovery message — 'this path, not whole tool'"
```

---

## Task 5: 单元测试 spec(覆盖核心不变量)

**Files:**
- Create: `packages/moss-agent/test/tool-loop-guard-discovery-per-path.spec.mjs`

**Interfaces:** 用 `node:test` + `node:assert/strict`,从 `../dist/core/tools/tool-loop-guard.js` 导入。覆盖 spec 的 6 个测试点。

- [ ] **Step 1: 写 spec**

Create `packages/moss-agent/test/tool-loop-guard-discovery-per-path.spec.mjs`:
```javascript
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createToolLoopGuardState,
  collectDiscoveryTargetKeys,
  recordToolLoopOutcome,
  shouldShortCircuitToolCall,
  formatToolLoopGuardMessage,
} from '../dist/core/tools/tool-loop-guard.js';

test('per-path isolation: wrong-path failures do NOT block correct-path read', () => {
  const s = createToolLoopGuardState();
  // read_file fails twice on WRONG path
  recordToolLoopOutcome(s, 'read_file', true, undefined, { path: 'wrong/a.ts' });
  recordToolLoopOutcome(s, 'read_file', true, undefined, { path: 'wrong/a.ts' });
  // correct path read must NOT be blocked
  const blocked = shouldShortCircuitToolCall(s, 'read_file', { path: 'src/calc.ts' });
  assert.equal(blocked, null, 'correct-path read must not be blocked by wrong-path failures');
});

test('same-path threshold unchanged: 2 failures block the SAME path', () => {
  const s = createToolLoopGuardState();
  recordToolLoopOutcome(s, 'read_file', true, undefined, { path: 'wrong/a.ts' });
  recordToolLoopOutcome(s, 'read_file', true, undefined, { path: 'wrong/a.ts' });
  const blocked = shouldShortCircuitToolCall(s, 'read_file', { path: 'wrong/a.ts' });
  assert.ok(blocked, 'same-path 3rd call must be blocked');
  assert.match(blocked, /discovery on .* has failed 2 time/);
});

test('discovery failures do NOT bump tool-level byToolFailure', () => {
  const s = createToolLoopGuardState();
  recordToolLoopOutcome(s, 'read_file', true, undefined, { path: 'wrong/a.ts' });
  recordToolLoopOutcome(s, 'read_file', true, undefined, { path: 'wrong/a.ts' });
  assert.equal(s.byToolFailure.get('read_file') ?? 0, 0, 'must not bump tool-level');
  assert.equal(s.byDiscoveryPathFailure.get('wrong/a.ts'), 2, 'must count per-path');
});

test('search_code keys by path+pattern: different patterns do not poison each other', () => {
  const s = createToolLoopGuardState();
  // search_code fails twice with pattern A on path X
  recordToolLoopOutcome(s, 'search_code', true, undefined, { path: 'src', pattern: 'A' });
  recordToolLoopOutcome(s, 'search_code', true, undefined, { path: 'src', pattern: 'A' });
  // same path, DIFFERENT pattern B → must NOT be blocked
  const blocked = shouldShortCircuitToolCall(s, 'search_code', { path: 'src', pattern: 'B' });
  assert.equal(blocked, null, 'different pattern must not be blocked');
});

test('identical-input guard still fires on same path+same input 3rd time', () => {
  const s = createToolLoopGuardState();
  const input = { path: 'src/calc.ts' };
  shouldShortCircuitToolCall(s, 'read_file', input);
  shouldShortCircuitToolCall(s, 'read_file', input);
  // 3rd identical call → identical-input guard (limit 3) blocks
  const blocked = shouldShortCircuitToolCall(s, 'read_file', input);
  assert.ok(blocked, 'identical-input guard must still fire');
  assert.match(blocked, /identical input was already requested/);
});

test('no-path discovery call falls back to tool-level (no crash, no drop)', () => {
  const s = createToolLoopGuardState();
  // read_file with no path → collectDiscoveryTargetKeys returns []
  const keys = collectDiscoveryTargetKeys({});
  assert.deepEqual(keys, []);
  // recording a failure with no path bumps tool-level (fallback)
  recordToolLoopOutcome(s, 'read_file', true, undefined, {});
  assert.equal(s.byToolFailure.get('read_file') ?? 0, 1, 'fallback to tool-level when no path');
});

test('formatToolLoopGuardMessage: per-path discovery message', () => {
  const msg = formatToolLoopGuardMessage('discovery on src/calc.ts has failed 2 time(s) in this user turn', 'read_file');
  assert.match(msg, /This specific path\/target/);
  assert.match(msg, /Other paths are fine/);
});
```

- [ ] **Step 2: build + 跑 spec**

```bash
cd /d/moss-drobotics/packages/moss-agent
npm run build 2>&1 | tail -3
node --test test/tool-loop-guard-discovery-per-path.spec.mjs 2>&1 | tail -20
```
Expected: 7 个 test 全 pass。若某个 fail,据失败信息修 `tool-loop-guard.ts`(不是测试)后重 build+跑。

- [ ] **Step 3: 跑全量回归(确认没破坏其他守卫)**

```bash
cd /d/moss-drobotics/packages/moss-agent
node ../../scripts/run-package-tests.mjs 2>&1 | tail -15
```
Expected: 全部 pass(含新 spec + 原有所有 spec)。若原有 spec 有 fail,对比 Task 0 基线 —— 若是本改动引入的回归,定位是 surgical-edit/web_fetch 分支被误改,还是 discovery 回落逻辑问题,修之。

- [ ] **Step 4: Commit**

```bash
cd /d/moss-drobotics
git add packages/moss-agent/test/tool-loop-guard-discovery-per-path.spec.mjs
git commit -m "test(tool-loop-guard): per-path discovery isolation + regression coverage"
```

---

## Task 6: moss-eval 回归验证(L3-02 turns 下降)

**Files:** 无代码改动,仅评估回归。

**Interfaces:** 用现成 moss-eval harness 重跑 L3-02 moss,对比 turns 是否下降。

- [ ] **Step 1: 用改后的 moss 跑 moss-eval L3-02 moss**

```bash
cd /d/moss-eval
# 改后的 moss 已 build 到全局 node_modules(需确认 link 指向改后 dist)
# 先重 build moss-agent 并确认全局 moss 用的是改后版本:
cd /d/moss-drobotics/packages/moss-agent && npm run build 2>&1 | tail -2
# 确认全局 moss 解析到改后 cli.js
moss --version
# 跑 L3-02 moss(单任务,用 EVAL_SMOKE 跑首个 L3 不行,直接构造)
cd /d/moss-eval
rm -rf runs/regress && mkdir -p runs/regress
node --input-type=module -e "
  const{runSubject}=await import('./harness/lib/run-subject.mjs');
  const{reset}=await import('./harness/lib/reset.mjs');
  const{TASKS}=await import('./harness/tasks.mjs');
  const t=TASKS.find(x=>x.id==='L3-02');
  reset(t.tag,t.cleanMode);
  const r=await runSubject('moss',t,1,'fixtures/sample-lib','regress');
  console.log('L3-02 moss turns:',r.status.durationMs,'ms; see metrics');
" 2>&1 | tail -3
```

- [ ] **Step 2: 对比 turns(改前 19 calls / 9 turns)**

```bash
cd /d/moss-eval
node -e "const fs=require('fs');const d=JSON.parse(fs.readFileSync('runs/regress/L3-02/moss/round-1/metrics.json'));console.log('regress turns='+d.turns+' calls='+d.toolCalls.length+' terminal='+d.terminalReason+' fixMatched(can check diff)')"
```
对比改前(trial1 L3-02 moss: turns=9, calls=19)。Expected: turns 与 calls **显著下降**(目标 turns ≤ 7、calls ≤ 10)。若未下降,查 stream.jsonl —— 是否仍出现「discovery on ... has failed」误断?若仍误断,说明改动未生效(检查全局 moss 是否真用改后 dist),或 key 提取有误。

- [ ] **Step 3: 顺带重跑其他 L3 确认无回归**

```bash
cd /d/moss-eval
# 可选:重跑全部 L3(用 --resume 只补 L3)
for u in L3-01 L3-03 L3-04 L3-05 L3-06 L3-07 L3-08; do rm -rf runs/regress/$u; done
# (L3-02 已跑;其他可按需补跑对比)
```
Expected: 其他 L3 无回归(turns 不应显著上升;死循环率仍 0)。

- [ ] **Step 4: 记录回归结果到 ledger + commit 一个 regression note**

把 L3-02 改前/改后 turns 对比写进 `D:\moss-eval\.superpowers\sdd\progress.md`(append)。

```bash
cd /d/moss-drobotics
git log --oneline -6  # 确认所有 commit 在 fix/moss-discovery-per-path
```
无需 commit 代码(本 Task 无代码改动)。

---

## Self-Review

**1. Spec coverage:** spec 各段对应:
- state 新字段 → Task 1 Step 1-2。✓
- collectDiscoveryTargetKeys(区分对待:read/list 按 path;search 按 path+pattern;path 缺省 '.') → Task 1 Step 3。✓
- recordToolLoopOutcome 走 per-path 不 bump tool-level → Task 2。✓
- shouldShortCircuitToolCall 改 per-path 判断 → Task 3。✓
- 守卫消息改「此路径」→ Task 4。✓
- identical-input 守卫保留(三层互补)→ Task 5 的 identical-input test 覆盖。✓
- 无 path 回落 tool-level → Task 5 的 no-path test。✓
- device 工具同步(spec 待决 2)→ DISCOVERY_TOOLS 已含 device_file_read/list,collectDiscoveryTargetKeys 按 path 处理(无 path 回落),自动覆盖。✓

**2. Placeholder scan:** 已核实 `search_files` 的 glob 字段名是 `pattern`(不是 `glob`,见 search-tools.ts:354 "Glob pattern"),与 `search_code` 同字段,故 `collectDiscoveryTargetKeys` 用单个 `if (typeof input.pattern === 'string')` 分支,无需 switch/glob 分支。无 TODO/TBD。✓

**3. Type/signature consistency:**
- `collectDiscoveryTargetKeys(input?: Record<string, unknown>): string[]` —— Task 1 定义,Task 2/3 消费,Task 5 测试导入,一致。✓
- `byDiscoveryPathFailure: Map<string, number>` —— state 字段,Task 1 加,Task 2 写、Task 3 读,Task 5 测试断言,一致。✓
- `shouldShortCircuitToolCall` 新 reason `discovery on <key> has failed N time(s) in this user turn` —— Task 3 产出,Task 4 的 formatToolLoopGuardMessage 正则匹配 `/^discovery on .+ has failed \d+ time/`,Task 5 test 断言 match,一致。✓
- 签名:`recordToolLoopOutcome`/`shouldShortCircuitToolCall`/`formatToolLoopGuardMessage`/`createToolLoopGuardState` 签名均不变(只加内部逻辑/分支)→ 下游 `agent-loop-tool-execution.ts` 无需改。✓
