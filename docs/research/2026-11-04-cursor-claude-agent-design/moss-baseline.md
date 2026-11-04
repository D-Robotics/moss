# Moss 基线侦察报告（竞品对照用）

- 日期：2026-11-04
- 范围：`/Users/d-robotics/Desktop/RDK_Studio/moss`（TypeScript/ESM 单包，bin=`dist/cli.js`）
- 方法：只读通读真实源码 + 对已构建 `dist/` 做只读测量（未 build、未跑 verify/test、未改任何源码）
- 读者：负责把 Cursor.app / Claude Desktop + Claude Code 洞察落回 Moss 的 Lead
- 约定：每条论断后标 `(src/xxx.ts:行号)`；测量值标「实测」

---

## 0. 摘要与测量基线

### 0.1 三个最重要的事实

1. **提示词是"稳定前缀 + 易变后缀"的双段结构，而不是一个大字符串**。persona/契约/行为/AGENTS.md 在 stable，环境/日期/git/MCP/skills/上下文窗口在 dynamic；OpenAI 兼容线上 dynamic 还会被搬到 user 消息的 `<turn-context>` 里，避免把工具 schema 缓存打掉 `(src/core/agent/moss-agent.ts:390)`、`(src/provider/pi-ai-http-transport.ts:303)`、`(src/core/agent/moss-agent.ts:1112)`。
2. **工具面是"注册 45 / 模型可见 38"的收敛面，且元数据驱动一切**：`sideEffectClass` 决定审批、并行、重试，`retainResult` 决定能否折叠，`noReplay`/`freshObservation` 决定能否重放——行为不在提示词里，而在工具元数据里 `(src/core/tools/tool-types.ts:178)`、`(src/core/tools/tool-types.ts:190)`、`(src/tools/builtin.ts:566)`。
3. **纠偏是三层叠加的、可逐条消融的机制**：工具级短路（loop-guard）+ 注入式 nudge（29 个 id，可 `MOSS_DISABLE_NUDGES` 消融）+ steering 规则；终稿另有 completion gate 与 acceptance gate 两道门 `(src/core/loop/nudges/disable.ts:19)`、`(src/core/tools/tool-loop-guard.ts:994)`、`(src/core/loop/steering.ts:29)`、`(src/core/loop/acceptance-completion-gate.ts:217)`。

### 0.2 实测规模（跑 `node` 读 `dist/contracts`、`dist/tools`）

| 项                                                                          | 实测值                                  | 说明                                                                                  |
| --------------------------------------------------------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------- |
| 注册内置工具数                                                              | 45                                      | `builtinTools.length`                                                                 |
| 模型实际可见工具数                                                          | 38                                      | 减去 5 个 deferred subagent + 2 个 legacy alias `(src/core/tools/tool-catalog.ts:15)` |
| 可见工具 schema 总量                                                        | 32,950 chars ≈ **8.2k tokens**          | `JSON.stringify({name,description,inputSchema})` 求和                                 |
| 全部（含隐藏）schema                                                        | 40,473 chars ≈ 10.1k tokens             | 最大单工具 `fan_out_subagents` 1,983 chars                                            |
| CLI 默认 stable 核心（identity+language quick+domain quick+behavior quick） | 4,631 chars ≈ **1.2k tokens**           | 不含 TOOL_RESULT_HANDLING(≈322)                                                       |
| behavior prompt quick / full                                                | 3,187 / 10,011 chars（797 / 2,503 tok） | 默认走 quick `(src/core/agent/moss-agent.ts:363)`                                     |
| domain prompt quick / full                                                  | 937 / 6,247 chars（235 / 1,562 tok）    | CLI 显式注入 quick `(src/cli-main.ts:1119)`                                           |
| language prompt quick / full                                                | 507 / 1,002 chars                       | 默认 quick `(src/core/agent/moss-agent.ts:349)`                                       |
| AGENTS.md 单文件上限                                                        | 16,384 bytes                            | 超限截断并写可见提示 `(src/cli/project-instructions.ts:15)`                           |

> 结论先行：Moss 的**固定提示词很便宜（~1.2k tok），工具 schema 才是大头（~8.2k tok，占 87%）**。任何"提示词设计"改进如果只动 prose，收益上限很低；Cursor/CC 真正省 token 的地方在工具面收敛与按需揭示。

---

## 1. 系统提示词组装

### 1.1 组装入口与顺序

`MossAgent.buildSystemPrompt()` 是唯一的拼装点，顺序固定 `(src/core/agent/moss-agent.ts:333)`：

| #   | 块                                            | 代码位置                | 默认是否启用                | 备注                                                                                          |
| --- | --------------------------------------------- | ----------------------- | --------------------------- | --------------------------------------------------------------------------------------------- |
| 1   | `baseSystemPrompt`（persona / soul identity） | `moss-agent.ts:341`     | 是                          | CLI 传 `resolveSoulIdentity(...)` `(src/cli-main.ts:1108)`                                    |
| 2   | Language policy                               | `moss-agent.ts:344-350` | quick                       | `'full'` 可切换，`false` 可关                                                                 |
| 3   | Domain prompt（软件工程）                     | `moss-agent.ts:352-360` | quick；CLI 用函数覆盖       | CLI 显式 `domainPrompt: () => buildSoftwareEngineeringPromptQuick()` `(src/cli-main.ts:1119)` |
| 4   | Agent behavior contract                       | `moss-agent.ts:362-368` | quick                       | `includeAgentBehaviorPrompt: 'full'` 才有长版                                                 |
| 5   | Subagent expert catalog                       | `moss-agent.ts:370-371` | 仅有 file-defined agents 时 | 空数组返回 `undefined` `(src/core/subagent/expert-registry.ts:238)`                           |
| 6   | `TOOL_RESULT_HANDLING_SECTION`                | `moss-agent.ts:372`     | 恒开                        | 一句反注入契约 `(moss-agent.ts:137)`                                                          |
| 7   | `extraPromptLayers`                           | `moss-agent.ts:374-376` | 由 host 决定                | CLI 放 AGENTS.md、answer-language、runtime-capabilities                                       |
| 8   | `options.extraContext`                        | `moss-agent.ts:378-380` | 按次                        | 运行期附加                                                                                    |
| —   | 用 `\n\n` join，`filter(Boolean)`             | `moss-agent.ts:382`     |                             | 空块自动消失                                                                                  |

**没有按 plan/act 模式切换提示词**。`plan` 只是权限模式（`CliInteractionMode = manual|acceptEdits|plan|full`），只改审批基线与设备策略，不改 system prompt `(src/cli/interaction-mode.ts:10)`、`(src/cli/interaction-mode.ts:44)`。plan 的语义靠 `isAllowedDuringPlanMode()` 在审批层拦截，而不是靠提示词 `(src/cli/approval.ts:466)`。

### 1.2 stable / dynamic 二段切分

`composeSystemPrompt()` 返回 `{stable, dynamic, full}`，模型看到 `full`，provider 缓存 key 在 `stable` `(src/core/agent/moss-agent.ts:390)`。

- **stable** = `buildSystemPrompt()` 的结果（persona + 三份契约 + expert catalog + 反注入 + extraPromptLayers）。
- **dynamic** = `config.dynamicPromptLayers` 非空行 join `(moss-agent.ts:401-407)`（数组**引用**保留，每次模型调用前重读）。
- `full = stable + "\n\n" + dynamic`。

