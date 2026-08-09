# moss skill 调用能力评估 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 moss skill 调用评估测试集(37 任务),测 moss 从自然语言 prompt 选用 skill 的准确率 + 执行质量,产出 skill-accuracy.csv + 人工复核清单。

**Architecture:** 复用 `D:\moss-eval` 现有 harness(run-subject/collect/pool/run-eval),新增 `tasks-skill.mjs`(37 任务定义)+ `score-skill.mjs`(从 stream-json 提取 load_skill 调用判分)+ `run-skill-eval.mjs`(主入口)。单边测 moss(不对比 claude)。判分严格口径:只认显式 `load_skill(name)` 调用。

**Tech Stack:** Node.js 22 ESM `.mjs`,moss CLI v0.6.0(已 link 全局),git,JSONL/JSON 解析。无第三方依赖。

**Spec:** `docs/superpowers/specs/2026-07-21-moss-skill-eval-design.md`

## Global Constraints

- 测 moss skill 调用能力,**单边**(不对比 claude)。
- 判分严格口径:只认显式 `load_skill(name)` 调用。nudge 触发作为辅助观测记录,不计入"选对"。
- prompt 措辞中性,**不点名 skill**(测自然语言匹配,不是「用 code-review skill」)。
- 同 GLM、同初始态(每任务独立 fixtures reset)、N=1 试水。
- 复用现有 `harness/lib/run-subject.mjs`、`collect.mjs`、`pool.mjs`、`reset.mjs`、`config.mjs`,**不动 L2/L3 harness**。
- web-research 联网任务跑,只判选择(load_skill 选对与否),执行质量不判。
- 多 skill 任务 expectedSkills 判分:**集合包含 + 软序**(集合⊇即算选对,顺序作辅助观测)。
- 每 Task 结尾 commit。在 `D:\moss-eval`(独立 git 仓,branch `eval/harness` —— 复用之前那个分支)。

---

## File Structure

`D:\moss-eval/`

- `harness/tasks-skill.mjs` — skill 任务定义(37 任务:id, prompt, expectedSkills[], reject, lang, fixtureTag?)
- `harness/score-skill.mjs` — 从 metrics.json/stream 提取 load_skill 调用 → 判分
- `harness/run-skill-eval.mjs` — 主入口:reset→run moss→collect(带 load_skill)→score→csv
- `fixtures/skill-eval/` — skill 任务用的被测项目(多 skill 需要的小代码库 + git 仓 + 前端项目)
- `runs/skill-eval/<ts>/<task>/moss/round-1/{stream.jsonl, metrics.json, status.json}`
- `reports/skill-accuracy.csv` + `skill-execution-samples.md` + `skill-summary.md`

---

## Task 0: 建 skill-eval fixture(被测项目)

**Files:**

- Create: `D:\moss-eval/fixtures/skill-eval/`(小代码库,供 skill 任务操作)

**Interfaces:** 产出一个带 bug 的 TS 小库 + git 仓 + 简单前端文件,供 code-review/refactoring/debugging/TDD/documentation/frontend-ui-polish/git-workflow/pr-and-ship 等任务操作。

- [ ] **Step 1: 建被测小库(skill-eval/sample-lib)**

`mkdir -p /d/moss-eval/fixtures/skill-eval/sample-lib/{src,test}`
Create `D:\moss-eval\fixtures\skill-eval\sample-lib\package.json`:

```json
{
  "name": "skill-eval-lib",
  "version": "0.1.0",
  "type": "module",
  "scripts": {
    "test": "node --test --test-reporter=spec \"test/**/*.test.ts\"",
    "tsc": "tsc --noEmit"
  },
  "devDependencies": { "typescript": "^5.7.3" }
}
```

Create `D:\moss-eval\fixtures\skill-eval\sample-lib\tsconfig.json`:

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "outDir": "dist"
  },
  "include": ["src"]
}
```

Create `D:\moss-eval\fixtures\skill-eval\sample-lib\src\calc.ts`(含一个待修复 bug):

```typescript
export function add(a: number, b: number): number {
  return a + b;
}
export function divide(a: number, b: number): number {
  return a / b;
} // 除零未处理
export function deprecatedFn(): string {
  return 'old';
}
```

Create `D:\moss-eval\fixtures\skill-eval\sample-lib\src\format.ts`:

```typescript
export function fmtDate(d: Date): string {
  return d.toLocaleDateString();
}
export function camelCase(input: string): string {
  return input.replace(/_([a-z])/g, (_, c) => c.toUpperCase());
}
```

Create `D:\moss-eval\fixtures\skill-eval\sample-lib\src\index.html`(前端任务用):

```html
<!DOCTYPE html>
<html>
  <body>
    <button id="b">click</button>
    <script>
      document.getElementById('b').onclick = () => alert(1);
    </script>
  </body>
