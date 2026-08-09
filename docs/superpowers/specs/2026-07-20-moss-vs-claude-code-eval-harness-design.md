# Moss vs Claude Code 对照评估 — Harness 落地设计

**Date**: 2026-07-20
**Status**: Design / 待 review
**关系**: 本文档是 `2026-07-20-moss-vs-claude-code-eval-design.md`(评估目标设计)的**落地补充**。前者定义「测什么、为什么测」;本文档定义「harness 怎么搭、怎么跑、怎么判分」。两者结合为完整可执行方案。

## 目标(沿用 + 收敛)

在 GLM 同模型下,对比 moss 与 Claude Code 在 L2(工具调用准确率)与 L3(错误闭环/自愈)两层的真实表现,产出量化基线,并对照文档「常见差距点」定位 moss 的具体短板。

核心理念:模型相同 → 测出的差距就是**框架/工程层面**的差距(勘察纪律、工具校验、错误闭环、prompt 约束),不是模型能力差距。

## 落地前提(已实测验证)

冒烟实测确认的可执行性,及由此引出的关键约束:

| 项            | moss                                                               | claude                                                                                      | 影响                            |
| ------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------- | ------------------------------- |
| 能否跑 GLM    | ✅ openai-compatible provider(`/v1/chat/completions`)              | ✅ anthropic 协议(`/v1/messages`)                                                           | 都能跑                          |
| 认证          | `Authorization: Bearer`(openai provider)                           | `Authorization: Bearer`(`ANTHROPIC_AUTH_TOKEN`)                                             | 同一 token `JV8o…`              |
| 协议          | **OpenAI**                                                         | **Anthropic**                                                                               | **不对等,报告须标注**(见局限性) |
| 工具集        | 23 个(全套)                                                        | 27 个(全套,需 `CLAUDE_CONFIG_DIR` 隔离 superpowers)                                         | 对等                            |
| headless 调用 | `moss --config-file <f> -p "…" --max-turns N`                      | `claude -p "…" --max-turns N --output-format stream-json --verbose` + `CLAUDE_CONFIG_DIR=…` | —                               |
| 埋点来源      | `fixtures/.moss/analytics/traces.jsonl` 的 `moss.tool.invoke` span | stream-json 的 `tool_use`/`tool_result`(`is_error`)                                         | 差异封在 subjects.mjs           |
| 单次成本      | 待实测                                                             | ~$0.05–0.12                                                                                 | 138 次两边合计约 $30–80 量级    |
| 单次耗时      | 待实测                                                             | ~3–90s(GLM 开 thinking,慢)                                                                  | 串行数小时 → 需并发             |

**关键约束(实测发现,原设计未覆盖)**:

1. **moss anthropic provider 跑不通 GLM**:GLM 网关只认 `Authorization: Bearer`,不认 Anthropic 标准 `x-api-key`;moss 的 anthropic provider 硬编码 `x-api-key`(`provider/anthropic.js:100`),无开关。本轮「只测不调」原则下不改 moss 源码,故 moss 改走 **openai-compatible provider**。由此带来协议不对等(见局限性)。
2. **claude 默认带 superpowers 注入**:SessionStart hook 注入全量 skills,单次 input tokens 22k+、$0.11+ 且 transcript 噪音大。解法:`CLAUDE_CONFIG_DIR` 指向干净配置目录(不含 superpowers 插件),superpowers 噪音清零,全套工具保留。
3. **claude stream-json 的 `thinking_tokens` 流式事件噪音巨大**(单次上百条),解析时必须过滤。
4. **moss completion-gate 会拒绝言行不一的回合**(实测:声称写 memory 但未调 `memory_write` 即被拒)。故 L3 任务 prompt 用目标式措辞(「修复让测试通过」),不规定输出格式,避免把框架行为噪音混进「修复成功率」指标。
5. **L3-03 的 lodash bug 在当前 fixture 未真正落地**(sample-lib 无 lodash 代码),L3-07/L3-08 tag 未建 —— 落地阶段补齐。

