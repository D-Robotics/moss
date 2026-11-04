# Moss 下一批能力方向脑暴（对照 Claude Code / Cursor 2026 现状）

- 日期：2026-11-04
- 状态：**脑暴稿**（不是路线图，不是承诺；每条方向都标注优先级、成本、是否触碰冻结线）
- 输入：
  - 本轮重读的官方文档（2026 现行版）：Claude Code `features-overview` / `skills` / `plugins/overview` /
    `plugins/components` / `plugin-evals` / `memory` / `workflows` / `mcp`；Cursor `docs/rules` / `docs/skills` /
    `docs/subagents` / `docs/hooks` / `changelog/2.4`（2.4 于 2026-01-22 发布：subagents、skills、图片生成）
  - 本仓库现状：只读源码 + `dist/` 实测（2026-11-04，HEAD `7dc75cd2` 之后）
  - 既有研究：`docs/research/2026-11-04-cursor-claude-agent-design/`（Cusror 3.27 / CC 2.1.317 时代的证据）
    与 `docs/specs/2026-11-04-moss-skill-library-architecture.md`（SK1–SK7）

---

## 0. 一页结论

1. **技能这条线已经不是差距**。Moss 的 SK1–SK7（契约/解析、预算 catalog、正文包裹、core 内置化、
   跨客户端发现、install/lock、evals）与参考产品 2026 年的 skill 能力面基本对齐；本轮还发现并修掉
   一个真实缺陷：**符号链接技能目录 18/19 不可见**（`614db704`）。
2. **参考产品 2026 的真正变化不在"再加一个功能"，而在三个"收口"**：
   - 技能收进 **plugin（能力包）**：skills + commands + agents + hooks + MCP + themes + workflows +
     LSP + settings 打成一个可版本化、可评估、可分发、可度量的单元（Claude `plugins/components`；
     Cursor `plugins` + 团队发布 skill）。
   - 工具面收进 **惰性发现**：工具搜索 / MCP lazy / 按能力揭示；Claude 的 `ToolSearch`、Cursor 的
     MCP lazy loading 都在为"schema 税"买单。
   - 多代理收进 **可复用脚本/团队**：`workflows`（脚本持有计划，可重跑、可恢复、可对抗式复核）、
     `agent teams`（共享任务板 + 跨会话消息）。
3. **工具 schema 没有想象中贵，但仍有优化空间**。注册表 46 个工具 / 41,745 chars 只是"全部可见"的上界；
   按真实会话可见规则实测（`toolVisibleForRun`）：**chat 25 工具 / 23,062 chars（≈5.8k tokens）、
   coding 31 / 28,733（≈7.2k）、device 36 / 34,513（≈8.6k）**。`device_*` 在未配置设备时**已经隐藏**，
   `task_*`/`record_*` 只在 taskFlow 会话出现，子代理 5 个工具要 `tool_search` 才揭示。所以 D3 不是
   "把设备工具藏起来"（已经做了），而是**lean 描述、去重、以及对 `todo_write` 做一次是否值得删的实验**；
   它从 P0 降为 P1。
4. **建议的下一波（A 波，1–2 天可交付）**：D4 MCP 协议补全 + D2 评估 grader 升级 + D12 hooks 契约对齐。
   三者共同点是：**不改产品哲学、不碰冻结线、全部可用真实运行量化收益**。D3 改为"先测量再瘦身"，
   放进 B 波。
5. **一个需要 owner 决策的分叉**：D1 能力包（plugin-lite）。它是最像参考产品、也最能把 RDK 知识
   打包分发的一步，但它需要明确"本地插件加载"是否越过了「插件市场冻结」的边界（市场=托管/registry，
   本地包≠市场，但需要 owner 确认）。
6. **不要按功能清单抄**：参考产品有 cloud agents、remote control、artifacts、Chrome、voice、blame、
   image generation——这些与"RDK 机器人闭环 + 本地 coding harness"的产品目标无关，抄了只会丢重心。

---

## 1. Moss 现状（本轮实测，不是文件猜测）

