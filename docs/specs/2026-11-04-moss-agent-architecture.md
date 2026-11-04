# Moss agent 架构清理：删什么、换什么、为什么

- 日期：2026-11-04
- 状态：implemented（D1–D6 已落地并实跑验证，见 §7）
- 前置证据：
  - [`docs/research/2026-11-04-cursor-claude-agent-design/why-design.md`](../research/2026-11-04-cursor-claude-agent-design/why-design.md)
    —— Cursor / Claude Code 12 个机制的"为什么"与代价，本文的产品判断全部引自这里，不重复论证。
  - [`moss-architecture-audit.md`](../research/2026-11-04-cursor-claude-agent-design/moss-architecture-audit.md)
    —— Moss 全量盘点（45 工具、29 nudge、slash/env/SDK 面、死代码、替换候选）。
  - [`docs/specs/2026-11-04-moss-agent-design-p0.md`](2026-11-04-moss-agent-design-p0.md) —— 同日 P0（计划提示词 / 项目指令 v2 / 拒绝文案），本文是其架构级续作。

## 0. 本文要解决的两个问题

用户对上一轮 P0 的批评是准确的：**只加了提示词和文案，没有解释产品为什么这么做，也没有动架构。**
本文按两条标准重做：

1. **为什么**：每个保留/删除/替换都先写清"竞品在优化什么约束"，再落到 Moss 的代码；
   凡是没有证据的动机一律标 `[inf]` 或 `[unknown]`，不把推测当结论。
2. **架构**：删除的不是"看着多余的东西"，而是**没有任何路径能到达、或到达后必然失败**的代码；
   替换的不是"和竞品不一样的地方"，而是**产品原因成立但实现形状错位**的地方。

## 1. 判定规则（先写规则，再动手）

| 动作 | 必须同时满足                                                                                                                                                 |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 删除 | ① 无引用或引用本身是死代码；② 删除后不存在"更容易误用的替代路径"（例如把子命令名当成聊天 prompt 发给模型）；③ 回滚 = `git revert` 单个改动                   |
| 替换 | ① 能说出竞品机制对应的是哪条产品约束（不是"它这么做所以我们也做"）；② 形状改变后行为差异可被实跑观察；③ 公共面（`src/index.ts`）变更需单列并说明 semver 影响 |
| 保留 | 必须写出"为什么现在不做"，并留下可证伪条件；"成本高"不是理由                                                                                                 |

三条规则来自同一个前提（why-design §1.1）：**agent 的固定开销是每轮重复支付的租金**，
所以架构决定的第一优先级是"这条指令/这个工具/这段代码是否每轮都在付钱或占注意力"，
而不是"写起来是否整齐"。

## 2. 为什么这些形状是错的（产品原因 → Moss 代码）

| 竞品机制                                                                                    | 真正的原因（证据在 why-design）                                                             | Moss 原来的错位                                                                                                   | 本文动作                                                                  |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| Cursor 每轮 `<system_reminder>` / CC 每轮 user 附件 + `__SYSTEM_PROMPT_STATIC_BREAKPOINT__` | 模式可中途切；改 system prompt 会重写缓存前缀；两套指令冲突时必须由最后到达的那条宣布优先级 | 模式语义 = 一个 env 开关（`MOSS_PLAN_GATE`）+ 一个工具注册分支；模式本身不携带契约                                | D2：把 plan 变成**模式驱动的可见性 + 动态层契约**，删 env 开关            |
| CC 的 `cacheScope`/静态断点、Cursor 的 per-model 缩 prompt                                  | 稳定前缀按缓存读价重复计费；可变内容必须活在断点之后                                        | stable/dynamic 靠调用点注释和数组下标维护（`mcpPromptLayerIndex`、`installPlanModeLayer`），层没有身份、没有来源  | D3：`CliPromptLayers` 声明式注册表（id/stability/origin），原地更新数组   |
| CC 用户级 `~/.claude/CLAUDE.md` → 项目 → 子目录；Cursor `.cursor/rules` 作用域              | 指令是**作用域**问题：谁在什么范围生效；全量常驻的代价是注意力而不是 token                  | 只读工作区根 `AGENTS.md`（P0 扩到祖先链），缺用户级一层                                                           | D4：`<configDir>/AGENTS.md` 最低优先级，项目文件覆盖它                    |
| CC "a denied call means the user declined it"；Cursor `rejected` ≠ `error`                  | 拒绝是**用户/策略意志**，不是失败；文案决定模型下一步                                       | P0 给所有拒绝追加同一句"不要原样重试"，与 plan 模式拒绝自带的 "Then run it again" **互相矛盾**（why-design §3.1） | D5：四类拒绝（user/mode/policy/headless）在决策点打标，文案各说各的下一步 |
| CC `maxResultSizeChars`、Cursor head/tail 截断                                              | 工具输出预算按**工具语义**定，不能按名字猜                                                  | `read_file` 的预算键写成了不存在的 `read`，实际落到 4k 默认值（审计 B8）                                          | D6：修键为 `read_file`/10k，并删死键 `bash`                               |
| CC 的 harness 不承诺不存在的能力                                                            | 提示词里的每条能力声明都会被模型复述给用户                                                  | behavior prompt 声称 TUI 支持 `Ctrl+V` 贴图 / `[Image #n]`，而 CLI 从未接线附件（审计 A1）                        | D1：删未接线的 `attachments.ts`，并把 prompt 改成"只接受文本"的真话       |

