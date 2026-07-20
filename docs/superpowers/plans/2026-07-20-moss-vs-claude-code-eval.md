# Moss vs Claude Code 对照评估 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在同一台机、同一 Claude 模型上,headless 对比 moss 与 Claude Code 在第 2 层(工具准确率)与第 3 层(错误闭环)的表现,产出量化基线 + 差距定位。

**Architecture:** 独立 eval 工作区 `D:\moss-eval`,含 fixtures(带 bug 的小 TS 库,每任务一个 git tag)、harness(半自动 runner:重置→跑两边→采埋点→自动算第2层显性错误率→标人工复核候选)、reports(对照表)。moss 用 `MOSS_CONFIG_DIR` 隔离配置,不污染真实 moss 装机;claude 用 `ANTHROPIC_API_KEY`。

**Tech Stack:** Node.js 22、moss CLI(已 link 全局)、claude CLI v2.1.204、git(任务重置)、JSONL/JSON 解析。

**Spec:** `docs/superpowers/specs/2026-07-20-moss-vs-claude-code-eval-design.md`

## Global Constraints

- moss 与 claude 必须用**同一个 Claude 模型**(同 `--model`)、同一个 Anthropic API key。
- moss 配置隔离:eval 用独立 `MOSS_CONFIG_DIR`,绝不碰用户真实的 `~/.config/moss`(它服务于 RDK Studio)。
- 每轮跑前必须 `git checkout <task-tag> -- && git clean -fdx` 重置 fixtures。
- 不联网:任务限制在 fixtures 内,web 工具任务不纳入。
- 显性错误率分母只算 `outcome_kind==='completed'` 的工具调用(`denied`/`pre-blocked`/`hook-blocked`/`unknown-tool` 不计入)。
- 预算上限:约 138 次 agent 运行;如单次超过 `--max-budget-usd`(claude)或明显卡住,中止该轮。
- 每 Task 结尾 commit。全程在 `D:\moss-eval`(独立 git 仓,非 moss 仓)。

---

## File Structure

`D:\moss-eval/`(独立 git 仓)
- `harness/run-eval.mjs` — 主 runner:读任务→重置→跑 moss→采产物→重置→跑 claude→采产物→调 score
- `harness/tasks.mjs` — 任务定义数组(15 + 8,每任务含 id/prompt/tag/layer/expectedFixPatch)
- `harness/collect-artifacts.mjs` — 解析 moss `traces.jsonl` 与 claude `stream-json`,产出统一 `{calls:[{tool,isError,outcomeKind,args}],turns,retries}` 结构
- `harness/score-layer2.mjs` — 第2层:显性错误率 + 隐性错误候选启发式
- `harness/score-layer3.mjs` — 第3层:纠错轮数/重复失败命令/对照 expectedFixPatch
- `harness/lib/run-moss.mjs` / `run-claude.mjs` — 封装两边 headless 调用 + 超时
- `harness/lib/reset.mjs` — fixtures 重置
- `fixtures/sample-lib/` — 被测 TS 库(本计划逐文件构造)
- `reports/layer2-error-rate.csv` / `layer3-recovery.csv` / `review-samples.md` / `baseline-summary.md` — 产出物

---

## Task 0: 搭 eval 工作区骨架 + 确认两 CLI 可调

**Files:**
- Create: `D:\moss-eval/.gitignore`, `D:\moss-eval/harness/`(空目录占位), `D:\moss-evel/README.md`
- Test: 手动跑两条命令确认可调

**Interfaces:** Produces 工作区根目录 + 确认 `moss`/`claude` 在 PATH。

- [ ] **Step 1: 建目录 + git init**

```bash
mkdir -p /d/moss-eval/harness/lib /d/moss-eval/fixtures /d/moss-eval/reports /d/moss-eval/runs
cd /d/moss-eval
git init
printf 'node_modules/\nruns/\n.moss/\n*.log\n' > .gitignore
```

- [ ] **Step 2: 写 README**

Create `D:\moss-eval\README.md`:
```markdown
# moss-eval
moss vs Claude Code 对照评估(第2+3层)。详见 ../moss-drobotics/docs/superpowers/specs/2026-07-20-moss-vs-claude-code-eval-design.md
```

- [ ] **Step 3: 确认两 CLI 可调 + 收集 Anthropic key 占位**

```bash
moss --version      # 期望: 1.3.0 或类似
claude --version    # 期望: 2.1.204
```
记录:`ANTHROPIC_API_KEY` 当前未设(后续 Task 1 会要用户提供)。

- [ ] **Step 4: Commit**

```bash
cd /d/moss-eval
git add -A
git commit -m "chore: scaffold moss-eval workspace"
```

---

## Task 1: 配 moss 用 Claude 模型(隔离配置)

**Files:**
- Create: `D:\moss-eval/harness/moss-config/config.json`
- Test: `moss --config-dir <eval配置目录> --version` + 一次最小 print 跑通

**Interfaces:** Produces 一个隔离的 moss 配置目录,provider=anthropic、model=与 claude 同。后续 `run-moss.mjs` 用 `MOSS_CONFIG_DIR=<eval配置目录>` 调 moss。

**关键事实(来自探索):** moss config 目录由 `MOSS_CONFIG_DIR` 决定(`packages/moss-agent/src/cli/config.ts:38`)。apiKey 在配置里加密存(deriveEncryptionKey)。最稳的非交互方式:直接写一份 `config.json`(provider/model/baseUrl),apiKey 用 `moss setup` 交互写一次到隔离目录,之后 eval 复用。

