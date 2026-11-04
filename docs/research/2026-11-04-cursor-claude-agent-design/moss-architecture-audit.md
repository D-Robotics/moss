# Moss 架构审计：工具面 / 提示词 / 命令面 / 死代码 / 能力重叠 → 删除与替换清单

- 日期：2026-11-04（审计时刻约 20:2x +08:00）
- 仓库：`/Users/d-robotics/Desktop/RDK_Studio/moss`，`@rdk-moss/agent@0.31.0`
- Git：HEAD `36262014`；**审计开始（20:2x）时工作树 13 个已修改 + 5 个未跟踪**（Lead 的 P0 在飞）；**报告交付时（20:4x）已增至 21 M + 4 D + 7 ??**——其中 `src/cli/attachments.ts`、`src/cli/identity.ts`、`src/cli/setup.ts`、`src/cli/tui/input-box.ts` 四个文件**已被删除**，即本报告 A1/A2/A3 三条建议在审计期间已落地
- 作者：arch-auditor（Team Lead 委派的只读架构审计员，task-6）
- 读者：把"删掉不需要的能力与工具、换掉不如 Cursor/Claude 的设计"落地的 Lead
- 纪律：本文件是本次唯一产出；**未改任何源码、未跑 build/verify/smoke/check/bench、未跑 git 写操作、未装依赖**
- 姊妹文档：`moss-baseline.md`（实测基线，441 行）、`cursor-evidence.md`（779 行）、`claude-evidence.md`（502 行）、`../../design/tool-surface-rea.md`（上一轮工具面 keep/merge/remove，已落地 `repo_outline`/`code_diagnostics` 的删除）

> **审计对象状态（重要）**：`src/` 的最近修改时间是 20:29:12，`dist/` 是 20:17:05 构建的。
> 因此：**工具 schema 字符数、提示词 builder 字符数、命令表、env 表**这些"结构未变"的测量对当前 `src` 仍成立；
> 但**可见性规则**（`PLAN_ONLY_TOOL_NAMES`、`MOSS_PLAN_GATE` 退役）以 `src/` 为准，`dist/` 已落后 3 个文件。
> 本文件对每处都标明数字来自 `dist`（可复跑）还是 `src`（读源码）。

## 0. 一页结论

### 0.1 可直接删（A 级：无引用 / 无行为影响）

| #   | 项                                                                        | 证据                                                                                                                                   | 规模                                          |
| --- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- |
| A1  | `src/cli/attachments.ts` 整模块                                           | 全仓库无 import；`preparePromptAttachments` 零引用（`src/cli/attachments.ts:152`）                                                     | 256 行                                        |
| A2  | `src/cli/tui/input-box.ts` 整模块                                         | 全仓库无 import；粘贴捕获在 `src/cli/tui/input/key-stream.ts:22,93` 另有实现，`PASTE_START` 常量重复定义                               | 59 行                                         |
| A3  | `src/cli/setup.ts` + `src/cli/identity.ts` 两个 re-export 壳              | 二者均零 import；`setup.ts:10` 注释自认"为 `test/cli-setup-commands.spec.mjs` 保留"，而该 spec 已于 2026-11-04 删除                    | 37 + 7 行                                     |
| A4  | 62 个"内部零引用 export"（不含 SDK 公共面）                               | 脚本扫 `src/**/*.ts` 全部顶层 export 声明 → 63 个全仓库零引用，其中仅 1 个在 `dist/index.js` 公共面上（见 §4.3）                       | 48 个文件                                     |
| A5  | 9 个 `*ForTest(s)` 钩子 + 6 处"locked by test/x.spec.mjs"陈旧注释         | spec 套件删除后无调用者（§4.3 逐条列名）；注释指的文件已不存在                                                                         | 9 函数 / 5 文件（6 处）                       |
| A6  | 4 个"能解析但没实现"的 CLI 子命令 `plugins` / `migrate` / `web` / `agent` | `src/cli/command-dispatcher.ts:702` `UNIMPLEMENTED_COMMANDS` 硬失败；`src/cli/subcommand-help.ts:377-404` 各写一段"本构建没有此子系统" | 4 命令 + 4 段 help + 4 个 `CliCommand` 类型位 |

> A 级合计：可删代码约 **379 行**（A1+A2+A3）+ 62 个符号 + 9 个测试钩子 + 6 处陈旧注释 + 4 个未实现命令。零行为影响，回滚 = `git revert`。

### 0.2 需退化处理再删（B 级：先隐藏 / 合并 / 降级，再删）

| #   | 项                                                                                                                                   | 证据                                                                                                                                              | 影响面                     |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| B1  | 6 个同模板 nudge 合并成 1 个 declarative 表（`background-server`/`build-tools`/`git-tools`/`install-tools`/`run-tests`/`web-tools`） | 六者全部走 `defineToolsNudge`（`src/core/loop/nudges/template.ts:41`），差异只有 `userRe`/`sawEvidence`/`correction`                              | 29 个 nudge id 的 6/29     |
| B2  | `buildMossDefaultWorkflowPrompt`（2,687 chars）从公共面退役                                                                          | `src/context/default-workflow.ts:1` 只有 `context/index.ts` → `src/index.ts:28` 导出，**无任何内部调用者**；内容与 behavior/domain quick 三重重叠 | 一个 SDK 导出 + 2.7k chars |
| B3  | 27 个"幽灵工具名"从 `tool-loop-guard` 名字集合中删除                                                                                 | `src/core/tools/tool-loop-guard.ts:22` 起 6 个 Set 的名字字面量与 45 个注册名求差 = 27 个不存在（§2.4d）                                          | 冻结路径，需一个版本观察   |
| B4  | 9 个 `MOSS_*` legacy 别名 + 4 个"读到但忽略"的模型变量退役                                                                           | `src/cli/config-commands.ts:289` 143 项里 9 条标 legacy；`src/cli/config.ts:1533` `IGNORED_MODEL_ENV_VARS` 4 个                                   | env 面 12/143              |
| B5  | AGENTS.md 19,005 chars 常驻 stable 提示词 → 改为分层 / 按需（Cursor rules 模型）                                                     | 实测本仓库 AGENTS.md 25,547 bytes → layer 19,005 chars，占 stable 总量 25,131 chars 的 **75.6%**（§3.2）                                          | 每次请求 ~4.7k tok         |
| B6  | `multi_edit` / `exec_background` 两个 legacy 别名工具退役                                                                            | `src/core/tools/tool-catalog.ts:17` 明确"保留注册给旧 transcript/SDK，永不示给模型"；隐藏后已不占 token，只占维护面（2,305 chars 死代码）         | 2 个工具模块               |

### 0.3 需 owner 决策（C 级：契约 / 冻结子系统 / 公共面）

| #   | 项                                                                       | 为什么必须 owner 拍板                                                                                          |
| --- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| C1  | RSI 子系统（`src/core/rsi/`，6 文件 2,035 行）整体退役                   | 唯一消费者是 `examples/rsi-sdk.mjs` + `src/index.ts` 导出；无 CLI、无工具、无 task 集成。删它 = 破坏 semver 面 |
| C2  | SDK `export *` 三个通配（`contracts` / `core` / `provider`）收成显式清单 | `dist/index.js` 实测 **298** 个运行时导出；通配意味着"任何内部改名都是公共面破坏"，无法冻结                    |
| C3  | `device_*` 12 个工具名与 7 个空 schema 只读探针合并                      | 仓库 `AGENTS.md` 明写"工具名已被 subagent scope、截断预算、loop-guard 按保留名引用，改名等于破坏契约"          |
| C4  | task ledger 6 工具 + `todo_write` 两套计划机制统一                       | Task OS 是 P0 契约；但 `todo-nudge` 已经为此打了补丁（`src/core/loop/nudges/todo-nudge.ts:45-52`）             |
| C5  | 3 个 example 绕过公共面（`../dist/core/agent/moss-agent.js` 等）         | `examples/` 自称"SDK 契约活文档"，实测 4 个例子中 3 个**不经过** `dist/index.js`，契约实际无人测               |

### 0.4 数字看板（全部可复跑，见 §1）

| 维度                 | 实测值                                                                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| 注册内置工具         | 45（`src/tools/builtin.ts:567`，`builtinTools.length`）                                                                                      |
| 模型可见上限         | 37（非 plan 模式）／38（plan 模式）；工作树新增 `PLAN_ONLY_TOOL_NAMES` 只放 `exit_plan`                                                      |
| 默认无设备可见       | 25（device 门隐藏 12 个）                                                                                                                    |
| 45 工具 schema 总量  | 40,518 chars ≈ 10,129 tok                                                                                                                    |
| 可见 37 工具         | 32,599 chars ≈ 8,150 tok（desc 13,608 + schema 16,914 + 名字/框架）                                                                          |
| 默认无设备 25 工具   | 22,304 chars ≈ 5,576 tok                                                                                                                     |
| deferred / legacy    | deferred 5 个 subagent 工具 = 5,218 chars（1,305 tok，靠 `tool_search` 揭示）；legacy `multi_edit`+`exec_background` = 2,305 chars（永不发） |
| stable 提示词（CLI） | 25,131 chars ≈ 6,283 tok，其中 AGENTS.md 19,005（75.6%）                                                                                     |
| quick / full 两档    | behavior 3,187 / 10,011；domain 937 / 6,247；language 507 / 1,002 chars                                                                      |
| 固定契约合计         | identity 768 + lang 507 + domain 937 + behavior 3,187 + 反注入 198 + 语言 90 + caps 439 = 6,126 chars                                        |
| slash / CLI 子命令   | slash 32（hidden 18、别名 11、retired 12）；CLI 20 声明 / 14 实现 / 4 未实现 / 2 走 AgentReady                                               |
| env / config 键      | `MOSS_*` 143 项 / 11 组 / 9 legacy / 4 "读到但忽略"；config.json 20 键（5 个 legacy 走读侧迁移）                                             |
| nudge / SDK 导出     | nudge id 29 + steering rule 5；`dist/index.js` 运行时导出 298                                                                                |
| 死代码               | 死模块 4（`attachments`/`identity`/`setup`/`tui/input-box`）；零引用 export 63（公共面 1、内部 62）                                          |

## 1. 方法（脚本与命令，可复跑）

### 1.1 只读约束

本审计**只**使用以下手段：

- `grep` / `rg` / `read`：读 `src/**/*.ts`；
- `node` + 动态 `import('file://.../dist/xxx.js')`：读**仓库既有** `dist/`（2026-11-04 20:17 产物），不触发 build；
- `wc` / `ls` / `git status` / `git log` / `git diff`（**只读**，无 `git add/commit/checkout`）；
- 未运行 `tsc`、未运行任何 `npm run *`、未跑 CLI 二进制（避免创建 `.moss/` 工件或撞 `dist/`）。

所有中间脚本写在 `/tmp/audit-*.mjs`，不落仓库。下表每行给"复跑方式"。

### 1.2 复跑清单