**dynamic 的二次去重是本节最不直观的设计**：dynamic 既进 system 的 `full`，又被写到"引入它的那条 user 消息"的 `<turn-context>` 里；只有内容变化时才重写，老消息不重写 `(src/core/agent/moss-agent.ts:1115-1127)`。在 Anthropic 线，若 payload 已带该 `<turn-context>`，就**不再把 dynamic 作为 system block 发**，避免重复计费 `(src/provider/pi-ai-adapter.ts:83)`；OpenAI 兼容线同样把易变后缀整体搬到 user 消息，理由是网关把 `tools` 放在 system 之后，system 里放易变文本会打掉 tool-schema 缓存 `(src/provider/pi-ai-http-transport.ts:325)`。

缓存资格由阈值判定：stable ≥ 2,048 chars 且 dynamic 占比 ≤ 25% 才算 eligible `(src/core/llm/prompt-prefix-cache.ts:29)`。实测 stable 核心 4.6k chars、dynamic（env+AGENTS.md 截断 16k）约 17k chars → **dynamic 占比 ~79%，远超 25% 门槛**，这是一个值得 Lead 注意的张力（见 §6 缺口 G6）。

### 1.3 环境 / 工具清单 / AGENTS.md 如何注入

**环境层（dynamic 第一块）** `(src/context/environment.ts:49)`：

- 固定行：working directory、platform、device env 报告（只列变量名，不列值）、今天的日期 `(src/context/environment.ts:58-61)`。
- 顶层 40 个非隐藏条目、git 分支、未提交变更（最多 20 行）、最近 5 条 commit `(src/context/environment.ts:25-28)`。
- 定位在 dynamic 的原因写在代码注释里："日期、git status、workspace listing 放易变后缀，让缓存前缀保持字节稳定" `(src/cli-main.ts:884)`。

**AGENTS.md（stable，via extraPromptLayers）** `(src/cli/project-instructions.ts:36)`：

- 候选 `AGENTS.md` / `agents.md`，只读工作区根，**不递归、不合并父目录** `(src/cli/project-instructions.ts:17)`。
- 16KB 硬上限；截断时写显式提示 "truncated, ~NKB dropped — edit the file under 16KB to load it fully"，绝不静默截断 `(src/cli/project-instructions.ts:55-59)`。实测本仓库 AGENTS.md 为 25,511 bytes → **被截断约 9KB**，即 Moss 自己的项目指令对 Moss agent 是"部分可见"的。
- 注入顺序在 environment 之后、runtime capability 之前 `(src/cli-main.ts:890)`。

**工具清单：故意不注入**。`buildRuntimeCapabilitiesPrompt()` 明确不再罗列工具名——模型已经从 tool definitions 拿到 name+description+schema，重复列出是纯浪费 `(src/context/runtime-capabilities.ts:47)`。它只补三件 schema 说不了的事：只用本次注册的工具、CodeGraph 是否可用、不可用时用什么 fallback `(src/context/runtime-capabilities.ts:55-71)`。
→ **这是一个已经做对的对齐点**（CC 也是靠 tool definitions 而非提示词清单）。

**上下文窗口**：探测/配置到 `contextTokens` 后追加一行 "Your context window is Nk tokens. State this number accurately…"，也在 dynamic `(src/cli-main.ts:1462-1468)`。

**persona / soul**：`resolveSoulIdentity()` 三级发现 `.moss/soul.md` → `<configDir>/soul.md` → 默认身份 `(src/core/agent/soul.ts:76)`。非默认 soul 会追加**不可覆盖**的 model-honesty footer；`prepend` 模式下还会再拼一次默认身份 `(src/core/agent/soul.ts:85-92)`。默认身份本身是中英双语 400 chars，带"模型名诚实"约束与 `current_model` 指引 `(src/core/agent/identity.ts:1)`。

### 1.4 quick 版与 full 版的差异（这是本仓库的一个明确设计立场）

quick 不是"压缩摘要"，而是**删掉模型已具备的通用 prose、保留不可推断的契约**：

- behavior quick（797 tok）保留：报告诚实、最小改动、按可逆性分级确认、开发闭环（改完跑一次被改行为；format/lint/typecheck/full suite 是交付门不是每步门）、反向例（"After a successful edit_file, do not re-read the file just to confirm the write"）、工具偏好（`read_file`/`edit_file`/`search_code` 优于 shell cat/sed/grep）、后台进程生命周期、todo/子代理触发条件 `(src/contracts/prompts/agent-behavior-prompt.ts:63-89)`。
- behavior full（2,503 tok）额外有：沟通风格、问题解决方法论、代码变更纪律、忠实报告、谨慎执行五节 `(src/contracts/prompts/agent-behavior-prompt.ts:10-58)`。
- 取舍理由写在 JSDoc 里：_"modern LLMs already have those baseline skills, and paying ~15k chars for them on every request (with prompt cache inactive on several providers) diluted the safety-critical lines"_ `(src/contracts/prompts/agent-behavior-prompt.ts:56-62)`。**这是与 Claude Code 相反的立场**（CC 的 system prompt 极长），值得 Lead 在 spec 里明确选边。
- domain quick（235 tok）把"证据优先/最小可验证改动/spec audit/失败测试定位"压成 4 句 `(src/contracts/prompts/software-engineering-prompt.ts:49-56)`；full（1,562 tok）展开成 7 节，包含 `SPEC-AUDIT.md` 这个**强制的诚实出口**：发现 spec 自相矛盾时写 `SPEC-AUDIT.md`、不改源码、明说结论 `(src/contracts/prompts/software-engineering-prompt.ts:44)`。

---

## 2. 工具定义与执行管线

### 2.1 schema 风格

接口只有四个核心字段 `{name, description, metadata?, inputSchema, normalizeInput?, execute, executeStructured?}` `(src/core/tools/tool-types.ts:231)`：

- **name**：`snake_case`；函数/常量名 `camelCase`，且这个映射被 onboarding 的分类逻辑依赖，注释明确要求保持一致 `(src/tools/builtin.ts:559)`。
- **inputSchema**：手写 JSON Schema 子集（`type: 'object'` + `properties` + `required`），**不是 zod 生成**。参数级 `description` 承担了大部分约束表达（例：`read_file` 的 `offset` 写明 "1-based line number"，`limit` 写明 "Maximum number of lines from offset"）`(src/tools/file-tools.ts:216-229)`。
- **description 写法**：1–5 句祈使句，常见四段结构 = 做什么 + 前置条件 + 关键约束 + 何时改用别的工具。例 `edit_file`：_"Replace exact strings in existing files. read_file first. old_string must match whitespace exactly and be unique unless replace_all. Do not include read_file line-number prefixes. Empty new_string deletes the match. Pass edits[] for 2+ replacements… Use write_file for new files and apply_patch for cross-file patches"_ `(src/tools/file-tools.ts:877-881)`。
  - **带反例**：`edit_file` "Do not include read_file line-number prefixes"（因为 read_file 输出带行号，模型常粘回）；`read_file` "Each line is prefixed with a line number and a tab that are NOT file content" `(src/tools/file-tools.ts:206)`。
  - **带何时用/何时不用**：`tool_search` 写明 "Use that group for 3+ independent subtasks… Do not use it for a short answer or a single local edit. Empty child output is failure." `(src/tools/tool-search.ts:30-34)`；`ask_user_question` 反例是 headless 立即返回错误而非挂起 `(src/tools/ask-user-question.ts:6-9)`。
  - **带工具间分工**：`exec` description 明确 "Prefer read_file, edit_file, search_files, search_code, and run_tests over cat/sed/find/grep" `(src/tools/builtin.ts:84)`。
  - 总评：**description 密度高于 CC 的平均工具，但缺少 Cursor 那种"何时不要用本工具"的独立段落**；约束主要靠一句句堆叠，长工具（`device_deploy` 910 chars、`device_exec` 950 chars）已经接近可读性上限。