| 能力面           | 现状                                                                                                                                                                                    | 证据                                                                                                                                                    |
| ---------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 技能             | SK1–SK7 完成；跨客户端目录（`.moss/.agents/.claude` + 用户级）；`globs` 激活；install/update/lock（hash+来源）；with/without eval                                                       | `src/core/skills/`、`src/cli/skill-install.ts`、`scripts/skill-eval.mjs`                                                                                |
| 技能目录 symlink | **已修**：18/19 用户技能曾被静默跳过                                                                                                                                                    | `src/core/skills/skill-registry.ts`（本轮 `614db704`）                                                                                                  |
| 工具面           | 46 注册 / 41,745 chars（上界）；真实可见面 chat 25 / 23,062、coding 31 / 28,733、device 36 / 34,513 chars；`tool_search` 只揭示 5 个 subagent 工具；设备/任务工具已按配置/taskFlow 门控 | `src/core/agent/session-tool-offer.ts:77`（`toolVisibleForRun`）、`src/tools/tool-search.ts`、`src/core/tools/deferred-tool-offer.ts`；本轮 `dist` 实测 |
| Hooks            | 11 个事件 + Claude 格式兼容 + 阻塞语义 + `/hooks`                                                                                                                                       | `src/cli/hooks.ts`、`src/cli/hook-event-names.ts`、`src/cli/claude-compat.ts`                                                                           |
| 子代理           | 文件定义（`.moss/.claude/agents`，Claude frontmatter 兼容）、前后台、fan-out、worktree 隔离                                                                                             | `src/core/subagent/agent-file-loader.ts`、`subagent-orchestrator.ts`                                                                                    |
| 规则/指令        | `AGENTS.md`/`CLAUDE.md` 祖先链 + 用户级；`.moss/rules` 里 always + `globs` 两类                                                                                                         | `src/cli/project-instructions.ts`、`src/cli/prompt-setup.ts:94-141`                                                                                     |
| 规划模式         | 独立 prompt 层 + `exit_plan` 工具 + 批准印章                                                                                                                                            | `src/core/agent/moss-agent.ts`、`src/tools/plan-gate.ts`                                                                                                |
| 权限/安全        | manual/acceptEdits/plan/full、allow/ask/deny glob 规则、设备信任分级、egress allowlist、redaction                                                                                       | `src/cli/approval.ts`、`src/safety/`                                                                                                                    |
| 检查点           | `/rewind` 同时回滚文件与对话                                                                                                                                                            | `src/cli/file-checkpoint.ts`、`src/cli/runtime.ts:1645`                                                                                                 |
| 会话             | resume/fork/export、JSONL、inbox/steering、context epoch                                                                                                                                | `src/core/session/`                                                                                                                                     |
| MCP              | stdio + streamable HTTP + 工具懒加载；**无 resources/prompts/elicitation/OAuth**                                                                                                        | `src/core/mcp/*`（grep 无对应符号）                                                                                                                     |
| 插件             | 只做信任扫描（`.moss/plugins`、`.claude/plugins` 的 manifest 识别）；**`moss plugins` 明确未实现**                                                                                      | `src/cli/workspace-trust.ts:214-230`、`src/cli/command-dispatcher.ts:702`                                                                               |
| 记忆             | 写路径冻结；读路径完善（层级 + 祖先 + 用户级 + 路径规则）                                                                                                                               | `src/cli/project-instructions.ts`                                                                                                                       |
| 多模态           | 消息契约与 provider wire 有 image block，**CLI 无附件入口、无 `read_image` 工具**                                                                                                       | `src/contracts/messages.ts:11`、`src/provider/pi-ai-wire-format.ts:364`                                                                                 |
| 执行隔离         | workspace-write 只是文件工具约束；OS sandbox 仅设计稿                                                                                                                                   | `docs/design/os-sandbox.md`（Status: design only）                                                                                                      |
| 评估/观测        | verify/bench/run_metrics/usage/pricing；技能 eval 只有 with/without + `expect_contains`                                                                                                 | `scripts/verify/`、`bench/`、`scripts/skill-eval.mjs`                                                                                                   |

补充实测（本轮）：

- 用户级 `.claude/skills` 19 个 → 修复后 19/19 加载；加上工作区 3 个 = 22 个技能，
  未裁剪 catalog 4,199 chars（≈1k tokens，`strategy=full`）。**技能本身不贵，贵的是工具 schema。**
- 工具 schema（真实可见面，按 `toolVisibleForRun` + 未揭示 deferred 计算）：chat 25 工具 / 23,062 chars
  （≈5.8k tokens）、coding 31 / 28,733、device 36 / 34,513。`device_*` 未配置设备时全部隐藏；
  coding 面里最大单工具仍是 `search_code` 1,969、`exec` 1,889、`edit_file` 1,511、`web_search` 1,402 chars。
- 已修：symlink 技能目录（19/19 加载）；工具可见面测量修正（上一版把"注册即可见"当成真实成本）。

---

## 2. 对照矩阵（只列"有产品含义"的差异）

图例：✅ 对标不落后；◐ 部分/形态不同；❌ 缺；— 明确不做/冻结。

### 2.1 技能与分发

| 能力                                              | Moss                                    | Claude Code（2026 文档）                                                                                  | Cursor（2026 文档）                          |
| ------------------------------------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| SKILL.md 标准 + 三档披露                          | ✅                                      | ✅（follows agentskills.io）                                                                              | ✅                                           |
| slash 调用 / 参数注入                             | ✅                                      | ✅（`/skill-name`，commands 已并入 skills）                                                               | ✅（`/` 菜单；skill 挂到当前会话或消息）     |
| 目录兼容                                          | ✅ `.agents/.claude` + 用户级           | ✅ `.claude/skills` + plugins                                                                             | ✅ `.agents/.cursor` + `.claude/.codex` 兼容 |
| 符号链接技能目录                                  | ✅（本轮修）                            | 文档未单列（dotfiles 场景常见）                                                                           | 未单列                                       |
| 技能内脚本不自动执行                              | ✅ 显式声明                             | ✅（脚本由模型用 Bash 调）                                                                                | ✅                                           |
| 技能评估                                          | ◐ with/without + `expect_contains`      | ✅ `skill-creator` + `evals/evals.json`；plugin eval 有 regex/tool-called/rubric judge + baseline + CI 门 | 文档未单列（有 sandbox/eval 基础设施）       |
| 能力包（skills+commands+agents+hooks+MCP 一起装） | ❌                                      | ✅ plugin components（含 themes/workflows/monitors/LSP/bin/settings/userConfig）                          | ✅ plugins + 团队发布 skill                  |
| 版本/依赖                                         | ◐ lock 记录 source/rev/hash，无依赖解析 | ✅ plugin version + dependencies（semver 约束）                                                           | ◐ plugin 更新/团队管理                       |
| 使用度/成本度量（catalog ROI）                    | ❌                                      | ✅ plugin measure（每会话上下文增量、是否仍被使用）                                                       | ◐ 团队分析（Blame/usage）                    |
| 创建器（脚手架+评测生成）                         | ◐ `skill create` 脚手架                 | ✅ skill-creator：生成 cases、跑隔离子代理、grading                                                       | ✅ `/create-skill` artifact                  |
| 技能迁移命令→技能                                 | ❌（明确不做）                          | ✅ commands 已并入 skills（旧文件兼容）                                                                   | ✅ `/migrate-to-skills`                      |

**读法**：技能"有没有"已经齐了；差的是**打包、依赖、度量、创建器**——也就是"技能从个人技巧变成可分发资产"的最后一公里。

### 2.2 上下文与工具面