## 3. 已执行：删除（D1）

### 3.1 四个无引用模块（−359 行）

| 模块                       | 行数 | 证据                                                                                            | 删除后的替代路径                                                 |
| -------------------------- | ---- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------- |
| `src/cli/tui/input-box.ts` | 59   | 无 import；粘贴捕获已由 `src/cli/tui/input/key-stream.ts:22,93` 实现，`PASTE_START` 重复定义    | `key-stream.ts` 的 paste 事件 → composer                         |
| `src/cli/attachments.ts`   | 256  | `preparePromptAttachments` 全仓库零调用；CLI 从未把 `ChatOptions.attachments` 传进 `agent.chat` | `@` 提及只插入路径（现状）；SDK 宿主仍可传 `attachments`         |
| `src/cli/setup.ts`         | 37   | re-export 壳，注释自认"为已删除的 `test/cli-setup-commands.spec.mjs` 保留"                      | `setup-wizard.ts` / `config-commands.ts` / `onboarding-hints.ts` |
| `src/cli/identity.ts`      | 7    | re-export 壳，零 import                                                                         | `src/core/agent/identity.ts`                                     |

同时修正了 behavior prompt 的能力声明（见 §2 最后一行）。这一步是"删代码"之外的真正收益：
**模型不再向用户承诺一个不存在的输入方式**——错误的能力声明比缺能力更伤信任。

`docs/cli-parity/{target-spec,moss-baseline}.md` 顶部加了一行历史说明，行号/哈希不再逐条改写：
那两份是**审计快照**，不是活文档。

### 3.2 5 处指向已删 spec 套件的陈旧注释

`src/core/loop/nudges/task-repair-nudge.ts`、`src/cli/workspace-write-copy.ts`（×2）、
`src/cli/tui/help.ts`、`src/cli/interactive-commands.ts` 里的 "locked by test/…spec.mjs"
全部改写为"当前没有 spec 套件，需手工/探针复核"。理由：仓库已于 2026-11-04 删除 504 个 spec，
这些注释会让下一个改代码的人以为存在自动保护。

### 3.3 删除 `MOSS_PLAN_GATE` 环境开关（4 个文件 + 1 个 bench 分支）

`src/tools/plan-gate.ts`、`src/tools/builtin.ts`、`src/cli/tui/app.ts`、`src/cli/config-commands.ts`、
`src/safety/dotenv-safety-env.ts`、`scripts/bench-ab.mjs` 的 `plan-gate` 臂。详见 D2。

## 4. 已执行：替换（D2–D6）

### 4.1 D2 计划模式：env 开关 → 模式驱动的"注册恒定、可见性变化"

**原来的形状**：`MOSS_PLAN_GATE=1` 才注册 `exit_plan`；TUI 用 `producedPlan && planGateEnabled()`
决定是否弹批准门。问题有三层：