- [ ] **Step 1: 用户提供 Anthropic API key + 选定 Claude 模型**

向用户索取:`ANTHROPIC_API_KEY=sk-ant-...` 和要用的模型别名(如 `claude-sonnet-5`/`claude-opus-4-8`)。**这个 key 两边(moss/claude)共用,保证同模型对照。**

- [ ] **Step 2: 建隔离配置目录 + 写 config.json**

```bash
mkdir -p /d/moss-eval/harness/moss-config
```
Create `D:\moss-eval\harness\moss-config\config.json`(模型名用 Step1 的值):
```json
{
  "provider": "anthropic",
  "model": "<Step1 的模型别名>",
  "baseUrl": "https://api.anthropic.com",
  "safetyMode": "full-access",
  "approvalPolicy": "never"
}
```
> `safetyMode: full-access` + `approvalPolicy: never` 让 headless 跑不需要审批打断(对照公平:claude `-p` 也是自动执行)。

- [ ] **Step 3: 把 apiKey 写进隔离配置(交互一次)**

```bash
cd /d/moss-eval
MOSS_CONFIG_DIR=/d/moss-eval/harness/moss-config moss setup
```
在交互里选 anthropic、粘 Step1 的 key。完成后 `moss-config/` 下生成加密 key 文件。

- [ ] **Step 4: 验证 moss 能用 Claude 跑一次最小 print**

```bash
cd /d/moss-eval
MOSS_CONFIG_DIR=/d/moss-eval/harness/moss-config moss -p "reply with exactly: OK" --max-turns 2
```
Expected: 输出含 `OK`,且 stderr 提示 `anthropic` provider 生效。若报 401 → key/模型名问题,回 Step1。

- [ ] **Step 5: Commit**

```bash
cd /d/moss-eval
git add harness/moss-config/config.json   # 不 add 加密 key 文件(已 gitignore 忽略 ~/.config? 这里手动 ignore)
printf 'harness/moss-config/.apikey-key\nharness/moss-config/*.bak\n' >> .gitignore
git add -A
git commit -m "chore: isolated moss config pointing at Claude"
```

---

## Task 2: 建 fixtures sample-lib(干净基底 + git tag)

**Files:**
- Create: `D:\moss-eval/fixtures/sample-lib/package.json`,`tsconfig.json`,`src/*.ts`,`test/*.test.ts`

**Interfaces:** Produces 一个能 `npm test`/`tsc --noEmit` 的 TS 小库;干净状态打 tag `base`,后续 Task 在其上埋 bug 打各 `L3-*` tag、各 `L2-*` 用 `base`。

- [ ] **Step 1: package.json + tsconfig + 一个工具模块**

Create `D:\moss-eval\fixtures\sample-lib\package.json`:
```json
{
  "name": "sample-lib",
  "version": "1.2.7",
  "type": "module",
  "scripts": { "test": "node --test --test-reporter=spec test/", "tsc": "tsc --noEmit" },
  "devDependencies": { "typescript": "^5.7.3" }
}
```
Create `D:\moss-eval\fixtures\sample-lib\tsconfig.json`:
```json
{ "compilerOptions": { "target": "ES2022", "module": "ESNext", "moduleResolution": "Bundler", "strict": true, "esModuleInterop": true, "outDir": "dist" }, "include": ["src"] }
```
Create `D:\moss-eval\fixtures\sample-lib\src\calc.ts`:
```typescript
export function add(a: number, b: number): number { return a + b; }
export function divide(a: number, b: number): number { return a / b; }
export function deprecatedFn(): string { return 'old'; }
```

- [ ] **Step 2: format 模块(供 L2-07/L2-09 用)**

Create `D:\moss-eval\fixtures\sample-lib\src\format.ts`:
```typescript
export function fmtDate(d: Date): string { return d.toLocaleDateString(); }
export function camelCase(input: string): string { return input.replace(/_([a-z])/g, (_, c) => c.toUpperCase()); }
```

- [ ] **Step 3: 测试(干净状态全过)**

Create `D:\moss-eval\fixtures\sample-lib\test\calc.test.ts`:
```typescript
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { add, divide } from '../src/calc.ts';
test('add', () => assert.equal(add(2, 3), 5));
test('divide', () => assert.equal(divide(10, 2), 5));
```
Create `D:\moss-eval\fixtures\sample-lib\test\format.test.ts`:
```typescript
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fmtDate } from '../src/format.ts';
test('fmtDate', () => assert.ok(fmtDate(new Date('2026-01-01')).length > 0));
```

- [ ] **Step 4: 装依赖 + 跑测试确认干净基底绿**

```bash
cd /d/moss-eval/fixtures/sample-lib
npm install
npm test    # 期望全过
npx tsc --noEmit   # 期望 0 error
```

- [ ] **Step 5: 打 base tag + commit**

```bash
cd /d/moss-eval
git add fixtures/sample-lib
git commit -m "feat(fixtures): sample-lib clean baseline"
cd fixtures/sample-lib && git tag base && cd ../..
```

- [ ] **Step 6: (验证步骤,可一起跑)再次确认 base 可重置**

```bash
cd /d/moss-eval/fixtures/sample-lib
# 模拟重置
git checkout base -- . && git clean -fdx -e node_modules
npm test   # 仍全过
```

