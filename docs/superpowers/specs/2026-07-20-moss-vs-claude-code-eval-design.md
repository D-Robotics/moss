# Moss vs Claude Code 对照评估设计(第 2 层 + 第 3 层)

**Date**: 2026-07-20
**Status**: Design / 待 review
**Scope**: 本轮聚焦第 2 层(工具调用准确率)与第 3 层(错误闭环与自愈)。第 1/4/5 层本轮不做,后续单独 spec。

## 目标

在同一台机、同一 Claude 模型上,对比 moss 与 Claude Code 在「工具调用准确率」和「错误闭环/自愈」两层的真实表现,产出**量化基线**,并对照文档「常见差距点」定位 moss 的具体短板,为后续调整 moss 提供**可归因、可验证**的依据。

核心理念:模型相同 → 测出的差距就是**框架/工程层面**的差距(勘察纪律、工具校验、错误闭环、prompt 约束),不是模型能力差距。

## 前提(已确认)

- moss 原生支持 Anthropic/Claude provider(`packages/moss-agent/src/cli/providers.ts:176,227` `callAnthropic`)。
- Claude Code CLI 已装(`~/.local/bin/claude` v2.1.204),支持 `-p/--print --model --output-format stream-json`。
- moss headless:`moss -p "<task>" --max-turns N --provider anthropic --model <claude 模型>`。
- moss OTel 埋点已合并进上游 main:`.moss/analytics/traces.jsonl` 含 `moss.tool.invoke` span 的 `is_error` / `outcome_kind` 属性。
- moss 已有的相关设施(本轮是测它们实际表现,不是测存不存在):
  - schema 校验层:`validateToolInputObject`(`tool-pipeline.ts:48`),在 `execute-tool-call.ts:341` 被调用。
  - 错误闭环:`MAX_RETRY_ATTEMPTS`(`execute-tool-call.ts:79`)、`tool-loop-guard`(防重复死循环)、`loop-scheduler` 的 `consecutiveFailures` 暂停。
  - 轻量评估指标:`eval/metrics.ts`(exactMatch/containsAll)。

## 整体架构

新建独立 eval 工作区 `D:\moss-eval`(不碰 moss/rdk-studio 正经仓库):

```
D:\moss-eval/
├─ harness/                      # runner + 判分(半自动)
│  ├─ run-eval.mjs                # 主 runner:重置→跑两边→采埋点→算分
│  ├─ tasks.mjs                   # 任务定义(第2层 15 + 第3层 8)
│  ├─ score-layer2.mjs            # 自动统计显性工具错误率
│  ├─ score-layer3.mjs            # 自动取纠错轮数/重复失败命令
│  └─ collect-artifacts.mjs       # 解析 traces.jsonl / claude stream-json
├─ fixtures/                      # 被测小项目(带 bug 的 TS 库)
│  └─ sample-lib/                 # 每个任务一个 git tag
├─ runs/                          # 每轮产物归档
│  └─ <ts>/<task>/<subject>/round-N/{traces.jsonl, transcript.md, diff.patch, review-samples.md}
└─ reports/                       # 最终对照表 + 结论
   ├─ layer2-error-rate.csv
   ├─ layer3-recovery.csv
   ├─ review-samples.md
   └─ baseline-summary.md
```

## 任务集

### 第 2 层:15 个任务 × 3 轮

任务覆盖不同工具类型,且设计成工具调用密集(单任务 ~10–15 次调用,把错误率分母做厚)。

| 组 | ID | 任务 prompt | 观测重点 |
|---|---|---|---|
| 搜索/定位 | L2-01 | 找所有调用 `deprecatedFn` 的地方 | 该用 search 而非全量读 |
| | L2-02 | 找 `divide` 函数定义在哪 | grep vs 逐文件读 |
| | L2-03 | 列出 `src/` 下被 import 次数最多的模块 | 多次 search + 聚合 |
| 精确读取 | L2-04 | 读 `src/calc.ts` 的 `divide` 实现 | 路径/符号精确 |
| | L2-05 | 读一个不存在的文件 | 该报错而非幻觉内容 |
| | L2-06 | 读 `node_modules/x` 的导出 | 跨目录路径 |
| 编辑/改写 | L2-07 | `fmtDate` 改成 ISO 格式 | 最小 diff vs 全量覆写 |
| | L2-08 | 批量给 5 个函数加 JSDoc | 多文件协同编辑 |
| | L2-09 | camelCase rename 成 snake_case | rename 跨文件一致 |
| 执行/验证 | L2-10 | 跑测试列出失败项 | 命令参数 + 结果解析 |
| | L2-11 | 跑 `tsc --noEmit` 修类型错误 | 编译错解析 |
| | L2-12 | 跑带 CLI 参数的脚本 | 参数传递 |
| 幻觉防护 | L2-13 | 项目里有没有 lodash(没装) | 不该假装有 |
| | L2-14 | 这个库版本号是多少 | 该读 package.json 而非猜 |
| 边界 | L2-15 | 超大输入触发 read 截断 | 处理截断/边界 |