### 2.2 无 `sideEffectClass` 即视为 `local_write`

工具元数据是审批/并行/重试的唯一真源 `(src/core/tools/tool-types.ts:190)`：

```
readonly | local_write | device_mutation | credential | external_message |
memory_write | runtime_state | subagent        (tool-types.ts:178)
```

- `planMode: 'allow' | 'audit' | 'requires_user_confirmation'` `(tool-types.ts:188)`。
- 其他：`requiresApproval`、`timeoutMs`、`transientRetry`、`noReplay`、`freshObservation`、`retainResult`、`requiresUserQuestion`、`ui.surface` `(tool-types.ts:190-227)`。
- **缺省即危险**：审批层 `inferSideEffectClass()` 在元数据缺失时返回 `local_write`，注释写明理由——"名字不是安全声明，`get_and_delete` 这类动词可以藏着变更" `(src/cli/approval.ts:260)`。MCP 工具因此**故意不声明** sideEffectClass，让每个 MCP 调用都走审批 `(src/core/mcp/registry.ts:1-14)`。
- 特例：`runtime_state`（Moss 自己 `.moss/` 记账）**永不进审批**，理由写在代码里"headless 无法授权，会把 task journey 卡在第一步" `(src/cli/approval.ts:514)`。task/evidence/todo 工具都属于这一类 `(src/tools/task-tools.ts:73)`、`(src/tools/evidence-tools.ts:88)`、`(src/tools/todo-tool.ts:79)`。

### 2.3 执行管线（一次 tool call 的完整路径）

`executeOneToolCall()` 的固定顺序 `(src/core/tools/execute-tool-call.ts:337)`：

1. **解析工具**：先查 `toolsForRun`，未命中再问 `resolveMissingTool`（MCP 用这个等待 in-flight 连接）`(execute-tool-call.ts:349-355)`；仍未命中 → `unknown-tool` + 可用列表 `(execute-tool-call.ts:357)`。
2. **schema 校验**：`validateToolInputObject()`，含**跨 harness 参数别名吸附**——`file_path→path`、`old_str→old_string`、`new_str→new_string`，以及大小写/下划线归一（`timeoutMs`/`timeout_ms`/`TIMEOUT-MS` 视为同一参数）`(src/core/tools/tool-pipeline.ts:37-45)`。理由注释：模型跨 harness 训练，"一次拼错就丢掉整个 turn" `(tool-pipeline.ts:47-54)`。
3. **全局 pre-tool hook 链** → 再校验 → **ToolHookRegistry pre hooks**（可 block / modify）→ **执行边界最终校验**（"用户批准的必须是被校验过的那个动作"）`(execute-tool-call.ts:373-425)`。
4. **审批 gate**：`checkToolApproval()`，返回 `allow-once | allow-always | deny`；deny → `deniedToolResultText()`，`isError: true` `(execute-tool-call.ts:451-485)`。
5. **执行 + 超时 + 心跳**：`toolTimeoutMs` 默认 5 分钟 `(src/core/loop/agent-loop.ts:64)`，每 30s 心跳；心跳超过 maxMissed 会**强制 abort** 并 warn `(execute-tool-call.ts:566-596)`。
6. **重试**：仅当 `sideEffectClass === 'readonly'` **且**（`transientRetry` 或工具在白名单）**且** 未触发审批时重试；默认 2 次，200ms 起步的渐进 backoff，上限 5s，可用 `MOSS_TOOL_RETRY_MAX` 调 `(execute-tool-call.ts:69-98)`、`(execute-tool-call.ts:504-512)`。只读设备工具（`device_info`/`device_file_read`…）在白名单里 `(execute-tool-call.ts:34-57)`。
7. **字符串错误归一**：很多工具用返回字符串表达失败（`Error: …`、`Command failed (exit 1)`），会显式转成 `isError`，注释强调"非零 shell 不是成功" `(execute-tool-call.ts:618-621)`。
8. **post hooks**：成功走 post hooks，失败额外走 post-failure hooks；hook 改写过文本则**丢弃 structuredContent** `(execute-tool-call.ts:747-806)`。

**结果回填格式：纯文本为主，结构化是可选旁路。** `Tool` 的 `execute` 返回 `Promise<string>`；`executeStructured` 才返回 `ToolContentBlock[]` `(src/core/tools/tool-types.ts:242-243)`。回填到 LLM 时 `modelToolResultText()` 优先用存下来的 text，`structuredContent` 只在没有 text 时兜底；结构化内容超过 12,000 chars 会被截断并加提示 `(src/core/tools/message-convert.ts:13)`、`(message-convert.ts:23)`。
→ **即：Moss 的 tool result 对模型就是一段文本**，与 CC 一致；`structuredContent` 是 host/UI 通道，模型基本看不到。

### 2.4 并行执行

- 分组：`groupToolCallsForExecution(toolCalls, effectiveParallelSafeTools, loadToolsMetaName)` `(src/core/loop/agent-loop-tool-execution.ts:465)`。
- **只有 `readonly` 才可能并行**：`requestedParallelSafe` 先取平台配置，再与 `readonlyToolNames` 求交 `(agent-loop-tool-execution.ts:426-429)`。
- 组内 >1 且**不含重复 fresh observation** 且未超 tool 预算 → `Promise.allSettled` 并发 `(agent-loop-tool-execution.ts:494-521)`。重复的 `noReplay+freshObservation` 调用（同一 read_file 两次）会退化串行，避免探针语义互相污染 `(agent-loop-tool-execution.ts:119-129)`。
- 并发的每个 call 仍是完整管线（含各自审批）——但审批在并发组里不能弹交互对话框，这是 host 侧责任。

### 2.5 输出截断与 spill

