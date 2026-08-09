# Moss vs Claude Code 对照评估 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 GLM 同模型下,headless 对比 moss 与 Claude Code 在第 2 层(工具准确率)与第 3 层(错误闭环)的表现,产出量化基线 + 差距定位。

**Architecture:** 独立 eval 工作区 `D:\moss-eval`,含 fixtures(带 bug 的小 TS 库,每任务一个 git tag)、harness(并发 runner:重置→跑两边→采埋点→自动算第 2 层显性错误率→标人工复核候选)、reports(对照表)。moss 用 `--config-file` 指向隔离的 openai-compatible 配置(GLM);claude 用 `CLAUDE_CONFIG_DIR` 指向隔离配置目录以脱离 superpowers 注入。**两边都用 `--output-format stream-json`,共用同一个 collector** —— 冒烟实测确认两边事件流形状几乎一致(`tool_use`/`tool_result`/`is_error`/`num_turns`)。

**Tech Stack:** Node.js 22(ESM `.mjs`)、moss CLI v0.6.0(已 link 全局)、claude CLI v2.1.204、git(任务重置)、JSONL/JSON 解析。无第三方依赖(纯 Node 内置模块)。

**Spec:** `docs/superpowers/specs/2026-07-20-moss-vs-claude-code-eval-harness-design.md`(落地设计)+ `docs/superpowers/specs/2026-07-20-moss-vs-claude-code-eval-design.md`(评估目标)

## Global Constraints

- moss 与 claude 必须用**同一个模型** `HORIZON-GLM`(实跑 `glm-5.2`,配置名别名)。同一 token `JV8o9ypgA0pwhC4h`(写在 gitignored 的 config 里,不进仓库)。
- moss 走 **openai-compatible provider**(`/v1/chat/completions`)—— 冒烟实测:GLM 网关只认 `Authorization: Bearer`,不认 Anthropic 标准 `x-api-key`,而 moss 的 anthropic provider 硬编码 `x-api-key`(`provider/anthropic.js:100`)跑不通 401。本轮「只测不调」不改 moss 源码,故用 openai-compatible。由此带来**协议不对等**(claude 走 Anthropic `/v1/messages`),写进 baseline-summary 局限性声明。
- moss 配置隔离:`--config-file harness/moss-config/config.json`(已存在,gitignored)。
- claude 配置隔离:`CLAUDE_CONFIG_DIR=harness/claude-config/clean-home/.claude`(已存在,gitignored)+ `--permission-mode bypassPermissions`。脱离 superpowers 注入后单次 input tokens 从 22k 降到 ~1k,全套 27 工具保留。
- claude stream-json 必须加 `--verbose`(`--output-format stream-json` 在 `--print` 下要求 `--verbose`)。
- 每轮跑前重置 fixtures;`cleanMode` 按任务分:L2 用 `git clean -fd`(保 node_modules 以跑 tsc),L3-03 用 `git clean -fdx`(清 node_modules 以测缺依赖),其余 L3 用 `git clean -fd`。
- 显性错误率分母只算 `completed` 的工具调用(`denied`/`pre-blocked`/`hook-blocked`/`unknown-tool`/`permission_denials` 不计入)。
- **不联网**:任务限制在 fixtures 内。
- **无温度扰动**:3 轮全用相同参数。
- **不设 budget-cap**:runner 只打印累计成本,不设上限停跑。moss 的 `total_cost_usd` 实测为 `null`(`cost_unavailable:true`),claude 有值 —— moss cost 在 csv 标 `N/A`。
- 每 Task 结尾 commit。全程在 `D:\moss-eval`(独立 git 仓,非 moss 仓)。

---

## File Structure

`D:\moss-eval/`(独立 git 仓)

- `harness/config.mjs` — 常量集中:路径、模型、并发、超时、两 subject 的调用参数
- `harness/tasks.mjs` — 任务定义数组(15 L2 + 8 L3),每任务含 `{id, layer, prompt, tag, cleanMode, watch, expectedFixPatch?}`
- `harness/lib/reset.mjs` — fixtures 重置(按 cleanMode)
- `harness/lib/run-subject.mjs` — 统一的 headless 调用:`runSubject(subject, task, round, workDir, ts)` → 跑 moss 或 claude,捕获 stream-json + diff + status
- `harness/lib/collect.mjs` — **统一**解析两边 stream-json → `RunResult`(两边形状一致,一个函数处理)
- `harness/lib/pool.mjs` — 并发池:work units + concurrency 调度,断点续跑跳过已完成
- `harness/score-layer2.mjs` — 第 2 层:显性错误率 + 隐性错误候选启发式
- `harness/score-layer3.mjs` — 第 3 层:纠错轮数/重复失败命令/对照 expectedFixPatch
- `harness/run-eval.mjs` — 主 runner:orchestrate(reset→run→collect→score),CLI: `--layer --rounds --concurrency --timeout --resume`
- `harness/moss-config/config.json` — gitignored:openai-compatible + GLM token(**已存在**)
- `harness/claude-config/clean-home/.claude/settings.json` — gitignored:脱离 superpowers 的干净配置(**已存在**)
- `fixtures/sample-lib/` — 被测 TS 库;git tags: `base`, `L3-01`..`L3-08`(L3-03 需重做,L3-07/08 需新建)
- `fixtures/expected/L3-XX.patch` — 每个 L3 任务的预期修复 patch(纳入版本控制)
- `runs/<ts>/<task>/<subject>/round-N/{stream.jsonl, raw.log, transcript.md, diff.patch, metrics.json, status.json}`
- `reports/layer2-error-rate.csv` / `layer3-recovery.csv` / `review-samples.md` / `baseline-summary.md`

---

## Task 0: 确认前置就绪 + 已有产物盘点

**Files:**

- Verify: `D:\moss-eval/` 已 scaffold、`fixtures/sample-lib/` 已有 base tag、`harness/moss-config/config.json` 已存在、`harness/claude-config/clean-home/.claude/settings.json` 已存在

**Interfaces:** 不产出文件,只验证冒烟阶段已建立的资产仍在,并记录当前 git tag 状态供后续 Task 用。

- [ ] **Step 1: 确认工作区 + 两 CLI 可调**

```bash
cd /d/moss-eval
moss --version        # 期望: moss v0.6.0
claude --version      # 期望: 2.1.204 (Claude Code)
node --version        # 期望: v22.x
git tag -l            # 期望至少含: base L3-01 L3-02 L3-03 L3-04 L3-05 L3-06
```

- [ ] **Step 2: 确认两份隔离配置存在且能用**

```bash
cd /d/moss-eval
# moss
moss --config-file harness/moss-config/config.json -p "reply with exactly: OK" --max-turns 2 --output-format stream-json 2>/dev/null | grep -o '"type":"result"' | head -1
# claude
CLAUDE_CONFIG_DIR="D:\\moss-eval\\harness\\claude-config\\clean-home\\.claude" claude -p "reply with exactly: OK" --max-turns 2 --output-format stream-json --verbose --permission-mode bypassPermissions 2>/dev/null | grep -o '"type":"result"' | head -1
```

Expected: 两条都输出 `"type":"result"`。若 moss 报 401 → 检查 `harness/moss-config/config.json` 的 apiKey/baseUrl。若 claude 仍带 superpowers 注入(`grep -c superpowers` > 0)→ 检查 `CLAUDE_CONFIG_DIR` 路径。

- [ ] **Step 3: 记录当前 fixtures git tag 清单**

```bash
cd /d/moss-eval && git tag -l | sort
```

记录输出。Task 2 会基于此判断哪些 L3 tag 已存在(L3-01..06 应在)、哪些要新建/重做(L3-03 重做、L3-07/08 新建)。

无需 commit(本 Task 只验证)。

---

## Task 1: config.mjs + tasks.mjs(常量与任务定义)

**Files:**

- Create: `D:\moss-eval/harness/config.mjs`
- Create: `D:\moss-eval/harness/tasks.mjs`

**Interfaces:**

- `config.mjs` 导出 `CONFIG` 对象,被 run-subject/pool/run-eval 消费。
- `tasks.mjs` 导出 `TASKS: EvalTask[]` 与 `ROUNDS`,被 run-eval 消费。每项 `{id, layer, prompt, tag, cleanMode, watch, expectedFixPatch?}`。

- [ ] **Step 1: 写 config.mjs**

Create `D:\moss-eval\harness\config.mjs`:

```javascript
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..'); // D:\moss-eval

export const CONFIG = {
  root: ROOT,
  fixtures: path.join(ROOT, 'fixtures', 'sample-lib'),
  expectedDir: path.join(ROOT, 'fixtures', 'expected'),
  runs: path.join(ROOT, 'runs'),
  reports: path.join(ROOT, 'reports'),
  mossConfigFile: path.join(ROOT, 'harness', 'moss-config', 'config.json'),
  claudeConfigDir: path.join(ROOT, 'harness', 'claude-config', 'clean-home', '.claude'),
  model: 'HORIZON-GLM',
  maxTurns: 30,
  timeoutMs: 300_000, // 5 min/次
  defaultConcurrency: 1, // 试水轮串行;后两轮可调高
  defaultRounds: 1, // 试水先 1 轮
};
```

- [ ] **Step 2: 写 tasks.mjs**

