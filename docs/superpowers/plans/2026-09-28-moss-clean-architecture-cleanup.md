# Moss 架构与代码整洁化实施计划

> **For agentic workers:** Use the current runtime's plan-execution workflow to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在不新增任何功能、不改变任何对外行为的前提下，消除 Moss 的分层依赖违规、合并复制粘贴代码、拆解巨型多职责文件，并把分层规则固化为 ESLint 守护，使代码库符合《代码整洁之道》与《架构整洁之道》。

**Architecture:** 以"依赖只能指向内层"为唯一分层原则，将 `src/contracts/` 确立为共享内核（消息与工具结果领域类型归位），`core` 为用例层（持有端口），`provider` / `tools` 为外层适配器/实现，`cli` 为最外层 UI。复制粘贴的 nudge 家族与三套错误分类合并为"一处实现 + 声明式数据"。巨型文件按职责拆为同目录协作模块，入口文件保留薄 re-export 以维持 `dist/*.js` 路径兼容（测试直接 import dist）。

**Tech Stack:** TypeScript 5.7 ESM / Node ≥22.16 / ESLint 10（`no-restricted-imports` 做边界守护）/ 既有 `npm run verify` 门禁（format:check + lint + typecheck + test + smoke）。

---

## 0. 现状审计结论（2026-09-28，全部有据）

代码规模：`src/` 264 个 TS 文件、约 55,700 行；`test/` 138 个 spec。git 树干净，`npm run verify` 基线待 Phase 0 确认。

### 0.1 架构问题（依赖方向违规，按严重度排序）

| #   | 违规                             | 证据                                                                                                                                                                                                                                                                   | 根因                                                                                             |
| --- | -------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| A1  | `tools → cli`（运行时依赖）      | `src/tools/ask-user-question.ts:10` import `getCliUserQuestionAsker` from `../cli/approval.js`                                                                                                                                                                         | 工具层直接调用 UI 层服务定位器，未做端口反转                                                     |
| A2  | 共享内核错位                     | `Message`/`ContentBlock`/`SessionEntry` 等领域类型定义在 `src/core/session/session-jsonl-types.ts`，被 `src/context/` 11 个文件、`core/loop`、`core/tools`、`core/subagent`、`core/agent`、`provider` 全量引用                                                         | 最核心的领域概念埋在 session 存储子模块，导致 `context → core` 12 条边、`provider → core` 部分边 |
| A3  | `provider → core` 越界（非端口） | `pi-ai-watchdog.ts:1` → `core/agent/abort.ts`（仅用 `combineAbortSignals` 纯工具）；`pi-ai-wire-format.ts:2-3` → `core/loop/follow-up-guard.ts` + `core/tools/message-convert.ts`（仅用两个纯谓词）；`multi-provider-router.ts:7` → `core/llm/llm-error-classifier.ts` | 协议适配层反向依赖业务层；被依赖的其实是应下沉的纯函数                                           |
| A4  | `core → tools` 具体实现          | `core/loop/agent-loop.ts:40-42`、`core/loop/agent-loop-tool-execution.ts:29` → `tools/background-completion-reminder.ts`                                                                                                                                               | 用例层依赖具体工具模块（该模块实为 loop 基础设施状态）                                           |
| A5  | provider ↔ core/llm 循环         | `core/llm/llm-error-classifier.ts` import `provider/errors.ts`，同时 `provider/multi-provider-router.ts` import 该 classifier                                                                                                                                          | 错误分类职责三处平行实现（见 B2）                                                                |
| A6  | 库入口泄漏 UI 层                 | `src/index.ts` re-export `cli/config`、`cli/config-manager`、`cli/model-catalog-manager`、`cli/cli-services`（28 条 `(root) → cli` 边中的主要部分）                                                                                                                    | 包为 `"private": true`，SDK 入口不应暴露 CLI                                                     |
| A7  | 无分层守护                       | `eslint.config.mjs` 无任何 import 边界规则                                                                                                                                                                                                                             | 违规只能靠人肉发现，会再生长                                                                     |

`core/loop/loop-scheduler.ts:22` → `core/agent/moss-agent.ts` 已是 `import type`（无运行时循环），列为可选优化，不在本计划强制项内。

### 0.2 代码整洁问题

| #   | 问题                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 证据                                                         |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| B1  | **nudge 家族复制粘贴**：30 个文件 / 2,229 行，其中约 23 个是完全同构的模板（`attempts 守卫 → totalToolCalls 守卫 → 证据判定 → user 正则 → 概念问题豁免 → correction 文案`）；`agent-loop.ts` 内另有 29 个 `inject*` 闭包 + 29 个 `if/push` 调用点（约 450 行样板）。安全网：28 个 nudge spec 已存在                                                                                                                                                                                               | `src/core/loop/*-nudge.ts`；`agent-loop.ts:351-720, 764-720` |
| B2  | **错误分类三套平行词汇表**：`provider/error-classify.ts`（`ProviderErrorCategory` 17 类 + 510 行）、`provider/errors.ts`（谓词 + `FailoverReason` 7 类）、`core/llm/llm-error-classifier.ts`（`LlmErrorCategory` 12 类）。判定逻辑（status/消息正则）多处重复                                                                                                                                                                                                                                     | 三个文件互相 import                                          |
| B3  | **巨型多职责文件（SRP）**：`tools/web-search.ts` 1902 行（8 个后端 + HTTP 重试 + 结果合并/去重/多样化 + 工具定义）；`cli/tui-utils.ts` 1690 行（名称已失实：ink TUI 已删，实为 REPL 支撑杂物箱：终端消毒/队列/进程树/本地 shell/resume 回放/markdown 表格/常量）；`cli/setup.ts` 1287 行（setup 向导 + config show/validate/set/unset/init + auth logout + onboarding 提示）；`core/agent/moss-agent.ts` 1250；`core/loop/agent-loop.ts` 1233；`cli/config.ts` 1193；`context/compaction.ts` 1169 | `wc -l` 排序                                                 |
| B4  | **疑似死导出约 105 个**（仅在定义文件出现一次；含 `cli/theme`、`cli/tui-utils`、`cli/approval` 的导出集合）。需逐一核对 `src/` + `test/`（测试 import dist）后删除                                                                                                                                                                                                                                                                                                                                | 符号级扫描                                                   |
| B5  | 桶文件松散：`index.ts` / `core/index.ts` 等大量 `export *`，公共面无边界                                                                                                                                                                                                                                                                                                                                                                                                                          | `src/index.ts`、`src/core/index.ts`                          |

### 0.3 目标依赖方向（本计划完成后强制）

