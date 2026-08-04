# moss skill 调用能力评估测试集 设计

**Date**: 2026-07-21
**Status**: Design / 待 review
**Scope**: 测 moss 从自然语言 prompt 选用 skill 的能力 —— 选择准确率 + 执行质量。

## 目标

通过自然语言任务(不点名 skill),测 moss:
1. 是否选对 skill(显式 `load_skill(name)` 调用)
2. 多 skill 任务能否正确编排(顺序、召回)
3. 不该用 skill 的任务能否拒识(不硬套)
4. 加载 skill 后是否真按 skill 方法执行(执行质量)

核心理念:skill 选择的「准确率」与「执行质量」分开判,只认显式 `load_skill` 调用(严格口径)。

## 探明的事实(影响设计)

- moss 内置 **17 个 skill**(`packages/moss-agent/src/skills/builtin.ts`),每个带 `name`/`description`/`tags`/`trigger`(含中文触发词)。
- **双层调用机制**:
  - 显式 `load_skill(name)` 工具 —— 模型主动调用
  - agent-loop 自动注入 nudge(`evaluateSkillDiscoveryNudge`/`evaluateSkillLoadNudge`)提示模型该用哪个 skill
- **关键实测发现**:面对明显该用 skill 的 prompt("review this code for bugs"),**nudge 触发了(stream 里出现 skill 提及),但模型没调 `load_skill`**,直接用了 list_directory/read_file。→ moss 现状是「nudge 引导了但模型常不服从」。

## 17 个内置 skill(精确清单)与依赖

1. superpower-methodical-builder — architecture/multi-file — 离线 ✓
2. superpower-systematic-debugging — bug/failure/regression — 离线 ✓
3. superpower-test-driven-development — tdd/failing test — 离线 ✓
4. moss-upgrade-and-migration-contract — migration/upgrade — 离线 ✓
5. codegraph-structural-navigation — callers/callees/trace — 需 CodeGraph 索引
6. code-review — review this/audit — 离线 ✓
7. git-workflow — git/commit/branch — 需 git 仓
8. refactoring — refactor/clean up/rename — 离线 ✓
9. documentation — docs/readme/changelog — 离线 ✓
10. create-presentation — 演示/幻灯片 — 离线 ✓
11. web-research — latest/最新/新闻 — 联网 ✗(判分放宽)
12. codebase-inspection — inspect codebase/看看代码 — 离线 ✓
13. planning — make a plan/制定计划 — 离线 ✓
14. verification-before-completion — verify — 离线 ✓
15. frontend-ui-polish — 前端 UI — 需前端小项目
16. pr-and-ship — PR 提交 — 需 git 仓
17. efficient-coding-loop — 高效编码循环 — 离线 ✓

依赖汇总:14 离线可判分;1 联网(web-research,放宽);1 需 CodeGraph 索引;3 需 git 仓/前端项目(fixture 可造)。

## 测试集结构(37 任务)

### A. 17 个单 skill 任务(每 skill 1 个)
prompt 用该 skill 的 trigger 关键词(中英混合),**不直接点名 skill**。预期:`load_skill(<对应 skill>)`。

### B. 10 个多 skill 任务(测编排)
- 「审查并修复这段代码的 bug」→ systematic-debugging + code-review
- 「理解这个库的架构,制定重构计划」→ codebase-inspection + planning + refactoring
- 「TDD 方式实现新功能并提交 PR」→ TDD + verification + pr-and-ship
- 「给这个库写文档并做一次 code review」→ documentation + code-review
- 「重构代码后验证并提交」→ refactoring + verification + git-workflow
- 「调研某技术并做成演示」→ web-research + create-presentation
- 「分析代码库影响面并规划升级」→ codegraph-structural-navigation + planning + moss-upgrade-and-migration-contract
- 「前端打磨并提 PR」→ frontend-ui-polish + pr-and-ship
- 「系统调试 + TDD 修复」→ systematic-debugging + TDD
- 「codebase 巡检 + 高效编码循环改进」→ codebase-inspection + efficient-coding-loop
预期:按正确顺序调用多个 `load_skill`,集合包含预期 skills。

### C. 10 个拒识任务(测不硬套,4 类)

拒识任务的核心是测「moss 会不会硬套 skill」。**带陷阱的拒识**(表面像某 skill 场景,实则简单问答)才有区分度;纯无关任务是基线确认。

**类型 1:像 code-review 但只是问事实(陷阱)**
- 「calc.ts 里的 add 函数返回什么」(问事实,不是要 review)
- 「divide 函数定义在哪一行」