- **按工具的 token 预算**（chars/4 估）：`exec`/`bash` 4,500；`read`/`read_file`/`edit_file`/`write_file`/`apply_patch` 10,000；`web_search` 2,250；`web_fetch` 8,000；`device_exec` 6,000；其他默认 4,000 `(src/context/tool-output-truncate.ts:1-19)`。
- **保头保尾、挖中间**，并用**按字节的二分查找**切点（CJK/emoji 不能按 UTF-16 index 切，避免切开 surrogate pair），且切点不得落在 `[REDACTED]` 标记内部 `(src/context/tool-output-truncate.ts:143-197)`。
- **截断提示带恢复指令**，而不是干说"被截断"：`read` → "re-read only it with offset/limit"；`exec` → "narrow the command (grep/head/tail)" `(tool-output-truncate.ts:37-44)`。这是 Task OS M12 的实测结论（每次 coding run 2–3 次盲目重读）。
- **rdk-docs 特殊照顾**：截断后把被切掉的 doc URL 重新追加，保证可引用 `(tool-output-truncate.ts:96-103)`。
- **spill**：`exec` 与 `device_exec` 丢中间前，把**已脱敏**的全文写到 `.moss/runtime/tool-output/<tool>-<ts>.txt`（0600，4MB 上限，7 天保留，每次写入顺带清理过期），返回相对路径 `(src/tools/tool-output-spill.ts:17-19)`、`(src/tools/tool-output-spill.ts:64)`。调用点在 `(src/tools/builtin.ts:412)`、`(src/tools/device-tools.ts:178)`。
  → 这一套（per-tool budget + 头尾保留 + 恢复提示 + spill 落盘）**比 Cursor/CC 公开描述的行为更完整**，是可直接作为"对标优势"记的点。

### 2.6 代表性工具实现要点

| 工具                                              | 关键行为                                                                                                                                          | 证据                                                                        |
| ------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `read_file`                                       | 行号前缀；未变更重读返回 stub；`noReplay+不值得重放` 但必须执行以登记读范围；越界路径可读                                                         | `(src/tools/file-tools.ts:204-215)`                                         |
| `write_file`                                      | 原子写；父目录自动创建；已存在则要求先读一次                                                                                                      | `(src/tools/file-tools.ts:347-353)`                                         |
| `edit_file`                                       | 精确串替换；`edits[]` 全成或全败；输出带 compact diff 预览                                                                                        | `(src/tools/file-tools.ts:876-885)`                                         |
| `apply_patch`                                     | 先校验全部 hunk 再写；失败回滚；拒绝二进制/非 UTF-8；CRLF 按主导行尾还原                                                                          | `(src/tools/patch-tool.ts:50-53)`                                           |
| `exec`                                            | 前后台统一入口；后台用 `exec_logs/exec_wait/exec_input/exec_stop`；拒绝未追踪的后台惯用法（`&`/nohup/`start /b`）；写目标受 `execWriteRoots` 约束 | `(src/tools/builtin.ts:152-160)`、`(src/tools/builtin.ts:114)`              |
| `ask_user_question`                               | 结构化多选/freeform；非 TTY 立即返回错误而非挂起；兼容 Cursor 式顶层单问题                                                                        | `(src/tools/ask-user-question.ts:12-16)`                                    |
| `task_define`/`task_acceptance`/`record_evidence` | 机检验收；`runtime_state` 免审批；缺证据=未完成                                                                                                   | `(src/tools/task-tools.ts:73)`、`(src/tools/evidence-tools.ts:88)`          |
| 设备工具                                          | readonly 可并行/自动重试；mutation 走 `requires_user_confirmation`；`device_deploy` 带 health check                                               | `(src/tools/device-tools.ts:85-134)`、`(src/tools/device-tools.ts:454-495)` |

### 2.7 计划态 / 延迟工具 / 工具搜索

- `exit_plan` 只在 `MOSS_PLAN_GATE=1` 时**注册**（不是运行时判断），否则连 schema 都不发 `(src/tools/builtin.ts:568-573)`、`(src/tools/plan-gate.ts:10)`。
- **延迟工具组**：5 个 subagent 工具常驻注册但默认不进模型工具列表，`tool_search(group='subagent')` 一次性揭示，揭示后**sticky**（工具列表不抖动）`(src/core/tools/deferred-tool-offer.ts:1-30)`。`tool_search` 额外兼容 CC 的 `{query:"..."}` 形状 `(src/tools/tool-search.ts:16-27)`。
- 目的与 CC `ToolSearch` 同构：把低频重 schema（5 个工具 ≈ 5.2k chars / 1.3k tok，实测）挡在默认请求外。

---

## 3. Agent loop 与 nudge / 纠偏

### 3.1 一轮的步骤

`runAgentLoop()` 是单一 `async` 闭包推进一个 `EventStream` `(src/core/loop/agent-loop.ts:128)`：

```
install dispatcher → bump run epoch → 初始化 state/caps/budget
└─ outerLoop
   └─ while (hasMoreToolCalls || pendingMessages.length)
      1. 排空后台完成通知（injectBackgroundCompletions）→ pendingMessages
      2. best-of-n 升级判断（同一验证命令连续失败 ≥2）
      3. 取 host steering 消息
      4. maxTurns / run budget / abort 三重检查
      5. 采剧本 toolsForTurn 快照 → 注入 nudge
      6. turns++ → 写入 pendingMessages → turn_start
      7. prepareTurnContext（prune/压缩/prefix 检查）
      8. executeLlmTurn（含 LLM 重试、overflow 恢复）
      9. processLlmResponse（completion gate / 空回复 / 续写 / 工具执行）
     10. flush assistant buffer → 再取 steering → 决定 continue / break
```

证据：`(agent-loop.ts:399-420)`（后台+best-of-n+steering）、`(agent-loop.ts:421-458)`（caps/budget/abort）、`(agent-loop.ts:460-478)`（tools 快照 + nudge 注入）、`(agent-loop.ts:520-620)`（turn 主体）、`(agent-loop.ts:629-695)`（错误恢复）。

### 3.2 什么时候中断 / 重试 / 注入纠偏

四类终止与四类纠偏：

**终止**
| 条件 | 行为 | 证据 |
| --- | --- | --- |
| `turns >= maxTurns` | 若"最后一条 assistant 还需要工具跟进"且未用完 bypass 额度，**再放一轮**；否则 `turn_transition(max_turns_reached)` | `(agent-loop.ts:421-434)` |
| run budget（tokens/toolCalls/时长） | 优雅停止，`turn_transition(budgetBreach)` | `(agent-loop.ts:435-449)`、`(src/core/loop/agent-loop-types.ts:196)` |
| abort | `turn_transition(aborted_by_user)` | `(agent-loop.ts:451-454)` |
| 输出上限耗尽 | `outputLimitHalted`，headless 报告为非成功 | `(src/core/loop/agent-loop-response.ts:412-427)` |

**纠偏**
| 机制 | 触发 | 动作 | 证据 |
| --- | --- | --- | --- |
| LLM 层错误 | 可重试分类 + 连续错误 ≤2 | 注入 recovery 消息，`turns--` 重来；超过即抛 | `(agent-loop.ts:629-695)`、`(agent-loop.ts:63)` |
| 空回复 | 连续空回复 | 第 1 次注入 "your previous response was empty"；超过预算抛 `EMPTY_MODEL_RESPONSE` | `(agent-loop-response.ts:437-457)` |
| 只思考不答 | thinking-only 连续 | 注入 retry（并且**必须换请求**：提高 reasoning override），预算耗尽即抛 | `(agent-loop-response.ts:377-390)` |
| 输出被截断（length） | `stopReason=length` | 提升 output token 预算 + 注入 continuation，最多 3 次 | `(agent-loop.ts:66)`、`(agent-loop-response.ts:391-411)` |
| 说了不做 | 终稿含"我来调用 X"但无 tool call | 注入 missing-tool nudge | `(agent-loop-response.ts:318-330)`、`(src/core/loop/follow-up-guard.ts)` |
| 流程 nudge | 29 个独立 id | 注入 `<system>` correction 消息 | `(src/core/loop/nudges/disable.ts:19)` |
| steering | 连续工具错误 ≥3 / 工具循环 ≥8 轮 / 上下文 ≥75% / 3 次不同搜索 | 注入 `[Steering] ...` 指导 | `(src/core/loop/steering.ts:29-31)` |