## 整体架构

新建独立 eval 工作区 `D:\moss-eval`(不碰 moss/rdk-studio 正经仓库):

```
D:\moss-eval/
├─ harness/
│  ├─ config.mjs              # 路径、模型、并发、超时等常量集中处
│  ├─ tasks.mjs               # 任务定义:L2×15 + L3×8,每任务{id,layer,prompt,tag,cleanMode,watch,expectedPatch?}
│  ├─ subjects.mjs            # 两边调用封装:runMoss/runClaude(task,round,workDir)→ 统一 RunResult
│  ├─ pool.mjs                # 并发池:work units + concurrency 调度,支持断点续跑跳过已完成
│  ├─ collect-artifacts.mjs   # 单次运行后:解析 traces/stream-json → transcript.md + metrics.json + diff.patch
│  ├─ score-layer2.mjs        # 扫 runs/ 聚合:每任务每轮显性错误率 → layer2-error-rate.csv
│  ├─ score-layer3.mjs        # 扫 runs/ 聚合:纠错轮数/死循环/修复成功初判 → layer3-recovery.csv
│  ├─ run-eval.mjs            # 主入口:orchestrate(重置→跑→采→评分),CLI:--layer --rounds --concurrency --timeout --resume
│  ├─ moss-config/            # gitignored:config.json(openai-compatible + GLM token)
│  └─ claude-config/          # gitignored:clean-home/.claude/settings.json(脱离 superpowers)
├─ fixtures/
│  ├─ sample-lib/             # git tags: base, L3-01..L3-08
│  └─ expected/L3-XX.patch    # 每个 L3 任务的预期修复 patch(宽松判分参照)
├─ runs/<ts>/<task>/<subject>/round-N/
│  └─ {raw.log, traces.jsonl|stream.jsonl, transcript.md, diff.patch, metrics.json, status.json}
└─ reports/
   ├─ layer2-error-rate.csv
   ├─ layer3-recovery.csv
   ├─ review-samples.md
   └─ baseline-summary.md
```

### 模块边界(单一职责、可独立测)

- **`subjects.mjs` 是关键隔离层**:对外只暴露 `runMoss(task, round, workDir) / runClaude(task, round, workDir) → RunResult{subject, ok, turns, toolCalls[], errorEvents[], deniedOrBlocked, transcript, diff, durationMs, costUsd, terminalReason}`。两边协议不同、埋点来源不同,这些差异**全部封在 subjects.mjs 内部**;下游 collect/score 只消费统一的 `RunResult` + 磁盘结构化文件,完全不关心是哪个 subject。
- **`pool.mjs`** 只管调度,不知道任务内容。
- **`tasks.mjs`** 只管数据,不跑东西。
- **`collect-artifacts.mjs`** 只解析不发起运行。

## 任务集

### L2:15 个任务 × N 轮(试水 N=1)

全部基于 `base` tag 的 sample-lib。prompt 全部用**中性措辞,不点名任何工具**(不写「用 grep」「用 search」),让两边自己选工具 —— 这才测得出「工具选择准确率」。prompt 直接照搬原设计表格:

| 组        | ID    | 任务 prompt                            | 观测重点 watch                                    |
| --------- | ----- | -------------------------------------- | ------------------------------------------------- |
| 搜索/定位 | L2-01 | 找所有调用 `deprecatedFn` 的地方       | 该用 search 而非全量读                            |
|           | L2-02 | 找 `divide` 函数定义在哪               | grep vs 逐文件读                                  |
|           | L2-03 | 列出 `src/` 下被 import 次数最多的模块 | 多次 search + 聚合                                |
| 精确读取  | L2-04 | 读 `src/calc.ts` 的 `divide` 实现      | 路径/符号精确                                     |
|           | L2-05 | 读一个不存在的文件                     | 该报错而非幻觉内容                                |
|           | L2-06 | 读 `node_modules/x` 的导出             | 跨目录路径                                        |
| 编辑/改写 | L2-07 | `fmtDate` 改成 ISO 格式                | 最小 diff vs 全量覆写                             |
|           | L2-08 | 批量给 5 个函数加 JSDoc                | 多文件协同编辑                                    |
|           | L2-09 | camelCase rename 成 snake_case         | rename 跨文件一致                                 |
| 执行/验证 | L2-10 | 跑测试列出失败项                       | 命令参数 + 结果解析                               |
|           | L2-11 | 跑 `tsc --noEmit` 并报告结果           | 编译命令执行 + 结果解析(base 为干净基线,预期无错) |
|           | L2-12 | 跑带 CLI 参数的脚本                    | 参数传递                                          |
| 幻觉防护  | L2-13 | 项目里有没有 lodash(没装)              | 不该假装有                                        |
|           | L2-14 | 这个库版本号是多少                     | 该读 package.json 而非猜                          |
| 边界      | L2-15 | 超大输入触发 read 截断                 | 处理截断/边界                                     |

### L3:8 个 bug 任务 × N 轮(试水 N=1)

每个任务一个 git tag + 预期修复 patch。落地阶段需补齐 L3-03/07/08:

| ID    | tag     | 预埋 bug                         | 难度 | 落地动作                                                                                                                       |
| ----- | ------- | -------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------ |
| L3-01 | `L3-01` | 语法错(括号没闭合)               | 易   | ✅ tag 已建                                                                                                                    |
| L3-02 | `L3-02` | divide 除零未处理                | 易   | ✅ 已建                                                                                                                        |
| L3-03 | `L3-03` | 缺依赖 lodash-es                 | 中   | ⚠️ **重做**:让 sample-lib 真用 `lodash-es`(如 `src/calc.ts` import `sum`)但 `package.json` 不声明 → install/tsc 失败。重打 tag |
| L3-04 | `L3-04` | import 路径大小写错              | 中   | ✅ 已建                                                                                                                        |
| L3-05 | `L3-05` | 类型注解错                       | 中   | ✅ 已建                                                                                                                        |
| L3-06 | `L3-06` | 排序比较器方向反                 | 难   | ✅ 已建                                                                                                                        |
| L3-07 | 待建    | 忘 await,测试时序偶发失败        | 难   | ❌ **新建**:加异步函数(如 `fetchValue` 返回 Promise),调用处忘 await,测试断言值却偶发拿到 Promise 对象                          |
| L3-08 | 待建    | tsconfig target 太低致语法不识别 | 中   | ❌ **新建**:`tsconfig.json` target 改 `ES5`,代码用 `ES2022` 语法(如 `??=`)→ 编译错                                             |

每个 L3 任务存预期修复 patch 于 `fixtures/expected/L3-XX.patch`,供 score-layer3 对照。**这些 patch 纳入版本控制**(判分参照,需可复现),不在 `.gitignore` 覆盖范围内。

**prompt 措辞约束**:L3 任务统一用目标式措辞(「修复让 `npm test` / `tsc --noEmit` 通过」),不规定输出格式 —— 避免触发 moss completion-gate 噪音混进修复成功率指标。

### 样本量与调度

- 试水:每任务每 subject 1 轮 = L2(15×2) + L3(8×2) = **46 次** agent 运行。
- 试水后据耗时/成本决定后两轮(目标:L2 3 轮 90 次 + L3 3 轮 48 次 = 138 次)。
- **无温度扰动**:去掉原设计「轮间温度轻微扰动」。3 轮全用相同参数,更严格测「同输入下两边表现」;代价是 3 轮可能高度相似,样本多样性下降 —— 接受此代价。

## 数据采集与判分

### 每次运行的采集(两边对等,差异封在 subjects.mjs 内)

每个运行单元产出固定文件集,放到 `runs/<ts>/<task>/<subject>/round-N/`:

| 文件                                         | 内容                                                                     | 来源                                               |
| -------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------- |
| `raw.log`                                    | 原始 stdout/stderr                                                       | 直接捕获                                           |
| `traces.jsonl`(moss)/ `stream.jsonl`(claude) | 原始埋点流                                                               | moss 写 `.moss/analytics/`;claude 输出 stream-json |
| `transcript.md`                              | 可读对话回放(tool_use/tool_result 摘要)                                  | collect 解析生成                                   |
| `diff.patch`                                 | 运行后 `git diff`                                                        | `git diff`                                         |
| `metrics.json`                               | 统一结构化指标                                                           | collect 提取                                       |
| `status.json`                                | 运行元信息(subject/task/round/tag/duration/cost/exitCode/terminalReason) | subjects 写                                        |

**`metrics.json` 统一 schema**(两边同字段,下游评分不分支):

```jsonc
{
  "subject": "moss" | "claude",
  "taskId": "L2-01",
  "round": 1,
  "toolCalls": [
    { "name": "search_code", "input": {...}, "ok": true, "errorKind": null, "turn": 3 },
    { "name": "read_file",   "input": {...}, "ok": false, "errorKind": "file_not_found", "turn": 4 }
  ],
  "turns": 7,
  "errorEvents": [/* 显性错误:ok=false 的 toolCall 摘要 */],
  "deniedOrBlocked": 3,   // denied/pre-blocked/hook-blocked/unknown-tool —— 不计入工具错误分母
  "durationMs": 12340,
  "costUsd": 0.05,
  "terminalReason": "completed" | "max_turns" | "error" | "completion_rejected" | "timeout"
}
```

**埋点提取的差异处理**(封在 collect-artifacts.mjs 内):

- **moss**:跑完读 `fixtures/.../.moss/analytics/traces.jsonl`,筛 `moss.tool.invoke` span,取 `is_error`/`outcome_kind`/工具名/入参。`outcome_kind` 为 `denied`/`pre-blocked`/`hook-blocked`/`unknown-tool` 的归入 `deniedOrBlocked`,不计工具错误分母。
- **claude**:解析 stream-json,取 `tool_use`(name/input)+ 配对 `tool_result`(`is_error` 字段)。**过滤 `thinking_tokens` 流式事件**(噪音)。`permission_denials` 归入 `deniedOrBlocked`。

两边都映射到统一 `toolCalls[]`,后续评分完全一致。

### 第 2 层判分(score-layer2.mjs,全自动)

扫所有 `runs/**/metrics.json`,按 `subject × taskId` 聚合:

- **显性错误率**:`分子 = toolCalls.filter(c => !c.ok).length`;`分母 = toolCalls.length - deniedOrBlocked`。每任务每轮一值 + 每任务 N 轮均值 + 每 subject 总均值。
- **基准对照**:<1% 优秀,>5% 头号优化点(写进 baseline-summary)。
- **隐性错误候选(启发式 → review-samples.md 供人工判)**:
  - 工具名与任务 `watch` 不匹配(如 L2-01「找 deprecatedFn 调用」却全程 `read_file` 不 `search`)
  - 同一工具 + 相同参数重复 ≥3 次
  - 读不存在的路径却 `ok:true`(疑似幻觉内容)
  - `terminalReason` 非 `completed`

输出 `reports/layer2-error-rate.csv`(每任务每轮 + 汇总)+ 往 `review-samples.md` 追加候选。

### 第 3 层判分(score-layer3.mjs,自动 + 人工)

- **自动取**:
  - 纠错轮数:从首个 `!ok` toolCall 到运行结束的连续 turn 数
  - 死循环:同名 tool + 相同参数 + `!ok` 的序列长度 ≥3 → 标记
  - 修复成功(初判):`terminalReason=completed` 且运行后 fixtures 上 `npm test`/`tsc --noEmit` 跑通
- **人工判(宽松口径,用户拍板)**:`diff.patch` 与 `fixtures/expected/L3-XX.patch` 语义等价 → 测试过且改动点在预埋 bug 附近就算修对。runner 把每个 L3 运行的 diff 摘要列进 `review-samples.md`,用户最终定性。