---

## Task 3: 在 base 上埋 L3 bug + 打各 tag

**Files:**
- Modify(在 base 副本上): `fixtures/sample-lib/*` 各埋一个 bug,每个打一个 tag

**Interfaces:** Produces tags `L3-01`..`L3-08`,每个对应一个可重置的"含 bug 初始态"。每个 tag 的"预期修复 patch"记到 `harness/tasks.mjs`(Task 4)的 `expectedFixPatch`。

- [ ] **Step 1: L3-01 语法错(括号没闭合)**

```bash
cd /d/moss-eval/fixtures/sample-lib
git checkout base -- . && git clean -fdx -e node_modules
```
改 `src/calc.ts` 把 `divide` 行改成缺右括号:
```typescript
export function divide(a: number, b: number): number { return a / b;
```
```bash
git add -A && git commit -m "bug(L3-01): unclosed paren" && git tag L3-01
```

- [ ] **Step 2: L3-02 divide 除零 + 测试断言抛错**

```bash
git checkout base -- . && git clean -fdx -e node_modules
```
`src/calc.ts` `divide` 不变(已会抛),但改 `test/calc.test.ts` 加:
```typescript
test('divide by zero throws', () => assert.throws(() => divide(1, 0)));
```
(预期:agent 要在 `divide` 里加 `if (b===0) throw new RangeError('divide by zero')`)
```bash
git add -A && git commit -m "bug(L3-02): divide zero not handled" && git tag L3-02
```

- [ ] **Step 3: L3-03 缺依赖**

```bash
git checkout base -- . && git clean -fdx -e node_modules
```
在 `src/format.ts` 顶部加 `import _ from 'lodash-es';`(项目没装),并用到一处。
```bash
git add -A && git commit -m "bug(L3-03): missing dependency lodash-es" && git tag L3-03
```

- [ ] **Step 4: L3-04 import 路径大小写错**

```bash
git checkout base -- . && git clean -fdx -e node_modules
```
在 `test/calc.test.ts` 把 `from '../src/calc.ts'` 改成 `from '../src/Calc.ts'`(大写 C,文件实际小写)。
```bash
git add -A && git commit -m "bug(L3-04): import path case mismatch" && git tag L3-04
```

- [ ] **Step 5: L3-05 类型注解错**

```bash
git checkout base -- . && git clean -fdx -e node_modules
```
`src/calc.ts` 把 `add(a: number, b: number)` 改成 `add(a: string, b: number)`(故意类型错,`tsc` 会报)。
```bash
git add -A && git commit -m "bug(L3-05): wrong type annotation" && git tag L3-05
```

- [ ] **Step 6: L3-06 逻辑 bug(排序比较器反向)**

```bash
git checkout base -- . && git clean -fdx -e node_modules
```
新建 `src/sort.ts`:
```typescript
export function sortAsc(arr: number[]): number[] { return [...arr].sort((a, b) => b - a); }
```
新建 `test/sort.test.ts`:
```typescript
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sortAsc } from '../src/sort.ts';
test('sortAsc asc', () => assert.deepEqual(sortAsc([3,1,2]), [1,2,3]));
```
(`tsc` 过、`npm test` 失败 → 难度中高:语法对、逻辑错)
```bash
git add -A && git commit -m "bug(L3-06): sort comparator reversed" && git tag L3-06
```

- [ ] **Step 7: L3-07 异步 bug(忘 await)**

```bash
git checkout base -- . && git clean -fdx -e node_modules
```
新建 `src/async.ts`:
```typescript
export async function fetchDouble(x: number): Promise<number> { return x * 2; }
export async function useIt(x: number): Promise<number> { fetchDouble(x); return 0; }
```
新建 `test/async.test.ts`:
```typescript
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { useIt } from '../src/async.ts';
test('useIt returns doubled', async () => { assert.equal(await useIt(3), 6); });
```
```bash
git add -A && git commit -m "bug(L3-07): missing await" && git tag L3-07
```

- [ ] **Step 8: L3-08 tsconfig target 太低**

```bash
git checkout base -- . && git clean -fdx -e node_modules
```
改 `tsconfig.json` `"target": "ES2022"` → `"target": "ES3"`;`src/calc.ts` 用 `??` 和箭头函数(ES3 不识别 → 编译报错)。
```bash
git add -A && git commit -m "bug(L3-08): tsconfig target too low" && git tag L3-08
```

- [ ] **Step 9: 验证每个 L3 tag 重置后状态可复现**

```bash
for t in L3-01 L3-02 L3-03 L3-04 L3-05 L3-06 L3-07 L3-08; do
  git checkout $t -- . && git clean -fdx -e node_modules
  echo "=== $t: tsc ==="; npx tsc --noEmit 2>&1 | head -1
done
git checkout base -- . && git clean -fdx -e node_modules
```
Expected: 每个 tag 都能 checkout、tsc 产出对应错误(或 L3-02/06/07 是测试失败而非 tsc 错)。

---

## Task 4: 任务定义 tasks.mjs

**Files:**
- Create: `D:\moss-eval/harness/tasks.mjs`

**Interfaces:** Produces `TASKS: EvalTask[]`,每项 `{id, layer, prompt, tag, expectedFixPatch?}`。被 `run-eval.mjs` 消费。

- [ ] **Step 1: 写 tasks.mjs**