</html>
```

Create `D:\moss-eval\fixtures\skill-eval\sample-lib\test\calc.test.ts`:

```typescript
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { add, divide } from '../src/calc.ts';
test('add', () => assert.equal(add(2, 3), 5));
test('divide', () => assert.equal(divide(10, 2), 5));
```

- [ ] **Step 2: 装依赖 + 初始化 git 仓(供 git-workflow/pr-and-ship 任务)**

```bash
cd /d/moss-eval/fixtures/skill-eval/sample-lib
npm install 2>&1 | tail -2
git init -q 2>/dev/null || true
git add -A && git -c user.email=eval@local -c user.name=eval commit -qm "feat: skill-eval sample-lib baseline"
git tag skill-base
```

- [ ] **Step 3: 验证可跑 tsc/test**

```bash
cd /d/moss-eval/fixtures/skill-eval/sample-lib
npx tsc --noEmit 2>&1 | tail -2; echo "tsc exit=$?"
npm test 2>&1 | tail -3
```

Expected: tsc exit 0, npm test 2 passed。npm install 后 node_modules 存在(后续任务需)。

- [ ] **Step 4: Commit**

```bash
cd /d/moss-eval
git add fixtures/skill-eval
git commit -m "feat(fixtures): skill-eval sample-lib (TS lib + git + frontend) for skill tasks"
```

---

## Task 1: tasks-skill.mjs(37 任务定义)

**Files:**

- Create: `D:\moss-eval/harness/tasks-skill.mjs`

**Interfaces:** 导出 `SKILL_TASKS: SkillTask[]`,每项 `{id, kind: 'single'|'multi'|'reject', prompt, expectedSkills: string[], reject: boolean, lang: 'zh'|'en', workDir, cleanMode}`。被 run-skill-eval.mjs 消费。

- [ ] **Step 1: 写 tasks-skill.mjs**

Create `D:\moss-eval\harness\tasks-skill.mjs`:

```javascript
// 37 个 skill 评估任务。prompt 不点名 skill(测自然语言匹配)。
// expectedSkills: 期望 moss 调 load_skill 的 skill name(集合判分,顺序软)。
// reject: true 表示预期不调 load_skill(拒识任务)。
// workDir: 跑 agent 的工作目录(skill-eval/sample-lib 或 skill-eval 根)。
// cleanMode: 'fd'(保 node_modules,多数任务)/'fdx'(清,拒识的纯查询也保)。

const LIB = 'fixtures/skill-eval/sample-lib'; // 带代码 + git + 前端的小库