**关键设计选择**：steering **不在 end_turn 路径评估**。代码注释解释得很清楚——模型已经给出最终答案时再插一条 "be concise" 只会换来一轮"好的我明白了"，每个单轮回答都白烧一次往返；steering 只在"模型仍在干活"的工具执行路径评估 `(agent-loop-response.ts:335-344)`。这是一条可直接复用的经验。

### 3.3 空回复 / 重复调用防护

三层重复防护，粒度不同：

1. **同签名 identical-call 短路**（默认 3 次）：`stableSerializeToolInput` 做签名，`shouldShortCircuitToolCall` 返回原因字符串 `(src/core/tools/tool-loop-guard.ts:79)`、`(tool-loop-guard.ts:994)`。
2. **同结果 replay 缓存**：只读工具可由历史结果直接回放；`noReplay` 工具（`read_file`）例外——因为它必须在 execute 里登记"读范围"，重放会跳过 `(src/core/loop/agent-loop-tool-execution.ts:141-152)`、`(src/tools/file-tools.ts:212-214)`。
3. **fresh observation 预算**：允许"会变的资源"被有限次重新观测，但签名 12 次封顶、额外观测 24 次封顶 `(tool-loop-guard.ts:82-83)`、`(tool-loop-guard.ts:1131-1143)`。

其余限额（都可用 `MOSS_TOOL_LOOP_*` 覆盖）：单工具失败 3 次；discovery 类工具（read/search/list/skill/subagent/device…）失败 **2** 次就更早熔断；surgical edit 每路径失败 3 次；`exec`/`run_tests` 同命令同输出连续失败 3 次；web_search 不同 query 上限 6；web_fetch 按 URL 分别计失败 `(tool-loop-guard.ts:84-109)`、`(tool-loop-guard.ts:1015-1085)`。

**拦截消息是双语的、给下一步的**，不是一句"STOP"：例如 edit thrash → "STOP retrying … Call `read_file` on that path, rebuild the edit from exact current text"；`same check failed repeatedly` → "优先修代码；不要换工具绕开同一检查" `(tool-loop-guard.ts:659-780)`。这与 CC 的"工具错误原文返回"路线不同：Moss 会**替模型写解释并指定下一步**。

还有一层**跨工具逃逸封堵**：一旦 edit 工具拒绝某路径，`exec` 用 shell 写同一文件会被拦（`sed -i`/重定向/`cp` 都被识别）`(tool-loop-guard.ts:1029-1052)`、`(src/context/stale-read-invalidate.ts:45)`。

**消息配对修复**：`tool_use` / `tool_result` 不成对时，上游调用前会插入合成块修复，而不是让 provider 报 400 `(src/core/tools/tool-result-roundtrip-guard.ts:1-30)`。

### 3.4 task 完成门（两道）

**第一道：acceptance completion gate**（本 run 定义过 task 但无验收裁决）

- 首次拦截：注入修正（"跑 task_acceptance / 修复 / 诚实报 FAIL"），`retryLimit: 2`；
- 有 FAIL 但之后没有 repair 动作（`record_failure`/`record_repair`/`record_evidence`）：再拦一次，`retryLimit: 1`；
- **每个 run 每种原因最多拦一次**，之后放行，绝不无限劫持 `(src/core/loop/acceptance-completion-gate.ts:174-240)`。
- runtime 已裁决（engine 或上一 run 落过 accepted）时直接放行 `(acceptance-completion-gate.ts:214)`。

**第二道：宿主 completion gate**（CLI 编码门）

- `processLlmResponse` 在终稿上调用 `completionGate`，`decision.ok=false` 且未超 `MAX_COMPLETION_GATE_ATTEMPTS=2` → 撤回终稿（从 assistantBuffer 移除）、清空 `finalText`、注入 correction、`continue`；超限则**抛错**而不是假成功 `(agent-loop-response.ts:35)`、`(agent-loop-response.ts:288-315)`。

两者叠加意味着：**Moss 的"完成"不由模型散文决定**。配合 evidence/acceptance 的 latest-wins，是这套 harness 最像"产品"的部分。

### 3.5 run-epoch 抢占

同一 sessionKey 的多次 `runAgentLoop` 通过 epoch 抢占：新 run bump epoch，旧 run 闭包里的 `stream.push` 发现 epoch 过期就**静默丢弃**（"later run wins"），避免同一 session 的两个流互相污染 `(src/core/loop/agent-loop-push-guard.ts:1-20)`。默认 store 是模块级单例，多 MossAgent 实例必须注入自己的 Map `(agent-loop-push-guard.ts:10-16)`。

---

## 4. 上下文 / 记忆机制

### 4.1 分层压缩：5 个档位，从便宜到贵

每轮 `runPerTurnContextManagement()` 先算 `planContextBudgetActions()` 再按序施加动作 `(src/core/loop/per-turn-context-management.ts:36)`、`(src/core/loop/context-budget-planner.ts:42)`：

| 档  | 动作                                                         | 何时                                  | 阈值/参数                                                               | 证据                                                           |
| --- | ------------------------------------------------------------ | ------------------------------------- | ----------------------------------------------------------------------- | -------------------------------------------------------------- |
| 0   | 首轮不做                                                     | `turn <= 1`                           | —                                                                       | `(context-budget-planner.ts:47)`                               |
| 1   | **失效陈旧读** `invalidate_stale_reads` + **elide 旧大结果** | 每次工具跟进轮 / 基线卫生             | elide: 保留最近 3 条，≥8,000 chars，头 400/尾 240                       | `(tool-result-elision.ts:36-41)`                               |
| 2   | **snip 尾部超大结果**                                        | `estPromptTokens >= warningThreshold` | 保留最新 2 条，12,000 chars 上限                                        | `(tail-tool-snip.ts:12-16)`                                    |
| 3   | **microcompact**                                             | warning / proactive                   | warning: 保 6 条 /≥200 chars；proactive: 保 2 条 /≥50 chars             | `(microcompact.ts:12-16)`、`(context-budget-planner.ts:88-98)` |
| 4   | **LLM 摘要压缩**                                             | 见 4.2                                | reserve 20k / keepRecent 20k / 摘要 ≤4,096 tok / 恢复 5 个文件 ≤50k tok | `(compaction.ts:118-137)`                                      |
| 5   | **压缩熔断**                                                 | LLM 摘要连续失败                      | `overflow-recovery` 的 `fused` 档 → 确定性截断                          | `(src/core/loop/overflow-recovery.ts:18-48)`                   |

阈值本身也分三层 `(src/context/window-economics.ts:1-59)`：

- `effectiveContextWindow = contextWindow - min(maxOutputTokens, 20_000)`
- `proactiveThreshold = effectiveWindow - max(13_000, 0.18 × effectiveWindow)`
- `warningThreshold = proactiveThreshold - min(20_000, 0.1 × effectiveWindow)`