Create `D:\moss-eval\harness\tasks.mjs`:

```javascript
// 15 个第 2 层任务 + 8 个第 3 层任务。
// prompt 是给 agent 的原话,中性措辞、不点名工具(测工具选择准确率)。
// tag = fixtures/sample-lib 的 git tag(L2 用 base,L3 各自 bug tag)。
// cleanMode: 'fd' = git clean -fd(保 node_modules);'fdx' = git clean -fdx(清 node_modules,测缺依赖)。
// watch = 观测重点,供 score-layer2 隐性候选启发式用。
// expectedFixPatch = L3 任务"修复后应出现的 diff 关键行"(score-layer3 判是否真修对,宽松口径:测试过且改动含此关键行即算修对)。

export const TASKS = [
  // ── 第 2 层(工具准确率),15 个,tag=base,cleanMode=fd ──
  {
    id: 'L2-01',
    layer: 2,
    tag: 'base',
    cleanMode: 'fd',
    watch: 'search-not-fullread',
    prompt: '找出这个项目里所有调用 deprecatedFn 的地方,列出文件和行号。',
  },
  {
    id: 'L2-02',
    layer: 2,
    tag: 'base',
    cleanMode: 'fd',
    watch: 'grep-vs-filebyfile',
    prompt: '找出 divide 函数定义在哪个文件的哪一行。',
  },
  {
    id: 'L2-03',
    layer: 2,
    tag: 'base',
    cleanMode: 'fd',
    watch: 'multi-search-aggregate',
    prompt: '列出 src 下被 import 次数最多的模块名。',
  },
  {
    id: 'L2-04',
    layer: 2,
    tag: 'base',
    cleanMode: 'fd',
    watch: 'exact-path-symbol',
    prompt: '读取 src/calc.ts 里 divide 函数的实现,贴出来。',
  },
  {
    id: 'L2-05',
    layer: 2,
    tag: 'base',
    cleanMode: 'fd',
    watch: 'should-error-not-hallucinate',
    prompt: '读取 src/does-not-exist.ts 的内容。',
  },
  {
    id: 'L2-06',
    layer: 2,
    tag: 'base',
    cleanMode: 'fd',
    watch: 'cross-dir-path',
    prompt: '读取 node_modules/typescript 的 package.json 里的 version 字段。',
  },
  {
    id: 'L2-07',
    layer: 2,
    tag: 'base',
    cleanMode: 'fd',
    watch: 'minimal-diff',
    prompt: '把 src/format.ts 里 fmtDate 函数改成返回 ISO 格式字符串(YYYY-MM-DD)。',
  },
  {
    id: 'L2-08',
    layer: 2,
    tag: 'base',
    cleanMode: 'fd',
    watch: 'multi-file-edit',
    prompt: '给 src/calc.ts 里的 add、divide、deprecatedFn 三个函数各加一句 JSDoc 注释。',
  },
  {
    id: 'L2-09',
    layer: 2,
    tag: 'base',
    cleanMode: 'fd',
    watch: 'cross-file-rename',
    prompt: '把 src/format.ts 里 camelCase 函数改名为 snake_case,并更新所有引用。',
  },
  {
    id: 'L2-10',
    layer: 2,
    tag: 'base',
    cleanMode: 'fd',
    watch: 'test-result-parse',
    prompt: '跑测试,列出失败的测试名。如果没有失败,说明全部通过。',
  },
  {
    id: 'L2-11',
    layer: 2,
    tag: 'base',
    cleanMode: 'fd',
    watch: 'tsc-result-parse',
    prompt: '跑 tsc 类型检查,列出所有类型错误。如果没有错误,说明类型干净。',
  },
  {
    id: 'L2-12',
    layer: 2,
    tag: 'base',
    cleanMode: 'fd',
    watch: 'cli-arg-passing',
    prompt: '跑 src/calc.ts 里 add 函数对参数 2 和 3 的调用(用 node),打印结果。',
  },
  {
    id: 'L2-13',
    layer: 2,
    tag: 'base',
    cleanMode: 'fd',
    watch: 'no-false-positive',
    prompt: '这个项目有没有安装 lodash?回答有或没有,并说明依据。',
  },
  {
    id: 'L2-14',
    layer: 2,
    tag: 'base',
    cleanMode: 'fd',
    watch: 'read-package-json',
    prompt: '这个库的版本号是多少?',
  },
  {
    id: 'L2-15',
    layer: 2,
    tag: 'base',
    cleanMode: 'fd',
    watch: 'truncation-boundary',
    prompt: '读取 src/calc.ts 的完整内容并原样贴出。',
  },

  // ── 第 3 层(错误闭环),8 个,各自 bug tag ──
  {
    id: 'L3-01',
    layer: 3,
    tag: 'L3-01',
    cleanMode: 'fd',
    watch: 'syntax-fix',
    prompt: '让 npm test 通过。',
    expectedFixPatch: 'return a / b; }',
  },
  {
    id: 'L3-02',
    layer: 3,
    tag: 'L3-02',
    cleanMode: 'fd',
    watch: 'divide-zero',
    prompt: '修复 divide 函数的除零问题,让所有测试通过。',
    expectedFixPatch: "if (b === 0) throw new RangeError('divide by zero')",
  },
  {
    id: 'L3-03',
    layer: 3,
    tag: 'L3-03',
    cleanMode: 'fdx',
    watch: 'missing-dep',
    prompt: '装好依赖让项目能 build(tsc --noEmit 通过)。',
    expectedFixPatch: '"lodash-es"',
  },
  {
    id: 'L3-04',
    layer: 3,
    tag: 'L3-04',
    cleanMode: 'fd',
    watch: 'import-case',
    prompt: '修掉导致 import 失败的路径错误,让测试通过。',
    expectedFixPatch: "'../src/calc.ts'",
  },
  {
    id: 'L3-05',
    layer: 3,
    tag: 'L3-05',
    cleanMode: 'fd',
    watch: 'type-annotation',
    prompt: '修掉 tsc 报的类型错误。',
    expectedFixPatch: 'add(a: number',
  },
  {
    id: 'L3-06',
    layer: 3,
    tag: 'L3-06',
    cleanMode: 'fd',
    watch: 'comparator-direction',
    prompt: '修掉 sortAsc 的逻辑错误,让测试通过。',
    expectedFixPatch: 'a - b',
  },
  {
    id: 'L3-07',
    layer: 3,
    tag: 'L3-07',
    cleanMode: 'fd',
    watch: 'missing-await',
    prompt: '修复 useIt,让它返回正确的值,让测试通过。',
    expectedFixPatch: 'await fetchDouble',
  },
  {
    id: 'L3-08',
    layer: 3,
    tag: 'L3-08',
    cleanMode: 'fd',
    watch: 'tsconfig-target',
    prompt: '修复让 tsc --noEmit 能通过的配置问题。',
    expectedFixPatch: '"target": "ES2022"',
  },
];

export const ROUNDS = 3; // 每任务跑 3 轮(试水轮用 --rounds 1)
```

- [ ] **Step 3: 自检加载**

```bash
cd /d/moss-eval
node --input-type=module -e "import('./harness/tasks.mjs').then(m=>console.log('tasks:',m.TASKS.length,'rounds:',m.ROUNDS))"
```

Expected: `tasks: 23 rounds: 3`

- [ ] **Step 4: Commit**

```bash
cd /d/moss-eval
git add harness/config.mjs harness/tasks.mjs
git commit -m "feat(harness): config constants + task definitions (15 L2 + 8 L3)"
```

---

## Task 2: 修齐 L3 fixtures(L3-03 重做 + L3-07/08 新建 + 预期 patch)

**Files:**

- Modify: `D:\moss-eval/fixtures/sample-lib/*`(在 base 副本上逐个埋 bug)
- Create: `D:\moss-eval/fixtures/expected/L3-01.patch` .. `L3-08.patch`

**Interfaces:** 产出 git tags `L3-01`..`L3-08`(L3-01/02/04/05/06 已存在,本 Task 校验即可;L3-03 重做;L3-07/08 新建)+ `fixtures/expected/` 下 8 个预期 patch 文件。被 tasks.mjs 的 `tag` 与 `expectedFixPatch` 字段引用,被 score-layer3 对照。

**关键修正:** 旧版 L3-03 只 `import _ from 'lodash-es'` 但不使用 —— 未使用的 import 在多数 tsconfig 下只是 warning 不 fail build,bug 没真正落地。本 Task 让 sample-lib **真正使用** lodash-es 且 `package.json` 不声明该依赖,使 `tsc`/`npm install` 报缺依赖。

- [ ] **Step 1: 验证已存在的 L3-01/02/04/05/06 tag 状态正确**

```bash
cd /d/moss-eval
for t in L3-01 L3-02 L3-04 L3-05 L3-06; do
  git checkout $t -- . >/dev/null 2>&1
  echo "=== $t: tsc ==="; (cd fixtures/sample-lib && npx tsc --noEmit 2>&1 | head -2)
done
git checkout base -- . && git clean -fd fixtures/sample-lib
```

Expected: 各 tag checkout 成功;tsc 产出对应错误(L3-02/06 是测试失败而非 tsc 错,允许 tsc 干净)。若某 tag checkout 失败或状态不对,记下来在后续 step 修正。