```
contracts（共享内核：消息模型、工具结果模型、soul、async-task、prompts）
   ↑ 无外部依赖
errors.ts / logger.ts（根）
   ↑
utils        ← errors/logger
safety       ← errors, utils
provider     ← contracts, errors, utils, safety（实现 core/llm 端口合法）
context      ← contracts, errors, utils, safety
core         ← contracts, errors, utils, safety, provider, context
tools        ← contracts, errors, utils, safety, core, context, provider
cli          ← 以上一切
cli-main.ts  ← 以上一切
index.ts     ← 除 cli 外的一切（SDK 面，不含 UI）
```

禁止：任何模块 import `cli/`（除 cli 自身与 cli-main）；`context` import `core`；`provider` import `core`（唯一豁免：`core/llm/llm-provider` 端口）；`core` import `tools`；`contracts` import 任何上层。

### 0.4 非目标（明确不做）

- 不新增功能、不改任何工具/命令/prompt 的对外行为（所有 spec 断言不变即通过标准）。
- 不更换测试框架、不引入新依赖（含 dependency-cruiser 等）。
- 不移动 `core/llm/llm-provider.ts` 端口本身（provider 实现该端口的现方向正确）。
- 不做 `moss-agent.ts` / `config.ts` / `compaction.ts` 的深度拆分（列为 stretch，仅在前序全绿后可选执行）。

---

## Phase 0 — 基线与行为锁（安全网）

> 原则：先证明绿，再锁没有 spec 覆盖的重构目标，最后才动结构。特征测试锁的是**现状**（probe 输出即期望值），不是理想。

### Task 0.1: 记录基线

- [ ] **Step 1: 运行完整验证并记录结果**

Run: `npm run verify 2>&1 | tail -20`
Expected: format:check / lint / typecheck / test / smoke 全部通过。若有失败，停止本计划，先修复基线。

- [ ] **Step 2: Commit（仅当基线本来就有未提交内容时；正常情况下工作树干净，跳过 commit）**

### Task 0.2: 为 `cli/setup.ts` 补特征测试（它没有任何直接 spec，Phase 6 要拆它）

**Files:**

- Create: `test/cli-setup-commands.spec.mjs`

- [ ] **Step 1: 探针确认现状行为（特征值以探针实际输出为准）**

Run:

```bash
npm run build >/dev/null && node -e '
const s = await import("./dist/cli/setup.js").then(m => m.default ?? m);
const logs = [];
const orig = console.log; console.log = (...a) => logs.push(a.join(" "));
s.renderConfigUsage();
console.log = orig;
console.log("=== renderConfigUsage 输出前 5 行 ===");
console.log(logs.join("\n").split("\n").slice(0,5).join("\n"));
' --input-type=module
```

Expected: 打印 usage 文本。记下首行与关键标记（如 `config` 字样行）。

- [ ] **Step 2: 写特征 spec（断言来自 Step 1 探针）**

```js
// test/cli-setup-commands.spec.mjs
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as setup from '../dist/cli/setup.js';

function captureLog(fn) {
  const out = [];
  const orig = console.log;
  console.log = (...a) => out.push(a.join(' '));
  try {
    fn();
  } finally {
    console.log = orig;
  }
  return out.join('\n');
}

test('renderConfigUsage prints usage overview', () => {
  const text = captureLog(() => setup.renderConfigUsage());
  assert.ok(text.length > 0);
  assert.match(text, /config/i); // 探针确认后可替换为更精确的首行断言
});

test('runConfigSet writes key into config file and validates', () => {
  const dir = mkdtempSync(join(tmpdir(), 'moss-setup-spec-'));
  const cfgPath = join(dir, 'config.yaml');
  writeFileSync(cfgPath, '# empty\n', 'utf8');
  // 探针步骤确认 startDir 语义与配置文件名后，按现状固化：
  setup.runConfigSet(['model', 'glm-4.6'], dir);
  const text = readFileSync(cfgPath, 'utf8');
  assert.match(text, /model/);
});
```

（`runConfigSet` 的落盘文件名/位置若与上面假设不符，以 Step 1 探针实跑结果修正断言；断言对象是"现状输出/落盘"，不是设计意图。）

- [ ] **Step 3: 运行并确认通过**

Run: `npm run build && node scripts/run-package-tests.mjs -- --filter cli-setup-commands`（或 `npm run test:filter -- --filter cli-setup-commands`）
Expected: PASS。测试红→修断言到现状→绿，才算"锁"。

- [ ] **Step 4: Commit**

```bash
git add test/cli-setup-commands.spec.mjs
git commit -m "test(cli): characterize setup config commands before split"
```

### Task 0.3: 为 `cli/tui-utils.ts` 核心纯函数补特征测试

**Files:**

- Create: `test/cli-tui-utils-core.spec.mjs`

已有 5 个 spec 引用 `dist/cli/tui-utils.js`，但集中在渲染路径。补队列/消毒/截断的纯函数面：

- [ ] **Step 1: 探针**

Run: `npm run build >/dev/null && node --input-type=module -e '
import * as t from "./dist/cli/tui-utils.js";
console.log(JSON.stringify(t.sanitizeTextForTerminal("\u001b[31mred\u001b[0m\ttext")));
console.log(JSON.stringify(t.truncateTerminalText("abcdef", 3)));
console.log(t.queueItemKind({ kind: "message", text: "hi" } ?? {}));
'`
Expected: 打印三个实际返回值（形状以实跑为准，`queueItemKind` 的入参形状先 `grep -n "QueuedInput" src/cli/tui-utils.ts` 确认联合分支）。

- [ ] **Step 2: 写 spec（断言 = 探针输出）**

```js
// test/cli-tui-utils-core.spec.mjs
import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import {
  sanitizeTextForTerminal,
  truncateTerminalText,
  dropLastQueuedInput,
} from '../dist/cli/tui-utils.js';

test('sanitizeTextForTerminal strips ANSI escapes (characterization)', () => {
  assert.equal(sanitizeTextForTerminal('\u001b[31mred\u001b[0m'), 'red'); // 以探针实跑为准
});

test('truncateTerminalText cuts to width (characterization)', () => {
  assert.equal(truncateTerminalText('abcdef', 3).length <= 4, true); // 以探针实跑为准
});

test('dropLastQueuedInput keeps others intact (characterization)', () => {
  const items = [
    { kind: 'message', text: 'a' },
    { kind: 'message', text: 'b' },
  ];
  const { items: rest } = dropLastQueuedInput(items);
  assert.equal(rest.length, 1);
});
```

- [ ] **Step 3: 运行 `npm run test:filter -- --filter cli-tui-utils-core` → PASS**