1. 模式存在时它的退出动作却可能不存在 —— 与"有模式就必须有出口"矛盾；
2. 环境变量是进程级开关，`/mode` 切换无法改变它（TUI 里 plan 模式批准门靠另一个条件兜住，逻辑分散）；
3. `MOSS_PLAN_GATE` 同时出现在 config 帮助、dotenv 白名单、bench A/B 臂里，变成 4 处维护面。

**现在的形状**（对齐 Cursor/Claude Code 的 `ExitPlanMode` 只在 plan 模式出现）：

| 位置                                   | 改动                                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `src/tools/plan-gate.ts`               | 删 `planGateEnabled`；`exitPlanTool` 恒定注册，描述写清"不会自己切模式，提交后等用户"            |
| `src/tools/builtin.ts`                 | 删跳过分支，`registerBuiltinTools` 恒装全部工具                                                  |
| `src/core/tools/tool-catalog.ts`       | 新增 `PLAN_ONLY_TOOL_NAMES = ['exit_plan']` + `isPlanOnlyToolName`（与 legacy 别名同一命名契约） |
| `src/core/agent/session-tool-offer.ts` | `toolVisibleForRun` 新增 `planMode?: boolean`，非 plan 模式隐藏 plan-only 工具                   |
| `src/core/agent/moss-agent-types.ts`   | 新增 `planModeActive?: () => boolean`（宿主注入；core 不认识 CLI 模式）                          |
| `src/core/agent/moss-agent.ts:1171`    | 可见性过滤透传 `planMode`                                                                        |
| `src/cli-main.ts`                      | `planModeActive: () => getCliInteractionMode() === 'plan'`                                       |
| `src/cli/tui/app.ts:1356`              | 条件简化为 `if (producedPlan)`（`producedPlan` 本身已要求 plan 模式）                            |
| 其余 4 处                              | `MOSS_PLAN_GATE` 全部移除；bench `plan-gate` 臂删除                                              |

**不做什么**：不改审批层 class-level deny（`deriveEngineQuantas`）——提示词让模型提前知道边界，
审批层仍是唯一执行边界；两者不是重复，是"预告"与"执法"。

### 4.2 D3 提示词层：数组下标 → 声明式注册表

**原来的形状**：`cli-main` 建 `extraPromptLayers` / `dynamicPromptLayers` 两个裸数组，
MCP 层靠记下标（`mcpPromptLayerIndex`）、skills 层靠记下标（`skillsLayerIndex`）、plan 层靠
`installPlanModeLayer` 占槽。加一层就要改三处；层的"稳定性"只写在注释里。

**现在的形状**：`src/cli/prompt-layers.ts` 的 `CliPromptLayers`：

- `set({id, stability, origin, text})`：同 id 覆盖文本、**保留声明位置**（重排会让缓存前缀无谓失效）；
  空串不进数组（模式关闭不留空层）。
- `stable` / `dynamic` 两个数组**原地更新**：子代理与宿主拿到的是同一个引用，`/mode` 切换和 MCP
  迟到握手都能到达已存在的 run，不需要重建 agent。
- `formatReport()` + `MOSS_PROMPT_LAYERS=1`：启动时打印层表（id / stability / origin / chars），
  这是"层可归因"的最小观测面（对应 why-design §3.2 指出的 per-layer hash 已有实现但 loop 传空数组的问题——
  这一步先让 CLI 宿主层可归因，core 侧归因另列后续）。

9 个层现在的声明（全部有 id 与来源）：`cli:environment`、`mode:plan`、`project:instructions`、
`contract:answer-language`、`cli:device`、`cli:mcp-index`、`cli:mcp`、`cli:skills`、
`cli:runtime-capabilities`、`cli:context-window`。CLI 内不再有 `promptLayerIndex` 变量。

**兼容性**：`MossAgentConfig.extraPromptLayers` / `dynamicPromptLayers` 语义与引用方式不变，
SDK 宿主无感；这是纯内部重构，公共面零变更。

### 4.3 D4 用户级项目指令