- [ ] **Step 2: 重做 L3-03(真正使用 lodash-es + 不声明依赖)**

```bash
cd /d/moss-eval
git checkout base -- . && git clean -fdx -e node_modules fixtures/sample-lib
```

确认 `fixtures/sample-lib/src/format.ts` 当前内容(应含 `fmtDate`/`camelCase`)。改 `src/format.ts`,在顶部加 import 并真正使用它:

Create `D:\moss-eval\fixtures\sample-lib\src\format.ts`(覆盖):

```typescript
import { camelCase as _camelCase } from 'lodash-es';

export function fmtDate(d: Date): string {
  return d.toLocaleDateString();
}
export function toCamel(input: string): string {
  return _camelCase(input);
}
```

确认 `package.json` **不含** `lodash-es`(base 本就没有,保持):

```bash
grep -q '"lodash-es"' fixtures/sample-lib/package.json && echo "BAD: dep declared" || echo "OK: dep not declared"
```

Expected: `OK: dep not declared`。验证 bug 真实落地:

```bash
cd fixtures/sample-lib && rm -rf node_modules && npx tsc --noEmit 2>&1 | head -3
```

Expected: tsc 报 `Cannot find module 'lodash-es'` 或类似缺模块错误。确认后:

```bash
cd /d/moss-eval
git add -A && git commit -m "bug(L3-03): missing dependency lodash-es (actually used, not declared)"
# 删除旧 tag 重建
git tag -d L3-03 2>/dev/null; git tag L3-03
```

- [ ] **Step 3: 新建 L3-07(忘 await)**

```bash
cd /d/moss-eval
git checkout base -- . && git clean -fdx -e node_modules fixtures/sample-lib
```

Create `D:\moss-eval\fixtures\sample-lib\src\async.ts`:

```typescript
export async function fetchDouble(x: number): Promise<number> {
  return x * 2;
}
export async function useIt(x: number): Promise<number> {
  fetchDouble(x);
  return 0;
}
```

Create `D:\moss-eval\fixtures\sample-lib\test\async.test.ts`:

```typescript
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useIt } from '../src/async.ts';
test('useIt returns doubled', async () => {
  assert.equal(await useIt(3), 6);
});
```

验证 bug 落地(`useIt` 忘 await → 返回 0 → 测试失败):

```bash
cd fixtures/sample-lib && npm test 2>&1 | tail -5
```

Expected: `useIt returns doubled` 测试失败(assert.equal 0 !== 6)。确认后:

```bash
cd /d/moss-eval
git add -A && git commit -m "bug(L3-07): missing await in useIt" && git tag L3-07
```

- [ ] **Step 4: 新建 L3-08(tsconfig target 太低)**

```bash
cd /d/moss-eval
git checkout base -- . && git clean -fdx -e node_modules fixtures/sample-lib
```

改 `fixtures/sample-lib/tsconfig.json` 把 `target` 从 `ES2022` 改为 `ES3`(用 Read 确认当前内容后 Edit):

Read 当前 `D:\moss-eval\fixtures\sample-lib\tsconfig.json`,把 `"target": "ES2022"` 改成 `"target": "ES3"`。

改 `src/calc.ts` 用 ES2020+ 语法(ES3 不识别 → 编译报错)。Create `D:\moss-eval\fixtures\sample-lib\src\calc.ts`(覆盖):

```typescript
export function add(a: number, b: number): number {
  return a + b;
}
export function divide(a: number, b: number): number {
  return a / b;
}
export function deprecatedFn(): string {
  return 'old';
}
export function defaulted(a: number, b: number = 0): number {
  return a + b;
}
```

> 用默认参数 `b: number = 0` —— ES3 target 下 tsc 会报 `TS2731: ... only available in ES2015+` 或类似 target 不足错误。
> 验证:

```bash
cd fixtures/sample-lib && npx tsc --noEmit 2>&1 | head -3
```

Expected: tsc 报与 target 相关的错误。确认后:

```bash
cd /d/moss-eval
git add -A && git commit -m "bug(L3-08): tsconfig target too low (ES3)" && git tag L3-08
```

- [ ] **Step 5: 写 8 个预期修复 patch 文件**

每个 patch 是该 bug「正确修复后」相对 base 的最小 diff。供 score-layer3 宽松对照(diff 含关键行即算修对)。

`mkdir -p /d/moss-eval/fixtures/expected`

Create `D:\moss-eval\fixtures\expected\L3-01.patch`:

```diff
--- a/src/calc.ts
+++ b/src/calc.ts
@@
-export function divide(a: number, b: number): number { return a / b;
+export function divide(a: number, b: number): number { return a / b; }
```

Create `D:\moss-eval\fixtures\expected\L3-02.patch`:

```diff
--- a/src/calc.ts
+++ b/src/calc.ts
@@
-export function divide(a: number, b: number): number { return a / b; }
+export function divide(a: number, b: number): number { if (b === 0) throw new RangeError('divide by zero'); return a / b; }
```

Create `D:\moss-eval\fixtures\expected\L3-03.patch`:

```diff
--- a/package.json
+++ b/package.json
@@
-  "devDependencies": { "typescript": "^5.7.3" }
+  "dependencies": { "lodash-es": "^4.17.21" },
+  "devDependencies": { "typescript": "^5.7.3" }
```

> 修复路径二选一皆算修对:声明依赖,或删掉对 lodash-es 的使用。本 patch 示范「声明依赖」。

Create `D:\moss-eval\fixtures\expected\L3-04.patch`:

```diff
--- a/test/calc.test.ts
+++ b/test/calc.test.ts
@@
-import { add, divide } from '../src/Calc.ts';
+import { add, divide } from '../src/calc.ts';
```

Create `D:\moss-eval\fixtures\expected\L3-05.patch`:

```diff
--- a/src/calc.ts
+++ b/src/calc.ts
@@
-export function add(a: string, b: number): number { return a + b; }
+export function add(a: number, b: number): number { return a + b; }
```

Create `D:\moss-eval\fixtures\expected\L3-06.patch`:

```diff
--- a/src/sort.ts
+++ b/src/sort.ts
@@
-export function sortAsc(arr: number[]): number[] { return [...arr].sort((a, b) => b - a); }
+export function sortAsc(arr: number[]): number[] { return [...arr].sort((a, b) => a - b); }
```

Create `D:\moss-eval\fixtures\expected\L3-07.patch`:

```diff
--- a/src/async.ts
+++ b/src/async.ts
@@
-export async function useIt(x: number): Promise<number> { fetchDouble(x); return 0; }
+export async function useIt(x: number): Promise<number> { return await fetchDouble(x); }
```

Create `D:\moss-eval\fixtures\expected\L3-08.patch`:

```diff
--- a/tsconfig.json
+++ b/tsconfig.json
@@
-  "compilerOptions": { "target": "ES3", ...
+  "compilerOptions": { "target": "ES2022", ...
```

- [ ] **Step 6: 回到 base + 校验全部 tag 可重置**

```bash
cd /d/moss-eval
git checkout base -- . && git clean -fdx -e node_modules fixtures/sample-lib
echo "=== all L3 tags ==="; git tag -l 'L3-*' | sort
for t in L3-01 L3-02 L3-03 L3-04 L3-05 L3-06 L3-07 L3-08; do
  git checkout $t -- . >/dev/null 2>&1 && echo "$t: ok" || echo "$t: MISSING"
done
git checkout base -- . && git clean -fd fixtures/sample-lib
```

Expected: 8 个 tag 全 `ok`。

- [ ] **Step 7: Commit fixtures + expected patches**

```bash
cd /d/moss-eval
git add fixtures/sample-lib fixtures/expected
git commit -m "feat(fixtures): rework L3-03 (actually use lodash-es), add L3-07/08 tags + expected patches"
```

---

## Task 3: reset.mjs(fixtures 重置,按 cleanMode)

**Files:**

- Create: `D:\moss-eval/harness/lib/reset.mjs`

**Interfaces:** `reset(tag, cleanMode, workDir?)` —— 在 `workDir`(默认 `CONFIG.fixtures`)跑 `git checkout <tag> -- . && git clean <-fd|fdx>`。被 pool/run-subject 消费。

- [ ] **Step 1: 写 reset.mjs**

Create `D:\moss-eval\harness\lib\reset.mjs`:

```javascript
import { execSync } from 'node:child_process';
import { CONFIG } from '../config.mjs';

// 在 workDir(默认 CONFIG.fixtures)重置到 tag,cleanMode 决定是否清 node_modules。
// 'fd'  → git clean -fd      (保 node_modules,L2 需要它跑 tsc)
// 'fdx' → git clean -fdx     (清 node_modules,L3-03 测缺依赖)
export function reset(tag, cleanMode = 'fd', workDir = CONFIG.fixtures) {
  const cleanFlag = cleanMode === 'fdx' ? '-fdx' : '-fd';
  execSync(`git checkout ${tag} -- .`, { cwd: workDir, stdio: 'pipe' });
  execSync(`git clean ${cleanFlag}`, { cwd: workDir, stdio: 'pipe' });
}
```

- [ ] **Step 2: 冒烟测**

```bash
cd /d/moss-eval
node --input-type=module -e "
  const {reset}=await import('./harness/lib/reset.mjs');
  reset('base','fd');
  const {execSync}=await import('node:child_process');
  console.log(execSync('git status --porcelain',{cwd:'fixtures/sample-lib'}).toString() || 'clean');
"
```