- [ ] **Step 4: Commit** `git commit -m "test(cli): characterize tui-utils pure helpers before split"`

---

## Phase 1 — 分层守护规则（先立规矩，豁免现状，后续逐阶段收紧）

### Task 1.1: ESLint 边界规则

**Files:**

- Modify: `eslint.config.mjs`

- [ ] **Step 1: 在 `export default tseslint.config(` 的 src 配置块之后追加（完整代码，豁免项与 0.1 的违规清单一一对应）**

```js
  // ---- 架构边界：依赖只能指向内层（见 docs/superpowers/plans/2026-09-28-moss-clean-architecture-cleanup.md §0.3）
  {
    name: 'moss/boundary-root',
    files: ['src/errors.ts', 'src/logger.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ regex: '\\.', message: '根级 errors/logger 不得依赖任何模块' }] }],
    },
  },
  {
    name: 'moss/boundary-contracts',
    files: ['src/contracts/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { regex: '\\.\\./(errors|logger|utils|safety|provider|context|core|tools|cli)', message: 'contracts 是共享内核，不得依赖上层模块' },
          ],
        },
      ],
    },
  },
  {
    name: 'moss/boundary-utils-safety',
    files: ['src/utils/**/*.ts', 'src/safety/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { regex: '\\.\\./(safety|provider|context|core|tools|cli)/', message: 'utils/safety 是底层，不得依赖上层模块' },
          ],
        },
      ],
    },
  },
  {
    name: 'moss/boundary-provider',
    files: ['src/provider/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // 豁免（随 Phase 3/5 收紧）：
              //   llm/llm-provider           —— 端口，长期合法
              //   agent/abort                —— T3.2 移除
              //   loop/follow-up-guard,
              //   tools/message-convert      —— T3.2 移除
              //   llm/llm-error-classifier   —— T5.1 移除
              regex: '\\.\\./core/(?!llm/llm-provider|agent/abort|loop/follow-up-guard|tools/message-convert|llm/llm-error-classifier)',
              message: 'provider 只允许依赖 core/llm 端口；其余 core 依赖均为越界',
            },
            { regex: '\\.\\./cli/', message: 'provider 不得依赖 UI 层' },
          ],
        },
      ],
    },
  },
  {
    name: 'moss/boundary-context',
    files: ['src/context/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // 豁免（Phase 2 移除）：session-jsonl*、core/tools/tool-types
              regex: '\\.\\./core/(?!session/session-jsonl|tools/tool-types)',
              message: 'context 不得依赖 core；共享类型走 contracts（Phase 2 归位）',
            },
            { regex: '\\.\\./cli/', message: 'context 不得依赖 UI 层' },
          ],
        },
      ],
    },
  },
  {
    name: 'moss/boundary-core',
    files: ['src/core/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // 豁免（Phase 3 移除）：tools/background-completion-reminder
              regex: '\\.\\./(\\./)?(\\.{2}/)?tools/(?!background-completion-reminder)',
              message: 'core 只依赖 contracts/provider/context；具体工具实现禁止（background-completion-reminder 例外将于 T3.3 移除）',
            },
          ],
        },
      ],
    },
  },
  {
    name: 'moss/boundary-tools',
    files: ['src/tools/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              // 豁免（T3.1 移除）：../cli/approval
              regex: '\\.\\./cli/(?!approval)',
              message: '工具层不得依赖 UI 层（ask-user-question 的 approval 依赖将于 T3.1 端口化）',
            },
          ],
        },
      ],
    },
  },
```

注意：`no-restricted-imports` 的 `patterns.regex` 需 ESLint ≥8.31（本项目 10.x，可用）。`moss/boundary-core` 中匹配 `../../tools/` 与 `./tools/` 两种相对深度——如果上面的 regex 不能同时命中两种写法，改为两条 pattern：`regex: '\\.\\./\\.\\./tools/(?!background-completion-reminder)'` 与 `regex: '\\.\\./tools/(?!background-completion-reminder)'`。

- [ ] **Step 2: 验证规则正好命中现状豁免、不误报**

Run: `npm run lint`
Expected: 0 error 0 warning。若报出**豁免清单之外**的新违规，说明审计有遗漏——记录之并追加到对应 Phase 的任务里，不要放宽规则。

- [ ] **Step 3: Commit**

```bash
git add eslint.config.mjs
git commit -m "feat(lint): enforce architecture layering with no-restricted-imports"
```

---

## Phase 2 — 共享内核归位：领域类型迁入 `contracts`（消 A2）

> 迁移物：`Message`、`ContentBlock`、`SessionEntry` 家族、`CURRENT_SESSION_VERSION`、`COMPACTION_SUMMARY_*`、`createCompactionSummaryMessage`（来自 `core/session/session-jsonl-types.ts`），以及 `ToolContentBlock`、`ToolResultOutcome`（来自 `core/tools/tool-types.ts`，`ContentBlock` 依赖它们）。

### Task 2.1: 创建 `src/contracts/messages.ts`

**Files:**

- Create: `src/contracts/messages.ts`

- [ ] **Step 1: 原样迁移代码（内容 = 现文件逐字拷贝，只改 import 来源）**

```ts
// src/contracts/messages.ts
/**
 * 领域消息模型 —— 全仓库共享内核。
 * 从 core/session/session-jsonl-types.ts 与 core/tools/tool-types.ts 归位而来，
 * 内容逐字保留（含 JSDoc），仅调整 import。
 */

// ---- 原 core/tools/tool-types.ts 中 ToolResultOutcome / ToolContentBlock 段落 ----
export type ToolResultOutcome = 'ok' | 'error' | 'denied' | 'blocked' | 'replayed' | 'suppressed';
// （ToolContentBlock 的完整联合类型定义从 tool-types.ts:183 起逐字拷贝至此）

// ---- 原 core/session/session-jsonl-types.ts 全文（Message、ContentBlock、
//      CURRENT_SESSION_VERSION、SessionHeaderEntry、SessionEntryBase、MessageEntry、
//      CompactionEntry、SessionEntry、SessionFileEntry、COMPACTION_SUMMARY_PREFIX/SUFFIX、
//      createCompactionSummaryMessage），删除其对 ../tools/tool-types.js 的 import ----
```

- [ ] **Step 2: 在 `src/contracts/index.ts` 追加 `export * from './messages.js';`（类型+常量+工厂函数）**

### Task 2.2: 原位置改为薄 re-export（临时，同 commit 内完成全量 import 切换后删除）

**Files:**