`src/cli/project-instructions.ts` 新增 `userDir`：`<configDir>/AGENTS.md`（或 `CLAUDE.md`）作为
**最低优先级**层加载，标签 `user`，与项目文件共用 32KB/48KB 预算；预算先花在最近目录，用户层最后加载、
最先被跳过（它的作用域最广、最不该挤掉工作区规则）。`cli-main.ts:899` 传 `configDir`。
与 CC 的 `~/.claude/CLAUDE.md` 同构：用户偏好 → 仓库约定 → 目录细节，渲染顺序由外向内。

**这是 P0 的补课不是延伸**：P0 只做了"祖先链 + 双上限"，why-design §3.3 指出真正缺的是**作用域**；
用户级层补的是"跨工作区"这一层作用域，路径级作用域（Cursor `.cursor/rules` 的 globs）列后续。

### 4.4 D5 拒绝语义：一句话术 → 四类决策标记

**问题**（why-design §3.1 实测）：plan 模式拒绝的工具结果同时包含
`Then run "write_file" again`（`src/cli/approval.ts:1369`（原 1359-1366））和
`Do not retry this call unchanged`（`execute-tool-call.ts`），模型收到两条相反指令，最可能的反应是换工具绕行——
正是 `tool-loop-guard.ts` 要封堵的行为。

**形状**：`src/contracts/tool-denial.ts` 定义 `DenialClass = user | mode | policy | headless`，
随 `ToolApprovalDecision` 一起从**决策点**传到渲染点：

| 来源                      | 类         | 话术（中文摘要）                                   | 实跑证据                                            |
| ------------------------- | ---------- | -------------------------------------------------- | --------------------------------------------------- |
| 用户拒绝（交互 y/n）      | `user`     | 用户拒绝了；不要原样重试，改请求或问人             | 交互路径，探针覆盖                                  |
| 模式/只读上限拦截         | `mode`     | 当前模式拦截；不要换工具绕行，请用户切模式后再执行 | plan 模式实跑（模型直接拒绝写文件，契约生效）       |
| 策略/受保护路径/deny 规则 | `policy`   | 策略拦截；不要绕行，改允许路径或说明规则           | `-p --workspace-write` 写工作区外，实跑捕获完整文案 |
| headless 无人可批         | `headless` | 本次无人可批；改无需批准的做法或说明需要什么       | 探针覆盖（headless 拒绝分支）                       |

未分类拒绝保持 P0 的旧话术（向后兼容）；`hook` 自带 `已拦截/Blocked` 的文案仍然原样透传
（它已经包含自己的处理指令，追加第二句就会重新制造矛盾）。

**代价**：`approval.ts` 多了 11 个 `denialClass` 标记、`execute-tool-call.ts` 多 4 组文案。
**收益**：拒绝文案第一次与"谁拒绝的、下一步该干什么"一致；这是 why-design 排序里的第 1 项
（"最便宜且现在是负的"）。

### 4.5 D6 `read_file` 截断预算键修复（审计 B8）

`src/context/tool-output-truncate.ts` 的预算表只有 `read: 10_000`，而 `read_file` 工具结果在
`agent-loop-tool-execution.ts:286` 用 `call.name` = `read_file` 查表 → 落到 4k 默认值。
后果：`file-tools.ts` 按"10k 预算"承诺的整文件读取实际会被拦腰截断，且 `wouldTruncateToolOutput`
的状态记账也跟着错。修复：键改为 `read_file: 10_000`，删掉从未存在的 `bash` 死键，
恢复提示同步改名。

## 5. 明确保留（以及为什么"删掉"会是错的）