| 测量                           | 复跑方式                                                                                                                                                                                                                                                                | 输出落点  |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| 工具注册 / 可见 / schema 字符  | `/tmp/audit-tools2.mjs`（import `dist/tools/builtin.js` + `deferred-tool-offer.js` + `tool-catalog.js`，对 `JSON.stringify({name,description,inputSchema}).length` 求和；同时输出 `descChars`/`schemaChars` 两列）                                                      | §2.2-§2.4 |
| 可见性场景（设备/taskFlow 门） | `/tmp/audit-tools3.mjs`（调用 `dist/core/agent/session-tool-offer.js` 的 `toolVisibleForRun`，4 个场景）                                                                                                                                                                | §2.3      |
| 提示词 builder 字符            | `/tmp/audit-prompts.mjs`（import `dist/contracts/index.js`、`dist/context/default-workflow.js`、`dist/contracts/prompts/plan-mode-prompt.js` 等，直接调 builder 取 `.length`）                                                                                          | §3.1      |
| CLI stable 提示词拼装实测      | `/tmp/audit-prompt2.mjs`（identity + 三份 quick + 反注入 + `buildAgentsMdLayer(workspace)` + answerLanguage + `buildRuntimeCapabilitiesPrompt(visibleTools)`）与 `/tmp/audit-prompt3.mjs`（`loadSkills([...])`、`buildEnvironmentContextLayer`、`buildMcpStableIndex`） | §3.2      |
| slash 命令表                   | `/tmp/audit-cmds.mjs`（import `dist/cli/interactive-commands.js`，遍历 `INTERACTIVE_COMMAND_SECTIONS`）                                                                                                                                                                 | §4.1      |
| 模块孤儿（无 import 者）       | `/tmp/audit-dead.mjs`（正则抽 `from                                                                                                                                                                                                                                     | import(   | require(`的`./` `../`说明符建反向图，排除`src/index.ts`、`src/cli-main.ts`，再扫 `bin/ scripts/ examples/ bench/`里`dist/...` 的引用） | §4.3 |
| 零引用 export                  | `/tmp/audit-exports.mjs` + `/tmp/audit-exports2.mjs`（抽 `export function/const/class/interface/type/enum` 名，全仓库计 `\bname\b` 出现次数，==1 判零引用；再用 `dist/index.js` 的导出键区分公共面/内部）                                                               | §4.3      |
| 幽灵工具名                     | `grep -oE "'[a-z][a-z0-9_]*(_[a-z0-9]+)+'" src/core/tools/tool-loop-guard.ts` 与 `src/tools/*.ts` 的 `name:` 求差集                                                                                                                                                     | §2.4      |
| env 参考表计数                 | `node` 正则切 `MOSS_ENV_REFERENCE` 块后统计条目/去重名/legacy 条目                                                                                                                                                                                                      | §7.2      |
| SDK 导出面                     | `node -e "import('file://.../dist/index.js').then(m=>Object.keys(m))"`                                                                                                                                                                                                  | §7.3      |

### 1.3 标记约定

- **实测**：跑过命令/脚本得到的数字；
- **读码**：直接读 `src` 得到的结构事实（含 `文件:行号`）；
- **[unknown]**：无法用只读手段确定（例如"这条 nudge 在真实运行里命中率多少"）；
- **工作树**：指当前未提交状态（13 M + 5 ??）；**dist**：指 20:17 的构建产物。

## 2. 工具面盘点

### 2.1 四层结构（注册 / 可见 / deferred / legacy）

Moss 的工具面有四个**互相独立的轴**，这是本仓库做得比 Cursor/Claude 更显式的地方，也是所有"看起来重复"的来源：

| 层               | 机制                                                             | 数量               | 证据                                         |
| ---------------- | ---------------------------------------------------------------- | ------------------ | -------------------------------------------- |
| 注册（register） | `registerBuiltinTools()` 全量注册，SDK host 可 `tools.get(name)` | 45                 | `src/tools/builtin.ts:596`                   |
| 可见（offer）    | `toolVisibleForRun()` 四道门                                     | 37 / 38（plan）    | `src/core/agent/session-tool-offer.ts:77`    |
| 延迟（deferred） | `DeferredToolOffer`：注册但默认不发，`tool_search` 揭示后 sticky | 5（subagent 一组） | `src/core/tools/deferred-tool-offer.ts:9,39` |
| 别名（legacy）   | 注册、可被旧 transcript/SDK 命中，**永不发**给模型               | 2                  | `src/core/tools/tool-catalog.ts:17`          |

`toolVisibleForRun` 的四道门（全部读码）：

1. `isLegacyAliasToolName` → 否（`session-tool-offer.ts:90`）；
2. `isPlanOnlyToolName && planMode !== true` → 否（**工作树新增**，`isPlanOnlyToolName` 现只含 `exit_plan`，`tool-catalog.ts:33`；门在 `session-tool-offer.ts:93`）；
3. `isDeviceToolName && !deviceConfigured` → 否（12 个 device 工具在没有 `MOSS_DEVICE_HOST`/`devices.json` 时整体隐藏，`session-tool-offer.ts:95`、`src/device/device-tool-offer.ts:29`）；
4. `taskFlow === false && TASK_LEDGER_TOOL_NAMES.has(name)` → 否（6 个 task ledger 工具在纯 chat turn 隐藏，`session-tool-offer.ts:20,96`）；`requiresUserQuestion && userQuestions===false` → 否（headless `-p`，`:97`）。

> 注意第 4 门的语义：**`taskFlow` 不传时 ledger 仍然可见**（`moss -p` 与交互式都不传），只有宿主显式标 `taskFlow:false` 才隐藏。这是"保守默认"的取舍，代价是纯 coding 会话为 6 个 task 工具付 5,671 chars。

### 2.2 全量 45 工具表（实测，来自 `dist`）

`chars` = `JSON.stringify({name,description,inputSchema}).length`；`side`/`retain` 取自 `metadata`；`vis` = 非 legacy/deferred 且非 plan-only。

| #   | 工具                     | chars | sideEffectClass | retain | vis | 组       |
| --- | ------------------------ | ----: | --------------- | :----: | :-: | -------- |
| 1   | `fan_out_subagents`      | 1,983 | subagent        |   ✓    |  D  | subagent |
| 2   | `search_code`            | 1,969 | readonly        |        |  ✓  | search   |
| 3   | `device_deploy`          | 1,955 | device_mutation |        |  ✓  | device   |
| 4   | `exec`                   | 1,889 | local_write     |        |  ✓  | exec     |
| 5   | `create_subagent`        | 1,749 | subagent        |   ✓    |  D  | subagent |
| 6   | `edit_file`              | 1,511 | local_write     |        |  ✓  | edit     |
| 7   | `record_evidence`        | 1,506 | runtime_state   |        |  ✓  | task     |
| 8   | `exec_background`        | 1,463 | local_write     |        |  L  | exec     |
| 9   | `web_search`             | 1,402 | readonly        |        |  ✓  | web      |
| 10  | `device_exec`            | 1,370 | device_mutation |        |  ✓  | device   |
| 11  | `task_define`            | 1,370 | runtime_state   |        |  ✓  | task     |
| 12  | `device_file_write`      | 1,174 | device_mutation |        |  ✓  | device   |
| 13  | `run_tests`              | 1,079 | local_write     |        |  ✓  | exec     |
| 14  | `device_robotics_status` |   971 | readonly        |        |  ✓  | device   |
| 15  | `record_failure`         |   948 | runtime_state   |        |  ✓  | task     |
| 16  | `web_fetch`              |   881 | readonly        |        |  ✓  | web      |
| 17  | `ask_user_question`      |   851 | runtime_state   |   ✓    |  ✓  | harness  |
| 18  | `multi_edit`             |   842 | local_write     |        |  L  | edit     |
| 19  | `search_files`           |   840 | readonly        |        |  ✓  | search   |
| 20  | `device_info`            |   825 | readonly        |        |  ✓  | device   |
| 21  | `task_plan_update`       |   746 | runtime_state   |        |  ✓  | task     |
| 22  | `list_directory`         |   730 | readonly        |        |  ✓  | edit     |
| 23  | `exec_logs`              |   713 | readonly        |        |  ✓  | exec     |
| 24  | `read_file`              |   710 | readonly        |        |  ✓  | edit     |
| 25  | `todo_write`             |   710 | runtime_state   |   ✓    |  ✓  | harness  |
| 26  | `record_repair`          |   710 | runtime_state   |        |  ✓  | task     |
| 27  | `device_file_read`       |   701 | readonly        |        |  ✓  | device   |
| 28  | `tool_search`            |   631 | readonly        |        |  ✓  | search   |
| 29  | `exec_wait`              |   622 | readonly        |        |  ✓  | exec     |
| 30  | `device_cameras`         |   593 | readonly        |        |  ✓  | device   |
| 31  | `device_network`         |   588 | readonly        |        |  ✓  | device   |
| 32  | `device_file_list`       |   580 | readonly        |        |  ✓  | device   |
| 33  | `merge_subagent_patch`   |   579 | local_write     |        |  D  | subagent |
| 34  | `exec_input`             |   547 | local_write     |        |  ✓  | exec     |
| 35  | `device_temperature`     |   546 | readonly        |        |  ✓  | device   |
| 36  | `subagent_status`        |   518 | readonly        |   ✓    |  D  | subagent |
| 37  | `device_processes`       |   507 | readonly        |        |  ✓  | device   |
| 38  | `move_file`              |   496 | local_write     |        |  ✓  | edit     |
| 39  | `device_resources`       |   485 | readonly        |        |  ✓  | device   |
| 40  | `write_file`             |   433 | local_write     |        |  ✓  | edit     |
| 41  | `exit_plan`              |   396 | readonly        |        |  P  | harness  |
| 42  | `task_acceptance`        |   391 | runtime_state   |        |  ✓  | task     |
| 43  | `subagent_stop`          |   389 | subagent        |   ✓    |  D  | subagent |
| 44  | `apply_patch`            |   339 | local_write     |        |  ✓  | edit     |
| 45  | `exec_stop`              |   280 | local_write     |        |  ✓  | exec     |

合计 40,518 chars。`retainResult: true` 只有 6 个（`fan_out_subagents`、`create_subagent`、`subagent_status`、`subagent_stop`、`ask_user_question`、`todo_write`）——这是"折叠旧结果时不能把头尾截断"的白名单，语义正确，但 **8 个 `runtime_state` 工具里只有 2 个声明 retain**：`record_evidence`（1,506 chars 的结构化证据）与 `task_define`（1,370）没有 retain，折叠时会被切成 stub。这是一个待确认点（§10 U3）。

### 2.3 成本表（按组，实测）