Create `D:\moss-eval\harness\tasks.mjs`:
```javascript
// 15 个第2层任务 + 8 个第3层任务。prompt 是给 agent 的原话。
// tag = fixtures/sample-lib 的 git tag(L2-* 用 base,L3-* 各自的 bug tag)。
// expectedFixPatch = L3 任务"修复后应出现的 diff 关键行"(score-layer3 判是否真修对)。

export const TASKS = [
  // ── 第 2 层(工具准确率),15 个,tag=base ──
  { id: 'L2-01', layer: 2, tag: 'base', prompt: '找出这个项目里所有调用 deprecatedFn 的地方,列出文件和行号。' },
  { id: 'L2-02', layer: 2, tag: 'base', prompt: '找出 divide 函数定义在哪个文件的哪一行。' },
  { id: 'L2-03', layer: 2, tag: 'base', prompt: '列出 src 下被 import 次数最多的模块名。' },
  { id: 'L2-04', layer: 2, tag: 'base', prompt: '读取 src/calc.ts 里 divide 函数的实现,贴出来。' },
  { id: 'L2-05', layer: 2, tag: 'base', prompt: '读取 src/does-not-exist.ts 的内容。' },
  { id: 'L2-06', layer: 2, tag: 'base', prompt: '读取 node_modules/typescript 的 package.json 里的 version 字段。' },
  { id: 'L2-07', layer: 2, tag: 'base', prompt: '把 src/format.ts 里 fmtDate 函数改成返回 ISO 格式字符串(YYYY-MM-DD)。' },
  { id: 'L2-08', layer: 2, tag: 'base', prompt: '给 src/calc.ts 里的 add、divide、deprecatedFn 三个函数各加一句 JSDoc 注释。' },
  { id: 'L2-09', layer: 2, tag: 'base', prompt: '把 src/format.ts 里 camelCase 函数改名为 snake_case,并更新所有引用。' },
  { id: 'L2-10', layer: 2, tag: 'base', prompt: '跑测试,列出失败的测试名。如果没有失败,说明全部通过。' },
  { id: 'L2-11', layer: 2, tag: 'base', prompt: '跑 tsc 类型检查,列出所有类型错误。如果没有错误,说明类型干净。' },
  { id: 'L2-12', layer: 2, tag: 'base', prompt: '跑 src/calc.ts 里 add 函数对参数 2 和 3 的调用(用 node),打印结果。' },
  { id: 'L2-13', layer: 2, tag: 'base', prompt: '这个项目有没有安装 lodash?回答有或没有,并说明依据。' },
  { id: 'L2-14', layer: 2, tag: 'base', prompt: '这个库的版本号是多少?' },
  { id: 'L2-15', layer: 2, tag: 'base', prompt: '读取 src/calc.ts 的完整内容并原样贴出。' },

  // ── 第 3 层(错误闭环),8 个,各自 bug tag ──
  { id: 'L3-01', layer: 3, tag: 'L3-01', prompt: '让 npm test 通过。', expectedFixPatch: 'return a / b; }' },
  { id: 'L3-02', layer: 3, tag: 'L3-02', prompt: '修复 divide 函数的除零问题,让所有测试通过。', expectedFixPatch: "if (b === 0) throw new RangeError('divide by zero')" },
  { id: 'L3-03', layer: 3, tag: 'L3-03', prompt: '装好依赖让项目能 build(tsc --noEmit 通过)。', expectedFixPatch: '"lodash-es"' },
  { id: 'L3-04', layer: 3, tag: 'L3-04', prompt: '修掉导致 import 失败的路径错误,让测试通过。', expectedFixPatch: "'../src/calc.ts'" },
  { id: 'L3-05', layer: 3, tag: 'L3-05', prompt: '修掉 tsc 报的类型错误。', expectedFixPatch: 'add(a: number' },
  { id: 'L3-06', layer: 3, tag: 'L3-06', prompt: '修掉 sortAsc 的逻辑错误,让测试通过。', expectedFixPatch: 'a - b' },
  { id: 'L3-07', layer: 3, tag: 'L3-07', prompt: '修复 useIt,让它返回正确的值,让测试通过。', expectedFixPatch: 'await fetchDouble' },
  { id: 'L3-08', layer: 3, tag: 'L3-08', prompt: '修复让 tsc --noEmit 能通过的配置问题。', expectedFixPatch: '"target": "ES2022"' },
];

export const ROUNDS = 3; // 每任务跑 3 轮
```

- [ ] **Step 2: 自检 tasks 加载**

```bash
cd /d/moss-eval
node -e "import('./harness/tasks.mjs').then(m=>console.log('tasks:',m.TASKS.length,'rounds:',m.ROUNDS))"
```
Expected: `tasks: 23 rounds: 3`

- [ ] **Step 3: Commit**

```bash
git add harness/tasks.mjs && git commit -m "feat(harness): task definitions (15 layer2 + 8 layer3)"
```

---

## Task 5: reset + run-moss + run-claude 库

**Files:**
- Create: `D:\moss-eval/harness/lib/reset.mjs`, `run-moss.mjs`, `run-claude.mjs`

**Interfaces:**
- `reset(tag)`:在 `fixtures/sample-lib` 跑 `git checkout <tag> -- . && git clean -fdx -e node_modules`。
- `runMoss(task, round, opts)`:用 `MOSS_CONFIG_DIR` 调 `moss -p <prompt> --max-turns 30`,产物写到 `runs/<ts>/<task>/moss/round-<n>/`,返回 `{exitCode, tracesPath, transcriptPath, diffPath}`。
- `runClaude(task, round, opts)`:调 `claude -p <prompt> --model <M> --output-format stream-json --max-turns 30`,产物写到 `runs/<ts>/<task>/claude/round-<n>/`,返回 `{exitCode, streamJsonPath, diffPath}`。