| 能力                            | Moss                             | Claude Code                                           | Cursor                                               |
| ------------------------------- | -------------------------------- | ----------------------------------------------------- | ---------------------------------------------------- |
| stable/dynamic 缓存切分         | ✅                               | ✅（`__SYSTEM_PROMPT_STATIC_BREAKPOINT__`）           | 内部实现，不公开                                     |
| 项目指令层级                    | ✅ AGENTS/CLAUDE + 祖先 + 用户级 | ✅ 托管/用户/项目/子目录 + auto memory                | ✅ Rules 4 类 + 用户/团队规则 + AGENTS.md            |
| 路径规则激活                    | ✅ always + globs                | ✅ `.claude/rules` 路径规则                           | ✅ Auto Attached（globs）                            |
| 描述匹配激活（agent-requested） | ❌（只有 globs/task 能力打分）   | ✅（skill description 触发）                          | ✅ Apply Intelligently（按 description）             |
| 手动激活（`@rule`）             | ❌                               | ✅（`@` 引用规则/skill）                              | ✅ Apply Manually                                    |
| 工具面常驻成本                  | ❌ 41,745 chars 全量             | ✅ ToolSearch + MCP lazy                              | ✅ MCP lazy、工具集按模式收敛                        |
| 工具描述分层                    | ❌ 单套 description              | ✅ full/lean 两套 + 负向条件                          | ◐ 内部                                               |
| 压缩摘要结构化                  | ◐ 5 档 + 确定性兜底，无章节契约  | ✅ 结构化摘要 + 压缩后保留规则（context-window 文档） | ✅ 10 节 summary + `# HISTORICAL` 保护（旧研究证据） |
| 每轮附件/系统提醒               | ◐ turn-watch 环境提醒            | ✅ per-turn attachments + `<system_reminder>`         | ✅ system reminder（旧研究证据）                     |
| 检查点                          | ✅ 文件+对话 rewind              | ✅ checkpoints                                        | ✅ checkpoints                                       |
| 图片/PDF 输入                   | ❌（有 wire，无入口/工具）       | ✅ 图片/PDF                                           | ✅ 图片/PDF/图片生成                                 |
| 浏览器                          | ❌                               | ✅ Chrome 集成                                        | ✅ browser 工具/面板                                 |

**读法**：工具面是最大单点成本（10.4k tokens），压缩摘要和"每轮附件"是模型行为质量项；图片输入是 RDK 场景的真实缺口。

### 2.3 MCP / 编排 / 平台

| 能力                               | Moss                                   | Claude Code                                                           | Cursor                                   |
| ---------------------------------- | -------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------- |
| MCP 工具                           | ✅ stdio/http + lazy                   | ✅                                                                    | ✅                                       |
| MCP resources / prompts            | ❌                                     | ✅（`@` 资源、slash prompt）                                          | ✅（资源/提示支持）                      |
| MCP elicitation                    | ❌                                     | ✅                                                                    | ◐                                        |
| MCP OAuth / headersHelper          | ❌                                     | ✅                                                                    | ✅（OAuth 一键）                         |
| MCP channels（服务端推事件进会话） | ❌                                     | ✅                                                                    | ◐（deeplinks/integrations）              |
| 脚编排（workflow 脚本、可恢复）    | ❌                                     | ✅ workflows（script 持计划、pipeline/parallel/phase/schema、resume） | ◐ cloud automations                      |
| agent teams / 共享任务板           | ❌（有 Task OS，但无跨会话 team 协议） | ✅ agent teams                                                        | ✅ agents window / projects              |
| 后台/云执行                        | ◐ 后台 exec/subagent，无云             | ✅ cloud sessions + remote control                                    | ✅ cloud agents（VM/self-hosted/mobile） |
| 定时/自动化                        | ◐ `/goal` 持续，无 cron                | ✅ scheduled tasks                                                    | ✅ automations                           |
| 团队/企业策略                      | ◐ workspace trust + config 分层        | ✅ managed settings/policies                                          | ✅ team rules/enterprise hooks           |

**读法**：MCP 协议面是"能不能接真实生态"的问题；编排/云是"要不要扩大边界"的问题（Moss 冻结了 orchestration，需 owner 决策）。

---

## 3. 方向清单（脑暴，不是全部要做）

每条给：问题 → 参考机制 → Moss 落点 → 验收（真实运行）→ 成本/风险 → 优先级。

### D1 能力包（plugin-lite）：让技能变成可分发资产

- **问题**：Moss 现在能装一个 skill，但一个 RDK 能力（如"X5 部署"）需要 skill + command + subagent +
  hook + MCP server 一起装；用户只能手工复制 5 个目录，无法版本化、无法评估整个包。
- **参考**：Claude plugin = `plugin.json` 清单 + `skills/ agents/ commands/ hooks/ mcp/` 等组件 +
  userConfig + `${CLAUDE_PLUGIN_DATA}`；Cursor plugins 可发布 skill 到团队。
- **落点**：新 `src/core/skills/plugin-manifest.ts` + `moss plugin validate|install|list|remove`；
  `.moss/plugins/<name>/`（或 `.claude/plugins` 兼容）；复用 SK6 的 hash/lock 做来源验证，
  复用 workspace-trust 做信任弹窗；**不做 registry/marketplace**。
- **验收**：一个真包（skill+command+agent+hook+mcp 各一）安装后：`/命令` 可用、subagent 出现、
  hook 在 PreToolUse 触发、MCP 工具被列出；`moss plugin validate` 对坏包返回非零；卸载后全部消失。
- **成本**：中（清单/合并逻辑/信任）；**风险**：与「插件市场冻结」的边界需要 owner 明确。
- **优先级**：P1（若 owner 同意"本地包≠市场"）。

### D2 评估体系升级：从"assert"到"grader + 基线 + CI"

- **问题**：SK7 只有 `expect_contains`，无法判断"技能是否让模型调用了正确工具"、"是否比不用更好"、
  "新模型/新版本是否回归"。
- **参考**：Claude `plugin eval`：每 case 是 prompt + 多个 grader（regex、tool-called、rubric judge），
  与 no-plugin baseline 对比，写 grading.json，CI 可门禁；`plugin eval init` 生成用例。