| 组       | 工具数 | 全量 chars | 全量 tok | 可见 chars | 可见 tok | 说明                                   |
| -------- | -----: | ---------: | -------: | ---------: | -------: | -------------------------------------- |
| device   |     12 |     10,295 |    2,574 |     10,295 |    2,574 | 无设备时整体隐藏（最常见默认）         |
| exec     |      7 |      6,593 |    1,648 |      5,130 |    1,283 | `exec_background` 为 legacy，发不出去  |
| task     |      6 |      5,671 |    1,418 |      5,671 |    1,418 | 只有 `taskFlow:false` 才隐藏           |
| subagent |      5 |      5,218 |    1,305 |          0 |        0 | deferred，`tool_search` 后才有         |
| edit     |      7 |      5,061 |    1,265 |      4,219 |    1,055 | 含 legacy `multi_edit` 842             |
| search   |      3 |      3,440 |      860 |      3,440 |      860 | `search_code` 单工具 1,969（最大之一） |
| web      |      2 |      2,283 |      571 |      2,283 |      571 |                                        |
| harness  |      3 |      1,957 |      489 |      1,561 |      390 | `exit_plan` 396 仅 plan 模式发         |
| **合计** |     45 |     40,518 |   10,129 |     32,599 |    8,149 | 非 plan 模式可见 37                    |

三个"默认会话"的实测成本（`/tmp/audit-tools3.mjs`）：

| 场景                              | 工具数 |  chars |   tok |
| --------------------------------- | -----: | -----: | ----: |
| 有设备 + taskFlow 开 + 非 plan    |     37 | 32,599 | 8,150 |
| 无设备 + taskFlow 开 + 非 plan    |     25 | 22,304 | 5,576 |
| 无设备 + `taskFlow:false`（纯聊） |     19 | 16,633 | 4,158 |

> **工具面是最大单项 token 税**：默认 25 工具 ≈ 5,576 tok，是 CLI 固定契约 prose（6,126 chars ≈ 1,531 tok）的 **3.6 倍**。任何"只改提示词"的优化，收益上限都很低。

### 2.4 结论：工具面的四个问题

**(a) 编辑类是真的多（4 条写路径 + 1 条移动 + 2 条读/列）**

`EDIT_TOOL_NAMES = ['edit_file','multi_edit','apply_patch','write_file']`（`src/core/tools/tool-catalog.ts:45`）—— 模型可见的是 3 条（`multi_edit` 已 hide）：

| 路径          | chars | 何时用（description 自述）                          |
| ------------- | ----: | --------------------------------------------------- |
| `edit_file`   | 1,511 | 精确串替换，`edits[]` 支持批量（已吸收 multi_edit） |
| `apply_patch` |   339 | 跨文件 patch（Cursor/Qoder 无等价物）               |
| `write_file`  |   433 | 新建 / 整体重写（需先读）                           |
| `move_file`   |   496 | 移动，带"先读"与覆盖保护                            |

`apply_patch` 是唯一"别的 harness 不需要"的路径，`docs/design/tool-surface-rea.md` 已把它定为 "keep (documented compatibility path)"。**结论：编辑族不再需要删除，但 `apply_patch`+`write_file`+`move_file` 合计 1,268 chars 的 description 可以合并成一份"写路径路由表"放进 behavior quick 一次讲清——目前三份 description 各自重复"先 read"**。

**(b) 搜索类是"1 个真搜索 + 2 个辅助"**

`search_code`（1,969，最大非 deferred 工具）承担全部文本检索；`search_files`（840）只做文件名；`tool_search`（631）只揭示 deferred 组。三者不重复，**但 `search_code` 的 description 有 303 chars、schema 1,611 chars**（22 个参数级 description），是全仓库 schema 最大的单工具。按 Claude Code 的 lean/full 两档（`claude-evidence.md` §A4），这 1,969 chars 里应有一部分移到"第一次调用失败后"才下发。

**(c) 7 个 device 只读探针是"空 schema + 长 prose"**

实测 `device_info` / `device_processes` / `device_resources` / `device_temperature` / `device_robotics_status` / `device_network` / `device_cameras` 的 `inputSchema` 都是 `{type:'object',properties:{}}`（**33 chars**），参数说明全部写在 description 里：

desc chars 依次为 `device_robotics_status` 869 / `device_info` 736 / `device_cameras` 502 / `device_network` 497 / `device_temperature` 451 / `device_processes` 414 / `device_resources` 392 —— 7 个工具合计 4,515 chars 可见成本，换 7 个"固定 SSH 探针"。这不是"重复能力"而是**7 个静态动词被建模成工具**；替换形状见 §9.4（一个 `device_probe(kind)` + 一个 schema），但改名是 C 级（`AGENTS.md` 已声明工具名是契约）。

**(d) 27 个幽灵工具名（实测）**

`src/core/tools/tool-loop-guard.ts` 里带下划线的单引号字面量去重后 **73 个**，与 45 个注册工具名求差 → **27 个在本构建里不存在**：

```
codegraph_search codegraph_callers codegraph_callees codegraph_trace codegraph_impact
codegraph_node codegraph_context codegraph_explore codegraph_files codegraph_status   (10 个)
skillhub_search skillhub_install install_skill load_skill                            (4 个)
memory_read memory_write memory_delete                                               (3 个)
plan_step generate_structured                                                        (2 个)
web_browser_fetch web_browser_control vision_analyze screenshot_capture fleet_batch  (5 个)
normal_nonzero start_failure                                                         (2 个，故障种类常量而非工具)
codegraph_                                                                           (1 个，前缀碎片)
```

另有 `bash`（无下划线，在 `SHELL_TOOLS` 里）同样不是本构建的工具名。

同批幽灵名还出现在：

- `src/context/tool-output-truncate.ts:1` 的预算表里 `read` / `bash` / `device_diagnose`（真实工具是 `read_file` / 无 bash / 无 device_diagnose）；
- `src/context/runtime-capabilities.ts:17` 的 `isCodeGraphToolName`（本仓库**没有任何** codegraph 工具）；
- `src/context/default-workflow.ts:12` 的 "Prefer CodeGraph …" 建议（该函数无内部调用者，见 B2）。

**这不是笔误，是一种设计立场：用名字集合给"别的 harness 的工具"兜底。** 代价是：`read_file` 的真实截断预算键是 `read_file`（不在表里 → 落 4,000 tok 默认），而 `file-tools.ts:313,318` 自查时用的键是 `read`（10,000 tok）——**两处对同一份输出给出不同预算**（读码，`tool-output-truncate.ts:1-33`）。这条不一致本身就是"名字集合代替 metadata"的直接后果，也是 §9.1 替换候选的第一顺位。

## 3. 提示词资产

### 3.1 资产表（实测字符数）

| 资产                                       | builder / 常量                         |                   quick |   full | 默认启用                       | 位置                                                        |
| ------------------------------------------ | -------------------------------------- | ----------------------: | -----: | ------------------------------ | ----------------------------------------------------------- |
| 身份 / soul                                | `resolveSoulIdentity()`                |                     768 |      — | ✓（stable）                    | `src/core/agent/soul.ts:76`                                 |
| 语言策略                                   | `buildLanguagePolicyPromptQuick/`      |                     507 |  1,002 | quick                          | `src/contracts/prompts/language-policy-prompt.ts:2,14`      |
| 领域（软件工程）                           | `buildSoftwareEngineeringPromptQuick/` |                     937 |  6,247 | CLI 显式 quick                 | `src/contracts/prompts/software-engineering-prompt.ts:2,49` |
| Agent 行为契约                             | `buildAgentBehaviorPromptQuick/`       |                   3,187 | 10,011 | quick                          | `src/contracts/prompts/agent-behavior-prompt.ts:6,66`       |
| 工具结果反注入                             | `TOOL_RESULT_HANDLING_SECTION`         |                     198 |      — | ✓ 恒开                         | `src/core/agent/moss-agent.ts:137`                          |
| Plan 模式契约                              | `PLAN_MODE_PROMPT`                     |                     932 |      — | 仅 plan 模式（**工作树新增**） | `src/contracts/prompts/plan-mode-prompt.ts:13`              |
| 默认工作流（**无内部调用者**）             | `buildMossDefaultWorkflowPrompt`       |                   2,687 |      — | ✗（只经 SDK 导出）             | `src/context/default-workflow.ts:1`                         |
| Runtime capabilities                       | `buildRuntimeCapabilitiesPrompt`       |                     439 |      — | ✓（stable）                    | `src/context/runtime-capabilities.ts:55`                    |
| 项目指令（本仓库 AGENTS.md）               | `buildAgentsMdLayer`                   |                  19,005 |      — | ✓（stable）                    | `src/cli/project-instructions.ts:139`                       |
| answer language                            | `buildAnswerLanguageLayer`             |                      90 |      — | ✓（stable）                    | `src/cli/cli-locale.ts:340`                                 |
| skills 索引（本仓库 3 个 skill）           | `buildSkillsPromptLayer`               |                     647 |      — | ✓（dynamic）                   | `src/core/skills/skill-registry.ts:193`                     |
| 无 skills 提示                             | `buildEmptySkillsHintLayer`            |                     333 |      — | 无 skill 时                    | `src/core/skills/skill-registry.ts:210`                     |
| MCP 索引（rdk-docs）                       | `buildMcpStableIndex`                  |                     145 |      — | ✓（dynamic）                   | `src/core/mcp/registry.ts:752`                              |
| 环境层                                     | `buildEnvironmentContextLayer`         |                   1,497 |      — | ✓（dynamic）                   | `src/context/environment.ts:49`                             |
| 压缩摘要（system + user + update + merge） | `SUMMARIZATION_SYSTEM_PROMPT` 等 4 个  | 949 / 1,348 / 627 / 316 |      — | 压缩时                         | `src/context/compaction-prompts.ts:11`                      |
| 子代理 scope addon                         | `buildSubagentPromptAddon`             |                按 scope |      — | 子代理时                       | `src/core/subagent/spawn-profile.ts:129`                    |
| 设备安全确认文案                           | `deviceDestructivePrompt`              |               按 locale |      — | 危险设备操作时                 | `src/cli/device-safety-prompt.ts:46`                        |

### 3.2 拼装与 stable / dynamic 实测

`MossAgent.buildSystemPrompt()` 是唯一拼装点（`src/core/agent/moss-agent.ts:333`），CLI 追加层在 `src/cli-main.ts:884-910`、`1455-1475`：

```
stable = identity(768) + lang quick(507) + domain quick(937) + behavior quick(3,187)
       + 反注入(198) + AGENTS.md(19,005) + answerLanguage(90) + runtimeCaps(439)
       = 25,131 chars ≈ 6,283 tok
dynamic = env(1,497) + skills(647) + mcp(145) [+ plan(932) 仅 plan 模式]
       = 2,289 chars ≈ 572 tok（默认）
```

**结论：AGENTS.md 是 stable 的 75.6%（19,005 / 25,131）**，是全部固定契约 prose（6,126 chars）的 **3.1 倍**。上一轮基线的 G5"25KB 被 16KB 截断"已被工作树的 32KB/48KB 上限修掉（`PROJECT_INSTRUCTION_MAX_FILE_BYTES = 32*1024`，`project-instructions.ts:20`），代价是 19k chars 常驻——**修好了信息损失，放大了 token 税**。这也是 B5 的依据。

顺带一个正向结论：dynamic 从"17k chars"（旧基线，16KB 截断的 AGENTS.md 在 dynamic）降到 2,289 chars，`prompt-prefix-cache` 的 "dynamic ≤25%" 门槛（`src/core/llm/prompt-prefix-cache.ts:34`）现在**很可能第一次满足**（2,289/27,420 ≈ 8.3%）——这值得 Lead 用真实请求验证一次（§10 U2）。