输出 `reports/layer3-recovery.csv`(每任务每轮:纠错轮数/死循环/修复成功初判/待人工)。

## 错误处理、超时、并发与断点续跑

### 错误分级与处理策略

| 失败类型                                                    | 识别                                     | 处理                                                               | 计入指标?                          |
| ----------------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------ | ---------------------------------- |
| agent 正常完成                                              | exit 0,`terminalReason=completed`        | 收集产物                                                           | 是                                 |
| agent 达到 max-turns                                        | exit 0,`terminalReason=max_turns`        | 收集产物,标记                                                      | 是(隐性错误候选)                   |
| agent 自身报错(moss completion_rejected / claude api error) | 非 0 exit 或 `terminalReason=error`      | 收集已产生的部分产物,`status.json` 记 error                        | 进 review-samples,不计工具错误分母 |
| 超时                                                        | 超过 `--timeout`(默认 300s)              | kill 进程树,记 `terminalReason=timeout`                            | 进 review-samples                  |
| fixtures 重置失败                                           | `git checkout`/`clean` 非 0              | **整个运行单元标 failed,不跑 agent**,记 `status.json`              | 不计,但报警                        |
| 采集失败                                                    | traces.jsonl 不存在 / stream-json 解析坏 | 保留 `raw.log`,`metrics.json` 写 `{parseError:...}`,`toolCalls:[]` | 该单元指标缺失,进 review-samples   |

**原则**:任何失败都不能让整个 eval 崩掉。每个运行单元独立 try/catch,失败只污染自己目录,runner 继续下一个。失败单元在 `runs/<ts>/_failures.json` 累计,跑完汇总。

### 超时设计

- 默认 `--timeout 300s`。GLM + thinking 实测 pong 90s,真实 L3 任务可能更长,300s 给余量。
- 超时用进程组 kill(Windows `taskkill /T /PID` 或 node 树 kill)。
- 超时也算「错误闭环失败」信号 —— agent 卡死说明纠错 loop 没收敛,进 review-samples。

### 并发池(pool.mjs)

- 工作单元 = `(task, subject, round)` 三元组。试水 `--concurrency 1`(本质串行);后两轮调高。
- **并发安全**:fixtures 是共享磁盘状态,多单元并发会互相踩 `git checkout`。策略:
  - `concurrency=1`:直接在 `fixtures/sample-lib` 上操作(简单、无副本开销)。
  - `concurrency>1`:自动切**工作目录隔离** —— 每个并发 slot 复制 `fixtures/sample-lib` 到 `fixtures/work-slot-<n>/`,在该副本里 checkout/clean/跑 agent。切换逻辑封在 pool.mjs,subjects.mjs 只接收「在哪个目录跑」。
- **moss `.moss/analytics/traces.jsonl` 并发写入与清理顺序**:落地时验证是 append 还是覆盖。若是 append,每个 moss 运行用独立 analytics 目录;若是覆盖,并发前先复制走。归到 subjects.mjs 的 moss 适配。**关键**:`git clean -fdx`(L3-03)会清掉 `sample-lib/.moss/` 未跟踪文件导致埋点丢失,故 moss 的 analytics 目录必须配到 `sample-lib` 之外(如 `runs/<ts>/<task>/moss/.moss/analytics/`),或由 subjects.mjs 在 clean 之后、agent 运行前确保该目录存在并在运行结束后立即采集 —— 二选一,落地时定。

### 断点续跑(--resume)

- runner 启动扫 `runs/<ts>/`,对每个 `(task, subject, round)` 检查是否已有完整 `metrics.json`(且无 `parseError`)。完整 → 跳过;缺失/不完整 → 重跑。
- 试水跑完第 1 轮后,跑第 2/3 轮用 `--rounds 2,3 --resume`,只补新的。
- `--ts` 默认当前时间戳目录;`--resume` 不带 `--ts` 时自动找最近 runs 目录。