export const SKILL_TASKS = [
  // ── A. 17 个单 skill 任务 ──
  {
    id: 'SK-01',
    kind: 'single',
    reject: false,
    lang: 'en',
    workDir: LIB,
    cleanMode: 'fd',
    prompt: 'Please do a code review of this codebase and report any bugs or issues with severity.',
    expectedSkills: ['code-review'],
  },
  {
    id: 'SK-02',
    kind: 'single',
    reject: false,
    lang: 'zh',
    workDir: LIB,
    cleanMode: 'fd',
    prompt: '系统性地调试一下 divide 函数的除零问题,找出根因再修。',
    expectedSkills: ['superpower-systematic-debugging'],
  },
  {
    id: 'SK-03',
    kind: 'single',
    reject: false,
    lang: 'en',
    workDir: LIB,
    cleanMode: 'fd',
    prompt:
      'Add a test for the add function using test-driven development: write a failing test first, then implement.',
    expectedSkills: ['superpower-test-driven-development'],
  },
  {
    id: 'SK-04',
    kind: 'single',
    reject: false,
    lang: 'zh',
    workDir: LIB,
    cleanMode: 'fd',
    prompt: '把这个库升级到 ES2024,处理迁移兼容性问题。',
    expectedSkills: ['moss-upgrade-and-migration-contract'],
  },
  {
    id: 'SK-05',
    kind: 'single',
    reject: false,
    lang: 'en',
    workDir: LIB,
    cleanMode: 'fd',
    prompt:
      'Find all callers of the divide function and trace its impact radius across the codebase.',
    expectedSkills: ['codegraph-structural-navigation'],
  },
  {
    id: 'SK-06',
    kind: 'single',
    reject: false,
    lang: 'zh',
    workDir: LIB,
    cleanMode: 'fd',
    prompt: '审查这段代码,检查 bug、安全、命名、测试覆盖,按严重程度给结论。',
    expectedSkills: ['code-review'],
  },
  {
    id: 'SK-07',
    kind: 'single',
    reject: false,
    lang: 'en',
    workDir: LIB,
    cleanMode: 'fd',
    prompt:
      'Commit the current changes using conventional commits with a structured message and branch naming.',
    expectedSkills: ['git-workflow'],
  },
  {
    id: 'SK-08',
    kind: 'single',
    reject: false,
    lang: 'zh',
    workDir: LIB,
    cleanMode: 'fd',
    prompt: '重构 calc.ts,识别代码异味,小步改并每步验证。',
    expectedSkills: ['refactoring'],
  },
  {
    id: 'SK-09',
    kind: 'single',
    reject: false,
    lang: 'en',
    workDir: LIB,
    cleanMode: 'fd',
    prompt: 'Generate API docs and a README for this library.',
    expectedSkills: ['documentation'],
  },
  {
    id: 'SK-10',
    kind: 'single',
    reject: false,
    lang: 'zh',
    workDir: LIB,
    cleanMode: 'fd',
    prompt: '把 add 函数的功能做成一份演示幻灯片。',
    expectedSkills: ['create-presentation'],
  },
  {
    id: 'SK-11',
    kind: 'single',
    reject: false,
    lang: 'en',
    workDir: LIB,
    cleanMode: 'fd',
    prompt: 'Research the latest TypeScript 5.5 release notes and summarize key changes.',
    expectedSkills: ['web-research'],
  },
  {
    id: 'SK-12',
    kind: 'single',
    reject: false,
    lang: 'zh',
    workDir: LIB,
    cleanMode: 'fd',
    prompt: '审查这个代码库的架构,评估整体结构。',
    expectedSkills: ['codebase-inspection'],
  },
  {
    id: 'SK-13',
    kind: 'single',
    reject: false,
    lang: 'en',
    workDir: LIB,
    cleanMode: 'fd',
    prompt:
      'Make an implementation plan for adding a subtract function to this library, step by step.',
    expectedSkills: ['planning'],
  },
  {
    id: 'SK-14',
    kind: 'single',
    reject: false,
    lang: 'zh',
    workDir: LIB,
    cleanMode: 'fd',
    prompt: '修改完后做一次验证,确认改对了再收尾。',
    expectedSkills: ['verification-before-completion'],
  },
  {
    id: 'SK-15',
    kind: 'single',
    reject: false,
    lang: 'en',
    workDir: LIB,
    cleanMode: 'fd',
    prompt: 'Polish the frontend: improve the index.html button styling and interaction.',
    expectedSkills: ['frontend-ui-polish'],
  },
  {
    id: 'SK-16',
    kind: 'single',
    reject: false,
    lang: 'zh',
    workDir: LIB,
    cleanMode: 'fd',
    prompt: '把改动整理成一个 PR 并准备提交。',
    expectedSkills: ['pr-and-ship'],
  },
  {
    id: 'SK-17',
    kind: 'single',
    reject: false,
    lang: 'en',
    workDir: LIB,
    cleanMode: 'fd',
    prompt:
      'Work through adding a multiply function using an efficient incremental coding loop, verifying each step.',
    expectedSkills: ['efficient-coding-loop'],
  },

  // ── B. 10 个多 skill 任务(集合判分 + 软序)──
  {
    id: 'SK-M1',
    kind: 'multi',
    reject: false,
    lang: 'en',
    workDir: LIB,
    cleanMode: 'fd',
    prompt: 'Review this code for bugs, then systematically fix the divide-by-zero issue you find.',
    expectedSkills: ['code-review', 'superpower-systematic-debugging'],
  },
  {
    id: 'SK-M2',
    kind: 'multi',
    reject: false,
    lang: 'zh',
    workDir: LIB,
    cleanMode: 'fd',
    prompt: '理解这个库的架构,然后制定一个重构计划。',
    expectedSkills: ['codebase-inspection', 'planning', 'refactoring'],
  },
  {
    id: 'SK-M3',
    kind: 'multi',
    reject: false,
    lang: 'en',
    workDir: LIB,
    cleanMode: 'fd',
    prompt:
      'Implement a subtract function using TDD, verify it works, then prepare a PR to ship it.',
    expectedSkills: [
      'superpower-test-driven-development',
      'verification-before-completion',
      'pr-and-ship',
    ],
  },
  {
    id: 'SK-M4',
    kind: 'multi',
    reject: false,
    lang: 'zh',
    workDir: LIB,
    cleanMode: 'fd',
    prompt: '给这个库写文档,然后做一次代码审查。',
    expectedSkills: ['documentation', 'code-review'],
  },
  {
    id: 'SK-M5',
    kind: 'multi',
    reject: false,
    lang: 'en',
    workDir: LIB,
    cleanMode: 'fd',
    prompt: 'Refactor calc.ts, verify the refactor, then commit with conventional git workflow.',
    expectedSkills: ['refactoring', 'verification-before-completion', 'git-workflow'],
  },
  {
    id: 'SK-M6',
    kind: 'multi',
    reject: false,
    lang: 'zh',
    workDir: LIB,
    cleanMode: 'fd',
    prompt: '调研 TypeScript 5.5 的发布说明,然后做成一份演示。',
    expectedSkills: ['web-research', 'create-presentation'],
  },
  {
    id: 'SK-M7',
    kind: 'multi',
    reject: false,
    lang: 'en',
    workDir: LIB,
    cleanMode: 'fd',
    prompt: 'Analyze the codebase impact of the divide function, then plan a migration to ES2024.',
    expectedSkills: [
      'codegraph-structural-navigation',
      'planning',
      'moss-upgrade-and-migration-contract',
    ],
  },
  {
    id: 'SK-M8',
    kind: 'multi',
    reject: false,
    lang: 'zh',
    workDir: LIB,
    cleanMode: 'fd',
    prompt: '打磨前端 index.html,然后准备提 PR。',
    expectedSkills: ['frontend-ui-polish', 'pr-and-ship'],
  },
  {
    id: 'SK-M9',
    kind: 'multi',
    reject: false,
    lang: 'en',
    workDir: LIB,
    cleanMode: 'fd',
    prompt:
      'Systematically debug the divide bug, then fix it with TDD by writing a failing test first.',
    expectedSkills: ['superpower-systematic-debugging', 'superpower-test-driven-development'],
  },
  {
    id: 'SK-M10',
    kind: 'multi',
    reject: false,
    lang: 'zh',
    workDir: LIB,
    cleanMode: 'fd',
    prompt: '巡检这个代码库,然后用高效编码循环改进它。',
    expectedSkills: ['codebase-inspection', 'efficient-coding-loop'],
  },

  // ── C. 10 个拒识任务(预期不调 load_skill)──
  // 类型1:像 code-review 但只问事实
  {
    id: 'SK-R1',
    kind: 'reject',
    reject: true,
    lang: 'en',
    workDir: LIB,
    cleanMode: 'fd',
    prompt: 'What does the add function in calc.ts return?',
    expectedSkills: [],
  },
  {
    id: 'SK-R2',
    kind: 'reject',
    reject: true,
    lang: 'zh',
    workDir: LIB,
    cleanMode: 'fd',
    prompt: 'divide 函数定义在 calc.ts 的哪一行?',
    expectedSkills: [],
  },
  // 类型2:像 git-workflow 但只查询
  {
    id: 'SK-R3',
    kind: 'reject',
    reject: true,
    lang: 'en',
    workDir: LIB,
    cleanMode: 'fd',
    prompt: 'Which branch am I currently on?',
    expectedSkills: [],
  },
  {
    id: 'SK-R4',
    kind: 'reject',
    reject: true,
    lang: 'zh',
    workDir: LIB,
    cleanMode: 'fd',
    prompt: '最近 3 个 commit 是什么?',
    expectedSkills: [],
  },
  // 类型3:像 documentation/refactoring 但只问答
  {
    id: 'SK-R5',
    kind: 'reject',
    reject: true,
    lang: 'en',
    workDir: LIB,
    cleanMode: 'fd',
    prompt: 'What dependencies does this project use?',
    expectedSkills: [],
  },
  {
    id: 'SK-R6',
    kind: 'reject',
    reject: true,
    lang: 'zh',
    workDir: LIB,
    cleanMode: 'fd',
    prompt: 'add 函数有几个参数?',
    expectedSkills: [],
  },
  // 类型4:纯无关基线
  {
    id: 'SK-R7',
    kind: 'reject',
    reject: true,
    lang: 'en',
    workDir: LIB,
    cleanMode: 'fd',
    prompt: 'What is 2 plus 3?',
    expectedSkills: [],
  },
  {
    id: 'SK-R8',
    kind: 'reject',
    reject: true,
    lang: 'zh',
    workDir: LIB,
    cleanMode: 'fd',
    prompt: '把这句话翻译成英文:你好世界',
    expectedSkills: [],
  },
  {
    id: 'SK-R9',
    kind: 'reject',
    reject: true,
    lang: 'en',
    workDir: LIB,
    cleanMode: 'fd',
    prompt: 'List the files in the current directory.',
    expectedSkills: [],
  },
  {
    id: 'SK-R10',
    kind: 'reject',
    reject: true,
    lang: 'zh',
    workDir: LIB,
    cleanMode: 'fd',
    prompt: '现在几点了?',
    expectedSkills: [],
  },
];