### 3.3 规则 × 出现位置（重叠矩阵）

同一条规范散文出现在 ≥2 处即为重叠。抽 8 条最常被重复的：

| 规范                                                           | behavior quick | domain quick | domain full | default-workflow（死） | AGENTS.md |       nudge       | 其它                               |
| -------------------------------------------------------------- | :------------: | :----------: | :---------: | :--------------------: | :-------: | :---------------: | ---------------------------------- |
| "改完跑一次被改行为；format/lint/typecheck 是交付门不是每步门" |       ✓        |      ✓       |      ✓      |           ✓            |     ✓     |         —         | `red-verify` nudge 再讲一遍        |
| "最小改动 / 不做投机抽象"                                      |       ✓        |      ✓       |      ✓      |           ✓            |     ✓     |         —         |                                    |
| "证据优先 / 不要散文宣称完成"                                  |       ✓        |      ✓       |      ✓      |           ✓            |     ✓     | `acceptance-gate` | completion gate 代码               |
| "读源码再改"                                                   |       ✓        |      ✓       |      ✓      |           —            |     ✓     |         —         | `edit_file` description            |
| "AGENTS.md/CLAUDE.md 优先于通用经验"                           |   ✓（2 处）    |  ✓（2 处）   |      ✓      |           ✓            |     —     |         —         | `default-workflow.ts:5`            |
| "多独立子任务并行 / 派 subagent"                               |       ✓        |      —       |      —      |           ✓            |     ✓     |     `fan-out`     | `create_subagent` description      |
| "不要用 GUI 打开终端"                                          |       —        |      —       |      —      |           ✓            |     —     |         —         | `default-workflow.ts:16`（死代码） |
| "SPEC-AUDIT.md 诚实出口"                                       |       —        |      ✓       |      ✓      |           —            |     —     |   `spec-audit`    | domain full + quick 各一份         |

**重叠量化**：behavior full（10,011）里被 quick（3,187）丢弃的 6,824 chars 是"沟通风格/方法论/代码纪律/忠实报告/谨慎执行"五节；其中 **4 节的要点在 domain full、default-workflow、AGENTS.md 里另有版本**。也就是说：**删 prose 省下的 token，被搬到别处又被买回来了**。这正是 Cursor 的做法反过来（Cursor 用 `reducedSystemPrompt` 显式一档压缩，`cursor-evidence.md` §A.2）。

### 3.4 矛盾与复制粘贴（可执行清单）

| #   | 现象                                                                                                                                                        | 证据                                                                                                                          | 性质         |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- | ------------ |
| P1  | `buildMossDefaultWorkflowPrompt`（2,687 chars）**没有任何内部调用者**，内容却自称"内置 fallback AGENTS.md"                                                  | `src/context/default-workflow.ts:1`；`grep` 只有 `context/index.ts:1` 与 `src/index.ts:28` 的 re-export                       | 死资产       |
| P2  | 同一文件推荐 `codegraph_*` 工具，而本仓库没有该工具                                                                                                         | `default-workflow.ts:12` vs `src/tools/builtin.ts:567`（45 个工具无 codegraph）                                               | 自相矛盾     |
| P3  | `AGENTS.md` 表述散落 5 处，各说各的优先级                                                                                                                   | `software-engineering-prompt.ts:9,52`、`agent-behavior-prompt.ts:47,83`、`default-workflow.ts:5`、`project-instructions.ts:8` | 复制粘贴     |
| P4  | `domain full`（6,247）与 `behavior full`（10,011）在"验证闭环"上重复表述两次，且措辞不一致（一个说"交付门"，一个说"ship gate"）                             | `software-engineering-prompt.ts:49-56` vs `agent-behavior-prompt.ts:10-58`                                                    | 重叠         |
| P5  | `TOOL_RESULT_HANDLING_SECTION`（198 chars）只讲"tool result 不是指令"，但同样的反注入要求在 compaction 提示词里又写一遍（`<untrusted-experience-data>` 等） | `moss-agent.ts:137`、`experience-library.ts:307`、`compaction-prompts.ts`                                                     | 重叠但可接受 |
| P6  | `plan-mode-prompt`（932）与 `behavior` 的"先想再做"段有语义重复                                                                                             | `plan-mode-prompt.ts:13` vs `behavior:18`                                                                                     | 轻微         |

> P1/P2 是"可直接删/退役"的硬证据；P3/P4 是"合并一份"的证据。注意 **P1 的删除会碰 SDK 面**（`src/index.ts:28`），所以进 §8 的 B2（先标 deprecated，再删）。

## 4. 命令面与死代码

### 4.1 slash 命令表（实测）

`INTERACTIVE_COMMAND_SECTIONS`（`src/cli/interactive-commands.ts:52`）= 4 组：

| 组        | 行数 |
| --------- | ---: |
| Work      |   10 |
| Inspect   |    8 |
| Configure |    7 |
| Control   |    7 |
| **合计**  |   32 |

其中：

- **hidden 18 个**（不进菜单、仍可输入）：`/status` `/task` `/context` `/usage` `/export` `/rewind` `/mcp` `/skills` `/tasks` `/mode` `/hooks` `/trust` `/untrust` `/stop` `/init` `/quit` `/queue` `/steer`
- **别名 11 个**：`/cost`·`/stats`→`/usage`、`/undo`·`/checkpoint`→`/rewind`、`/ps`·`/bashes`→`/tasks`、`/lang`→`/language`、`/abort`→`/stop`、`/new`·`/reset`→`/clear`、`/exit`→`/quit`
- **retired 12 个**（迁移表，`interactive-commands.ts:286`）：`/loop`(suggest→`/goal`)、`/jobs` `/bg` `/subs`→`/tasks`、`/history` `/evidence` `/deployments` `/failures`→`/task view *`、`/sessions`→`/resume`、`/mode` 与 `/steer` `/queue` 三条"保留一个版本"
- **仅 tui**：`/theme`（`surfaces:['tui']`）

**结论**：32 条里 **18 条 hidden + 11 个别名 + 12 个 retired = 41 个名字**在维持一个"用户记不住"的命名空间。`/mode`、`/steer`、`/queue` 三行的 migration 文案自认"保留一个版本"（`interactive-commands.ts:314-329`）——**版本承诺已经到期或即将到期，是 B 级退役候选**。

### 4.2 CLI 子命令面

`KNOWN_COMMANDS` 20 个（`src/cli/args.ts:211`），`COMMANDS` 表 14 个 handler（`src/cli/command-dispatcher.ts:228`），`resume`/`fork` 走 AgentReady，**4 个未实现**：

```ts
// src/cli/command-dispatcher.ts:702
export const UNIMPLEMENTED_COMMANDS: readonly string[] = ['plugins', 'migrate', 'web', 'agent'];
```

`subcommand-help.ts:377-404` 各给一段"本构建没有 X 子系统"的本地化文案（plugins / migrate / web / agent）。这 4 个名字还占着 `CliCommand` 类型位（`args.ts:11-31`）与 help 索引。**A 级删除**（若担心用户习惯，降为 hidden alias 指向 `--help`，但当前行为已是硬失败，删掉只是把"明确报错"变成"未知命令"，需 1 行 `COMMAND_LIKE_REDIRECTS` 补丁即可保持体验）。

### 4.3 死代码清单（实测）

**(a) 4 个孤儿模块**（无任何 import 者，也未被 `bin/ scripts/ examples/ bench/` 引用）

| 模块                       | 行数 | 证据                                                                                           |
| -------------------------- | ---: | ---------------------------------------------------------------------------------------------- |
| `src/cli/attachments.ts`   |  256 | `preparePromptAttachments` 全仓库 1 次出现（定义处）；模块无 importer                          |
| `src/cli/setup.ts`         |   37 | re-export 壳；注释自认"为 `test/cli-setup-commands.spec.mjs` 保留"（`setup.ts:10`），spec 已删 |
| `src/cli/identity.ts`      |    7 | re-export 壳，无 importer                                                                      |
| `src/cli/tui/input-box.ts` |   59 | 无 importer；粘贴捕获在 `tui/input/key-stream.ts:22,93` 另有实现                               |

**(b) 63 个零引用 export**（`\bname\b` 全仓库计数 == 声明本身）

- 其中 **1 个在 SDK 公共面**：`mossScopedInferenceVersion`（`src/index.ts:218`，`dist/index.js` 有该导出键）→ C 级（semver 面）。
- **62 个是内部死符号**，按文件聚合（实证详见 §1.2 脚本）：