- **落点**：扩展 `scripts/skill-eval.mjs` → `scripts/agent-eval.mjs`：
  - grader 类型：`contains`（已有）、`regex`、`tool_called`、`rubric`（第二模型判分，需 key）、
    `post_condition`（跑 `check.mjs`/设备探测——**Moss 独有**）；
  - 技能 listing 预算补两个机制：per-entry 上限（1536 chars，超了截断而不是整条丢）与
    **least-invoked-first 排序**（本地计数，`.moss/skills-usage.json`，不上报）；对应 Claude 的
    `skillListingBudgetFraction`/`skillListingMaxDescChars` 两个旋钮；
  - 报告加 token/成本/时长与 delta；`--baseline` 缓存；
  - CI：`moss skill eval --ci` 退出码 + `bench/tasks/skill-*` 回归。
- **验收**：对现有 `skills-install-lock` bench 任务用新 grader 复跑；构造一个"用了 skill 的工具调用
  序列正确"的 case；rubric grader 对开放题给出 pass/fail 且有证据行。
- **成本**：低–中；**风险**：rubric grader 是真实模型调用（成本/波动），默认关闭、CI 只用机械 grader。
- **优先级**：P0（与 D3 一起做，收益可量化）。
- **进展（2026-11-04）**：第一版已落地——`expect_regex` / `expect_tools` / `post_condition`（+ contains）
  四类 grader，`skill-eval.mjs` 改走 `--output-format stream-json` 同时取工具调用与最终答案；
  真实 `/tmp/eval-demo` 运行 1/1 PASS（四 grader 全过）。rubric judge（第二模型判分）与 `--baseline`
  缓存仍待做。

### D3 工具面瘦身：lean 描述、去重、砍掉可疑工具

- **问题（修正后的准确版）**：注册表 46 工具 41,745 chars 是上界，真实可见面 chat ≈5.8k tokens、
  coding ≈7.2k、device ≈8.6k。设备/任务工具已被配置门控，所以剩下的不是"藏"，而是：
  ① 单工具描述偏长（`search_code` 1,969、`exec` 1,889、`edit_file` 1,511 chars）；
  ② 功能重叠（`apply_patch` vs `edit_file` vs `multi_edit`；`todo_write` 是否值得占用上下文——
  Claude 已对新模型默认关闭 todo 工具，理由正是"定义与提醒占上下文"）；
  ③ 首次请求里工具之外的大块（系统提示/AGENTS.md/技能 catalog）没有被逐项测过。
- **参考**：Claude 的 full/lean 两套描述 + 工具搜索；todo 工具被默认移除的公开理由。
- **落点**：
  1. 先加 `/context` 级测量（工具 vs 系统提示 vs catalog vs 对话），**用数据决定**下一步，而不是拍脑袋；
  2. lean 描述：schema 里留 ≤120 chars 的一句话 + 一行"何时不要用"，长用法进 `tool_search`/`help`；
  3. 合并/删除实验：`apply_patch` 与 `edit_file` 二选一（用 bench A/B 决定），`todo_write` 做开关
     （默认关的实验分支），`multi_edit` 若已被 edit_file 覆盖则隐藏；
  4. 对已揭示组做"按环境预揭示"仅当出现新的条件组，不重复设备/任务已经做过的门控。
- **验收**：`bench/tasks` 成功率 A/B 不降；工具 schema chars 降 20%+；首请求总 tokens 有前后对比数字；
  删/合并的工具在旧 transcript 里仍可解析（兼容）。
- **成本**：中；**风险**：lean 描述可能让模型误用工具，必须 bench 对照；删工具是 semver 级变更（SDK 导出面）。
- **优先级**：P1（从 P0 降级；先测后改）。

### D4 MCP 协议补全：resources / prompts / elicitation / OAuth

- **问题**：Moss 的 MCP 只有 tools。真实 MCP server（含 RDK 生态）常带 resources（手册/文件）、
  prompts（模板）、elicitation（运行中问用户）；OAuth 让远程 server 可用。
- **参考**：Claude MCP 全协议 + channels；Cursor MCP OAuth/lazy。
- **落点**：`src/core/mcp/` 增加 resources list/read（`@resource` 附件）、prompts → slash 命令、
  elicitation → 复用 `ask_user_question` 的桥、OAuth PKCE + token 存储（凭据仍只在 config/env）。
- **验收**：本地 mock stdio server（新 fixture，不联网）完成 resources/read、prompt/list、elicitation
  round-trip；真实 rdk-docs server 的 resources 列表可见；`moss mcp test` 覆盖新能力。
- 顺带对齐：per-tool `alwaysLoad`/`defer` 标记（现在只有全局懒加载）、MCP 描述长度上限
  （Claude：upfront 4,096 / tool-search 16,384 chars），否则大 server 会把搜索预算吃光。
- **成本**：中；**风险**：elicitation 与审批语义重叠，要定"谁来问"。
- **优先级**：P0–P1（协议完整性直接影响生态接入）。

- **进展（2026-11-05）**：resources / prompts 已完成并**可回归证明**——`mcp_resource`（无参列出、
  带 `uri` 读取）与 `mcp_prompt`（无参列出、带 `name`+`arguments` 展开）已是模型可调用工具；
  `moss mcp test <name>` 现在同时报告 tools / resources / prompts 三个协议面；新增 verify stage
  `mcp-protocol`（`scripts/verify/mcp-protocol.mjs` + `scripts/verify/fixtures/mcp-mock-server.mjs`，
  **6 条断言**）：真实 `McpClient` 对本地 mock stdio server 完成 `tools/list`、`resources/list`+
  `resources/read`、`prompts/list`+`prompts/get`（含参数）、未知 URI 报协议错误、连接在
  method-not-found 时仍存活，且 `moss mcp test` 的三种清单都出现。描述长度上限（默认 1,024 字符截断）
  与 `alwaysLoadTools` 已有。**未做（本轮明确不做）**：elicitation（MCP 要求客户端声明
  `elicitation` capability 并在运行中弹表单，与 Moss 现有审批语义重叠，且需要 TUI 表单面；
  不声明 capability，避免 server 发出无法应答的请求）、OAuth（凭据仍只走 env/config header）。
  这两项保持为待做方向，不计入"已落地"。

  真实 server 实测（2026-11-05，`moss mcp test rdk-docs`）：连接成功、**6 个工具**、
  **0 resources / 0 prompts**——rdk-docs 目前只发布工具，所以"真实 resources 列表可见"以
  mock server 的协议级证据为准，rdk-docs 侧诚实记为"server 未发布资源"。