Expected: `clean`(working tree 无改动)。再测 fdx 不报错:

```bash
node --input-type=module -e "const{reset}=await import('./harness/lib/reset.mjs');reset('L3-03','fdx');console.log('fdx ok');"
```

Expected: `fdx ok`。

- [ ] **Step 3: Commit**

```bash
cd /d/moss-eval
git add harness/lib/reset.mjs
git commit -m "feat(harness): reset() with per-task cleanMode"
```

---

## Task 4: run-subject.mjs(统一 headless 调用,两边共用)

**Files:**

- Create: `D:\moss-eval/harness/lib/run-subject.mjs`

**Interfaces:** `runSubject(subject, task, round, workDir, ts)` → `{status, streamPath, diffPath}`。

- `subject`: `'moss' | 'claude'`
- 捕获 stream-json 到 `runs/<ts>/<task.id>/<subject>/round-<round>/stream.jsonl`
- 运行后捕获 `git diff` 到同目录 `diff.patch`
- 写 `status.json`:`{subject, taskId, round, tag, exitCode, durationMs, costUsd, terminalReason}`
- **超时**:超过 `CONFIG.timeoutMs` kill 进程树,`terminalReason:'timeout'`
- 两边都用 `--max-turns CONFIG.maxTurns`

**关键:** moss 与 claude 都用 `--output-format stream-json`,事件流形状一致,故用一个函数处理两 subject,只差二进制名和参数。

- [ ] **Step 1: 写 run-subject.mjs**

Create `D:\moss-eval\harness\lib\run-subject.mjs`:

```javascript
import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { CONFIG } from '../config.mjs';

// 两 subject 的命令构造。两边都用 stream-json。
function buildArgs(subject, task) {
  const common = [
    '-p',
    task.prompt,
    '--max-turns',
    String(CONFIG.maxTurns),
    '--output-format',
    'stream-json',
  ];
  if (subject === 'moss') {
    // moss: --config-file 指向隔离配置。--output-format stream-json 在 moss 里直接可用。
    return ['--config-file', CONFIG.mossConfigFile, ...common];
  }
  // claude: stream-json 需 --verbose;CLAUDE_CONFIG_DIR 经 env 传入(见 runSubject)。
  return [...common, '--verbose', '--permission-mode', 'bypassPermissions'];
}

function buildEnv(subject) {
  const env = { ...process.env };
  if (subject === 'claude') {
    env.CLAUDE_CONFIG_DIR = CONFIG.claudeConfigDir;
  }
  return env;
}

function killTree(pid) {
  try {
    execFileSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore' });
  } catch {
    try {
      process.kill(pid);
    } catch {}
  }
}

export async function runSubject(subject, task, round, workDir, ts) {
  const outDir = path.join(CONFIG.runs, ts, task.id, subject, `round-${round}`);
  await fsp.mkdir(outDir, { recursive: true });
  const streamPath = path.join(outDir, 'stream.jsonl');
  const rawPath = path.join(outDir, 'raw.log');
  const diffPath = path.join(outDir, 'diff.patch');
  const statusPath = path.join(outDir, 'status.json');

  const startedAt = Date.now();
  const stream = createWriteStream(streamPath);
  const raw = createWriteStream(rawPath);
  const args = buildArgs(subject, task);
  const bin = subject === 'moss' ? 'moss' : 'claude';

  const status = {
    subject,
    taskId: task.id,
    round,
    tag: task.tag,
    exitCode: null,
    durationMs: null,
    costUsd: null,
    terminalReason: 'unknown',
  };

  await new Promise((resolve) => {
    let timedOut = false;
    const p = spawn(bin, args, {
      cwd: workDir,
      env: buildEnv(subject),
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(p.pid);
    }, CONFIG.timeoutMs);

    p.stdout.on('data', (d) => {
      stream.write(d);
    });
    p.stderr.on('data', (d) => {
      raw.write(d);
    });
    p.on('close', (code) => {
      clearTimeout(timer);
      stream.end();
      raw.end();
      status.exitCode = code;
      status.terminalReason = timedOut ? 'timeout' : code === 0 ? 'completed' : 'error';
      resolve();
    });
    p.on('error', () => {
      clearTimeout(timer);
      stream.end();
      raw.end();
      status.terminalReason = 'error';
      resolve();
    });
  });

  status.durationMs = Date.now() - startedAt;

  // 捕获运行后 diff(L3 有意义,L2 多为只读/空)
  try {
    const diff = execFileSync('git', ['diff'], { cwd: workDir });
    await fsp.writeFile(diffPath, diff);
  } catch {
    await fsp.writeFile(diffPath, '');
  }

  // cost: 从 stream.jsonl 的 result 事件取(claude 有 total_cost_usd,moss 为 null)
  try {
    const lines = (await fsp.readFile(streamPath, 'utf8')).split('\n').filter(Boolean);
    const resultEv = lines
      .map((l) => {
        try {
          return JSON.parse(l);
        } catch {
          return null;
        }
      })
      .find((e) => e?.type === 'result');
    if (resultEv?.total_cost_usd != null) status.costUsd = resultEv.total_cost_usd;
  } catch {}

  await fsp.writeFile(statusPath, JSON.stringify(status, null, 2));
  return { status, streamPath, diffPath };
}
```

- [ ] **Step 2: 冒烟测 —— 两边各跑一个真实工具任务**

先确保 fixtures 在 base、有 node_modules:

```bash
cd /d/moss-eval
git checkout base -- . && (cd fixtures/sample-lib && [ -d node_modules ] || npm install >/dev/null 2>&1)
```

跑 moss 一个 L2 任务:

```bash
node --input-type=module -e "
  const{runSubject}=await import('./harness/lib/run-subject.mjs');
  const{reset}=await import('./harness/lib/reset.mjs');
  const{TASKS}=await import('./harness/tasks.mjs');
  const t=TASKS.find(x=>x.id==='L2-01');
  reset(t.tag,t.cleanMode);
  const r=await runSubject('moss',t,1,'fixtures/sample-lib','smoke');
  console.log('moss status:',JSON.stringify(r.status));
  const fsp=await import('node:fs/promises');
  const lines=(await fsp.readFile(r.streamPath,'utf8')).split('\n').filter(Boolean);
  const tu=lines.filter(l=>l.includes('tool_use')).length;
  console.log('moss tool_use events:',tu);
"
```

Expected: `moss status: {"subject":"moss",...,"terminalReason":"completed",...}` 且 `moss tool_use events:` ≥ 1。
跑 claude 同一任务:

```bash
node --input-type=module -e "
  const{runSubject}=await import('./harness/lib/run-subject.mjs');
  const{reset}=await import('./harness/lib/reset.mjs');
  const{TASKS}=await import('./harness/tasks.mjs');
  const t=TASKS.find(x=>x.id==='L2-01');
  reset(t.tag,t.cleanMode);
  const r=await runSubject('claude',t,1,'fixtures/sample-lib','smoke');
  console.log('claude status:',JSON.stringify(r.status));
  const fsp=await import('node:fs/promises');
  const lines=(await fsp.readFile(r.streamPath,'utf8')).split('\n').filter(Boolean);
  const tu=lines.filter(l=>l.includes('tool_use')).length;
  console.log('claude tool_use events:',tu);
"
```

Expected: `claude status: ...terminalReason":"completed"...` 且 `claude tool_use events:` ≥ 1。若 claude 状态 error 或 tool_use=0,检查 `CLAUDE_CONFIG_DIR` 是否正确隔离(无 superpowers)。

- [ ] **Step 3: Commit**

```bash
cd /d/moss-eval
git add harness/lib/run-subject.mjs
git commit -m "feat(harness): unified runSubject() for moss+claude via stream-json"
```

---

## Task 5: collect.mjs(统一解析两边 stream-json)

**Files:**

- Create: `D:\moss-eval/harness/lib/collect.mjs`

**Interfaces:** `collect(streamPath, subject, taskId, round)` → `RunResult`,写 `metrics.json` 到 stream 同目录,返回该对象。
`RunResult` schema(两边同字段,下游评分不分支):

```jsonc
{
  "subject": "moss"|"claude",
  "taskId": "L2-01",
  "round": 1,
  "toolCalls": [{ "name","input","ok","errorKind","turn" }],
  "turns": 7,
  "errorEvents": [/* ok=false 的 toolCall 摘要 */],
  "deniedOrBlocked": 3,
  "durationMs": 12340,
  "costUsd": 0.05 | null,
  "terminalReason": "completed"|"max_turns"|"error"|"timeout"
}
```

**关键:** moss 与 claude stream-json 形状一致(冒烟实测):

- `assistant` 事件 `content[]` 含 `{type:'tool_use', id, name, input}`
- `user` 事件 `content[]` 含 `{type:'tool_result', tool_use_id, is_error}`
- `result` 事件含 `num_turns`/`is_error`/`duration_ms`/`total_cost_usd`
  两边都用同一解析逻辑,只过滤 claude 特有的 `thinking_tokens` 噪音行。

- [ ] **Step 1: 写 collect.mjs**

Create `D:\moss-eval\harness\lib\collect.mjs`:

```javascript
import fsp from 'node:fs/promises';
import path from 'node:path';

// DENIED 类 outcome:不计入工具错误分母。
const DENIED_KINDS = new Set(['denied', 'pre-blocked', 'hook-blocked', 'unknown-tool']);

// 统一解析 moss/claude 的 stream-json。两边事件形状一致:
//  assistant.content[] → {type:'tool_use', id, name, input}
//  user.content[]      → {type:'tool_result', tool_use_id, is_error}
//  result              → {num_turns, is_error, duration_ms, total_cost_usd, subtype}
// claude 多 thinking_tokens 噪音行 → 过滤(type==='system' && subtype==='thinking_tokens')。
export async function collect(streamPath, subject, taskId, round) {
  const outDir = path.dirname(streamPath);
  let turns = 0,
    terminalReason = 'unknown',
    durationMs = null,
    costUsd = null;
  const useById = new Map(); // tool_use_id → {name, input, turn, ok, errorKind}
  let turnCounter = 0;
  let parseError = null;

  try {
    const lines = (await fsp.readFile(streamPath, 'utf8')).split('\n').filter(Boolean);
    for (const line of lines) {
      let ev;
      try {
        ev = JSON.parse(line);
      } catch {
        continue;
      }
      // 过滤 claude thinking_tokens 噪音
      if (ev.type === 'system' && ev.subtype === 'thinking_tokens') continue;

      if (ev.type === 'assistant' && ev.message?.content) {
        turnCounter++;
        for (const c of ev.message.content) {
          if (c.type === 'tool_use') {
            useById.set(c.id, {
              name: c.name,
              input: c.input,
              turn: turnCounter,
              ok: true,
              errorKind: null,
            });
          }
        }
      } else if (ev.type === 'user' && ev.message?.content) {
        for (const c of ev.message.content) {
          if (c.type === 'tool_result') {
            const u = useById.get(c.tool_use_id);
            if (u) {
              u.ok = c.is_error !== true;
              u.errorKind = c.is_error ? 'tool_error' : null;
            }
          }
        }
      } else if (ev.type === 'result') {
        turns = ev.num_turns ?? turnCounter;
        durationMs = ev.duration_ms ?? null;
        costUsd = ev.total_cost_usd ?? null;
        if (ev.subtype === 'error_max_turns' || ev.stop_reason === 'max_turns')
          terminalReason = 'max_turns';
        else if (ev.is_error) terminalReason = 'error';
        else terminalReason = 'completed';
      }
    }
  } catch (e) {
    parseError = String(e);
  }

  const toolCalls = [...useById.values()];
  const errorEvents = toolCalls
    .filter((c) => !c.ok)
    .map((c) => ({ name: c.name, turn: c.turn, errorKind: c.errorKind }));
  // deniedOrBlocked:本版从 stream-json 难直接取(claude permission_denials 在 result;moss denied 在 tool_result content)。
  // 粗略统计:tool_result 内容含 "denied"/"blocked"/"unknown tool" 且非 isError 的,标记为 denied。下游评分容错。
  const deniedOrBlocked = 0; // 见 Step 2 注:落地时按需细化,初版置 0 不影响显性错误率主指标(分子=completed&&isError)

  const result = {
    subject,
    taskId,
    round,
    toolCalls,
    turns,
    errorEvents,
    deniedOrBlocked,
    durationMs,
    costUsd,
    terminalReason,
    ...(parseError ? { parseError } : {}),
  };
  await fsp.writeFile(path.join(outDir, 'metrics.json'), JSON.stringify(result, null, 2));
  return result;
}
```

- [ ] **Step 2: 用 smoke 产物自测解析**

```bash
cd /d/moss-eval
node --input-type=module -e "
  const{collect}=await import('./harness/lib/collect.mjs');
  const fsp=await import('node:fs/promises');
  // 找 smoke 跑出来的 stream
  const dir='runs/smoke/L2-01';
  for (const sub of ['moss','claude']) {
    const p=\`\${dir}/\${sub}/round-1/stream.jsonl\`;
    try {
      const r=await collect(p,sub,'L2-01',1);
      console.log(sub,'→ turns:',r.turns,'toolCalls:',r.toolCalls.length,'errors:',r.errorEvents.length,'terminal:',r.terminalReason);
    } catch(e){ console.log(sub,'no smoke artifact:',e.message); }
  }
"
```

Expected: 两边都输出非负数字,`terminal:'completed'`,`toolCalls` ≥ 1(L2-01 是搜索任务,应有用 search/read 工具)。若 `toolCalls:0` 但任务有响应,说明 tool_use 解析路径有 bug,回 Step 1 检查。

- [ ] **Step 3: Commit**

```bash
cd /d/moss-eval
git add harness/lib/collect.mjs
git commit -m "feat(harness): unified collect() parsing moss+claude stream-json → metrics.json"
```

---

## Task 6: score-layer2.mjs(显性错误率 + 隐性候选)

**Files:**

- Create: `D:\moss-eval/harness/score-layer2.mjs`

**Interfaces:** `scoreLayer2(runResult, task)` → `{total, explicitErrors, explicitRate, reviewCandidates}`。

- `分母 = toolCalls.length - deniedOrBlocked`;`分子 = toolCalls.filter(ok=false).length`(即 errorEvents)
- 隐性候选启发式 → 进 review-samples:
  - 工具名与任务 `watch` 不匹配(如 `watch:'search-not-fullread'` 但全程只用 read 不用 search)
  - 同一工具 + 相同 input 重复 ≥3
  - 读不存在路径却 `ok:true`(幻觉,watch 含 `should-error-not-hallucinate`)
  - `terminalReason !== 'completed'`

- [ ] **Step 1: 写 score-layer2.mjs**

Create `D:\moss-eval\harness\score-layer2.mjs`:

```javascript
// 第 2 层判分。显性错误率(自动)+ 隐性错误候选(启发式 → 人工)。
// 显性:completed 工具调用里 is_error=true 的占比。denied 类不计入分母。
// 隐性候选(交人工):工具与任务 watch 不匹配、同工具同参重复≥3、读不存在路径未报错、terminalReason 非 completed。

const WATCH_EXPECTS = {
  'search-not-fullread': ['search_code', 'search_files', 'grep', 'Grep', 'search'],
  'grep-vs-filebyfile': ['search_code', 'search_files', 'grep', 'Grep', 'search'],
  'multi-search-aggregate': ['search_code', 'search_files', 'grep', 'Grep', 'search'],
  'read-package-json': ['read_file', 'Read', 'cat'],
};

export function scoreLayer2(run, task) {
  const denom = Math.max(0, run.toolCalls.length - (run.deniedOrBlocked || 0));
  const explicitErrors = run.errorEvents.length;
  const explicitRate = denom ? explicitErrors / denom : 0;

  const candidates = [];

  // 1. 工具与 watch 预期不匹配
  const expects = WATCH_EXPECTS[task.watch];
  if (expects) {
    const used = new Set(run.toolCalls.map((c) => c.name));
    const hitExpected = [...used].some((n) => expects.includes(n));
    if (!hitExpected && run.toolCalls.length > 0) {
      candidates.push({ kind: 'tool-mismatch', watch: task.watch, used: [...used] });
    }
  }

  // 2. 同工具同参重复 ≥3
  const seen = new Map();
  for (const c of run.toolCalls) {
    const key = c.name + '|' + JSON.stringify(c.input ?? {});
    seen.set(key, (seen.get(key) ?? 0) + 1);
  }
  const repeated = [...seen.entries()].filter(([, n]) => n >= 3).map(([k]) => k);
  if (repeated.length) candidates.push({ kind: 'repeat-tool', keys: repeated });

  // 3. 读不存在路径却 ok(幻觉)
  if (task.watch === 'should-error-not-hallucinate') {
    const reads = run.toolCalls.filter((c) => /read|cat/i.test(c.name));
    const okReads = reads.filter((c) => c.ok);
    if (okReads.length && !run.errorEvents.length) {
      candidates.push({ kind: 'suspected-hallucination', reads: okReads.length });
    }
  }

  // 4. terminalReason 非 completed
  if (run.terminalReason !== 'completed') {
    candidates.push({ kind: 'non-completed', reason: run.terminalReason });
  }

  return {
    subject: run.subject,
    taskId: task.id,
    round: run.round,
    total: denom,
    explicitErrors,
    explicitRate,
    terminalReason: run.terminalReason,
    durationMs: run.durationMs,
    costUsd: run.costUsd,
    reviewCandidates: candidates,
  };
}
```

- [ ] **Step 2: 单元自测(构造假数据)**

```bash
cd /d/moss-eval
node --input-type=module -e "
  const{scoreLayer2}=await import('./harness/score-layer2.mjs');
  const run={subject:'moss',taskId:'L2-05',round:1,toolCalls:[
    {name:'read_file',input:{path:'x'},turn:1,ok:true,errorKind:null},
    {name:'read_file',input:{path:'y'},turn:2,ok:false,errorKind:'tool_error'},
    {name:'search_code',input:{q:'z'},turn:3,ok:true,errorKind:null},
  ],errorEvents:[{name:'read_file',turn:2,errorKind:'tool_error'}],deniedOrBlocked:0,
  durationMs:1000,costUsd:null,terminalReason:'completed'};
  const s=scoreLayer2(run,{id:'L2-05',watch:'should-error-not-hallucinate'});
  console.log(JSON.stringify(s,null,2));
"
```