export const SKILL_ROUNDS = 1; // 试水轮 N=1
```

- [ ] **Step 2: 自检加载**

```bash
cd /d/moss-eval
node --input-type=module -e "import('./harness/tasks-skill.mjs').then(m=>{const by={};for(const t of m.SKILL_TASKS)by[t.kind]=(by[t.kind]||0)+1;console.log('total:',m.SKILL_TASKS.length,'byKind:',JSON.stringify(by))})"
```

Expected: `total: 37 byKind: {"single":17,"multi":10,"reject":10}`。

- [ ] **Step 3: Commit**

```bash
cd /d/moss-eval
git add harness/tasks-skill.mjs
git commit -m "feat(harness): skill-eval task definitions (17 single + 10 multi + 10 reject)"
```

---

## Task 2: score-skill.mjs(判分:提取 load_skill + 指标)

**Files:**

- Create: `D:\moss-eval/harness/score-skill.mjs`

**Interfaces:** `scoreSkill(runResult, task)` → `{loadedSkills, selectionCorrect, rejectCorrect, hallucinatedSkill, wrongSkill, nudgeFired, nudgeResponded, firstLoadTurn, repeatLoadCount}`。被 run-skill-eval.mjs 的 aggregate 消费。

- [ ] **Step 1: 写 score-skill.mjs**

Create `D:\moss-eval\harness\score-skill.mjs`:

```javascript
// skill 评估判分。严格口径:只认显式 load_skill(name) 调用。
// run.toolCalls 已含 {name, input, turn, ok}(来自 collect.mjs)。
// 提取所有 load_skill 调用的 input.name,判选择准确率 + nudge 辅助观测。

const ALL_SKILL_NAMES = new Set([
  'superpower-methodical-builder',
  'superpower-systematic-debugging',
  'superpower-test-driven-development',
  'moss-upgrade-and-migration-contract',
  'codegraph-structural-navigation',
  'code-review',
  'git-workflow',
  'refactoring',
  'documentation',
  'create-presentation',
  'web-research',
  'codebase-inspection',
  'planning',
  'verification-before-completion',
  'frontend-ui-polish',
  'pr-and-ship',
  'efficient-coding-loop',
]);