即 **1M 窗口下 proactive 在 ~974k 触发、warning 在 ~954k**；32k 小窗口下 buffer 退化为 13k 的绝对值下限。这是"按窗口比例 + 绝对下限"的混合策略，比 CC 的单一比例更稳。

### 4.2 压缩策略：LLM 摘要 vs 确定性

- **策略选择**：`selectCompactionStrategy()` 支持三条路——本地 LLM 摘要、远程 compaction provider（`MOSS_*` env 配置）、跳过 LLM 直接确定性 `(compaction.ts:911)`、`(src/context/remote-compaction.ts:1)`。
- **分块摘要**：`splitMessagesByTokenShare` 自适应 chunk ratio（0.4 → 0.15，按平均消息占比下降）`(compaction.ts:106-108)`、`(compaction.ts:414)`；超过 50% 窗口的单条消息单独走"oversized"路径 `(compaction.ts:497)`。
- **摘要提示词是本仓库最"重"的提示词工程**（中文，92 行）`(src/context/compaction-prompts.ts:19)`：
  - `<analysis>` 草稿 + `<summary>` 正文两段式；
  - **反失忆优先级高于篇幅**：用户"必须/不要/禁止"要逐条写成可执行短句，不得概括成"用户有偏好"；
  - **精确字面量必须保留**：路径、函数名、命令、端点、错误码、版本号、哈希、端口、IP；
  - **事实强度分级**：只有用户确认 / 工具结果 / 官方来源能写"已验证"，旧 assistant 回答只能写"历史说法/待核对"；
  - 固定 10 节模板（0 历史脉络 … 9 后续工作所需上下文），每节无内容写"（无）"，不许省略章节 `(compaction-prompts.ts:26-56)`；
  - 摘要 ≤ ~3,000 tokens（约 1.2 万字符）硬上限 `(compaction-prompts.ts:60)`；
  - 增量更新用 `UPDATE_SUMMARIZATION_PROMPT`：默认保留旧约束与已验证事实，"推翻时写「更新：…（旧：…）」，不要静默删除" `(compaction-prompts.ts:76-88)`。
    → 这是一份**可直接拿去做竞品对照的高质量摘要契约**，Cursor/CC 公开材料里没有等价细节。
- **确定性兜底**：`deterministic-summary.ts` 在 LLM 不可用时按消息顺序生成 12,000 chars 上限的结构化清单（tool_use 只保留高价值入参 `path/file_path/cmd/command/url`）`(src/context/deterministic-summary.ts:6-20)`。
- **多段摘要合并**：`mergePriorCompactionSummaries()` 保留最多 20,000 chars 的早期检查点，并显式标注"弱上下文，未标明来源的事实需复核"，绝不静默丢早期决策 `(src/context/summary-checkpoint-merge.ts:5-52)`。

### 4.3 保留 / 丢弃规则

**pruning（删消息层）** `(src/context/pruning.ts:77-93)`：

- `maxHistoryShare 0.5`：历史最多占可用字符窗口的一半（另一半留给系统提示）。
- 两道软/硬阈值：`softTrimRatio 0.3`（工具结果头 1,500+尾 1,500、单条 ≤4,000）→ `hardClearRatio 0.5`（整条替换为 `[Old tool result content cleared]`）。
- 字符占比降到预算内就**不删消息**；超了才按 `keepLastAssistants 3` 找切点，保留受保护尾部，从后往前填预算 `(pruning.ts:426-540)`。
- 保护性收尾：`protectLatestCompactionSummary()`（最新摘要永不被删）+ `expandKeptWithToolRoundtrips()`（被保留的 tool_result 一定连同它的 tool_use 一起保留，避免孤儿块）`(pruning.ts:519-522)`。
- **最小历史地板**：`minMsgTokenFloor = min(4096, max(512, 20% × window))`，系统提示再大也不能把历史压没 `(pruning.ts:435-446)`。

**elision / fold（改内容层）**：

- elision 只动"最后一条 assistant 之前"的结果，pending batch（当前必须回答的那批）永不 elide `(tool-result-elision.ts:8-13)`。
- **fold 是成本决策不是容量决策**：`savedTokens × remainingRequests × readPrice > suffixTokens × (writePrice - readPrice)`，`savingsRatio=11.5`（Anthropic sonnet/haiku）、`horizon=5`、prompt 至少 60k tok 或窗口一半才启动 `(src/context/tool-result-fold.ts:1-41)`。措辞很讲究："This is not limited to context-window compaction"，即 fold 只在"改前缀能赚回写缓存成本"时做。

**陈旧读失效（跨轮的事实修正）** `(src/context/stale-read-invalidate.ts:323)`：

- 收集所有 tool_result 事件，把路径归一成 key；`read` 之后出现 `mutate`（含 `exec` 的 `sed -i`/重定向/`cp`/`mv`）→ 旧 read 内容替换为 `STALE_READ_PLACEHOLDER`（中英双语，明确要求重读）`(stale-read-invalidate.ts:21-24)`。
- 还做 `dedupeUnchangedReadToolResults()`：重复的"文件未变"读取合并 `(stale-read-invalidate.ts:423)`。
- **回写脏读缓存**：内容被压缩/剪裁后，通过 `notifyReadContextDropped()` 通知 read_file 复用缓存失效——否则缓存会答"未变更，参考之前的读取"，而那次读取已经不在上下文里了 `(src/context/read-context-events.ts:1-10)`、`(tool-result-elision.ts:13)`。这是很细但很关键的一致性补丁。

**turn-watch（跨轮外部变更感知）** `(src/context/turn-watch.ts:166)`：

- 比较对话里读写过的文件的 mtime 与会话最后活动时间，检测"用户趁你不注意改了文件"；以及日历翻日（date_change）。
- 结果**不落库**，只挂当轮 `<turn-context>`；`MOSS_DISABLE_TURN_WATCH=1` 可关 `(turn-watch.ts:22-25)`。
- 注释直接写明来源：_"Mining Qoder Desktop conversation logs (2026-11-04, 476 sessions) surfaced two high-frequency runtime injections Moss had no equivalent for: edited_text_file (213 occurrences) and date_change (24)"_ `(turn-watch.ts:1-14)`。→ **这是已经做过一次竞品挖掘的痕迹，Lead 应避免重复劳动。**

### 4.4 跨会话记忆：确认冻结，只有会话内记忆

- `AGENTS.md` 明确：_"维持冻结：memory（跨会话自动记忆）/ mesh / observability / orchestration / web-ui / 插件市场。不要重新引入这些子系统"_（仓库根 `AGENTS.md:26`）。
- 代码事实一致：`src/` 下没有任何 memory 子系统模块；`memory_read`/`memory_write`/`memory_delete` 只作为**需要熔断的历史工具名**出现在 loop-guard 的 discovery 列表里 `(src/core/tools/tool-loop-guard.ts:22-46)`；`src/core/superagent/upstream/memory.ts` 是 Super-agent 的**内存仓储实现**（`MemoryRepositories`，用于测试/临时实例），与"跨会话记忆"无关，且不在 `core/index.ts` 的 memory 导出面 `(src/core/superagent/upstream/memory.ts:1-20)`。
- 现存的"记忆"只有四种，都是**会话/工作区级**：
  1. 会话持久化 `JsonlSessionStore`（`src/core/session/`）；
  2. 工作区工件 `.moss/tasks.jsonl`、`evidence.jsonl`、`deployments.jsonl`、`task-events.jsonl` 等 `(agent-behavior-prompt.ts:6)`；
  3. 压缩检查点摘要（会话内、可跨压缩轮累积，见 4.2）；
  4. AGENTS.md / soul.md / skills（人写的、非自动积累）。