### D5 编排：workflow 脚本 / agent teams（需要解冻）

- **问题**：Moss 有 `fan_out_subagents` 和 Task OS，但"计划"仍由模型逐轮决定；大规模任务（几百文件
  审计、跨机部署）无法把编排固化成可重跑、可恢复的脚本。
- **参考**：Claude workflows（`agent/pipeline/parallel/phase`、schema 输出、resume、对抗式复核）；
  agent teams（共享任务板 + 跨会话消息）。
- **落点**：两条路径——
  - 轻量：**声明式编排**（YAML/JSON 计划 + 现有 subagent runner），不引入 JS 沙箱；
  - 完整：脚本式 workflow（需 owner 解冻 orchestration，且要沙箱化脚本执行）。
    Task OS 的任务板可复用为 team 共享状态。另一个独立小项：**子代理 resume/只读/嵌套上限**
    （Cursor 按 agent ID 恢复、`readonly` 禁写、嵌套 ≤2 层），可在不动 orchestration 的前提下单独做。
- **验收**：一个 20 文件迁移任务用声明式计划跑完并可 resume；caps/budget 生效；失败 item 隔离。
- **成本**：高；**风险**：与「orchestration 冻结」冲突，需 owner 决策。
- **优先级**：P1（决策后）/P2（不决策）。

### D6 记忆写路径（需要解冻）：显式 `/remember` 优先

- **问题**：参考产品都在补"写"：Claude auto memory（200 行/25KB 自动加载）、Cursor Memories；
  Moss 只有读路径，用户每次都要手改 AGENTS.md。
- **参考**：Claude auto memory + `.claude/rules`；subagent 也有自己的 memory。
- **落点（最小可行）**：`/remember <事实>` 显式写入（工作区 `AGENTS.md` 或 `.moss/memory/<topic>.md`，
  带 diff 确认 + 去重 + 过期）；不做自动写入。自动记忆只作为可选实验（需 owner 解冻）。
- **验收**：跨会话真实运行：第一次纠正 → `/remember` → 新会话不再犯；写入内容可审查、可撤销。
- **成本**：低（显式版）；**风险**：memory 冻结红线。
- **优先级**：P2（需 owner 决策）。

**进度（2026-11-05，D6 可实施部分已落地）**

- ✅ 显式写路径 `/remember <fact>` / `moss remember "<fact>" [--dry-run]`：写入工作区
  `AGENTS.md`（Moss 本就作为项目指令自动加载，新会话直接可见），**先预览 diff、默认不写**
  （TTY 下 `/remember` 需 y 确认），按空白/大小写去重，单条上限 500 字符，写入前校验文件未被并发改动；
  撤销 = 删掉那一行。
- 验收：真实跨会话——`moss remember "Device bench: run npm run bench:device -- --target sim"`
  后**新起一个 `-p` 会话**问"device bench 怎么跑"，回答直接给出 `npm run bench:device -- --target sim`；
  确定性探针 `remember`（6 条：dry-run 不写、真写建小节、去重、空内容/超长 exit 2、标题只出现一次）。
- ⬜ 未做（刻意）：自动记忆、记忆过期/蒸馏、subagent 独立记忆——仍受"不做自动写入"的边界约束；
  TUI 只显示预览并提示用 `moss remember` 落盘（全屏壳不直接写文件）。

### D7 多模态输入（RDK 场景差异化）

- **问题**：机器人现场最常见的输入是**接线照片、板卡丝印、报错截图、示波器/串口截图**；Moss 现在
  只能读文本，模型看不到。SDK/契约其实已有 image block。
- **参考**：Cursor 图片生成/PDF/browser；Claude 图片/PDF。
- **落点**：TUI/REPL 附件入口（拖拽/粘贴路径）→ image block 透传；`read_image` 工具让模型主动看文件；
  provider 视觉能力矩阵（qwen-vl 等）；可选：`device_screenshot`（SSH + 图像块）。
- **验收**：真实模型跑"看这张接线图说明引脚对应关系"；设备截图闭环；token/成本提示。
- **成本**：中；**风险**：provider 视觉能力参差，需要 model capability guard（不能用不支持图片的模型）。
- **优先级**：P1（若 RDK 产品线要"现场调试"，这是差异化）。

### D8 代码智能（LSP / diagnostics）

- **问题**：Moss 的"看代码"靠 search/exec；参考产品有 code intelligence（Claude 有 LSP plugin，
  Cursor 原生）。对大仓库重构，诊断信息能显著减少来回。
- **参考**：Claude code-intelligence plugins（LSP）。
- **落点**：先做**聚合 diagnostics 工具**（tsc/eslint/pytest 输出归一化），再评估 LSP client；
  避免把 Moss 做成 IDE。
- **验收**：一个"修类型错误"bench 任务：有 diagnostics 与没有的 A/B（turn 数与 token）。
- **成本**：中；**风险**：LSP 生命周期复杂；**优先级**：P2。

### D9 规则 4 类 + 团队/策略层

- **问题**：Moss 只有 always + globs；缺"按 description 智能激活"和"手动 `@rule`"；
  缺用户/团队/托管策略的分层（企业会把规则和 allowlist 统一管理）。