export function scoreSkill(run, task, transcriptText = '') {
  const loadCalls = run.toolCalls.filter((c) => c.name === 'load_skill');
  const loadedSkills = loadCalls.map((c) => String(c.input?.name ?? '').trim()).filter(Boolean);
  const loadedSet = new Set(loadedSkills);

  // 幻觉 skill:调了不存在的 skill name
  const hallucinatedSkill = loadedSkills.filter((n) => !ALL_SKILL_NAMES.has(n));
  // 重复 load 同 skill(死循环信号)
  const seen = new Map();
  for (const n of loadedSkills) seen.set(n, (seen.get(n) ?? 0) + 1);
  const repeatLoadCount = [...seen.values()].filter((n) => n > 1).length;

  // 首次加载轮数
  const firstLoadTurn = loadCalls.length ? loadCalls[0].turn : null;

  // nudge 辅助观测:transcript 里出现 skill/nudge 相关消息
  const nudgeFired = /skill/i.test(transcriptText) && /nudge|moss-agent/i.test(transcriptText);
  const nudgeResponded = nudgeFired && loadCalls.length > 0;

  let selectionCorrect = false;
  let rejectCorrect = false;
  let wrongSkill = [];

  if (task.reject) {
    // 拒识任务:预期 load_skill = 0 次
    rejectCorrect = loadedSkills.length === 0;
  } else {
    // 单/多 skill 任务:loadedSkills ⊇ expectedSkills(集合包含,软序)
    const expected = new Set(task.expectedSkills);
    const got = loadedSet;
    selectionCorrect = [...expected].every((s) => got.has(s));
    // 误选:调了存在但不在 expected 里的 skill
    wrongSkill = loadedSkills.filter((n) => ALL_SKILL_NAMES.has(n) && !expected.has(n));
  }

  return {
    taskId: task.id,
    kind: task.kind,
    lang: task.lang,
    loadedSkills,
    loadedCount: loadedSkills.length,
    expectedSkills: task.expectedSkills,
    selectionCorrect,
    rejectCorrect,
    hallucinatedSkill,
    wrongSkill,
    nudgeFired,
    nudgeResponded,
    firstLoadTurn,
    repeatLoadCount,
    terminalReason: run.terminalReason,
  };
}
```

- [ ] **Step 2: 自检(假数据)**

```bash
cd /d/moss-eval
node --input-type=module -e "
  const{scoreSkill}=await import('./harness/score-skill.mjs');
  // 命中:load_skill('code-review')
  const ok={toolCalls:[{name:'load_skill',input:{name:'code-review'},turn:2,ok:true}],terminalReason:'completed'};
  console.log('single-hit:', JSON.stringify(scoreSkill(ok,{id:'SK-01',reject:false,expectedSkills:['code-review'],lang:'en',kind:'single'})));
  // 拒识:无 load_skill
  const rej={toolCalls:[{name:'read_file',input:{},turn:1,ok:true}],terminalReason:'completed'};
  console.log('reject-ok:', JSON.stringify(scoreSkill(rej,{id:'SK-R1',reject:true,expectedSkills:[],lang:'en',kind:'reject'})));
  // 拒识失败:误调 load_skill
  const rejBad={toolCalls:[{name:'load_skill',input:{name:'code-review'},turn:1,ok:true}],terminalReason:'completed'};
  console.log('reject-fail:', JSON.stringify(scoreSkill(rejBad,{id:'SK-R1',reject:true,expectedSkills:[],lang:'en',kind:'reject'})));
  // 幻觉 skill
  const halluc={toolCalls:[{name:'load_skill',input:{name:'nonexistent-skill'},turn:1,ok:true}],terminalReason:'completed'};
  console.log('halluc:', JSON.stringify(scoreSkill(halluc,{id:'SK-01',reject:false,expectedSkills:['code-review'],lang:'en',kind:'single'})));