| 项                                                                          | 看起来该删的理由              | 为什么保留                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------- | ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 4 个未实现子命令（`plugins`/`migrate`/`web`/`agent`）                       | 永远硬失败，是死面            | 删掉后它们会**退化成聊天 prompt**：`moss plugins` 会把单词 "plugins" 发给模型并花一轮 token。保留"能解析 + 明确告知本构建没有该子系统 + 退出码 USAGE"是更好的错误路径（`command-dispatcher.ts:702`、`subcommand-help.ts:377-404`）            |
| legacy 别名工具 `multi_edit` / `exec_background`                            | 死代码 2,305 chars            | 它们**不发给模型**（`toolVisibleForRun` 恒隐藏），只占注册面；删除会破坏旧 transcript 重放与 SDK 宿主直接调用（`tool-catalog.ts:17` 已写清契约）                                                                                              |
| `tool-loop-guard` 里 27 个"本构建不存在"的工具名                            | 字符串与注册表不同源          | 这些名字是**防御性集合**：MCP/插件/可选 provider 可以注册同名工具（如 codegraph MCP）；删名会让 guard 对它们失效。审计建议"观察一版再删"，采纳                                                                                                |
| 5 层压缩 + 29 nudge + 验收/完成门 + `sideEffectClass`                       | 看起来"比竞品复杂"            | 这三项是 Moss **领先**而不是欠债：CC 的压缩摘要 9 节、Cursor 的 HISTORICAL 段都不如 Moss 的 10 节 + 证据分级 + 确定性兜底；nudge 是条件触发（对比 prose 的每轮必付），是否需要合并取决于触发率 A/B，不取决于代码行数（why-design §3.5、§5.2） |
| RSI 子系统、SDK 的 3 个 `export *`、`buildMossDefaultWorkflowPrompt`        | 审计 C 级，公共面无自动化保护 | 删/收窄 = semver 破坏，必须 owner 拍板并补 verify 探针（审计 R1/R2）。本文只记录，不擅自改公共面                                                                                                                                              |
| `*ForTest(s)` 钩子、62 个零引用内部 export、nudge 合并、描述 lean/full 两档 | 审计 A4/A5/B1/§9.2 建议       | 无行为收益或需逐个确认引用；在主目标（架构错位）完成前不扩大改动面。审计已给清单，可单独一轮做                                                                                                                                                |

## 6. 与"只改 5 处"排序的对齐

why-design §4 的排序（先修矛盾 → 再修每轮税 → 再修质量地板 → 最后能力发现）：

| 排序                                   | 本文覆盖情况                                                                                     |
| -------------------------------------- | ------------------------------------------------------------------------------------------------ |
| 1 拒绝语义四分类 + 单源化              | ✅ D5（实跑验证 policy/mode；user/headless 探针覆盖）                                            |
| 2 工具面按能力揭示 + sticky 可回收     | 部分：设备工具已按 target 隐藏、task ledger 按 taskFlow 隐藏（既有）；sticky 可回收未做（见 §8） |
| 3 压缩可回溯 + 节标题机器校验          | 未做（§8），Moss 的结构化契约已强于两家                                                          |
| 4 工具 description 否定段 / 跨工具路由 | 未做（§8），零额外轮次、改动局部                                                                 |
| 5 MCP headless 审批探测                | ✅ 已实测**推翻**：`-p` 下 `mcp__rdk-docs__*` 可发现、可调用（含 meta-tool 揭示），G4 不成立     |

## 7. 验证（全部实跑，2026-11-04）

### 7.1 行为探针 `/tmp/moss-arch-probe.mjs`（19/19 PASS，临时脚本不入库）

覆盖：`planModeLayer` 模式映射；注册表声明顺序/原地更新/空串移除/报告格式；拒绝四类话术；`read_file` 10k 预算；
`exit_plan` 仅 plan 模式可见；项目指令单文件头、用户层优先级、同目录不重复加载、
祖先链顺序、`agents.md` 优先、32KB 截断、48KB 总预算丢弃祖先并提示、
本仓库 25KB `AGENTS.md` 全量；拒绝文案四类 + 未分类 + hook 透传。

### 7.2 真实模型端到端（非 mock，`--output-format stream-json`）

| 场景                    | 命令要点                                        | 观察                                                                                                                |
| ----------------------- | ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| plan 模式有出口         | `--plan` + 「调用 exit_plan」                   | 模型调用 `exit_plan`，结果 "Plan submitted for approval…"                                                           |
| 默认模式无出口          | 同 prompt，无 `--plan`                          | 模型回答 "`exit_plan` is not registered for this run, so I did not call it"                                         |
| 拒绝分类（policy）      | `-p --workspace-write` 强制写工作区外           | 工具结果 = 拦截原因 + "A configured policy or protected-path rule blocks this. Do not route around it…"；文件未创建 |
| 截断预算（D6）          | 读 30KB / ≈7.6k tok 文件                        | 模型收到全文（331 行、末行正确、无 truncated）；修复前会在 ~16KB 处截断                                             |
| MCP headless（G4 反证） | `-p` 调 `mcp__rdk-docs__search` → `search_docs` | 首次 meta 搜索、再揭示 6 个工具、最终返回 40PIN 文档命中；**未被审批阻断**                                          |
| 能力声明（D1）          | 问"怎么发图片"                                  | behavior prompt 已改为"只接受文本"，模型不再承诺 `Ctrl+V` 贴图                                                      |