- **参考**：Cursor Rules 4 类 + Team rules；Claude managed settings/policies。
- **落点**：`src/cli/project-instructions.ts` 增加 `activation: always|globs|description|manual`；
  复用 capability registry 的打分做 description 激活；`@rule` mention 进 attachments；
  用户级 `~/.config/moss/rules`（已有 user rules 目录）+ 只读 managed 文件（`MOSS_MANAGED_*`）。
- **验收**：三条规则分别按 always/globs/description 注入，未命中不注入（token 差可测）；
  `@rule` 只在提及时注入。
- **成本**：低–中；**风险**：description 激活增加不确定性，需确定性回退。
- **优先级**：P1。

### D10 产品化小件（让能力被发现）

- **问题**：能力做了但用户不知道：catalog 有预算、eval 有报告、install 有 lock，但 `/skills` 只列名字。
- **落点**：`/skills` 增加 cost/状态（evals、issues、last install、scope）；`/create-skill` 内置技能
  （脚手架 + eval init）；statusline 增加 skills/cost 段；本地 usage 计数（不上报）。
- **验收**：真实会话里 `/skills` 显示每个技能的字符/加载次数；创建→评估→安装一条龙。
- **成本**：低；**优先级**：P1（配合 D2）。

### D11 技能运行语义 v2：从"读到一段正文"到"按技能改变运行"

**进度（2026-11-04，D11 第一片）**

- ✅ 技能级 **turn/run 作用域工具限制**：`allowed-tools` / `disallowed-tools` 不再是"只声明不生效"——
  加载该技能后，本次 run 的后续工具列表被收窄（allowed 为空表示不限制；disallowed 永远隐藏；
  多次激活只会取交集，不会放宽）；限制只收窄**可见性**，审批照常执行，绝不自动放行。
- 验收：临时工作区技能 `allowed-tools: [read_file, skill]` + `disallowed-tools: [exec]`，真实 `-p` 会话：
  加载技能后 `write_file` 不可用 → 模型回 `WRITE-BLOCKED` 且文件未创建；对照组（不加载技能、同一提示）
  `write_file` 正常创建文件。
- ⬜ 仍缺：`context: fork`（子代理隔离执行）、技能级 `model`/`effort` 覆盖、`when_to_use` /
  `arguments` 的目录级展示与替换。

- **问题**：Moss 加载技能只是把正文塞进工具结果；参考产品已经让技能**改变运行本身**：
  Claude 的 `context: fork`（技能作为隔离子代理跑）、`agent`/`background`、`allowed-tools`/
  `disallowed-tools`（仅本次调用预批准/移除工具）、`model`/`effort` 覆盖、技能自身 `hooks`、
  `paths`（文件级自动激活）、`when_to_use`/`arguments`；Cursor 有 `paths`、`disable-model-invocation`、
  skill 与 mode 的二象性。
- **落点**：`src/contracts/skill.ts` 增加可选字段；`skill` 工具执行时把"本次调用的策略"交给
  agent loop（turn-scoped tool allow/deny、model/effort override、可选 fork 到 subagent）；
  与 SK6 的"声明不自动批准"边界一致：`allowed-tools` 只预批准**本次调用**，不改变全局审批。
- **验收**：一个技能声明 `disallowed-tools: [exec]` → 加载后本轮 exec 被拒且有可读理由；
  一个 `context: fork` 技能在子代理里跑完并把结果带回；`model` 覆盖只影响本轮（usage 里可见模型切换）。
- **成本**：中（碰 agent loop 的策略面）；**风险**：与审批/权限语义交叉，需要明确"技能不能提权"。
- **优先级**：P1（与 D9 一起做，是"技能"这条线真正的深水区）。

### D12 Hooks 契约对齐（低成本、高杠杆）

- **问题（先核实现状，避免修不存在的洞）**：Moss 已有 `additional_context`、hook 输出 overflow
  （`output_too_large`）、Claude 格式兼容（`format:'claude'` 时 exit 2 阻塞、其余非阻塞）与原生
  非零即阻塞的语义。真正缺的是：
  ① PreToolUse 的 **`updatedInput` 整对象替换**（Moss 没有；参考产品用它让 hook 改写工具输入，
  且改写后的输入重新走权限判断）；
  ② 多 hook 的**决策优先级**与 `defer` 语义没有显式契约/探测（Moss 有审批队列，但没有 "defer 到下一轮"）；
  ③ 事件面 11 vs Claude 37 / Cursor 18，缺 `SubagentStart`、`PermissionDenied`、`FileChanged`、
  `WorktreeCreate/Remove`、`PostToolUseFailure`；
  ④ 原生"非零即阻塞"与 Claude"仅 2 阻塞"的差异**是刻意兼容选择**，必须写进文档 + probe，而不是悄悄改语义。
- **参考**：Claude hooks 的 per-event block table + 退出码矩阵 + `updatedInput` 替换；Cursor 的
  `matcher`/`failClosed`/`loop_limit(5)`/`additional_context`。
- **落点**：`src/cli/hooks.ts`：
  1. PreToolUse 支持 `updatedInput`（整对象替换，随后按替换后的输入重新过 `toolVisibleForRun` 与审批）；
  2. 决策优先级与原生/`claude` 格式的 exit-code 矩阵写成显式表 + probe；
  3. 补 `PermissionDenied`（审批拒绝后可观测/可审计）与 `SubagentStart`；其余事件按需求再加；
  4. 可选：`failClosed`（spawn 失败/超时是否阻塞）作为配置项，默认保持现状。
- **验收**：probe 覆盖 exit-1 原生阻塞 / `claude` 格式非阻塞 / exit-2 阻塞、`updatedInput` 替换后
  审批按新输入判断、`PermissionDenied` 可观测；真实会话中一个"改 exec 参数"的 hook 生效且不绕过 deny 规则。
- **成本**：低；**风险**：改语义会影响现有 hook 用户，需要新增配置开关或严格向后兼容。
- **优先级**：P1（与 D5/D11 相比，这是"确定性控制层"最便宜的质量提升）。