- [ ] **Step 1: reset.mjs**

Create `D:\moss-eval\harness\lib\reset.mjs`:
```javascript
import { execSync } from 'node:child_process';
import path from 'node:path';
const FIX = path.resolve('fixtures/sample-lib');
export function reset(tag) {
  execSync(`git checkout ${tag} -- . && git clean -fdx -e node_modules -e dist`, { cwd: FIX, stdio: 'ignore' });
}
```

- [ ] **Step 2: run-moss.mjs**

Create `D:\moss-eval\harness\lib\run-moss.mjs`:
```javascript
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
const run = promisify(execFile);
const CONFIG_DIR = path.resolve('harness/moss-config');
const FIX = path.resolve('fixtures/sample-lib');
const MODEL = process.env.EVAL_MODEL || 'claude-sonnet-5';

export async function runMoss(task, round, ts) {
  const outDir = path.resolve(`runs/${ts}/${task.id}/moss/round-${round}`);
  await fs.mkdir(outDir, { recursive: true });
  // moss 把 traces 写到 cwd/.moss/analytics。所以 cwd=FIX,产物跑完搬走。
  const env = { ...process.env, MOSS_CONFIG_DIR: CONFIG_DIR, MOSS_OTEL_ENABLED: '0', MOSS_TRACE: '0' };
  let exitCode = 0;
  try {
    const { stdout } = await run('moss', ['-p', task.prompt, '--max-turns', '30', '--model', MODEL, '--print'],
      { cwd: FIX, env, maxBuffer: 50 * 1024 * 1024, timeout: 10 * 60 * 1000 });
    await fs.writeFile(path.join(outDir, 'transcript.md'), stdout);
  } catch (e) {
    exitCode = e.code ?? 1;
    await fs.writeFile(path.join(outDir, 'error.log'), String(e));
  }
  // 搬 traces
  const traces = path.join(FIX, '.moss', 'analytics', 'traces.jsonl');
  try { await fs.copyFile(traces, path.join(outDir, 'traces.jsonl')); } catch {}
  // diff
  const diff = execFileSync('git', ['diff'], { cwd: FIX });
  await fs.writeFile(path.join(outDir, 'diff.patch'), diff);
  return { exitCode, tracesPath: path.join(outDir, 'traces.jsonl'), transcriptPath: path.join(outDir, 'transcript.md'), diffPath: path.join(outDir, 'diff.patch') };
}
```
> 注意:`import { execFileSync }` 顶部要补;上面 diff 行用了 execFileSync,在文件头加 `import { execSync, execFileSync } from 'node:child_process'`。实现时统一用 promisify 的 execa 风格或补 import。这是计划,实现时修正导入一致性。

- [ ] **Step 3: run-claude.mjs**

Create `D:\moss-eval\harness\lib\run-claude.mjs`:
```javascript
import { spawn } from 'node:child_process';
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
const FIX = path.resolve('fixtures/sample-lib');
const MODEL = process.env.EVAL_MODEL || 'claude-sonnet-5';

export async function runClaude(task, round, ts) {
  const outDir = path.resolve(`runs/${ts}/${task.id}/claude/round-${round}`);
  await fs.mkdir(outDir, { recursive: true });
  const streamPath = path.join(outDir, 'stream.jsonl');
  const out = createWriteStream(streamPath);
  await new Promise((resolve) => {
    const p = spawn('claude', ['-p', task.prompt, '--model', MODEL, '--output-format', 'stream-json', '--max-turns', '30'],
      { cwd: FIX, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    p.stdout.pipe(out);
    p.stderr.pipe(createWriteStream(path.join(outDir, 'stderr.log')));
    p.on('close', (code) => resolve(code));
  });
  const diff = spawnSync('git', ['diff'], { cwd: FIX });  // 头部补 spawnSync import
  await fs.writeFile(path.join(outDir, 'diff.patch'), diff.stdout || '');
  return { streamJsonPath: streamPath, diffPath: path.join(outDir, 'diff.patch') };
}
```
> 同样,实现时把 `spawnSync` 补进头部 import。

- [ ] **Step 4: 冒烟测 — 各跑一个最小任务**

```bash
cd /d/moss-eval
node -e "import('./harness/lib/reset.mjs').then(m=>m.reset('base'))"
EVAL_MODEL=claude-sonnet-5 ANTHROPIC_API_KEY=<Step1的key> node -e "
  import('./harness/tasks.mjs').then(async t=>{
    const{runMoss}=await import('./harness/lib/run-moss.mjs');
    const r=await runMoss(t.TASKS[0],1,'smoke'); console.log('moss:',JSON.stringify(r));
  })
"
```
Expected: moss 产物目录生成、traces.jsonl(可能为空,因为 L2-01 可能没埋点触发——这是允许的,只要不报错)、diff.patch 存在。claude 同理单独测一次。

- [ ] **Step 5: Commit**

```bash
git add harness/lib && git commit -m "feat(harness): reset + run-moss + run-claude"
```

---

## Task 6: collect-artifacts(统一解析两边产物)