"
```

Expected: single-hit `selectionCorrect:true`; reject-ok `rejectCorrect:true`; reject-fail `rejectCorrect:false`; halluc `hallucinatedSkill:['nonexistent-skill']`。

- [ ] **Step 3: Commit**

```bash
cd /d/moss-eval
git add harness/score-skill.mjs
git commit -m "feat(harness): skill scorer — load_skill extraction + selection/reject/hallucination metrics"
```

---

## Task 3: collect.mjs 扩展提取 load_skill(或 run-skill-eval 内联提取)

**Files:**

- Modify: `D:\moss-eval/harness/lib/collect.mjs`(确认 toolCalls 已含 load_skill 的 input;若已通用则无需改)

**Interfaces:** collect.mjs 的 toolCalls 数组每项含 `{name, input, turn, ok}` —— 已通用(不分 tool)。确认 load_skill 的 input.name 被正确保留。

- [ ] **Step 1: 确认 collect.mjs 保留 input(含 load_skill 的 name)**

```bash
cd /d/moss-eval
grep -n "input" harness/lib/collect.mjs | head -5
```

Expected: collect.mjs 在解析 tool_use 时已存 `input: c.input`(整个 input 对象),load_skill 的 name 在 input.name 里。**若已通用,无需改 collect.mjs**,run-skill-eval 的 score 直接从 run.toolCalls[].input.name 取。

- [ ] **Step 2: 若 collect 不保留 input,补丁**

若 Step 1 显示 collect 丢了 input(只存 name 不存 input),给 toolCalls 的每项加 `input: c.input`。但冒烟测显示 collect 已存 input(L3 任务里 exec 的 input.command 都能读到),故大概率无需改。**实现时确认即可**。

- [ ] **Step 3: 冒烟确认 load_skill 的 input 在 metrics 里**

跑一个 SK-01(code-review)单任务,确认 metrics.json 的 toolCalls 里有 load_skill + input.name:

```bash
cd /d/moss-eval
# 用 run-skill-eval 跑(Task 4 写好后)。Task 3 此步可跳过,在 Task 4 冒烟时一并验。
```

无需 commit(本 Task 多半无改动;若有 collect 改动再 commit)。

---

## Task 4: run-skill-eval.mjs(主入口)

**Files:**

- Create: `D:\moss-eval/harness/run-skill-eval.mjs`

**Interfaces:** CLI 入口 `--tasks --concurrency --ts --resume`。复用 runSubject + collect + pool,每任务 reset→run moss→collect,score-skill 判分,写 skill-accuracy.csv + samples。

- [ ] **Step 1: 写 run-skill-eval.mjs**

Create `D:\moss-eval\harness\run-skill-eval.mjs`:

```javascript
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { CONFIG } from './config.mjs';
import { SKILL_TASKS, SKILL_ROUNDS } from './tasks-skill.mjs';
import { reset } from './lib/reset.mjs';
import { runSubject } from './lib/run-subject.mjs';
import { collect } from './lib/collect.mjs';
import { runPool } from './lib/pool.mjs';
import { scoreSkill } from './score-skill.mjs';

function parseArgs(argv) {
  const a = { concurrency: 1, ts: null, resume: false, smoke: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--concurrency') a.concurrency = parseInt(argv[++i], 10);
    else if (argv[i] === '--ts') a.ts = argv[++i];
    else if (argv[i] === '--resume') a.resume = true;
    else if (argv[i] === '--smoke') a.smoke = true;
  }
  return a;
}
async function latestTs() {
  try {
    const d = (await fsp.readdir(path.join(CONFIG.runs, 'skill-eval')))
      .filter((x) => /^\d{8}-\d{6}$/.test(x))
      .sort();
    return d[d.length - 1] ?? null;
  } catch {
    return null;
  }
}
function tsStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

async function main() {
  const args = parseArgs(process.argv);
  const ts = args.ts ?? (args.resume ? await latestTs() : tsStamp());
  const tsDir = path.join('runs', 'skill-eval', ts);
  if (!ts && args.resume) {
    console.error('no skill-eval runs to resume');
    process.exit(1);
  }
  await fsp.mkdir(tsDir, { recursive: true });
  await fsp.mkdir(CONFIG.reports, { recursive: true });
  let tasks = SKILL_TASKS;
  if (args.smoke) tasks = SKILL_TASKS.slice(0, 1); // 只跑首个(SK-01 code-review)
  const rounds = [1];

  const units = [];
  for (const task of tasks)
    for (const round of rounds) units.push({ task, subject: 'moss', round });
  console.log(
    `skill-eval ts=${ts} tasks=${tasks.length} units=${units.length} concurrency=${args.concurrency} resume=${args.resume}`
  );

  const workFn = async (unit, workDir) => {
    reset(unit.task.reject ? 'skill-base' : 'skill-base', unit.task.cleanMode, workDir);
    const { status } = await runSubject('moss', unit.task, unit.round, workDir, `skill-eval/${ts}`);
    await collect(
      path.join(
        'runs',
        'skill-eval',
        ts,
        unit.task.id,
        'moss',
        `round-${unit.round}`,
        'stream.jsonl'
      ),
      'moss',
      unit.task.id,
      unit.round
    );
    return {
      terminalReason: status.terminalReason,
      durationMs: status.durationMs,
      costUsd: status.costUsd,
    };
  };
  await runPool(units, args.concurrency, `skill-eval/${ts}`, workFn);
  await aggregate(ts, args);
  console.log(`done. runs in runs/skill-eval/${ts}/, reports in reports/`);
}