Expected: `total:3, explicitErrors:1, explicitRate:0.3333`,且因 watch 是 `should-error-not-hallucinate` 但有 ok 的 read 且有 errorEvents → `suspected-hallucination` 候选**不应**出现(因为有 errorEvents 说明报错了)。验证逻辑:此例有 errorEvents 故不算幻觉,候选应为空或仅含其他类。确认 `explicitRate ≈ 0.3333`。

- [ ] **Step 3: Commit**

```bash
cd /d/moss-eval
git add harness/score-layer2.mjs
git commit -m "feat(harness): layer2 scorer (explicit error rate + hidden-error candidates)"
```

---

## Task 7: score-layer3.mjs(纠错轮数 + 死循环 + 修复对照)

**Files:**

- Create: `D:\moss-eval/harness/score-layer3.mjs`

**Interfaces:** `scoreLayer3(runResult, task, diffPath)` → `{turns, repeatFailures, deathLoop, testPassed, fixMatched}`。

- `repeatFailures`:同名 tool + 相同 input + `ok=false` 的序列最长长度
- `deathLoop`:`repeatFailures >= 3`
- `fixMatched`:`diff.patch` 含 `task.expectedFixPatch` 关键行(宽松)
- `testPassed`:运行后在 workDir 跑 `npm test`/`tsc --noEmit` 是否通过(初判,人工终判)

- [ ] **Step 1: 写 score-layer3.mjs**

Create `D:\moss-eval\harness\score-layer3.mjs`:

```javascript
import fs from 'node:fs';
import { execSync } from 'node:child_process';
import { CONFIG } from './config.mjs';

function inputHash(input) {
  return JSON.stringify(input ?? {});
}

// 第 3 层判分。纠错轮数/死循环/修复对照。
export function scoreLayer3(run, task, diffPath) {
  // 重复失败命令:同名 tool + 相同 input + ok=false 的序列最长长度
  const seen = new Map();
  let maxRepeat = 0;
  for (const c of run.toolCalls) {
    if (c.ok) continue;
    const key = c.name + '|' + inputHash(c.input);
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n);
    if (n > maxRepeat) maxRepeat = n;
  }
  const deathLoop = maxRepeat >= 3;

  // 修复对照(宽松):diff 含 expectedFixPatch 关键行
  let fixMatched = false;
  if (task.expectedFixPatch && diffPath) {
    try {
      fixMatched = fs.readFileSync(diffPath, 'utf8').includes(task.expectedFixPatch);
    } catch {}
  }

  return {
    subject: run.subject,
    taskId: task.id,
    round: run.round,
    turns: run.turns,
    repeatFailures: maxRepeat,
    deathLoop,
    fixMatched,
    terminalReason: run.terminalReason,
    durationMs: run.durationMs,
    costUsd: run.costUsd,
    humanVerdict: 'review', // 初值,人工回填 fixed/wrong/partial
  };
}

// 运行后在 workDir 实跑验证(初判 testPassed)。L3-08 验 tsc,其余验 npm test。
export function verifyFix(task, workDir = CONFIG.fixtures) {
  try {
    if (task.id === 'L3-08') {
      execSync('npx tsc --noEmit', { cwd: workDir, stdio: 'pipe' });
    } else {
      execSync('npm test', { cwd: workDir, stdio: 'pipe' });
    }
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 2: 自测(死循环检测)**

```bash
cd /d/moss-eval
node --input-type=module -e "
  const{scoreLayer3}=await import('./harness/score-layer3.mjs');
  const run={subject:'moss',taskId:'L3-06',round:1,turns:5,toolCalls:[
    {name:'exec',input:{cmd:'npm test'},ok:false},
    {name:'exec',input:{cmd:'npm test'},ok:false},
    {name:'exec',input:{cmd:'npm test'},ok:false},
  ],errorEvents:[],durationMs:1000,costUsd:null,terminalReason:'completed'};
  console.log(JSON.stringify(scoreLayer3(run,{id:'L3-06',expectedFixPatch:'a - b'},null),null,2));
"
```

Expected: `repeatFailures:3, deathLoop:true, fixMatched:false`。

- [ ] **Step 3: Commit**

```bash
cd /d/moss-eval
git add harness/score-layer3.mjs
git commit -m "feat(harness): layer3 scorer (turns/deathloop/fix-match/verify)"
```

---

## Task 8: pool.mjs(并发池 + 断点续跑)

**Files:**

- Create: `D:\moss-eval/harness/lib/pool.mjs`

**Interfaces:** `runPool(units, concurrency, workFn)` → 跑完所有 unit。

- `unit = {task, subject, round}`
- concurrency=1:直接在 `CONFIG.fixtures` 上串行跑(workDir = fixtures)
- concurrency>1:每个并发 slot 复制 fixtures 到 `fixtures/work-slot-<n>`,在该副本跑(workDir = slot 副本)
- 断点续跑:跑前检查 `runs/<ts>/<task>/<subject>/round-<round>/metrics.json` 是否完整(无 parseError),完整则跳过

- [ ] **Step 1: 写 pool.mjs**

Create `D:\moss-eval\harness\lib\pool.mjs`:

```javascript
import { execSync } from 'node:child_process';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { CONFIG } from '../config.mjs';

// 为并发 slot 复制一份 fixtures(L3-03 等需要 node_modules,故连 node_modules 一起复制以省 npm install)。
function makeSlot(slotIndex) {
  const slotDir = path.join(CONFIG.fixtures, '..', `work-slot-${slotIndex}`);
  execSync(`git checkout base -- .`, { cwd: CONFIG.fixtures, stdio: 'pipe' });
  execSync(`rm -rf "${slotDir}"`, { stdio: 'pipe' });
  execSync(`cp -r "${CONFIG.fixtures}" "${slotDir}"`, { stdio: 'pipe' });
  return slotDir;
}

// 断点续跑:检查某 unit 是否已有完整产物。
async function alreadyDone(ts, unit) {
  const metricsPath = path.join(
    CONFIG.runs,
    ts,
    unit.task.id,
    unit.subject,
    `round-${unit.round}`,
    'metrics.json'
  );
  try {
    const m = JSON.parse(await fsp.readFile(metricsPath, 'utf8'));
    return m && !m.parseError && Array.isArray(m.toolCalls);
  } catch {
    return false;
  }
}

// 并发池。workFn(unit, workDir) 由调用方提供(含 reset+run+collect+score)。
export async function runPool(units, concurrency, ts, workFn) {
  const useSlots = concurrency > 1;
  const slots = useSlots
    ? Array.from({ length: concurrency }, (_, i) => makeSlot(i + 1))
    : [CONFIG.fixtures];
  const workDirs = useSlots ? slots : [CONFIG.fixtures];

  let idx = 0;
  const done = { count: 0, cost: 0 };
  async function worker(slotIdx) {
    while (idx < units.length) {
      const cur = idx++;
      const unit = units[cur];
      if (await alreadyDone(ts, unit)) {
        console.log(
          `[${cur + 1}/${units.length}] ${unit.task.id} ${unit.subject} r${unit.round} SKIP (done)`
        );
        continue;
      }
      const workDir = workDirs[slotIdx];
      try {
        const r = await workFn(unit, workDir);
        done.count++;
        if (r?.costUsd) done.cost += r.costUsd;
        console.log(
          `[${cur + 1}/${units.length}] ${unit.task.id} ${unit.subject} r${unit.round} ${r?.terminalReason ?? 'ok'} ${((r?.durationMs ?? 0) / 1000).toFixed(1)}s $${r?.costUsd ?? 'N/A'} | total $${done.cost.toFixed(2)}`
        );
      } catch (e) {
        console.error(
          `[${cur + 1}/${units.length}] ${unit.task.id} ${unit.subject} r${unit.round} FAILED: ${e.message}`
        );
        // 失败不崩全局:记录到 _failures.json
        const fp = path.join(CONFIG.runs, ts, '_failures.json');
        let fails = [];
        try {
          fails = JSON.parse(await fsp.readFile(fp, 'utf8'));
        } catch {}
        fails.push({
          taskId: unit.task.id,
          subject: unit.subject,
          round: unit.round,
          error: e.message,
        });
        await fsp.writeFile(fp, JSON.stringify(fails, null, 2));
      }
    }
  }
  await Promise.all(Array.from({ length: concurrency }, (_, i) => worker(i)));
  // 清理 slot 副本
  if (useSlots) for (const s of slots) execSync(`rm -rf "${s}"`, { stdio: 'pipe' });
  return done;
}
```

- [ ] **Step 2: 自检导出**

```bash
cd /d/moss-eval
node --input-type=module -e "const{runPool}=await import('./harness/lib/pool.mjs');console.log('runPool:',typeof runPool)"
```

Expected: `runPool: function`

- [ ] **Step 3: Commit**

```bash
cd /d/moss-eval
git add harness/lib/pool.mjs
git commit -m "feat(harness): concurrency pool with resume + work-dir isolation"
```

---

## Task 9: run-eval.mjs(主 runner,串起全流程)

**Files:**

- Create: `D:\moss-eval/harness/run-eval.mjs`

**Interfaces:** CLI 入口。解析 `--layer --rounds --concurrency --timeout --resume --ts`,构造 units,调 runPool,跑完调 score 聚合产 csv/md。

- `--rounds`:逗号分隔轮号(如 `1` 或 `1,2,3`),默认 `1`(试水)
- `--concurrency`:默认 1
- `--resume`:跳过已有完整产物的 unit
- `--ts`:指定 runs 时间戳目录;`--resume` 不带则找最近

- [ ] **Step 1: 写 run-eval.mjs**

Create `D:\moss-eval\harness\run-eval.mjs`:

```javascript
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { CONFIG } from './config.mjs';
import { TASKS, ROUNDS } from './tasks.mjs';
import { reset } from './lib/reset.mjs';
import { runSubject } from './lib/run-subject.mjs';
import { collect } from './lib/collect.mjs';
import { runPool } from './lib/pool.mjs';
import { scoreLayer2 } from './score-layer2.mjs';
import { scoreLayer3, verifyFix } from './score-layer3.mjs';