**Files:**
- Create: `D:\moss-eval/harness/collect-artifacts.mjs`

**Interfaces:** Produces `collectMoss(tracesPath)` → `{calls:[{tool, isError, outcomeKind, callId}], totalTurns}` 和 `collectClaude(streamJsonPath)` → 同构结构。被 score-layer2/3 消费。

- [ ] **Step 1: collectMoss — 解析 traces.jsonl**

Create `D:\moss-eval\harness\collect-artifacts.mjs`:
```javascript
import fs from 'node:fs';

// traces.jsonl 每行一个 span 对象:{name,attributes:{toolName,is_error,outcome_kind,...},status,...}
export function collectMoss(tracesPath) {
  const calls = [];
  const lines = fs.readFileSync(tracesPath, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    let span;
    try { span = JSON.parse(line); } catch { continue; }
    if (span.name !== 'moss.tool.invoke') continue;
    calls.push({
      tool: span.attributes?.toolName,
      isError: span.attributes?.is_error === true || span.status === 'error',
      outcomeKind: span.attributes?.outcome_kind, // completed | denied | pre-blocked | hook-blocked | unknown-tool
      callId: span.attributes?.toolCallId,
    });
  }
  return { calls, source: 'moss' };
}

// claude stream-json: 每行一个 event。tool_use 事件含 name/input;tool_result 含 is_error。
export function collectClaude(streamJsonPath) {
  const calls = [];
  const useById = new Map();
  const lines = fs.readFileSync(streamJsonPath, 'utf8').split('\n').filter(Boolean);
  for (const line of lines) {
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type === 'tool_use') useById.set(ev.id, { tool: ev.name, isError: false, outcomeKind: 'completed', callId: ev.id });
    else if (ev.type === 'tool_result') {
      const u = useById.get(ev.tool_use_id);
      if (u) { u.isError = ev.is_error === true; if (u.isError) u.outcomeKind = 'completed'; }
    }
  }
  for (const [, v] of useById) calls.push(v);
  return { calls, source: 'claude' };
}
```

- [ ] **Step 2: 用 smoke 产物自测解析**

```bash
cd /d/moss-eval
node -e "
  const {collectMoss}=await import('./harness/collect-artifacts.mjs');
  const r=collectMoss('runs/smoke/L2-01/moss/round-1/traces.jsonl');
  console.log('moss calls:', r.calls.length);
"
```
Expected: 数字输出(可能 0,只要不抛错)。

- [ ] **Step 3: Commit**

```bash
git add harness/collect-artifacts.mjs && git commit -m "feat(harness): unified artifact collector (moss traces + claude stream-json)"
```

---

## Task 7: score-layer2(显性错误率 + 隐性候选)

**Files:**
- Create: `D:\moss-eval/harness/score-layer2.mjs`

**Interfaces:** `scoreLayer2(collected)` → `{total, explicitErrors, explicitRate, reviewCandidates:[...]}`。规则:`分母 = outcomeKind==='completed'`;`分子 = completed && isError`。隐性候选启发式:同一 tool 重复 ≥3 次、读不存在的路径未报错、tool 与任务 id 的预期工具集合不匹配。

- [ ] **Step 1: 写 score-layer2.mjs**

Create `D:\moss-eval\harness\score-layer2.mjs`:
```javascript
// 显性错误率 + 隐性错误候选。
// 显性:completed 工具调用里 is_error=true 的占比。
// 隐性候选(交给人工):同 tool 重复≥3、读不存在路径未报错、tool 不在任务预期集合。
export function scoreLayer2(collected, taskId) {
  const completed = collected.calls.filter(c => c.outcomeKind === 'completed');
  const explicitErrors = completed.filter(c => c.isError).length;
  const total = completed.length;
  const explicitRate = total ? explicitErrors / total : 0;

  // 隐性候选
  const byTool = new Map();
  for (const c of completed) byTool.set(c.tool, (byTool.get(c.tool) ?? 0) + 1);
  const repeated = [...byTool.entries()].filter(([, n]) => n >= 3).map(([t]) => t);
  const readNoErrMissing = collected.calls.filter(c => /exist|does-not-exist/i.test(taskId) && c.tool === 'read' && !c.isError);

  return {
    total, explicitErrors, explicitRate,
    reviewCandidates: { repeatedTools: repeated, suspectedHallucinatedRead: readNoErrMissing },
    source: collected.source,
  };
}
```

- [ ] **Step 2: 单元自测(构造假数据)**

```bash
cd /d/moss-eval
node -e "
  const {scoreLayer2}=await import('./harness/score-layer2.mjs');
  const fake={calls:[
    {tool:'read',isError:false,outcomeKind:'completed'},
    {tool:'read',isError:true,outcomeKind:'completed'},
    {tool:'search',isError:false,outcomeKind:'completed'},
    {tool:'denied',isError:false,outcomeKind:'denied'},  // 不计入分母
  ],source:'moss'};
  console.log(scoreLayer2(fake,'L2-05'));
"
```
Expected: `total:3, explicitErrors:1, explicitRate:0.333...`(denied 不计入分母)。

- [ ] **Step 3: Commit**

```bash
git add harness/score-layer2.mjs && git commit -m "feat(harness): layer2 scorer (explicit error rate + hidden-error candidates)"
```

---

## Task 8: score-layer3(纠错轮数 + 死循环 + 修复对照)

**Files:**
- Create: `D:\moss-eval/harness/score-layer3.mjs`