async function aggregate(ts, args) {
  const csv = fs.createWriteStream(path.join(CONFIG.reports, 'skill-accuracy.csv'));
  const samples = [];
  csv.write(
    'taskId,kind,lang,reject,loadedSkills,loadedCount,expectedSkills,selectionCorrect,rejectCorrect,hallucinatedSkill,wrongSkill,nudgeFired,nudgeResponded,firstLoadTurn,repeatLoadCount,terminalReason\n'
  );
  for (const task of SKILL_TASKS) {
    for (let round = 1; round <= SKILL_ROUNDS; round++) {
      const mp = path.join(
        'runs',
        'skill-eval',
        ts,
        task.id,
        'moss',
        `round-${round}`,
        'metrics.json'
      );
      let m;
      try {
        m = JSON.parse(await fsp.readFile(mp, 'utf8'));
      } catch {
        continue;
      }
      // transcript text for nudge detection: 读 stream 里非 tool 的 text
      let transcriptText = '';
      try {
        const lines = (
          await fsp.readFile(
            path.join('runs', 'skill-eval', ts, task.id, 'moss', `round-${round}`, 'stream.jsonl'),
            'utf8'
          )
        )
          .split('\n')
          .filter(Boolean);
        transcriptText = lines
          .map((l) => {
            try {
              const e = JSON.parse(l);
              return (
                e.message?.content?.map((c) => (c.type === 'text' ? c.text : '')).join(' ') || ''
              );
            } catch {
              return '';
            }
          })
          .join(' ');
      } catch {}
      const s = scoreSkill(m, task, transcriptText);
      csv.write(
        `${task.id},${task.kind},${task.lang},${task.reject},${JSON.stringify(s.loadedSkills)},${s.loadedCount},${JSON.stringify(task.expectedSkills)},${s.selectionCorrect},${s.rejectCorrect},${JSON.stringify(s.hallucinatedSkill)},${JSON.stringify(s.wrongSkill)},${s.nudgeFired},${s.nudgeResponded},${s.firstLoadTurn ?? ''},${s.repeatLoadCount},${s.terminalReason}\n`
      );
      // 执行质量候选:有 load_skill 但要人工看是否真按方法做
      if (!task.reject && s.loadedSkills.length)
        samples.push({
          task: task.id,
          kind: task.kind,
          loaded: s.loadedSkills,
          terminal: s.terminalReason,
        });
      if (task.reject && !s.rejectCorrect)
        samples.push({ task: task.id, kind: 'reject-FAIL', loaded: s.loadedSkills });
    }
  }
  csv.end();
  await new Promise((r) => csv.on('finish', r));
  await fsp.writeFile(
    path.join(CONFIG.reports, 'skill-execution-samples.md'),
    '# Skill Execution Samples (manual review)\n\n## Loaded skill — verify it actually followed the skill method\n' +
      samples
        .filter((s) => s.kind !== 'reject-FAIL')
        .map(
          (s) =>
            `- ${s.task} [${s.kind}]: loaded ${JSON.stringify(s.loaded)} terminal=${s.terminal}`
        )
        .join('\n') +
      '\n\n## Reject tasks that WRONGLY loaded a skill (hardcoded skill)\n' +
      samples
        .filter((s) => s.kind === 'reject-FAIL')
        .map((s) => `- ${s.task}: wrongly loaded ${JSON.stringify(s.loaded)}`)
        .join('\n')
  );
  // summary
  const summary = computeSummary(ts);
  await fsp.writeFile(path.join(CONFIG.reports, 'skill-summary.md'), summary);
}

async function computeSummary(ts) {
  const rows = (await fsp.readFile(path.join(CONFIG.reports, 'skill-accuracy.csv'), 'utf8'))
    .trim()
    .split('\n')
    .slice(1);
  const parse = (r) => {
    const x = r.split(',');
    return {
      kind: x[1],
      lang: x[2],
      reject: x[3] === 'true',
      selCorrect: x[7] === 'true',
      rejCorrect: x[8] === 'true',
    };
  };
  const parsed = rows.map(parse);
  const single = parsed.filter((p) => p.kind === 'single');
  const multi = parsed.filter((p) => p.kind === 'multi');
  const reject = parsed.filter((p) => p.kind === 'reject');
  const zh = parsed.filter((p) => p.lang === 'zh' && p.kind !== 'reject');
  const en = parsed.filter((p) => p.lang === 'en' && p.kind !== 'reject');
  const pct = (arr, f) => {
    const n = arr.filter(f).length;
    return arr.length ? ((n / arr.length) * 100).toFixed(1) + '%' : 'n/a';
  };
  return `# moss skill-eval summary (ts=${ts})\n\n## 选择准确率\n- 单 skill: ${pct(single, (p) => p.selCorrect)} (${single.filter((p) => p.selCorrect).length}/${single.length})\n- 多 skill(集合包含): ${pct(multi, (p) => p.selCorrect)} (${multi.filter((p) => p.selCorrect).length}/${multi.length})\n- 拒识(不硬套): ${pct(reject, (p) => p.rejCorrect)} (${reject.filter((p) => p.rejCorrect).length}/${reject.length})\n\n## 语言差异\n- 中文 prompt: ${pct(zh, (p) => p.selCorrect)}\n- 英文 prompt: ${pct(en, (p) => p.selCorrect)}\n\n注:严格口径只认显式 load_skill 调用。执行质量见 skill-execution-samples.md(人工复核)。\n`;
}