- 另有一条"经验库"：`buildExperienceBlock()` 在**首轮**按用户消息检索工作区经验并拼进 `extraContext` `(src/core/agent/moss-agent.ts:1084-1089)`、`(src/core/experience/experience-library.ts)`。这是当前唯一"自动积累 + 自动回灌"的机制，但作用域仍是工作区，且只在首轮注入 → **这是 memory 冻结下最接近"记忆"的替身，值得 Lead 评估是否作为 memory 解冻的落点**。

---

## 5. MCP / skills / subagent / task runtime

### 5.1 MCP 客户端（v0.16，懒加载）

- 传输：stdio + streamable HTTP 双传输 `(src/core/mcp/stdio-transport.ts)`、`(src/core/mcp/http-transport.ts)`；协议版本 `2025-06-18` `(src/core/mcp/client.ts:22)`。
- **懒加载形状 = "CC MCPSearch"**：每个 server 只广告一个 `mcp__<server>__search` 元工具（列 name+description，**不含 schema**），真实 `mcp__<server>__<tool>` 在 search 列出后才按需注册；先挂宽松 `{type:'object'}` schema，首次调用后再把真 schema 贴上去 `(src/core/mcp/registry.ts:1-14)`。
- **提示词注入**：`buildMcpStableIndex()` 只写 server 名 + search 工具名，**不写工具数量、不写连接状态**——因为握手完成会改变计数并打掉前缀缓存 `(src/core/mcp/registry.ts:752-770)`。CLI 把它放在 dynamic `(src/cli-main.ts:1228-1233)`。
- 安全：MCP 工具**故意不声明 sideEffectClass** → 审批层按 `local_write` 全部走审批；工具名 >64 chars 走 `mcp__<server>__<tool>_<hash8>` 截断 `(registry.ts:107-117)`；server 描述只取首行、≤500 chars，防恶意 server 撑爆 payload `(registry.ts:83-95)`。
- 内置 server：`rdk-docs` 默认开启、后台连接、不阻塞启动；`MOSS_NO_RDK_DOCS=1` 关闭 `(src/cli-main.ts:1211-1220)`。
- 能力发现：`mcpServerFromWireName()` + `capability.ts` 支持"按 goal 匹配 MCP 工具"而不必先揭示整目录 `(src/core/task/capability.ts:26-38)`。

### 5.2 Skills（v0.16，渐进披露）

- 发现目录：工作区 `.moss/skills/` + `<configDir>/skills/`；`_template`/`.hidden` 跳过 `(src/core/skills/skill-registry.ts:102-104)`。
- **索引进提示词、正文按需加载**：`buildSkillsPromptLayer()` 只输出 `- name: description (when: ...)`，约 40 tok/skill `(skill-registry.ts:193-207)`；正文靠 `skill` 工具读，单次 ≤24,000 chars，`$ARGUMENTS` 做替换，用 mtime 做缓存失效 `(src/tools/skill-tool.ts:5-33)`。
- 没有 skill 时也会注入 `buildEmptySkillsHintLayer()`，列出 Moss 自己的目录并明确"其他工具的 skill 目录（如 `~/.claude/skills`）不会被加载"——防止模型去扫别人家的目录 `(skill-registry.ts:210-219)`。
- 无自动触发/无匹配打分：是否加载完全由模型决定（只有 `when:` 提示）。对比 Cursor 的 rules 自动注入，这是能力缺口（§6 G8）。

### 5.3 Subagent

- **scope 即工具白名单**：`critic(空)` / `read-only(4)` / `device-read` / `explore` / `plan` / `verify` / `full(不过滤)` `(src/core/subagent/spawn-profile.ts:74-110)`。`verify` 额外带 `record_evidence`+`task_acceptance`，让验证子代理能自己落证据并过验收门 `(spawn-profile.ts:90-108)`。
- 过滤时**强制**剔除 `create_subagent`/`fan_out_subagents`/`tool_search`（防递归），read-only/explore 还要求 `metadata.sideEffectClass === 'readonly'` `(src/core/subagent/subagent-runner.ts:161-180)`。
- **提示词继承**：子代理默认继承父的 `stable`，dynamic 换成 `[父dynamic, expertAddon, scopeAddon, prevStepAddon]`；`systemPromptOverride` 时整块替换且**不拆 stable/dynamic**（prefix-cache 不再生效）`(subagent-runner.ts:197-221)`。
- **每个 scope 一段强制加成的 prompt**，最硬的一条是 "You MUST end with a text summary… the parent agent receives ONLY your final text output" + "Even if you ran out of turns: write `## Partial results`" `(spawn-profile.ts:133-146)`。
- 隔离与合并：可选 git worktree 隔离 + lease/patch 合并 `(src/core/subagent/worktree-isolation.ts)`；启动预算 `DEFAULT_MAX_SUBAGENT_STARTS_PER_RUN` 可扩展 `(src/core/subagent/spawn-budget.ts)`。
- file-defined agents（`.moss/agents/`）+ expert registry 会进 stable 提示词（§1.1 第 5 块），并支持 per-child model override `(expert-registry.ts:235)`、`(subagent-runner.ts:138-143)`（注释坦承 override 后 context window 仍用父值，是已知 follow-up）。

### 5.4 Task runtime

- 状态机契约在 `src/contracts/task-runtime.ts`：`draft → … → verifying → diagnosing → repairing → reverifying → accepted/failed`；非法转移抛 `EXECUTION_STATE_INVALID`；**PASS 只能来自 verdict provider，模型散文永远不是事件** `(src/contracts/task-runtime.ts)`。
- 引擎：`runTask` / `resumeTask` 驱动 plan→execute→verify→repair→accept，`DEFAULT_MAX_REPAIR_ATTEMPTS=5`、`DEFAULT_MAX_TURNS=24` `(src/core/task/task-engine.ts:80-81)`、`(task-engine.ts:529)`。planning/execution/repair 三段各有专用 prompt（`task-engine.ts:83/113/153`），repair 历史只带最近 3 条、每条 ≤200 chars `(task-engine.ts:135-136)`。
- 裁决优先级：**命令裁决 > 契约裁决** `(src/core/task/verdict.ts:26-46)`、`(verdict.ts:288)`。证据匹配是 metric + latest-wins（修复后复测能翻盘）。
- 能力发现注入 planning：`capability.ts` 按 goal 关键词给 skills/内置工具/MCP 打分，把候选 + "deviceTask/deviceConfigured" 一起喂给规划轮 `(capability.ts:1-40)`——设备形 goal 但没有配置设备时**不会**要求模型去探设备。
- 四入口同一行为：`moss task run/resume/status/timeline`、REPL `/task`、SDK、TUI 读同一份 `.moss/` 工件（仓库 AGENTS.md 记录）。

---