### 7.3 交付门

`npm run build` PASS；`npm run check`（format + lint 0 warning + typecheck）PASS；
`npm run verify`（static + build + smoke + 3 examples）PASS。最终数字见 §9 与交付报告。

## 8. 未完成（按 why-design 排序，写明可证伪条件）

1. **工具面按能力揭示 + sticky 可回收**：现在 deferred 揭示是 sticky（`deferred-tool-offer.ts`），
   长会话工具列表只增不减。可证伪条件：若 bench 里 `errors/turn` 与工具数不相关，则该收益≈0。
2. **压缩可回溯**：把被压缩段写成 `# HISTORICAL -- DO NOT EDIT` 的可读工件（`.moss/` 已有 JSONL 基础），
   摘要里留引用而不是细节。可证伪条件：长会话里模型从不回读历史细节时，收益≈0。
3. **工具 description 否定段 / 跨工具路由**：零额外轮次的误选修复。可证伪：bench 统计误选工具次数无变化。
4. **路径级指令作用域**（Cursor `.cursor/rules` 的 globs / CC 子树 CLAUDE.md）：在当前"祖先链 + 用户层"之上，
   再按路径命中决定"何时生效"。可证伪：全量常驻后任务成功率不降 → 分层是过度设计。
5. **nudge 触发率 A/B**（`MOSS_DISABLE_NUDGES`）：决定 quick prompt 把成本转移到轮次是否划算。
6. **SDK 公共面护栏**（审计 R1/R2）：`verify` 里加 4 个 node 探针（`MOSS_ENV_REFERENCE` 覆盖、
   工具面上限、slash 命令表同源、TUI 键位），成本极低但需要 owner 确认公共面冻结方式。

## 9. 数字（改动后实测）

| 指标                 | 值                                           | 来源                           |
| -------------------- | -------------------------------------------- | ------------------------------ |
| 注册内置工具         | 45（`exit_plan` 恒注册）                     | `builtinTools.length`          |
| 模型可见（无设备）   | 37/45 有设备时；plan 模式多 1（`exit_plan`） | `toolVisibleForRun`            |
| 删除代码             | 359 行（4 个模块）                           | §3.1                           |
| CLI 提示词层         | 10 个声明，全部带 id/stability/origin        | `MOSS_PROMPT_LAYERS=1`         |
| 项目指令预算         | 单文件 32KB / 总 48KB，用户层最低优先级      | `project-instructions.ts`      |
| 拒绝类               | 4 类 + 未分类兼容                            | `src/contracts/tool-denial.ts` |
| `read_file` 输出预算 | 10k tok（原 bug 下实际 4k）                  | `tool-output-truncate.ts`      |

## 10. 回滚

每个动作独立可回滚，均为单文件或单目录改动：

| 动作          | 回滚                                                                                                       |
| ------------- | ---------------------------------------------------------------------------------------------------------- |
| D1 删除       | `git revert` 对应删除提交（4 个模块 + 注释）                                                               |
| D2 计划模式   | 恢复 `planGateEnabled` 分支、`toolVisibleForRun` 的 `planMode` 参数与 `PLAN_ONLY_TOOL_NAMES`；TUI 条件加回 |
| D3 层注册表   | 恢复 cli-main 的两个数组与 MCP/skills 下标；`src/cli/prompt-layers.ts` 可整体删除（无公共面）              |
| D4 用户级指令 | `buildAgentsMdLayer(workspace)` 不传 `userDir` 即回到 P0 行为                                              |
| D5 拒绝分类   | `deniedToolResultText` 忽略第三参即回到 P0 话术；`DenialClass` 是新增可选字段                              |
| D6 预算键     | 改回 `read` 键（不建议——那会把 10k 预算重新降回 4k）                                                       |