- Modify: `src/core/session/session-jsonl-types.ts` → `export * from '../../contracts/messages.js';`（最终在本任务 Step 3 删除该文件）
- Modify: `src/core/tools/tool-types.ts` → 删除被迁走的两个类型定义，改为 `export type { ToolResultOutcome, ToolContentBlock } from '../../contracts/messages.js';`

### Task 2.3: 全量切换 import 并删除垫片

- [ ] **Step 1: 找出全部引用方**

Run: `grep -rl "session-jsonl-types\|session-jsonl.js" src | sort`（`session-jsonl.ts` 桶文件也在内）
Run: `grep -rn "from '.*tool-types.js'" src/context` （确认 context 侧引用点）

已知清单（执行时以 grep 为准）：`src/context/` 11 个文件（compaction、deterministic-summary、message-tool-helpers、microcompact、pruning、remote-compaction、stale-read-invalidate、summary-checkpoint-merge、tail-tool-snip、tokens）、`src/core/loop/*`、`src/core/tools/*`、`src/core/subagent/*`、`src/core/agent/*`、`src/core/session/*`。

- [ ] **Step 2: 跨模块引用改指 `contracts`（`import type` 语义保持不变）；`core/session/` 内部与 `session-jsonl.ts` 桶改从 `contracts/messages.js` re-export；删除 `session-jsonl-types.ts`**

- [ ] **Step 3: 收紧 Phase 1 豁免**

`eslint.config.mjs` 中 `moss/boundary-context` 的 regex 改为 `\\.\\./core/`（无豁免），删除 `session-jsonl|tools/tool-types` 分支。

- [ ] **Step 4: 验证**

Run: `npm run typecheck && npm run lint && npm run test`
Expected: 全绿（所有 session/loop/context 相关 spec 不改断言通过——纯类型移动不影响运行时）。
Run: `node -e "import('./dist/core/session/session-jsonl.js').then(m=>console.log(typeof m.createCompactionSummaryMessage))"`
Expected: `function`（桶仍可用）。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "refactor(contracts)!: move message domain types into contracts shared kernel

session-jsonl-types eliminated; context no longer depends on core.
No runtime behavior change; all specs pass unchanged."
```

---

## Phase 3 — 边界依赖反转（消 A1 / A3 / A4 / A6）

### Task 3.1: `ask_user_question` 端口化（消 tools → cli）

**Files:**

- Create: `src/core/tools/user-question-asker.ts`
- Modify: `src/tools/ask-user-question.ts`
- Modify: `src/cli/approval.ts`（或其装配点）

- [ ] **Step 1: 定义端口（core 持有端口，外层实现）**

```ts
// src/core/tools/user-question-asker.ts
/**
 * 端口：交互式用户提问通道。
 * core 定义端口；CLI 在装配时通过 setUserQuestionAsker 注入实现；
 * 未注入（headless/embedding）时 ask_user_question 返回明确错误。
 */
export interface UserQuestionRequest {
  prompt: string;
  options?: { label: string; description?: string }[];
  multiSelect?: boolean;
}

export interface UserQuestionAnswer {
  text: string;
  selected?: string[];
}

export type UserQuestionAsker = (request: UserQuestionRequest) => Promise<UserQuestionAnswer>;

let asker: UserQuestionAsker | undefined;

export function setUserQuestionAsker(instance: UserQuestionAsker | undefined): void {
  asker = instance;
}