- **进展（2026-11-05）**：①②③④ 全部落地并钉住——① `updatedInput` 整对象替换后**重新过审批**
  （`src/cli/hook-ask.ts`：hook 只能收紧/改写输入，不能绕过 deny）；② deny > ask > allow 的优先级
  与 exit-code 矩阵有显式 probe（`hooks-contract`，16 条断言）；③ 事件面已含 `PermissionDenied`、
  `SubagentStart`/`SubagentStop`、`PreCompact`/`PostCompact`、`Stop`、`SessionStart/End`、`Notification`；
  ④ 原生"非零即阻塞"与 `format:"claude"`"仅 exit 2 阻塞"的刻意差异写进 [`docs/hooks.md`](../hooks.md)
  并各有 probe；`Stop` 另做成用户可安装完成门（`docs/hooks/stop-verified-completion.mjs`，真实
  exit 9 / exit 0 对照）。`failClosed` 已作为默认行为（spawn 失败/超时 = 阻塞），不新增开关。

**进度（2026-11-04）**

- ✅ `updatedInput`：PreToolUse hook 可整对象改写工具输入（moss 原生与 Claude 兼容两种形态），
  改写后用新输入重跑策略检查（不能绕过 deny），执行边界再校验 schema。真实 CLI 运行验证
  （hook 把 `write_file{path:original.txt}` 改成 `rewritten.txt`，落地文件内容来自 hook）。
- ✅ `SubagentStart` 事件：spawn 子代理前触发，payload `{event, goal}`；真实运行验证
  （`create_subagent` 前 hook 收到 goal，子代理返回 4）。
- ✅ `PermissionDenied` 事件：工具被拒（策略/hook/用户）后触发，payload `{event, toolName, reason}`；
  真实运行验证（deny 规则拦 `write_file`，hook 收到 reason 原文），fire-and-forget 不阻塞拒绝。
- ✅ 契约探针已进交付门：`scripts/verify/hooks-contract.mjs` + `scripts/verify/stages/hooks-contract.mjs`
  （fast gate 新增 `hooks-contract` stage，11 条断言：原生 exit 0/1/2、`claude` 格式 exit 1/2、
  `blocking:false`、显式 deny、ask 暴露、deny>ask、`updatedInput` 整对象替换、`blocking:false` 不能改写）。
  实测 `npm run verify` 19.0s（预算 60s）。探针纠正了一处文档错误：PreToolUse 在 **两种格式**下都对
  非零退出阻塞（刻意比 Claude 严格，仅非 PreToolUse 事件才按 `claude` 格式只认 exit 2）。
- ⬜ 仅剩可选 `failClosed`（spawn 失败/超时的可配置策略；当前默认已 fail-closed）。

**进度（2026-11-04，D4 第一片）**

- ✅ MCP **resources**：客户端新增 `resources/list`（分页 + 会话缓存 + "method not found → 空列表"降级）与
  `resources/read`；每个已连接服务器自动注册 `mcp__<server>__resources` 元工具（无 uri 列资源、
  有 uri 读内容，readonly 免审批）。
- 验收：本地 mock stdio MCP server（`initialize`/`tools/list`/`resources/list`/`resources/read`）+ 真实
  `-p` 会话，模型列资源后按 `mock://hello` 读回 **`RESOURCE-CONTENT-42`**（exact content）。
- ✅ per-tool `alwaysLoadTools` / `deferTools`（mcp.json 字段，支持精确名与 `prefix*`）：
  alwaysLoad 在连接时直接注册成真实工具（不花一次 search）；defer 从能力发现 catalog 排除
  （仍可手动 search）。工具描述统一截断到 **4,096 字符**。
- 验收：mock server 三个工具（`echo` / 5,000 字符描述 `bigdesc` / `deferred_one`）+
  registry 探针（alwaysLoad 注册、defer 不在 catalog、描述恰好 4,096）+ 真实 `-p` 会话
  （不 search 直接调 `mcp__mock__echo` → `ECHO:hi`）。
- ✅ MCP **prompts**：客户端新增 `prompts/list`（分页 + 缓存 + method-not-found → 空）与
  `prompts/get`；每个已连接服务器注册 `mcp__<server>__prompts` 元工具（无 name 列模板、有 name
  按字符串参数展开，返回 role + 文本块）。
- 验收：mock server（`greet{topic}` 模板）+ 真实 `-p` 会话，模型列出后展开 `greet{topic:robots}`
  → 精确得到 `Write a haiku about robots`。
- ⬜ 仍缺：prompts 映射成 `/` 斜杠命令（当前走元工具）、elicitation、OAuth、
  resources 订阅 / `@uri` 直接引用。

### 可选/低优先（列入但不推荐立刻做）

- D13 定时/循环任务（`/loop`、cron）：参考有 scheduled tasks；Moss `/goal` 已覆盖大部分，先观察。
- D14 环境隔离（OS sandbox）：`docs/design/os-sandbox.md` 已有设计；默认关闭，可作为 enterprise 选项。
  参考产品的关键不是"要不要 sandbox"，而是**把 sandbox 当成与 permissions 分离的边界**
  （reads-loose / writes-tight / net-via-proxy；sandboxed bash 可 auto-allow 而不看 permission mode）。
- D15 输出样式/主题/语音/blame/artifacts/浏览器自动化：与产品目标无关，抄了丢重心。

（Cursor 研究里还有两条值得记住但不急的机制：subagent 可按 agent ID 恢复；hooks 有 `failClosed`
和约 5 次的循环上限——后者可对照 Moss 的 hook 阻塞语义做一次对齐审计。）

---

## 4. 分歧与反方观点（脑暴必须有的部分）

1. **"能力包是不是过度设计？"** 反方：Moss 用户是 RDK 开发者，技能 git clone 就够；正方：RDK 能力包
   天然是"技能+设备任务+MCP+命令"的组合，缺包=每次手工拼装、无法评估、无法升级。**折中**：先做
   D2（评估）与 D10（可见性），用一个真实 RDK 包验证需求，再决定 D1 的投入。