### 成本与耗时监控

- **成本字段来源**:claude 的 `costUsd` 取自 stream-json 收尾事件的 `total_cost_usd`;moss headless 不一定输出成本,若无可解析的成本来源,`costUsd` 填 `null`,csv 中标注 `moss cost N/A`。成本对照仅作耗时/开销参考,不计入任何判分指标。
- **runner 每跑完一个单元**,累加 `costUsd` 到 `runs/<ts>/_budget.json`,打印进度:`[12/46] L2-07 moss round1 ok 14.2s $0.08 | running total $0.94`。
- **不设 `--budget-cap`**(用户决定):runner 只打印累计成本,不设上限停跑。

## 公平性保证(落地细则)

- **同模型**:moss openai-compatible provider + `HORIZON-GLM`;claude `ANTHROPIC_MODEL=HORIZON-GLM`。实跑模型均为 `glm-5.2`(配置名别名)。同一 token。
- **同初始态**:每轮运行前重置 fixtures。`cleanMode` 写进 `tasks.mjs`:L2 用 `git clean -fd`(不清 node_modules,L2 需要 node_modules 跑 tsc);L3-03 用 `git clean -fdx`(清掉 node_modules 以测缺依赖);其余 L3 用 `git clean -fd`。
- **同 prompt**:两边一字不差(同一 `task.prompt`)。
- **不联网**:两边都不给 web 任务。moss 虽有 `web_search`/`web_fetch`,任务不诱导使用;若误用进 review-samples。
- **无温度扰动**:3 轮全用相同参数。

## 产出物

1. **`reports/layer2-error-rate.csv`** — score-layer2 全自动。含每任务每轮 + `L2-ALL avg` 汇总行 + 基准对照注释(<1% 优秀 / >5% 头号优化点)。
2. **`reports/layer3-recovery.csv`** — score-layer3。每任务每轮:纠错轮数/死循环/修复成功初判/`humanVerdict`(初值 `review`,人工回填 `fixed`/`wrong`/`partial`)。
3. **`reports/review-samples.md`** — 隐性错误候选 + L3 diff 摘要(人工复核清单)。每条含任务/subject/round、可疑点描述、相关 toolCall 片段、transcript 链接。
4. **`reports/baseline-summary.md`** — 对照总表 + 文字结论 + 局限性声明 + 调整方向。

## 结论的可归因边界(写进 baseline-summary 顶部)

> - **成立**:模型相同(glm-5.2),故 L2/L3 差距主要反映框架/工程层面(勘察纪律、工具校验、错误闭环、prompt 约束)。
> - **不成立/需打折**:moss 走 OpenAI 协议、claude 走 Anthropic 协议,协议适配层差异混入其中 —— 若 moss L2 错误率偏高,有一部份可能来自 OpenAI 工具调用适配而非纯框架工程。此项无法在本轮消除,仅标注。
> - **样本量**:试水轮单轮(N=1/任务/subject),统计意义有限,定位性质重于定量性质。后两轮补齐后可强化定量结论。

## 测完的调整方向(本轮不实施,仅定位)

对照文档「常见差距点」映射到 moss 代码:

- 第 2 层显性错误率高 → 查 `validateToolInputObject`(`tool-pipeline.ts:48`)是否所有工具都过校验、参数描述是否够细。
- 第 2 层隐性「选错工具」多 → 查工具描述/枚举约束(`builtin.ts` 各工具 description)。
- 第 3 层纠错轮数多/死循环 → 查 `tool-loop-guard`、`MAX_RETRY_ATTEMPTS`、completion-gate 触发逻辑。

## 范围外(本轮不做)

- 第 1 层(首轮意图/勘察纪律)、第 4 层(上下文一致性)、第 5 层(领域知识)。
- 实际调整 moss 代码(本轮只测不调)。
- web 工具相关任务(联网不可控)。
- 消除协议不对等(需改 moss anthropic provider 支持 Bearer,属后续 spec)。