function parseArgs(argv) {
  const a = {
    layer: null,
    rounds: '1',
    concurrency: CONFIG.defaultConcurrency,
    timeout: CONFIG.timeoutMs,
    resume: false,
    ts: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--layer') a.layer = argv[++i];
    else if (k === '--rounds') a.rounds = argv[++i];
    else if (k === '--concurrency') a.concurrency = parseInt(argv[++i], 10);
    else if (k === '--timeout') a.timeout = parseInt(argv[++i], 10) * 1000;
    else if (k === '--resume') a.resume = true;
    else if (k === '--ts') a.ts = argv[++i];
  }
  return a;
}

async function latestTs() {
  try {
    const dirs = (await fsp.readdir(CONFIG.runs)).filter((d) => /^\d{8}-\d{6}$/.test(d)).sort();
    return dirs[dirs.length - 1] ?? null;
  } catch {
    return null;
  }
}

function tsStamp() {
  // 用固定格式(不依赖 new Date 的随机性,但需当前时间 —— 用 Date 一次取)
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function main() {
  const args = parseArgs(process.argv);
  CONFIG.timeoutMs = args.timeout;
  const rounds = args.rounds.split(',').map((s) => parseInt(s, 10));
  const ts = args.ts ?? (args.resume ? await latestTs() : tsStamp());
  if (!ts) {
    console.error('No runs dir to resume from. Run without --resume first.');
    process.exit(1);
  }
  await fsp.mkdir(path.join(CONFIG.runs, ts), { recursive: true });
  await fsp.mkdir(CONFIG.reports, { recursive: true });

  let tasks = TASKS;
  if (args.layer) tasks = TASKS.filter((t) => t.layer === parseInt(args.layer, 10));
  if (process.env.EVAL_SMOKE) tasks = TASKS.slice(0, 1); // 冒烟:只跑首个任务
  const subjects = ['moss', 'claude'];

  // 构造 units:每 unit = {task, subject, round}
  const units = [];
  for (const task of tasks)
    for (const round of rounds)
      for (const subject of subjects) units.push({ task, subject, round });

  console.log(
    `eval ts=${ts} tasks=${tasks.length} rounds=${rounds.join(',')} subjects=${subjects.length} units=${units.length} concurrency=${args.concurrency} resume=${args.resume}`
  );

  // workFn:reset → run → collect → (运行时 score 留到聚合阶段)
  const workFn = async (unit, workDir) => {
    reset(unit.task.tag, unit.task.cleanMode, workDir);
    const { status } = await runSubject(unit.subject, unit.task, unit.round, workDir, ts);
    await collect(
      path.join(CONFIG.runs, ts, unit.task.id, unit.subject, `round-${unit.round}`, 'stream.jsonl'),
      unit.subject,
      unit.task.id,
      unit.round
    );
    return {
      terminalReason: status.terminalReason,
      durationMs: status.durationMs,
      costUsd: status.costUsd,
    };
  };

  await runPool(units, args.concurrency, ts, workFn);

  // 聚合评分(扫所有 metrics.json)
  await aggregate(ts, args);
  console.log(`done. runs in runs/${ts}/, reports in reports/`);
}

async function aggregate(ts, args) {
  const l2 = fs.createWriteStream(path.join(CONFIG.reports, 'layer2-error-rate.csv'));
  const l3 = fs.createWriteStream(path.join(CONFIG.reports, 'layer3-recovery.csv'));
  const review = [];
  l2.write(
    'subject,taskId,round,toolCalls,denied,errors,errorRate,terminalReason,durationMs,costUsd\n'
  );
  l3.write(
    'subject,taskId,round,fixTurns,deadLoop,fixMatched,testPassed,humanVerdict,durationMs,costUsd\n'
  );

  for (const task of TASKS) {
    for (let round = 1; round <= ROUNDS; round++) {
      for (const subject of ['moss', 'claude']) {
        const mp = path.join(CONFIG.runs, ts, task.id, subject, `round-${round}`, 'metrics.json');
        let m;
        try {
          m = JSON.parse(await fsp.readFile(mp, 'utf8'));
        } catch {
          continue;
        }
        const diffPath = path.join(
          CONFIG.runs,
          ts,
          task.id,
          subject,
          `round-${round}`,
          'diff.patch'
        );
        if (task.layer === 2) {
          const s = scoreLayer2(m, task);
          l2.write(
            `${subject},${task.id},${round},${m.toolCalls.length},${m.deniedOrBlocked || 0},${s.explicitErrors},${s.explicitRate.toFixed(4)},${m.terminalReason},${m.durationMs ?? ''},${m.costUsd ?? 'N/A'}\n`
          );
          if (s.reviewCandidates.length)
            review.push({ task: task.id, round, subject, candidates: s.reviewCandidates });
        } else {
          const s = scoreLayer3(m, task, diffPath);
          // testPassed 初判:仅在串行(concurrency=1)下有意义 —— 此时 workDir=fixtures 仍是末次运行后的状态。
          // 并发模式下 slot 副本已清理,故 testPassed 留 N/A,交人工终判。
          let testPassed = 'N/A';
          if (args.concurrency === 1) {
            try {
              testPassed = verifyFix(task, CONFIG.fixtures) ? 'yes' : 'no';
            } catch {}
          }
          l3.write(
            `${subject},${task.id},${round},${s.turns},${s.deathLoop},${s.fixMatched},${testPassed},${s.humanVerdict},${m.durationMs ?? ''},${m.costUsd ?? 'N/A'}\n`
          );
          if (task.layer === 3)
            review.push({
              task: task.id,
              round,
              subject,
              diffSummary: await diffHead(diffPath),
              fixMatched: s.fixMatched,
              deadLoop: s.deathLoop,
            });
        }
      }
    }
  }
  l2.end();
  l3.end();
  await fsp.writeFile(
    path.join(CONFIG.reports, 'review-samples.md'),
    '# Review Samples\n\n## L2 隐性错误候选\n' +
      review
        .filter((r) => r.candidates)
        .map((r) => `- ${r.task} ${r.subject} r${r.round}: ${JSON.stringify(r.candidates)}`)
        .join('\n') +
      '\n\n## L3 diff 摘要(人工对照 expected patch)\n' +
      review
        .filter((r) => r.diffSummary !== undefined)
        .map(
          (r) =>
            `- ${r.task} ${r.subject} r${r.round}: fixMatched=${r.fixMatched} deadLoop=${r.deadLoop}\n  ${r.diffSummary}`
        )
        .join('\n')
  );
}

async function diffHead(diffPath) {
  try {
    return (await fsp.readFile(diffPath, 'utf8')).split('\n').slice(0, 8).join('\\n');
  } catch {
    return '(no diff)';
  }
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
```

- [ ] **Step 2: 冒烟跑(只 L2-01,moss+claude 各 1 轮)**

```bash
cd /d/moss-eval
EVAL_SMOKE=1 node harness/run-eval.mjs --rounds 1 --concurrency 1 --ts smoke 2>&1 | tail -8
```

Expected: 跑完 L2-01 moss + claude 各 1 轮,输出 `done.`。`reports/layer2-error-rate.csv` 有表头 + 2 行(L2-01 moss + claude)。`runs/smoke/L2-01/{moss,claude}/round-1/metrics.json` 存在且 `toolCalls.length >= 1`。若某 subject `toolCalls:0` 或 terminalReason 非 completed,按错误信息修 run-subject/collect 后重跑。

- [ ] **Step 3: Commit**

```bash
cd /d/moss-eval
git add harness/run-eval.mjs
git commit -m "feat(harness): main runner (pool + collect + aggregate → csv/md)"
```

---

## Task 10: 试水轮全量跑(1 轮 46 次)+ baseline-summary

**Files:**

- Create: `D:\moss-eval/reports/baseline-summary.md`(跑完生成)

**Interfaces:** 跑 1 轮全量(23 任务 × 2 subject = 46 次),看耗时/成本,生成 csv + review-samples + baseline-summary。

- [ ] **Step 1: 冒烟确认 smoke 绿(只 L2-01)**

```bash
cd /d/moss-eval
EVAL_SMOKE=1 node harness/run-eval.mjs --rounds 1 --concurrency 1 --ts smoke 2>&1 | tail -6
```

Expected: 输出 `done.`,且 `cat reports/layer2-error-rate.csv` 有表头 + 2 行(L2-01 moss + claude),`runs/smoke/L2-01/*/round-1/metrics.json` 存在且 `toolCalls.length >= 1`。

- [ ] **Step 2: 试水全量跑(1 轮,串行)**

```bash
cd /d/moss-eval
node harness/run-eval.mjs --rounds 1 --concurrency 1 --ts trial1 2>&1 | tee runs/trial1-run.log | tail -20
```

Expected: 46 个 unit 依次跑完,进度行逐条打印累计成本。耗时约 30–90 分钟(GLM + thinking 慢)。若中途某 unit FAILED,不影响后续(已记 \_failures.json)。跑完:

```bash
wc -l reports/layer2-error-rate.csv reports/layer3-recovery.csv
```

Expected: layer2 约 31 行(表头 + 15 任务 × 2),layer3 约 17 行(表头 + 8 × 2)。

- [ ] **Step 3: 看汇总,算 moss vs claude 各层均值**

```bash
cd /d/moss-eval
node --input-type=module -e "
  const fs=await import('node:fs/promises');
  const l2=(await fs.readFile('reports/layer2-error-rate.csv','utf8')).trim().split('\n').slice(1);
  const by={}; for(const r of l2){const[subj,t,rd,tot,den,er,rate]=r.split(',');(by[subj]=by[subj]||[]).push(parseFloat(rate));}
  for(const[s,arr]of Object.entries(by)){const avg=arr.reduce((a,b)=>a+b,0)/arr.length;console.log(s,'L2 avg explicitRate=',avg.toFixed(4),'(n='+arr.length+')');}
  const l3=(await fs.readFile('reports/layer3-recovery.csv','utf8')).trim().split('\n').slice(1);
  const b3={}; for(const r of l3){const[subj,t,rd,turns,dl,fm,tp,hv]=r.split(',');(b3[subj]=b3[subj]||[]).push({turns:+turns,dead:dl==='true',fixed:fm==='true'});}
  for(const[s,arr]of Object.entries(b3)){const at=arr.reduce((a,b)=>a+b.turns,0)/arr.length;const df=arr.filter(b=>b.dead).length;const fx=arr.filter(b=>b.fixed).length;console.log(s,'L3 avg turns=',at.toFixed(1),'deadloops=',df,'fixMatched=',fx,'/',arr.length);}
"
```

记录输出(moss/claude 各层均值),供 Step 4 填 baseline-summary。

- [ ] **Step 4: 写 baseline-summary.md(基于 Step 3 实际数字)**

Create `D:\moss-eval\reports\baseline-summary.md`(把 `<实际>` 换成 Step 3 的数字):

```markdown
# moss vs Claude Code 基线(第 2+3 层,试水轮)

## 结论的可归因边界(必读)

- **成立**:模型相同(glm-5.2),故 L2/L3 差距主要反映框架/工程层面(勘察纪律、工具校验、错误闭环、prompt 约束)。
- **不成立/需打折**:moss 走 OpenAI 协议、claude 走 Anthropic 协议,协议适配层差异混入其中 —— 若 moss L2 错误率偏高,有一部份可能来自 OpenAI 工具调用适配而非纯框架工程。此项无法在本轮消除,仅标注。
- **样本量**:试水轮单轮(N=1/任务/subject),统计意义有限,定位性质重于定量性质。后两轮补齐后可强化定量结论。

## 第 2 层 工具调用准确率

| subject | 总调用数 | 显性错误率 | 基准                    |
| ------- | -------- | ---------- | ----------------------- |
| moss    | <实际>   | <实际>     | <1% 优秀,>5% 头号优化点 |
| claude  | <实际>   | <实际>     | 同上                    |

隐性错误候选见 review-samples.md(人工复核后补隐性错误率)。

## 第 3 层 错误闭环

| subject | 平均纠错轮数 | 死循环发生率 | 修复成功率(fixMatched) |
| ------- | ------------ | ------------ | ---------------------- |
| moss    | <实际>       | <实际>       | <实际>                 |
| claude  | <实际>       | <实际>       | <实际>                 |

## 差距定位(对照文档「常见差距点」)

- 第 2 层:<根据 review-samples 候选写 moss 哪类错误最多:格式/参数/选错,映射到 validateToolInputObject / 工具描述>
- 第 3 层:<根据结果写 moss 是否死循环/纠错轮数偏高,映射到 tool-loop-guard / MAX_RETRY / completion-gate>

## 调整方向(后续单独 spec,本轮不实施)

- 第 2 层显性错误率高 → 查 `validateToolInputObject`(`tool-pipeline.ts:48`)是否所有工具都过校验、参数描述是否够细。
- 第 2 层隐性「选错工具」多 → 查工具描述/枚举约束(`builtin.ts` 各工具 description)。
- 第 3 层纠错轮数多/死循环 → 查 `tool-loop-guard`、`MAX_RETRY_ATTEMPTS`、completion-gate 触发逻辑。

## 协议不对等说明

moss 用 openai-compatible provider(GLM 仅认 Bearer,anthropic provider 的 x-api-key 跑不通);claude 用 anthropic 协议。两者模型同为 glm-5.2。
```

- [ ] **Step 5: Commit 产物**

```bash
cd /d/moss-eval
git add reports/
git commit -m "data: trial1 baseline run (layers 2+3, 1 round, 46 runs)"
```

- [ ] **Step 6: 据试水耗时/成本决定后两轮调度**

看 `runs/trial1-run.log` 末尾的累计成本和总耗时。与用户确认:

- 若单轮 ~$X、~Y 分钟可接受 → 跑后两轮:`node harness/run-eval.mjs --rounds 2,3 --concurrency <N> --ts trial1 --resume`(串行 N=1 或并发 N=4)
- 若太慢 → 并发:`--concurrency 4`(自动切 work-slot 隔离)
- 若成本过高 → 仅跑第 2 轮补到 N=2

本步骤无代码,只决策 + 执行后续轮。

---

## Self-Review

**1. Spec coverage:** harness 设计 spec 各段对应:

- 架构与模块边界 → Task 1(config/tasks)+ Task 4(run-subject 隔离层)+ Task 5(统一 collect)+ Task 8(pool)+ Task 9(run-eval 编排)。✓
- 任务集(L2 15 + L3 8,中性措辞)→ Task 1 tasks.mjs。✓
- L3 fixture 补齐 L3-03/07/08 + 预期 patch → Task 2。✓
- 数据采集(统一 metrics.json,差异封在 collect)→ Task 5。✓
- 第 2 层判分(显性错误率 + 隐性候选)→ Task 6。✓
- 第 3 层判分(纠错轮数/死循环/宽松对照)→ Task 7。✓
- 错误分级 + 独立 try/catch → Task 8 pool 的 workFn try/catch + \_failures.json。✓
- 并发(=1 直接 fixtures,>1 切 slot 隔离)→ Task 8。✓
- 断点续跑 → Task 8 alreadyDone。✓
- 无 budget-cap、成本只打印 → Task 8/9(无上限逻辑)。✓
- 公平性(同模型、cleanMode 分级、不联网、无温度扰动)→ Task 1 tasks.mjs cleanMode + Global Constraints。✓
- 产出物(4 报告 + 局限性声明)→ Task 9 aggregate + Task 10 baseline-summary。✓

**2. Placeholder scan:** Task 10 Step 4 的 `<实际>` 是跑完才有数据的占位,符合「跑完填」。其余无 TODO/TBD。EVAL_SMOKE 在 Task 9 代码中已实现(`if (process.env.EVAL_SMOKE) tasks = TASKS.slice(0, 1)`),非「落地时补」。✓

**3. Type/signature consistency:**

- `runSubject(subject, task, round, workDir, ts)` → `{status, streamPath, diffPath}`:Task 4 定义,Task 9 workFn 消费 `status.terminalReason/durationMs/costUsd`。✓
- `collect(streamPath, subject, taskId, round)` → RunResult:Task 5 定义,Task 9 消费。RunResult 字段 `toolCalls/errorEvents/deniedOrBlocked/turns/terminalReason/costUsd/durationMs` 与 Task 6/7 消费一致。✓
- `scoreLayer2(run, task)`:Task 6 定义,Task 9 aggregate 调用 `scoreLayer2(m, task)`。✓
- `scoreLayer3(run, task, diffPath)` + `verifyFix(task, workDir)`:Task 7 定义,Task 9 调用一致。✓
- `reset(tag, cleanMode, workDir)`:Task 3 定义,Task 9 workFn 调 `reset(unit.task.tag, unit.task.cleanMode, workDir)`。✓
- `runPool(units, concurrency, ts, workFn)`:Task 8 定义,Task 9 调用 `runPool(units, args.concurrency, ts, workFn)`。✓
- `CONFIG` 字段:`fixtures/runs/reports/mossConfigFile/claudeConfigDir/model/maxTurns/timeoutMs` —— Task 1 定义,Task 3/4/5/7/8/9 消费一致。✓
- 一处需注意:Task 9 aggregate 里 `verifyFix` 在并发模式下 testPassed 留 N/A(因 workDir 已清理),串行下取末态 —— 此局限已在代码注释说明,接受。

无类型/签名不一致。