2. **"工具面收敛会不会让模型变笨？"** 反方：隐藏工具会让模型不知道能力存在；正方：参考产品都在收敛，
   且 reveal 是显式一步。**折中**：先做"按环境预揭示"（device 环境存在才揭示 device 组），
   并用 bench A/B 决定是否进一步 lean。
3. **"记忆写路径该不该解冻？"** 反方：自动记忆会污染 AGENTS.md、不可审查；正方：显式 `/remember`
   是低成本高收益。**折中**：只做显式写入 + diff 确认 + 过期，不做自动。
4. **"多模态 vs workflow 谁先？"** 若产品目标是"机器人现场调试"，D7 优先；若目标是"通用 coding
   harness 质量"，D5 优先。需要 owner 定产品优先级（见 §6）。

---

## 5. 建议路线（如果只做三件事）

**波 A（P0，1–2 天，不动冻结线）**

1. D4 MCP resources/prompts/elicitation（先 mock server 验证，OAuth 单独一档）
2. D2 grader 升级（tool-called/regex/post_condition + 报告 delta）
3. D12 hooks 契约对齐（exit-code 矩阵、updatedInput、输出 cap）

**波 B（P1，需求确认后）**

4. D3 工具面瘦身（先 `/context` 测量，再 lean 描述/去重/实验）
5. D10 技能可见性 + D9 规则 4 类
6. D11 技能运行语义 v2（fork/tool-scope/model/hooks）
7. D7 多模态（若 RDK 现场调试是产品重点）
8. D1 能力包（本地包，无托管市场）

**波 C（需 owner 解冻 / 产品决策）**

7. D5 编排（workflow/teams）、D6 记忆写路径、D12 OS sandbox、D8 LSP

---

## 5.1 Owner 决策记录（2026-11-04）

用户原话："我觉得都可以做，没有不能做的。" 据此落定：

| 问题                               | 决策                                                          | 影响                                          |
| ---------------------------------- | ------------------------------------------------------------- | --------------------------------------------- |
| 下一波走哪条线                     | 全部方向都可以做，按 P0→P1→P2 推进                            | §5 的三波变成**执行队列**，不再等确认         |
| D1 本地能力包                      | 允许（本地安装/信任/版本；**不做托管 marketplace/registry**） | D1 可实施；插件市场冻结针对托管侧             |
| 解冻 orchestration / memory 写路径 | **解冻**                                                      | D5/D6 可实施；仍需在 AGENTS.md 记录范围与验收 |
| 多模态 D7                          | 进产品路线                                                    | 附件 + `read_image` + 设备截图可做            |

## 6. 需要 owner 拍的四个问题（已由 5.1 回答，保留作记录）

1. **下一波选哪条线？** 我建议波 A（D3+D4+D2）；如果你更关心"技能生态"，则 D1+D2+D10。
2. **是否解冻 `orchestration`（D5）？** 解冻后可以做声明式/脚本式编排；不解冻则只做单会话子代理。
3. **是否允许"本地插件包"（D1）？** 本地包 ≠ 托管市场；需要你确认这不算越过「插件市场冻结」。
4. **多模态（D7）是否进 RDK 产品路线？** 若现场调试是重点，它比 workflow 更值得先做。

---

## 7. 附：参考链接与本地证据

**Claude Code（2026 现行文档）**

- 扩展机制总览：https://code.claude.com/docs/en/features-overview
- Skills（含 commands 并入、invocation 控制、subagent 执行、evals/skill-creator）：https://code.claude.com/docs/en/skills
- Plugins 组件：https://code.claude.com/docs/en/plugins/components
- Plugin evals（grader/baseline/CI）：https://code.claude.com/docs/en/plugin-evals
- Memory（CLAUDE.md/rules/auto memory）：https://code.claude.com/docs/en/memory
- Dynamic workflows：https://code.claude.com/docs/en/workflows
- MCP：https://code.claude.com/docs/en/mcp

**Cursor（2026 现行文档）**

- Rules（4 类 + 团队规则 + AGENTS.md）：https://cursor.com/docs/rules
- Agent Skills（目录/兼容/云限制）：https://cursor.com/docs/skills
- Subagents（`.cursor/agents`、Claude/Codex 兼容）：https://cursor.com/docs/subagents
- Hooks（`.cursor/hooks.json`、Claude 兼容、云支持矩阵）：https://cursor.com/docs/hooks
- 2.4 changelog（subagents/skills/图片生成）：https://cursor.com/changelog/2-4

**本轮新增研究笔记**

- [`docs/research/2026-11-04-next-capabilities/claude-code.md`](../research/2026-11-04-next-capabilities/claude-code.md)：
  Claude Code 能力清单（1,496 行，逐条给机制与官方链接；含 skills frontmatter 全表、hooks 事件/退出码、
  plugin 组件、plugin eval grader、workflow/team、MCP、记忆与压缩）。
- [`docs/research/2026-11-04-next-capabilities/cursor.md`](../research/2026-11-04-next-capabilities/cursor.md)：
  Cursor 能力清单（409 行；rules 真值表、skills 目录/嵌套 scoping、hooks 支持矩阵、MCP 文件型 catalog
  −46.9% tokens、subagent 可恢复、worktree-per-agent）。

**本地实测**

- 工具 schema：46 个注册工具、41,745 chars（`dist/tools/builtin.js` 实测）；`device_*` 11,445、
  `task_*`/`record_*` 5,671、`subagent*` 5,218。
- 技能 catalog：22 个技能、4,199 chars、`strategy=full`；symlink 修复后 19/19 用户技能可见。
- 现有实现：`src/core/skills/`、`src/cli/hooks.ts`、`src/core/subagent/`、`src/core/mcp/`、
  `src/cli/project-instructions.ts`、`docs/design/os-sandbox.md`。
- 本轮已修：`614db704` fix(skills): follow symlinked skill folders during discovery。