export function getUserQuestionAsker(): UserQuestionAsker | undefined {
  return asker;
}
```

- [ ] **Step 2: 改写 `src/tools/ask-user-question.ts`**
  - 删除 `import { getCliUserQuestionAsker } from '../cli/approval.js'`，改用 `getUserQuestionAsker()`。
  - 现有 `getCliUserQuestionAsker` 的调用行为（无 asker 时的错误返回文案、prompt 格式）**逐字保留**——只换解析函数来源。先读 `ask-user-question.ts` 中 asker 的全部调用点再动。

- [ ] **Step 3: CLI 侧注入**
  - `src/cli/approval.ts` 里 `getCliUserQuestionAsker` 的实现逻辑改为同时调用 `setUserQuestionAsker(...)`（在 CLI 启动装配处，即现有 `setCliUserQuestionAsker` 被调用的位置，追加一行 `setUserQuestionAsker(cliAsker)`；具体装配点用 `grep -rn "setCliUserQuestionAsker" src` 定位）。

- [ ] **Step 4: 收紧豁免并验证**

`eslint.config.mjs` `moss/boundary-tools` regex 改为 `\\.\\./cli/`（无豁免）。
Run: `npm run typecheck && npm run lint && npm run test:filter -- --filter cli-security && npm run test:filter -- --filter harness`
Expected: 全绿；`grep -rn "cli/" src/tools/` 返回空。

- [ ] **Step 5: Commit** `git commit -m "refactor(tools): invert ask_user_question dependency onto core port"`

### Task 3.2: provider 越界依赖下沉（消 3 条 provider → core 边）

- [ ] **Step 1: `combineAbortSignals` 下沉到 utils**

Create `src/utils/abort-signals.ts`：将 `src/core/agent/abort.ts` 中 `combineAbortSignals` 函数**逐字**移入（含 JSDoc）。`core/agent/abort.ts` 改为 re-export 该符号（保持其对外形状）。`src/provider/pi-ai-watchdog.ts:1` 改 import `../../utils/abort-signals.js`。
Run: `node -e "import('./dist/core/agent/abort.js').then(m=>console.log(typeof m.combineAbortSignals))"` → `function`（re-export 生效）。

- [ ] **Step 2: 两个纯谓词移入 provider**

Create `src/provider/reasoning-policy.ts`：将 `shouldSuppressReasoningForToolFollowUpRound`（来自 `core/loop/follow-up-guard.ts`）与 `shouldRoundTripAssistantThinking`（来自 `core/tools/message-convert.ts`）**逐字**移入（含依赖的模块级常量，若有）。

- `pi-ai-wire-format.ts:2-3` 改 import `./reasoning-policy.js`。
- `core/loop/follow-up-guard.ts` 与 `core/tools/message-convert.ts` 改从 `../../provider/reasoning-policy.js` re-export/引用（core → provider 方向合法，与既有 `pi-ai-types` 引用一致）。
- 验证谓词纯度：两函数不得引用 session/loop 状态——若实现里引用了上层类型，仅以 `import type` 引入 contracts 类型。

- [ ] **Step 3: `multi-provider-router` 的 classifier 依赖留给 T5.1（整体移动 classifier 时自然消除），本任务不改。**

- [ ] **Step 4: 收紧豁免并验证**

`moss/boundary-provider` regex 豁免移除 `agent/abort|loop/follow-up-guard|tools/message-convert`，仅剩 `llm/llm-provider|llm/llm-error-classifier`。
Run: `npm run typecheck && npm run lint && npm run test:filter -- --filter pi-ai && npm run test:filter -- --filter loop-follow-up-guard`
Expected: 全绿。

- [ ] **Step 5: Commit** `git commit -m "refactor(provider): sink pure helpers to break provider->core boundary"`

### Task 3.3: `background-completion-reminder` 归位 core/loop（消 core → tools）

**Files:**

- Move: `src/tools/background-completion-reminder.ts` → `src/core/loop/background-completion.ts`
- Modify: importers

- [ ] **Step 1: 判定归属**。该模块是 loop 的待汇报后台任务状态机（`ensureBackgroundCompletionTracker` / `buildBackgroundCompletionSystemText`），被 loop 两处消费；工具侧（`background-exec.ts`）只是写入方。→ 属于 loop 基础设施。
- [ ] **Step 2: `git mv src/tools/background-completion-reminder.ts src/core/loop/background-completion.ts`，内部 import 路径相应调整（`./background-exec.js` → 若有，改为 `../../tools/background-exec.js`，tools→core 方向不变时反之确认——以 grep 实际 import 为准）。**
- [ ] **Step 3: 更新引用方**：`core/loop/agent-loop.ts:40-42`、`core/loop/agent-loop-tool-execution.ts:29` 改 `./background-completion.js`；`src/index.ts` 与 `src/tools/background-completion-state.ts`（若引用）同步；`test/background-completion-reminder.spec.mjs`、`test/background-completion-user-visible.spec.mjs` 的 import 路径改为 `../dist/core/loop/background-completion.js`（**断言不动**）。
- [ ] **Step 4: 收紧豁免**：`moss/boundary-core` regex 移除 background-completion-reminder 豁免。
      Run: `npm run typecheck && npm run lint && npm run test:filter -- --filter background-completion`
- [ ] **Step 5: Commit** `git commit -m "refactor(core): move background completion tracker into loop (break core->tools edge)"`

### Task 3.4: 库入口移除 CLI re-export（消 A6）

**Files:**

- Modify: `src/index.ts`

- [ ] **Step 1: 删除 index.ts 中 4 个 CLI re-export 块**（`auditResolvedCliConfig`/`isBroadTrustedToolPattern`/`ConfigManager`/`ModelCatalog`/`CliServices`）。
- [ ] **Step 2: 证明无消费者**：Run: `grep -rn "from 'moss'" --include="*.ts" --include="*.mjs" src test scripts` → 空；`grep -rn "dist/index.js" test` 仅 `loop-pending-tool-aborts.spec.mjs`（用 `PendingToolAbortStore`，与 CLI 无关）与 markdown 示例字符串。
- [ ] **Step 3: 验证**：`npm run typecheck && npm run lint && npm test`（`loop-pending-tool-aborts` 必须仍绿）。
- [ ] **Step 4: Commit** `git commit -m "refctor(api)!: drop CLI surface from SDK entry point"`（注意修正拼写为 `refactor`）

---

## Phase 4 — Nudge 声明式注册表合并（消 B1，删 ~2,000+ 行样板）

### Task 4.1: 创建共享模板

**Files:**

- Create: `src/core/loop/nudges/template.ts`

- [ ] **Step 1: 模板代码（守卫顺序与现状一致的纯合取，语义等价）**

```ts
// src/core/loop/nudges/template.ts
import { collectExecCommands, isConceptualQuestion } from '../nudge-helpers.js';
import type { NudgeMessage, NudgeRequest, NudgeResult } from '../nudge-helpers.js';

export const TOOLS_NUDGE_MAX_ATTEMPTS = 1;

export interface NudgeEvidenceContext {
  messages: NudgeMessage[] | undefined;
  toolCallsByName: Record<string, number>;
  totalToolCalls: number;
}

export interface ToolsNudgeSpec {
  /** 用户请求正则（原 X_USER_RE 逐字拷贝） */
  userRe: RegExp;
  /** 动作词正则（原 X_ACTION_RE；提供则自动套用 isConceptualQuestion 豁免） */
  actionRe?: RegExp;
  /** 证据判定（原 saw*Evidence 函数体逐字拷贝） */
  sawEvidence: (ctx: NudgeEvidenceContext) => boolean;
  /** 额外用户文本豁免（如 git-nudge 的"仅询问状态"分支），可选 */
  extraUserExempt?: (userText: string) => boolean;
  /** 触发后注入的纠正文案（原 correction 逐字拷贝） */
  correction: string;
}

export function defineToolsNudge(spec: ToolsNudgeSpec) {
  return function evaluate(request: NudgeRequest): NudgeResult {
    if (request.attempts >= TOOLS_NUDGE_MAX_ATTEMPTS) return { fire: false };
    if (request.totalToolCalls < 1) return { fire: false };
    if (
      spec.sawEvidence({
        messages: request.messages,
        toolCallsByName: request.toolCallsByName,
        totalToolCalls: request.totalToolCalls,
      })
    ) {
      return { fire: false };
    }
    const user = (request.userText || '').trim();
    if (!user || !spec.userRe.test(user)) return { fire: false };
    if (spec.actionRe && isConceptualQuestion(user, spec.actionRe)) return { fire: false };
    if (spec.extraUserExempt && spec.extraUserExempt(user)) return { fire: false };
    return { fire: true, correction: spec.correction };
  };
}
```

> 等价性论证（写进 commit message）：所有被合并 nudge 的守卫均为**无副作用的否定合取**（attempts / totalToolCalls / evidence / userRe / conceptual / exempt），合取与顺序无关，模板与原实现语义等价。`git-tools-nudge` 的 status-only 豁免通过 `extraUserExempt` 承载。

- [ ] **Step 2: Commit** `git commit -m "refactor(loop): add declarative nudge template"`

### Task 4.2: 逐文件转换 23 个模板型 nudge

**Files:**

- Create: `src/core/loop/nudges/`（目录）
- 23 个转换对象：`audit-、build-、codegen-、contract-visual-、coverage-、docker-、e2e-、eval-、format-、install-、lighthouse-a11y-、migrate-、mutation-fuzz-、publish-deploy-、run-tests-、seed-、smoke-load-、snapshot-、storybook-、web-、git-`（git 带 `extraUserExempt`）+ 经核对同构的其余 2 个（以逐文件比对模板六要素为准）

- [ ] **Step 1: 转换规则（机械、零判断空间）**：每个 `src/core/loop/X-nudge.ts` → `src/core/loop/nudges/X-nudge.ts`，新文件形如：

```ts
// src/core/loop/nudges/git-tools-nudge.ts（示例：git 因带 extraUserExempt 最复杂）
/**
 * GitToolsNudge — mid-run reminder when the user asked to commit/push/open a PR/
 * review/approve/tag/release/file an issue but no git/gh exec has run yet.
 * Soft: max 1 fire. Pairs with evaluateInventedGitCompletionGate.
 */