**Interfaces:** `scoreLayer3(collected, task)` → `{turns, repeatFailures, deathLoop:boolean, fixMatched:boolean}`。`repeatFailures` = 同名 tool + 相同 argsHash + isError 序列长度;`deathLoop` = repeatFailures ≥3;`fixMatched` = diff.patch 含 `task.expectedFixPatch` 字符串。

- [ ] **Step 1: 写 score-layer3.mjs**

Create `D:\moss-eval\harness\score-layer3.mjs`:
```javascript
import fs from 'node:fs';

function argsHash(args){ return JSON.stringify(args ?? {}); }

export function scoreLayer3(collected, task, diffPath) {
  // 纠错轮数 ≈ completed 调用里 isError 的连续段(粗略)
  let turns = collected.calls.length;
  // 重复失败命令:同名 tool + 相同 argsHash + isError
  const seen = new Map(); let maxRepeat = 0;
  for (const c of collected.calls) {
    if (!c.isError) continue;
    const key = c.tool + '|' + argsHash(c.args);
    const n = (seen.get(key) ?? 0) + 1;
    seen.set(key, n); maxRepeat = Math.max(maxRepeat, n);
  }
  const deathLoop = maxRepeat >= 3;
  // 修复对照
  let fixMatched = false;
  if (task.expectedFixPatch && diffPath) {
    try { fixMatched = fs.readFileSync(diffPath,'utf8').includes(task.expectedFixPatch); } catch {}
  }
  return { turns, repeatFailures: maxRepeat, deathLoop, fixMatched, source: collected.source };
}
```

- [ ] **Step 2: 自测**

```bash
cd /d/moss-eval
node -e "
  const {scoreLayer3}=await import('./harness/score-layer3.mjs');
  const c={calls:[
    {tool:'exec',isError:true,args:{cmd:'npm test'},outcomeKind:'completed'},
    {tool:'exec',isError:true,args:{cmd:'npm test'},outcomeKind:'completed'},
    {tool:'exec',isError:true,args:{cmd:'npm test'},outcomeKind:'completed'},
  ],source:'moss'};
  console.log(scoreLayer3(c,{expectedFixPatch:'return a / b; }'},null));
"
```
Expected: `repeatFailures:3, deathLoop:true`。

- [ ] **Step 3: Commit**

```bash
git add harness/score-layer3.mjs && git commit -m "feat(harness): layer3 scorer (turns/deathloop/fix-match)"
```

---

## Task 9: 主 runner run-eval.mjs(串起全流程)

**Files:**
- Create: `D:\moss-eval/harness/run-eval.mjs`

**Interfaces:** 消费 tasks/reset/run-moss/run-claude/collect/score。产出 `reports/*.csv` + `review-samples.md`。每任务每轮:reset→moss→collect→score→reset→claude→collect→score→appendCSV。

- [ ] **Step 1: 写 run-eval.mjs**

Create `D:\moss-eval\harness\run-eval.mjs`:
```javascript
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { TASKS, ROUNDS } from './tasks.mjs';
import { reset } from './lib/reset.mjs';
import { runMoss } from './lib/run-moss.mjs';
import { runClaude } from './lib/run-claude.mjs';
import { collectMoss, collectClaude } from './collect-artifacts.mjs';
import { scoreLayer2 } from './score-layer2.mjs';
import { scoreLayer3 } from './score-layer3.mjs';

const ts = new Date().toISOString().slice(0,19).replace(/[:T]/g,'');
await fsp.mkdir('reports', { recursive: true });
const l2 = fs.createWriteStream('reports/layer2-error-rate.csv');
const l3 = fs.createWriteStream('reports/layer3-recovery.csv');
const review = [];
l2.write('task,round,subject,total,explicitErrors,explicitRate\n');
l3.write('task,round,subject,turns,repeatFailures,deathLoop,fixMatched\n');

for (const task of TASKS) {
  for (let round = 1; round <= ROUNDS; round++) {
    // moss
    reset(task.tag);
    const mr = await runMoss(task, round, ts);
    const mc = collectMoss(mr.tracesPath);
    if (task.layer === 2) {
      const s = scoreLayer2(mc, task.id);
      l2.write(`${task.id},${round},moss,${s.total},${s.explicitErrors},${s.explicitRate.toFixed(4)}\n`);
      if (s.reviewCandidates.repeatedTools.length || s.reviewCandidates.suspectedHallucinatedRead.length)
        review.push({ task: task.id, round, subject: 'moss', ...s.reviewCandidates });
    } else {
      const s = scoreLayer3(mc, task, mr.diffPath);
      l3.write(`${task.id},${round},moss,${s.turns},${s.repeatFailures},${s.deathLoop},${s.fixMatched}\n`);
    }
    // claude
    reset(task.tag);
    const cr = await runClaude(task, round, ts);
    const cc = collectClaude(cr.streamJsonPath);
    if (task.layer === 2) {
      const s = scoreLayer2(cc, task.id);
      l2.write(`${task.id},${round},claude,${s.total},${s.explicitErrors},${s.explicitRate.toFixed(4)}\n`);
    } else {
      const s = scoreLayer3(cc, task, cr.diffPath);
      l3.write(`${task.id},${round},claude,${s.turns},${s.repeatFailures},${s.deathLoop},${s.fixMatched}\n`);
    }
  }
}
l2.end(); l3.end();
await fsp.writeFile('reports/review-samples.md',
  '# Review Samples\n' + review.map(r => `- ${r.task} ${r.round} ${r.subject}: ${JSON.stringify(r)}`).join('\n'));
console.log('done. reports in reports/');
```