main().catch((e) => {
  console.error('FATAL:', e);
  process.exit(1);
});
```

- [ ] **Step 2: 冒烟跑(--smoke 只跑 SK-01)**

```bash
cd /d/moss-eval
git -C fixtures/skill-eval/sample-lib checkout skill-base -- . 2>/dev/null
node harness/run-skill-eval.mjs --smoke --ts skill-smoke 2>&1 | tail -6
echo "=== csv ==="; cat reports/skill-accuracy.csv 2>/dev/null | head -3
echo "=== metrics has load_skill? ==="; node -e "const fs=require('fs');const d=JSON.parse(fs.readFileSync('runs/skill-eval/skill-smoke/SK-01/moss/round-1/metrics.json'));console.log('toolCalls:',d.toolCalls.map(c=>c.name).join(','));console.log('load_skill calls:',d.toolCalls.filter(c=>c.name==='load_skill').map(c=>c.input?.name))"
```

Expected: `done.` printed; csv 有表头 + SK-01 行;metrics 里能看到 toolCalls(可能含 load_skill,也可能 moss 没调 —— 两种都正常,看实际)。

- [ ] **Step 3: Commit**

```bash
cd /d/moss-eval
git add harness/run-skill-eval.mjs
git commit -m "feat(harness): skill-eval main runner (smoke single + aggregate → csv/samples/summary)"
```

---

## Task 5: 全量跑(37 任务 × moss × 1 轮)+ 产出报告

**Files:** 无代码改动,仅运行 + 生成报告。

**Interfaces:** 跑全量,产出 skill-accuracy.csv + skill-execution-samples.md + skill-summary.md。

- [ ] **Step 1: 冒烟确认 smoke 绿**

```bash
cd /d/moss-eval
node harness/run-skill-eval.mjs --smoke --ts skill-smoke 2>&1 | tail -3
```

Expected: `done.`,csv 有 SK-01 行。

- [ ] **Step 2: 全量跑(串行)**

```bash
cd /d/moss-eval
node harness/run-skill-eval.mjs --ts skill-trial1 2>&1 | tee runs/skill-trial1.log | tail -20
```

Expected: 37 单元跑完,进度行逐条打印。耗时 ~15-30 分钟(GLM + thinking)。中途某单元 FAILED 不影响后续。跑完:

```bash
wc -l reports/skill-accuracy.csv
cat reports/skill-summary.md
```

Expected: csv ~38 行(表头 + 37);summary 含选择准确率/拒识率/语言差。

- [ ] **Step 3: 看汇总,记录关键数字**

```bash
cd /d/moss-eval
cat reports/skill-summary.md
echo "=== 拒识失败(硬套 skill 的)==="; grep -c "reject-FAIL" reports/skill-execution-samples.md || echo 0
```

记录:单 skill 准确率、多 skill 准确率、拒识准确率、中英差。

- [ ] **Step 4: Commit 产物**

```bash
cd /d/moss-eval
git add reports/
git commit -m "data: skill-eval trial1 (37 tasks, moss, selection accuracy + reject + lang)"
```

- [ ] **Step 5: 据 trial1 耗时/成本决定是否补 N=3**

看 runs/skill-trial1.log 末尾成本(若 moss cost 仍 N/A 则无成本数据)。与用户确认:单轮够了 vs 补 N=3 强化。

---

## Self-Review

**1. Spec coverage:**

- 17 单 skill 任务 → Task 1 (SK-01..17,覆盖全部 17 skill)。✓
- 10 多 skill 任务 → Task 1 (SK-M1..10)。✓
- 10 拒识任务(4 类含陷阱)→ Task 1 (SK-R1..10)。✓
- 选择准确率(自动,只认 load_skill)→ Task 2 scoreSkill。✓
- 执行质量(人工)→ Task 4 aggregate 写 skill-execution-samples.md。✓
- 拒识准确率 → Task 2 rejectCorrect。✓
- 多 skill 召回(集合包含)→ Task 2 selectionCorrect(集合⊇)。✓
- 幻觉 skill / 误选 → Task 2 hallucinatedSkill / wrongSkill。✓
- nudge 触发/响应(辅助)→ Task 2 nudgeFired/nudgeResponded(从 transcriptText 推断)。✓
- 中英差 → Task 4 computeSummary 按 lang 分组。✓
- 首次加载轮数 / 重复 load → Task 2 firstLoadTurn/repeatLoadCount。✓
- web-research 跑只判选择 → Task 1 SK-11 是单 skill 任务,判 load_skill('web-research')。✓

**2. Placeholder scan:** Task 3 Step 2「若 collect 不保留 input,补丁」是条件分支,落地时确认即可(冒烟测显示 collect 已存 input,大概率无需改)。无 TODO/TBD。✓

**3. Type/signature consistency:**

- `scoreSkill(run, task, transcriptText)` → 指标对象,Task 4 aggregate 消费。✓
- `SKILL_TASKS` 每项 `{id, kind, reject, lang, workDir, cleanMode, prompt, expectedSkills}` —— Task 1 定义,Task 4 消费(workFn 用 task.reject/workDir/cleanMode,aggregate 用 task.kind/lang/reject/expectedSkills)。✓
- `runPool(units, concurrency, ts, workFn)` —— 复用现有签名。workFn 用 `reset('skill-base', cleanMode, workDir)`。✓
- `runSubject('moss', task, round, workDir, 'skill-eval/'+ts)` —— 复用现有签名,ts 前缀加 skill-eval/。✓
- `collect(streamPath, 'moss', task.id, round)` —— 复用现有签名。✓
- 一处需注意:run-skill-eval 的 ts 目录是 `runs/skill-eval/<ts>`(不同于 L2/L3 的 `runs/<ts>`),runSubject 的 outDir 由 ts 参数拼成 —— 需确认 runSubject 不会在 ts 前再加 runs/。**实现时验证 runSubject 的 outDir 拼接**(`path.join(CONFIG.runs, ts, ...)`)—— 若 CONFIG.runs='runs',传 ts='skill-eval/skill-trial1' 会拼成 `runs/skill-eval/skill-trial1`,正确。✓