import { collectExecCommands } from '../nudge-helpers.js';
import { defineToolsNudge } from './template.js';

export const GIT_TOOLS_NUDGE_MAX_ATTEMPTS = 1;

export type GitToolsNudgeRequest = import('../nudge-helpers.js').NudgeRequest;
export type GitToolsNudgeResult = import('../nudge-helpers.js').NudgeResult;

export const evaluateGitToolsNudge = defineToolsNudge({
  userRe: /(?:\bgit\s+commit\b|…原 GIT_USER_RE 逐字拷贝…)/iu,
  sawEvidence: ({ messages, toolCallsByName }) => {
    if ((toolCallsByName.git_commit ?? 0) > 0 || (toolCallsByName.git_push ?? 0) > 0) return true;
    for (const cmd of collectExecCommands(messages)) {
      if (/\bgit\b|\bgh\s+(?:pr|release|issue)\b/i.test(cmd)) return true;
    }
    return false;
  },
  extraUserExempt: (user) =>
    /(?:git status|git log|what(?:'s| is) (?:the )?status|有没有提交)/iu.test(user) &&
    !/(?:commit|push|PR|tag|release|issue|review|approve|提交代码|推送)/iu.test(user),
  correction:
    '[System] The user asked for a git/gh VCS action (commit/push/PR/review/approve/tag/release/issue), and tools have already run without a matching `git` / `gh pr|release|issue` command. ' +
    'If VCS action is required: run the real command via `exec` and report its output. ' +
    'If you are waiting for approval, say so — do not invent commits, reviews, tags, releases, or issues.',
});
```

其余 22 个文件同法：`userRe`/`actionRe`/`sawEvidence`/`correction` 一律从原文件**逐字拷贝**，禁止改写正则或文案；转换后原文件删除。

- [ ] **Step 2: 每转换一个子集（建议按 5 个一批）即跑其 spec**

Run（示例）: `npm run build && npm run test:filter -- --filter git-tools-nudge`
Expected: PASS——**spec 只改 import 路径** `../dist/core/loop/X-nudge.js` → `../dist/core/loop/nudges/X-nudge.js`，断言一字不动。哪个不过，就是转换不等价，立即修模板适配而不是改 spec。

- [ ] **Step 3: 7 个特型 nudge 平移**（`todo-、verify-、red-verify-、fan-out-、ambiguity-、subagent-running-、subagent-stopped-`）：逻辑保留原样，仅 `git mv` 到 `nudges/` 并改内部 import（`./nudge-helpers.js` → `../nudge-helpers.js`）；对应 spec 同样只改路径。

- [ ] **Step 4: 全量验证**：`npm run test`（28 个 nudge spec + autonomous-loop + harness-\* 全绿）。
- [ ] **Step 5: Commit**（每批一个 commit）

### Task 4.3: `agent-loop.ts` 注入点收敛为单循环

**Files:**

- Create: `src/core/loop/nudges/registry.ts`
- Modify: `src/core/loop/agent-loop.ts`（删除 `:351-720` 的 29 个闭包与 `:764+` 的 29 个调用点）
- Modify: `src/core/loop/agent-loop-state.ts`（不改字段，见下）

- [ ] **Step 1: registry 代码（计数器仍走既有 state 字段，状态形状不变）**

```ts
// src/core/loop/nudges/registry.ts
import type { Message } from '../../../contracts/messages.js';
import type { AgentLoopState } from '../agent-loop-state.js';
// … 30 个 evaluate* import …

export interface NudgeBuildContext {
  state: AgentLoopState;
  currentMessages: Message[];
  lastUserText: () => string;
  buildCorrectionMessage: (text: string) => Message;
}

/** 按既有顺序执行全部 nudge 检查，返回待注入消息（含计数器自增 / resetAttempts 语义）。 */
export function collectNudgeInjections(ctx: NudgeBuildContext): Message[] {
  const { state } = ctx;
  const req = (attempts: number) => ({
    turns: state.turns,
    totalToolCalls: state.toolExecutionMetrics.totalToolCalls,
    toolCallsByName: state.toolExecutionMetrics.toolCallsByName,
    userText: ctx.lastUserText(),
    messages: ctx.currentMessages,
    attempts,
  });
  const out: Message[] = [];
  const run = (
    evaluate: (r: any) => any, // 保持与原调用一致的请求/结果形状；禁止 any 可改为重载联合
    counter: { get(): number; set(v: number): void },
    opts?: { onResetAttempts?: boolean }
  ) => {
    const decision = evaluate(req(counter.get()));
    if (opts?.onResetAttempts && decision.resetAttempts) counter.set(0);
    if (!decision.fire) return;
    counter.set(counter.get() + 1);
    out.push(ctx.buildCorrectionMessage(decision.correction));
  };
  // 顺序 = agent-loop.ts 现状顺序（todo → verify → red-verify → fan-out → ambiguity → …）
  run(evaluateTodoNudge, {
    get: () => state.todoNudgeAttempts,
    set: (v) => (state.todoNudgeAttempts = v),
  });
  run(evaluateVerifyNudge, {
    get: () => state.verifyNudgeAttempts,
    set: (v) => (state.verifyNudgeAttempts = v),
  });
  run(
    evaluateRedVerifyNudge,
    { get: () => state.redVerifyNudgeAttempts, set: (v) => (state.redVerifyNudgeAttempts = v) },
    { onResetAttempts: true }
  );
  // …其余 26 项同型…
  return out;
}
```

（实现时把 `any` 收敛为 `NudgeRequest | 特型请求` 的联合重载；计数器字段名以 `agent-loop-state.ts` 实际字段为准，先 grep。）

- [ ] **Step 2: agent-loop.ts 注入块替换**

```ts
for (const msg of collectNudgeInjections({
  state,
  currentMessages,
  lastUserText: lastUserTextForNudge,
  buildCorrectionMessage,
})) {
  state.pendingMessages.push(msg);
}
```

`injectBackgroundCompletions` 保留原状（Phase 3.3 已归位，两处调用点不动）。

- [ ] **Step 3: 验证**：`npm run typecheck && npm run test:filter -- --filter autonomous-loop && npm run test:filter -- --filter todo-nudge && npm test`
- [ ] **Step 4: Commit** `git commit -m "refactor(loop): collapse 29 nudge injection sites into registry loop"`

---

## Phase 5 — 错误分类统一（消 B2 / A5）

### Task 5.1: classifier 归位 provider + 谓词单一来源

**Files:**

- Move: `src/core/llm/llm-error-classifier.ts` → `src/provider/llm-error-classifier.ts`
- Modify: `src/provider/errors.ts`、`src/provider/error-classify.ts`、importers

- [ ] **Step 1: `git mv` classifier 到 provider**（router 的 import 变模块内引用，A5 循环消除）。importers：`core/loop/agent-loop.ts`、`agent-error-outcome.ts`、`agent-loop-stream-helpers.ts`、`core/subagent/agent-events.ts`、`provider/multi-provider-router.ts`（grep 确认），core → provider 方向合法。
- [ ] **Step 2: 谓词去重**：通读三文件，凡同一判定（如 401/403→auth、429→rate_limit、timeout 消息模式）出现 ≥2 处的实现，收敛为 `provider/errors.ts` 中单一导出谓词（如 `isAuthFailure(input)`、`isRateLimitFailure(input)`、`isTimeoutFailure(input)`），两个分类器改为组合谓词 + 各自词汇表映射。**三套公开词汇表（ProviderErrorCategory / FailoverReason / LlmErrorCategory）保留为视图**——它们是既有公共契约，不做破坏性合并；重复的是判定逻辑，不是视图。
- [ ] **Step 3: 收紧豁免**：`moss/boundary-provider` regex 仅剩 `llm/llm-provider`。
- [ ] **Step 4: 验证（行为锁全在）**：`npm run test:filter -- --filter error-classify && npm run test:filter -- --filter llm-error-classifier && npm run test:filter -- --filter provider-retry-contract && npm run test:filter -- --filter connection-error && npm run test:filter -- --filter multi-provider-router`
- [ ] **Step 5: Commit** `git commit -m "refactor(provider): unify error predicates; single classifier home"`

---

## Phase 6 — 巨型文件拆分（入口保 dist 路径兼容）

> 通用配方：目标文件拆为同目录（或同名目录）协作模块；原路径保留为薄 re-export（`export * from './<dir>/index.js'` + 具名 re-export），因为测试直接 import `dist/tools/web-search.js` 等路径。拆分 = 纯 `git mv` 式搬代码 + 改 import，**不改函数体**。

### Task 6.1: `tools/web-search.ts`（1902 行）→ `tools/web-search/` 目录

**Files:**

- Create: `src/tools/web-search/` —
  - `http.ts`：`fetchWithTimeout`、`defaultSleep`、`isAbortError`、`isRecoverableError`、`backoffDelay`、`combineAbortSignals`（若与 utils 重复则直接引用 utils）、`parseSseJsonMessages`、`coerceString`、`decodeEntities`、`stripTags`
  - `backends-scrape.ts`：`duckDuckGoSearch`、`duckDuckGoLiteSearch`、`duckDuckGoResponseLooksBlocked`、`unwrapDuckDuckGoHref`、`bingSearch`、`bingResponseLooksBlocked`、`unwrapBingHref`、`baiduSearch`、`baiduResponseLooksBlocked`、`unwrapBaiduHref`
  - `backends-api.ts`：`createBraveSearch`、`createBochaSearch`、`createExaSearch`、`createAnonymousExaMcpSearch`、`parseExaMcpText`
  - `chain.ts`：`resolveBackendChain`、`runBackendWithRetry`、`searchWithFallback`、`searchAllWithBudget`、`containsCjk`、`resultRelevanceScore`
  - `merge.ts`：`canonicalResultUrl`、`mergeSearchEvidence`、`parsedResultDate`、`eventSignature`、`diversifyNewsResults`
  - `tool.ts`：工具定义（`createWebSearchTool` 及其 schema/执行体）
  - `index.ts`：组装 + 全量 re-export
- Modify: `src/tools/web-search.ts` → 薄壳：`export * from './web-search/index.js';`（保留 `dist/tools/web-search.js` 供 2 个 spec 与 `builtin.ts`/`index.ts` 使用）
- [ ] **Step 1: 按上表搬移符号（函数体逐字不动）**
- [ ] **Step 2: 验证**：`npm run typecheck && npm run test:filter -- --filter web-search`
- [ ] **Step 3: Commit** `git commit -m "refactor(tools): split web-search into focused modules"`

### Task 6.2: `cli/tui-utils.ts`（1690 行）→ 按职责拆分

**Files:**

- Create（均在 `src/cli/`）：
  - `terminal-text.ts`：`ANSI_RE`、`CONTROL_CHAR_RE`、`LONG_TOKEN_RE`、`CJK_CHAR_RE`、`COPY_SENSITIVE_TOKEN_RE`、`RTL_RE`、`sanitizeTextForTerminal`、`sanitizeRenderableText`、`sanitizePromptEditorText`、`visibleText`、`truncateTerminalText`
  - `input-queue.ts`：`QueuedInput`、`QueueDrainState`、`SerialQueueDrain`、`shouldDrainQueue`、`queueItemKind`、`queueItemMeta`、`dropLastQueuedInput`、`formatQueueWait`、`stopRequestedMessage`、`queueResumedMessage`、`queuePausedSubmissionMessage`、`isQueueControlCommand`、`isImmediateGoalCommand`、`MAX_INPUT_HISTORY`
  - `repl-process.ts`：`killProcessTree`、`runLocalShellCommand`、`LOCAL_SHELL_OUTPUT_LIMIT`
  - `resume-replay.ts`：`ResumableMessage`、`resumedMessageText`、`resumedToolLines`、`buildResumeReplay`、`RESUME_REPLAY_MAX`
  - `transcript-types.ts`：`TranscriptKind`、`TranscriptItem`、`ActivityItem`、`TuiRunState`、各 Picker/Approval/Question State 接口、`createTranscriptId`、`nextId`
- Modify: `src/cli/tui-utils.ts` → 薄 re-export 壳（5 个 spec 依赖 `dist/cli/tui-utils.js`）
- [ ] **Step 1: 搬移（其余未列出的符号留在壳文件或就近归类，以符号清单逐一对号）**
- [ ] **Step 2: 验证**：`npm run typecheck && npm run test:filter -- --filter cli-tui && npm run test:filter -- --filter cli-tui-utils-core && npm run test:filter -- --filter cli-tui-noise && npm run test:filter -- --filter markdown-table`
- [ ] **Step 3: Commit** `git commit -m "refactor(cli): split tui-utils grab-bag into focused modules"`

### Task 6.3: `cli/setup.ts`（1287 行）→ 三个命令域

**Files:**

- Create: `src/cli/setup-wizard.ts`（`runSetupWizard`、`probeSetupReachability`、`question*`、`hiddenQuestion`、`providerFromChoice`、`guessModelProvider`、`renderAuthStatus`、`runAuthLogout`）
- Create: `src/cli/config-commands.ts`（`renderConfigJson`、`renderConfigUsage`、`runConfigShow`、`runConfigValidate`、`runConfigSet`、`runConfigUnset`、`runConfigInit`、`applyConfigSetPair`、`parseConfig*`、`setGuardrailPatternList`、`resolveConfigEditTarget`、`resolveConfigInitTarget`、`build*ConfigTemplate`、`serialize*`、`guardrailSummary`、`configAuditSummary`、`removeEmptyNestedConfig`、`supportedConfigKeys`）
- Create: `src/cli/onboarding-hints.ts`（`printMissingConfigGuidance`、`offerSetupForInteractiveMissingConfig`、`oneShotOnboardingMarkerPath`、`hasShownOneShotOnboardingHint`、`markOneShotOnboardingShown`、`renderOneShotOnboardingHint`）
- Modify: `src/cli/setup.ts` → 薄 re-export；`cli/command-dispatcher.ts`、`cli-main.ts` 的 import 改指新模块（grep 确认调用点）
- [ ] **Step 1: 搬移 + 改 import**
- [ ] **Step 2: 验证（Task 0.2 的特征测试在此生效）**：`npm run typecheck && npm run test:filter -- --filter cli-setup && npm run test:filter -- --filter cli-onboarding && npm run smoke`
- [ ] **Step 3: Commit** `git commit -m "refactor(cli): split setup.ts into wizard/config-commands/onboarding"`

### Task 6.4 (stretch，可选): `config.ts` / `compaction.ts` / `moss-agent.ts` 同法拆分

仅在 Task 6.1–6.3 全绿且预算允许时执行；配方相同（符号分组 → 同目录协作模块 → 薄壳）。`moss-agent.ts` 覆盖最好（16 个 spec），`config.ts` 有 2 个 spec，`compaction.ts` 有 e2e spec——先跑对应 spec 确认安全网再动。

---

## Phase 7 — 死代码清理与收尾

### Task 7.1: 死导出核对与删除

- [ ] **Step 1: 重新生成候选清单（迁移会改变引用计数）**

Run（符号级扫描，与审计同法）：对 `src/**` 每个导出符号统计其在 `src/` + `test/` 的出现次数；仅出现 1 次（定义处）者为候选。

- [ ] **Step 2: 逐个核对**：候选符号 grep `src/` 与 `test/`（test import `dist/`，符号名不变即命中）。确认两处皆无引用 → 删除导出及其实现；被 test 引用 → 保留（导出供测试是合法用途）；被 `export *` 桶间接暴露且属 SDK 面（`src/index.ts` 可达）→ 保守保留并在自审记录中列出。
- [ ] **Step 3: 验证**：`npm run typecheck && npm run lint && npm test`
- [ ] **Step 4: Commit** `git commit -m "chore: remove dead exports confirmed unused"`

### Task 7.2: 固化架构文档与最终验证

- [ ] **Step 1: `AGENTS.md` 的「结构导航」追加一行分层规则引用**（指向 eslint 边界配置名 `moss/boundary-*`，说明"新增 import 前先看边界规则"）。
- [ ] **Step 2: 最终门禁**

Run: `npm run verify`
Expected: 全绿。另跑边界证明：

```bash
grep -rn "from '.*cli/" src/tools src/core src/context src/provider src/safety src/utils | grep -v "src/cli"   # 期望空
grep -rn "from '\.\./core/" src/context                                                                                   # 期望空
grep -rn "from '\.\./cli/" src/tools                                                                                      # 期望空
```

- [ ] **Step 3: Commit** `git commit -m "docs(agents): document enforced layering rules"`

---

## 验证策略总表

| Phase | 最窄验证                                                                                                     | 行为锁                     |
| ----- | ------------------------------------------------------------------------------------------------------------ | -------------------------- |
| 0     | `npm run verify` 基线 + 新增特征 spec                                                                        | 新增 2 个 spec             |
| 1     | `npm run lint`（豁免外零误报）                                                                               | —                          |
| 2     | typecheck + lint + 全量 test；`session-jsonl.js` 桶探针                                                      | 既有 spec 不动             |
| 3     | 分方向 spec（cli-security / pi-ai / follow-up-guard / background-completion / pending-tool-aborts）          | 既有 spec 仅改 import 路径 |
| 4     | 28 个 nudge spec 分批 + autonomous-loop + harness                                                            | nudge spec 断言一字不动    |
| 5     | error-classify* / llm-error-classifier* / provider-retry-contract / connection-error / multi-provider-router | 同上                       |
| 6     | 每文件对应 spec + smoke                                                                                      | Task 0.2/0.3 特征 spec     |
| 7     | `npm run verify` + 三条 grep 边界证明                                                                        | 全量                       |

## 风险与回滚

- 每任务独立 commit，可单 commit revert；Phase 2/4/6 内部再按批切分 commit。
- 最大风险点：Task 4.2 模板等价性（缓解：spec 断言不动，分批转换分批验证）；Task 2.3 大面积 import 改写（缓解：typecheck 全量覆盖 + 纯类型移动无运行时差异）。
- `dist` 路径兼容靠"原路径薄 re-export 壳"保证；若最终想去壳，须同步改 spec import——本计划不做（留作后续）。

## 自审记录（Self-Review）

1. **覆盖度**：0.1 的 A1→T3.1、A2→Phase 2、A3→T3.2/T5.1、A4→T3.3、A5→T5.1、A6→T3.4、A7→Phase 1；B1→Phase 4、B2→Phase 5、B3→Phase 6（含 stretch 项明示）、B4→T7.1、B5→T3.4/T7.1。无遗漏。
2. **占位符**：Phase 2/6 的代码块为"迁移指令 + 结构定义"（源真相 = 被搬文件本身，逐字拷贝是刻意设计以防计划与代码漂移）；所有新写的结构性代码（端口、模板、registry、eslint 规则）均给出完整实现。探针→锁值的两步法是特征测试的标准做法，不是占位符。
3. **类型一致性**：`NudgeRequest`/`NudgeResult` 以 `nudge-helpers.ts` 现定义为准；registry 中计数器字段名标注"以 agent-loop-state.ts 实际字段为准，先 grep"——执行时核对。