### 第 3 层:8 个 bug 任务 × 3 轮

| ID | 任务 | 预埋 bug | 难度 |
|---|---|---|---|
| L3-01 | 让 `npm test` 通过 | 语法错(括号没闭合) | 易 |
| L3-02 | 修 divide 除零 | divide 没处理 0 + 测试断言抛错 | 易 |
| L3-03 | 装好依赖让能 build | package.json 缺实际用到的依赖 | 中 |
| L3-04 | 修 import 失败 | import 路径大小写错 | 中 |
| L3-05 | 修类型错误 | 变量类型注解错 | 中 |
| L3-06 | 修逻辑 bug | 排序比较器方向反(语法对、测试失败) | 难 |
| L3-07 | 修异步 bug | 忘 await,测试时序偶发失败 | 难 |
| L3-08 | 修环境问题 | tsconfig target 太低致语法不识别 | 中 |

### 样本量

- 第 2 层:15 × 3 = 45 次 ×2(moss+claude)= 90 次 agent 运行;工具调用样本 ~450–675 次。
- 第 3 层:8 × 3 = 24 次 ×2 = 48 次 agent 运行。
- 合计 ~138 次 agent 运行。轮间用模型温度轻微扰动(避免完全相同输出),但 seed 固定可复现。

## 数据采集与判分

### 每轮自动采集(两边对等)

- **moss**:读 `fixtures/.moss/analytics/traces.jsonl` → 提取 `moss.tool.invoke` span(`is_error`/`outcome_kind`)+ session export(transcript)+ `git diff`。
- **claude**:`claude -p --output-format stream-json` → 解析 JSON 事件流的 `tool_use`/`tool_result`(`is_error` 字段)+ `git diff`。

### 第 2 层判分

- **显性错误率(自动)**:分子 = `completed && is_error` 的工具调用次数;分母 = 工具调用总次数。`denied`/`pre-blocked`/`hook-blocked`/`unknown-tool` 不计入分母(非执行错误)。基准:<1% 优秀,>5% 头号优化点。
- **隐性错误(人工采样)**:runner 用启发式标出「显性无错但疑似有问题」的候选(工具名与任务不匹配、相同工具重复 N 次、读不存在路径却没报错)→ 进 `review-samples.md`,人工判「参数错/选错工具/幻觉」→ 隐性错误率。

### 第 3 层判分

- **自动取**:纠错轮数(从首次报错到任务结束的连续 turn 数)、重复相同失败命令次数(同名 tool + 相同参数 + `is_error` 序列长度)。
- **人工判**:最终 `git diff` 是否真的修对预埋 bug(对照每个 L3 任务预存的「预期修复 patch」)。
- 指标:平均纠错轮数、死循环发生率(重复相同失败命令 ≥3 次)、修复成功率。

## 公平性保证

- **同模型**:moss `--provider anthropic --model <M>`,claude `--model <M>`,同一 API key。
- **同初始态**:每轮 `git checkout <task-tag> -- ; git clean -fd` 重置 fixtures。
- **同 prompt**:两边任务原话一字不差。
- **不联网**:任务限制在 fixtures 内,web 工具任务不纳入(避免外部因素)。
- **判分者偏见**:人工采样由用户最终拍板(我只标候选,不替用户定性)。

## 产出物

1. `reports/layer2-error-rate.csv` — 第2层每任务每轮错误率 + 汇总(自动)
2. `reports/layer3-recovery.csv` — 第3层每任务每轮纠错轮数/死循环/修复成功(混合)
3. `reports/review-samples.md` — 需人工复核的隐性错误候选清单
4. `reports/baseline-summary.md` — 对照总表 + 文字结论(moss 哪层落后、差距多大、对应文档哪条「差距点」)

## 测完的调整方向(本轮不实施,仅定位)

对照文档「常见差距点」映射到 moss 代码:

- 第 2 层显性错误率高 → 查 `validateToolInputObject`(`tool-pipeline.ts:48`)是否所有工具都过校验、参数描述是否够细。
- 第 2 层隐性「选错工具」多 → 查工具描述/枚举约束(`builtin.ts` 各工具 description)。
- 第 3 层纠错轮数多/死循环 → 查 `tool-loop-guard`、`MAX_RETRY_ATTEMPTS`、completion-gate 触发逻辑。

这些调整是后续**单独的 spec/plan**,本轮只产出基线 + 定位差距。

## 范围外(本轮不做)

- 第 1 层(首轮意图/勘察纪律)、第 4 层(上下文一致性)、第 5 层(领域知识)。
- 实际调整 moss 代码(本轮只测不调)。
- web 工具相关任务(联网不可控)。