- [ ] **Step 2: 冒烟跑(只 1 任务 1 轮,临时改 TASKS)**

```bash
cd /d/moss-eval
# 临时只测 L2-01 round1
node -e "
  const orig=await import('./harness/tasks.mjs');
  process.env.EVAL_SMOKE=1;
  // 直接调 run-eval 但 monkey-patch TASKS — 简单做法:改 run-eval 读 EVAL_SMOKE 只跑第一项
"
# 简化:直接跑全量前先手动 reset + runMoss + collect + score 走一遍(用 Task5 的冒烟测方式)
```
> 实现时:在 run-eval 顶部加 `const tasks = process.env.EVAL_SMOKE ? TASKS.slice(0,1) : TASKS; const rounds = process.env.EVAL_SMOKE ? 1 : ROUNDS;` 并把循环用这两个变量。这样冒烟只跑 1×1×2。

- [ ] **Step 3: Commit**

```bash
git add harness/run-eval.mjs && git commit -m "feat(harness): main runner wiring reset→run→collect→score→csv"
```

---

## Task 10: 全量跑 + baseline-summary

**Files:**
- Create: `D:\moss-eval/reports/baseline-summary.md`(跑完生成)

**Interfaces:** 跑完 `npm`-less 全量,生成汇总。

- [ ] **Step 1: 冒烟跑确认 smoke 绿**

```bash
cd /d/moss-eval
EVAL_SMOKE=1 EVAL_MODEL=<Step1模型> ANTHROPIC_API_KEY=<key> node harness/run-eval.mjs
```
Expected: `reports/layer2-error-rate.csv` 有 2 行(L2-01 moss+claude),无报错。

- [ ] **Step 2: 全量跑**

```bash
cd /d/moss-eval
EVAL_MODEL=<Step1模型> ANTHROPIC_API_KEY=<key> node harness/run-eval.mjs
```
Expected: 跑约 1–2 小时(138 次 agent 运行)。产出 3 个 csv/md。若中途某任务卡住 >10min,kill 后该轮记为 timeout 继续。

- [ ] **Step 3: 看 csv 汇总,算 moss vs claude 各层均值**

```bash
cd /d/moss-eval
node -e "
  const fs=require('fs');
  const l2=fs.readFileSync('reports/layer2-error-rate.csv','utf8').trim().split('\n').slice(1);
  const by={}; for(const r of l2){const[t,rd,s,tot,er,rate]=r.split(',');(by[s]=by[s]||[]).push(+rate);}
  for(const[s,arr]of Object.entries(by)){const avg=arr.reduce((a,b)=>a+b,0)/arr.length;console.log(s,'layer2 avg explicitRate=',avg.toFixed(4));}
"
```

- [ ] **Step 4: 写 baseline-summary.md**

Create `D:\moss-eval\reports\baseline-summary.md`(基于 Step3 实际数字填):
```markdown
# moss vs Claude Code 基线(第2+3层)

## 第2层 工具调用准确率
| subject | 总调用数 | 显性错误率 | 基准 |
|---|---|---|---|
| moss | <实际> | <实际> | <1%优秀,>5%头号优化点 |
| claude | <实际> | <实际> | 同上 |

隐性错误候选见 review-samples.md(人工复核后补隐性错误率)。

## 第3层 错误闭环
| subject | 平均纠错轮数 | 死循环发生率 | 修复成功率 |
|---|---|---|---|
| moss | <实际> | <实际> | <实际> |
| claude | <实际> | <实际> | <实际> |

## 差距定位(对照文档「常见差距点」)
- 第2层:<根据结果写 moss 哪类错误最多:格式/参数/选错,映射到 validateToolInputObject / 工具描述>
- 第3层:<根据结果写 moss 是否死循环/纠错轮数偏高,映射到 tool-loop-guard / MAX_RETRY / completion-gate>

## 调整方向(后续单独 spec,本轮不实施)
<列 spec 第6段的映射>
```

- [ ] **Step 5: Commit 全部产物**

```bash
cd /d/moss-eval
git add reports/ && git commit -m "data: baseline run results (layers 2+3)"
```

---

## Self-Review

**1. Spec coverage:** spec 6 段全覆盖——架构(Task0-2)、任务集(Task2-4)、采集判分(Task5-8)、公平性(Task1 同模型+Task5 重置+隔离配置)、产出物(Task9-10)、调整方向(Task10 Step4)。✓
**2. Placeholder scan:** Task5/Step2 注释提到"实现时补 import"——这是已点明的实现细节,非占位符;baseline-summary 的 `<实际>` 是跑完填的数据占位,符合"跑完才有"。无 TODO/TBD。✓
**3. Type consistency:** `collectMoss`/`collectClaude` 返回 `{calls,source}`,scoreLayer2/3 都收 collected.calls——一致。runMoss/runClaude 返回字段名贯穿 Task6-9 一致(tracesPath/transcriptPath/diffPath;streamJsonPath/diffPath)。✓

一处实现修正记号:Task5 run-moss.mjs/run-claude.mjs 里 diff 用了 execFileSync/spawnSync 但头没 import——已在 Step 注释标明"实现时补 import 统一"。实现者需统一 import。