## 6. 已知缺口与设计张力（候选清单，供 Lead 取舍）

> 只陈述代码事实，不给方案。

**G1 · 前缀缓存在默认 CLI 配置下基本不成立**
`assessPromptCacheEligibility` 要求 dynamic 占比 ≤25% `(src/core/llm/prompt-prefix-cache.ts:30)`；但 CLI 把 16KB 上限的 AGENTS.md（本仓库 25KB→截到 16KB）和 40 条 git 状态都放在 stable/dynamic 里 `(src/cli/project-instructions.ts:15)`、`(src/context/environment.ts:49)`。实测 stable 4.6k chars vs dynamic ~17k chars → 永不 eligible。**AGENTS.md 放在 stable 是加分（稳定），但它把 stable 撑到和 dynamic 同量级，"缓存前缀"设计意图被抵消。**

**G2 · 工具 schema 占提示词 87%，且隐藏策略只覆盖 subagent**
38 个可见工具 ≈ 8.2k tok（实测），而固定 prose 只有 ~1.2k tok。已做延迟揭示的只有 5 个 subagent 工具 `(src/core/tools/deferred-tool-offer.ts:1-12)`；`device_*`（11 个）、`task/evidence`（5 个）、`exec_* 后台`（5 个）全部常驻。对非设备/非 task 的纯 coding 会话，这是持续的无效 token 税。

**G3 · 没有真正的 plan 模式提示词**
`plan` 只是审批模式 `(src/cli/interaction-mode.ts:44)`，system prompt 与 act 完全相同；`exit_plan` 默认不注册 `(src/tools/plan-gate.ts:10)`。模型在 plan 模式下拿不到"先只读、产出计划、不要动手"的任何指令，只能靠工具被拒后自我修正。CC 的 plan mode 有独立 prompt 段。

**G4 · MCP 工具默认全部走审批，headless 下等于不可用**
MCP 工具不声明 sideEffectClass → `inferSideEffectClass` 返回 `local_write` → `needsApproval` 为真 `(src/cli/approval.ts:260)`、`(src/cli/approval.ts:518)`；而 headless（`-p`）拒绝需审批动作。`rdk-docs` 是内置默认开启的 server，**在 print 模式下可能只能读提示词索引、不能真正调用**——需要 Lead 用真实 headless 跑一次确认（我未运行，不报结论）。

**G5 · AGENTS.md 只读工作区根，单文件 16KB**
不递归、不合并父目录、不认 `CLAUDE.md` `(src/cli/project-instructions.ts:17-18)`、`(src/cli/project-instructions.ts:15)`。CC 支持子目录嵌套 + `CLAUDE.md` 双拼写。本项目自己的 AGENTS.md 25KB 已被截断 9KB——**Moss 无法完整读到自己的项目指令**，这是可验证的自伤点。

**G6 · nudge 是"事后补丁"而非"事前约束"**
29 个 nudge id `(src/core/loop/nudges/disable.ts:19)`，每个都是"模型做错了 → 注入纠正"。这是高成本路径（多一轮 LLM 调用）。而 §1.4 已经承认 quick prompt 删掉了长版方法论——**删 prose 的代价被转移到了 nudge 轮次上**，两者之间没有量化对照（`bench:ab` 只覆盖 best-of-n/reasoning-high/model-routing）。

**G7 · 压缩摘要的"事实强度分级"没有机器校验**
摘要提示词要求"只有工具/用户/官方来源能写已验证" `(src/context/compaction-prompts.ts:19-26)`，但摘要产物是自由文本，下游没有任何解析或校验；`mergePriorCompactionSummaries` 也只是字符串拼接加免责声明 `(src/context/summary-checkpoint-merge.ts:52)`。**契约是给模型的自律，不是结构**。对比 Task runtime 的 verdict provider（结构 + 状态机），这里是同一问题域的两种强度。

**G8 · skills 无自动匹配 / 无组合**
只有 `name: description (when:)` 索引 `(src/core/skills/skill-registry.ts:193)`，是否加载完全靠模型读索引判断；没有像 `capability.ts` 那样对 skills 做 goal 打分（打分只在 task runtime 内部用）`(src/core/task/capability.ts:1-10)`。tasks 有自动匹配、chat 没有——两套逻辑分裂。

**G9 · turn-watch 只感知文件 mtime 与日期**
`(src/context/turn-watch.ts:1-14)`。不感知：用户切换了分支、改了配置、装了依赖、外部进程改了 port。检测靠 mtime > 会话最后活动时间，**对"内容相同但 mtime 更新"和"内容变化但 mtime 后退"都无解**。

**G10 · 已知的自我记录缺陷（代码注释里明说）**

- 子代理 model override 后 context window 仍用父模型的值 → compaction/pruning 会算错 `(src/subagent/subagent-runner.ts:130-137)`。
- `deferredTools` 揭示是 sticky 的，一旦揭示永不收回，长会话里工具列表只增不减 `(src/core/tools/deferred-tool-offer.ts:1-5)`。
- `AGENTS.md` 16KB 截断对 25KB 的项目文档是静默的信息损失（有提示但模型仍缺内容）`(src/cli/project-instructions.ts:55)`。

---

## 附录 A · 复测方法（Lead 可直接跑）

```bash
# 提示词各层实测字符数
node -e "import('./dist/contracts/index.js').then(m=>{for(const [n,f] of [['behaviorQuick',m.buildAgentBehaviorPromptQuick],['behaviorFull',m.buildAgentBehaviorPrompt],['domainQuick',m.buildSoftwareEngineeringPromptQuick],['domainFull',m.buildSoftwareEngineeringPrompt],['langQuick',m.buildLanguagePolicyPromptQuick]]){const t=f();console.log(n,t.length)}})"

# 工具面实测（注册数 / 可见数 / schema 总量）
node -e "Promise.all([import('./dist/tools/builtin.js'),import('./dist/core/tools/deferred-tool-offer.js'),import('./dist/core/tools/tool-catalog.js')]).then(([b,d,c])=>{const dv=new Set(d.SUBAGENT_DEFERRED_TOOLS),lg=new Set(c.LEGACY_ALIAS_TOOL_NAMES);const v=b.builtinTools.filter(t=>!dv.has(t.name)&&!lg.has(t.name));let s=0;for(const t of v)s+=JSON.stringify({name:t.name,description:t.description,inputSchema:t.inputSchema}).length;console.log('registered',b.builtinTools.length,'visible',v.length,'chars',s)})"

# 真实提示词分层（不需要模型调用）
moss context report     # src/cli/context-report.ts 会按 layer 打印 measured 大小
```

## 附录 B · 本次未验证项（不报结论）

- 未运行 `npm run verify/build/smoke/bench`；`dist/` 是仓库既有产物（2026-11-04 19:39 构建），测量基于它。
- 未用真实 provider 跑一次完整 run，因此 §1.3 dynamic 去重、§2.5 spill、§3.4 completion gate 的实际线上字节/轮次未观测。
- §6 G4（MCP 在 headless 下是否被拒）是**代码推断**，需真实 `moss -p` + rdk-docs 调用验证。
- 未审计 `src/core/experience/`（经验库）全文，只确认其注入点在首轮 `(src/core/agent/moss-agent.ts:1084-1089)`。