| 文件                                     | 死 export                                                                                                                                                                                                        |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/cli/model-pricing.ts`               | `lookupModelPrice:317`、`takeUnknownPriceNotice:467`、`resetUnknownPriceNoticeForTests:473`                                                                                                                      |
| `src/cli/tui/transcript.ts`              | `renderTranscriptRows:839`、`infoBlock:1038`、`renderComposer:1248`                                                                                                                                              |
| `src/cli/context-report.ts`              | `buildFreshSessionContextReport:133`、`formatContextReport:325`                                                                                                                                                  |
| `src/cli/approval-view.ts`               | `approvalAnswerAllows:111`、`approvalAnswerTrusts:116`                                                                                                                                                           |
| `src/cli/attachment-refs.ts`             | `extractAttachmentRefs:3`、`formatAttachmentChip:20`                                                                                                                                                             |
| `src/cli/repl-chrome.ts`                 | `formatTuiSessions:14`、`activityLabel:57`                                                                                                                                                                       |
| `src/cli/setup-wizard.ts`                | `setupMenuLines:50`、`formatDiscoveredModels:89`                                                                                                                                                                 |
| `src/cli/tui/render-bridge.ts`           | `formatUsage:776`、`visibleRows:876`                                                                                                                                                                             |
| `src/cli/workspace-trust.ts`             | `deliverWorkspaceTrustNotice:268`、`trustQuestion:281`                                                                                                                                                           |
| `src/contracts/task-runtime.ts`          | `formatTaskPhase:340`、`formatFailureRecord:345`                                                                                                                                                                 |
| `src/core/task-runtime/runtime.ts`       | `formatTaskSummaryLine:760`、`formatEvidenceCardLine:773`                                                                                                                                                        |
| `src/tools/web-search/chain.ts`          | `searchBackendBlockedStreak:57`、`resetSearchBackendStreaksForTests:62`                                                                                                                                          |
| `src/safety/protected-path-approvals.ts` | `clearProtectedPathApprovals:26`、`listProtectedPathApprovals:30`                                                                                                                                                |
| 其余 32 个文件                           | 各 1 个符号，含 `src/cli/approval.ts:219`（`getCliApprovalAskerForTest`）、`src/core/tools/tool-catalog.ts:59`（`TOOL_FAMILY_NAMES`）、`src/core/tools/background-process-registry.ts:26` 等；完整清单见脚本输出 |

**根因**：`test/*.spec.mjs` 504 个文件于 2026-11-04 删除，spec 专用导出与 re-export 壳失去了唯一消费者。这是一整层"孤儿地层"，不是零散笔误。

**(c) 9 个 `*ForTest(s)` 钩子**（全部零调用）

```
resetUnknownPriceNoticeForTests      src/cli/model-pricing.ts:473
resetSearchBackendStreaksForTests    src/tools/web-search/chain.ts:62
getCliApprovalAskerForTest           src/cli/approval.ts:219
resetDeferredRoutingEnvForTests      src/cli/config.ts:2789
clearBackgroundCompletionReminderForTests src/core/loop/background-completion.ts:34
setKillEscalationMsForTests          src/core/tools/background-process-registry.ts:26
clearBackgroundRegistryForTests      src/core/tools/background-process-registry.ts:108
clearPreToolHooksForTests            src/core/tools/tool-pipeline.ts:25
resetFailoverEventsForTests          src/provider/multi-provider-router.ts:64
```

**(d) 失效的"隐性契约"**（最隐蔽的一类，删除 spec 时一起消失了）

| 契约                                          | 原执行者（已删）                                                                 | 现在谁保证                                                               | 证据                                                     |
| --------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------ | -------------------------------------------------------- |
| `MOSS_ENV_REFERENCE` 与源码 `MOSS_*` 双向覆盖 | 注释自述"a coverage test scans src/ … and fails"（`config-commands.ts:286-288`） | **无人**。`scripts/verify/` 只有 static/build/smoke/examples 4 段        | `config-commands.ts:286`、`scripts/verify/cli.mjs:27-33` |
| 工具面数量与 payload 上限                     | `docs/design/tool-surface-rea.md` 称 `test/builtin-tool-surface.spec.mjs` 断言   | **无人**（本文件实测 40,518 chars 与该文档的 25,052 bytes 口径已不可比） | `tool-surface-rea.md:128,191`                            |
| REPL / TUI 命令表同源                         | `interactive-commands.ts:15` 称 `test/cli-interactive-commands.spec.mjs` 锁住    | **无人**                                                                 | `interactive-commands.ts:15`                             |
| TUI 键位表                                    | `src/cli/tui/help.ts:71` 称 `test/tui-command-surface.spec.mjs` 失败即报错       | **无人**                                                                 | `tui/help.ts:71`                                         |

> 这四行是本次审计最值得 Lead 立刻补的：**不需要恢复 504 个 spec**，只需在 `scripts/verify/cli.mjs` 加 4 个 assert 阶段（或 4 个 `node -e` 探针），成本极低。否则"删 spec 换 60s 验证预算"的收益正在被这些静默漂移吃掉。

## 5. 能力重叠矩阵

### 5.1 四套"工作区 Markdown → 提示词"机制

| 机制         | 目录                                                                    | 披露方式                                              | 消费入口                                                   | 证据                                                                                  |
| ------------ | ----------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| 项目指令     | 仓库根 → workspace 的 `AGENTS.md`/`CLAUDE.md`（祖先链，最多 12 层）     | **全量注入 stable**（19,005 chars）                   | 每轮 system prompt                                         | `src/cli/project-instructions.ts:20,27,30,139`                                        |
| Skills       | `<ws>/.moss/skills/<name>/SKILL.md` + `<configDir>/skills/`             | 索引 1 行进 prompt，正文走 `skill` 工具（≤24k chars） | 模型调 `skill` 工具；**也可当 slash 命令**（`/skillname`） | `src/core/skills/skill-registry.ts:167,193`、`src/cli/commands/custom-commands.ts:82` |
| 自定义命令   | `<ws>/.moss/commands/*.md` + `<configDir>/commands/`                    | 不进 prompt，只在斜杠菜单                             | 用户输入 `/name` → 展开成 prompt                           | `src/cli/commands/custom-commands.ts:246-256`                                         |
| 文件定义代理 | `<ws>/.moss/agents/*.md`、`.claude/agents/*.md`、`~/.moss`、`~/.claude` | 一行进 stable（expert catalog）                       | `create_subagent(expert=...)`                              | `src/core/subagent/agent-file-loader.ts:5-8`                                          |

**重叠点**：Skills 与自定义命令**共用同一个 slash 命名空间**（`reservedBuiltinNames()` 保护内置名，`custom-commands.ts:14-36`），而 Skills 还多一个"模型工具"入口。于是**同一个 skill 有两种触发方式、两种披露成本**，但只有一种消费语义（都是"把一段 Markdown 塞进 conversation"）。Claude Code 的四类（skills/commands/agents/output-styles，`claude-evidence.md` §D4）在 Moss 里落地成了"4 个 loader + 3 个命名空间"。

### 5.2 一个 slash 命名空间，三家争用

解析顺序（读码，`src/cli/commands/custom-commands.ts:135-160`）：

```
builtin(32) → custom(.moss/commands/*.md) → skill(.moss/skills/*) → unknown
```

`reservedBuiltinNames()`（`custom-commands.ts:14`）把 32 个内置名 + 7 个硬编码名（`/logout` 等）+ 别名全部锁掉。**代价**：用户安装一个叫 `review` 的 skill，会静默输给内置 `/review`；而叫 `deploy` 的 skill 又会与 `.moss/commands/deploy.md` 竞争，后者赢（builtin 之后 custom 先于 skill）。这套优先级**没有任何用户可见文档**（`/skills` 只说"list discovered skills"）。

### 5.3 `device_*` 与 `exec` 的边界

| 维度       | `exec`                                    | `device_exec`                         |
| ---------- | ----------------------------------------- | ------------------------------------- |
| 执行位置   | 本机（`hostShellChildEnv`）               | SSH 到 `MOSS_DEVICE_HOST`             |
| sideEffect | `local_write`                             | `device_mutation`                     |
| 审批       | planMode `requires_user_confirmation`     | 同 + 设备风险分级（`device-risk.ts`） |
| 输出预算   | 4,500 tok（`tool-output-truncate.ts:16`） | 6,000 tok（`:2`）                     |
| 是否并行   | 否（非 readonly）                         | 否                                    |

**边界是清楚的，重复的是"文件读写"**：`device_file_read` / `device_file_write` / `device_file_list`（701/1,174/580 chars）与本地 `read_file` / `write_file` / `list_directory`（710/433/730）是同一语义的两套实现。差异只在"路径在哪台机器上"——这在 `read_file`/`write_file` 的 description 里各有一句提示。**这是一个可替换的对偶（§9.4），但改名是 C 级。**

另一个不对称：`device_deploy`（1,955 chars，最大 device 工具）**没有本地对应物**，且只有它做 health check（`src/tools/device-tools.ts:456-459`）——这是"闭环"的核心动词，不应合并。

### 5.4 task ledger vs `todo_write` vs task runtime vs `/task`

| 层             | 工具 / 入口                                                                        | 状态存哪             | 完成判定                     |
| -------------- | ---------------------------------------------------------------------------------- | -------------------- | ---------------------------- |
| 会话级 todo    | `todo_write`（710 chars，`retainResult`）                                          | 消息历史（无持久化） | 无（纯 UI/自省）             |
| 任务台账       | `task_define` / `task_plan_update` / `record_*` / `task_acceptance`（5,671 chars） | `.moss/*.jsonl`      | `task_acceptance` + evidence |
| 任务运行时     | `runTask`（SDK/CLI `moss task run`）                                               | `.moss/` + 事件流    | verdict provider（结构判定） |
| CLI / TUI 视图 | `moss task status/timeline`、`/task`、TUI 投影                                     | 读同一份 `.moss/`    | 只读                         |

**重叠已被部分修掉**：`todo-nudge` 明确在 `task_define`/`task_plan_update` 已调用时不再推 `todo_write`，注释写"让 agent 维护两个清单，每次 run 多花 2-3 轮（Task OS M12 分析）"（`src/core/loop/nudges/todo-nudge.ts:45-52`）。**但工具面还是两套**：`todo_write` 与 `task_plan_update` 同时在 25 个默认工具里（1,456 chars）。§9.3 给替换形状。

### 5.5 MCP vs skills vs builtin 的能力发现

三套"按需发现"并存：

| 机制                    | 触发                      | 成本                                        | 证据                                    |
| ----------------------- | ------------------------- | ------------------------------------------- | --------------------------------------- |
| `tool_search(group)`    | 模型主动调                | 0 常驻（deferred）+ 631 chars meta          | `src/tools/tool-search.ts:32`           |
| `mcp__<server>__search` | 模型主动调                | 每个 server 1 行索引（145 chars @rdk-docs） | `src/core/mcp/registry.ts:752`          |
| skills 索引             | 常驻 1 行/skill           | 647 chars（本仓库 3 个 skill）              | `src/core/skills/skill-registry.ts:193` |
| `capability.ts` 打分    | **任务 runtime 内部**自动 | 不占 chat prompt                            | `src/core/task/capability.ts:1`         |

**分裂点**：`capability.ts` 已经会按 goal 对 skills/内置工具/MCP 打分并注入 planning 轮，**但 chat 路径完全不用它**——chat 只给一份 skills 索引让模型自己判断（基线 G8）。同一套打分逻辑存在，却只服务 `runTask`。这是 §9.5 的替换依据。

### 5.6 `tool_search` / deferred 揭示策略

现状：**只有 1 个组**（`subagent`，5 工具 5,218 chars / 1,305 tok），揭示后 sticky（`DeferredToolOffer.revealed`，`deferred-tool-offer.ts:39-47`）。

按 §2.3 成本表，下一批该 deferred 的是：

| 候选组              | 可省（非设备会话） | 风险                                                                    |
| ------------------- | -----------------: | ----------------------------------------------------------------------- |
| `task`（6 工具）    |        5,671 chars | 中：`/goal` 与验收门依赖 ledger；需在 task intent 出现时**自动**揭示    |
| `exec-bg`（4 工具） |        2,162 chars | 低：`exec(run_in_background)` 先跑起来后再揭示句柄才合理                |
| `device`（12 工具） |       10,295 chars | 已被 `deviceConfigured` 门替代，收益只对"有设备但做纯 coding"的会话成立 |

## 6. nudge / steering 清单与重叠

### 6.1 29 个 nudge id（`src/core/loop/nudges/disable.ts:19`）

注入机制：每轮工具执行前 `collectNudgeInjections()`（`registry.ts:99`）按固定顺序求值，命中即 `buildCorrectionMessage()` 注入一条 `<system>` 消息；每个 id 有独立 counter（多数 1-2 次/run）。全部可用 `MOSS_DISABLE_NUDGES=id1,id2` 消融。

| id                                | 触发条件（一句话）                                                                    | 目标                                                |
| --------------------------------- | ------------------------------------------------------------------------------------- | --------------------------------------------------- |
| `todo`                            | 已跑 ≥3 轮且 ≥3 次工具、用户像是在做多步编码、没调过 `todo_write`/`task_*`            | 让计划落到工具结果里，防长任务跑偏                  |
| `red-verify`                      | 最近一次验证类 tool_result 是红（test/build 失败），最多 2 次/红波，转绿后重置        | 先修再重跑同一条命令，不许继续盲改                  |
| `fan-out`                         | `fan_out`/`create_subagent` 有失败/空子结果后                                         | 只合并成功子结果 / 重跑，别把空当成功               |
| `ambiguity`                       | 用户请求 ≥40 字且含多义词（either/or/要么/还是…）+ 编码动词，且已发生编辑、没问过用户 | 显式声明选了哪种解释；无 asker 时也要声明           |
| `spec-audit`                      | 请求提到 docs/spec/需求/注释，且已跑工具                                              | 强制先做权威审计；写 `SPEC-AUDIT.md` 即满足         |
| `subagent-running`                | 后台 `create_subagent` 仍是 STARTED、无终态 status                                    | 先收子代理结果再宣布完成                            |
| `subagent-stopped`                | 调了 `subagent_stop` 但没验证证据                                                     | "停掉子代理" ≠ "修好了"                             |
| `web-tools`                       | 用户要求联网查资料，但没调 `web_search`/`web_fetch`                                   | 真去查，别凭记忆编                                  |
| `git-tools`                       | 用户要 commit/push/PR/tag/release/issue，但没跑 git/gh                                | 真跑命令或明说在等审批                              |
| `install-tools`                   | 用户要装依赖，但没跑包管理器                                                          | 真装或明说跳过                                      |
| `run-tests`                       | 用户明确要跑测试，但没调验证工具                                                      | 真跑测试                                            |
| `build-tools`                     | 用户要 build/compile，但没跑构建型命令                                                | 真构建                                              |
| `background-server`               | 用户要起长跑 dev server/watcher，但没起后台进程                                       | 用后台而非前台阻塞                                  |
| `task-repair`                     | `task_acceptance` 判红且之后没有修复路径动作（diag/repair/evidence）                  | 强制 diagnose→repair→reverify；重复失败要换根因假设 |
| `run-anchor`                      | run 内 ≥20 轮且 ≥8 次工具（一次/run）                                                 | 重读原始目标，指出还差什么才能收尾                  |
| `reasoning-only`                  | 连续 thinking-only 无实质答复                                                         | 换请求（提高 reasoning override），不许空转         |
| `output-continuation`             | `stopReason=length`（输出被截断）                                                     | 提升 output 预算 + 续写（≤3 次）                    |
| `missing-tool-call`               | 终稿说"我来调用 X"但没有 tool call                                                    | 补上真实调用                                        |
| `empty-response`                  | 连续空回复                                                                            | 重试一次，超预算抛 `EMPTY_MODEL_RESPONSE`           |
| `steering-error-recovery`         | 连续工具错误 ≥3                                                                       | 换证据来源，别原样重试                              |
| `steering-local-exploration-loop` | 同域反复探索（读/搜）超阈值                                                           | 换工具/换粒度                                       |
| `steering-web-search-variation`   | 不同 query 的 web_search 达上限（默认 6）                                             | 别再换关键词瞎搜                                    |
| `steering-tool-loop`              | ≥8 轮且最近 12 条 assistant 全是 tool_use                                             | 暂停链条、先总结已有证据                            |
| `steering-context-pressure`       | context 使用率 ≥75%（>100% 时抑制）                                                   | 收敛输出 / 促压缩                                   |
| `background-completion`           | 后台任务完成通知待注入                                                                | 把完成事件带回会话                                  |
| `background-lifecycle-gate`       | 终稿时仍有未归属的后台进程                                                            | 不许"假完成"                                        |
| `acceptance-gate`                 | 本 run 定义过 task 但无验收裁决                                                       | 跑 `task_acceptance` 或诚实报 FAIL                  |
| `follow-up-guard`                 | 终稿后模型还需要工具跟进（`lastMessageNeedsToolFollowUp`）                            | 允许再放一轮，避免半句话收尾                        |
| `truncated-tool-json`             | 工具入参 JSON 被截断                                                                  | 让模型重发完整入参                                  |

### 6.2 steering（`src/core/loop/steering.ts:33-124` 定义 5 条，`:155` 组装默认集）

| 规则 id                  | 阈值                  | cooldown | 消融 id（`MOSS_DISABLE_NUDGES`）  |
| ------------------------ | --------------------- | -------: | --------------------------------- |
| `error-recovery`         | 连续错误 ≥3           |     4 轮 | `steering-error-recovery`         |
| `tool-loop`              | turn ≥8 且全 tool_use |     6 轮 | `steering-tool-loop`              |
| `context-pressure`       | ratio ≥75%            |    10 轮 | `steering-context-pressure`       |
| `web-search-variation`   | 变体数达上限          |        — | `steering-web-search-variation`   |
| `local-exploration-loop` | 同域探索反复          |        — | `steering-local-exploration-loop` |

消融是**真的连通**的：`SteeringEngine.evaluate()` 里 `if (isNudgeDisabled('steering-'+rule.id)) continue`（`src/core/loop/steering.ts:181`）——一个 env var 同时关掉 steering 规则与同名 nudge，这点设计正确。

> **唯一不准确的是清单本身**：`NUDGE_IDS` 的注释说"registry order matches `collectNudgeInjections`"（`disable.ts:15-16`），但 5 个 `steering-*` id **从未出现在** `collectNudgeInjections`（`grep 'steering-' src/core/loop/nudges/registry.ts` 为空）。也就是说 29 个 id 里 24 个是"注入式 nudge"、5 个是"steering 规则开关"，被合并进了同一个清单。清单本身没错（都是可消融开关），错的是注释语义——**读它的人会以为 29 个都会往对话里插消息**。

### 6.3 重叠 / 可合并 / 可删候选

| 候选                                                                         | 证据                                                                                                          | 级别                                |
| ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- | ----------------------------------- |
| 6 个 `defineToolsNudge` 同模板 nudge → 1 个 declarative 表                   | `template.ts:41` 是同一个实现，6 个文件只填 `userRe`/`sawEvidence`/`correction`                               | **B1**                              |
| `steering-*` 5 个 id 与 `SteeringRule` 的关系**已正确**，不需要动            | `steering.ts:181` 已用 `isNudgeDisabled('steering-'+id)` 消融；只需修 `disable.ts:15` 的注释                  | —                                   |
| `red-verify` / `run-tests` / `build-tools` 三个"验证类"提醒                  | 三者都指向"跑那条验证命令"（`red-verify-nudge.ts:2`、`run-tests-tools-nudge.ts:2`、`build-tools-nudge.ts:2`） | B（同一族）                         |
| `truncated-tool-json` / `empty-response` / `reasoning-only` 三个"请求重发"类 | 三者都把同一条 assistant 回复作废重来（`agent-loop.ts:112`、`agent-loop-post-llm.ts:108,156`）                | B（可共用一套"retry budget"计数器） |

> 红色警告：**删任何 nudge 都是行为变更**。当前没有行为 spec 套件（504 个已删），`bench:ab` 只覆盖 best-of-n/reasoning-high/model-routing 三种，**不能**验证 nudge 消融的行为影响。任何 nudge 合并必须先跑 `bench` 至少在 hard 层做一次对照，否则只能标 `[unknown]`。

## 7. 配置 / 环境变量 / SDK 面

### 7.1 `config.json` 键与 legacy 迁移

`ConfigFile`（`src/cli/config.ts:146`）共 20 个公开键 + 2 个私有（`_apiKeyEncrypted`、`_examples`）：

```
profile, provider, apiKey, apiKeyEnv, model, baseUrl, workspace,
safetyMode, approvalPolicy, trustedTools, deniedTools, permissions,
promptCache, guardrails, agent, hooks, net, rdkDocs, pricing, statusLine, language
```

其中 **5 个是 legacy 键**，走读侧纯函数迁移 `migrateLegacyPermissionConfig()`（`src/cli/config.ts:480`），映射表（代码注释里逐条写明，`config.ts:466-479`）：

| legacy 键                        | 迁移结果                                                  |
| -------------------------------- | --------------------------------------------------------- |
| `profile: cautious`              | `defaultMode=manual` + `ceiling=read-only`                |
| `profile: balanced`              | `defaultMode=manual`（注意：与"无 config 默认 full"不同） |
| `profile: autonomous`            | `defaultMode=full`                                        |
| `safetyMode: read-only`          | `manual` + read-only ceiling（ceiling 压过一切模式）      |
| `safetyMode+approvalPolicy` 其它 | `full-access+never` → `full`；其余 → `manual`             |
| `trustedTools`                   | allow 规则（整工具名）                                    |
| `deniedTools`                    | deny 规则（整工具名）                                     |

`legacyKeysUsed` 只用于 doctor / `config show` 的弃用提示（`config.ts:455`）。**没有写回迁移**（只读侧），所以旧 config 永远不会被自动改写——这是"可退役但永远不能删读路径"的典型：**要删必须先做一次写侧迁移**。这是 B 级（非 A 级）的原因。

### 7.2 `MOSS_*` 环境变量面

`MOSS_ENV_REFERENCE`（`src/cli/config-commands.ts:289`）实测 **143 条 / 11 组 / 9 条 legacy**：

| 组                                                   | 条数（约） | 备注                                                                                                                         |
| ---------------------------------------------------- | ---------: | ---------------------------------------------------------------------------------------------------------------------------- |
| config & identity                                    |         12 | 含 2 legacy：`MOSS_CONFIG_PATH`、`MOSS_CONFIG_PROFILE`                                                                       |
| safety & approval                                    |          8 | 含 5 legacy：`MOSS_CLI_SAFETY_MODE`、`MOSS_ASK_FOR_APPROVAL`、`MOSS_TRUSTED_TOOLS`、`MOSS_DENIED_TOOLS`、`MOSS_AUTO_APPROVE` |
| runs, loops & budgets                                |         19 | `MOSS_PLAN_GATE` 已在工作树移除（未提交）                                                                                    |
| device                                               |         16 | `MOSS_DEVICE_*` 前缀 + 3 个 rdk-docs 开关                                                                                    |
| context & compaction                                 |         11 |                                                                                                                              |
| providers, models & fallback                         |         24 | 含 2 legacy：`MOSS_PROMPT_CACHE_ENABLED`、`MOSS_PROMPT_PREFIX_DEBUG`                                                         |
| tools, exec & guardrails                             |         17 | 含 `MOSS_TOOL_LOOP_*` 7 个                                                                                                   |
| ui, logging & notifications                          |         18 | 含 `MOSS_LANG`（真实）与 `MOSS_LOCALE`（仅 protected-path 提示用）                                                           |
| network&telemetry / test-only / **read-but-IGNORED** |  2 / 1 / 4 | IGNORED = `MOSS_PROVIDER`/`MOSS_MODEL`/`MOSS_BASE_URL`/`MOSS_API_KEY`（`config.ts:1533`）                                    |

**可退役候选**：

| 项                                   | 证据                                                                                   | 级别   |
| ------------------------------------ | -------------------------------------------------------------------------------------- | ------ |
| 4 个"读到但忽略"模型变量             | `IGNORED_MODEL_ENV_VARS`（`config.ts:1533-1541`）；用户设了不生效，比不读更糟          | B4     |
| 9 条 legacy 别名                     | `MOSS_ENV_REFERENCE` 里 9 条带 `legacy` 字样                                           | B4     |
| `MOSS_TEST_PIPED_STDIN_CAP`          | 唯一 test-only 变量，spec 已删                                                         | A      |
| `MOSS_LOCALE`（与 `MOSS_LANG` 并存） | `cli-locale.ts:275` 用 `MOSS_LANG`；`MOSS_LOCALE` 只在 protected-path 提示里做 zh 旁证 | B      |
| `MOSS_PLAN_GATE`                     | 工作树已退役（`plan-gate.ts` 重写、env 表与 dotenv 白名单各删 1 行）——**待提交即可**   | 已完成 |

### 7.3 SDK 公共面

`src/index.ts`（233 行）→ `dist/index.js` 实测 **298 个运行时导出**（238 函数 + 60 常量/对象）。结构：

| 段                                            | 形式            | 说明                                                      |
| --------------------------------------------- | --------------- | --------------------------------------------------------- |
| `export * from './contracts/index.js'`        | 通配            | 无法枚举、无法冻结                                        |
| `export * from './core/index.js'`             | 通配            | 同上，含 `rsi`、`superagent`、`task`、`session`、`loop`   |
| `export * from './provider/index.js'`         | 通配            | 同上                                                      |
| 28 个显式 `export {…}` 块                     | 显式 145 个名字 | 工具、设备、evidence、task、web-search、logger、errors 等 |
| `export const mossScopedInferenceVersion = 1` | 1 个            | 全仓库零引用（§4.3）                                      |

**历史包袱清单（读码 + 交叉引用 `examples/`）**：

1. **3 个通配导出**：`contracts`/`core`/`provider` 的内部任何改名都是公共面破坏。`claude-evidence.md` §B1 记录 Claude Code 也用"工具名/别名表"做兼容契约，但它的 SDK 面是可枚举的。
2. **4 个 example 里 3 个绕过公共面**：`headless-run.mjs`、`custom-tool-approval.mjs`、`repl-host.mjs` 全部 `import '../dist/core/agent/moss-agent.js'` / `'../dist/core/session/session.js'`；只有 `rsi-sdk.mjs` 用 `'../dist/index.js'`。**"examples 是 SDK 契约活文档"（`AGENTS.md`）这条不成立**——它测的是深路径模块契约。
3. **`buildMossDefaultWorkflowPrompt`**、`buildRuntimeCapabilitiesPrompt`、`truncateToolOutput`、`registerToolOutputLimits` 等 8 个"宿主可能想调"的 builder，实际没有任何宿主（仓库内零调用）。
4. **RSI 全家桶**（`RsiEngine`/`RsiStore`/6 个 digest）：唯一使用者在 `examples/rsi-sdk.mjs`。
5. **`mossScopedInferenceVersion`**：注释"Per-agent local compaction override…"但零引用，疑似快照遗留。

> semver 影响：删除/重命名上述任一 = **破坏版本契约**（`AGENTS.md` "SDK 公共面与 semver"）。且仓库已无 `sdk-contract.spec.mjs` 快照（2026-11-04 删），**现在改公共面不会有任何自动化红灯**——只剩 `npm run verify` 的 examples 阶段，而 examples 又不走公共面。这是 §10 R1 风险。

## 8. 删除候选清单

分级：**A 安全删除**（无引用/无行为影响）、**B 需退化**（先隐藏/合并/延迟/降级再删）、**C 需 owner 决策**（冻结子系统/契约/公共面）。
每项给：证据 / 影响 / 回滚。

### A 级

| #   | 对象                                                       | 证据                                                                                                                      | 影响                                                 | 回滚                              |
| --- | ---------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------- |
| A1  | `src/cli/attachments.ts`（256 行）                         | 无 importer；`preparePromptAttachments` 零引用（`:152`）                                                                  | 0 token、-256 行维护面                               | `git revert`                      |
| A2  | `src/cli/tui/input-box.ts`（59 行）                        | 无 importer；`key-stream.ts:22,93` 已有等价实现                                                                           | 0；消除 `PASTE_START` 双定义                         | revert                            |
| A3  | `src/cli/setup.ts`（37）+ `src/cli/identity.ts`（7）       | 两个 re-export 壳零引用；`setup.ts:10` 自认服务已删的 spec                                                                | 0；`dist/cli/setup.js` 深路径契约消失（无宿主）      | revert                            |
| A4  | 62 个内部零引用 export（清单见 §4.3b）                     | `\bname\b` 全仓库计数 == 1                                                                                                | 0 token；-62 个符号（48 个文件）                     | revert（若需测试可还原单个）      |
| A5  | 9 个 `*ForTest(s)` 钩子                                    | §4.3c 逐条列名                                                                                                            | 0；未来恢复 spec 需重加                              | revert                            |
| A6  | 6 处 "locked by test/x.spec.mjs" 注释                      | `task-repair-nudge.ts:20`、`workspace-write-copy.ts:16,23`、`tui/help.ts:71`、`setup.ts:10`、`interactive-commands.ts:15` | 0；消除"指向不存在文件"的误导                        | revert                            |
| A7  | `MOSS_TEST_PIPED_STDIN_CAP`                                | env 参考表 "test-only" 组唯一项                                                                                           | 0                                                    | revert                            |
| A8  | 4 个未实现 CLI 子命令（`plugins`/`migrate`/`web`/`agent`） | `command-dispatcher.ts:702` + `subcommand-help.ts:377-404`                                                                | CLI 帮助面 -4 条；未实现命令从"明确报错"变"未知命令" | revert；或保留 1 行 redirect 补丁 |

### B 级

| #   | 对象                                                                                                       | 证据                                                                                                                                          | 影响                                                  | 回滚 / 前提                                                       |
| --- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------- |
| B1  | 6 个同模板 nudge → 1 个 declarative 表（id 合并为 `intent-evidence`，保留旧 id 作为 alias 消融）           | `template.ts:41`；6 文件只差 regex/evidence/correction                                                                                        | 维护面 -5 文件；**行为可能变**（顺序/触发条件要等价） | 保留 `MOSS_DISABLE_NUDGES` 旧 id 映射；先跑 bench 对照            |
| B2  | `buildMossDefaultWorkflowPrompt` 从公共面退役（保留文件 1 个版本标 `@deprecated`）                         | `default-workflow.ts:1` 无内部调用者；内容与 quick 提示词重复；含 codegraph 幽灵建议（`:12`）                                                 | SDK 面 -1 导出；-2,687 chars 死资产                   | 需 minor 版本 + 说明；两个 minor 后删文件                         |
| B3  | 27 个幽灵工具名从 `tool-loop-guard` / 截断预算表删除                                                       | §2.4d 实测字面量与 45 个注册名求差 = 27 个不存在                                                                                              | 冻结路径 -27 个 Set 条目；跨 harness 兜底能力消失     | 一个版本内保留 `registerSpawnToolExtensions` 扩展路径             |
| B4  | 9 个 legacy env 别名 + 4 个"读到但忽略"变量退役                                                            | `config-commands.ts:289`、`config.ts:1533`                                                                                                    | env 面 -13 条；启动时给一次弃用警告                   | 先 warn 一个 minor，再删读路径                                    |
| B5  | AGENTS.md 19,005 chars 常驻 stable → 分层/按需（Cursor rules 模型，`cursor-evidence.md` §C.1）             | 实测 stable 25,131 chars 中 75.6% 是 AGENTS.md                                                                                                | 每请求 **-4.7k tok**（最大单项收益）                  | 保留 `AGENTS.md` 全量作为 `/init` 可读源；新增 `.moss/rules` 分层 |
| B6  | `multi_edit` / `exec_background` 两个 legacy 别名工具退役                                                  | `tool-catalog.ts:17`；隐藏后不占 token，只占 2,305 chars 死代码                                                                               | 0 token；旧 transcript 无法回放这两个工具名           | 需 1 个版本公告；transcript 回放会落到 `unknown-tool`             |
| B7  | 3 个"请求重发"类 nudge（`truncated-tool-json` / `empty-response` / `reasoning-only`）共用一套 retry budget | `agent-loop.ts:112`、`agent-loop-post-llm.ts:108,156`；三者都把同一条回复作废重来，但各有一个独立 counter                                     | 少 2 个计数器；**重试上限语义会变**                   | 先加一个统一上限观察，再合并 counter                              |
| B8  | `read_file` 预算键统一（`read` → `read_file` 或进 metadata）                                               | `tool-output-truncate.ts:1-19` 无 `read_file`；`file-tools.ts:313,318` 用 `'read'`；loop 用 `call.name`（`agent-loop-tool-execution.ts:286`） | 修一致性；可能让 `read_file` 提前 2.5× 截断或反过来   | 先加 `read_file: 10_000` 再观察；这是 bug-fix 型改动              |

### C 级（需 owner 决策）

| #   | 对象                                                       | 证据                                                                                          | 为什么不能自决                                          |
| --- | ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| C1  | RSI 子系统（`src/core/rsi/`，6 文件 2,035 行）整体退役     | 唯一消费者 `examples/rsi-sdk.mjs` + `src/index.ts`；无 CLI/工具/task 集成                     | 删 = 破坏 semver 面 + 删一个 example                    |
| C2  | SDK 三个 `export *` 收成显式清单                           | 298 个运行时导出，`contracts`/`core`/`provider` 全通配                                        | 公共面契约变更                                          |
| C3  | `device_*` 12 工具名 / 7 个空 schema 只读探针合并          | `AGENTS.md`："工具名已被 subagent scope、截断预算、loop-guard 按保留名引用，改名等于破坏契约" | P0 契约                                                 |
| C4  | task ledger 6 工具 + `todo_write` 统一                     | 已用 nudge 打补丁（`todo-nudge.ts:45-52`）；工具面仍两套                                      | Task OS P0 契约                                         |
| C5  | 3 个 example 改为走 `dist/index.js`                        | `examples/*.mjs` 实测 3/4 深路径 import                                                       | 需要同步改公共面导出（否则 example 拿不到 `MossAgent`） |
| C6  | `src/core/superagent/`（19 文件 4,162 行）是否维持         | 2026-11-02 定向解冻，spec `docs/specs/moss-superagent.md`                                     | 产品方向决策                                            |
| C7  | `src/core/experience/`（368 行，`MOSS_EXPERIENCE=1` 才开） | `moss-agent.ts:1085` 首轮注入；`experienceEnabled()` 默认关                                   | 实验性功能，去留是产品决策                              |

## 9. 替换候选清单

格式：**Moss 现状 → Cursor/Claude 做法（引用证据节号）→ 替换后的接口形状**。不写完整代码。

### 9.1 用工具 metadata 取代"按名字建表"（最高杠杆）

- **现状**：`ToolMetadata` 12 个字段（`tool-types.ts:190-227`）已经足够描述行为，但**有 6 张按名字建键的表**在并行维护：`tool-loop-guard` 6 个 Set（`:22-99`）、`tool-output-truncate` 预算表（`:1-19`）、`tool-catalog` 4 个族集合（`:17-46`）、`edit-syntax-check-hook` 的 `MUTATING_TOOLS`（`:6`）、`stale-read-invalidate` 的工具名分支、`agent-file-loader` 的 allow-list。
- **对方做法**：Claude Code 每个工具声明 `isReadOnly / isConcurrencySafe / isDestructive / maxResultSizeChars / searchHint / userFacingName`，**行为从声明读，不查名字表**（`claude-evidence.md` §B1）；Cursor 把只读/变更放在"运行时审批层 + result case 枚举（`rejected` 是一等状态）"，不在 description 层（`cursor-evidence.md` §B.5）。
- **替换形状**：

```ts
// src/core/tools/tool-types.ts
interface ToolMetadata {
  // 已有：sideEffectClass / planMode / noReplay / freshObservation / requiresApproval /
  //       transientRetry / retainResult / requiresUserQuestion / timeoutMs
  readonly?: boolean; // 冗余但显式：并行/重试/发现类阈值的唯一真源
  maxResultSizeChars?: number; // 取代 tool-output-truncate 的名字表
  discovery?: boolean; // 取代 DISCOVERY_TOOLS
  editPathScoped?: boolean; // 取代 SURGICAL_EDIT_TOOLS
  searchHint?: string; // 给 tool_search 的检索文本
}
```

判据：`isDiscoveryTool(tool) = tool.metadata?.discovery ?? tool.metadata?.readonly === true`。收益：删 6 张表 ≈ 100 个名字字面量（含 27 个幽灵名）、修掉 §2.4(d) 的 `read`/`read_file` 预算不一致。**这是唯一一条"改一处、全局受益"的替换**。

### 9.2 提示词：lean/full 两档 + 描述分层

- **现状**：quick/full 只有 behavior/domain/language 三份有；工具 description 只有一档，`search_code` 1,969 chars、`device_exec` 950、`device_deploy` 910 全量下发。
- **对方做法**：Cursor `reducedSystemPrompt` 是显式压缩档（`cursor-evidence.md` §A.2），同一工具 description 按 `promptVersion`/模型从 1 句到 6 条（§B.4 范式 3）；Claude Code 的 `leanPrompt` 按模型选长短版（`claude-evidence.md` §A4）。
- **替换形状**：

```ts
interface Tool {
  description: string; // lean：只写"做什么 + 何时不用 + 3 条硬约束"
  longDescription?: string; // full：示例、跨工具路由表、边界
}
// 选取：leanDescriptionFor(model, budget) — 默认 lean；
// 首次调用失败 / 显式 tool_search 时下发 longDescription
```

预期收益：`search_code`/`device_deploy`/`device_exec`/`record_evidence`/`edit_file` 5 个 >1,500 chars 的工具压到 ~60%，工具面 -3~4k chars/请求。

### 9.3 计划机制统一（`todo_write` vs `task_plan_update`）

- **现状**：两套计划（§5.4），靠 nudge 互相避让。
- **对方做法**：Claude Code 的 `TodoWrite` 是**唯一**计划面：状态机 `pending|in_progress|completed`、每次发全量替换、强制"同时只一个 in_progress"（`claude-evidence.md` §B2 TodoWrite 段）。Cursor 的 todo 也是单面。
- **替换形状**：保留 `todo_write` 作为**会话级**计划（唯一），`task_plan_update` 降为 task runtime 的**内部**写入口（不直接暴露给模型；由 `task_define`/`task_acceptance` 驱动）。工具面 -1 工具、-746 chars；nudge 也不用再写避让逻辑。

### 9.4 device 只读探针：7 工具 → 1 工具 + kind enum

- **现状**：7 个空 schema 探针（§2.4c），4,515 chars 换 7 个固定 SSH 脚本。
- **对方做法**：两家都没有"每个观测一个工具"的形态——Cursor/Qoder 的设备/系统观测走 `Bash`，专用工具只给"结构化裁决"（Moss 的 `task_acceptance` 就是这一类）。
- **替换形状**：

```ts
device_probe: {
  kind: 'info'|'processes'|'resources'|'temperature'|'robotics_status'|'network'|'cameras',
  // 返回：每 kind 一份结构化 section（保留当前 869/736/... chars 的排版价值）
}
```

收益：7 个工具 → 1 个（~1,200 chars），-3.3k chars。**但这是 C 级改名**（转成 B 级的前提：`tool-catalog`/`truncation`/`spawn-profile`/`loop-guard` 四处同步 + 一个版本的双名兼容）。

### 9.5 chat 与 task 共用能力发现

- **现状**：`capability.ts` 只在 `runTask` 内用（§5.5）；chat 靠 skills 索引 + 模型自觉。
- **对方做法**：Cursor 的 rules 四类（always / auto-attached / agent-requested / manual，`cursor-evidence.md` §C.1）——**自动附着**是其中一类，等价于"按 query 匹配注入"；Claude Code 靠 skills 索引 + `Skill` 工具（`claude-evidence.md` §D4），但没有打分注入。
- **替换形状**：把 `matchTaskCapabilities()` 提升为 `matchCapabilities(query, {skills, tools, mcp})`，chat 首轮用它**只选 1-3 个**候选写进 `<turn-context>`，替代"全量 skills 索引"（本仓库 647 chars → 实测 3 skill，规模化后线性增长）。

### 9.6 拒绝/失败语义（P0 已做，此处只记录已完成项）

工作树已把拒绝文案改成**按 `DenialClass` 分四类给不同下一步**（`user`/`mode`/`policy`/`headless`，`DENIED_GUIDANCE` 在 `src/core/tools/execute-tool-call.ts:38-58`；函数 `:66`）。代码注释明确写了为什么不能用一句 blanket "don't retry"：Moss 的拒绝有 4 个来源，"一句统一话术会与 mode-block 理由里已经写好的『切模式后再跑』直接矛盾"（`:20-33`）。这比 Claude Code 的单句 `# Harness` 分节（`claude-evidence.md` §A2）和 Cursor 的 `rejected` result case（`cursor-evidence.md` §B.5）更细。**这条不用再改，审计确认已完成**。

### 9.7 项目指令分层（B5 的具体形状）

- **现状**：单一 `AGENTS.md` 祖先链全量注入（19,005 chars）。
- **对方做法**：Cursor `.cursor/rules` 四类 + `AGENTS.md` 一等概念（`cursor-evidence.md` §C.1/C.3）；Claude Code `CLAUDE.md` 层级 + `rules/`、`skills/`、`commands/`、`agents/`、`output-styles/` 五种目录（`claude-evidence.md` §A5/D4）。
- **替换形状**：

```
.moss/rules/*.md    frontmatter: { always: bool, globs: string[], description: string }
  - always: true  → 进 stable（保持极小，≤2k chars）
  - globs 命中     → 进 dynamic（按本轮读写过的文件自动命中）
  - 其余           → 只在 <turn-context> 里列一行 description（模型可 skill 式读取）
```

`AGENTS.md` 全量降级为"`/init` 与人工阅读的源"，不再整块进 stable。

## 10. 风险与未验证项

### 10.1 风险

| #   | 风险                                                                                                                                 | 触发条件                           | 缓解                                                                                                        |
| --- | ------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| R1  | **改 SDK 公共面不会有任何自动化红灯**                                                                                                | C1/C2/C5 任一落地                  | 先在 `scripts/verify/` 加一个"`dist/index.js` 导出键快照 == 期望清单"的 stage（不需要恢复 spec 套件）       |
| R2  | **删 spec 后 4 条隐性契约无人守**（env 覆盖、工具面上限、命令表同源、TUI 键位）                                                      | 任何人新增工具/env/slash 命令      | §4.3(d)：加 4 个 `node -e` 探针进 verify                                                                    |
| R3  | **nudge 合并无行为验证手段**                                                                                                         | B1/B7 落地                         | 只能靠 `bench` hard 层对照；否则标 `[unknown]`，不要声称等价                                                |
| R4  | **B5（AGENTS.md 分层）是最大的行为变更**：项目指令从"全量常驻"变"按需"，模型可能漏读关键约定                                         | 落地后长任务回归                   | 先做"always 子集（≤2k）+ 其余按需"两段式；`/init` 自动生成 frontmatter，别让用户手写                        |
| R5  | **dist 与 src 已漂移 12 分钟**（`PLAN_ONLY_TOOL_NAMES`、`MOSS_PLAN_GATE` 退役未进 dist）                                             | 任何用 `dist` 的测量/交付          | 本文件已逐项标注来源；Lead 收尾前必须重建一次再核对 §0.4 数字                                               |
| R6  | **B3 会削弱跨 harness 兼容**：删掉 27 个幽灵名后，用户通过 MCP/外部 host 注册的 `codegraph_*`、`memory_*` 不再受 loop-guard 熔断保护 | 用户接 CodeGraph/MCP memory server | 保留"扩展注册"路径（`registerSpawnToolExtensions` 已有先例），把扩展名里的发现类/写类元数据映射到同一套判据 |
| R7  | **删/合并 nudge 会影响 headless 长跑**（重试预算、验证类提醒的触发顺序都是隐式契约）                                                 | B1/B7                              | 用 `MOSS_DISABLE_NUDGES` 灰度：先并集后删代码；重试预算合并前后各跑一次长任务                               |

### 10.2 未验证项（不报结论）

| #   | 项                                                                                  | 为什么没验证                                |
| --- | ----------------------------------------------------------------------------------- | ------------------------------------------- |
| U1  | 29 个 nudge 的真实命中率 / 每条消融后的行为差异                                     | 需要真实 provider 跑 bench；本次禁跑 bench  |
| U2  | `prompt-prefix-cache` 是否在 B5/当前配置下真的 eligible（§3.2 推算 8.3% ≤ 25%）     | 需要真实请求的 usage 字段；未跑模型         |
| U3  | `record_evidence`/`task_define` 没有 `retainResult` 是否真的导致折叠丢证据          | 需要跑一次长任务触发 fold；只读代码无法确认 |
| U4  | 4 个未实现 CLI 子命令是否有用户依赖（`plugins`/`migrate`/`web`/`agent`）            | 需要遥测；`MOSS_TELEMETRY_ALLOW` 默认关     |
| U5  | `src/core/rsi/` 是否有仓库外的真实消费者（它是 SDK 导出）                           | 仓库内零消费 ≠ 外部零消费                   |
| U6  | `MOSS_PLAN_GATE` 退役（工作树已做）在 P0 benchmark 上的表现是否与"env gate off"一致 | 需跑 `bench:ab plan-gate`；工作树改动未提交 |
| U7  | 7 个空 schema device 工具在真实调试中是否比"1 工具 + kind"更好用                    | 需要真实设备会话；本次未连设备              |
| U8  | `examples/` 3 个深路径 import 是否被外部文档/用户当作公开路径引用                   | 需要外网搜索；本次未做                      |

### 10.3 给 Lead 的落地顺序建议（一段话）

先做**A 级 + §4.3(d) 的 4 个 verify 探针**（零风险、当天可合、立刻止住隐性契约漂移）；再做 **B8（预算键 bug-fix）+ B5（AGENTS.md 分层，最大 token 收益）**；然后 **9.1 元数据化**（一次性清掉 6 张名字表与 27 个幽灵名）；`B1/B7` 的 nudge 合并放在有 bench 预算之后；**C 级全部等 owner 排期**，其中 C2（SDK 面收窄）建议在 C1（RSI 去留）之前拍，因为它决定"怎么删才不破契约"。