**类型 2:像 git-workflow 但只是查询(陷阱)**
- 「当前在哪个分支」(查一下,不是要走 git workflow skill)
- 「最近 3 个 commit 是什么」

**类型 3:像 documentation/refactoring 但只是问答(陷阱)**
- 「这个项目用了哪些依赖」(读 package.json,不是要写文档)
- 「add 函数有几个参数」

**类型 4:纯无关(基线,确认不会乱套)**
- 「2+3 等于几」
- 「把这段话翻译成英文:hello world」
- 「列出当前目录文件」
- 「现在几点」

预期:`load_skill` 调用次数 = 0。**类型 1-3 是主判分点**(陷阱难度),类型 4 是基线。

## 判分(两层)

### 第一层:选择准确率(自动,严格口径 = 只认 load_skill)
从 stream-json 提取所有 `load_skill` 调用的 `name` 参数:
- 单 skill 任务:`loadedSkill === expectedSkill` ✓
- 多 skill 任务:`loadedSkills ⊇ expectedSkills`(集合包含)+ 顺序软检查
- 拒识任务:`load_skill` 次数 = 0 ✓
- **辅助观测(不计入准确率)**:nudge 触发率(nudge 消息出现)、nudge 响应率(nudge 后是否调 load_skill)

### 第二层:执行质量(人工抽样)
加载 skill 后是否真按 skill 方法做:
- code-review:有无产出 review 报告(而非只读文件)
- TDD:有无先写失败测试再实现
- verification:有无运行验证步骤
- documentation:有无产出文档
靠 diff/transcript 人工判,harness 标候选进 review-samples。

## 性能指标(尽量多)

| 指标 | 类型 | 说明 |
|---|---|---|
| skill 选择准确率(单 skill) | 自动 | loadedSkill==expected 占比 |
| 拒识准确率 | 自动 | 不该用 skill 时 load_skill=0 占比 |
| 多 skill 召回率 | 自动 | 预期 skills 被加载的比例 |
| 多 skill 顺序正确率 | 自动 | 调用顺序与预期一致 |
| nudge 触发率(辅助) | 自动 | 该触发 nudge 的任务里 nudge 出现比例 |
| nudge 响应率(辅助) | 自动 | nudge 后模型调 load_skill 的比例 |
| 幻觉 skill 调用 | 自动 | 调了不存在的 skill name |
| 误选 skill | 自动 | 选了错误但存在的 skill |
| 执行质量 | 人工 | 加载 skill 后真按方法做的比例 |
| 中文 vs 英文 prompt 准确率差 | 自动 | 同 skill 中英 prompt 对比 |
| skill 首次加载轮数 | 自动 | load_skill 首次出现在第几 turn |
| 重复 load 同 skill | 自动 | 死循环/重试信号 |

## 公平性

- 同 GLM、同 prompt 措辞(中性,不点名 skill)。
- N=1 试水(沿用 moss-eval 现有 harness 模式),后按需补 N=3。
- 同初始态:每任务独立 fixtures reset。
- web-research 联网不可控:**跑,但只判选择准确率(load_skill 选对与否)**,执行质量不判(联网结果不可控)。单 skill 任务里 web-research 用一个明确查询(如「查 TypeScript 5.5 的发布说明」),判 load_skill('web-research') 是否触发。

## 待决(实现时定)

- 多 skill 任务的 expectedSkills 顺序:硬序还是集合?倾向**集合包含 + 软序**(允许合理顺序变体)

## 产出物

1. `tasks-skill.mjs` — skill 任务定义(id, prompt, expectedSkills[], reject(boolean), lang)
2. `score-skill.mjs` — 从 stream-json 提取 load_skill 调用 → metrics.json + skill-accuracy.csv
3. `runs/skill-eval/<ts>/<task>/moss/round-N/{stream.jsonl, metrics.json}`
4. `reports/skill-accuracy.csv` + `skill-execution-samples.md`(人工复核)+ `skill-summary.md`

## 复用 moss-eval harness

- 复用 `run-subject.mjs`(moss 调用)、`collect.mjs`(stream 解析,扩展提取 load_skill)、`pool.mjs`、`run-eval.mjs` 模式
- 新增 `tasks-skill.mjs`、`score-skill.mjs`,不动现有 L2/L3 测试集

## 范围外

- 不对比 moss vs claude(本轮只测 moss skill 能力,单边基线)
- 不调 moss skill 相关代码(只测不调)
- 不实现新 skill

- 多 skill 任务的 expectedSkills 顺序:硬序还是集合?倾向**集合包含 + 软序**(允许合理顺序变体)
- web-research:跑还是跳过?倾向**跑但只判选择**(联网执行不可控)
