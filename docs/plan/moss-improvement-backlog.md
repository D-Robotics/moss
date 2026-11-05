# Moss 改进 backlog：对照 Cursor / Claude Code 的「对手已发布、Moss 尚缺」

- 日期：2026-11-05（写作基线 HEAD `7cc26447`；写作期间 A1/A2 连续落地，见 §1）｜负责人：由每轮执行者认领
- 定位：**可持续使用的优先级队列**。只收「参考产品已发布、Moss 当前缺失或明显弱于对手」的点，
  每条都要能用一个命令/场景判定做完没做完；不做「感觉更好」的条目。
- 输入：`docs/research/2026-11-04-cursor-claude-agent-design/`（含 Cursor 3.27 / Claude Code 2.1.317
  逆向证据）、`docs/research/2026-11-04-next-capabilities/{cursor,claude-code}.md`、
  `docs/research/2026-11-05-cursor-acceptance-loop.md`、`docs/specs/2026-11-05-moss-acceptance-loop.md`、
  `docs/research/2026-11-05-ux-handfeel.md`、`docs/specs/2026-11-04-moss-next-capabilities-brainstorm.md`、
  `docs/tui-ux-audit-2026-10-01.md`、`docs/superpowers/plans/2026-10-08-tui-cc-parity-v3.md`、
  `git log --oneline -40`，以及逐条抽样核对的真实源码（抽样清单见 §5）。
- **不写入范围**（`AGENTS.md` 冻结线）：memory 自动写入、mesh、observability、orchestration 托管、
  web-ui、插件市场/托管 registry。凡是需要它们才能成立的条目，本文件不列。

## 0. 使用规则

**优先级**

| 级别 | 判定标准                                                                  |
| ---- | ------------------------------------------------------------------------- |
| P0   | 用户可感知的功能缺口或有真实错误风险，且**当前文档/提示已在承诺却做不到** |
| P1   | 对手已发布且可直接量化收益（省轮次/省 token/少误判），切片成本 ≤ 半天     |
| P2   | 收益明确但需要先测量或依赖其它条目收口，切片成本 ≤ 1 小时                 |

**状态机**：`待做` → `进行中`（写 owner 与分支/worktree）→ `已验收`（探针已进 `scripts/verify/stages/`
或 `bench/tasks/`，并贴出实测输出）→ `已放弃`（写清原因与推翻证据）。**没有落探针的条目不算已验收**
（`AGENTS.md`：仓库不恢复 spec 套件，回归靠 verify stage / 可执行探测 / bench 任务）。

**探针约定**：`node -e` 类探针以 `npm run build` 产出 `dist/` 为前置（本文不要求你构建）；
「现状」一列写的是**按当前代码应当得到的结果**——先跑一次确认它确实如所述，再动手改。若现状与描述不符，
先更新本文件（证据优先于条目）。

**探针约定（补充）**：任何「子进程访问本地 stub」的验证，stub 必须跑在**不会被驱动器阻塞**的地方
（独立进程或线程）；禁止在托管 stub 的进程里用 `execFileSync` / 同步等待跑 PTY 驱动——那样得到的「0 请求」
是探针噪声，不是产品行为（H8 的教训，2026-11-05）。

**新增条目模板**：`ID | 优先级 | 改进点 | 现状证据(文件:行) | 参考实现 | 验收探针 | 状态` 一行 + §3 里
2–4 行说明（为什么现在、最小切片、风险）。一个条目只解决一个可独立验收的切片。

## 1. 进行中（本轮不入 backlog，避免重复劳动）

| ID  | 内容                                                                                          | 现状（可核对）                                                                                                                                                                                                                                                                     |
| --- | --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| A1  | L1 完成门：改过文件的 run 在终稿前必须自检；review 返回 FAIL 且终稿未认领也不放行             | 已落地 `f7e2f512`（自检门）+ `7cc26447`（review FAIL 必须被认领）：`src/core/loop/verification-completion-gate.ts`、探针 `scripts/verify/verification-gate.mjs`、stage `scripts/verify/stages/verification-gate.mjs`                                                               |
| A2  | P1-a `/review` 接独立 reviewer + 结构化 findings（`.moss/review.jsonl`）+ 有变更 run 自动触发 | 已落地：reviewer 专家 `38f5d222`、review-FAIL 认领 `7cc26447`、管线 `e9542689`（`review_changes` 工具 + `/review` 同管线 + `.moss/review.jsonl` + verify stage `review-pipeline` 14 断言）；**仍缺**：有变更 run 结束后的自动触发（`review.mode` 配置）与 L3 修复循环消费 findings |
| A3  | P2-a `moss loop --until <command>`（本地 CI 式闭环）                                          | **已落地且已验证**：`cli/loop-command.ts` + `command-dispatcher.ts:333` 动态加载；`moss loop --help` 打印用法；verify stage `loop-command` 实跑                                                                                                                                    | 见 §2 表 B 行与 verify 日志 |
| A4  | P0-b L1 逃生阀 `verificationGate` + `/config` 可见                                            | **已落地**：`core/agent/moss-agent.ts:1722-1752` 构造 `createVerificationCompletionGate`，`config.verificationGate===false` 关闭；`cli/config-commands.ts:88-89` 暴露值与来源                                                                                                      | —                           |
| A5  | P1-b L3 有界修复循环（上限 3，写 `.moss/task-repairs.jsonl`）                                 | **已落地**：`core/task/task-engine.ts:80` `DEFAULT_MAX_REPAIR_ATTEMPTS`、`:343` 超限拒绝、`:359-375` repairing 阶段；`core/task/task-store.ts:50` 写 `task-repairs.jsonl`（上限实测 5，可配）                                                                                      | —                           |

> 判断：A2/A3 确实是本轮最高优先级的两项，因此按任务约定不重复列为 backlog 条目。

## 2. backlog 总表

| ID  | 优先级                    | 改进点                                                                                          | 现状证据(文件:行)                                                                                                                                                                                                                                                                                                                                        | 参考实现（Cursor / Claude 的行为）                                                                                                                                                                                                        | 验收探针                                                                                                                                                                                                                                                                                                                                                                                                                                           | 状态                                                                                                                                                    |
| --- | ------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| B01 | P0                        | 图片/附件进不了上下文，但帮助与提示词都在承诺                                                   | **已完成（2026-11-05，两片）**：`cli/image-mentions.ts` 扫描消息里的图片提及；能在视觉模型上**直接以 `ChatOptions.attachments` 附 base64 图片块**（首轮就能看到像素），不能附时（`agent.supportsImages=false` / 非真实图片 / >3MB）退化为 `<attachments>` 描述 + `read_image` 指引；`runOneShot` 一处接线，`-p`/REPL/TUI 同时生效                        | 已实跑两种模型声明下抓请求体（见本节末）                                                                                                                                                                                                  | **已验收**                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| B02 | P0                        | 压缩后旧历史不可回溯，模型无法回查被丢弃的证据                                                  | `src/context/compaction-prompts.ts:27-76`（9 节模板，无「历史段落盘/回查」约定）、`src/context/compaction.ts:1125-1144`（摘要后只补文件清单/todo/task 锚 + 恢复 5 个文件）、`src/core/session/jsonl-session-store.ts:267`（被丢弃的原文其实在 `.moss/sessions`，但没有指针）                                                                             | Cursor 把旧段写成 `# HISTORICAL -- DO NOT EDIT` + 「Use read_file or grep to look up details, but do not modify.」（`cursor-evidence.md:478-527`，`lar:63784-64057`）；Claude Code 把压缩状态做成一等数据（`claude-evidence.md:273-287`） | `node -e`：`dist/context/compaction.js` 的 `buildCompactionSummary({ summarize: async () => '<summary>x</summary>', messages: [20 条伪造历史], contextWindowTokens: 128000 })` → 断言返回值含 `.moss/sessions/` 与 `HISTORICAL`；当前两项都为假（探针必须先在旧代码上 fail）                                                                                                                                                                       | 已落地                                                                                                                                                  |
| B03 | P1                        | 摘要产物的 9 节结构只是提示词自律，没有机器校验/收紧重试                                        | `src/context/compaction.ts:1061-1079`（"Validate summary" 只判非空与一个固定字符串）、`src/context/compaction.ts:131`（唯一的硬约束是 4096 token 上限）                                                                                                                                                                                                  | Cursor 摘要最多重试 3 次、逐次 `requestShorterOutput` 收紧，失败回退确定性裁剪（`cursor-evidence.md:483-486`，`lar:67205/67235`）；Claude Code 摘要 prompt 固定九段并 `capped` 限 2000 词（`claude-evidence.md:281-287`）                 | 新增 `scripts/verify/compaction-summary.mjs`：用 `buildCompactionSummary` + 返回「缺 `## 6.` 节」的 stub summarize → 现在被直接接受（探针 fail），改后必须判 invalid 并触发一次收紧重试；再喂合规摘要必须一次通过。`node scripts/verify/cli.mjs --stage compaction-summary`                                                                                                                                                                        | 已落地                                                                                                                                                  |
| B04 | P1                        | plan 模式没有结束协议：headless / REPL 既没引导 `exit_plan` 也没有批准门                        | `src/contracts/prompts/plan-mode-prompt.ts:13-31`（全文不提 `exit_plan`，不要求以提交计划结束）、`src/tools/plan-gate.ts:23-38`（工具存在且带版本指纹）、`src/cli/tui/app.ts:1353-1367`（批准仪式只在 TUI 里补）                                                                                                                                         | Claude Code plan 模式要求本轮以 `ExitPlanMode`/提问结束，而不是散文「这样可以吗」（`docs/research/2026-11-04-next-capabilities/claude-code.md` §7.4）；Cursor plan guardrails + 每轮 `planSystemReminder`（`cursor-evidence.md:142-149`） | `node dist/cli.js --plan -p "plan adding a --json flag; do not edit" --output-format stream-json \| grep -c '"name":"exit_plan"'` 现在为 `0`；改后 ≥1（或末轮为 `ask_user_question`）                                                                                                                                                                                                                                                              | 已落地                                                                                                                                                  |
| B05 | P1                        | 工具面按需揭示只有 `subagent` 一组；task 台账 6 工具常驻 5,671 chars                            | `src/core/tools/deferred-tool-offer.ts:17-21`（`DEFERRED_GROUPS` 只有 subagent）、`:40-47`（揭示 sticky 永不回收）、`src/core/agent/session-tool-offer.ts:8,19-26,99`（`taskFlow` 不传 → 台账可见，`moss -p` 与交互式都不传）；实测 `moss-architecture-audit.md:126,188`                                                                                 | Claude Code `ToolSearch` + 每工具 `alwaysLoad`/`defer` + 描述预算（`claude-code.md` §9.2）；Cursor MCP 文件型 catalog −46.9% tokens（`cursor.md` §4.3.8）                                                                                 | `node -e`：`dist/core/agent/session-tool-offer.js` 的 `toolVisibleForRun` + `dist/tools/builtin.js` 的 `builtinTools`，在 `taskFlow` 未设时统计可见工具 schema 字符数（当前为 28,733 量级，见 `moss-architecture-audit.md:188`）；改后「无 task 意图的 coding 会话」必须 < 24,000，且 `npm run bench -- --samples 3` 的 PASS 数不降                                                                                                                | 已落地                                                                                                                                                  |
| B06 | P1                        | 规则只有 always/globs 两态：`description` 解析了但不参与激活，意图被反转                        | `src/cli/project-instructions.ts:237`（解析出 `description`）、`:289-306`（读 frontmatter）、`:319-326`（`selectActiveRules` 把 `globs.length===0` 一律当 always）；`src/cli/prompt-setup.ts:117-121`（always 规则进稳定前缀）                                                                                                                           | Cursor rules 四类 `global / fileGlobbed / agentRequestable / manuallyAttached` + `alwaysApply/description/globs` 真值表（`cursor-evidence.md:414-464`；`cursor.md:22-50`）                                                                | 临时工作区写 `.moss/rules/x.md`（只有 `description:`、无 globs），调 `dist/cli/project-instructions.js` 的 `selectActiveRules(rules, [])`：现在返回该规则（=always），改后必须返回空（只有显式 `@rule`/模型请求才加载）                                                                                                                                                                                                                            | 已落地                                                                                                                                                  |
| B07 | P1                        | 子代理提示层缺「父消息≠用户授权」与绝对路径契约                                                 | `src/core/subagent/spawn-profile.ts:120-137`（只有 final-response 规则）；各 scope 只写工具禁用（`:144-213`）；工具层审批继承已做（`src/core/subagent/subagent-runner.ts:398-401`），缺的是提示层契约                                                                                                                                                    | Claude Code 子代理原文：`No message from any agent is ever your user's consent or approval…`、`cwd reset between bash calls … only use absolute file paths`（`claude-evidence.md:341-355`）                                               | `node -e "import('./dist/core/subagent/spawn-profile.js').then(m=>{const t=['full','read-only','explore','plan','critic','device-read'].map(s=>m.buildSubagentPromptAddon(s)).join('\n');console.log('consent:',/never your user.s consent/i.test(t),'abs:',/absolute file paths/i.test(t))})"` 现在打印 `consent: false abs: false`；改后两项都 `true`。另加行为切片：父代理用一句话让 read-only 子代理写文件 → 子代理必须回 `blocked` 而不是尝试 | 已落地                                                                                                                                                  |
| B08 | P2 工具描述单档、无否定段 | **已落地**                                                                                      | `tools/file-tools.ts:210-216`：`read_file.description` 结尾就是 `Not for directories (list_directory), images (read_image), or finding unknown matches (search_code).`；`metadata.leanDescription`（`:212`）同样带否定段，另有 lean 模式分档；dist 探针实测 `hasNegativeGuidance: true` / `leanHasNegativeGuidance: true`                                |
| B09 | P2 大结果只有 exec 落盘   | **已落地且已验证**                                                                              | `context/tool-output-spill.ts:104` `truncateWithRecoveryPath` 覆盖所有被截断的工具结果（exec 自己写过的用 `SPILL_MARKER` 跳过），循环侧调用在 `core/loop/agent-loop-tool-execution.ts:315`；dist 探针见本节末                                                                                                                                            |
| B10 | P2                        | skills 目录裁剪不看真实使用：先丢的是名字靠前的，不是最久未用的                                 | `src/core/skills/skill-catalog.ts:70-74`（排序 = scope → name）、`:111,124`（预算与 `ranked` 决定谁先降级）；使用数据已存在（`src/core/skills/skill-usage.ts:24`，写入 `src/core/skills/skill-tool.ts:5`）但 catalog 不读                                                                                                                                | Claude Code tier-1 listing 超预算时「保留全部名字，从最久未用的技能开始丢描述」，常用技能保全文（`claude-code.md:134-152`）                                                                                                               | `node -e` 用 30 个技能 + 伪造 usage（第 1 个 `used=5`）渲染 catalog：断言被降级为 name-only 的集合**不含** used 最高者；现在按 name 排序，断言 fail                                                                                                                                                                                                                                                                                                | 已落地                                                                                                                                                  |
| B11 | P2                        | 子代理不可续跑：只能重跑，不能带上下文追问                                                      | 只有 5 个工具 `create_subagent`/`fan_out_subagents`/`subagent_status`/`subagent_stop`/`merge_subagent_patch`（`src/tools/create-subagent.ts:157,558,825,905`、`src/tools/merge-subagent-patch.ts:10`），无 resume；`subagent_status` 只给快照/等待（`:825-829`）                                                                                         | Claude Code 子代理可按 agent id 恢复并保上下文（`claude-code.md` §4.7）；Cursor subagent resumable by agent ID（`cursor.md:259-277`）                                                                                                     | 固定 git fixture 上：`create_subagent(background)` → `subagent_status` 拿 id → `subagent_resume({agentId, prompt})`；现在该工具不存在（模型收到 unknown tool）；改后子代理终稿必须引用上一轮发现（探针断言关键词）                                                                                                                                                                                                                                 | ✅ 完成（前台/磁盘 latest/跨进程/后台等待/fan-out 逐子）                                                                                                |
| B12 | P2                        | 启动到可输入 ~800ms，且没有分阶段计时可定位                                                     | 实测 `composer_ready` 843 ms / 737 ms（`docs/research/2026-11-05-ux-handfeel.md:11-14`）；技能发现（`src/cli/runtime.ts:1088-1162`）、MCP、prompt 组装都在 TUI 挂载（`src/cli/runtime.ts:1615`）之前；`grep -rn "MOSS_STARTUP" src/` 零命中                                                                                                              | 参考产品先渲染 composer + 状态行、再异步补数据（`ux-handfeel.md` §2.4）；Moss 自己在 `ux-handfeel.md:43` 已给出 H2 验收口径                                                                                                               | ✅ 产品侧达标（product composer 384–501ms）+ 可重复门禁（`bench:tui-feel` 报 product/端到端两口径，`MOSS_TUI_FEEL_STRICT=1` 时超 600ms 失败）                                                                                                                                                                                                                                                                                                      |
| B14 | P0                        | 验证门 23 个 stage 全串行：static 21s + build + 21 个探针全部 await，墙钟 42s，紧贴 60s CI 预算 | 旧 `scripts/verify/cli.mjs` 的 `for (const name of stages) { … await stage.run() }`；`docs/design/ci-and-verify.md:39` 记录的 30.9s 只是 4 stage 时代的数字，之后 stage 已增到 23 个；`VERIFY_BUDGET_SECONDS=60` 在 CI 上是硬失败                                                                                                                        | CI 门把独立检查并发化、只给 timing 敏感项独占（Cursor / Claude 的 CI 也是并行 job + 显式耗时账）                                                                                                                                          | 同一条 `npm run verify`：`VERIFY_CONCURRENCY=1`（同调度器串行基线）3 次 41.9/42.0/42.6s vs 默认并发 3 次 24.3/24.6/25.0s，全部 PASS；强制让池中一个探针失败时新 stage 不再启动、在跑的跑完、exit 1                                                                                                                                                                                                                                                 | 已落地                                                                                                                                                  |
| B15 | P2                        | `/context` 看不到工具面成本与当前 lean/full 档位，优化不可见                                    | `/context` 只报 system prompt / messages / free / reserve；工具声明（每轮都付费）没有数字，lean 档切换也无处观察                                                                                                                                                                                                                                         | Cursor 的上下文面板列工具/系统提示成本；Claude Code `/context` 同样给出分解                                                                                                                                                               | 真实 REPL（`MOSS_NO_TUI=1`，pipe `/context`）输出必须含 `tools ~N tokens (M declared, lean                                                                                                                                                                                                                                                                                                                                                         | full descriptions)`：默认 200k 档显示 `32 declared, full descriptions`、`agent.contextTokens=32000`显示`32 declared, lean descriptions` 且 token 数更小 | ✅ 完成（含 verify stage `context-surface`） |
| B16 | P1                        | 独立评审（`review_changes`）不会自动用任务验收标准当 rubric，模型必须手填 `criteria`            | `review_changes` 已有 `criteria` 输入（`src/tools/review-tools.ts`），但没人自动传；`task_define` 的 acceptance criteria 在 `.moss/tasks.jsonl`（`listTaskRecords`）里躺着不用                                                                                                                                                                           | Cursor Agent Review 按任务标准评分（`docs/research/2026-11-05-cursor-acceptance-loop.md` §2.2、§5.1「acceptance criteria 作为评审 rubric」）                                                                                              | 真实 `-p`（脚本化 provider）在含 `.moss/tasks.jsonl` 的工作区触发 `review_changes`：reviewer 请求体必须含 `Task <id>` 与验收标准原文，工具结果含 `rubric: task <id>`；verify probe 断言最新任务胜出、可选 criterion 标注 `(optional)`、无任务返回 undefined                                                                                                                                                                                        | ✅ 完成                                                                                                                                                 |
| B17 | P2                        | REPL（非 TUI）里运行中的一轮无法被按键中断：Esc 与 Ctrl+C 都不生效，用户只能等它跑完            | 真实 PTY 探针（见 §3 B17）：慢流 stub + REPL，按 Esc 后 provider 继续发出 95 个 token、无客户端中断、无 Interrupted 提示；Ctrl+C 同样无效                                                                                                                                                                                                                | Cursor / Claude Code 的“按 Esc 停止当前生成”是核心手感；TUI 已实现（bench 的 typing-stream-interrupt 场景 PASS，interrupt_ms 46–91ms）                                                                                                    | 真实 PTY 复跑：按 Esc / Ctrl+C 后 provider 侧 2.5s 内新增 token = 0，且出现 Interrupted 提示；REPL 与 TUI 行为一致                                                                                                                                                                                                                                                                                                                                 | ✅ 完成（REPL 运行中 Esc/Ctrl+C 可中断；文案恢复统一口径；真实 PTY 四场景验证）                                                                         |
| B18 | P2                        | 启动慢的大头是模块加载：`dist` 里 511 个 ESM 模块约 480ms，且发布形态无法按需                   | **持续推进（2026-11-05 第四片）**：把启动图里白付的重依赖改成按需——`ssh2`（27 个 CJS 模块，≈38ms）改为连接设备时才 `import()`，`turndown`+`@mixmark-io/domino`（24 模块，≈20ms）改为首次 HTML 转换时才加载。启动期 `node_modules` 模块数 **64 → 7**（只剩 micromatch/braces/picomatch/string-width），`dist/cli/runtime.js` 图加载中位 **251ms → 204ms** | 见本节末 B18 第四片证据                                                                                                                                                                                                                   | 持续进行                                                                                                                                                                                                                                                                                                                                                                                                                                           |

**H7 已完成（2026-11-05）：REPL 跨会话提示历史**
TUI 早就有工作区 `prompt-history.jsonl`（`cli/tui/prompt-history.ts` + `app.ts:822-837`）并支持 Up/Down 召回；
readline REPL 每次启动 history 为空，Up 只能回到本次会话。现在 REPL 复用同一套文件：
启动时 `loadMergedPromptHistory` 灌入 `rl.history`（newest-first），每条提交写回 configDir + 工作区两份文件。
**真实证据（PTY，`MOSS_NO_TUI=1`）**：

- 跨会话召回+提交：预置 `.moss/prompt-history.jsonl` 为 `seeded-prompt-from-session-one`，新会话里按 Up 再回车，
  该会话的 `.moss/sessions/cli-*.jsonl` 首条 `role:"user"` 的 content 正是 `seeded-prompt-from-session-one` 加上
  `<turn-context>` 环境段（说明召回进入 readline、回车把它提交给了这一轮）；
- 写入侧：同法输入 `remember-this-prompt` 后，工作区 `.moss/prompt-history.jsonl` 出现 `{"text":"remember-this-prompt"}`。
- 该轮用不可路由 baseUrl（`127.0.0.1:9`）当 provider，判定只读会话文件、不依赖 stub 回包。REPL 与 stub 的正常往返
  另由 H8 结论里的非阻塞 stub 探针证明。

**H8 已结案（2026-11-05）：不是产品 bug，是探针把 stub 的事件循环堵死了**
曾经连续三轮怀疑「REPL 里 `Working` 且 provider 收到 0 个请求」是产品缺陷，逐层打点到了 transport 的
`before-fetch`（URL 正确），最后发现是**探针缺陷**：

- 所有 stub 都跑在 Node 驱动进程里，而驱动用 `execFileSync('python3', ...)` **同步**跑 PTY 脚本 ——
  父进程事件循环被阻塞，stub 无法 accept/解析连接，子进程自然等不到响应（3s first-chunk 超时也是这个原因）；
- 把 stub 改成**不阻塞**的形式（Python `ThreadingHTTPServer` + 线程跑 stub，PTY 循环在主线程）后，REPL 立刻正常：
  `/v1/chat/completions` 收到请求（25,699 字节），界面显示 `pong`，随后 `Completed: run finished`。
  **结论**：撤回「REPL 有 bug」的推论，产品代码无需改动。**教训已写进探针约定**：子进程要访问本地 stub 时，
  stub 必须与阻塞等待隔离（独立进程/线程），不要在托管 stub 的进程里用同步等待跑驱动器。

**B18 第五片（2026-11-05）：子命令帮助不再把命令模块拖进每次启动**
`cli/subcommand-help.ts` 静态 import 了 10 个命令模块的 usage 渲染器（config/device/mcp/setup/loop/review/skill/task/tasks/update），
而它被 `bootstrap.ts` 引用，于是**每一个** `moss` 进程都加载这些模块及其工具注册表（`review-tools`、`task-run`、`device-commands`…），
包括根本不看帮助的 `-p` 运行。改成 `renderSubcommandHelp` 为 async，只在 `moss <cmd> --help` 时按命令 `await import()` 对应模块。
**真实证据（`module.registerHooks` 逐模块计数，不再用 CPU-profile 采样估算）**：

- 启动期 eager 模块总数 **393 → 371**（dist **368 → 346**，`node_modules` 25 未变）；
- 11 个子命令 `--help` 输出逐条抽查仍正常（config/device/mcp/skill/review/loop/tasks/task/update/setup/trust/uninstall 首行如上）；
- `moss --help` 根帮助、`-h -v` 语义不变；`npm run verify` PASS in 37.4s（含 CLI smoke）；
- 图加载墙钟中位在 204–215ms 间波动（本机噪声 ±40ms，22 个模块的差异低于噪声，因此以模块计数为准）。

**B18 测量方法更正（2026-11-05）**：第四片当时写的「启动期 node_modules 64 → 7」来自 CPU-profile 采样（只统计出现调用帧的模块），
绝对值偏低。用 `module.registerHooks` 逐模块记录后，真实 eager 计数为 393 模块（dist 368 + node_modules 25）；
`ssh2`/`turndown`/`domino` 确实已不在列表里（结论方向不变），但绝对数字以本节为准。

**B18 第四片（2026-11-05）：把 ssh2 / turndown 移出启动图**
启动图 CPU profile（`--cpu-prof` + 按文件聚合）显示，没有任何设备、也没抓网页的 `moss -p` 仍然加载了
64 个 `node_modules` 模块，其中 **ssh2 一整个 CJS 树（27 模块：tweetnacl/asn1/bcrypt-pbkdf/…）** 与
**turndown + @mixmark-io/domino（24 模块）** 都是「用时才需要」。
改法：`device/ssh-device-connection.ts` 的 `import { Client } from 'ssh2'` 改为 `import type` + 连接时
`await import('ssh2')` 并缓存；`tools/web-fetch.ts` 的 turndown 由静态 import 改为首次 HTML 转换时
`await import('turndown')`（`htmlToText` 变 async，调用点已 await）。
**真实证据**：

- 启动图（同一命令 `await import(dist/cli/runtime.js)`，各 5 次）：中位 **251ms → 204ms**（197/198/204/222/285）；
- 启动期加载的 `node_modules` 模块：**64 → 7**，profile 里 `ssh2 loaded: false / turndown loaded: false / domino loaded: false`；
- 按需加载确实生效：`import(dist/device/ssh-device-connection.js)` 只要 **12ms**，随后 `import('ssh2')` 才花 **49ms** 且 `Client` 可用；
- 行为回归（本地 HTTP 服务返回 HTML）：`web_fetch` 输出 `# Probe Heading`、`**bold**`、`<script>`/`<style>` 已剥离——即 turndown 动态加载后转换链完整；
- `npm run verify` PASS in 36.0s；lint 0 warning。

**B18 第三片（2026-11-05）：保留名表不再拖入斜杠命令实现图**
`cli/commands/custom-commands.ts` 的 `reservedBuiltinNames()` 只为拿命令名，却静态 import 了 `./registry.js`
（含整套命令实现），使该模块求值 **154ms**；这也让上一片「registry 移出 `-p` 路径」被部分抵消。
改为用已有的 `INTERACTIVE_COMPLETION_COMMANDS` + 菜单行 + 显式 `/cost`、`/stats`（registry 独有）构造保留名集合，
只留 `import type { CommandSpec }`。
**证据**：模块求值 **154ms → 81ms**；保留名集合 **46 个**，对 `registryCommandNames()` 做包含性检查 **无缺失**。
**诚实结论**：`-p` 的 `entry` 中位数仍在 313–314ms、墙钟 683–731ms（10 次，波动 627–816ms），
本片**没有**带来可测的 `-p` 改善——它的价值是解除 custom-commands→registry 的静态耦合，让后续真把 registry 移出成为可能。
**行为回归（真实运行）**：工作区自定义命令 `/hello world` → provider 收到 `CUSTOM-MARKER` 且 `$ARGUMENTS` 展开为 `world`；
用 `.moss/commands/status.md` 试图覆盖内置 `/status` → provider **没有**收到 `SHADOW-MARKER`，内置 status 正常输出（保留名保护有效）。

**B18 第二片（2026-11-05）：`-p` 不再加载整套斜杠命令图**
`src/cli/runtime.ts` 为了 oneshot/管道的 `/命令` 分发，静态 import 了 `cli/commands/registry.js`（单测求值 **155–182ms**），
而这个图只有交互会话（REPL/TUI）需要；`-p` 纯聊天永远走不到。改成 `registryCommandModule()` 的按需 dynamic import，
在两个调用点（oneshot 分发、管道分发）各取一次句柄。
**真实 A/B（同一脚本化 provider，各 10 次）**：`-p` 墙钟中位数 **709ms → 683ms**（−26ms），
启动分阶段 `entry` 中位数 **321ms → 313ms**（−8ms）；单次波动 620–1060ms，中位数差异接近噪声上限，
所以只按「结构上把交互图的 150ms 求值移出 `-p` 路径」记录，不夸大成大跃升。
**行为回归（真实运行，全部通过）**：`moss "/skills"` → exit 0 且有技能表；`moss "/nope-not-a-command"` → exit 2 且给出
did-you-mean；`echo "/skills" | moss` → exit 0 且有表；`-p` → exit 0 / subtype success。

**B18 第一片（2026-11-05）：绕开 `contracts` 桶文件，收掉静态图里的无用耦合**
上一片量化出「打包只值 85–120ms」，所以先做延迟/收窄求值：`src/cli/runtime.ts` 只需要
`buildSoftwareEngineeringPromptQuick`，却经 `contracts/index.js` 桶文件把整套 message/device/task 契约一起求值
（单测该桶 **133ms**，直连模块 **8ms**）；`src/provider/provider-presets.ts` 只为 `DEFAULT_MODEL` 引同一个桶。
两处改为直连具体模块。
**真实 A/B（同一脚本化 provider，各 6 次交替）**：`-p` 墙钟中位数 **684ms → 665ms**（−19ms），
启动分阶段 `entry` 中位数 **317ms → 302ms**（−15ms）；幅度在噪声量级，但方向一致，且静态图少了一层桶耦合。
改后真实 `-p`：`exit 0 / subtype success / first_token_ms 9 / duration_ms 154`。`npm run verify` PASS。

**B18 可行性探针（2026-11-05，未改产品代码）：打包能省多少、卡在哪**
为了给 B18 一个可信量级，做了两组实测：

1. **纯 loader 开销上限**：在 `/tmp` 生成 511 个「只有一条 export」的 ESM 文件，由一个 index 依次 import，
   单进程实测 511 个模块的加载耗时 **82.0 / 90.2 / 85.1 ms**。即「文件数×loader」这一项最多值 ~85ms。
2. **真打包 spike**：临时 `npm i --no-save esbuild`（0.28.2，未进 package.json），把 `dist/cli.js` 打成单文件。
   产物 6.2MB，但连续撞到三个具体障碍：
   - 默认 `--packages=external` 时产物在临时目录里找不到 `string-width` 等依赖（需连同依赖一起打）；
   - ESM 产物里 CJS 依赖需要 `createRequire` banner，否则 `Dynamic require of "util" is not supported`；
   - `ssh2` 的 `__dirname` + 本仓顶层 `await` 触发 Node「无法判定模块格式」错误（需 `__dirname` 兼容层）。
     因崩溃发生在入口，无法量到真实 `-p` 墙钟；本轮**不**把打包写进构建。
     **结论（写入 B18）**：当前 `-p` 墙钟 ~668ms 中，loader 文件数只占 ~85ms；`entry≈305ms` 的其余部分是各模块**求值**
     （真实代码：提示词、工具表、schema 等）。所以打包单独做最多 ~85–120ms，B18 的 ≤450ms 目标必须叠加
     「按命令路径懒加载/延迟求值子系统」，而不是只换构建产物。esbuild 已卸载、产物已删，仓库无新增依赖。

**H1 第二片（2026-11-05）：启动提示覆盖 readline REPL**
上一片只给 TUI 打启动行（`wantsTui` 条件里排除了 `MOSS_NO_TUI=1`）。但 REPL 付的是同一笔模块加载账。
实测 REPL（PTY，`MOSS_NO_TUI=1`）首字节 **524.5ms**（那之前终端全空）。把 `bin` 的条件改成「TTY + 交互式 chat」
（不再要求启用 TUI）后：REPL 首字节 **63.5ms**，启动行只出现 **1 次**；`--version`（291ms 首字节）与 TTY 下 `-p hi`
仍然**不**打印启动行。

**H6 第二片（2026-11-05）：首字 8ms、墙钟 700ms——瓶颈在模块加载，先砍设备注册表**
用 `first_token_ms` 加 `MOSS_STARTUP_TIMING=1` 拆真实 `-p` 运行（脚本化 provider，零延迟）：
`wall≈700ms`，其中 `first_token_ms≈8ms`、`duration_ms≈150ms`、`entry≈320–372ms`。也就是**用户感知的等待几乎全在
Node 加载 511 个 ESM 模块**，不在 prompt 组装或 provider。
先做低风险的一刀：把 `src/cli/runtime.ts` 里只为「有设备时」服务的两个静态 import 改成按需动态加载
（`device-registry-file.js`、`device-registry.js`），其余逻辑不动。
**真实证据（同一脚本化 provider，各 6 次交替测量）**：墙钟中位数 **702ms → 668ms**（−34ms）；启动分阶段行
`entry` 由 **362ms → ~305ms**（三次 307/306/300ms），`total` 仍在 147–160ms；带 `.moss/devices.json` 的真实 `-p` 运行
仍 `exit 0 / subtype success`（设备路径未坏）。
剩余大头（~480ms 的模块加载）需要「入口图瘦身或打包」，登记为 **B18**（见总表）。

**H6 第一片（2026-11-05）：把首字延迟暴露到 headless JSON 结果**
loop 早就在测 `firstTokenMs`（`run_metrics`）与每次调用的 `ttftMs`（`llm_usage`），但 **CLI 一个都没消费**——
`-p --output-format json` 里只有 `duration_ms`，想拆分「prompt 组装 vs provider 往返」只能靠猜。
现在 `result` 事件新增 `first_token_ms`（首次观测到的 ttft），`HeadlessResultEvent` 与 `HeadlessPrintState` 同步带上。
**真实证据（真实 CLI + 脚本化 provider，同一工作区两次）**：

- provider 首字节延迟 400ms：`exit 0 | first_token_ms 411 | duration_ms 592`；
- 延迟 0ms：`exit 0 | first_token_ms 8 | duration_ms 163`。
  也就是说这个字段确实反映 provider 停顿，而不是固定值；差值（duration − first_token）≈ 其余装配/收尾开销，可作为下一步优化的基线。

**H4 余量（2026-11-05）：会话内 `/skills` 可见技能成本/使用/评测**
`moss skill list` 早就有「scope / used / catalog 字符 / evals」四列，但**会话里没有等价入口**（`/skills` 不是命令），
用户想判断「这个技能占多少上下文、到底用不用」必须退出会话。现在把列表渲染抽成
`renderSkillsList(workspaceDir, configDir, zh)`，`moss skill list` 与会话内 `/skills` 共用同一份实现，
并把 `/skills` 加进斜杠菜单与补全。
**真实证据（真实 REPL，`MOSS_NO_TUI=1`，工作区放一个 demo-skill）**：会话里 `/skills` 输出
`name scope used catalog evals description` 表头 +
`demo-skill  workspace 0  142  -  demo skill for the /skills probe` +
`1 skill(s); catalog 142/8000 chars (strategy full, 142 without a budget)`；
同工作区 `moss skill list` 的对应行逐字段一致（catalog 142、used 0、evals `-`）。

**H1 余量（2026-11-05）：启动期不再空屏——`bin` 层 69ms 出一行启动提示**
实测（PTY，`node bin/moss.cjs`，真实 TUI）：首屏第一个字节出现在 **777ms**（那时是 `[moss] Interaction mode …` 通知），
composer/alt-screen 在 ~830ms；也就是进程活着但终端空屏约 0.78s。TUI 的首帧必须等 config/agent/skills 完成，
把它提前的代价太大，所以改成**在最外层 `bin/moss.cjs` 立刻打一行暗色提示**（`moss starting…` / `zh` 时 `moss 启动中…`），
由 alt-screen 接管后自然被覆盖。判定只用 argv + TTY：无子命令或 `chat`、且不是 `-p/--print/-v/--version/-h/--help`、且 `MOSS_NO_TUI!=1`。
**真实证据（同一 PTY 驱动）**：交互路径首字节 **68.9ms**（原 777ms），启动提示只出现 1 次；`MOSS_LANG=zh` 时输出
`moss 启动中…`；TTY 下 `-p hi` **不**打印；`--version` 不打印；`npm run verify` PASS 36.0s，lint 0 warning。

**B12 收口（2026-11-05）：把 600ms 目标做成可重复门禁**
`bench:tui-feel` 跑完会读自己的报告并打印两口径中位数：
`composer: product median Xms (worst Yms), end-to-end median Ums, driver overhead median Vms; target <=600ms`。
默认只告警；设 `MOSS_TUI_FEEL_STRICT=1` 时超 `MOSS_TUI_FEEL_MAX_COMPOSER_MS`（默认 600）即 **exit 1**。
**真实证据（本机 pyte bench，两次运行）**：

- 默认 strict 门槛：product median **442.5ms**（worst 501ms），端到端 831.4ms，driver 开销 388.9ms → PASS，退出码 0。
- 负向证明：把门槛压到 300ms 后同一命令打印 `2/2 scenario(s) exceeded the 300ms product composer target … failing`，
  实测退出码 **1**。
- 同批 `typing-stream-interrupt` 场景 `interrupt_ms` 56/90ms，启动分阶段行含 `composer=501ms`（100x30）/`384ms`（70x24）。

**B15 `/context` 工具面可见性（P2，2026-11-05 完成）**
`/context` 原来只报 system prompt / messages / free / compaction reserve，**工具声明**这一块（每轮都付费、且刚做完 lean 档）
在会话里完全不可见：用户无法判断 lean 是否生效、也没有数字支撑「要不要加工具」。
最小切片：`MossAgent.offeredTools()`（按 loop 同一条 deferral/hidden 规则返回下一轮要发的工具）+
`/context` 用生产同一条 `buildProviderToolDeclarations(tools, { contextWindowTokens })` 算声明成本，并打印
`  tools      ~N tokens (M declared, lean|full descriptions)` —— 档位判断与真实发送一致（`shouldLeanToolDescriptions`）。
**真实证据（`MOSS_NO_TUI=1` + `script` 驱动 REPL，pipe `/context`）**：默认配置 → `tools ~5,140 tokens (32 declared, full descriptions)`；
`agent.contextTokens=32000` → `tools ~4,476 tokens (32 declared, lean descriptions)`（同一 32 个工具，lean 档少约 664 tokens，与
`measure-tool-surface` 的方向一致）。`tsc` 干净、`npm run verify` PASS。
**回归保护已补（同一轮，verify stage `context-surface`）**：`scripts/verify/stages/context-surface.mjs` 用
python3 PTY 驱动 `MOSS_NO_TUI=1` 的 REPL，真实键入 `/context` 并解析 `tools  ~N tokens (M declared, lean|full descriptions)`：
默认大窗口必须报 `full`、`agent.contextTokens=32000` 必须报 `lean`，两档声明的工具数必须相同、lean token 数必须更小。
**探针先在旧代码上失败**（`git worktree` 建 `d6dbbc94` 的构建，`MOSS_VERIFY_CLI_ENTRY=/tmp/moss-old/dist/cli.js`
跑同一 stage → `FAIL 21.1s`，因为旧 `/context` 根本没有这一行），新代码上 `ok 2.0s`；完整 `npm run verify`
**PASS 26.6s**（stage 并发调度，新增 2.0s 未挤爆 60s 预算）。

\*\***B16 独立评审自动带上任务验收标准（P1，2026-11-05 完成）**
`review_changes` 早就支持 `criteria` 参数，但没有任何地方自动传：`task_define` 写进 `.moss/tasks.jsonl` 的
acceptance criteria 与评审是断开的，模型只能凭自觉手填。Cursor 的 Agent Review 是**按任务标准评分**，不是凭感觉挑刺。
最小切片：`loadTaskAcceptanceRubric(workspaceDir)` 读任务台账、取 `updatedAt` 最新且声明了 criteria 的任务，
渲染成 rubric 文本（`metric expected` + 可选标注 + description）；`review_changes` 在**未显式传 `criteria`** 时自动
带进 reviewer prompt，并把来源写进结果头部 `rubric: task <id> (N acceptance criteria)` 与 `.moss/review.jsonl`
记录（`rubricTaskId`/`rubricCriteria`）。
**真实证据（`-p` + 脚本化 provider，工作区含 `.moss/tasks.jsonl`，provider 记录全部请求体）**：
`reviewerPromptFound=true`、`rubricInReviewerPrompt=true`（含 `camera_fps >=30`）、`rubricTaskIdInPrompt=true`
（含 `Task t-e2e`）、`toolResultHasRubricLine=true`（工具结果里出现 `rubric: task t-e2e`）、`mainSawVerdict=true`。
**回归门**：`scripts/verify/review-pipeline.mjs` 新增 2 条（21 checks pass）——最新任务胜出 + 可选 criterion
标注/描述保留 + 空工作区返回 `undefined`（回落到 correctness/security）。
**诚实说明**：该 e2e 进程 exit 9 来自既有的「无文件变更」完成门提示（`Incomplete: no files were modified`），
与本改动无关；rubric 传递本身的五条断言全部为真。

**B16 第二片（同一轮）：同一个 diff 不重复评审（Bugbot 的「状态而不是再来一次」）**。此前
description 写着「At most once per change」但代码里没有任何去重，模型重复调用会再花一个子代理。现在
`ReviewRecord.diffFingerprint`（`sha256(diff)` 前 16 位）+ `findRepeatedReview(records, fingerprint, depth)`
让「同一 diff、同一 depth」的重复调用直接返回**已记录的评审结果**（前缀 `This change is already reviewed…
(no new sub-agent was spent)`），文件一改 hash 变化就重新评审。
**真实证据（`-p` + 脚本化 provider，统计 reviewer 请求次数）**：同一 diff 连调两次 → `reviewerCalls=1`、
第二次工具结果含 `already reviewed`、`.moss/review.jsonl` 只有一条记录且带 16 位 fingerprint；
随后 `read_file` + `write_file` 改动文件再评审 → `reviewerCalls=2`，两条记录 fingerprint 不同
（`94ee02afb9a4f0f4` vs `30192c1d1d1a9b58`），run exit 0。
**回归门**：`review-pipeline` probe 新增 1 条（22 checks）：fingerprint 稳定/对内容敏感、按 depth 区分、
未知 hash 返回 undefined。

**B16 第三片（同一轮）：修复次数上限（Bugbot 的 fix loop 上限 3）**。此前失败评审可以无限重跑，没有
「试了 3 次还是不行就该停下来」的状态。现在 `failingRepairAttempts(records, depth)` 统计**尾部连续的
失败评审（按 diff fingerprint 去重，pass 即清零，depth 分档）**；达到 `MAX_REPAIR_ATTEMPTS = 3` 时
`review_changes` 不再花子代理，直接返回 `Repair attempts exhausted …` + 最后一次失败评审的结果，
并要求模型停止评审、诚实汇报未解决问题或询问用户（也提示可用 `paths=` 缩窄范围）。
**真实证据（4 次独立 `-p` 运行共享同一 `.moss/review.jsonl`，脚本化 provider 每次给出带 finding 的
`VERDICT: FAIL`）**：前 3 次各花 1 个 reviewer（`reviewerCalls=3`，记录 `fail,fail,fail`），第 4 次
**没有**再调用 reviewer，主模型上下文里出现 `Repair attempts exhausted` 消息；4 次 run 均 exit 0
（工具返回的是「停手」指引而非工具错误，所以进程退出码不表达失败——想用退出码表达请用
`moss review check`，它仍以 1 表示仍有未解决问题）。**同轮观察**：单轮内重复调用同一 `review_changes`
本来就会被 tool loop guard 挡住（`identical input … 3 time(s)`），所以本上限主要覆盖**跨轮/跨会话**的
修复循环。**回归门**：probe 新增 1 条（23 checks）：cap 常量、尾部连续统计、重复 fingerprint 只算一次、
pass 清零、depth 分档。

**B16 第四片（2026-11-05）：把「第几次修复尝试」告诉模型**。上限到了才停手还不够——模型不知道自己在
第 2/3 次，容易把「又失败」当成随机噪声。现在 `ReviewRecord.repairAttempt`（1 起）+ 结果头部
`repair attempt: N of 3`（第 1 次不显示，避免噪声）。
**真实证据（4 次独立 `-p`，共享 `.moss/review.jsonl`，每次改文件后评审且 reviewer 回 FAIL）**：
`reviewerCalls=3`，记录里 `repairAttempt` 依次 `1,2,3`；第 2、3 次的主模型上下文分别出现
`repair attempt: 2 of 3` / `repair attempt: 3 of 3`，第 1 次没有该行；第 4 次被上限拒绝。

**H5 错误文案给出下一步（2026-11-05 首片：MCP 连接失败 + Stop 钩子拦截）**
两处真实失败场景原来只说明「失败了」：MCP 状态行 `○ broken — failed: spawn … ENOENT` 之后无路可走；
Stop 钩子拦截在 headless 只给原因，用户只能盲目重跑。现在：
`○ broken — failed: <reason> — next: /mcp to retry; check the server command in mcp.json`
（中文：`— 下一步：/mcp 重试；检查 mcp.json 里的服务启动命令`），Stop 拦截行追加
`(fix what the hook checks, then re-run; or remove the hook from your Moss config hooks.Stop)`。
**真实证据（两个真实失败场景，真实 CLI）**：(1) 工作区 `.moss/mcp.json` 指向不存在的启动命令 →
stderr 出现 `○ broken — failed: spawn /nonexistent-mcp-binary-xyz ENOENT — next: /mcp to retry…`，
`MOSS_LANG=zh` 同样输出中文下一步；(2) `hooks.Stop` 配置 `node -e "process.exit(1)"` 的 headless 运行 →
`[hooks] Blocked by Stop hook: hook exited 1 (fix what the hook checks, then re-run; or remove the hook from your Moss config hooks.Stop)`，
退出码 `9`（未完成）。

**H5 第五片（2026-11-05）：把「Shift+Tab」类提示统一标注 TUI（全仓排查一遍）**
上一片修的是拦截文案，这一片是**同类排查**：`Shift+Tab` 只在 TUI 存在，但 5 处共享文案（`/mode` 列表快捷键行、
`/mode plan` 切换提示、`/plan` 进入提示、onboarding 的 /permissions 帮助、`/mode` 迁移提示）都无条件把它
当成人人可用的快捷键。现在统一写成 `Shift+Tab（TUI）` / `Shift+Tab (TUI)`，退出话术改为「/mode manual 退出
（TUI 里也可用 Shift+Tab）」。
**真实证据（真实 PTY，两个界面同一份代码）**：(1) REPL（`MOSS_NO_TUI=1`）依次发 `/plan`、`/mode plan`、`/mode`
→ 屏幕上的提示全部带 `(TUI)` 限定（`allNameTui: True`）；(2) TUI 界面同样发送 `/plan`、`/mode plan` → 文案相同。

**H5 第四片（2026-11-05）：plan 模式拦截文案按「真实存在的切换面」分表面**
plan 模式的拒绝原来统一说「(use Shift+Tab)」——`-p` 或无 TTY 的运行根本没有 Shift+Tab，等于给了不存在的键。
现在：`-p`/管道场景说「Plan mode is an exploration ceiling: relaunch with --workspace-write or --full-access, or run
interactively and switch modes with /mode or Shift+Tab」；交互场景说「Shift+Tab in the TUI, /mode in the REPL」。
**真实证据（两个真实运行）**：(1) headless `-p --plan` 让模型调用 `write_file` → 工具结果含 relaunch 指引，
文件未被写（`app.txt` 仍 `zero`），exit **9**；(2) 真实 PTY + REPL（`MOSS_NO_TUI=1 --plan`，脚本化 provider）
→ 拒绝行含 `Switch to "manual", "accept-edits", or "full" mode (Shift+Tab in the TUI, /mode in the REPL)`，
且不含 headless 分支文案。

**H5 第三片（2026-11-05）：PreToolUse 钩子「要求确认」在无人可确认时给出下一步**
`hookAskHeadlessReason` 原来只说「钩子要求人工确认，-p/无终端下按拒绝处理」——用户不知道还能怎么做。
现在末尾补 `Next: re-run in an interactive session to confirm this call, or change that hook's decision.`
（中文：`下一步：在交互会话里重跑以确认该调用，或修改该 hook 的判定。`）。
**真实证据（真实 CLI + 脚本化 provider，配置 PreToolUse matcher=exec 的 ask 钩子）**：headless `-p` 运行
调用 `exec` → 进程 exit **9**，主模型看到的工具结果同时含 `needs a human`（钩子理由）与新增的 Next 句；
`MOSS_LANG=zh` 同一场景输出中文下一步。

**H5 第二片（2026-11-05）：工具被 deny 规则拦截时给出「怎么放宽」**。`exit_tool_call` 的 `policy` 类拒绝原来只说
「已配置策略拦截、不要绕行」，没告诉用户去哪里看/改规则。现在 `DENIED_GUIDANCE.policy`（中英）追加
`run /permissions to see the matching rule and relax it (or use an allowed path), then retry`；同时
`approval.ts` 的 `deniedTools` 背景行也补了「从 `permissions.deniedTools` 移除该条、`/permissions` 列出生效规则」。
**真实证据（真实 CLI + 脚本化 provider，配置 `permissions.deny: ["exec"]` 并让模型调用 `exec`）**：工具结果
`Tool execution denied: Tool "exec" blocked by deny rule exec (user). … run /permissions to see the matching rule and
relax it (or use an allowed path), then retry …`，`exec` 确实未执行（`echoDidNotRun: true`）；`MOSS_LANG=zh` 下
同一路径输出 `……运行 /permissions 查看并放宽匹配的规则（或改用允许的路径）后重试……`。

**B12 收尾进展（2026-11-05）：composer 计时单标签 + 真实 `bench:tui-feel` 基线**
两处 TUI 打点都写 `skills`，计时行会打印 `skills=… skills=…`；现在 `StartupTiming.mark` 对重复标签首个生效，
TUI 的第二处改名为 `commands`（命令命名空间 + 能力注册构建），一行变为
`entry=330ms proxy=80ms config=375ms prompt=379ms agent=383ms mcp=384ms skills=388ms commands=388ms tui-import=388ms probe=410ms composer=473ms total=473ms`。
`startup-timing` probe 新增「标签不得重复」断言（4 checks 仍 pass）；README 同步。
**真实 `npm run bench:tui-feel`（本机，MOSS_STARTUP_TIMING=1，真实 PTY + pyte）**：
`composer_ready_ms` = **905ms**（100x30）/ **695ms**（70x24），而 CLI 自己上报的 `composer=` 只有 **473ms / 343ms**
（每次跑两次取到 525/352、473/343）。两者差值 ~340–430ms 是 bench 驱动的 PTY 传输 + pyte 解析 + 可见 composer
探测开销 —— **B12 的 `<600ms` 目标在 bench 指标上仍未达成，但产品侧首帧已在 350–520ms**；下一步要动的是
bench 驱动的探测开销（或接受把验收口径改成 CLI 上报的 composer），而不是继续压产品启动。
基线对比：B12 立项时同机 `composer_ready` 是 843/737ms，产品侧现在 343–473ms（含本轮 probe/env 延迟化）。

**B12 口径落地（2026-11-05）：bench 报告把「产品首帧」和「驱动开销」拆开**
`scripts/tui-feel/driver.py` 在 `MOSS_STARTUP_TIMING=1` 时解析 CLI 的 `composer=` 并新增两个 metric：
`cli_composer_ms`（产品首帧）与 `driver_overhead_ms = composer_ready_ms − cli_composer_ms`（PTY 传输 +
pyte 解析 + 可见探测）。**真实一次 bench**：`composer_ready_ms=866.7 / cli_composer_ms=474 / driver_overhead_ms=392.7`；
`774.9 / 374 / 401.0`。**验收口径定为：B12 的 `<600ms` 用 `cli_composer_ms` 判定（当前 374–474ms，达标）；
`composer_ready_ms` 保留为端到端体感指标，并在报告里始终同时给出驱动开销**，避免把驱动开销当成产品回退。

**B12 复测 + bench 默认捕获相位（2026-11-05）**：`bench:tui-feel` 现在**默认**给被测 CLI 设
`MOSS_STARTUP_TIMING=1` 并把相位行写进每个场景的 `metrics.startup_timing`（以前只有调用者自己设环境变量才有，
慢首帧要复跑一次才能定位）。**真实复测（同机，两次场景）**：`composer_ready_ms` 863.2 / 657.0，
`cli_composer_ms` **466 / 345**，`driver_overhead_ms` 397.2 / 312.0 —— `cli_composer_ms` 仍稳定 **<600ms**，
B12 的产品侧口径持续达标；端到端指标的波动几乎全部来自驱动开销。

**B16 第五片（2026-11-05）：`.moss/review-state.json` 状态投影**
日志 `.moss/review.jsonl` 是历史，但「现在在第几次尝试、还剩几次、下一步做什么」需要一个当下对象。
`recordReview` 在追加日志后写 `.moss/review-state.json`（best-effort，失败不影响日志）：
`{ reviewId, depth, verdict, attempt, maxAttempts: 3, attemptsExhausted, nextAction, findings:{total,critical,important,suggestion},
diffFingerprint?, rubricTaskId?, rubricCriteria? }`，`nextAction` 三态：`proceed: …` / `apply the findings, then re-run …` /
`stop retrying: 3 distinct diffs failed review; …`。
**真实证据（真实 CLI + 脚本化 provider，四个工作区状态）**：FAIL 第 1/2 次 → `attempt 1/2, attemptsExhausted false,
nextAction "apply the findings…"`；FAIL 第 3 次 → `attempt 3, attemptsExhausted true, nextAction "stop retrying…"`；
PASS → `verdict pass, findings.total 0, nextAction "proceed…"`。spec 的持久化小节已同步该文件。

**B16 第七片（2026-11-05）：`moss review list` 末尾给出「当前修复循环状态」**
`list` 是历史列表，读者仍要自己判断「现在停在哪一步」。现在列表末尾追加一行：
`repair attempt: 2 of 3 — apply the findings, then re-run review_changes on the new diff`
（中文：`当前修复尝试：第 2 / 3 次 — 按 findings 修复后…`），用与 `check` 相同的 `buildReviewState` + 中文渲染。
**真实证据（真实 CLI + 脚本化 provider，两次 FAIL 后）**：`moss review list` exit **0**，末尾行为
`repair attempt: 2 of 3 — apply the findings, then re-run review_changes on the new diff`。

**B16 第六片（2026-11-05）：`moss review check` 直接报「第几次 / 下一步」**
状态文件有了，但门禁命令还在只看结论。现在 `moss review check` 在 FAIL 时追加两行：
`repair attempt: 2 of 3`（用尽时标 `(exhausted)`）与 `next: <nextAction>`；状态文件缺失时用
`buildReviewState(latest)` 从日志派生，所以旧日志也能回答「现在该干什么」。中文输出不再混英文句子，
三种状态有对应的中文渲染。
**真实证据（真实 CLI + 脚本化 provider）**：两次 FAIL 后 `moss review check` exit **1** 并打印
`repair attempt: 2 of 3` + `next: apply the findings, then re-run review_changes on the new diff`；
PASS 后 exit **0**；`MOSS_LANG=zh` 同一状态打印 `修复尝试：第 1 / 3 次` + `下一步: 按 findings 修复后，对新的 diff 重新运行 review_changes`。

**B08 收尾（2026-11-05）：`web_search` / `tool_search` 也进 lean 档，B08 判定完成**
`web_search`（full 295 chars）与 `tool_search`（full 402 chars，是 deferred 子代理组的唯一入口）此前
只有单档；补了 lean 版并压到「≤ full 的 60%」预算内（234→最终 175，290→最终 205 区间，`--check` 通过）。
**真实 A/B（用生产同一条 `buildProviderToolDeclarations` 构建 27 个 TUI 可声明工具，仅切
`contextWindowTokens` 32k/200k）**：lean 档声明正文 **7,173 → 6,848 chars**（−325 chars ≈ **−81 tokens**，−4.5%）；
full 档 10,872 chars 不变（新增 lean 不影响 full）。`node scripts/measure-tool-surface.mjs --check` PASS
（49 工具 / 4 场景 / 7 scope）。
**诚实边界**：B08 验收还要求 `npm run bench -- --samples 3` 的 PASS 率不降、以及每工具描述的否定段断言；
二者仍未跑（本机无 bench API key）→ **bench-unverified**。至此 B08 的描述分档工作全部落地：
否定段 ✅、热编码工具 lean ✅、`web_search`/`tool_search` lean ✅。

**B17 REPL 运行中不可中断（2026-11-05 完成）**
**问题**：真实 PTY 探针显示 REPL（`MOSS_NO_TUI=1`）里按 Esc / Ctrl+C 都不中断运行中的这一轮——2.5s 内
provider 继续发出 95/98 个 token、无客户端断开、无 `Interrupted`。原因：readline 接管了 stdin，运行期没有
注册按键或信号处理；`withCliRunCancellation` 只挂在 headless 路径。
**修复**：`repl.ts` 新增 `runReplTurn`，在一次运行的存续期内接管中断：`process.on('SIGINT')` + readline 的
`'SIGINT'`（^C 被 readline 截获时走它）+ `process.stdin` 的 `data` 监听（**只有单字节 0x1b 才算 Esc**，
方向键 `\x1b[A` 等多字节序列不算），把 AbortSignal 传给 `runOneShot`；finally 里全部摘除。三处主运行点
（普通消息、custom/skill 命令、REPL 命令的 submitPrompt）都改用该包装。
**真实证据（同一 PTY 探针，慢流 stub 每 20ms 一个 token）**：
| 按键 | 按下后 2.5s 新增 token | 客户端断开 | `Interrupted` 提示 |
| --- | --- | --- | --- |
| Esc | **1**（仅 in-flight） | 有 | 有 |
| Ctrl+C | **1** | 有 | 有 |
| ↑ 方向键（`\x1b[A`） | 95（不中断，无误报） | 无 | 无 |
| 正常运行 | 完整跑完 `FINAL-ANSWER`，**无**误报中断 | — | — |
文案随之恢复为统一口径（`/stop`：`Esc (or Ctrl+C) interrupts the current run`，REPL 实测确认），
B17 关闭。

**B17 回归保护（2026-11-05，本轮）：`verify` 新 stage `repl-interrupt`**
新行为没有门禁就会回退，所以把它做成 verify stage（仓库规矩：回归保护用 verify stage，不建 spec 套件）：
真实 PTY 驱动 REPL + 本地慢流 stub，三次运行——Esc 必须停流（客户端断开 + `Interrupted` 提示）、
Ctrl+C 必须停流、上方向键 `\x1b[A` **不得**停流（防止把转义序列误判成 Esc）。
**证据**：`npm run verify` PASS **36.4s**（含该 stage 9.8s，仍在 60s 预算内）；单独跑 `--stage repl-interrupt` PASS 11.7s。
**负向证明（红）**：把 `dist` 复制一份、删掉编译产物里 `process.stdin.on('data', onStdinData)` 这一行，
用 `MOSS_VERIFY_CLI_ENTRY` 指向它 → stage **FAIL**（`[verify] FAIL repl-interrupt`），证明该 stage 能捕获回退。

## 2.5 状态审计（2026-11-05）：总表已大面积过期，多数条目其实已落地

本轮逐条 `grep` 真实源码核对 §1/§2 的状态列，结论是**表里写的「未做/未开始」大多已经实现**。
以后认领前先看这张审计表，别再按旧状态重复开工（这正是本轮该做的事：先让队列可信，再谈优化）。

| ID  | 表里旧状态                   | 审计结论                               | 证据（本轮实读）                                                                                                                                                                                                                          |
| --- | ---------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A3  | 未开始                       | **已落地**                             | `src/cli/loop-command.ts`（`moss loop --until`）+ `command-dispatcher.ts:345` 的帮助文案                                                                                                                                                  |
| A4  | 未做                         | **已落地**                             | `moss-agent.ts:1722` `createVerificationCompletionGate` + `config.verificationGate===false` 关闭；`cli/config.ts:2511-2519` 的 `MOSS_VERIFICATION_GATE` 与来源解析；`config-commands.ts:88-89` 展示                                       |
| A5  | 未做                         | **已落地**（上限为 5，不是条目写的 3） | `core/task/task-engine.ts:80` `DEFAULT_MAX_REPAIR_ATTEMPTS = 5`、`:546/:647` 使用；`record_repair` 提示在 `:188`                                                                                                                          |
| B04 | P1 未做                      | **已落地**                             | `contracts/prompts/plan-mode-prompt.ts` 明写 `exit_plan`；`core/loop/plan-completion-gate.ts` 强制「不是散文式的 shall I proceed」；`core/tools/tool-catalog.ts:33` `PLAN_ONLY_TOOL_NAMES`                                                |
| B05 | P1 未做                      | **已落地**                             | `core/tools/deferred-tool-offer.ts`：`TASK_DEFERRED_TOOLS` 六件套按意图/台账/宿主显式请求揭示                                                                                                                                             |
| B06 | P1 未做                      | **已落地**                             | `cli/project-instructions.ts:323-363`：只有 `description` 的规则归为 `manual`，需 `@rule:<name>` 触发（正是条目说的「意图被反转」的修法）                                                                                                 |
| B07 | P1 未做                      | **已落地**                             | `core/subagent/spawn-profile.ts:130-143`：授权边界段 + 绝对路径契约                                                                                                                                                                       |
| B10 | P2 未做                      | **已落地**                             | `core/skills/skill-catalog.ts:50-88` + `skill-usage.ts`：`usageAware` 先按计数排序，未用过的才按字母                                                                                                                                      |
| B11 | P2 不可续跑                  | **已落地**                             | `tools/create-subagent.ts:327/401/422` 保留子会话供 `subagent_resume` 续跑                                                                                                                                                                |
| B12 | P2 无分阶段计时              | **已落地**                             | `MOSS_STARTUP_TIMING=1` 输出 entry/proxy/config/env/prompt/agent/mcp/probe/skills/total；另加了 `bin/moss.cjs` 启动行                                                                                                                     |
| B14 | P0 全串行                    | **已落地**                             | verify 改为依赖调度并发（`VERIFY_CONCURRENCY` 默认 4）；本会话实测 `npm run verify` **PASS in 41.8s**                                                                                                                                     |
| B15 | P2 `/context` 看不到工具成本 | **已落地**                             | `cli/context-report.ts` 用 `toolVisibleForRun` + `isDeferredToolName` 统计实际工具面 token                                                                                                                                                |
| B16 | P1 评审不自动用验收标准      | **已落地**                             | `tools/review-tools.ts:369-396`：无手填 `criteria` 时回落任务验收标准（`Task …: Acceptance criteria:`）                                                                                                                                   |
| B17 | P2 REPL 无法中断             | **已落地**                             | `cli/repl.ts` B17 段：SIGINT + 单字节 ESC + `AbortController`                                                                                                                                                                             |
| B01 | P0 图片进不了上下文          | **已完成（2026-11-05）**               | `cli/image-mentions.ts` 把消息里的 `@<图片>` 直接作为 `ChatOptions.attachments` 附进请求（视觉模型首轮见像素）；`agent.supportsImages=false`/非图片/超 3MB 时退化为 `<attachments>` 描述 + `read_image` 指引。证据见 §2.5 末 B01 收尾证据 |
| B02 | P0 压缩后旧历史不可回溯      | **已落地且已端到端验证**               | 机制在 `context/compaction.ts:256-274`（`formatHistoricalTranscriptPointer` 生成 `<historical-transcript>` 段）+ `:1198-1203` 拼接 + `core/agent/moss-agent.ts:955/1841` 传 `store.transcriptPath`；端到端探针见本节末                    |
| B08 | P2 工具描述单档              | **已落地（审计更正）**                 | `tools/file-tools.ts:210-216` 的 `description` 已以否定段结尾（目录→list_directory、图片→read_image、找匹配→search_code），`metadata.leanDescription` 同内容；见 §2.5 审计                                                                |
| B09 | P2 大结果只有 exec 落盘      | **已落地且已验证**                     | 后续由 `context/tool-output-spill.ts` 的 `truncateWithRecoveryPath` 收口（循环侧 `agent-loop-tool-execution.ts:315` 对所有工具生效）；见 §2 B09 行                                                                                        |
| B18 | P2 启动慢在模块加载          | **已大幅推进**                         | `bin/moss.cjs` 启动行（交互首字节 777→68.9ms）、懒加载设备注册表/斜杠命令图、barrel 直连、REPL 历史；剩余空间见 B18 段落                                                                                                                  |

**新的队列结论（本轮更新三次审计）**：B02、B09、B08 都已从「仍缺」改为**已实现/已验收**（证据见下）。
**§2 的 18 条到此没有真正的未做项**，B01 是唯一「部分完成」（贴图仍要模型再 `read_image` 一次）。
这意味着队列需要**新鲜条目**；本轮据此新增两条来自真实代码扫描的候选（见下），下一轮从 B19 开始。

**B20 第二片（2026-11-05，已实跑）**：工具超时与 LLM 流错误原来只报原因。现在：

- `execute-tool-call.ts` 的三处超时错误带 hint：`Narrow the call (page a file with offset/limit, shorten the command) and retry, or run long work with exec_background and poll it with exec_logs/exec_wait. The default per-call limit is 5 minutes.`
- 关键发现：hint 只挂在抛出的 `MossError` 上时**模型看不到**（工具结果文本不带 hint）。改为「失败的工具结果文本自动追加 `err.hint`」，一条改动让所有工具错误的 hint 都能被模型读到（已在 policy-blocked 结果里做去重）。
- `agent-loop-stream-helpers.ts` 的 `LLM stream error` 带 hint（重试 → 检查 base URL/API key（`moss config get`）→ 代理（`HTTP(S)_PROXY` / `NO_PROXY`）→ `moss doctor`）。
  **探针（SDK + 脚本化 provider，真实超时）**：`MossAgent({toolTimeoutMs: 400})` + 让模型调 `exec {"command":"sleep 5"}`，真实 0.4s 超时；
  模型在第二轮看到的工具结果文本为 `Execution error: Tool exec timed out (0.4s)` **换行**上述 hint（`containsHint: true`）。

**B20 证据（2026-11-05 首片，已实跑）**：`dist` 直接触发四条真实失败路径，全部渲染成 `message` + `→ hint`：

- 沙箱逃逸（`../outside.txt`）→ `Tools may only touch paths inside the workspace: use a workspace-relative path, copy the file in first, or ask the user to widen permissions (permissions.defaultMode: "full" or --full-access) and retry.`
- 工作区内符号链接指向 `/etc/hosts` → 提示指向 realpath 或放宽权限；
- 设备 exec 失败（伪连接注入 ssh2 错误）→ `Re-check the device with device_probe (reachability, command exists), then retry; a dropped connection is re-established automatically.`；
- 设备 `readFile` stat 失败 → `Confirm the path exists on the device (device_file_list lists directories), then retry.`
  修的过程中发现并修掉一个真 bug：`uiText(en, zh)` 的参数顺序被写反（3 处 hint 曾输出中文而 message 是英文），已统一为与 message 同语言。

**B19 证据（2026-11-05，已实跑）**：用 stub 掉的 `fetch` 触发 6 条失败路径（Brave 401 / Bocha 429 / Exa 503 /
Brave 非 JSON / 传输失败 ENOTFOUND / 300ms 超时），`dist` 里全部渲染成 `message` 换行 `→ hint`，例如：

- `web_search: Brave returned HTTP 401` → `Brave rejected the credential: set BRAVE_API_KEY (or pass the key explicitly), then retry.`
- `web_search: provider timed out after 300ms` → 建议检查网络/代理（`HTTP(S)_PROXY` / `NO_PROXY`）、用 `web_fetch` 兜底、或配置 provider key。
  文案单例化在 `SEARCH_TRANSPORT_GUIDANCE` 与 `searchHttpStatusHint()`，避免各 backend 各自漂移。

**B08 证据（2026-11-05，dist 实测）**：`readFileTool.description` 含
`Not for directories (list_directory), images or screenshots (read_image), or finding unknown matches across files (search_code).`，
`metadata.leanDescription` 同样带否定段 —— 即「何时不要用」的档位早已在默认面与 lean 面都存在。

**新增候选（2026-11-05，来自 `new MossError` 全量扫描：114 处，仅 44 处带 `hint:`）**

| ID   | 优先级 | 改进点                                                                                                                                                                                                                                                                                                                                                                                                                                      | 现状证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 验收探针                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 状态                                                                                                                               |
| ---- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| B19  | P2     | `web_search` 系列失败只报「超时/HTTP 状态」，不给下一步（换 backend / 设 key / 重试）                                                                                                                                                                                                                                                                                                                                                       | **已修（2026-11-05）**：`tools/web-search/http.ts` 新增 `SEARCH_TRANSPORT_GUIDANCE` + `searchHttpStatusHint()`；`fetchWithTimeout` 的超时/请求失败、`backends-api.ts` 的 Brave/Bocha/Exa HTTP 状态与非 JSON 响应都带 `hint`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 已实跑：stub 掉 `fetch` 触发 6 条失败路径，全部渲染为 `message\n→ hint`（证据见本节末）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | **已验收**                                                                                                                         |
| B20  | P2     | 用户可感知的报错里仍有约 70 处 `new MossError` 没有 `hint`（失败后没有下一步）                                                                                                                                                                                                                                                                                                                                                              | **基本完成（2026-11-05，两片）**：首片补沙箱 4 处 + 设备运行时 4 处；第二片补「工具超时」3 处（`execute-tool-call.ts`）与「LLM 流错误」1 处（`agent-loop-stream-helpers.ts`），并让**所有** `MossError.hint` 自动进入模型可见的工具结果文本                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 已实跑：沙箱/设备/工具超时三条路径都渲染 `message` + `→ hint`；见本节末 B20 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | **已验收**                                                                                                                         |
| B21  | P2     | `moss --version` 要加载整个 runtime 图（~320ms）才打印一行：CI/脚本里调用昂贵                                                                                                                                                                                                                                                                                                                                                               | **已修（2026-11-05）**：`src/cli.ts` 在 import `cli-main.js` 前识别 `-v/--version`（`--` 之前、且无 `-h/--help`），只加载 `utils/package-info.js` + `cli/color-level.js` 直接打印；颜色检测抽到 `cli/color-level.ts` 供 bootstrap 与快路径共用                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 实测 `--version` 墙钟 **320.2ms → 76.6ms**（8 次 spawn 取中位）；TTY 下输出与旧 `displayVersion()` 一致（`\x1b[1mmoss\x1b[22m \x1b[36m…`），`-- --version` 仍作为 payload 送模型，`-p` 路径正常                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| B22  | P2     | 技能目录只裁 `description`：单个技能的 `when` 是段落时能吃满预算，把别人挤成 name-only（Claude Code 每条约 1,536 字符上限）                                                                                                                                                                                                                                                                                                                 | **已修（2026-11-05）**：`core/skills/skill-catalog.ts` 增加 `SKILL_CATALOG_WHEN_MAX_CHARS=240` 与 `SKILL_CATALOG_ENTRY_MAX_CHARS=1536`；`when` 走 `clip()`，整行超出 1,536 时截断并以 `…` 结尾                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 实测见本节末 B22 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| B23  | P1     | headless `-p` 会在首轮前**同步等待** 4s 的 context-window 探测：`/v1/models` 慢/挂时整轮白等（Cursor/Claude 不让可选元数据挡首字）                                                                                                                                                                                                                                                                                                          | **已修（2026-11-05）**：`cli/runtime.ts` 抽出 `STARTUP_CONTEXT_PROBE_TIMEOUT_MS = 1500` 替换原 4000；超时仍走「保守未探测窗口」路径（与探测失败等价）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 实测：慢 `/v1/models`（3s）下 `-p` 墙钟 **3679ms → 2119ms**；健康端点仍只探测 1 次、墙钟 589ms、`probe=185ms` 阶段正常                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| B24  | P2     | 配置层 hook 只有 `PostToolUse`（所有调用都触发，含失败），没有 Claude Code 的 `PostToolUseFailure`：想只对失败告警/记账必须在 hook 里自己判 `isError`                                                                                                                                                                                                                                                                                       | **已落地并验证（2026-11-05）**：`HooksConfig` + `HOOK_EVENT_KEYS` + `hook-event-names.ts` 新增 `PostToolUseFailure`；`cli/hooks.ts` 在 `isError` 时额外触发（`PostToolUse` 语义不变，仍覆盖每次调用）；`docs/hooks.md` 事件表补行                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 实测：失败工具 → `post`+`failure` 两条 payload；成功工具 → 只有 `post`（`isError:false`）；`npm run check` 绿、`npm run verify` PASS 40.6s                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| B25  | P1     | **原生 hook matcher 用正则兜底**：`"matcher": "exec"` 会连带命中 `exec_logs`/`exec_wait`/`exec_background`（无锚点前缀），Claude Code 对纯字母数字词视为精确名 → 一个工具写的钩子悄悄覆盖兄弟工具                                                                                                                                                                                                                                           | **已修并验证（2026-11-05）**：`cli/claude-compat.ts` `hookMatcherMatches` 两种 format 都先走「纯词 = 精确名/`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | `,`,` 列表」，其它字符才是正则；`docs/hooks.md` 写清 matcher 语义                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 12/12 matcher 用例 + 真实 e2e（matcher `exec`：`exec` 触发、`exec_logs` 不触发）；`npm run check` 绿、`npm run verify` PASS 40.1s  |
| B26  | P1     | `/skills` 的下一步提示是 `moss skill validate <skill 名>`，但 `validate` 只按**路径**解析 → 用户级技能（`<configDir>/skills/x`、`~/.claude/skills/x`）照抄这条命令必然报 "no SKILL.md at <workspace>/x"（提示即假承诺，同 B01 形状）                                                                                                                                                                                                        | **已修并验证（2026-11-05）**：`cli/skill-commands.ts` 的 `validate` 在路径不存在且参数是裸名时，按 runtime 同一套发现范围（workspace → `.agents`/`.claude` → configDir → `~/.claude`）解析名称；找不到时列出全部搜索目录并提示可传路径                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 实测：工作区名 ✅、用户级名 ✅、未知名称 exit 2 列出 5 个目录、显式路径不变、无参数打印用法；`npm run check` 绿、`npm run verify` PASS 39.3s                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| B27  | P2     | hook 缺 Claude Code 的 `if` 字段：只能用 `matcher` 按工具名筛，无法再按**操作数**窄化（只对 `git *`、只对 `.env`），只能进钩子脚本自己判断                                                                                                                                                                                                                                                                                                  | **已落地并验证（2026-11-05）**：`HookCommandConfig.if` + `cli/hooks.ts` `createHookIfMatcher()`（复用 `permission-rules.ts` 的 `parsePermissionRuleSpec`/`matchPermissionRule`/`extractRuleOperand`）；非工具事件带 `if` 会被移除并提示，非法 spec 跳过该钩子并提示；`PermissionDenied` 现在也带 `input` 供 `if` 判定                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 实测：`if:"exec(git *)"` 的 Pre/Post 钩子只对 `git status --porcelain` 触发（`echo hi` 不触发）；非法 `if` 跳过+提示；`SessionStart` 带 `if` 被移除+提示；`npm run check` 绿、`npm run verify` PASS 39.1s                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| B28  | P2     | hook 只有 `command` 一种 handler：Claude Code 有 command/http/mcp_tool/prompt/agent；想让 Moss 把事件推给本地服务或 CI 只能再包一层脚本                                                                                                                                                                                                                                                                                                     | **已落地并验证（2026-11-05）**：`HookCommandConfig` 增加 `type:'command'                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 'http'`、`url`、`headers`（`command` 变为可选）；`cli/hooks.ts`新增`runHook()`分发 +`runHookHttp()`（POST 同一 JSON、2xx 记成功且响应体等同 stdout 参与 decision 解析、非 2xx 记非零 → 阻塞事件 fail-closed、`AbortSignal.timeout`走超时路径）；所有 17 处调用点改走`runHook`，通知文案用 `hookTarget()`（command 或 url）；`docs/hooks.md` 写清两种 handler                                                                                                                                                                                                                                                                                                                                                                                                             | 实测见 B28 证据；`npm run verify` PASS 40.8s（hooks-contract 全绿）                                                                |
| B29  | P2     | B20 余量：MCP 传输层 12 处失败仍无 `hint`（缺 command/url、连接中途退出、连接已关、非 JSON 正文、SSE 断开、服务器拒绝请求），用户只看到原因没有下一步；`is not connected` 的 hint 依赖 `_lastError`，为空时整条消失                                                                                                                                                                                                                         | **已修并验证（2026-11-05，B20 第 3 片）**：`core/mcp/stdio-transport.ts` + `http-transport.ts` 共 12 处补 `hint`（指明 `moss mcp list` / mcp.json 字段 / 改 stdio / 重开会话）；`is not connected` 改为 `_lastError ?? 兜底文案`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 实测 4 类真实失败均渲染 `→` 提示；`npm run check` 绿、`npm run verify` PASS 39.4s（`mcp-protocol` stage 全绿）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| B30  | P1     | **stdio 传输丢弃 server→client 请求**：服务器发来的 `ping` / `roots/list` / `sampling/createMessage` 带 id 但没有对应 pending，被静默 `return` —— 服务器等不到应答（可能放弃连接或超时），MCP 协议层面不合法                                                                                                                                                                                                                                | **已修并验证（2026-11-05）**：`core/mcp/stdio-transport.ts` `handleLine` 先判 `typeof msg.method === 'string'` → `answerServerRequest()`：`ping`→`{}`、`roots/list`→`{roots:[]}`、其它→JSON-RPC `-32601 method not supported by moss`；`types.ts` 的 `InboundJsonRpcMessage` 补 `params`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 实测：改造前 stub 服务器收不到任何应答（log 文件不出现）；改造后收到 `ping:{result:{}}`、`roots:{result:{roots:[]}}`、`sampling: error -32601`；`npm run check` 绿、`npm run verify` PASS 39.4s                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| B31  | P1     | Claude Code 会**在启动时警告**「`*` 出现在子命令之前」的 allow 规则（`Bash(git * main)` 也能匹配 `git push main`，见 research §8.2）；Moss 的 `auditResolvedCliConfig` 只审 `trustedTools` 宽通配，`permissions.allow` 的中段通配静默通过                                                                                                                                                                                                   | **已修并验证（2026-11-05）**：`cli/config.ts` 新增 `isOverbroadAllowRule()` + audit code `permissions.broad_allow_pattern`（allow 列表里 `*` 不在末尾或为 `exec(*)` 时告警，末尾前缀族 `exec(git log *)` 不告警）；`cli/doctor.ts` 给该 code 专属标签 `allow rules`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 实测 4 组 doctor 输出见 B31 证据；`npm run check` 绿、`npm run verify` PASS 40.8s                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| B32  | P2     | headless `-p` 白加载 TUI 渲染图：`cli/output.ts` 只为拿一个常量 `DIFF_PREVIEW_LINES` 就静态 import `cli/tui/transcript.js`，连带 transcript/composer/markdown/code-style/theme 进每次 `-p`                                                                                                                                                                                                                                                  | **已修并验证（2026-11-05）**：常量移到 `cli/diff-preview.ts`（3 行注释说明为何独立成模块），`output.ts` 改从该模块取；`tui/transcript.ts` 保留 re-export 供 TUI 内部使用                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | dist 模块数 377 → 370（−8 个渲染模块 +1 个 3 行常量模块）；`-p` 墙钟中位 583ms → 606ms（7 次采样，属噪声，**不宣称更快**）；`-p` 改动 `edit_file` 的 headless diff 预览仍按 14 行截断并打印 `... 27 more lines ...`；`npm run verify` PASS 41.2s                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| B33  | P2     | B32 续：`runtime.ts`/`doctor.ts`/`command-dispatcher.ts` 从 `cli/tui-utils.ts` 这个 **barrel** 取两个小函数，而 barrel 用 `export *` 静态重导出 `repl-process`/`repl-chrome`/`command-completion`/`transcript-types` —— headless 也白加载整条 REPL 图                                                                                                                                                                                       | **已修并验证（2026-11-05）**：新增 `cli/session-format.ts` 放 `formatSessionTimestamp` + `humanTokens`；dispatcher/tasks-commands/doctor 改指该模块；`repl-chrome` 保留 re-export；`runtime.ts` 改从 `cli-locale.ts` + `interactive-commands.ts` 直接取 `cliLocale`/命令表，不再 import barrel                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | dist 模块数 370 → 367（再减 `repl-process`/`repl-chrome`/`transcript-types`/`tui-utils`）；行为实测见 B33 证据；`npm run verify` PASS 41.5s                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| B34  | P2     | **隐藏命令的拼写建议缺失**：`/context`、`/usage` 等是 `hidden: true`，`uniqueMenuRows()` 把它们同时排除出 menu / 补全 / did-you-mean；用户打错 `/contex` 时只得到 `unknown command`，而该命令真实存在（Claude Code 的 near-miss 提示会点名真实命令）                                                                                                                                                                                        | **已修并验证（2026-11-05）**：`cli/interactive-commands.ts` 新增 `DISPATCHABLE_SLASH_COMMANDS`（repl 面全部命令 + 别名，含 hidden；menu 与补全仍用原表）；`runtime.ts` 两处未知斜杠建议、`repl.ts` 拼写建议改用该表；`uniqueMenuRows` 注释同步（hidden 只退出 menu/前缀补全）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 实测：`-p '/contex'` → `Did you mean /context, /cost?`；REPL pipe 同结果；`/zzzzzz` 无建议（防 dump）；`/context` 仍可执行；`INTERACTIVE_COMPLETION_COMMANDS` 仍 19 条、不含 `/context`；`npm run verify` PASS 36.2s                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| B35  | P1     | **`web_fetch` 的权限规则永不生效**：`extractRuleOperand()` 没有 `web_fetch` 分支（返回 undefined），于是 `deny: ["web_fetch(domain:example.com)"]` 这类规则**静默失效**——用户从 Claude Code 迁移过来的域名拦截等于没写；同时 Claude Code 文档的 `WebFetch(domain:…)` 写法 Moss 也不解析                                                                                                                                                     | **已修并验证（2026-11-05）**：`extractRuleOperand()` 增加 `web_fetch → input.url`；`matchPermissionRule()` 支持 `domain:` 说明符（精确 host、子域、`*.example.com` 通配，URL 端口/大小写容错）；错误提示与 onboarding 示例补 `web_fetch(domain:example.com)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 实测见 B35 证据（e2e 三条 + dist 十组对照）；`npm run check` 绿、`npm run verify` PASS 39.6s                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| B36  | P2     | **更多工具的主操作数缺失，路径型 deny 规则静默失效**：B35 修好 `web_fetch` 后同类形状仍在——`read_image`、`list_directory`、`search_files`、`search_code` 都没有 `extractRuleOperand` 分支，`run_tests` 的 command 也没有；于是 `deny list_directory(./private)` 解析通过却永不匹配，私有目录照列                                                                                                                                            | **已修并验证（2026-11-05）**：提取表补 `read_image/list_directory/search_files/search_code → path`、`run_tests → command`；表注释同步                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 实测：改造前 `list_directory(./private)` / `search_code(./src)` 均 ✓ 正常执行（规则无效）；改造后均 ✗ 2ms 被 deny 规则拦下、未触盘；同配置下别的路径 `./public` 仍执行（未误伤）；dist 9 组对照（含 read_image、run_tests 正负例）全绿；`npm run verify` PASS 40.0s                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| B37  | P1     | **REPL 里 `@rule:<name>` 永远不生效**：规则扫描只做一次（`createCliPromptSetup({ initialText: process.argv.join(' ') })`），REPL 的 argv 里没有提示词，所以首轮与后续轮次的 `@rule:` 都被忽略——B06 交付的「可按需加载的 manual 规则」在交互模式下形同虚设                                                                                                                                                                                   | **已修并验证（2026-11-05）**：`prompt-setup.ts` 新增 `noteUserText()`（会话内 sticky 累加已请求规则）；`runtime.ts` 在每轮 `onInputGuardrail` 先扫该轮用户消息；`CliPromptSetup` 接口补声明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | PTY 实测：改造前「hello」→`none`、「@rule:described give me a fruit」→`none`；改造后同一会话第二轮 → `BANANA`，首轮直接 `@rule:` → `BANANA`；headless `-p` 行为不变（带 `@rule:` → BANANA，不带 → none）；`npm run verify` PASS 44.2s                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| B38  | P1     | **拼错工具名的权限规则静默失效且无处可见**：`deny: ["exce(npm run *)"]` 解析通过、`/permissions` 里显示 `deny 1` 看起来很健康，实际永不匹配（B35/B36 修的是「工具名对但操作数没提取」，这里是「工具名根本不存在」）                                                                                                                                                                                                                         | **已修并验证（2026-11-05）**：`renderCliPermissions` 新增 `knownToolNames` 选项 + `unmatchedRuleToolLines()`：字面量工具名（跳过 `*?[]` 通配）不在注册表时输出 `⚠ rule exce matches no registered tool — check the spelling; it never applies`；`/permissions` 与 `--verbose` 都显示；`registry.ts` 传 `ctx.agent.tools.getAll()`（含 MCP 工具，大小写不敏感）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | PTY 实测：改造前 `⚠` 行数 0；改造后仅拼错的 `exce` 报警，`exec(npm run *)`、大小写不同的 `Read_File(...)` 不报，通配规则 `exec*` 被跳过；`npm run verify` PASS 38.7s                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| B39  | P2     | **`/hooks` 在 REPL 里是 unknown command，且两个界面都读不到 hooks 表**：hooks 视图只写在 TUI 内联分支里；REPL 输入 `/hooks` 得到 `unknown command`（还给出错误建议 `/tasks`）；`CliRuntimeStatus.config`（resolved config）不含 `hooks`，所以 TUI 的 hooks 视图实际永远显示「no hooks configured」                                                                                                                                          | **已修并验证（2026-11-05）**：新增 `cli/hooks-view.ts`（`formatHookViewLines()`，REPL 与 TUI 共用；对字面量 `matcher` 与 `if:` 条件里的工具名做同一套「永不触发」告警）；`CliRuntimeStatus` 增加 `hooksConfig`，runtime 从 `projectCapabilities.hooks` 发布；REPL 新增 `/hooks` 分支，TUI 改调共享格式化                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | PTY 实测：改造前 `/hooks` → `[help] unknown command "/hooks"` + `Did you mean /tasks?`；改造后列出 3 条 hook，并对 `matcher: exce` 与 `if: exce(git *)` 各报一条 ⚠，`exec` / `exec(git *)` 不报；`npm run verify` PASS 41.0s                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| B40  | P2     | **REPL 里 `/mcp` 是未知命令**：MCP 服务器状态只在 TUI 的 `showBlock('mcp')` 里显示，readline REPL 输入 `/mcp` 得到 `unknown command`（B39 的 `/hooks` 同族：能力面只在 TUI）                                                                                                                                                                                                                                                                | **已修并验证（2026-11-05）**：`CliRuntimeStatus` 增加 `listMcpServers`（runtime 复用同一个 `listMcpServerStatuses()`，过滤 `deferred`），REPL 新增 `/mcp` 分支用 `formatMcpStatusLine()` 输出与 TUI 相同措辞；无服务器时给出 `moss mcp add` 指引                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | PTY 实测：配置 stub stdio server 后 `/mcp` → `● stub — connected (3 tools, lazy)`；无配置 → `no MCP servers configured (moss mcp add …)`；改造前两条路径都是 `unknown command "/mcp"`；`npm run verify` PASS 46.8s                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| B41  | P1     | **headless 的 web 工具启发式漏掉常见说法**：`WEB_ELIGIBLE_PROMPT_RE` 决定是否把 `web_search`/`web_fetch` 放进工具面（并让 `isPureChatOneShotRequest` 不把这类提示当纯聊天）；但 `look up …`、`what's new in …`、`official site`、`release notes` 等常见说法不匹配，于是模型明明需要联网却被摘掉 web 工具，只能回 `Unknown tool: web_fetch`                                                                                                  | **已修并验证（2026-11-05）**：正则补 `look (it )?up / lookup / find out (about                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | what) / browse / homepage / official (site                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | docs                                                                                                                               | page | website) / website / what's new / release notes / changelog / 官方文档 / 发版说明 / 更新日志 / 版本说明 / 下载地址` | 实测（stub 模型直接调 web_fetch + deny 规则作为「工具是否存在」的探针）：改造前 3 条提示均 `Unknown tool: web_fetch`，改造后 3 条均 `blocked by deny rule web_fetch(domain:example.com)`（说明工具已进入工具面）；对照组 `explain closures in JavaScript` 改造前后都仍 `Unknown tool`（没有把 web 工具面扩大成默认）；dist 正/负例 6+6 全绿；`npm run verify` PASS 38.2s |
| B42  | P1     | **写错的权限规则只在 `/permissions` 里才被提示**：B38 给 `/permissions` 加了「规则名不匹配任何工具」告警，但 headless 用户（`-p` / SDK / 脚本）永远不打这个视图；一条拼错的 `deny exce(npm run *)` 会静默什么都不拦                                                                                                                                                                                                                         | **已修并验证（2026-11-05）**：抽出共享 `unmatchedRuleToolNames()`（glob 与 `mcp__` 前缀跳过——前者无法精确判断，后者要等握手后才注册），`/permissions` 复用同一实现，runtime 在工具注册完成后按启动规则做一次审计并打印 `[moss] permission rule "X" names no registered tool — it never applies (fix it in /permissions)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 实测（headless `-p 'say ok'`，故意不靠 `/permissions`）：`deny ["exce(npm run *)"]` → 恰好 1 条告警；`deny ["exec(npm run *)"]` → 0；`deny ["mcp__rdk-docs__search_docs"]` → 0；`deny ["exce(…)","Run_Tests(*)","exec(*)"]` → 只报 `exce`（大小写不敏感匹配 `run_tests`）；`npm run verify` PASS 40.2s                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| B43  | P1     | **REPL 没有剪贴板附件入口**：`moss --help` 在「Inside Moss」里承诺 Ctrl+V 贴剪贴板图，但 Ctrl+V 只在 TUI composer 里实现；`MOSS_NO_TUI=1` / 非 TTY 回退的 readline REPL 无法贴图，RDK 现场最常见的输入（接线图、相机截图、报错截图）在 REPL 里只能手打                                                                                                                                                                                      | **已修并验证（2026-11-05）**：REPL 新增 `/paste [prompt]`（复用 `captureClipboardAttachment`：图片/Finder 文件/路径 → 暂存 `.moss/runtime/attachments/` 并变成 `@<relpath> <prompt>` 消息；纯文本 → 原样并入消息；空/不支持 → 打印原因且不发请求）；`/paste` 进 REPL 菜单；`moss --help` 的 Ctrl+V 行标注「TUI；REPL 用 /paste」                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | PTY 实测（macOS 真剪贴板）：设蓝色 PNG → `/paste describe the image` → 打印 `attached 118392be79c5eaae.png (1 KB) — ask moss to read_image it`，stub 模型收到的 user 消息是 `@.moss/runtime/attachments/118392be79c5eaae.png describe the image`；设文本 `error: ENOENT camera0` → `/paste why does this happen` → 消息含 `why does this happen\nerror: ENOENT camera0`；改造前 `/paste` → `unknown command` + 错误建议 `/bashes, /cost, /ps`；`npm run verify` PASS 42.7s                                                                                                                                                                                                                                                                                               |
| B44  | P1     | **文本模型收到图片时，报错指向「模型不存在」**：provider 400 `Invalid image_url: this model does not support image input` 被分类成 `model_not_found`，用户看到 `The gateway does not have this model. Pick another with /model`——原因判断错误，且没有给「设置 supportsImages=false 让 read_image 提前拦住」这个真正的下一步                                                                                                                 | **已修并验证（2026-11-05）**：`provider/error-classify.ts` 新增 category `images_not_supported` + 文案（换视觉模型 / `moss config set agent.supportsImages false`）；`matchImageUnsupported()` 覆盖能力级与 wire 级措辞；判定放在 `matchModelNotFound` 之前（transport 会给任何 400 追加「this model name is not available on the gateway」，否则永远被模型分支吃掉）；顺手补 `matchToolUnsupported` 的 `does not support tool calls` 说法                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | e2e（stub 先让模型调 read_image，再对含图请求返回 400）：改造前 `The gateway does not have this model…` + `Gateway text: Invalid image_url…`；改造后 `This model does not accept image input…` + 明确两条下一步；分类矩阵：image 措辞×2 → `images_not_supported`、tool-call 措辞×2 → `tools_not_supported`、`unexpected field` → `unknown`（不误报）；`npm run verify` PASS 43.2s                                                                                                                                                                                                                                                                                                                                                                                        |
| B45  | P2     | **Linux 上没装剪贴板工具时，`/paste` 只说「剪贴板里没有内容」**：图片与文本都走 `wl-paste`/`xclip`，两者都缺时 `captureClipboardAttachment` 返回 `clipboard has no image, file or text` —— 用户会去检查剪贴板，而真正的修法是装 `wl-clipboard` 或 `xclip`                                                                                                                                                                                   | **已修并验证（2026-11-05）**：`missingLinuxClipboardTool()` 用 `command -v wl-paste` / `command -v xclip` 判定，两者都缺时返回 `no clipboard tool found — install wl-clipboard (wl-paste) or xclip to paste on Linux`（macOS/Windows 路径不变）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | dist 直调（`platform:'linux'`，本机无这些工具）：改造前 → `clipboard has no image, file or text`；改造后 → 安装提示；负例（PATH 里放一个假 `wl-paste`）→ 仍返回通用 `clipboard has no image, file or text`（不误报）；`npm run verify` PASS 40.9s                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| B46  | P2     | **`/doctor` 不报 MCP 与 hooks 状态**：两个最强大的配置面（MCP 服务器、9 个生命周期 hook）在诊断报告里完全没有行；MCP 挂了、hook matcher 写错了，用户只能分别去 `/mcp`、`/hooks` 一个个查                                                                                                                                                                                                                                                    | **已修并验证（2026-11-05）**：`renderCliSessionDoctor()` 增加 MCP 行（`ok MCP: 1/1 connected`，有 failed 则 `warn MCP: 0/1 connected; failed: broken — see /mcp to retry…`）与 hooks 行（`ok hooks: 3 hooks on 1 event` + 复用 `hookEntryWarnings()` 的逐条 ⚠）；数据直接取 B39/B40 已发布的 `hooksConfig` / `listMcpServers`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | PTY `/doctor` 实测：改造前输出里没有 MCP/hooks 行（只有 node/version/model/provider/auth/egress/approval）；改造后挂 stub MCP → `ok MCP: 1/1 connected`、hook 配置 3 条 → `ok hooks: 3 hooks on 1 event` + 两条 `warn hooks: ⚠ matcher "exce" …`、`warn hooks: ⚠ if condition …`；把 MCP 命令改成必失败的 stub → `warn MCP: 0/1 connected; failed: broken — see /mcp to retry, check the command in mcp.json`；`npm run verify` PASS 38.1s                                                                                                                                                                                                                                                                                                                               |
| B47  | P2     | **`moss doctor`（独立子命令）完全不看 mcp.json**：`/doctor`（B46）已报实时 MCP 状态，但可脚本化的 `moss doctor` 只查 config/auth/workspace/search/approval；mcp.json 里写坏的条目（stdio 缺 `command`、条目不合法）要到第一次真正需要该服务器时才暴露                                                                                                                                                                                       | **已修并验证（2026-11-05）**：`renderMcpConfigDoctor()` 静态审计用户 `<configDir>/mcp.json` 与项目 `.moss/mcp.json`（项目文件仅在文件夹已信任时读取，否则明确提示「忽略中，用 /trust 启用」），输出 `ok MCP config: N server(s): …`、逐条 `warn MCP config: [mcp] skipping server …`，条目全坏时说 `no valid servers (see below)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | `node bin/moss.cjs doctor` 四态实测：无 mcp.json → 无 MCP 行（保持安静）；用户级合法 → `ok MCP config: 1 server: stub`；条目缺 `command` → `ok MCP config: no valid servers (see below)` + `warn … skipping server "bad" … stdio transport requires "command"`；项目级 + 未信任 → `warn … project .moss/mcp.json is ignored until this folder is trusted`；写 `workspace-trust.json` 信任后 → `ok MCP config: 1 server: proj`；`npm run verify` PASS 49.0s                                                                                                                                                                                                                                                                                                               |
| B48  | P2     | **写在未知事件名上的 hook 被静默丢弃**：`mergeHooksConfig()` 只按 `HOOK_EVENT_KEYS` 合并，`hooks.PreToolUseTypo`（拼错）或 Claude-only 事件名会被无声丢掉——配置看着「已配」，实际永不触发；`moss doctor` 也不报                                                                                                                                                                                                                             | **已修并验证（2026-11-05）**：`renderHookConfigDoctor()` 读用户配置（项目配置仅信任后读）里的 `hooks` 段，未知事件名逐条 `warn hooks: … on "X", which is not a Moss event — they never fire (events: …)`，并汇总 `ok hooks: N hooks on M events (config files)`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | `moss doctor` 实测：无 hooks → 无 hooks 行；`PreToolUseTypo` → 1 条 warn 并列出全部 14 个合法事件；混合（1 条合法 + `ZzzEvent`）→ 1 条 warn + `ok hooks: 1 hook on 1 event`；2 条合法 → `ok hooks: 2 hooks on 2 events`；改造前同一 typo 配置 → 0 行（完全静默）；`npm run verify` PASS 49.9s                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| B49  | P2     | **hook 的 `matcher`/`if` 写错工具名，`moss doctor` 不报；同时 `mcp__…` 匹配器在两处视图被误报**：B48 只查了事件名，条目级（matcher / `if:` 条件）写错仍是静默哑火；而 `hooks-view.warnsAboutTool()` 不认 `mcp__` 前缀，导致合法的 MCP 工具 hook 在 `/hooks`、`/doctor` 里被误报「永不触发」（MCP 工具握手后才注册）                                                                                                                         | **已修并验证（2026-11-05）**：`moss doctor` 的 hooks 段现在用 `builtinTools` + 工作区 `.moss/tools/*.tool.json` 的真实工具名做条目级审计（`hookEntryWarnings` 复用，`user:`/`project:` 前缀标明来源）；`warnsAboutTool()` 对 `mcp__` 前缀豁免（与 B42 的规则审计一致）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | `moss doctor` 五态实测：合法（`exec` + `if: exec(git *)`）→ 只有 ok 行；`matcher: exce` → `warn hooks: user: ⚠ matcher "exce" on PreToolUse matches no registered tool`；`if: exce(git *)` → `warn … if condition … names unknown tool "exce"`；matcher 指向自定义 `.moss/tools/my.tool.json` 工具 `my_tool` → 不报（真实加载名字）；`matcher: mcp__rdk-docs__search_docs` → 不报（修复前会误报）；`npm run verify` PASS 40.8s                                                                                                                                                                                                                                                                                                                                           |
| B50  | P1     | **图片被网关拒绝后整个会话永久失效**：文本端点对「任何含图片的请求」都回 400；一次误附图片后，历史里那条图片让之后**每个**后续请求都 400（重试在工具执行前就失败），用户只能 `/clear` 重开——B44 只改进了错误文案，没让会话恢复                                                                                                                                                                                                              | **已修并验证（2026-11-05）**：新增 `src/provider/image-capability.ts`（进程内单向标记，由 `classifyProviderError` 判定 `images_not_supported` 时置位，adapter 与 stream-parser 两条路径都记）；`piMessagesToOpenAI()` 在标记置位后把历史图片块换成文本占位符 `[image omitted: …]`（transcript 仍保留图片，换视觉模型后新进程可复用）；`read_image` 守卫同时查标记，后续新附件直接本地解释、不再发请求；`COPY.images` 文案补一句「本会话后续请求用文本占位符代替图片」                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | PTY 双轮实测：改前第 1 轮 400、第 2 轮**同样的 400**（`image_requests=2`，会话卡死）；改后第 1 轮 400 文案含新句，第 2 轮正常 `done`，且 `image_requests=1`、第 2 轮请求体里图片块变成 `[image omitted: this endpoint rejected image input earlier in this session]`；模块级探针：置标记前 `prepareImageInput` 返回 `image` 块，置标记后返回本地拒绝文案（不发图片）；`npm run verify` PASS 45.7s                                                                                                                                                                                                                                                                                                                                                                        |
| B51  | P1     | **B50 的副作用：`/model` 换到视觉模型后图片仍被拦**——进程内「端点拒绝图片」标记是单向的，同进程 `/model vision-m` 之后仍然把历史/新图片换成占位符，视觉模型永远收不到图（用户看到的是换模型也没用）                                                                                                                                                                                                                                         | **已修并验证（2026-11-05）**：`image-capability.ts` 新增 `resetProviderImageRejection()`，在 `MossAgent.switchModel()` 里调用——所有宿主（TUI `/model`、REPL `/model`、`/model config`、setup 保存）都走这个入口，换模型即清空上一端点的判定，重新用「真发一次」探测                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | PTY 实测（stub 双模型：`m` 拒绝图片 / `vision-m` 接受）：轮 1 → `m` 400；`/model vision-m`；轮 2 读图。改前 `image_requests=1, image_accepted=0`（换视觉模型后仍没发图）；改后 `image_requests=2, image_accepted=1`（`vision-m` 收到图片并正常完成）；`npm run verify` PASS 41.0s                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| B52  | P2     | **B50/B51 的占位符只「说明」，不「指导」**：模型拿到的只是 `[image omitted: …]` 一句陈述，用户问「我刚才那张图是什么」时模型可能凭空编造；`read_image` 的本地拒绝文案也还写着「set agent.supportsImages true 并重开会话」，与 B51 的「换模型即可重探」不一致                                                                                                                                                                                | **已修并验证（2026-11-05）**：占位符改成带行动指令的两句（「如果用户问的是这张图，就说明该端点不收图片，建议 `/model` 换视觉模型或用文本描述——不要猜内容」）；`read_image` 拒绝文案改成「判定跟着端点走，不跟进程走：用 `/model` 换视觉模型可重探，或 `moss config set agent.supportsImages false` 把这拒绝设为默认」                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | PTY 双轮 + `DUMPREQ` 实抓第 2 轮请求体：`placeholder_requests=1`，实际发出文本 = `[image omitted: … If the user asked about this image, say that the configured endpoint cannot accept images and suggest a vision model (/model) or describing it in text — do not guess what it shows.]`；模块探针置标记后 `prepareImageInput` 返回的新文案含 `/model` 与「verdict follows the endpoint」；`npm run verify` PASS 40.6s。**同轮负结果**：`-p` 启动白加载本轮实测不成立——在 `dist/cli/config.js` 已加载后，`interactive-commands` 边际 2.6ms、`command-completion` 0.7ms、`help` 1.3ms（此前的 65–91ms 是 Node loader 冷启动的假象，config.js 闭包仅 50 模块/7 node_modules），后续不要再排「把 interactive-commands 变懒加载」这类项                                    |
| B53  | P2     | **CLI 命令面三处漂移**：①`moss --help --all` 自称完整参考，却漏了 `auth`/`update`/`loop`/`review`/`remember`/`rules` 六个可运行子命令；②`args.ts` 的「安装/认证动词别名」`login`/`logout`/`install`/`upgrade` 是**死代码**——只做 did-you-mean 建议，`moss logout` 直接 `unknown command 'logout'` 退出 2；③裸 `moss auth` 打印 usage（exit 2）而不是状态                                                                                    | **已修并验证（2026-11-05）**：`COMMAND_ALIASES` 在执行层解析（`logout→auth logout`、`login/install→setup`、`upgrade→update`，`findCommand` 带 `aliasArgs` 注入）；裸 `auth` 默认打印状态；help 中英各补 4 行（auth/update、loop/review、rules/remember、别名说明）并补 `uninstall` 的中文缺失；补 `setup`/`config`/`sessions`/`auth` 的 dispatcher description；新增 verify stage `help-surface`（18 命令必须在中英子命令段出现 + 别名必须执行）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 改前：`moss logout` → `unknown command 'logout' … Did you mean 'auth'?` 退出 2；改后 `[auth] No API key is stored.` 退出 0；`moss upgrade` 打印升级命令退出 0；裸 `moss auth` 打印状态退出 0；`moss login` 进入 setup；`--help --all` 中英均列出六个新命令 + 别名行；负向控制：临时删掉 rules/remember 帮助行并重建 → `help-surface` 失败并点名 `rules`、`remember`，恢复后 `ok in 0.1s`；`npm run verify` PASS 48.9s                                                                                                                                                                                                                                                                                                                                                    |
| B54  | P3     | **`moss <命令> --help` 不一致**：B53 让六个命令进了帮助，但 `moss rules --help` / `moss remember --help` 仍然回退到根 banner（`renderSubcommandHelp` 缺这两个 case），而 review/loop/auth/update 都打印自己的用法——用户按「完整参考」去查规则/记忆怎么用却看到首页                                                                                                                                                                          | **已修并验证（2026-11-05）**：`subcommand-help.ts` 增加 `rules`（`renderRulesUsage`）与 `remember`（`renderRememberUsage`）两个 case；`help-surface` stage 增加断言「18 个命令的 `--help` 必须返回非空用法，不许回退到根帮助」                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 改前 `moss rules --help` / `moss remember --help` → 根 banner（`Most useful`）；改后分别打印 `Usage: moss rules list [--json] …`、`Usage: moss remember "<fact>" … --dry-run …`，中文同样（`用法：…`）；负向控制：临时删掉这两个 case 重建 → stage 失败并点名 `rules`、`remember`（另带出被同段删除的 `loop`，说明断言覆盖的是全部命令而非白名单），恢复后 ok；`npm run verify` PASS 43.4s                                                                                                                                                                                                                                                                                                                                                                               |
| B55  | P2     | **斜杠目录与 REPL 实际分派漂移**：`interactive-commands.ts` 是数据、`repl.ts` 是代码，二者无联系。`/queue`、`/steer`（只存在于 TUI 的“运行中输入”能力）被标成 REPL 可回答，于是 REPL 的 did-you-mean 建议里会推荐一个输入后回 `unknown command` 的命令；另有重复的 `/skills` 隐藏行（同段还有一个可见行）与 `RETIRED_SLASH` 里指向自身、REPL 却跑不了的 `/steer`/`/queue` 条目                                                              | **已修并验证（2026-11-05）**：`/queue`、`/steer` 加 `surfaces: ['tui']`；删除重复的隐藏 `/skills` 行与两条自指 retired 条目；新增 verify stage `slash-dispatch`：静态断言（目录无重复行、TUI-only 行不得出现在 REPL 列表/建议池）+ 动态 PTY 探针（真 REPL 逐条敲完 29 个目录命令，任何 `unknown command` 即失败，2.1s，Windows/无 python3 时跳过）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 改前：`closestSlashCommands('/queu')` → `/queue /quit /new`（建议一个 REPL 跑不了的命令），`closestSlashCommands('/stee')` → 含 `/steer`；改后 → `/queu` → `/quit /new /rules`，`/stee` → `/stop /mode /new`；TUI 侧 `rowsForSurface('tui')` 仍含 `/queue`/`/steer`（app.ts 确实实现）；负向控制①：临时加一条 `/nope` 隐藏目录行 → stage 失败并点名 `/nope`；负向控制②：去掉 `/queue` 的 `surfaces` 标记（即复现改前状态）→ stage 失败并点名 `/queue`；`npm run verify` PASS 47.2s（stage 2.1s）                                                                                                                                                                                                                                                                         |
| B56  | P2     | **`moss config show`（与裸 `moss auth`）看不到三个影响行为的关键开关**：`agent.supportsImages`、`review.mode`、`verificationGate` 在 `--json` 里有、在文本摘要里全无。用户按 B52/B51 的提示设了 `agent.supportsImages false` 之后，`config show` 一个字都不提；`MOSS_VERIFICATION_GATE=0` 关掉完成门、`MOSS_REVIEW_MODE=auto` 也无处可见                                                                                                    | **已修并验证（2026-11-05）**：`config-snapshot.ts` 新增 `images`/`review mode`/`verification gate` 三行（带来源），中文标签补进 `ZH_FIELD`；`renderAuthStatus` 字段列表加入三者，`config show` 与裸 `auth` 同时生效                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 改前：`moss config show` 文本里 grep 不到 images/review/verification（只有 `--json` 里有）；改后：默认 `images: image input allowed (default)`、`review mode: manual (default)`、`verification gate: on (default)`；`config set agent.supportsImages false` 后 → `images: text-only (agent.supportsImages=false) (user)`；`MOSS_VERIFICATION_GATE=0` → `verification gate: off (env)`；`MOSS_REVIEW_MODE=auto` → `review mode: auto (configured)`；中文 → `图片输入：仅文本（agent.supportsImages=false）（用户配置）`、`评审模式：manual（默认）`、`验证门：开启（默认）`；`npm run verify` PASS 46.5s                                                                                                                                                                  |
| B57  | P2     | **REPL 看不到模型维护的清单**：`todo_write` 的清单在 TUI 里是实时面板（`render-bridge.ts:561` 抓 `tool_start`），REPL 里只有工具调用那一行、没有汇总视图；用户长重构中途想问「还剩什么」只能翻滚动历史。Claude Code 有 `/todos` 一眼看全表                                                                                                                                                                                                  | **已实现并验证（2026-11-05）**：新增 registry 命令 `/todos`（中英 + 状态字形），`CommandContext.getTodos()` 由宿主提供实时清单（REPL 从 `tool_start` 事件跟踪并随 `/clear` 清空；TUI 复用 `store.todos`），目录里可见；新增 verify stage `todos-view`（真 REPL + stub 返回 `todo_write` 工具调用 → 敲 `/todos` 断言四行）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 改前 REPL 输 `/todos` → `unknown command`（且无任何清单入口）；改后：模型写入清单后 → `Checklist 1/3 done` / `1. ✓ audit the loader` / `2. ◐ refactor the parser (in progress)` / `3. ○ run the verifier`；中文 → `清单 1/3 已完成`、`（进行中）`；无清单时 → `No checklist yet — one appears here after the model calls todo_write.`；TUI 输入 `/todos` → `⏺ Todos` 块同四行；负向控制：让宿主 `getTodos` 返回空表（模拟未接线）→ stage 失败并点名 header/completed/in_progress/pending；`npm run verify` PASS 50.8s                                                                                                                                                                                                                                                    |
| B58  | P2     | **诊断视图不报行为开关**：`moss config show`（B56）已列 images / 评审模式 / 完成门，但 `moss doctor` 与 `/doctor` 完全看不到——用户「截图被拒」「评审为什么跑了」「旧跑为何被拦」时打开的诊断页反而比配置页少信息                                                                                                                                                                                                                            | **已实现并验证（2026-11-05）**：`cli/doctor.ts` 新增 `renderBehaviorDoctor()`（三行 ok：图片输入 / 评审模式 / 验证门，含来源与中英），`cli/onboarding.ts` 的 `renderCliSessionDoctor`（`/doctor`）加同一组行；新增 verify stage `doctor-behavior`：真 `moss doctor` + 临时 HOME（`agent.supportsImages=false`、`review.mode=auto`、`MOSS_VERIFICATION_GATE=0`）断言三行                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 改后 `moss doctor`（默认）：`images: image input allowed (default)` / `review mode: manual (default)` / `verification gate: on (default)`；配置+env：`images: text-only (agent.supportsImages=false) (user)` / `review mode: auto (config or env)` / `verification gate: off (env)`；中文：`图片输入：允许图片输入（默认）`、`评审模式：auto（配置或环境变量）`、`验证门：关闭（环境变量）`；`/doctor`（真 PTY）同三行（`text-only (agent.supportsImages=false, user)`、`auto (config or env)`、`off (env)`）；负向控制：去掉 CLI 里的 `renderBehaviorDoctor` 调用 → stage 失败并点名三行，恢复后 1.8s 通过；`npm run check` 绿、`npm run verify` PASS 49.4s / 52.5s                                                                                                     |
| B59  | P2     | **lean 档只覆盖一半工具**：B08 给 15 个工具写了短描述，但 main-headless 的 20 个声明里仍有 10 个只有长版（`list_directory` 283 / `run_tests` 256 / `write_file` 246 / `apply_patch` 231 / `todo_write` 217 / `exec_logs` 187 / `move_file` 186 / 还有 exec\_\* 小工具），小窗口（≤64k，Cursor/Claude Code 按窗口发精简声明的做法）省不下来                                                                                                  | **已实现并验证（2026-11-05）**：给 17 个工具补 `leanDescription`（文件/编辑族 `write_file`/`multi_edit`/`list_directory`/`move_file`/`apply_patch`、任务族 `todo_write`、验证族 `run_tests`、后台族 `exec_logs`、交互族 `ask_user_question`/`exit_plan`、设备族 `device_file_read`/`device_file_list`、子代理族 `create_subagent`/`fan_out_subagents`/`merge_subagent_patch`/`subagent_status`/`subagent_stop`），长版按 B08 规矩补「不是用来做什么」的否定句；`measure-tool-surface --check` 新增**覆盖不变式**：main-headless/main-tty/main-plan 里声明且描述 ≥150 字符的工具必须有 lean 档                                                                                                                                                                                                                                                                                                                                                                                                                                                        | lean 覆盖 15→**33/49 工具**（可见 42 个中 32 个）；同一构建内 lean 声明总量：main-headless 11,803→**10,834**（−969，≈−242 tokens）、main-tty 16,261→**14,735**（−1,526，≈−382）、main-plan 12,182→**11,114**、main-qa −969；子代理 scope：device-read −567、explore −567、verify −986、plan −728；净代价：默认长版 +491（headless 13,524→14,015）/ +550（tty 19,774→20,324），换的是否定句与 patch 匹配规则等关键约束；真 CLI wire（脚本化 provider 记录请求体，`MOSS_LEAN_TOOLS=1`）：`write_file` 246→141、`list_directory` 283→163、`apply_patch` 399→189、`todo_write` 301→140、`run_tests` 321→188、`move_file` 270→155、`device_file_read` 438→228；负向控制：删掉 `write_file` 的 lean 档 → `--check` 失败并点名；`npm run check` 绿、`npm run verify` PASS 52.2s |
| B60  | P2     | **启动图里还白付 110 个 undici 模块**：`runCli()` 第一件事就 `await ensureKeepAliveDispatcherInstalled()`（为 O83 代理语义），把 undici 整包（110 模块，单进程冷 import 128ms）拖进每次启动；交互式 composer 要等它，`--help`/REPL 都付                                                                                                                                                                                                     | **已实现并验证（2026-11-05）**：改为「配了代理才在启动时装，否则首个真实请求时由 `fetchWithConnectionContext` 懒装」——`keep-alive-dispatcher` 导出 `hasProxyConfigured()`，`runtime.ts` 只在 HTTP(S)\_PROXY 存在时 eager 安装                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 见本节末 B60 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 持续进行                                                                                                                           |
| B61  | P1     | **压缩准备超时=静默跳过**（B13 首片）：`runWithCompactionPrepareTimeout` 30s 超时后 `runCompactionCore` 只 `log.warn` 一句，本次压缩被放弃、上下文原样跑——用户看不到降级，小窗口模型随后撞上限                                                                                                                                                                                                                                              | **已实现并验证（2026-11-05）**：`compaction-timeout` 增加类型化 `CompactionPrepareTimeoutError` + `isCompactionPrepareTimeout()`；`runCompactionCore` 在超时（非用户 abort）时打一条结构化 warn（phase/timeoutMs/elapsedMs/messages/runId/sessionKey），再以 `skipLlmCompaction: true` 重试一次确定性摘要；`compaction` 事件带 `degraded: true`，TUI 行 / REPL 横幅 / `--output-format stream-json` 都显示「deterministic summary (the model summary timed out)」；`deterministic-summary` 的预算改成「不超过被替换消息字符数的 50%」（下限 400、上限 12k），保证降级摘要不会让上下文变大                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 见本节末 B61 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 已验收（B13 首片；B13 余量=超时成因与 reserveTokens 关系未定位）                                                                   |
| B62  | P1     | **小窗口压缩预算整体失真**（B13 根因首片）：`reserveTokens`/`keepRecentTokens` 默认 20000，窗口 5000 时触发阈值 = `5000-20000 < 0`——每轮都算「超预算」；汇总请求 `maxTokens = min(4096, 0.8×reserve) = 4096`，占 5k 窗口的 82%，小模型上极易拖到 30s 超时（B13 的真实现象）                                                                                                                                                                 | **已实现并验证（2026-11-05）**：`clampCompactionSettingsToWindow()` 只收敛「配置值 ≥ 整个窗口」的荒谬情况（reserve→窗口 25%、keepRecent→窗口 50%），32k+ 标准窗口与用户显式设置完全不变；`buildCompactionSummary` 再加一道输出封顶 `min(4096, 窗口×25%)`；`shouldTriggerCompaction` 与 `compactHistoryIfNeeded` 都走同一个 clamp                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 见本节末 B62 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 已验收（B13 根因首片；余量=窗口经济学常量对小窗口的适配，见 B13 段）                                                               |
| B63  | P2     | **配了 provider 的启动仍白付 110 个 undici 模块**（B18/B60 续片）：B60 只让 `cli/runtime.ts` 在无代理时懒装 dispatcher，但启动期 context-window 探测 `resolveModelContextWindowFromApi()` 无条件 `await ensureKeepAliveDispatcherInstalled()`——只要配了 provider（最常见形态），TUI/REPL/headless 启动都会把 undici 整包拉回来                                                                                                              | **已实现并验证（2026-11-05）**：探测侧改成与 `runtime.ts` 同一条规则——只有 `hasProxyConfigured()` 为真才提前装 dispatcher，无代理时交给首个真实请求的懒装路径；代理语义（O83）不变                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 见本节末 B63 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 已验收（B18/B60 线程续）                                                                                                           |
| B64  | P2     | **首轮请求被 undici 装上阻住**：`runAgentLoop` 第一行 `await ensureKeepAliveDispatcherInstalled()`，`fetchWithConnectionContext` 每次请求前也 `await` 同一函数——即使没配代理，首轮也要先付 undici 110 个模块的 import（实测 87ms）才发得出去；B60/B63 只清掉「启动图」里的 undici，首轮关键路径仍付                                                                                                                                         | **已实现并验证（2026-11-05）**：新增 `scheduleKeepAliveDispatcherInstalled()`（fire-and-forget + in-flight promise 去重）；有代理仍 `await`（O83 语义不变），无代理改为后台安装——首个请求用默认 dispatcher 立即发出，后续轮次享受 60s keep-alive；`fetchWithConnectionContext` 用同一规则                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 见本节末 B64 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 已验收（B18/B60/B63 线程续）                                                                                                       |
| B65  | P2     | **小窗口预算说假话**：`getEffectiveContextWindowTokens` 用 `max(4000, window - reserved)` 兜底，4k 窗口配 1k 输出预留时真实 prompt 预算 3072、它却报 4000；`getProactiveCompactThreshold` 的 4k 底部在 4k–5.3k 窗口上等于预算本身，主动压缩永不触发、只剩硬上限，prompt 能长过 provider 的真实窗口                                                                                                                                          | **已实现并验证（2026-11-05）**：有效窗口改为「抬到窗口为上限」（`min(window, max(min(floor,window), usable))`，floor = min(4k, max(512, 40%window))）；主动阈值改为 `min(effective-1, max(min(4k, 75%effective), effective-dynamicBuffer))`；新增 verify stage `window-economics`（55 组窗口/输出组合不变量 + 具体数值回归）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 见本节末 B65 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 已验收（B13 根因线程续；4k–8k 窗口的产品级修法见 B66 候选）                                                                        |
| B66  | P1     | **4k 窗口一轮都跑不起来**（B65 顺带测出的真实发现）：Ollama 默认 4096 窗口下，即使 lean 描述已自动开，15 个工具声明 baseline ≈4.3k est tokens 已超整窗；首请求被网关以 context-length 拒绝，overflow 恢复把工具面降到 0 后仍有 3.9–5.4k，整轮 exit 6。另外 2k 输出地板在 4k 窗口上吃掉一半窗口，模型摘要请求（系统提示+transcript）也放不进窗口                                                                                             | **已实现并验证（2026-11-05）**：① `tiny-window-tools.ts`（≤6k 预算只声明 5 个核心工具：exec/read_file/write_file/edit_file/list_directory，`MOSS_TINY_WINDOW_TOOLS=1/0` 可强制）；② 输出预算 ≤6k 窗口改按 1/6（4096→682，2048→341），>6k 仍 1/4；③ ≤6k 窗口压缩改用本地确定性摘要（不再向模型要摘要），摘要预算 = 窗口 15%；新增 verify stage `tiny-window-surface`，并把 B62 探针的 5k 断言更新为「5k 窗口不得调用模型摘要器」                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 见本节末 B66 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 已验收（4096 窗口真实跑通含工具调用的一轮）                                                                                        |
| B67  | P2     | **系统提示还在推销本轮不给的工具**：`buildBaseSystemPromptParts` 无条件拼 `## Available sub-agent experts`（503 chars，含「用 `create_subagent` / `fan_out_subagents` 选一个」），而微型窗口（≤6k）与 plan 模式等场景根本不声明这些工具——模型被指引调用不存在的工具，还白付 125 tokens                                                                                                                                                      | **已实现并验证（2026-11-05）**：`buildBaseSystemPromptParts`/`buildSystemPrompt`/`composeSystemPrompt`/`buildSystemPromptMeta` 增加 `omitSubagentExperts`；`createAgentLoopRun` 在已知有效窗口处算 `tinyToolSurface`（与 B66 工具面同一判定）并沿 run 传入，catalog 与工具面一致；verify 扩展 `tiny-window-surface`（SDK 级断言标准提示有 catalog、裁剪后没有且省 >400 chars）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 见本节末 B67 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 已验收（4096 窗口首请求再省 ~190 tokens）                                                                                          |
| B68  | P2     | **静态门每轮从头做功**：`format:check` / `eslint .` / `tsc --noEmit` 三个工具都没有缓存，本机 load ≈27 时一次 static 要 2 分钟（eslint 单项冷跑 56.7s），verify 反复触发 60s 预算警告——这也是连续多轮「verify 超预算」的真实成本来源                                                                                                                                                                                                        | **已实现并验证（2026-11-05）**：static stage 三个检查全部改为内容寻址缓存（prettier `--cache`、eslint `--cache`、tsc `--incremental --tsBuildInfoFile`），缓存落 `node_modules/.cache/verify/`（已 gitignore，CI 冷启动一次、语义不变）；日志标签改为 `(cached)`/`(incremental)` 以免误解为无条件加速                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 见本节末 B68 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 已验收（static 2m0 → 5.1s warm；verify 3m42 → ~63s）                                                                               |
| B69  | P2     | **微型窗口静默降级，用户不知道**：B66 之后 4k 窗口只给 5 个核心工具、压缩走本地摘要、回复限 682 tokens，但 CLI 启动什么都不说——模型发现自己缺工具、用户发现模型「变笨」都无从归因，也没有指向修法的线索（Cursor/Claude 对降级能力都会显式提示并给开关）                                                                                                                                                                                     | **已实现并验证（2026-11-05）**：`runtime.ts` 在窗口与输出预算解析完成后判定微型档，一次性打印（TUI 走 notice、headless/REPL 走 stderr，zh/en 双语）「窗口 4k：只给 5 个核心工具、压缩用本地摘要、单次回复上限 N tokens；用 agent.contextTokens 配更大窗口」，并说明为什么工具变少；`MOSS_TINY_WINDOW_TOOLS=0` 时不打印（与工具面一致）；verify 扩展 `tiny-window-surface`：3 次真实 CLI 启动断言（4096 有、32000 无、强制关无）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 见本节末 B69 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 已验收                                                                                                                             |
| B70  | P1     | **微型窗口下工具结果仍按大窗口预算切，直接把下一轮请求顶穿**：4k 窗口的系统提示 + 5 工具已占 ~2770 est tokens，而 `exec` 结果按工具自带预算（4k tokens）放行——6000 字符输出 = ~1500 tokens，下一轮 est 3471 + 682 = 4153 > 4096 被 provider 拒绝，模型根本看不到那次工具的结果（实测连拒 2 次，白烧 2 轮）                                                                                                                                  | **已实现并验证（2026-11-05）**：`context/window-economics` 新增 `TINY_TOOL_RESULT_WINDOW_TOKENS=6000` 与 `tinyWindowToolResultTokens(window)=max(192, floor(window*0.1))`（4096→409）；`truncateToolOutput` 接受 `contextWindowTokens` 并在小窗口取 `min(工具预算, 窗口份额)`；`ToolContext.contextWindowTokens` 由 run 的有效预算注入，经 `truncateWithRecoveryPath` 落到结果截断；大窗口完全不变                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 见本节末 B70 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 已验收（4k 窗口第二轮 est 3353 接受，exit 0）                                                                                      |
| B71  | P1     | **4k 窗口撑不过 5 次工具调用**：系统提示 5830 chars（含 ~2700 chars 行为手册与工具结果规范）在 3414 预算里占掉 2770 est tokens；工具链每轮只增不减（tool-result follow-up 跳过 prune/压缩），第 5 次调用 est 3419+682=4101 被 provider 拒绝，run 以 exit 6 失败——小窗口「能起跑、跑不远」                                                                                                                                                   | **已实现并验证（2026-11-05）**：① 小窗口（≤6k 有效预算）在 tool-result follow-up 轮也做本地滑窗 prune（0.85 预算留余量，不生成摘要——摘要 600+ tokens 在小窗口比省下的还贵）；② `compactGuidance`：小窗口用 ~700 chars 的 `## Small-context mode` 替代 ~2700 chars 行为手册 + 工具结果规范段落，首请求 est 2770→2099                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 见本节末 B71 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 已验收（工具链 5 次→20+ 次零拒绝）                                                                                                 |
| B72  | P2     | **小窗口工具声明的话术成本**：5 个核心工具的声明仍占 tools_chars 3546（≈890 tokens，占 3414 预算 26%），其中描述 1168 chars 全是「别用 cat 用 read_file」「2+ 处替换用 edits[]」这类**列的是本轮不给的工具**；而且线上走的是 `metadata.leanDescription`（≤64k 窗口启用），只改 `description` 完全无效——第一次改完实测请求字段一字未变才发现                                                                                                 | **已实现并验证（2026-11-05）**：`tiny-window-tools` 新增 5 条 ≤130 chars 的微型档描述（保留 read_file 先读、别抄行号、绝对路径等硬约束），`moss-agent` 在小窗口同时覆盖 `description` 与 `metadata.leanDescription`（真正上线路径）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 见本节末 B72 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 已验收（首请求 est 2099→1890）                                                                                                     |
| B73  | P2     | **schema 本体是剩余最大声明成本**：wire 上 5 个工具 schema 仍占 ~2360 chars（exec 1044 / edit_file 1087），其中大半在描述本轮 guidance 明确不让用的模式（后台运行 `run_in_background`/`wait`/`event`/`label`、批量编辑 `edits[]`）                                                                                                                                                                                                          | **已实现并验证（2026-11-05）**：`tinyWindowToolSchema` 按工具白名单裁剪属性（exec→command+timeout_ms；edit_file→path/old_string/new_string/replace_all；list_directory→path/depth），`required` 同步过滤；工具实现本身不变，宿主/其他窗口传参不受影响                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 见本节末 B73 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 已验收（首请求 est 1890→1655）                                                                                                     |
| B74  | P2     | **降级档位不可诊断**：小窗口实际换了工具面（5 个）、压缩策略（确定性）与工具结果上限（341 tokens），但 `moss doctor` 只报 context window 和 max output，用户排查「为什么模型变笨/工具不见了」时无处可查；Cursor/Claude 的诊断入口都会把生效档位摆出来                                                                                                                                                                                       | **已实现并验证（2026-11-05）**：`doctor` 新增 `context profile` 行（小窗口时）：`small window: 5 core tools, local (deterministic) compaction, tool results capped at <N> tokens. Raise agent.contextTokens …`，zh/en 双语；判定与运行期同一组 helper（`tinyWindowToolSurfaceEnabled` + `getEffectiveContextWindowTokens` + `tinyWindowToolResultTokens`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 见本节末 B74 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 已验收（4096 显示、8192/32000 不显示）                                                                                             |
| B75  | P2     | **首 token 只有一个数，无法归因**：headless `--json` 只有 `first_token_ms`（且注释写「从 run 开始」实际是 provider 请求起点），本地 prompt 组装占了多少、provider 往返占了多少全靠猜；而 Moss 已有 `MOSS_STARTUP_TIMING` 却没有「这一轮首字慢在哪」的口径                                                                                                                                                                                   | **已实现并验证（2026-11-05）**：loop 在首个请求发出时打点 `promptReadyMs`（相对 run 开始），`run_metrics` 新增 `promptReadyMs`/`firstTokenProviderMs`；经 `cache_metrics` 事件透出到 headless `--json` 的 `prompt_ready_ms`（加性字段），并把 `first_token_ms` 的注释改正为 provider 请求起点口径                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 见本节末 B75 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 已验收（stub 延迟归因）                                                                                                            |
| B76  | P2     | **lean 窗口只瘦了描述、没瘦 schema**：≤64k 窗口本来就会切到 lean 描述（`shouldLeanToolDescriptions`），但 wire schema 仍全量——32k 窗口首请求 4960 est tokens（exec 7 属性、edit_file 5 属性），其中后台执行与批量编辑仍是「一次一步」场景用不到的税                                                                                                                                                                                         | **已实现并验证（2026-11-05）**：`compactToolSchema` 抽成 tiny/lean 共用，`buildProviderToolDeclarations` 在 lean 时按工具白名单裁剪属性（工具实现仍接受全部参数）；同时把 B72/B73 注释里对竞品的表述改准确（Cursor reduced-prompt tier / Claude ToolSearch 是「约束档少花声明字节」的实证先例，按窗口裁 schema 是 Moss 自己的延伸）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 见本节末 B76 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 已验收（32k 首请求 −877 est tokens）                                                                                               |
| B77  | P3     | **lean 档位在诊断里不可见**：≤64k 窗口从 B76 起会裁工具 schema（exec 只剩 command+timeout、edit_file 只留单次编辑），但 `moss doctor` 只在微型档（≤6k 有效预算）时提示；32k/8k 用户看到「参数不见了」会当 bug                                                                                                                                                                                                                               | **已实现并验证（2026-11-05）**：doctor 增加 `lean surface` 行（en/zh）：说明描述已精简、schema 已裁到一次一步参数，并给出恢复完整声明的阈值（`agent.contextTokens > 64k`）；判定复用运行期 `shouldLeanToolDescriptions`（输入为有效预算，与 wire 决策同源）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 见本节末 B77 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 已验收（4096 tiny / 8192–64000 lean / 100k+ 无行）                                                                                 |
| B78  | P2     | **TUI 里探测晚到 → 系统提示说错窗口、降级提示永不出现**：`## Context Window` 层和 B66 的微型档提示都在 probe 落盘前按「未探测默认 1000k」算好；TUI 按设计先画屏、probe 后到，结果 4k 窗口的 TUI 会话被告知 1000k，且 5 工具降级提示一次都不打印（headless 因为 `await probe` 没这问题）                                                                                                                                                     | **已实现并验证（2026-11-05）**：抽出 `announceTinyWindowIfNeeded()`（幂等，headless/TUI 共用）；TUI 在 `contextProbe.then()` 里：probe 修正为 `provider-api` 时重写 `cli:context-window` 层文本，并补发降级提示                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 见本节末 B78 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 已验收（PTY 真实 TUI：改造前无提示，改造后有）                                                                                     |
| B79  | P3     | **会话内 `/skills` 与 `moss skill list` 报的不是同一张表**：`renderSkillsList` 的注释写着「与 `/skills` 共用，两边数字一致」，但 REPL 和 TUI 各自 print 自己的窄行（只有名字+描述首行+issue 数），scope / 真实使用次数 / 目录成本 / evals 在会话里看不见（D10 遗留的唯一一项）                                                                                                                                                              | **已实现并验证（2026-11-05）**：两处改为调用 `renderSkillsList(workspace, configDir, zh)`，删掉各自的重复格式化                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 见本节末 B79 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 已验收（REPL 输出与 `moss skill list` 逐行一致；TUI PTY 行含 scope/used/catalog）                                                  |
| B80  | P0     | **交付门超过 60s 预算，最大单点是 tiny-window 探针**：`tiny-window-surface` 一个 stage 串行 boot CLI 6 次（3 次 `-p` + 3 次 `doctor` + 1 次 PTY TUI），实测 24–41s，而 verify 调度器只能并行 stage 之间——单点长 stage 就是关键路径，整门 1m7s–2m30s，CI 用 `VERIFY_BUDGET_SECONDS=60` 会拦                                                                                                                                                  | **已实现并验证（2026-11-05）**：把该探针按「boot 组」拆成 4 个 stage（纯模块断言 / 启动提示 3 次 boot / doctor 3 次 boot / PTY TUI 1 次 boot），共享 `scripts/verify/lib/tiny-window-boot.mjs` 夹具，四个 stage 都 `requires: ['build']` 进池并行                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 见本节末 B80 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 已验收（四 stage 独立通过；池内最大 13.1s，替代原 24.1s 串行）                                                                     |
| B81  | P1     | **技能不能自带 hooks，保护只能整机配**：技能/能力包是 Moss 当前的交付单元，但`hooks` 只存在于用户/项目配置——一个技能想声明「改这个包之前先跑冒烟脚本」只能写进 README 让用户手抄；Claude Code 的 skill frontmatter 已支持 `hooks`（invoke 后整个会话生效，`once` 只跑一次），Moss 的 skills 有正文/工具/模型/后台却独缺这层「运行中的确定性控制」                                                                                           | **已实现并验证（2026-11-05）**：SKILL.md frontmatter 新增 `hooks: <相对路径>`，指向技能目录内的 hooks JSON（schema 与 `.moss/config.json` 完全一致：matcher/if/timeoutMs/http）；`skill` 工具加载时读取并校验，成功则调用 `activateSkillHooks` 会话粘性激活，失败（缺失/坏 JSON/非对象/越界路径）令技能加载失败并给出可读原因；`src/cli/hooks.ts` 的 PreToolUse/PostToolUse/PostToolUseFailure 改为**调用时解析**静态条目+技能条目，其余事件保持静态（技能只能挂工具事件，不能 veto Stop/压缩）；`onBeforeToolExec`/`onToolResult` 因可晚到而常驻定义                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 见本节末 B81 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 已验收（探针 6/6 + 真实模型 E2E 拦截 rm -rf）                                                                                      |
| B82  | P1     | **`run_tests` 把「退出码 0 但输出不是已知 reporter」判成失败**：harness 的契约是「测试命令的退出码就是裁决」（Claude Code / Cursor 都只读 exit code，计数只是展示糖），而 `judge()` 的 unknown 分支直接写 `tests_pass=false`——真实 deepseek-flash 会话里模型因此多花一轮 `exec` 去证明「绿了」，`record_evidence`/`task_acceptance` 的 `tests_pass` 也会把绿跑记成 false                                                                    | **已实现并验证（2026-11-05）**：exit 0 且计数无法解析 → `✅ exit 0 (pass/fail counts could not be parsed)` + `tests_pass=true`，并保留一句诚实的 caveat（计数不可用，静默/空测试脚本看起来一样，要看原始输出用 exec）；非零退出/超时/spawn 失败/无 runner/裸调用仍为 `tests_pass=false`；`executePlan` 的汇总把 unknown（现在只来自该分支）计入 passed，多命令 suite 的 `overall tests_pass` 不再自相矛盾                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 见本节末 B82 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 已验收（探针 6/6 + 真实模型 E2E：tests_pass=true 被模型接受、不再补 exec）                                                         |
| B83  | P2     | **verify stage 阻塞事件循环，扭曲并发 stage 的计时**（上一轮 B82 验收时发现）：`repl-interrupt` / `context-surface` / `slash-dispatch` / `smoke` / `todos-view` / `build` 在 orchestrator 里用 `spawnSync` 跑 tsc/PTY/python 驱动，阻塞期间同池其他 stage 的 child `close` 回调无法运行——B82 新 stage 内部实测 0.7s，全门里却被记成 17.7s；只把 `repl-interrupt` 与它同池就复现 10s 差。这会误导 60s 预算与「最长 stage」判断（B80 的前提） | **已实现并验证（2026-11-05）**：六个 stage 全部改用 `scripts/verify/lib/proc.mjs` 的异步 `runProcess` / `captureProcess`；`python3 --version` 一次性探测也改异步；add 了 `MOSS_VERIFY_CLI_ENTRY` 兼容不动；`docs/design/ci-and-verify.md` 写明「新 stage 不得同步阻塞事件循环」的规则与这次证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 验收：全门里 `run-tests-verdict` 0.7s（顺序/单独跑同为 0.7s，差 ≤1s）；六个 stage 单独跑全绿；`npm run verify` PASS 36.9s（改前 46.3s）；`npm run check` 绿                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 已验收（全门 38.2s/36.9s 两次 PASS，stage 计时差归零）                                                                             |
| B84  | P1     | **MCP prompts 只有模型能用，用户不能触发**（D4 最后一片，Claude Code parity）：Claude Code 把每个 MCP prompt 暴露成一等斜杠命令；Moss 已有 `mcp_prompt` 工具（模型可调用），但 REPL/TUI 用户无法列出或运行服务器模板，`/mcp` 只显示服务器状态                                                                                                                                                                                               | **已实现并验证（2026-11-05）**：`McpToolRegistry.promptCatalog()`（健康服务器的模板 + 坏服务器单列失败行）与 `expandPrompt()`（`prompts/get` → 一轮文本）；`CliRuntimeStatus.mcpPrompts` 由 runtime 注入；`/mcp prompts`（别名 `/mcp list`）列出 `server/name (args?) — 描述` 并提示运行方式；`/mcp prompt <server> <name> key=value...` 展开后经共享 `submitPrompt` 作为一轮发送（REPL 与 TUI 同一条 dispatcher）；新增 `CommandSpec.requiresArgs`，裸 `/mcp` 仍留给宿主的富状态面板；未知服务器/未知 prompt/坏参数都报错且不提交空轮                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 见本节末 B84 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 已验收（探针 9/9 + 真实 deepseek-flash PTY 两轮）                                                                                  |
| B85  | P1     | **技能只能二选一：要么模型自动可用，要么用户完全用不了**（Cursor/Claude `disable-model-invocation` 缺失）：Moss 的 `skill` 工具对所有发现到的技能一视同仁，发布/部署这类只该由操作者亲手触发的过程无法既出现在 `/` 菜单里、又不出现在模型 catalog 里                                                                                                                                                                                        | **已实现并验证（2026-11-05）**：frontmatter `disable-model-invocation: true`（接受 true/yes/on/1，坏值 fail-open + issue）→ manifest `modelInvocable`；L1 catalog 与 `/context` 成本过滤掉这类技能；`skill` 工具显式拒绝（给出"让用户运行 /名称"下一步、不吐正文）；`resolveUserCommand` 对这类技能把 SKILL.md 正文直接内联成用户这一轮（REPL 与 TUI 共用）；`/skills`/`moss skill list` 标 `user-only` 且不占目录预算                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 见本节末 B85 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 已验收（探针 7/7 + 真实 deepseek-flash headless 拒绝 + REPL 用户触发双跑）                                                         |
| B86  | P0     | **技能目录预算固定 8,000 字符，与模型窗口脱钩**（Claude 是 ≈1% 窗口）：32k 窗口里 6,203 字符目录 ≈1.5k tokens 每一轮都付，占掉本可用于历史的窗口；16k/8k 窗口更离谱，且 `tiny-window` 预算保护只算总 prompt，不会替技能目录降档                                                                                                                                                                                                             | **已实现并验证（2026-11-05）**：新增 `skillCatalogBudgetForWindow()`＝`min(8,000, max(800, windowTokens×1%×4))`（窗口未知→8,000 兜底，`MOSS_SKILLS_CATALOG_BUDGET` 仍可覆盖）；CLI runtime 的 port 预算、SDK 内置 catalog、`/context` 渲染与 `/skills` 汇总全部改用窗口预算（`/skills` 走 registry 取 `agent.config.contextTokens`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 见本节末 B86 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 已验收（探针 4/4 + 真实 deepseek-flash 运行 32k/200k 双窗口层报告 + 真实 `/skills`）                                               |
| B87  | P1     | **用户无法引用 MCP 资源**：`mcp_resource` 只有模型可调，用户打 `@server:uri` 只是普通文本（Claude Code 的 `@` 是 prompt 级机制，会在回合前把资源正文放进上下文）；模型为了读一个用户已经指名的资源要花 1–2 轮工具调用，还可能先 list 再猜 URI                                                                                                                                                                                               | **已实现并验证（2026-11-05）**：`McpToolRegistry.readResourceText()`（复用提示词的 deferred/重连规则，未知服务器/未知 URI/空内容都如实报错）；`src/cli/mcp-resource-mentions.ts`（`@server:scheme://...` 语法、去重、尾标点剥离、并发读、每资源 8k / 单回合 16k / 最多 3 个、失败只记 note、块头注明已附加）；`CliRuntimeStatus.mcpResources` 接线 REPL `runReplTurn`、TUI `runTurn`→`streamChat extraContext`、headless `-p` 主回合                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 见本节末 B87 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 已验收（探针 5/5 + 真实 deepseek-flash headless 0 工具调用直达答案 + 真实 REPL attached 行）                                       |
| B88  | P2     | **技能 hooks 没有 one-shot 语义**：Claude 的技能 frontmatter hook 支持 `once: true`（首次成功后移除），Moss 的技能 hooks 一旦激活就会在会话里每次匹配都跑——一次性的「首次写入时校验」「首次 push 前检查」类守卫只能自己写锁文件                                                                                                                                                                                                             | **已实现并验证（2026-11-05）**：技能 `hooks.json` 条目支持布尔 `once`（非布尔值作为坏条目丢弃并警告）；PostToolUse 不 await，所以用 claim→run→report 三段式（同步 claim 防并发双跑、退出码 0 retire、非 0/超时/启动失败重新武装、重新 invoke 技能重新武装）；`describeActivatedSkillHooks()` 显示 `(N once)`；项目 `.moss/config.json` hooks 不受影响                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 见本节末 B88 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 已验收（探针 4/4 + 真实 deepseek-flash REPL 双跑：once 落 1 行 vs 无 once 落 6 行）                                                |
| B89  | P1     | **脚本化/CI 的 headless 运行没有“本次只预批准这些工具”的手**：`--workspace-write` 下每个 exec 都是「needs approval (could not ask)」，自动化只能二选一——`--full-access`（过宽）或什么都不做；Claude Code 有 `--allowedTools` / `--disallowedTools`（规则语法与 settings 的 permissions 相同）                                                                                                                                               | **已实现并验证（2026-11-05）**：新增 `--allowed-tools` / `--disallowed-tools`（也接受 `--allowedTools` / `--disallowedTools`，可重复、逗号分隔、支持 `=` 形式）；值用现有 `parsePermissionRuleSpec(spec,'session',level)` 变成 session 规则，与 org policy / 配置 permissions 一起进同一张表，所以 deny 仍然全模式最高优先、ask 语义不变、`/permissions` 可见、不写盘；空值/非法规则是启动错误；交互启动时 stderr 公告本次规则；help 中英文各加一行。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 见本节末 B89 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 已验收（探针 2/2 + 真实 deepseek-flash 三跑：无 flag 被拦 / 有 flag 执行成功 / full-access 下 deny 仍然拦）                        |
| B90  | P1     | **一次会话只能改工作区内的文件**：Claude Code 的 `--add-dir`/`permissions.additionalDirectories`（多根工作区）在 Moss 里不存在，文件工具（`write_file`/`edit_file`/`move_file`/`apply_patch`）在所有模式下都被 `safePath` 硬限制在 workspace，想同时改旁边仓库只能开第二个会话或先拷贝                                                                                                                                                      | **已实现并验证（2026-11-05，第一片：`--add-dir`）**：新 `src/cli/add-dir.ts` 把每个目录解析到 workspace、realpath 去重、拒绝不存在/非目录并丢掉 workspace 自身；`ToolContext.fileWriteRoots` + `safePath(input, workspace, extraRoots)` 让文件工具接受附加根；审批层 `workspaceMutationBlockReason` 用同一组 extraRoots（不是绕过，工具仍强制）；shell 写边界 `execWriteRoots` 扩展为 `[workspace, ...added]`；环境提示层新增一行（文件名 + 明确「不从中加载 AGENTS.md/技能」）；交互启动 stderr 公告；help 中英各一行。**仍缺**：`permissions.additionalDirectories` 配置键、会话内 `/add-dir`、子代理继承（子代理需自己带 flag）。                                                                                                                                                                                                                                                                                                                                                                                                                 | 见本节末 B90 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 已验收（探针 4/4 + 真实 deepseek-flash 五跑：附加目录 write_file 成功/无 flag 被拦、exec 重定向成功/无 flag 被拦、坏目录启动报错） |      |
| B91  | P2     | **macOS `/tmp` 形式被 shell 写检查误拦**：`assertShellWritesWithinRoots` 先做词法包含判断再 realpath，`/tmp/x` 与根 `/private/tmp/x` 不匹配 → 即使目标就在 workspace 内也报 "shell write escapes the workspace sandbox"；B90 E2E 实测（`echo inside > /tmp/<ws>/inside-tmp.txt` 被拦，改用 `/private/tmp/...` 才能过）。文件工具走 `assertSandboxPath` 的 realpath 分支所以不受影响                                                         | 待做：在 `resolveSandboxPath` 比较前对目标做 realpath（目标不存在时 realpath 父目录），并给 B90 场景加回归探针                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | —                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 待做                                                                                                                               |
| B92  | P0     | **长程任务一轮一个恢复点，但重启后就丢了**：checkpoint 元数据只在内存里，备份文件虽然落盘（`<runtimeDir>/checkpoints/<session>/`），进程退出后重开同一 session 的 `/rewind` 列表为空——Claude Code 明确「checkpoints 和对话存在一起，resume 后 `/rewind` 仍可用，保留最近 100 个」；Moss 之前保留 20 且不持久化                                                                                                                              | **已实现**：`FileCheckpointStore` 构造时 `load()` 元数据、每次 open/track/note/rewind 后原子 `save()`；保留窗口对齐 Claude（100），裁剪时 `pruneBackups()` 删掉孤儿备份而不只是忘记；坏/缺元数据降级为空列表不抛错。真实 deepseek-flash：PTY 里写文件 → 退出 → `--session` 重开 → `/rewind` 列出 1 个 checkpoint → `/rewind 1` 把文件恢复成 BEFORE。**仍缺**：`/rewind` 只恢复文件、不恢复对话（Claude 的「恢复代码+对话 / 从这里总结」未做，下一片）；bash/exec 改动、子代理编辑不在 checkpoint 内（与 Claude 同边界，已文档化）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 见 B92 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 已验收（探针 3/3 + 真实 deepseek-flash 两段 PTY 会话）                                                                             |
| B93  | P0     | **`/rewind` 只回滚文件、不回滚对话**：`RewindResult.messageCount` 早已返回但 REPL/TUI 都没用；交互入口 `checkpointStore.open(label)` 没传 messageCount（默认 0），所以即便接了对话回滚也没有正确的回滚点。Claude Code 的 `/rewind` 是「恢复代码 + 对话 / 从这里总结」——撤销一轮后模型不该还记得被撤销的内容                                                                                                                                 | **已实现**：`MossAgent.countSessionMessages(sessionKey)` 给出存储中的历史长度；REPL 与 TUI 在回合开始前 `await` 真实计数再 `open(label, count)`；`/rewind`/`/undo` 恢复文件后调 `agent.rewindConversation`，打印「Dropped N message(s) from the LLM context」；TUI 的 `rewindTo` 变 async 并在状态行报告。**边界**：撤销的是 LLM 上下文，视觉 transcript 保留（与既有设计一致）；bash/子代理改动仍不在 checkpoint 内。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 见 B93 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 已验收（探针 4/4 + 真实 deepseek 两轮+rewind+跨进程复验）                                                                          |
| B107 | P1     | **长跑账本只增不减**：每次 `moss loop` 都往 `.moss/loops/` 写一个 jsonl，无人清理；跑几晚几十上百个文件，`loop list` 每次全量读，磁盘与读延迟都无界；Cursor/Claude 的运行历史有条数上限或清理入口，Moss 没有                                                                                                                                                                                                                                | **已实现**：`moss loop prune [--keep N] [--dry-run] [--json]`（默认保留最新 50 个已结束运行）；**进行中（存活 pid）的 run 永不删除**，dead-pid/旧账本算已结束可清；`--dry-run` 只报表与可释放字节；`--json` 给 `[{runId,ledger,bytes,status,startedAt}]`；表头 `pruned N of M run(s) (kept K) · freed X`；坏 `--keep` exit 2、unlink 失败 exit 1；走 dispatcher fast path，不构造 agent                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 见 B107 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 已验收（探针 5/5 + 真实两 run 的 prune/list/json/dry-run）                                                                         |
| B106 | P1     | **长跑健康度看不到**：`loop list` 只给一页行，跑了一周后账本几十条也答不出"整体通过率、现在还有几个在跑、失败算不算多"；脚本要筛失败/进行中的 run 只能自己解析 `--json`；Cursor 的 run 视图与 Claude 的 task list 都有聚合状态                                                                                                                                                                                                              | **已实现**：`loop list` 表头给出**全账本**（不受 `--limit` 影响）计数 `total · passed · failed · running · interrupted`；新增 `--status passed\|failed\|running\|interrupted`（`fail` 别名）只筛表格与 `--json` 输出，表头保留全局计数并标 `— status X (N)`；筛不到时打印 `no runs with status X` 而不是错误；坏 status 报 usage、exit 2；`summarizeLoopRuns()` 导出供探针/未来 TUI 复用                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 见 B106 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 已验收（探针 6/6 + 真实两 run 的 list/status/json）                                                                                |
| B105 | P1     | **检查命令挂起不可见**：`--until` 只有硬编码 10 分钟上限，超时被杀后按 `exit 1` 当"判定失败"，会烧掉剩余轮次重跑一个每次都挂的检查；跟随者只看到"失败"，分不清"你写错了"还是"命令卡住了"                                                                                                                                                                                                                                                    | **已实现**：`--until-timeout <时长>`（默认 10m，支持 ms/s/m/h）——单次检查命令的墙钟上限；到点没结束视为**挂起**而非判定失败，attempt 记录 `check.timedOut:true` 并显示 `check TIMEOUT (Xs)`，summary 新 reason `check_timeout` 且**不烧剩余轮次**（`--max 3` 只跑 1 轮就停），start/summary 记录 `untilTimeoutMs`，`list` 原因列显示 `check timed out (hang)`、`show` RESULT `failed · check_timeout`；坏值解析期报错（`0`/`soon`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 见 B105 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 已验收（探针 4/4 + 真实挂起 run + follow）                                                                                         |
| B104 | P1     | **长跑只能手动轮询**：`loop list`/`show` 是快照，盯一个跑着的 loop 要自己反复执行，看不到"进行到第几轮、刚过去那轮为什么失败"，Cursor 的 run 视图是活的                                                                                                                                                                                                                                                                                     | **已实现**：`moss loop follow [<run_id>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              \| latest] [--interval 1s]`——按 `--interval`（≥100ms）轮询账本，先打印已有状态（`following <id> (pid N) — X attempt(s) so far` + 已有 attempt 行），之后新 append 的 attempt/summary 实时打印，summary 落盘即退出（passed 0 / 失败 1）；进程已死且无 summary 时报 interrupted 并立刻退出；`latest`默认最新一次、未知 id 报错 exit 1；与`list`/`show` 一样不构造 agent，Ctrl+C 只停跟随不停 loop | 见 B104 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 已验收（探针 4/4 + 真实 pass/fail follow 各一次）                                                                                  |
| B103 | P1     | **loop 历史把"还在跑"当成"被杀"**：B100 对没有 summary 的 run 一律标 `interrupted`；无人值守时这正好是"别动它"和"重新拉起来"的区别，`--json`/TUI 也无法判断运行中                                                                                                                                                                                                                                                                           | **已实现**：每个 run 的首行写 `{type:"start", runId, at, pid, until, maxAttempts, prompt}`（截断 500 字）；读路径在同机用 `process.kill(pid,0)`（EPERM 视为存活）判活：无 summary 且 pid 活 → `running`（`in progress (pid N)`），pid 已死/旧账本无 start → `interrupted`；`maxAttempts` 回退到 start 记录（不再显示 `att:1/1`），`loop list --json` 带 `status`/`pid`，`loop show` 打 `PID` 行与 `RESULT running                                                                                                                                                                                                                    \| interrupted`                                                                                                                                                                                                                                                                                                                                                                                                 | 见 B103 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 已验收（探针 6/6 + 真实 run：运行中→kill -9→interrupted）                                                                          |
| B102 | P1     | **完成门靠散文猜审查结论**：验证完成门（L3 review-fail 规则）对 `review_changes`/子代理结果做 `VERDICT: FAIL` 正则匹配；结果被截断、被改写或审查器只写"findings saved"时，critical finding 可能悄悄放行——而 `.moss/review.jsonl` 里已有结构化 verdict，`moss review check` 也在用它                                                                                                                                                         | **已实现**：`createVerificationCompletionGate({ workspaceDir })` 每次判定读 `.moss/review.jsonl` 最新记录（尾部 64KB、容忍半行、跳过坏行），run 内调用过审查工具且记录晚于 run 开始时以结构化 verdict 为准：FAIL → 拦一次并注入含 critical/important 计数与 record id 的修正（提示 `moss review check` exit 1）；PASS 可推翻工具结果里的旧 FAIL 句子；早于本次 run 的记录不拦；子代理审查无账本记录时保留散文后备                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 见 B102 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 已验收（探针 7/7 + 真实 run：reviewer FAIL→完成门拦截→模型诚实报未解决，exit 9）                                                   |
| B101 | P1     | **loop 只能按固定时钟重试**：`--every` 是死等，CI 产物/外部构建落地时要么等太久、要么白跑一轮；brainstorm §5/S5 的"外部信号唤醒"一直是暂缓项                                                                                                                                                                                                                                                                                                | **已实现**：`moss loop --watch <路径> [--watch-timeout 10m]`——失败后在下一轮前等该文件/目录签名变化（文件 size+mtime、目录子项签名，500ms 轮询、缺失也算独立签名），变化即唤醒（打印等待时长与 before/after 状态），等不到就以 `reason=watch_timeout` 收工、不消耗剩余轮次；等待时长写进下一次 attempt 的 `waitedMs`，`loop list/show` 显示 `WATCH` 行与 `wait 20.0s`；可与 `--every` 叠加（先固定延迟再等信号）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 见 B101 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 已验收（探针 8/8 + 真实 wake 27s/timeout 11s）                                                                                     |
| B100 | P1     | **loop 账本只写不读**：B94 把每轮退出码/耗时/检查输出写进 `.moss/loops/<runId>.jsonl`，但仓库里没有任何读它的命令——夜跑/长跑之后只能 `cat` + 手写 jq，`--json` 还被顶层参数解析器吃掉（与 `task list` 同一个坑）                                                                                                                                                                                                                            | **已实现**：`moss loop list [--limit N] [--json]` 与 `moss loop show [<run_id>                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       \| latest] [--json]`，直接读 `.moss/loops/\*.jsonl`（不构造 agent，无 key 也能用）：最新在前、`pass/fail/interrupted`（没有 summary 行即中断或仍在跑）、att:N/M、时长、`--until` 命令、`↳` 停止原因与账本路径；`show` 打印每轮 agent/check 耗时、退出码、检查输出尾部与模型错误，passed 才 exit 0（脚本可判定）；缺行/坏行跳过并计数；`--json`经 dispatcher 的`ctx.argv` 透传修复               | 见 B100 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 已验收（探针 6/6 + 真实 loop 2 次）                                                                                                |
| B99  | P1     | **B98 的修正能力在交互面不可达**：`/goal resume` 只认单词 `resume`（`planGoalInvocation` 里 `token === 'resume'` 才匹配），REPL/TUI 无法传 `--accept`，也无法指定 task id——用户在 REPL 里看到 blocked 提示后唯一出路仍是退出到 headless                                                                                                                                                                                                     | **已实现**：`/goal resume [<task_id>] [--accept "<cmd>"]`（`parseResumeArgs`：可选 id + `--accept`/`--accept=`，多余 token 走 usage）；REPL 与 TUI 都经 `goalResumeArgs()` 生成 `/task resume <id> --accept "<cmd>"`（引号经 `quoteCommandArg`，`splitCommandArgs` 回读一致）；TUI 的 `runTaskShellCommand` 现在按"非 flag 位置参数"判断是否要自动补最新可恢复 id；`GOAL_USAGE` 同步                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 见 B99 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 已验收（探针 5/5 + 真实 PTY REPL：blocked→PASS）                                                                                   |
| B98  | P0     | **B97 的 blocked 提示不可执行**：`blockedReason` 让用户"修正验收命令后 resume"，但 `moss task resume` 无法替换已持久化的 oracle（`acceptanceCommandFromEvents` 只读 `task_created`，resume 一直重放坏命令）——提示与能力不一致，等于把用户引到死路                                                                                                                                                                                           | **已实现**：`moss task resume <id> --accept "<cmd>"` 经 `resumeTask(..., {acceptanceCommand})` 追加 `note{kind:"acceptance_command"}`（append-only，原命令可审计），`acceptanceCommandFromEvents` 反向扫描取最新 override；timeline 专用标签 `Acceptance command updated — <cmd>`，不再是匿名 `Note`；verdict 的 blocked 文案直接给出可复制的 `moss task resume <id> --accept "<cmd>"`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 见 B98 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 已验收（探针 9/9 + 真实链：blocked 36s → resume --accept 12s PASS）                                                                |
| B97  | P0     | **验收命令不可用/超时被当成"任务失败"**：`--accept "不存在的命令"` 时 bash 退出 127，引擎当作普通 FAIL 进入修复循环，模型花掉全部修复轮次去"修"一个根本装不上的命令（真实跑实测 113s、att:3/rep:2 之后才 blocked；Claude hooks 的 exit code/timeout 语义、Cursor hooks timeout 都区分基础设施失败与工作失败）                                                                                                                               | **已实现**：`acceptance-command` 新增 `failureKind`（`exit_nonzero` / `timeout` / `command_unavailable`，126/127/ENOENT/超时）；`TaskVerdict.blocked` 携带 `acceptance_timeout` / `acceptance_command_unavailable`；引擎在 acceptance 后直接 `blocked_on_user{reason}` 并返回 blocked（不写 acceptance_fail、不进 repair）；`task_acceptance` 工具同样立即 block 并明确告诉模型"重试无用、去修命令"；`goals.jsonl`/`moss task list` 记录并显示 blockedReason。普通非零退出仍走修复（探针里有对照）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 见 B97 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 已验收（探针 6/6 + 真实 deepseek：113s/rep:2 → 38.9s/att:0 rep:0）                                                                 |
| B96  | P1     | **没有目标级 rollup**：跨会话 / 多次 `/goal`、`task run`、`task resume` 之后，没有任何一个视图能回答「我提过哪些目标、哪些通过、哪些还挂着、各自跑了几轮多久」；只能逐个翻 `.moss/tasks.jsonl`、`task-events.jsonl`，而 `moss loop` 有自己的 ledger、workflow 有 state.json，三者互不相通。Cursor 有 run 历史、Claude 有任务目录。                                                                                                          | **已实现**：`runTaskCommand` 的 run/resume（REPL `/task`、`/goal`、TUI、headless 共用）在结束时写一行 `.moss/goals.jsonl`（taskId/goal/phase/outcome/attempts/repairs/turns/startedAt/endedAt/durationMs/acceptanceCommand/sessionKey，aborted 也写）；新增 `moss task list [--limit N] [--json]`（默认 20 条、最新在前、长目标与命令截断、zh/en）；store 用共享 JSONL 读取器容忍半行；写失败只 stderr 告警、不改任务退出码                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 见 B96 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 已验收（探针 6/6 + 真实 deepseek：pass→fail→resume 三次运行全部入账）                                                              |
| B95  | P0     | **`/goal`/`/task` 运行中按 Ctrl+C 完全没反应**：readline 被 pause、终端处于 raw mode，`0x03` 只是一个字节，没有监听器；用户想停止或调整方向时只能等它跑完（或杀进程丢进度）。Cursor 的 `/goal` 是 Ctrl+C 暂停、可继续；Claude 中断后也能 resume。而且中断后没有说明：task 标成 failed、没有任务 id、用户不知道该 `/goal resume`                                                                                                             | **已实现**：REPL `/task` 运行期间同时监听 `0x03` 字节（raw mode）与 SIGINT（非 raw），第一次暂停（AbortController→engine 记 `aborted`）、400ms 后的第二次才是硬退出；暂停后从快照里取最新可恢复任务，打印「paused by user (not a failure)」+ task id + 目标摘要 + `/goal resume` / `/task resume <id>` / `/goal clear`；TUI Esc 走同一份文案；恢复链路 `task_resumed` 事件与 timeline 已验证                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 见 B95 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 已验收（探针 4/4 + 真实 deepseek PTY：Ctrl+C 暂停→`/goal resume` 接续并 PASS）                                                     |
| B94  | P1     | **无人值守的 loop 没有审计轨迹、也没有整轮熔断**：`moss loop` 每轮的 sessionKey 只打印在 stderr，退出后无法回答「昨晚几轮、各自检查输出、耗时、为什么停」；`--max` 只限次数、`--every` 只限间隔，一次性 40 分钟的回合没有墙钟上限。Cursor 有 PR/branch 记录与云 VM 超时，Claude 有 task 目录与后台任务预算                                                                                                                                  | **已实现**：每轮尝试写 `.moss/loops/<runId>.jsonl`（attempt: 退出码/耗时/检查 stdout+stderr 尾部/sessionKey/agentError；summary: reason=`passed`/`attempts_exhausted`/`budget_exhausted`）；新增 `--max-duration` 整轮墙钟上限（两次尝试之间检查，不切断进行中的回合）；失败摘要额外列出 `git status` 改动；ledger 写失败只警告一次、不中断 loop                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 见 B94 证据                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 已验收（探针 3/3 + 真实 deepseek 三跑：通过/次数耗尽/预算耗尽）                                                                    |

**B107 证据（2026-11-06，探针 5/5 + 真实 deepseek-flash prune）**：

```
node scripts/verify/loop-prune.mjs
  ok prune deletes finished ledgers beyond --keep and keeps the newest
  ok a running loop (live pid) is never deleted, even when oldest
  ok --dry-run reports the would-delete set and touches nothing
  ok --json returns {runId,ledger,bytes,status,startedAt} for the removed runs
  ok bad --keep exits 2 and an empty ledger dir is a no-op
  5/5 checks passed
```

- 真实 deepseek-flash（临时工作区 `/tmp/b107-ws`，两次 `loop --until "true"` 均 exit 0）：
  - `loop prune --keep 1 --dry-run` → `would prune 1 of 2 run(s) (kept 1) · 610 B reclaimable (--dry-run, nothing deleted)`，两个账本仍在；
  - `loop prune --keep 1` → `pruned 1 of 2 run(s) (kept 1) · freed 610 B`，只删较旧 run，较新账本保留；
  - 随后 `loop list` → `loop runs (1 total · passed 1 · failed 0 · running 0 · interrupted 0, newest first)`；
  - `--json --keep 1`（对剩余唯一 run）返回一条记录；`--keep 0`/`--keep abc` → `--keep must be a positive integer`（exit 2）。
- 质量门：`npm run check` 绿；`npm run verify` PASS 55.4s（exit 0 实测，load 高——两个并行 worker 同时在 build/test；`loop-prune` stage 0.7s）。

**B106 证据（2026-11-06，探针 6/6 + 真实 run 健康度和筛选）**：

```
node scripts/verify/loop-health.mjs
  ok counts cover every status across the whole ledger
  ok the header counts all runs, newest first
  ok --status running narrows the table and keeps the per-status count
  ok --status failed includes exhausted and check_timeout runs
  ok a filter with no matches reports it without failing
  ok the command filters table and JSON, and rejects an unknown status
  6/6 checks passed
```

- 真实 deepseek-flash（同工作区：一个通过 run + 一个 `sleep 20`/`--until-timeout 1s` 的失败 run）：
  - `moss loop list` → `loop runs (2 total · passed 1 · failed 1 · running 0 · interrupted 0, newest first)`，两行明细正常；
  - `--status passed` → 表头 `— status passed (1)` + 只有通过行；`--status running` → `— status running (0)` + `no runs with status running`，exit 0；
  - `--json --status fail` → 只返回 check_timeout 那条（status/failed、`reason":"check_timeout"`）；
  - `--status sometimes` → `moss loop list: --status must be one of …`（探针断言 exit 2）。
- 质量门：`npm run check` 绿；`npm run verify` PASS 40.0s（exit 0 实测，load ~6.9；新 `loop-health` stage 0.2s，`loop-history`/`loop-status` 同步更新表头断言后仍全绿）。

**B105 证据（2026-11-06，探针 4/4 + 真实挂起 run）**：

```
node scripts/verify/loop-check-timeout.mjs
  ok a hung check stops the loop with reason check_timeout after one attempt
  ok list/show name the timeout instead of implying a failing check
  ok default cap is 10m and a passing check still succeeds
  ok --until-timeout validates and accepts ms/s/m/h
  4/4 checks passed
```

- 真实 deepseek-flash 挂起检查（临时工作区）：后台 `moss loop --until "sleep 25" --until-timeout 2s --max 3 "Reply … Do not run any commands."`，1s 后 `moss loop follow`：
  - `#1 agent 1.3s check TIMEOUT (2.0s) fail`，`[loop] finished: failed · 1 attempt(s) · 3.3s · reason=check_timeout`，follow exit **1**；
  - loop 自身 exit **1**，`att:1/3`（未烧剩余 2 轮）；`loop list` 原因 `check timed out (hang)`；`loop show` 打 `RESULT failed · check_timeout`；
  - 账本 summary 为 `{"type":"summary",…,"reason":"check_timeout","attempts":1,"untilTimeoutMs":2000,…}`。
- 质量门：`npm run check` 绿；`npm run verify` PASS 40.2s（exit 0 实测，load ~10.5；`loop-check-timeout` 0.9s）。

**B104 证据（2026-11-06，探针 4/4 + 真实 deepseek-flash 两 run 实时跟随）**：

```
node scripts/verify/loop-follow.mjs
  ok follows a live run: existing state as header, then new attempt and summary
  ok a finished run returns immediately with its summary
  ok a killed run reports interrupted instead of waiting forever
  ok defaults to newest, unknown ids and empty workspaces resolve to undefined
  4/4 checks passed
```

- 真实跟随（临时工作区，deepseek-flash）：
  - 通过型：后台 `moss loop --until "test -f made.txt" "Create made.txt …"`，1s 后 `moss loop follow latest --interval 300ms` → `[loop] following loop-mw3hglnl (pid 91101) — 0 attempt(s) so far…`、`19:49:46 #1 agent 15.4s check exit 0 (4ms) PASS`、`[loop] finished: passed · 1 attempt(s) · 15.5s · reason=passed`，follow exit **0**（loop 本身 exit 0）；
  - 失败型：`--until "test -f never-follow.txt" --max 1` + follow → `#1 agent 1.2s check exit 1 (6ms) fail`、`finished: failed · 1 attempt(s) · 1.2s · reason=attempts_exhausted`，follow exit **1**；随后 `loop list` 两行与 follow 输出一致。
- 质量门：`npm run check` 绿；`npm run verify` PASS（见提交说明）。

**B103 证据（2026-11-06，探针 6/6 + 真实 deepseek-flash 长跑）**：

```
node scripts/verify/loop-status.mjs
  ok liveness: current pid alive, impossible/absent pid dead
  ok listLoopRuns: running (live pid) vs interrupted (dead pid / legacy ledger)
  ok the table distinguishes in-flight runs from dead ones
  ok `loop show` prints the pid and says the run is still in progress
  ok `loop show` says the dead run is interrupted, not merely unfinished
  ok `--json` rows carry status + pid
  6/6 checks passed
```

- 真实长跑（临时工作区，deepseek-flash，`--until "test -f never-xyz.txt" --every 25s --max 3`）：
  - 运行中（起跑 ~8s 后）：`loop list` → `19:43:30  running  loop-mw3h8u27  att:1/1 …` + `↳ in progress (pid 83111)`；`loop show latest` 打 `PID 83111`、`RESULT running (no summary yet)`；账本首行确为 `{"type":"start","pid":83111,…}`；
  - 修掉 `att:1/1` 回退（start.maxAttempts）后 `kill -9 83111`：`loop list` → `interrupted  loop-mw3h8u27  att:2/3 …` + `↳ no summary and the process is gone …`；`loop show` → `RESULT interrupted (no summary and the process is gone)`，exit **1**。
- 质量门：`npm run check` 绿；`npm run verify` PASS 39.3s（exit 0 实测，load ~10.9；`loop-status` 0.2s / `loop-history` 0.3s / `loop-watch` 0.5s / `review-verdict` 0.2s / `loop-ledger` 1.1s 全绿；顺手修了 `goal-runs` probe 的 1ms 时钟抖动断言）。

**B102 证据（2026-11-06，探针 7/7 + 真实 deepseek-flash 审查 run）**：

```
node scripts/verify/review-verdict.mjs
  ok reader: newest record, finding counts, torn trailing line skipped
  ok structured FAIL holds an answer whose prose never said FAIL
  ok an answer that owns the open findings is allowed through
  ok a review record older than the run does not block it
  ok structured PASS outranks a stale FAIL sentence in an older tool result
  ok a sub-agent review with no ledger record still blocks via prose
  ok wrapper: injects the record-backed correction, bounded by the repair ceiling
  7/7 checks passed
```

- 真实 run（临时工作区，deepseek-flash，39s，exit 9=INCOMPLETE）：让 agent 原样写入带 SQL 注入的 `vuln.ts`，再用 rubric "no SQL injection; parameterized" 调 `review_changes`：
  - 账本落 `{"id":"e8b18ff9-…","verdict":"fail","reviewerSuccess":true,"findings":[{"severity":"critical","file":"vuln.ts",…},{"severity":"suggestion",…}]}`；
  - 模型最后一轮回答 "DONE."（未提 findings）→ 完成门用**结构化记录**拦截，session 里注入的修正原文：`The independent reviewer returned FAIL: 1 critical, 0 important, 1 suggestion finding(s) (record e8b18ff9-c2c2-4fb1-b8a4-72085359966c; \`moss review check\` exits 1 on it). Fix the blocking findings and call review_changes again so a new record passes, or report exactly which findings are still open and why…`；
  - 模型随后（在"不要改"的指令与门禁之间）选择诚实收尾：列出 `[critical] vuln.ts:1 SQL injection` 仍未解决，run 以 INCOMPLETE 9 结束而不是假 PASS。
- 质量门：`npm run check` 绿；`npm run verify` PASS 40.7s（exit 0 实测，load ~7.6；`review-verdict` stage 0.2s 全绿）。

**B101 证据（2026-11-06，探针 8/8 + 真实 deepseek-flash loop 两次）**：

```
node scripts/verify/loop-watch.mjs
  ok parser: --watch/--watch-timeout (space and =), defaults, and bad values
  ok a file rewrite changes the signature (size or mtime)
  ok a directory tree signature tracks child size/mtime
  ok a missing path has a distinct signature (creation counts as a change)
  ok an unchanged path times out with the elapsed wall clock
  ok waitForWatchChange resolves when the watched path appears
  ok the run table names the watch timeout as its own reason
  ok `loop show` prints the watched path and the pre-attempt wait
  8/8 checks passed
```

- 真实外部信号唤醒（临时工作区，deepseek-flash）：后台进程在 t≈22s 落地 `external2.txt`，前台
  `moss loop --until "test -f external2.txt" --watch external2.txt --watch-timeout 90s --max 3 "Reply with the word waiting…"`：
  - 27s、exit 0；日志 `waiting for external2.txt to change before attempt 2` → `external signal changed after 20046ms` → attempt 2 `check exit 0` → `passed after attempt 2`；
  - 账本 attempt #2 带 `waitedMs: 20046`，summary 带 `"watch": "external2.txt"`；`loop show` 打出 `WATCH external2.txt` 与 `#2  wait 20.0s  agent 4.9s  check exit 0  PASS`，exit 0（第一轮 wake 运行 30s 版本同结论）。
- 真实等待超时：`--watch never-external.txt --watch-timeout 4s --max 3` → 11s、exit 1；
  日志 `no change on never-external.txt within 4000ms (--watch-timeout); stopped instead of burning the remaining attempts`；
  `loop list` 显示 `fail … att:1/3 9.8s` + `↳ watch timed out`（**没有跑 attempt 2**，剩余轮次没被烧掉）；`loop show latest` RESULT `failed · watch_timeout`，exit 1。
- 质量门：`npm run check` 绿；`npm run verify` PASS 42.3s（exit 0 实测，load ~11.5；`loop-watch` 0.5s / `loop-history` 0.3s 全绿）。

**B100 证据（2026-11-06，探针 6/6 + 真实 deepseek-flash loop 两次）**：

```
node scripts/verify/loop-history.mjs
  ok listLoopRuns is newest-first, marks interrupted runs, tolerates a torn line
  ok the table shows counts, outcomes, the --until command, and limit overflow
  ok `loop list --json --limit 2` is valid JSON of the newest two runs
  ok `loop show` prints attempt detail, accepts latest/prefix, and exits 1 unless passed
  ok the detail body names the stop reason and every attempt
  ok unknown ids exit 1, bad --limit exits 2, an empty workspace is not an error
  6/6 checks passed
```

- 真实 loop（临时工作区，deepseek-flash）：
  - `moss loop --until "test -f ready.txt" "Create ready.txt …"` → 11s，exit 0，attempt 1 即通过；
  - `moss loop --until "test -f missing-never.txt" --max 1 "…do not create any file"` → 2s，exit 1。
  - `moss loop list` 两行最新在前：`fail loop-mw3gm4k1 att:1/1 1.2s test -f missing-never.txt` / `pass loop-mw3glvhu att:1/3 10.9s test -f ready.txt`，各带 `↳ 原因 · 账本路径`；
  - `loop list --limit 1` 截断并提示 `…1 more`；`loop list --json` 是合法 JSON（2 条，含 runId/passed/reason/attempts/until）；
  - `loop show`（latest=失败运行）输出 `RESULT failed · attempts_exhausted`、`attempts: 19:25:50 #1 agent 1.1s check exit 1 (7ms) fail`，exit **1**；
  - `loop show loop-mw3glvhu` 输出 `RESULT passed`、`ATTEMPTS 1/3 · 10.9s`，exit **0**；`show --json` 给原始记录。
- 质量门：`npm run check` 绿；`npm run verify` PASS 39.5s（exit 0 实测，load ~13.6；`loop-history` stage 0.3s，6 项探针全绿）。

**B99 证据（2026-11-06，探针 5/5 + 真实 PTY REPL）**：

```
node scripts/verify/goal-resume-args.mjs
  ok bare `/goal resume` keeps picking the newest resumable task
  ok `/goal resume [id] --accept "<cmd>"` names both the task and the new oracle
  ok malformed resume lines are a usage error, not a silent run
  ok the original `/goal <condition> --accept` path and usage text are intact
  ok the `/task` hand-off string survives quoting and re-parsing
  5/5 checks passed
```

- 真实链（临时工作区，deepseek-flash）：headless `task run "Create omega.txt …" --accept "no-such-oracle-binary-omega"` → 60s，exit 1，`Task … — BLOCKED`，`phase: blocked · attempts: 0 · repairs: 0 · failures: 1 · turns: 1`。随后 **PTY 里的 REPL**（`MOSS_NO_TUI=1`）输入 `/goal resume --accept "grep -q omega omega.txt"`：自动选中最新可恢复任务，输出 `Task task_mw3gfvot_yqqiie — PASS`，`phase: accepted · attempts: 1`，timeline `Resumed — resumed by user` / `Acceptance command updated — grep -q omega omega.txt` / `Evidence recorded ×2` / `Verification started` / `Acceptance passed — acceptance command exited 0`；`/quit` 正常退出。
- 质量门：`npm run check` 绿；`npm run verify` PASS 39.1s（exit 0 实测，load ~8.4；`goal-resume-args` stage 0.3s，5 项探针全绿）。

**B98 证据（2026-11-06，探针 9/9 + 真实 deepseek-flash 端到端）**：

```
node scripts/verify/acceptance-blocked.mjs
  … 7 项（见 B97）…
  ok resume --accept replaces the persisted oracle and the task can pass
  ok the timeline shows the oracle correction instead of an anonymous note
  ok the original command stays in history while the accepted task is closed
  ok the goal rollup carries the blocked reason into `moss task list`
  9/9 checks passed
```

- 真实 CLI（临时工作区，deepseek-flash）：`task run "Create fix.txt … zeta" --accept "no-such-oracle-binary-zzz"` → 36s，exit 1，`PHASE blocked (blocked · needs-user)`，`BLOCKED` 行给出 `moss task resume task_mw3gbgzf_vkww7p --accept "<command>"`；随后 `task resume <id> --accept "grep -q zeta fix.txt"` → 12s，exit 0，timeline `Resumed — resumed by user` / `Acceptance command updated — grep -q zeta fix.txt` / `Verification started` / `Acceptance passed — acceptance command exited 0`；`task list` 最新一条 pass（`att:1 rep:0 turns:1`，`↳ grep -q zeta fix.txt`），旧 blocked 行仍带原坏命令与原因。
- 质量门：`npm run check` 绿；`npm run verify` PASS 39.1s（exit 0 实测，load ~11.6；`acceptance-blocked` stage 3.3s，9 项探针全绿）。

**B97 证据（2026-11-06，探针 6/6 + 真实 deepseek-flash 对照）**：

```
node scripts/verify/acceptance-blocked.mjs
  ok a plain non-zero exit stays an ordinary failure (repair can help)
  ok missing command (127) and timeout are classified as harness failures
  ok the engine blocks instead of burning repair turns on a broken harness
  ok the timeline names the blocked state
  ok an ordinary failure still enters repair (the short-circuit is specific)
  ok the goal rollup carries the blocked reason into `moss task list`
  6/6 checks passed
```

- 真实 CLI（临时工作区，deepseek-flash）：`task run "…gamma…" --accept "definitely-not-a-real-binary-xyz --version"`：
  - 修复前：113.2s，`BLOCKED · attempts:3 repairs:2`，模型在轮内自己反复 `task_acceptance` 失败后还做了一轮诊断/修复。
  - 修复后：38.9s（第二次 41.1s），`phase: blocked · attempts:0 · repairs:0 · failures:0 · turns:1`；timeline `Blocked — needs user — acceptance command is unavailable (exit 127) — nothing the agent writes can fix a missing command; install it or correct --accept, then resume`；命令退出码 1；`task list` 行 `blocked` + `↳ 原因` + `↳ 命令`，`--json` 里带 `blockedReason`。
- 质量门：`npm run check` 绿；`npm run verify` PASS 37.1s（exit 0 实测，load ~9.6；`acceptance-blocked` stage 2.6s 已进 FAST_GATE）。

**B96 证据（2026-11-06，探针 6/6 + 真实 deepseek-flash 三次运行）**：

```
node scripts/verify/goal-runs.mjs
  ok recorded rows round-trip with durations and the deciding command
  ok the ledger lives in .moss and is git-ignored like the other runtime artifacts
  ok a torn write does not hide earlier rows
  ok the table is newest first, clips long goals and shows the deciding command
  ok --limit caps rows and the zh projection is localized
  ok a workspace without runs reads as empty, not an error
  6/6 checks passed
```

- 真实 CLI（临时工作区，deepseek-flash）：
  1. `task run "Create pass-goal.txt containing alpha…" --accept "grep -q alpha pass-goal.txt"` → PASS（13.8s）。
  2. `task run "Do not create any file…" --accept "test -f never.txt" --max-repairs 0 --max-turns 2` → FAIL（2m33s，`att:3 rep:2`）。
  3. 手动建 `never.txt` 后 `task resume <task_id>` → PASS（20.7s，timeline `Resumed — resumed by user → … → Acceptance passed`）。
  4. `task list` 三行全部在、同一 taskId 的 fail→resume pass 相邻可见；`task list --json --limit 2` 输出合法 JSON（version/runId/taskId/outcome/durationMs/sessionKey）；`--limit 1` 只回一行；REPL 里 `/task list` 同样渲染。
- 质量门：`npm run check` 绿；`npm run verify` PASS 36.9s（exit 0 实测，load ~9.2；`goal-runs` stage 0.2s 已进 FAST_GATE）。

**B95 证据（2026-11-06，探针 4/4 + 真实 deepseek-flash PTY 全链）**：

```
node scripts/verify/goal-pause.mjs
  ok en notice names the pause, the task and both resume paths
  ok long goals are truncated without losing the task identity
  ok zh notice is localized
  ok no-candidate branch says there is nothing to resume
  4/4 checks passed
```

- 真实 REPL（PTY，deepseek-flash，临时工作区）：`/task run "Create five files a.txt..e.txt …" --accept "test -f e.txt && grep -q hihi e.txt"`；运行中（任务已 task_define、plan_ready 之后）发送 Ctrl+C：
  - 修复前实测：`0x03` 被吞，任务继续跑到 PASS，`task-events.jsonl` 里没有 abort —— Ctrl+C 是 no-op。
  - 修复后：进程存活，stderr 打印 `[goal] paused by user (not a failure)…`、`[goal] task task_mw3ff1cb_bc136z (paused): Create a.txt, …`、`continue with /goal resume (or /task resume task_mw3ff1cb_bc136z); abandon with /goal clear.`；`task-events.jsonl` 记 `task_failed{detail:"aborted"}`。
  - 随后输入 `/goal resume`：timeline `Task aborted → Resumed — resumed by user → Evidence recorded ×2 → Verification started → Acceptance passed — acceptance command exited 0`，最终 `Task task_mw3ff1cb_bc136z — PASS`，五个文件都在。
- 质量门：`npm run check` 绿；`npm run verify` PASS 42.3s（exit 0 实测，load ~11.2；`goal-pause` 0.2s 与 `loop-ledger` 0.8s 已进 FAST_GATE，`loop-command` probe 7/7）。顺带修复 B94 遗留：`parseLoopDuration` 按 flag 给出 `--every` / `--max-duration` 专属报错，探针同步新文案。TUI 的 Esc 暂停复用同一份文案，未单独做 PTY 体感测试（既有 Esc→abortSignal 路径不变）。

**B94 证据（2026-11-06，探针 3/3 + 真实 deepseek-flash 三跑）**：

```
node scripts/verify/loop-ledger.mjs
  ok every attempt is recorded and the summary names attempts_exhausted
  ok a pass is recorded as passed after one attempt
  ok --max-duration stops with budget_exhausted instead of max attempts
  3/3 checks passed
```

- 真实 CLI（临时工作区；检查命令决定成败，模型只负责干活）：
  1. `--until "grep -q hello ok.txt"` + 让模型建 ok.txt → attempt 1 exit 0，进程 exit 0；ledger `loop-mw3ezea8.jsonl` 的 summary `passed:true, attempts:1, reason:"passed", totalDurationMs:9092`。
  2. `--until "false" --max 2` → 两轮都 exit 1，进程 exit 1；ledger `loop-mw3eznn0.jsonl` 有 2 条 attempt（1600ms / 25137ms，均 `exitCode:1`）+ summary `reason:"attempts_exhausted", attempts:2, totalDurationMs:26748`。
  3. `--until "false" --max 3 --max-duration 1ms` → 只跑 1 轮就停，进程 exit 1；summary `reason:"budget_exhausted", attempts:1, maxAttempts:3, maxDurationMs:1`；stderr 不再错误地承诺"下一轮会收到输出"。
- 质量门：`npm run check` 绿；**更正**：B94 提交时 `npm run verify` 实际因 `loop-command` 探针仍在匹配旧文案（`still exited 7 after 2 attempts`）而失败——提交说明里的 PASS 是 grep 吞掉退出码造成的误报；B95 已同步探针（7/7）并补跑全绿。

**B93 证据（2026-11-06，探针 4/4 + 真实 deepseek-flash 两轮 rewind）**：

```
node scripts/verify/rewind-conversation.mjs
  ok countSessionMessages tracks the stored history
  ok rewindConversation drops exactly the undone turn
  ok a forward target truncates nothing
  ok a checkpoint carries the rollback point across a restart
  4/4 checks passed
```

- 真实 CLI（PTY，deepseek-flash；新 session `rewindconv`）：
  1. 回合 1：「the secret word is BANANA」→ 模型 OK。
  2. 回合 2：「changed: it is now ORANGE」+ `write_file secret.txt` → 模型 OK，文件落盘 `ORANGE`。
  3. `/rewind` → `1 checkpoint(s): seq=2 [The secret word has changed: …] (1 files)`（空回合 1 不产生恢复点，符合设计）。
  4. `/rewind 2` → `Restored 1 file(s) to checkpoint 2. ✓ …/secret.txt` + **`Dropped 7 message(s) from the LLM context: this turn is no longer remembered.`**；`ls` 确认 `secret.txt` 已被删除（恢复为写入前不存在）。
  5. 同一会话接着问「What is the current secret word?」→ 答 **BANANA**（不是 ORANGE）——证明被撤销的回合已不在上下文里。
  6. 退出后用同 session 起**新进程** `-p "What is the current secret word?"` → 仍答 **BANANA**，证明截断落到了持久化历史，不只是进程内状态。
- 质量门：`npm run check` 绿；`npm run verify` 见提交说明。

**B92 证据（2026-11-06，探针 3/3 + 真实 deepseek-flash 跨进程 /rewind）**：

```
node scripts/verify/checkpoint-persist.mjs
  ok checkpoints and files are restored from a fresh store instance
  ok retention is 100 and pruning removes orphaned backups
  ok corrupt metadata degrades to an empty list instead of throwing
  3/3 checks passed
```

- 真实 CLI（PTY，`MOSS_NO_TUI=1`，workspace 里 `rewind-target.txt` 初始为 BEFORE）：
  1. 第一段会话 `--session rewindtest`，prompt「Use write_file to replace rewind-target.txt with exactly AFTER」→ 文件变 AFTER，
     落盘 `.moss/checkpoints/rewindtest/checkpoints.json`。
  2. 进程退出，第二段会话用**同一** `--session rewindtest` 重开：`/rewind` → `1 checkpoint(s)`（seq=1, `Use write_file to replace…`）；
     `/rewind 1` → `Restored 1 file(s) to checkpoint 1. ✓ /private/tmp/moss-rewind/ws/rewind-target.txt`，读回内容 = `BEFORE`。
- 质量门：`npm run check` 绿；`npm run verify` 见提交说明（新 stage `checkpoint-persist` 0.4s）。

**B90 证据（2026-11-05，已实跑：探针 4/4 + 真实 deepseek-flash 五跑）**：

```
node scripts/verify/add-dir.mjs
  ok resolves, realpaths, dedupes, drops the workspace, and rejects missing paths/files
  ok added roots are contained, other paths still escape, and symlinked roots stay refused
  ok safePath accepts extra roots and keeps the workspace-only default
  ok environment layer names added dirs, states the no-discovery caveat, and stays silent otherwise
  4/4 checks passed
```

- 真实 CLI（deepseek-flash，临时配置目录；workspace=`…/ws`，附加目录=`…/other`）：
  ```
  --accept-edits --add-dir other            → write_file 成功写入 other/added.txt（内容 hello-added，读回一致）
  --accept-edits（无 flag，对照）            → "Workspace file tool blocked path outside the sandbox: … Path escapes workspace"
  --workspace-write --add-dir other --allowed-tools "exec(echo *)" → `echo hi-exec > other/exec.txt` 执行成功（exit 0，文件内容 hi-exec）
  --workspace-write（无 add-dir，对照）      → "Incomplete: … Blocked by: write outside the workspace"
  --add-dir /tmp/…/nope                     → "[moss] --add-dir directory does not exist: …"（启动即失败）
  ```
- 启动公告（真实 stderr）：`[moss] additional directories for this run: /private/tmp/…/other (file tools may read/write; no AGENTS.md/skills loaded from there)`。
- 顺带发现一个**既有 bug**（不在本片修，记为 B91）：macOS 上 shell 写的静态检查不做 realpath，`/tmp/...` 形式会与 `/private/tmp/...` 根不匹配而被误拦（即使路径就在 workspace 内）；文件工具走 `assertSandboxPath` 的 realpath 分支所以不受影响。
- 质量门：`npm run check` 绿；`npm run verify` PASS（见提交说明）。

**B89 证据（2026-11-05，已实跑：探针 2/2 + 真实 deepseek-flash 三跑）**：

```
node scripts/verify/cli-tool-rules.mjs
  ok flags parse both spellings, split on commas, accumulate, and reject empty values
  ok session rules allow the named calls, deny wins, and nothing else is pre-approved
  2/2 checks passed
```

- 真实 CLI（deepseek-flash，`MOSS_CONFIG_DIR` 临时目录，`--workspace-write`；prompt 要求 `exec` 跑 `echo hi-from-exec`）：
  ```
  无 flag              → "Blocked by: needs approval (could not ask) `exec: echo hi-from-exec`"（同一命令）
  --allowed-tools "exec(echo *)" → 工具结果 hi-from-exec，模型回复 "hi-from-exec"
  ```
- `--full-access --disallowed-tools "write_file"` → `write_file` 被拒：
  `Tool execution denied: Tool "write_file" blocked by deny rule write_file (session). ...`，且文件确实没创建
  （模型随后 `read_file blocked.txt` = file not found）。
- 交互启动公告（`MOSS_NO_TUI=1` 管道 REPL）：`[moss] this run's CLI tool rules: allow exec(echo *), allow write_file, deny exec(rm *) (not persisted)`。
- 质量门：`npm run check` 绿；`npm run verify` PASS（见提交说明）。

**B88 证据（2026-11-05，已实跑：探针 4/4 + 真实 deepseek-flash REPL 双跑）**：

```
node scripts/verify/skill-hook-once.mjs
  ok hooks.json keeps boolean `once`, and a string once value is a rejected entry
  ok one claim per run, and success retires the hook
  ok failure re-arms the hook; non-once entries survive retirement
  ok re-invoking the skill re-arms its once hooks
  4/4 checks passed
```

- 真实 deepseek-flash REPL（PTY；同一 workspace 放两个 fixture 技能，hook 都是 PostToolUse + matcher exec，
  一个条目带 `once: true`、一个不带；同一 prompt：把 3 条 `echo` 作为 3 个独立 exec 调用）：
  ```
  hooked        (once: true)  → real exec calls 3, hook runs 1   (skill tool 行 2)
  hooked-every  (no once)     → real exec calls 3, hook runs 6
  ```
  即 once 守卫只吃首个成功运行；不带 once 的同类 hook 每个 exec 都触发（含模型自己做的诊断 exec）。另一次真实运行
  的 skill 工具输出为 `Skill hooks active for the rest of this session: PostToolUse 1 (1 once)`。
- 失败重新武装、并发 claim 只跑一次、重新 invoke 重新武装由探针钉住（hook 进程副作用用真实 `runHook`
  在既有 `skill-hooks` stage 覆盖；本探针覆盖 claim/retire 状态机）。
- 质量门：`npm run check` 绿；`npm run verify` PASS（见提交说明）。

**B87 证据（2026-11-05，已实跑：探针 5/5 + 真实 deepseek-flash headless + 真实 REPL）**：

```
node scripts/verify/mcp-resource-mentions.mjs
  ok mention grammar: server:scheme://uri only, deduped, files/agents/Windows paths untouched
  ok trailing sentence punctuation is stripped from the URI
  ok one failing resource is a note, and the healthy ones still attach
  ok truncation, 3-resource cap and the no-session note keep the prompt bounded
  ok registry.readResourceText reads the live mock server and errors honestly
  5/5 checks passed
```

- 真实 headless（deepseek-flash，workspace `.moss/mcp.json` 指向 mock stdio server）：
  `moss -p "… @mock:mock://doc/one …" --output-format stream-json`
  → stderr `[mcp] attached mock:mock://doc/one (21 chars)`；
  最终 result `mock resource content`，`num_turns: 1`，**tool_start/tool_end 事件 0 条**，2,991 ms。
  对照：未加「已附加，无需再调工具」提示的第一次真实运行中，模型仍调了一次
  `mcp__mock__resources`（`num_turns: 2`，4,392 ms）——块头这句话是实测有效的成本修复。
- 真实 REPL（`MOSS_NO_TUI=1` PTY，同一 workspace/config）：输入
  `What is the exact text of @mock:mock://doc/one? …` → 先打印 `[mcp] attached mock:mock://doc/one (21 chars)`，
  随后直接回答 `mock resource content`，无工具调用。
- 失败路径：未知服务器 → `Unknown MCP server "nope".`；未知 URI → 协议错误；两者都只产生一行
  `[mcp] … not attached: … — check the server with /mcp.`，健康资源仍然附加。
- 质量门：`npm run check` 绿；`npm run verify` PASS（见提交说明）。

**B86 证据（2026-11-05，已实跑：探针 4/4 + 真实进程 prompt 层报告 + 真实 `/skills`）**：

```
node scripts/verify/skill-catalog-budget.mjs
  ok budget = 1% of the window in chars (8k ceiling, 800-char floor, 8k fallback)
  ok 40 skills stay under every window budget and compress instead of overflowing
  ok SDK fallback catalog scales with contextTokens (and keeps the 8k fallback when unknown)
  ok /skills uses the window budget in-session and the 8k fallback without a window
  4/4 checks passed
```

- 真实进程（deepseek-flash@latest，12 个 workspace 技能 + 真实用户技能共 31 个，同一份配置只改 `agent.contextTokens`）：
  `MOSS_PROMPT_LAYERS=1` 的层报告——
  ```
  32k 窗口:  cli:skills  1279 chars  (skills 31, 1279/6203 chars, omitted 0, strategy mixed)
  200k 窗口: cli:skills  6203 chars  (skills 31, 6203/6203 chars, omitted 0, strategy full)
  ```
  即 8,000 字符上限正好是 200k 窗口的 1%，大窗口保持满详情；32k 窗口每轮省 ≈1,231 tokens。
- 真实 REPL `/skills`（32k 窗口）：`31 skill(s); catalog 1279/1280 chars (strategy mixed, 6203 without a budget)`；
  同一次会话的 `/context` 显示 `usage ~0 / 32,000 tokens`，目录不再挤占窗口。
- 800 字符下限与 8,000 兜底由探针钉住；`MOSS_SKILLS_CATALOG_BUDGET` 覆盖语义未变。
- 质量门：`npm run check` 绿；`npm run verify` PASS（见提交说明）。

**B85 证据（2026-11-05，已实跑：确定性探针 7/7 + 真实 deepseek-flash 两条路径）**：

```
node scripts/verify/skill-model-invocation.mjs
  ok disable-model-invocation parses booleans, defaults to invocable, fails open with an issue
  ok model catalog drops user-only skills; the renderer stays a pure filter boundary
  ok skill tool refuses a user-only skill with guidance and no body
  ok ordinary skills still load through the same tool
  ok user-only skills keep their slash command (user-invocable)
  ok /skills marks user-only entries and reports the model-visible catalog budget
  ok the user-only skill slash command inlines the body; ordinary skills keep the tool path
  7/7 checks passed
```

- 真实模型 A（模型侧，headless deepseek-flash，`-p "Load the skill named release-deploy and do what it says."`）：
  `skill` 工具返回 `Skill "release-deploy" is user-invocable only (disable-model-invocation: true) …`，
  模型回给用户"我加载不了，请你运行 `/release-deploy`"，工作区**没有**生成 `release-notes.md`。
- 真实模型 B（用户侧，REPL PTY 输入 `/release-deploy`）：slash 解析直接内联技能正文，模型按正文步骤
  创建了 `release-notes.md`，首行逐字为 `Release deploy skill executed by the operator.`。
- 同一工作区真实 `/skills`：

  ```
  name                scope     used  catalog   evals description
  ordinary           workspace 0     145      -     A normal model-invocable helper skill
  release-deploy     workspace 0     user-only -    Publish a release (operator-only; run it with its slash command)

  2 skill(s); catalog 145/8000 chars (strategy full, 145 without a budget). `user-only` skills …
  ```

  （145 字符只含 ordinary，user-only 技能不占目录预算。）

- 质量门：`npm run check` 绿；`npm run verify` PASS（见提交说明）。

**B84 证据（2026-11-05，已实跑：确定性探针 9/9 + 真实 deepseek-flash PTY）**：

```
node scripts/verify/mcp-prompt-slash.mjs
  ok promptCatalog lists templates and keeps a broken server as a failure row
  ok expandPrompt renders prompts/get messages for a turn
  ok unknown server and unknown prompt reject instead of submitting empty text
  ok /mcp prompts lists templates and failure rows
  ok /mcp prompt submits the expanded template as a turn
  ok /mcp prompt without a name prints usage instead of submitting
  ok /mcp prompt rejects a non key=value argument
  ok /mcp prompt reports a failed expansion instead of a turn
  ok /mcp list is an alias for /mcp prompts
  9/9 checks passed
```

- 真实模型 E2E（deepseek-flash@latest，`MOSS_NO_TUI=1` 的 REPL + PTY，工作区 `.moss/mcp.json` 指向
  `scripts/verify/fixtures/mcp-mock-server.mjs`）：

  ```
  › /mcp prompts
  MCP prompts
  mock/greet (who) — Greeting template

  Run one with: /mcp prompt <server> <name> key=value...

  › /mcp prompt mock greet who=Ada
  Running MCP prompt "greet" from "mock" (1 message).
  Hello! Quick note: I'm Moss, not Ada — ...   ← 模型收到 "Hello Ada" 后真实回复
  ```

- 回归对照（同环境真跑）：裸 `/mcp` 仍打印 `MCP / ● mock — connected (4 tools, lazy)`，
  `requiresArgs` 没有抢走宿主状态面板。
- 质量门：`npm run check` 绿；`npm run verify` PASS（见提交说明）。

**B83 证据（2026-11-05，已实跑：计时对照 + 全门回归）**：

- 定位：`run-tests-verdict` 探针独立跑 0.7s，全门里显示 17.7s；`git` 上该 stage 无改动。
  缩小到「只有 `repl-interrupt` 同池」时复现 10.0s 差；`repl-interrupt` 用 `spawnSync` 跑 python PTY 驱动，
  阻塞 orchestrator 事件循环，导致同池 stage 的 child `close` 回调排队。
- 改动：`build`、`smoke`、`context-surface`、`repl-interrupt`、`slash-dispatch`、`todos-view` 六个
  stage 的 `spawnSync` 全部换成 `runProcess` / `captureProcess`（异步、带超时语义）；
  `scripts/verify/stages/` 下已无 `spawnSync`（`grep` 为空）。
- 全门实测（macOS，warm cache）：
  ```
  run-tests-verdict ok   0.7s   （改前 17.7s；顺序跑 0.7s）
  context-surface  ok    3.2s
  repl-interrupt   ok   12.8s
  slash-dispatch   ok    4.3s
  todos-view       ok    2.0s
  [verify] budget 60s: ok (36.9s)
  [verify] PASS in 36.9s        （改前 46.3s）
  ```
- 六个 stage 单独 `--stage` 跑均 ok（build/smoke/todos-view/slash-dispatch/context-surface/repl-interrupt）；
  `npm run check` 绿；`npm run verify` 两次 PASS（38.2s / 36.9s）。
- 规则落地：`docs/design/ci-and-verify.md` 新增「Stages must not block the event loop」一节，
  写明用异步 helper、这次 17.7s→0.7s 的证据，避免新 stage 重犯。

**B82 证据（2026-11-05，已实跑：确定性探针 + 同一模型的真实会话前后对照）**：

```
node scripts/verify/run-tests-verdict.mjs（0.8s）：
  ok exit 0 with an unparsed custom reporter is a pass with a counts caveat
  ok a non-zero exit is still a failure
  ok recognized runner counts are still parsed
  ok timeout is still a failure
  ok a command that cannot run is still a failure
  ok no-runner and not-started guards are unchanged
  6/6 checks passed
```

- 改前（真实 deepseek-flash，`/tmp/moss-disc` 里修 1 行 bug）：模型 `edit_file` 后再跑 `run_tests {command:"npm test",suite:true}`，
  工具返回 `Test Results: ⚠️ exit 0, counts unknown` + `tests_pass=false`；模型不信这个绿跑，
  又追加一次 `exec npm test` 拿原始输出才敢下结论（7 条 assistant 消息，多一轮工具）。
- 改后（同一模型）：自定义 reporter 仓库（`npm test` → `node check.mjs` 打印 `ALL GREEN: 3 assertions satisfied`，exit 0），
  提示模型必须用 `run_tests` 跑一次。工具返回
  `Test Results: ✅ exit 0 (pass/fail counts could not be parsed)` + `tests_pass=true` + caveat；
  模型终稿直接引用 `tests_pass=true` 并说明「计数不可解析，结论来自退出码」，没有再补 `exec`。
- 确定性探针覆盖：自定义 reporter exit 0 → true；exit 1 → false；`node --test` 已知 reporter 仍解析计数；
  超时/命令不存在 → false；无 runner 的 `suite:true` 与裸调用（B 线刻意不启动）语义不变。
- 质量门：`npm run check` 绿；`npm run verify` PASS（见提交说明）。
- 诚实记录：全门里这个新 stage 的 duration 显示 17.7s，但探针内部实测 0.7s、单独/顺序跑都 0.7s；差额来自同池 `repl-interrupt` 的 `spawnSync` 阻塞 orchestrator 事件循环（本轮已定位并记为 B83），不是探针变慢。

**B81 证据（2026-11-05，已实跑：6 条确定性探针 + 真实 deepseek-flash 会话，同一构建）**：

```
node scripts/verify/skill-hooks.mjs（探针，0.3s）：
  ok frontmatter hooks path parsed; escaping path rejected with an issue
  ok skill invocation activates hook entries and warns about dropped events
  ok PreToolUse skill hook blocks only the matching call
  ok PostToolUse skill hook runs after the tool call
  ok gate composition unchanged; clearing state removes the dynamic hooks
  ok broken hooks files fail the skill load instead of loading without the guard
  6/6 checks passed
```

- 探针走的是真实 hook 管道：hooks 文件里的 `command` 由真子进程执行（`node -e "process.exit(2)"` 阻塞、
  `writeFileSync` 落 PostToolUse 标记），断言 `onBeforeToolExec` 返回 `approved:false` 且 reason 含
  `PreToolUse hook`；`matcher`/`if` 未命中的调用仍放行。
- 负向控制：`clearSkillHookState()` 后同一个 `exec(rm *)` 请求被审批门放行（说明拦住它的是技能 hooks 而非别的层）；
  另断言无静态 hooks 时 `composePreToolUseGate` 仍调用审批门（本轮把 `onBeforeToolExec` 从「无条目即
  undefined」改成常驻定义，探针证明审批语义未变）。
- 越界路径：`hooks: ../outside.json` → 技能 manifest 不带 hooks，`issues` 记 `unsafe-hooks-path`；
  声明了但缺失/坏 JSON → 技能工具返回 `was not loaded: …` 且**不返回正文**（fail closed）。
- 真实模型 E2E（临时工作区 + 技能 `guard`，hooks.json `PreToolUse: exec + if: exec(rm *) → exit 2`，
  `--trust-workspace -p "先加载 guard，再 exec rm -rf /tmp/..."`）：模型先调 `skill`（46ms，结果里出现
  `Skill hooks active for the rest of this session: PreToolUse 1`），随后 `exec` 被
  `Blocked by PreToolUse hook: hook exited 2` 拒绝，进程 exit 9（Incomplete），目标目录未被删除。
- 质量门：`npm run check` 绿；`npm run verify` PASS 42.8s（新 stage `skill-hooks` 0.3s，其余 40+ stage 全绿）。

**B32 证据（2026-11-05，已实跑）**：模块加载计数器（`module.registerHooks`）跑 7 次真实 `-p`：

- 改造前 dist 377 个模块，其中含 `cli/tui/{transcript,composer,markdown,code-style,theme}.js`、`cli/status-line.js`、`cli/usage-display.js`、
  `core/task-runtime/runtime.js`；
- 改造后 370 个：上述 8 个消失，新增 3 行的 `cli/diff-preview.js`；
- 墙钟中位 583ms → 606ms（min 564 → 559）——**噪声内，本轮只声称图更小**；
- 行为：`-p` 让模型把文件 20 行改掉，headless diff 预览仍**恰好 14 行**后打印 `... 27 more lines ...`（`DIFF_PREVIEW_LINES` 语义未变）。

**B80 证据（2026-11-05，已实跑：拆前/拆后同一台机器上的真实验证门 + 逐 stage 计时）**：

```
拆分前（HEAD 的 worktree，`npm run verify`）：PASS in 2m 30.3s
  其中 tiny-window-surface 单 stage 41.5s（当时机器在外会话 build 负载下；空闲时 24.1s）
拆分后（四 stage 独立跑，隔离副本，同机）：
  tiny-window-surface     ok in 0.2s   ← 只留纯模块断言
  tiny-window-cli-boot    ok in 1.6s   ← 3 次 -p 启动（4096 / 32k / MOSS_TINY_WINDOW_TOOLS=0）
  tiny-window-diagnostics ok in 5.6s   ← 3 次 moss doctor（4096 / 32k / 100k）
  tiny-window-tui-notice  ok in 13.1s  ← 1 次 PTY TUI（B78 的晚到探测）
  池内关键路径 = max ≈ 13.1s，替代原 24.1–41.5s 的串行 stage；且三组 boot 与其余 40+ 探针重叠
```

- 断言内容不变：拆出来的三个探针逐字复用原来的断言（4096 提示 / 32k 与 forced-off 静默；doctor tiny/lean/无档；PTY 晚到提示）。
- 归类理由：verify 调度器按 `requires` 并行（默认池 4，`startup-timing` 独占），所以把一个 stage 里串行的 boot 拆成「有依赖关系的独立 stage」是唯一能吃到并行的方向；`scripts/verify/lib/tiny-window-boot.mjs` 统一夹具避免四份复制。
- 质量门：四 stage 独立 `--stage` 全绿；下一轮候选里继续守 60s（本轮测量时外会话正在 build，数字受负载影响，需在干净 worktree 复测整门）。

**B79 证据（2026-11-05，已实跑：真实 headless 会话写入 usage + 真实 REPL + 真实 TUI PTY，三层同一工作区）**：

```
工作区：.moss/skills/alpha（workspace，被真实会话加载过 1 次）、config/skills/beta（user）
moss skill list：
  name                scope     used  catalog   evals description
  alpha              workspace 1     141      -     Alpha skill for workspace-scope demo
  beta               user      0     138      -     Beta skill installed at user scope
REPL `/skills`（改造后）：与上面逐行一致（探针断言 header + parity 行逐字出现）
TUI `/skills`（PTY，改造前 → 改造后）：
  前：Skills alpha Alpha skill for workspace-scope demo (1 skill(s) · load with the skill tool)
  后：name scope used catalog evals description / alpha workspace 1 141 - Alpha skill …
      1 skill(s); catalog 141/8000 chars (strategy full, 141 without a budget)
```

- usage 列不是造出来的：先跑一次真实 headless 会话让模型调用 `skill`(alpha)，`.moss/skills-usage.json` 记录 `count: 1`，两个界面都读到 1。
- 固化为 verify 断言（`skill-catalog-usage`，+1 条，0.6s）：临时工作区+临时 config 起真实 REPL，断言 `/skills` 打印的 header 与 parity 行和 `renderSkillsList` 逐字相同（旧实现只有窄行，会 fail）。
- 质量门：见提交说明（干净 worktree 复核）。

**B78 证据（2026-11-05，已实跑：PTY 起真实 TUI + 本地 /v1/models 桩，配置里不写 `agent.contextTokens`，让窗口只能来自探测）**：

```
场景（完全相同的 PTY 脚本、unprobed 配置、桩报 4096）：
  改造前构建（/tmp/dist-b77-root）：tiny notice seen: False   ← 真 bug 复现
  改造后构建（/tmp/dist-b78-root）：tiny notice seen: True
    渲染文本：⏵⏵ full mode on · m · ? for shortcuts  ⏸ [moss] This model's context window is
    small (4k tokens): only the 5 core tools are offered, compaction uses a local summary,
    and each reply is capped at 682 tokens. …
  对照（桩报 32000 / 200000，改造后）：均无提示
```

- 附带修掉的同源问题：TUI 的 `cli:context-window` 提示层原本也会把一个 4k 窗口说成 1000k；现在 probe 落地后按 `provider-api` 值重写该层（dynamic 层，不破坏前缀缓存）。
- 固化为 verify 断言：`tiny-window-surface` 用 Python `pty` + 本地桩起一次真实 TUI，断言降级提示在**晚到 probe 之后**出现（探针独立 17.0s，其中 PTY 约 8s）。反向（宽窗口不提示）由同函数 headless 断言覆盖，避免再加一次 8s PTY boot。
- 质量门：见提交说明（干净 worktree 复核）。

**B77 证据（2026-11-05，已实跑：真实 `moss doctor` × 6 种窗口；en/zh 双语文案核对；verify 断言固化）**：

```
窗口     tiny 行   lean 行
 4096      yes       -
 8192       -       yes        ← 有效预算 6144 ≤ 64k
32000       -       yes
64000       -       yes        ← 边界：原始窗口 64k，有效预算仍 ≤ 64k
100000      -        -         ← 有效预算 > 64k，完整声明
200000      -        -
zh 行样例：ok 精简档位： 工具描述已精简、schema 已裁到一次一步的参数（exec：command + timeout；edit_file：单次编辑）。
           需要完整声明请把 agent.contextTokens 提到 64k 以上。
```

- 判定与运行期同源：wire 用的是 `shouldLeanToolDescriptions({ contextWindowTokens: effectiveContextTokens })`，doctor 传同一个有效预算，所以「诊断说 lean」= 「请求里真的 lean」。
- 固化为 verify 断言：`tiny-window-surface` 现在 boot doctor 三次——4096 必须有微型档且不得再叠加 lean 行、32k 必须有 lean 行且含 `pruned to one-step parameters`、100k 两者都不得出现（探针独立 5.5s）。
- 质量门：本 checkout 的 `npm run check` / `npm run verify` 被**另一会话未提交的 `src/core/workflow/workflow-runner.ts`** 打断（tsc TS6133 `byId`/`results`、eslint no-unused-vars），与本轮改动无关；改动本身在干净 worktree（HEAD 上不含外来未提交文件）复核，结果见提交说明。

**B76 证据（2026-11-05，已实跑：stub 抓 32k/200k 请求 tools 字段 + 32k 真实工具链；`MOSS_LEAN_TOOLS=0` 做同树 A/B）**：

```
32k 窗口，默认（自动 lean）：est 4083、15 工具、exec 2 属性、edit_file 4 属性
32k 窗口，MOSS_LEAN_TOOLS=0 ：est 4960、exec 7 属性、edit_file 5 属性   ← 同一 dist，只差裁剪
200k 窗口，默认            ：est 4960、exec 7 / edit_file 5（与改造前一致）
200k 窗口，强制 lean       ：est 4084、exec 2 / edit_file 4            ← 证明差值来自裁剪本身
32k 行为验证：exec 链 N=6 → 7 请求 0 拒绝、exit 0；文件工具 write→read→edit 全部执行成功，
  工作区 probe.txt 落盘内容 "hello moss"（裁剪后的 schema 不影响工具执行）
```

- 与 B73 的 32k 对照（est 4318，lean 描述 + 全量 schema）相比：本轮 schema 裁剪再省 235 est tokens；对未开 lean 的同窗口（4960）共省 877。
- verify 断言（已固化）：`shouldLeanToolDescriptions(32000)=true / (200000)=false`；`buildProviderToolDeclarations([exec, edit_file], 32000)` 属性数 2/4，200k 为 7/5；`compactToolSchema` 对 read_file 原样返回。
- 质量门：`npm run check` PASS（static 7.3s 热缓存）。`npm run verify` 在本 checkout 仍被并发会话的 `build --clean` 打断（`dist/context/tokens.js` 缺失 → smoke 0.3s 就失败）；
  隔离副本 `/tmp/moss-b76-check` 复跑：build PASS、smoke PASS、examples PASS、`tiny-window-surface` PASS（本轮改动无回归）。

**B75 证据（2026-11-05，已实跑：stub 首请求注入延迟 + 换长 prompt，各 1 次真实 headless run，读 `--json`）**：

```
stub 延迟 0ms   ：first_token_ms 140，prompt_ready_ms 7
stub 延迟 400ms ：first_token_ms 599（+459），prompt_ready_ms 8（+1）   ← 延迟被判给 provider
prompt 加长     ：first_token_ms 118，prompt_ready_ms 15（8→15）        ← 长输入抬高本地组装
```

- 结论：`prompt_ready_ms` 只随本地组装变化，provider 停顿全部落进 `first_token_ms`；两个数相加就是这轮的到首字墙钟时间。
- 契约变化（加性，semver minor）：`--json` result 增加 `prompt_ready_ms`；`run_metrics` 增加 `promptReadyMs` / `firstTokenProviderMs`；`cache_metrics` 事件透传两个可选字段。
- 质量门：`npm run check` PASS（static 26.3s）。`npm run verify` 在本 checkout 被**并发会话**打断（对方在反复 `build --clean`，`dist/` 被清空后 `slash-dispatch`/`help-surface` 报 `ERR_MODULE_NOT_FOUND`）；
  隔离副本 `/tmp/moss-b75-check`（rsync 本树 + symlink node_modules）复跑：`tiny-window-surface` PASS、其余 stage 全 PASS，唯一 FAIL 是 `help-surface`——原因是并发会话新增的 `plugins` 命令还没进 help 表（`--help --all (en/zh) does not mention command "plugins"`），与本轮改动无关。
- 未固化断言的原因：`--json` 时序需要 stub 延迟，加进 verify 会引入长驻 HTTP stub；后续如需回归保护，可在 `smoke` 后加一个 30 行 stub（成本约 1s）。

**B74 证据（2026-11-05，已实跑：真实 `moss doctor` × 3 种窗口；verify 断言已固化）**：

```
窗口 4096：ok  context profile: small window: 5 core tools, local (deterministic) compaction,
           tool results capped at 341 tokens. Raise agent.contextTokens (or use a model with a bigger
           window) to get the full tool surface.
窗口 8192 / 32000：无该行（8192 的有效预算 6144 > 6000，工具面本身就是标准面）
```

- 顺带修正 B70 的表述：运行期 `ToolContext.contextWindowTokens` 传的是**有效预算**（4096→3414），
  所以实际工具结果上限是 `floor(3414*0.1)=341`，不是 `floor(4096*0.1)=409`；probe 两个数都断言（409 为裸窗口、341 为运行期）。
- 固化为 verify 断言：`tiny-window-surface` 额外跑 2 次真实 `dist/cli.js doctor`（4096 必须有该行且含 `tool results capped at 341 tokens`、32000 必须没有），
  探针独立耗时 5.2s（含 3 次 boot + 2 次 doctor）。
- 质量门：`npm run check` 绿（static 6.2s 热缓存）；`npm run verify` **PASS 46.2s**（static 9.8s，宿主机负载回落后回到预算内）。
- 下一轮候选：小窗口首字延迟（H6 三段口径）；verify stage 进程冷启动摊薄；TUI 探测落地后的补提示。

**B73 证据（2026-11-05，已实跑：请求 schema 字段 + 真文件工具链 write→read→edit + 落盘校验；32k 控制组）**：

```
4096 窗口首请求：
  改造前：est 1890、tools_chars 2711（exec schema 1044 chars / edit_file 1087）
  改造后：est 1655（−235）、tools_chars 1772；wire schema 属性
    exec: command, timeout_ms（240 chars）
    edit_file: path, old_string, new_string, replace_all（361 chars）
    list_directory: path, depth（91 chars）；read_file/write_file 不变
  与 B66 起点 2902 相比：首请求 −1247 est tokens（占 3414 预算 37%）
行为验证（同一 stub 脚本化 3 次真实文件工具调用）：
  req1 write_file → 工具结果 "Successfully wrote 11 chars to probe.txt"
  req2 read_file  → "1  hello world"
  req3 edit_file  → "Edited probe.txt (replaced 1 occurrence)"
  运行结束后工作区 probe.txt 内容 = "hello moss"（真实落盘）；4 个请求 est 1655/1739/1800/1908 全部接受，exit 0
32000 控制组：15 工具、exec 仍 7 个属性、edit_file 仍 5 个属性、est 4318 —— 与改造前一致
verify 断言（已固化）：裁剪后属性列表精确匹配、required 只留 command、exec+edit_file 合计至少省 1000 chars（实测 1386）、未列入白名单的工具 schema 原样返回
```

- 质量门：`npm run check` 绿（static 52.3s）；`npm run verify` PASS 54.7s（static 18.0s，回到 60s 预算内）。
- 说明：微型档不再声明后台运行与批量编辑，这是刻意的能力收窄（B71 guidance 要求一次一步）；工具实现仍接受这些参数，宿主与普通窗口不受影响。

**B72 证据（2026-11-05，已实跑：stub 抓真实请求的 tools 字段 + 首请求 est + 工具链；32k 控制组）**：

```
4096 窗口首请求：
  改造前：est 2099、tools_chars 3546、描述 exec 348 / edit_file 278 / read_file 238 / list_directory 163 / write_file 141 chars
  改造后：est 1890（−209）、tools_chars 2711、描述 exec 70 / edit_file 97 / read_file 109 / list_directory 25 / write_file 49（合计 350 chars）
  与 B66 起点的 2902 相比：−1012 est tokens（约窗口的 25%）
4096 工具链 N=12：13 请求 0 拒绝，est 尾部 2415/2336/2396/2455（B71 时为 2843~2962），exit 0
32000 控制组：est 4318、15 工具、lean 描述原样（exec 348 chars）、0 拒绝 —— 与改造前一致
verify 断言（已固化）：5 个名字都有微型档描述、每条 ≤130 chars、合计 <500（实测 350）；非小窗口工具（create_subagent）返回自身描述
```

- 过程教训（值得留档）：第一次只覆盖了 `tool.description`，实测请求 `tools_chars` 与 est **完全没变**——因为 wire 在 ≤64k 窗口用 `metadata.leanDescription`。
  这说明「改完必须抓真实请求字段」而不是看本地代码路径。
- 剩余最大块：工具 schema 本体（exec 1044 / edit_file 1087 chars，合计仍占 tools_chars 大半），下一轮候选。
- 质量门：`npm run check` 绿（static 29.5s）；`npm run verify` PASS 1m35.6s（static 47.1s；本轮宿主 load 再次抬升，前一轮同树为 54.0s/12.6s）。

**B71 证据（2026-11-05，已实跑：stub 首轮起连续 N 次 exec 工具调用，N=0/4/12/20；32k 控制组）**：

```
4096 窗口，工具链：
  改造前：req1 est 2770 → req5 est 3419+682=4101 被拒 → run exit 6「stuck at: exec echo step-5」（第 5 次工具调用就死）
  改造后：req1 est 2099（系统提示 3159 chars，含 "## Small-context mode"；tools_chars 3546）
          N=4 → 5 请求 0 拒绝；N=12 → 13 请求 0 拒绝（est 2902/2961/2962 有界）；
          N=20 → 21 请求 0 拒绝（est 尾部 2969/2962/2830，滑窗生效后不再单调增长），全部 exit 0
32000 窗口控制组：req1 est 4318、4 次工具链 est 4318→4639、0 拒绝、exit 0 —— 与改造前一致（未启用紧凑提示/滑窗）
verify 断言（已固化）：compactGuidance 提示含 "## Small-context mode"、不含 "## Tool Result Handling"、
  比默认提示少 >2000 chars（实测 3174 chars）
```

- 关键判断：小窗口下**摘要比截断更贵**（B66 的确定性摘要最小 ~600 tokens，而 4k 窗口留给对话的只有 ~1000），所以 follow-up 轮走滑窗 prune、不生成新摘要；只有普通用户轮才允许省略+摘要。
- 质量门：`npm run check` 绿（static 17.4s）；`npm run verify` **PASS 54.0s**（static 12.6s，B68 缓存后首次回到 60s 预算内）。
- 下一轮候选：小窗口工具 schema 瘦身（5 个工具 3546 chars ≈ 890 tokens，占 3414 预算的 26%）；TUI 探测落地后的降级补提示；verify stage 冷启动摊薄。

**B70 证据（2026-11-05，已实跑：stub 让首轮 exec 产出 6000 字符，前后 A/B；32k 控制组逐字段不变）**：

```
4096 窗口，首轮 exec 输出 6000 字符：
  改造前：req1 est 2770+682 接受 → req2 est 3471+682=4153 拒绝 → req3 est 4946+682 拒绝（连拒 2 次，恢复后 exit 0）
  改造后：req1 est 2770+682 接受 → req2 est 3353+682=4035 接受，工具结果 1734 字符（含 "…tokens truncated" 提示），exit 0、零拒绝
32000 窗口控制组：工具结果 6002 字符（未截断，仍是工具自带预算）、req2 est 5882+8000 接受、tools 15、exit 0 —— 与改造前一致
verify 断言（已固化）：tinyWindowToolResultTokens(4096)=409、(8000)/(32000)=undefined；
  truncateToolOutput('exec', 6000 chars, {contextWindowTokens:4096}) < 2200 且含截断提示；32000 时原样返回 6000 字符
```

- 设计说明：份额取窗口 10%（4096→409 tokens ≈ 1600 字符，约 40 行代码），下限 192 tokens；只有窗口 ≤6000 才启用，默认档零变化。
  `wouldTruncateToolOutput`（工具自己判断"是否会被省略"的探测）仍按工具预算，微型档下二者可能不一致——工具说"未截断"时引擎仍会截断并附提示，行为安全。
- 质量门：`npm run check` 绿（static 27.5s）；`npm run verify` PASS（1m3.6s，static 19.8s in pool；仍偶发 over-budget 警告，宿主 load 25+）。
- 下一轮候选：verify 阶段进程冷启动摊薄（B68 已把 static 从 3m16.7s 降到 ~20s，剩余 ~45s 主要是 35+ 次 stage node 冷启动）。

**B69 证据（2026-11-05，已实跑：真实 CLI 启动 stderr ×3 窗口 + zh + 强制关；verify 断言已固化）**：

```
同一个 stub 配置（网关声明 context_length、超窗即 400）跑 `moss -p hi`：
  窗口 4096：stderr 出现
    [moss] This model's context window is small (4k tokens): only the 5 core tools are offered,
    compaction uses a local summary, and each reply is capped at 682 tokens. Configure a bigger window
    with agent.contextTokens (or use a model with one) for the full tool set.
  窗口 8192 / 32000：只有既有的 "Interaction mode" 行，无微型档提示
  MOSS_LANG=zh（4096）：
    [moss] 这个模型的上下文窗口较小（4k tokens）：只提供 5 个核心工具，压缩使用本地摘要，单次回复上限 682 tokens。
    需要完整工具面请用 agent.contextTokens 配置更大的窗口（或换更大窗口的模型）。
  MOSS_TINY_WINDOW_TOOLS=0（4096）：无提示（工具面也确实是标准面，二者一致）
```

- 固化为 verify 断言（`tiny-window-surface`，3 次真实 `dist/cli.js -p hi` 启动，共 1.8s 独立跑、6.5s 加进 verify 并发池）：
  4096 必须含 `context window is small (4k tokens)` 且含 `5 core tools`；32k 与 `MOSS_TINY_WINDOW_TOOLS=0` 必须不含。
- 已知边界（诚实记录）：TUI 路径在探测（异步 `probeContextWindow`）落地前就发提示，因此「未配置且靠探测才发现是 4k」的 TUI 用户暂不会看到该行；
  已配置 `agent.contextTokens` 的用户（本地模型主要场景）两条路径都能看到。
- 质量门：`npm run check` 绿（static 15.2s 热缓存）；`npm run verify` PASS（1m6.0s，仍偶发 over-budget 警告——宿主 load 25+，静态已从 3m16s 降到 21.8s）。

**B68 证据（2026-11-05，已实跑：冷/热缓存 A/B + 三个负向控制 + 全量 verify 计时）**：

```
== static stage（同一棵树、同一台 load≈27 的机器）==
冷缓存：format/lint/types 并行 → static ok 2m 0.3s（lint 单项 2m 0.2s）
热缓存：static ok 5.1s（format 4.5s / lint 4.5s / types 4.7s，并行）
单工具实测：eslint 冷 56.7s → 热 1.4s；prettier 冷 21.7s → 热 1.4s；tsc 冷 8.3s → 热 3.3s
== 负向控制（缓存不得掩盖新错误；连续两次热缓存跑都 FAIL，证明按文件失效而非整体跳过）==
写入 src/tmp-cache-probe-types.ts（类型错误）/ src/tmp-cache-probe-lint.ts（unused var）/ scripts/tmp-cache-probe-format.mjs（格式错误）：
  第一次热跑：format FAILED / lint FAILED / types FAILED（错误文本逐条命中）
  第二次热跑：仍然全部 FAILED（缓存命中其它文件、新文件重新检查）
删除探针文件后：static ok 8.2s（PASS）
== 全量 verify ==
改造前（本轮早些时候，同机）：PASS 3m42.6s（static 单项 3m16.7s，超预算警告）
改造后：PASS 1m2.2s / 1m4.8s（static 单项 16.0s / 15.5s——全量 verify 里 static 与 build/smoke 并发抢 CPU）
```

- `npm run check`（= static stage）从 2m+ 降到 5s 级，日常改完一轮的反馈闭环显著变快。
- 缓存位置 `node_modules/.cache/verify/{prettier.cache,eslint.cache,tsc.tsbuildinfo}`，不新增仓库文件；CI 冷启动行为不变（只是首次会写缓存）。
- 质量门：`npm run check` 绿；`npm run verify` PASS（1m2.2s / 1m4.8s，仍偶发 over-budget 警告：剩下的 ~45s 是 35+ 个 stage 各自 `node` 冷启动在 load≈27 下的成本，列为下一轮候选）。
- 下一轮候选（B69）：stage 进程冷启动摊薄——把单进程零依赖的小探针合并进同一个 node 进程跑，或给 verify 增加「按 CPU 负载调整 VERIFY_CONCURRENCY」；预期能把 60s 预算真正打回绿。

**B67 证据（2026-11-05，已实跑：同 stub 的窗口 A/B + SDK 级提示断言）**：

```
4096 窗口（stub 声明 context_length、超窗即 400）：
  改造前：system 6585 chars（含 "## Available sub-agent experts"）、est 2902 + 682、tools 5 → 接受
  改造后：system 5830 chars（无该段）、est 2770 + 682、tools 5 → 接受（首请求再省 132 est tokens / 755 chars）
  脚本化工具调用后第二轮：est 3185 + 682 = 3867 ≤ 4096 → 接受，exit 0
32000 窗口（控制组）：system 6341 chars、catalog 仍在（1 处）、est 4318 / max_tokens 8000 / tools 15 → 与改造前逐字段相同
SDK 断言（已固化进 verify stage tiny-window-surface）：buildSystemPrompt({}) 含 catalog，
  buildSystemPrompt({ omitSubagentExperts: true }) 不含，释放 503 chars
```

- 质量门：`npm run check` 绿；`npm run verify` PASS（本次 2m51.1s，`static` 单项 2m26.3s——宿主机 load 25+，同树常态 static 22.8s；扩展后的 `tiny-window-surface` 1.2s）。
- 设计说明：`omitSubagentExperts` 只由「本轮是否会真的给 sub-agent 工具」决定（当前唯一来源是微型工具面判定）；
  常规窗口/显式 MOSS_TINY_WINDOW_TOOLS=0 时行为不变。plan 模式等其它工具面收窄路径暂未接入（同一机制可复用，列入下一轮候选）。

**B66 证据（2026-11-05，已实跑：4096 窗口 E2E 前后 A/B，含工具调用；标准窗口逐字段不变；verify 负向控制）**：
探针 = 本地 OpenAI 兼容 stub，`/v1/models` 声明 `context_length`，请求 `est_prompt_tokens + max_tokens > window` 时返回真实 OpenAI 风格 400；
配置 `agent.contextTokens` 固定窗口，模型名 `m`（未知模型）。

```
== 改造前（b9f37000，窗口 4096）==
  首请求 est 4318 + max_tokens 2048，tools 15 → 被拒（gateway: 4096 窗口，请求 6608 tokens）
  整轮 exit 6（模型无法开始工作）
== 改造后（B66，窗口 4096）==
  首请求 est 2902 + max_tokens 682，tools 5（exec/read_file/write_file/edit_file/list_directory）→ 接受
  脚本化工具调用后第二轮 est 3318 + 682 = 4000 ≤ 4096 → 接受；整轮 exit 0，无一次被拒
== 控制组（同一 stub，改造前后逐字段相同）==
  窗口 32000：est 4318 / max_tokens 8000 / tools 15 / exit 0
  窗口 8192： est 4318 / max_tokens 2048 / tools 15 / exit 0（8192 仍在阈值上方，走标准面）
```

- 数值探针：输出预算 `2048→341 / 4096→682 / 6000→1000 / 8192→2048 / 32000→8000`；微型面在 effective ≤6000 时开、
  6144（8k 窗口）时关；确定性摘要上限 2443/2456 chars。
- `verify` 负向控制：把 `dist/core/loop/output-limit.js` 换回 B65 版本 → `tiny-window-surface` FAIL
  （`4096 window prompt budget 2048 must leave room for tools`）；换回修复版 → ok。
- **B62 探针的语义更新（有意为之）**：`compactHistoryIfNeeded` 在 ≤6k 窗口不再调用模型摘要器，
  所以 `compaction-window-clamp` 里「5k 窗口问 1250 tokens 摘要」改为「5k 窗口不得调用模型摘要器，
  且本地摘要 ≤ 3000 chars」；32k 仍是 4096 tokens 的模型摘要上限（断言未变）。
- 质量门：`npm run check` 绿；`npm run verify` PASS（本次 **3m42.6s**，`static` 单项 3m16.7s——宿主机 load ≈27，
  同树常态 static 22.8s；新 stage `tiny-window-surface` 1.5s）。
- 余量（下一轮候选）：微型窗口上确定性摘要仍会触发一次「missing required sections; retrying once」校验重试（噪音 + 双份工作）；
  系统提示 6.3k chars 里仍有 480 chars 的子代理专家段、CodeGraph 段与微型面无关，可在微型档位裁掉，再多留 ~200 tokens。

**B65 证据（2026-11-05，已实跑：纯算术探针前后 A/B + 32k 窗口请求不变 + verify 负向控制）**：

```
== 改造前（HEAD 构建）==
4096 窗口 / 1024 输出：effective 4000（真实预算 3072）、threshold 4000（= 预算本身，永不触发）
1024 窗口任意输出：effective 4000 > 窗口 1024（10 组越界）
== 改造后 ==
4096 / 1024：effective 3072、threshold 2304
8192 / 2048：effective 6144（与改造前一致）
32000 / 4096：effective 27904、threshold 14904（与改造前一致）
不变量 sweep（512–200k 窗口 × 256–16k 输出，55 组）：越界 0、阈值越界 0、阈值 ≤0 0
```

- 探针：`node /tmp/b65_probe.mjs <dist>`（打表 + 不变量），已固化为 `scripts/verify/window-economics.mjs` + stage（2.2s，进 FAST_GATE）。
- **32k 窗口真实请求不变**：同一 stub（`context_length` 由网关声明 + 超窗即 400）下，`-p "<小提示>"` 在改造前后的构建上发出的请求完全一致：
  `est_prompt_tokens 4318 / max_tokens 8000 / tools 15 / rejected false / exit 0`（两构建逐字段相同）。
- **verify 负向控制**：把 `dist/context/window-economics.js` 换回 HEAD 版本 → stage FAIL 并打印
  `window 512 / maxOut 256: effective 4000 exceeds the window 512`；换回修复版 → `ok: 55 window/output pairs in range`。
- 质量门：`npm run check` 绿；`npm run verify` PASS（本次 **3m7.8s**，`static` 单项 3m7.8s——机器 load 平均 ≈27，同树常态 22.8s；窗口/输出探针本身 2.0s）。预算超限是宿主机负载，不是本改动（B65 只动 context/window-economics 与 verify 注册）。

**B66 候选（本轮顺带测出的真实发现）：4k–8k 窗口真正卡住的不是算术，是工具面本身。** 同一 stub 在 `WINDOW=4096` 下，
改造前后的构建都**整轮失败**（exit 6，网关回 `maximum context length is 4096 tokens ... resulted in 7999 tokens`）：
即使用 lean 描述（`LEAN_TOOL_AUTO_CONTEXT_TOKENS = 64_000` 已自动开），15 个工具声明的 baseline 仍然 ≈4.3k est tokens
（32k 窗口那次实测 `est_prompt_tokens 4318` 且不含用户长文），4096 窗口连 baseline 都放不下；
overflow 恢复把工具面降成 0 后仍有 3.9–5.4k，全部被拒。修法不是继续调窗口算术，而是**微型窗口档**：
窗口 ≤8k 时只声明核心工具子集（exec/read/write/edit/list/search + todo），其余走 `load_tools`/延迟揭示，
并把系统提示压到最短；验收口径 = 4096 窗口下 `-p` 首次请求 `est_prompt_tokens + max_tokens ≤ 4096` 且真实跑完一轮。

**B64 证据（2026-11-05，已实跑：临时分段时间戳 A/B；探针代码未提交）**：`-p "hi"` 对本地 SSE stub 抓时间点时发现，
`runAgentLoop` 进入后到 `prepareTurnContext` 之间有 **87ms** 空档，且首个进度条/POST 比预期晚：

```
改造前（临时 MOSS_DEBUG_TIMING 打点，未提交）：
  H-loop-start 427.6ms → ctx-prep-start 514.7ms（87.1ms 空档）→ stream-call 516.9ms
改造后（同一 stub、同一构建方式）：
  H-loop-start 401.8ms → ctx-prep-start 408.3ms（6.5ms）→ stream-call 411.4ms
  H-loop-start 398.4ms → ctx-prep-start 403.8ms（5.4ms）→ stream-call 407.0ms
```

空档来源就是 `runAgentLoop` 顶部的 `await ensureKeepAliveDispatcherInstalled()`——无代理时它仍要 `import('undici')`
（110 个模块）；`fetchWithConnectionContext` 里也有同样的无条件 `await`。

- 改法：`keep-alive-dispatcher` 新增 `scheduleKeepAliveDispatcherInstalled()`（后台安装 + in-flight promise 去重）；
  `agent-loop.ts` 与 `fetchWithConnectionContext` 都改成「有代理 `await`、无代理后台装」。代理语义不变：
  verify 既有的 `a configured proxy still installs the dispatcher during boot` 仍 PASS，带 `HTTPS_PROXY` 的启动图仍是
  `total 504 / undici 110`（B63 证据里的同一组测量）。
- 效果：首个请求的发出点从 **~517ms uptime 提前到 ~407–411ms**（同一探针、同一机器），stub 侧 `arrival_ms`
  从 557–586ms 降到 495–557ms；墙钟同批 615–713ms → 565–607ms（本机当时有负载，另有一次 5.7s 离群值，只作为方向性参考，
  可复现口径是上面的内部分段）。
- 回归保护：B63 的 `boot without a proxy does not load undici` 与 `a configured provider does not load undici` 覆盖启动图；
  首轮「不被安装阻住」目前靠代码注释承诺，未加 verify stage（stub 服务器 + 首请求时序断言留作后续）。
- 质量门：`npm run check` 绿；`npm run verify` PASS，但本次 72.2s 触发 over-budget 警告（同一棵树此前 41–59s；
  本次 `static` 单项 52.8s，机器当时被其他会话占满，非本次改动引入——B64 只改首轮路径，不影响 static）。

**B63 证据（2026-11-05，已实跑：启动模块图 A/B + 启动耗时 A/B + 新回归检查的负向控制）**：
B60 之后 `npm run verify` 的 no-proxy 检查只用一个空 HOME（无 provider 配置）启动，所以没覆盖最常见形态——
配置了 provider 的用户启动仍会加载 undici。定位：`src/cli/model-catalog.ts` 的 `resolveModelContextWindowFromApi()`
里有一行 `if (!params.fetchImpl) await ensureKeepAliveDispatcherInstalled(); // O83`，它被启动期 context-window
探测直接调用，于是 undici 111 个模块（resolve hook 计数 110 个 file:// 模块）又回到启动图。

- 启动模块图 A/B（同一临时 HOME + `config.json` 配 `openai-compatible`、`baseUrl=http://127.0.0.1:9/v1`，无代理环境，
  各跑 3 次）：改造前 `total 504 / dist 368 / node_modules 135 / undici 110`（三次一致）；
  改造后 `total 394 / dist 368 / node_modules 25 / undici 0`（三次一致）。即 **110 个 undici 模块离线**，
  dist 自身 368 不变（不是靠少加载业务代码凑数）。
- 代理语义未被破坏：同配置加 `HTTPS_PROXY/HTTP_PROXY=http://127.0.0.1:9`、`no_proxy=''` 启动，仍是
  `total 504 / undici 110` —— 配了代理就照旧提前装 dispatcher（O83 的「代理流量绝不走默认路径」保持）。
- 启动耗时 A/B（`MOSS_STARTUP_TIMING=1`，REPL 启动到 EOF，各 7 次，机器有负载）：
  改造前 `total` 中位 **309ms**（287–471），墙钟中位 **645.8ms**（577–782）；
  改造后 `total` 中位 **240 / 250ms**（两批），墙钟中位 **536 / 572ms**。即启动阶段约 **−60~75ms（≈20%）**；
  诚实说明：墙钟受机器负载影响较大，模块数（−110）才是可复现的口径。
- 回归检查：`startup-timing` probe 新增 `a configured provider does not load undici for the startup probe`
  ——用带 provider 配置的临时 HOME 启动，断言 `MOSS_STARTUP_TIMING` 的 `probe=` 出现在 stderr（证明探测确实跑了）、
  且图里 0 个 `/node_modules/undici/`；负向控制（把那一行改回无条件安装）→ 该检查 FAIL 并打印
  `the provider probe loaded undici without a proxy (110 modules): …/undici/index.js, …`；恢复后 6 checks passed。
- 质量门：`npm run check` 绿；`npm run verify` PASS **41.3s**（startup-timing 3.6s，比之前 +0.9s，预算内）。

**B62 证据（2026-11-05，已实跑：模块级对照 + 真 CLI 请求预算 A/B + 负向控制）**：B13 记录的真实现象是
「窗口设 5000/6000 时每次压缩准备都 30s 超时」。根因不在汇总器本身，而在窗口小于默认保留额度时的预算失真：
`shouldTriggerCompaction` 的阈值是 `contextWindowTokens - reserveTokens`，默认 reserve=20000，
窗口 5000 → 阈值 −15000，**任何对话都算超预算**；同时 `maxTokens = min(4096, 0.8×reserve)` 在 5k 窗口上
仍然要 4096 个输出 token（窗口的 82%），小模型只能拖到超时。

- 模块级对照（`scripts/verify/compaction-window-clamp.mjs`）：窗口 5000 + 默认设置，
  改造前 `shouldTriggerCompaction(tiny) = true`、汇总 `maxTokens = 4096`；改造后
  `shouldTriggerCompaction(tiny) = false`、`maxTokens = 1000`（=0.8×reserve，reserve 由 20000 收敛到 1250）；
  keepRecent 由 20000 收敛到 2500；`reserveTokens < 窗口` 时完全不干预（`clamp(DEFAULT, 32k) === DEFAULT`，
  显式 `reserveTokens=4000/keepRecent=6000` 也原样保留）——标准 32k 窗口行为零变化。
- 真 CLI A/B（同一个脚本化 stub，`agent.contextTokens=5000`，记录每次 POST 的 `max_tokens`）：
  改造前汇总请求 `max_tokens: 4096`（连发两次：验证失败重试），改造后 `max_tokens: 800`；
  两次运行都正常完成压缩（`tokens_before 5026 → tokens_after 928`），说明收紧预算没有把压缩弄坏。
  注：这条 E2E 的触发来自 prompt-prune 路径（`tokens_before 2440` 也发生压缩，改造前后一致），
  阈值从「恒真」到「真超预算才触发」是由上面的模块级对照证明的。
- 负向控制：把 clamp 临时改成直接返回原设置（等价修复前）→ 探针失败 `expected 1250, got 20000`；
  恢复后 5 checks passed。回归门 `compaction-window-clamp`（0.2s）与 `compaction-timeout-fallback`（0.4s）都在 FAST_GATE。
- 质量门：`npm run check` 绿；`npm run verify` PASS 58.8s（static 36.9s，两个新 stage 合计 0.6s）。

**B61 证据（2026-11-05，已实跑：模块级探针 + 真 CLI E2E + 三种渲染面）**：B13 的真实现象是压缩准备 30s 超时后
只留一行 log、上下文原样继续；小窗口模型下一轮就撞上限，而用户不知道该做什么。

- 模块级探针（`scripts/verify/compaction-timeout-fallback.mjs`，`MOSS_COMPACTION_PREPARE_TIMEOUT_MS=120`）：
  prepare 第一次调用挂起 → 输出 `prepare calls (skipLlmCompaction): [false, true]`；warn 为
  `proactive compaction prepare timed out; using the deterministic summary` +
  `{phase: proactive, timeoutMs: 120, elapsedMs: 127, messages: 2}`；`compaction` 事件 `degraded: true`；
  outcome `succeeded: true, degraded: true`，总耗时 131ms（降级路径不花模型时间）。
- 真 CLI E2E（脚本化 provider 每次响应延迟 400ms、`agent.contextTokens=1200`、
  `MOSS_COMPACTION_PREPARE_TIMEOUT_MS=100`）：3 次 POST = 主请求 / 汇总请求（`tools: 0`，被超时中止）/ 压缩后的主请求；
  `--output-format stream-json` 里 `{"type":"compaction", "summary_chars":1262, "dropped_messages":1,
"tokens_before":434, "tokens_after":375, "degraded":true}` —— 降级摘要**确实缩小**了上下文；
  文本模式的用户可见横幅为
  `· context compacted 1 messages into 1262 chars · deterministic summary (the model summary timed out)`，
  同一 run 的 stderr 有结构化 warn（阶段/超时/耗时/消息数/runId/sessionKey）。
- 写第一版时 E2E 暴露出一个真问题：确定性摘要模板本身约 1.4k 字符，小窗口下会让「压缩」把
  tokens 从 434 涨到 863（`tokens_after > tokens_before`）。于是把 `deterministic-summary` 的预算改成
  `min(12k, max(400, 丢弃字符数 × 50%))`，超预算时退化为「历史脉络 + 主要目标 + 第 9 节摘录」的紧凑模板并截断；
  改后同场景 434 → 375。探针另断言：1 条短消息的窗口摘要 ≤400 字符、40 条大窗口摘要 ≤50% 且 ≤12k。
- 三条渲染面都实跑过：TUI 行（`compacted N earlier messages · now ~X tokens · deterministic summary (the model
summary timed out)`，中文本地化同键）、REPL/oneshot 横幅（文本模式 E2E 实际打印，见上）、headless JSON（`degraded: true`）。
- 回归门：新 verify stage `compaction-timeout-fallback`（0.3s，放进 FAST_GATE）。负向控制：把
  `isCompactionPrepareTimeout()` 改成恒 false（超时不被识别）→ 探针失败 `no compaction event was pushed`；
  恢复后 3 checks passed。
- 质量门：`npm run check` 绿；`npm run verify` PASS 60.9s（本机本次 `static` 38.9s + `skill-fork` 19.1s 的并行波动，
  新增 stage 仅 0.3s；前一轮同门 52.6s 可对照）。

**B60 证据（2026-11-05，已实跑，模块图 + A/B 墙钟 + 代理语义）**：`cli/runtime.ts` 的 `runCli()` 开头无条件
`await ensureKeepAliveDispatcherInstalled()`，而该函数 `import('undici')` 会拉起整包 110 个模块（本机单进程冷 import
**128ms**）。交互式启动（REPL/TUI 到 composer）与 `--help` 都在它后面，属于 B18 说的「发布形态无法按需」。

- 改动：`provider/keep-alive-dispatcher.ts` 导出 `hasProxyConfigured()`（HTTP_PROXY/HTTPS_PROXY 大小写都算）；
  `cli/runtime.ts` 改成**只在配了代理时**才在启动期安装（O83 的「配了代理就必须在任何请求之前生效」语义不变），
  无代理时由已有的 `fetchWithConnectionContext` 在首个真实请求前懒装（O83 当时就是给 SDK/embedder 路径加的那处）。
- 启动图（`module.registerHooks` 逐模块计数，REPL 启动 + EOF 退出）：**总 504 → 394 模块**（dist 368 不变，
  `node_modules` **135 → 25**，undici 的 110 个模块不再出现）。
- A/B 墙钟（同一构建，9 轮交错、已预热；无代理=懒装 vs 设 `HTTPS_PROXY`=走原 eager 路径）：
  懒装中位 **0.32s**（0.29–0.36，另有一次 3.09s 离群）vs eager 中位 **0.37–0.39s**（0.36–0.66）；
  eager 还额外构造 `EnvHttpProxyAgent`，所以真实节省是 ≤50–70ms，以模块计数为准。
- 代理语义真实验证：设死代理 `HTTPS_PROXY=HTTP_PROXY=http://127.0.0.1:9` 跑 REPL，启动图仍是 504 模块
  （undici 已 eager 装好）；同一死代理下用脚本化 provider 跑 `-p`，loopback stub 仍收到请求并 `exit 0`
  （LOOPBACK no_proxy 绕过生效）；无代理跑 `-p` 同样 `exit 0`（懒装发生在 fetch 之前）。
- 回归门：`scripts/verify/startup-timing.mjs` 新增两条 resolve-hook 模块图检查——
  「无代理启动不得加载 undici（且必须真的走 `cli/runtime.js`）」「设 `HTTPS_PROXY` 时启动期必须装好 dispatcher」。
  负向控制：`MOSS_FORCE_EAGER_DISPATCHER=1` 强制 eager → 第一条失败并点名 undici 模块；模拟跳过代理启动安装 →
  第二条失败。为了不超预算，把原有「格式」与「单调」两条检查合并成一次 `-p --mock` 运行（省 ~1.1s），
  该 stage **9.4s → 2.8s**，`npm run verify` **PASS 52.6s**（budget 60s ok）。
- 附注：`moss --help` 的图本来就没有 undici（help 在 `runCli` 之前退出），本轮收益集中在交互式/REPL/TUI 启动与
  `-p` 之外的前置阶段；`-p` 因首个请求立即触发懒装，总时长基本不变。

**B59 证据（2026-11-05，已实跑，lean 声明面实测 + 真 CLI wire）**：B08 的 lean 档只做了 15 个工具，main-headless 的 20 个声明里
还有 10 个（`list_directory` 283、`run_tests` 256、`write_file` 246、`apply_patch` 231、`todo_write` 217、`exec_logs` 187、`move_file` 186 …）
只有长版，小窗口模型的声明面降不下来。

- 本轮补 17 个 `leanDescription`：文件/编辑族（`write_file`/`multi_edit`/`list_directory`/`move_file`/`apply_patch`）、
  `todo_write`、`run_tests`、`exec_logs`、`ask_user_question`、`exit_plan`、设备族（`device_file_read`/`device_file_list`）、
  子代理族（`create_subagent`/`fan_out_subagents`/`merge_subagent_patch`/`subagent_status`/`subagent_stop`）。
  为守住「60% 长度」预算，长版同步补了 B08 式的否定句/关键约束（如 apply_patch 的「context 行必须精确匹配」、
  todo_write 的「不是用来记验收/证据」、run_tests 的「不是用来装依赖」、merge 的「不要自己手抄改动」）。
- lean 覆盖：15 → **33/49** 工具（可见工具 42 个里 32 个有短版）。
- 同一构建内 lean 声明总量（`measure-tool-surface` 的构建器 + 逐工具对比）：main-headless 11,803→**10,834**（−969，≈−242 tokens）、
  main-tty 16,261→**14,735**（−1,526，≈−382 tokens）、main-plan 12,182→11,114、main-qa 11,803→10,834；
  子代理 scope：device-read −567、explore −567、verify −986、plan −728、read-only −120。
  代价是默认长版 +491（13,524→14,015）/ +550（19,774→20,324）——换到的是否定句与匹配规则，仍在 B05 的 24,000 预算内。
- 真 CLI wire（脚本化 provider 记录 `/chat/completions` 请求体；`MOSS_LEAN_TOOLS=1` vs 默认）：
  `write_file` 246→141、`list_directory` 283→163、`apply_patch` 399→189、`todo_write` 301→140、`run_tests` 321→188、
  `move_file` 270→155、`device_file_read` 438→228；23 个声明工具的 description 合计 10,376→**5,262**（整档 lean，≈−1,278 tokens）。
- 回归门：`measure-tool-surface --check` 新增覆盖不变式（三个主场景里「声明且描述 ≥150 字符」的工具必须有 lean 档）；
  负向控制：删掉 `write_file` 的 lean 档 → `--check` 失败并点名 `write_file has a 246-char description but no lean tier`，恢复后 PASS。
  `npm run check` 绿、`npm run verify` PASS 52.2s（`tool-surface` stage 全绿）。

**B58 证据（2026-11-05，已实跑，CLI + 会话内双端）**：配置页（`moss config show`，B56）已经能看到 images / 评审模式 / 验证门，
诊断页却看不到——而「为什么截图被拒」「为什么这轮必须评审」「为什么旧跑被完成门拦住」正是打开 `moss doctor` 的场景。

- 实现：`cli/doctor.ts` 的 `renderBehaviorDoctor()` 三行（图片输入 / 评审模式 / 验证门，各带来源；评审模式来源写
  `config or env`/`配置或环境变量`，因为配置与环境变量都能设它）；`cli/onboarding.ts` 的 `renderCliSessionDoctor`（`/doctor`）
  加同一组行，两侧文案一致。
- 真跑（temp HOME）：默认 → `images: image input allowed (default)` / `review mode: manual (default)` / `verification gate: on (default)`；
  `moss config set agent.supportsImages false` + `MOSS_REVIEW_MODE=auto` + `MOSS_VERIFICATION_GATE=0` →
  `text-only (agent.supportsImages=false) (user)` / `auto (config or env)` / `off (env)`；中文 →
  `图片输入：允许图片输入（默认）`、`评审模式：auto（配置或环境变量）`、`验证门：关闭（环境变量）`。
- `/doctor`（真 PTY，同配置）→ `images: text-only (agent.supportsImages=false, user)`、`review mode: auto (config or env)`、
  `verification gate: off (env)`；中文 `图片输入/评审模式/验证门` 同样三行。
- 回归门：verify stage `doctor-behavior`（真 `moss doctor`，1.4–1.8s，断言三行；auth fail 在临时 HOME 属预期）。
- 负向控制：删掉 CLI 里的 `renderBehaviorDoctor` 调用 → stage 失败并点名三行；恢复后通过。
- 预算：`npm run verify` 49.4s / 52.5s（三次新探针合计约 +5.6s，仍在 60s 内）。

**B57 证据（2026-11-05，已实跑，REPL/TUI 双端 + stub 工具调用）**：清单视图在 TUI 有（实时面板），REPL 完全没有入口，
`/todos` 是 Claude Code 里「长任务中途看进度」的标准动作。

- 实现：`cli/commands/registry.ts` 加 `/todos`（registry 命令 REPL/TUI 共用），`CommandContext.getTodos()` 由宿主提供实时值——
  REPL 在 `tool_start`（`todo_write`）时跟踪并随 `/clear` 清零，TUI 直接复用已有 `store.todos`；目录行加到 Inspect 段（菜单可见）。
- 端到端（真 REPL + 本地 stub 第一跳返回 `todo_write` 工具调用、第二跳返回文本）：
  `Checklist 1/3 done` + `1. ✓ audit the loader` + `2. ◐ refactor the parser (in progress)` + `3. ○ run the verifier`；
  中文同一场景 → `清单 1/3 已完成`、`（进行中）`；空清单 → `No checklist yet — one appears here after the model calls todo_write.`；
  TUI（真 PTY）输 `/todos` → `⏺ Todos` 块同四行。
- 回归门：verify stage `todos-view`（1.7s，pty REPL + stub 工具调用，断言四行；Windows/无 python3 跳过）。
- 负向控制：把宿主 `getTodos` 改成返回空表（等价于「没接线」）→ stage 失败并点名 header/completed/in_progress/pending，恢复后 1.7s 通过。
- 预算提示：B55 的 `slash-dispatch`（2.1s）与本 stage（1.7s）让 `npm run verify` 从 ~46s 升到 50.8–54.8s（三次实测 60.4/54.8/50.8），
  仍在 60s 内但余量变小；下一轮若要再加 PTY 探针，应先合并这两个探针的 REPL 启动开销。
  `npm run check` 绿。

**B56 证据（2026-11-05，已实跑，`moss config show` 真跑）**：`moss config show --json` 早就输出 `supportsImages`/`reviewMode`/`verificationGate`，
但给人看的文本摘要（`renderAuthStatus` 的字段列表）里没有——三个开关都会改变行为（图片能不能进上下文、评审是否自动跑、完成门是否拦截），
用户设完之后没有任何地方能确认它生效了，只能去翻 JSON。

- 改前（设 `agent.supportsImages false` 后）：`moss config show` 全文没有 images / review / verification 任何一行；
- 改后默认：`images: image input allowed (default)`、`review mode: manual (default)`、`verification gate: on (default)`；
  显式关闭 → `images: text-only (agent.supportsImages=false) (user)`；
  env 覆盖 → `verification gate: off (env)`、`review mode: auto (configured)`（来源列跟着变）；
- 中文标签同时补齐（`ZH_FIELD`）：`图片输入：仅文本（agent.supportsImages=false）（用户配置）`、`评审模式：manual（默认）`、`验证门：开启（默认）`，
  不出现中文行里夹英文标签的半本地化；
- 裸 `moss auth`（B53 让它打印状态）走同一个 `renderAuthStatus`，因此一并获得三行；`--json` 未改动（本来就有）。
  `npm run check` 绿、`npm run verify` PASS 46.5s。

**B55 证据（2026-11-05，已实跑，PTY REPL 真敲 + 双负向控制）**：斜杠命令目录（`interactive-commands.ts`）与 REPL 分派链（`repl.ts`）之间
从来没有契约，B39/B40/B43 三次都是靠人工探测才发现「目录里有、REPL 里没实现」。这次把这条缝补上，并修掉当前的两处漂移：

- `/queue`、`/steer` 是 TUI 的「运行中输入」控制（`tui/app.ts` 实现），却缺少 `surfaces: ['tui']`，于是被算进 REPL 行与 did-you-mean 池：
  改前 `closestSlashCommands('/queu')` → `/queue /quit /new`、`closestSlashCommands('/stee')` → 含 `/steer`；
  改后 `/queu` → `/quit /new /rules`、`/stee` → `/stop /mode /new`（不再推荐 REPL 跑不了的命令）；TUI 目录照旧含二者。
- 目录里有一对重复行：隐藏的 `/skills`（"list discovered skills…"）和同段可见的 `/skills`（"list skills: scope, real usage…"），隐藏行永远不会被渲染；
  一并删除，并删掉 `RETIRED_SLASH` 里 `/steer`、`/queue` 两条指向自身、只会让 REPL 打印迁移提示却仍不认识的条目。
- 新回归门 `slash-dispatch`（2.1s，build 之后）：① 静态断言「目录无重复命令」「`surfaces: ['tui']` 的行不得出现在 REPL 目录、`DISPATCHABLE_SLASH_COMMANDS`、菜单里」；
  ② 动态探针：pty 起一个真 REPL（本地 OpenAI 兼容 stub 供 `/doctor` 探测），把目录里 29 个可脚本化命令逐条敲进去，
  任何一条回 `unknown command` / `did you mean` 即失败；Windows 或无 python3 时跳过（与 smoke 同策略）。
- 负向控制①：临时插入一条隐藏目录行 `/nope`（REPL 没有实现）→ stage 失败并点名 `"/nope"`；
  负向控制②：去掉 `/queue` 上的 `surfaces: ['tui']`（等价于 B55 之前的状态）→ stage 失败并点名 `"/queue"`。
- 探针本身的坑也记一笔：readline 提示符后面跟着 `ESC[3G`，早先按字节 `endswith('›')` 判断永远不命中，靠静默窗口兜底导致耗时抖动
  （2s～43s）；改成「去 ANSI 取最后一行是否以 `›` 结尾」后稳定 2～3.5s，退出阶段 `/quit` 卡住也只等 1s 再 kill。
  `npm run check` 绿、`npm run verify` PASS 47.2s（60s 预算内）。

**B54 证据（2026-11-05，已实跑，CLI + 负向控制）**：B53 把六个命令写进了帮助，但 `moss <cmd> --help` 这条查询路径仍不一致：
`renderSubcommandHelp()` 缺 `rules`/`remember` 两个 case，于是它们回退到根 banner，而 `review`/`loop`/`auth`/`update` 都打印自己的用法。

- 改前：`moss rules --help`、`moss remember --help` 输出 `moss — a cross-platform coding agent harness … Most useful`（根帮助）；
- 改后：`moss rules --help` → `Usage: moss rules list [--json]     list scoped rules with activation class and size …`；
  `moss remember --help` → `Usage: moss remember "<fact>" … moss remember "<fact>" --dry-run preview only, write nothing`；
  中文 `--lang zh` 同样输出 `用法：…`；
- 回归门：`help-surface` stage 现在对全部 18 个 dispatcher 命令断言 `renderSubcommandHelp(name)` 非空（不是白名单，将来新增命令漏 case 会直接红）；
- 负向控制：临时删掉这两个 case 并重建 → probe exit 1，点名 `rules`、`remember`（同段被删的 `loop` 也被点名，恰好证明断言覆盖全部命令）；
  恢复后 `ok`。`npm run check` 绿、`npm run verify` PASS 43.4s。

**B53 证据（2026-11-05，已实跑，CLI 真跑 + 负向控制）**：三处命令面漂移互相关联——帮助漏命令让人发现不了功能，
别名是死代码让人以为命令不存在，裸 `auth` 又打印 usage。

- 改前：`moss logout` → `[moss] unknown command 'logout' … Did you mean 'auth'?` 退出 2（`moss login` 同）；
  裸 `moss auth` → `Usage: moss auth <status|logout>` 退出 2；`moss --help --all`（中英）没有 auth/update/loop/review/remember/rules
  六个命令（`renderAuthStatus` 等都能跑）。
- 改后：`moss logout` → `[auth] No API key is stored.` 退出 0；`moss upgrade` → 打印升级命令退出 0；
  裸 `moss auth` → 完整 auth 状态退出 0；`moss login` → 进入 setup 菜单。
- 帮助：英文新增 `auth status|logout · update`、`loop --until … · review list|check`、`rules list … · remember "<fact>"`、
  别名说明四行；中文同样四行并补上原先缺失的 `uninstall`。
- 回归门：新增 `scripts/verify/help-surface.mjs` + stage `help-surface`（0.1s），断言「18 个 dispatcher 命令在中英子命令段都出现」
  「每条命令都有 description」「四个别名必须解析成对应命令且无 unknownCommand」。
- 负向控制（真删源码再重建）：临时删掉 rules/remember 帮助行 → `probe_exit=1` 并点名两条，恢复后 `ok`。
- 过程中发现并修掉探针自身的假阴性：子命令段必须止于「交互命令」段，否则 `/rules`、`/remember` 会冒充 `moss rules`、`moss remember`。
  `npm run check` 绿、`npm run verify` PASS 48.9s。

**B52 证据（2026-11-05，已实跑，PTY 双轮 + 请求体实抓）**：B50 的占位符只陈述「图片被略过」，没有告诉模型该对用户说什么；
用户追问图片内容时，模型很容易照着文件名或上下文编造。

- 改后占位符（`DUMPREQ` 实抓第 2 轮请求体，`placeholder_requests=1`）：
  `[image omitted: this endpoint rejected image input earlier in this session. If the user asked about this image, say that the configured endpoint cannot accept images and suggest a vision model (/model) or describing it in text — do not guess what it shows.]`
- `read_image` 本地拒绝文案同步改成「verdict follows the endpoint, not the process: switch to a vision model with /model to re-probe,
  or run `moss config set agent.supportsImages false` …」，与 B51 的「换模型即重探」一致；
- 模块探针（直调 `prepareImageInput`）确认新文案生效；`npm run check` 绿、`npm run verify` PASS 40.6s。
  **本轮负结果（同一轮顺手测掉，避免以后重复排期）**：`-p` 的「白加载优化」不成立。在 `dist/cli/config.js` 已加载后实测
  `interactive-commands` 边际 2.6ms、`command-completion` 0.7ms、`help` 1.3ms；此前 65–91ms 的读数是 Node ESM loader 冷启动
  （首次 import 的 `performance.now` 含引擎预热），config.js 闭包只有 50 个 dist 模块 + 7 个 node_modules。B33 之后不应再排
  「把 interactive-commands / command-completion 改成懒加载」这类项。

**B51 证据（2026-11-05，已实跑，PTY 双轮 + 换模型）**：B50 的标记是进程内单向的，`/model` 在同进程切到视觉模型后，
标记仍然生效 → 视觉模型收不到图。这是 B50 引入的回归，必须当轮修掉。

- 脚本：轮 1「look at pic.png」→ `read_image` → 文本模型 `m` 回 400；然后 `/model vision-m`（stub `/models` 同时列出 `m` 与
  `vision-m`）；轮 2「read pic.png and describe what you see」。
- 改前（stash 掉 `switchModel` 里的 reset 后重建）：`image_requests=1, image_rejected=1, image_accepted=0` ——
  切到 `vision-m` 后**没有任何图片请求**，占位符逻辑继续生效；
- 改后：`image_requests=2, image_rejected=1, image_accepted=1`，请求体 model 依次为 `m, m, vision-m`，
  `vision-m` 收到图片并正常 `Completed: run finished`；
- 实现：`image-capability.ts` 的 `resetProviderImageRejection()` 只在 `MossAgent.switchModel()` 里调用，
  覆盖 TUI `/model`、REPL `/model`、`/model config`、setup 保存等所有宿主入口（它们都走 switchModel）。
  `npm run check` 绿、`npm run verify` PASS 41.0s。

**B50 证据（2026-11-05，已实跑，PTY 双轮 + 模块探针）**：文本端点对任何含图片的请求回 400（B44 的 `images_not_supported`）。
问题不是文案，而是**会话被历史图片永久毒化**：第 1 轮失败后，历史里那条图片会让第 2 轮请求在工具执行前就 400，用户只能 `/clear`。

- 改前（PTY，stub 拒绝图片）：第 1 轮 `Error: This model does not accept image input…`；第 2 轮发给 stub 的仍是同一条图片请求
  （`image_requests=2`），会话无法继续；
- 改后：第 1 轮错误文案多一句「本会话后续请求会用文本占位符代替图片，不再重复失败」；第 2 轮正常结束（`Completed: run finished`），
  `image_requests=1`；第 2 轮请求体（`DUMPREQ` 实抓）里原来的图片块变成
  `[image omitted: this endpoint rejected image input earlier in this session]`；
- 模块探针（直调 `prepareImageInput`）：置标记前返回 `{ok:true, block:'image'}`，置标记后返回本地拒绝
  `Error: pic.png was not attached — this session's endpoint already rejected image input …`（不再发请求）；
- 实现：`src/provider/image-capability.ts` 进程内单向标记，`pi-ai-adapter` 与 `pi-ai-stream-parser` 两条分类路径置位，
  `pi-ai-http-transport.ts` 的 `piMessagesToOpenAI()` 在置位后换占位符（transcript 保留图片，换视觉模型/新进程仍可用）。
  `npm run check` 绿、`npm run verify` PASS 45.7s。

**B49 证据（2026-11-05，已实跑，`moss doctor` 五态）**：B48 只覆盖事件名；条目级（`matcher` / `if:` 条件）写错工具名仍是静默哑火，
而且 `mcp__…` 前缀的合法 MCP hook 会被误报。

- 合法（`matcher: exec` + `if: exec(git *)`）→ 只有 `ok hooks: 2 hooks on 1 event (config files)`，无 ⚠；
- `matcher: exce` → `warn hooks: user: ⚠ matcher "exce" on PreToolUse matches no registered tool — this hook never fires`；
- `if: exce(git *)` → `warn hooks: user: ⚠ if condition on PreToolUse names unknown tool "exce" — it never matches`；
- matcher 指向工作区自定义工具（`.moss/tools/my.tool.json` 定义 `my_tool`，用真实 `loadFileBasedTools()` 解析）→ 不报（避免误伤自定义工具）；
- `matcher: mcp__rdk-docs__search_docs` → 不报；修复前该行会报「永不触发」（MCP 工具握手后才注册，启动/doctor 阶段不可见）；
- 实现：`moss doctor` 的 hooks 段用 `builtinTools` + `loadFileBasedTools(workspace)` 组成已知工具名集合，
  逐条调用 `hookEntryWarnings()`（与 `/hooks`、启动告警同一份判定）；`warnsAboutTool()` 增加 `mcp__` 豁免（与 B42 规则审计一致）。
  `npm run check` 绿、`npm run verify` PASS 40.8s。

**B48 证据（2026-11-05，已实跑，`moss doctor` 四态）**：`mergeHooksConfig()` 只遍历 `HOOK_EVENT_KEYS`，所以 `hooks.PreToolUseTypo`
这类未知事件名（拼错、或来自 Claude 的其它事件名）会被无声丢弃：配置看起来已生效，实际永不触发。

- 改造前（临时 stash 掉本轮改动后重建）：`moss doctor` 对 `hooks: {PreToolUseTypo: [...]}` 输出 0 条 hook 行（完全静默）；
- 改造后：`warn hooks: user config has 1 hook(s) on "PreToolUseTypo", which is not a Moss event — they never fire
(events: PreToolUse, PostToolUse, PostToolUseFailure, UserPromptSubmit, PermissionRequest, PermissionDenied,
SessionStart, Stop, SubagentStart, SubagentStop, PreCompact, PostCompact, SessionEnd, Notification)`；
- 混合配置（1 条合法 `PreToolUse` + `ZzzEvent`）：1 条 warn + `ok hooks: 1 hook on 1 event (config files)`；
- 全合法（`PreToolUse` + `Stop`）：`ok hooks: 2 hooks on 2 events (config files)`；
- 无 hooks 配置：0 行（不打扰）。
  项目配置里的 hooks 只在文件夹已信任时读取（与运行时一致）；B42 的「规则名不匹配工具」启动告警、B46 的实时 hooks 状态行与本条互补。
  `npm run check` 绿、`npm run verify` PASS 49.9s。

**B47 证据（2026-11-05，已实跑，`moss doctor` 四态）**：B46 的 MCP 行只存在于交互式 `/doctor`（需要 agent 的实时状态）；
可脚本化的 `moss doctor` 依然不看 mcp.json，写坏的条目要等第一次用到该服务器才暴露。

- 无 mcp.json：无 MCP 行（保持原有安静输出）；
- 用户级合法（`{stub: {command: node, args: […server.mjs]}}`）：`ok MCP config: 1 server: stub`；
- 条目写坏（`{bad: {transport: "stdio"}}`）：`ok MCP config: no valid servers (see below)` +
  `warn MCP config: [mcp] skipping server "bad" in …/mcp.json: stdio transport requires "command"`；
- 项目级 `.moss/mcp.json` 且文件夹未信任：`warn MCP config: project .moss/mcp.json is ignored until this folder is trusted —
run /trust (or the folder-trust prompt) to enable it`（与运行时行为一致，避免列出「其实不会加载」的服务器）；
- 在 `<configDir>/workspace-trust.json` 写入该路径后：`ok MCP config: 1 server: proj`。
  `npm run check` 绿、`npm run verify` PASS 49.0s。

**B46 证据（2026-11-05，已实跑，PTY 真交互）**：`/doctor` 是用户「感觉不对」时第一个看的报告，但它既不报 MCP 服务器状态，
也不报 hooks 配置——两者恰好是最容易静默失效的配置面。

- 改造前 PTY `/doctor`：`node / version / model / provider / auth / egress / approval.*` 之后直接是会话日志行，无 MCP、无 hooks；
- 改造后（configDir/mcp.json 挂 `/tmp/mcp-srv/server.mjs` stub + 3 条 PreToolUse hook）：
  `ok MCP: 1/1 connected`、`ok hooks: 3 hooks on 1 event`、两条
  `warn hooks: ⚠ matcher "exce" on PreToolUse matches no registered tool — this hook never fires` /
  `warn hooks: ⚠ if condition on PreToolUse names unknown tool "exce" — it never matches`；
- 失败态：把 MCP 命令换成 `node -e process.exit(1)` → `warn MCP: 0/1 connected; failed: broken — see /mcp to retry,
check the command in mcp.json`；
- 实现：数据源是 B39/B40 已经发布的 `CliRuntimeStatus.hooksConfig` / `listMcpServers`（不新增探测），
  hook 告警文案由 `hooks-view.ts` 新导出的 `hookEntryWarnings()` 提供，`/hooks` 与 `/doctor` 共用同一份措辞。
  `npm run check` 绿、`npm run verify` PASS 38.1s。

**B45 证据（2026-11-05，已实跑，dist 直调）**：Linux 的剪贴板没有内置实现，图片与文本都要 `wl-paste`（Wayland）
或 `xclip`（X11）。两者都缺时，旧代码会一路掉到通用的 `clipboard has no image, file or text`，
把「缺工具」误诊成「剪贴板空」。

- 改造前（dist 直调 `captureClipboardAttachment({platform:'linux'})`，本机无这两个工具）：
  `{"kind":"empty","reason":"clipboard has no image, file or text"}`；
- 改造后同一调用：`{"kind":"empty","reason":"no clipboard tool found — install wl-clipboard (wl-paste) or xclip to paste on Linux"}`；
- 负例（PATH 头部放一个假 `wl-paste`，使 `command -v` 命中）：仍返回通用 `clipboard has no image, file or text`
  —— 检测不会在工具存在时误报；
- 实现：`missingLinuxClipboardTool()`（`sh -c 'command -v …'` 两次探测），只在 linux 分支兜底时使用；
  macOS（osascript/pbpaste）与 Windows（powershell）路径不变。
  `npm run check` 绿、`npm run verify` PASS 40.9s。

**B44 证据（2026-11-05，已实跑，headless + stub provider）**：用户用文本模型贴图/调 `read_image` 时，provider 的 400 被
`matchModelNotFound` 吃掉（transport 给任何 400 追加「this model name is not available on the gateway」），
于是报「The gateway does not have this model」——原因错误、下一步也错。

- 改造前 e2e（stub 第一轮让模型调 `read_image`，第二轮对含 image part 的请求返回 400 `Invalid image_url…`）：
  `Error: The gateway does not have this model. Pick another with /model, or run moss setup.` + `Gateway text: Invalid image_url…`；
- 改造后同一 e2e：`Error: This model does not accept image input, so the images in this request were rejected. Switch to a
vision model with /model; if you only use text models, run `moss config set agent.supportsImages false` so read_image
explains this before the request is sent.`；
- 分类矩阵（dist 直调 `classifyProviderError`）：含 image 措辞 ×2 → `images_not_supported`；`does not support tool calls` /
  `tool calls are not supported` → `tools_not_supported`（此前两条都落到 `unknown`）；`unexpected field foo` → `unknown`（不误报）。
- 实现：新 category + 文案；`matchImageUnsupported()` 先于 `matchModelNotFound()`；debug 探针（`MOSS_DEBUG_CLASSIFY`）用完已移除，
  dist 里 `dbg-classify` 计数为 0。
  `npm run check` 绿、`npm run verify` PASS 43.2s。

**B43 证据（2026-11-05，已实跑，PTY + 真剪贴板）**：B01 的「Ctrl+V 贴图」只在 TUI（`edit.attachClipboard`），readline REPL 里
既是 `unknown command`，`moss --help` 却把 Ctrl+V 写在「Inside Moss」。

- 改造前 PTY：`/paste describe this image` → `[help] unknown command "/paste"` + `Did you mean /bashes, /cost, /ps?`；
- 改造后（`osascript` 把 64×64 纯蓝 PNG 放进真剪贴板）：`/paste describe the image` →
  `attached 118392be79c5eaae.png (1 KB) — ask moss to read_image it`；stub 抓到的请求体第一条 user 消息为
  `@.moss/runtime/attachments/118392be79c5eaae.png describe the image`（同一措辞与 TUI 一致，read_image 可打开暂存文件）；
- 文本路径：剪贴板设为 `error: ENOENT camera0` → `/paste why does this happen` → 消息为 `why does this happen` + 换行 + 剪贴板原文；
- 实现：复用 `captureClipboardAttachment()`（图片/Finder 文件/路径/文本四条分支 + 魔数/3MB 校验都在 B01 已实现），REPL 只加编排；
  `/paste` 进 REPL 菜单（`INTERACTIVE_COMPLETION_COMMANDS`），`moss --help` 行改为「TUI；REPL 用 /paste」。
  `npm run check` 绿、`npm run verify` PASS 42.7s。

**B42 证据（2026-11-05，已实跑，headless）**：B38 的死规则告警只在 `/permissions` 视图里，headless 用户看不到。

- 改造前：`deny ["exce(npm run *)"]` 的 `-p 'say ok'` 全程无任何提示（规则解析成功、计数 +1、永不匹配）；
- 改造后同一配置：`[moss] permission rule "exce" names no registered tool — it never applies (fix it in /permissions)`；
- 负例（必须静默）：`exec(npm run *)` → 0 条；`mcp__rdk-docs__search_docs` → 0 条（MCP 工具握手后才注册，
  启动审计不能误报）；混合 `exce(…), Run_Tests(*), exec(*)` → 只报 `exce`（`Run_Tests` 大小写不敏感命中 `run_tests`）；
- 实现：`unmatchedRuleToolNames()` 抽到 `cli/permission-rules.ts`，`/permissions`（B38）与启动审计共用，避免两套判定漂移。
  `npm run check` 绿、`npm run verify` PASS 40.2s。

**B41 证据（2026-11-05，已实跑）**：headless `-p` 的 web 工具面由 `WEB_ELIGIBLE_PROMPT_RE` 决定（同一正则也让
`isPureChatOneShotRequest` 不把这类提示当纯聊天）。常见说法不在正则里时，模型需要联网却被摘掉 web 工具。

- 改造前（stub 模型直接调 `web_fetch`，配置里 `deny web_fetch(domain:example.com)` 当探针）：
  `look up the Rust 1.80 release notes` / `what's new in Node 24` / `check the official site for moss`
  → 全部 `Unknown tool: web_fetch`（工具根本不在面里）；
- 改造后同一探针：三条全部变成 `Tool "web_fetch" blocked by deny rule web_fetch(domain:example.com)`（2–4ms，未联网）
  —— 证明工具已进入工具面，只是被策略拦下；
- 对照：`explain closures in JavaScript` 改造前后都 `Unknown tool: web_fetch`（web 工具面没有被放宽成默认）；
- dist 层 `isWebEligiblePrompt` 正例 6/6（含中文「看看最新发版说明」）、负例 6/6（`hi`、`thanks`、`write a fibonacci function` 等）。
  `npm run check` 绿、`npm run verify` PASS 38.2s。

**B40 证据（2026-11-05，已实跑，PTY 真交互）**：REPL 斜杠面清点后只剩 `/mcp` 缺口（`/context` `/usage` `/tasks` `/skills`
`/agents` 都能用，`/mcp` 与 `/hooks` 一样只存在于 TUI）。

- 改造前 PTY：`/mcp` → `[help] unknown command "/mcp"`；
- 改造后 PTY（configDir/mcp.json 配置 `/tmp/mcp-srv/server.mjs` stub）：`MCP` + `● stub — connected (3 tools, lazy)`（与 TUI 同措辞）；
- 无 mcp.json：`MCP` + `no MCP servers configured (moss mcp add <name> <command>, or .moss/mcp.json)`；
- 实现：`CliRuntimeStatus.listMcpServers` 由 runtime 的 `listMcpServerStatuses()` 发布（TUI 的 `listMcpServers` 选项也改用它，
  单一数据源），过滤 `deferred` 状态，避免地把「还没连」错报成失败。
  `npm run check` 绿、`npm run verify` PASS 46.8s。

**B39 证据（2026-11-05，已实跑，PTY 真交互）**：`/hooks` 只存在于 TUI 内联分支，REPL 输入 `/hooks` 是未知命令；
而 `CliRuntimeStatus.config`（`resolveCliConfig()` 的结果）根本不带 `hooks`（dist 实测 `hasHooks:false`），
所以 TUI 那个视图实际也永远显示「no hooks configured」——hooks 是最强的配置面（9 事件、可阻塞否决），却看不到。

- 改造前 PTY：`/hooks` → `[help] unknown command "/hooks"` + `[help] Did you mean /tasks?`；
- 改造后 PTY（配置含 3 条 PreToolUse）：
  `PreToolUse [exce] echo typo · blocking` + `⚠ matcher "exce" on PreToolUse matches no registered tool — this hook never fires`；
  `PreToolUse [exec] echo ok`（无告警）；`PreToolUse echo all` + `⚠ if condition on PreToolUse names unknown tool "exce"`；
- 实现：`cli/hooks-view.ts` 单一格式化器（REPL 与 TUI 共用），`CliRuntimeStatus.hooksConfig` 由
  `projectCapabilities.hooks` 发布（`config.hooks` 那条路本来就读不到）。
  `npm run check` 绿、`npm run verify` PASS 41.0s。

**B38 证据（2026-11-05，已实跑，PTY 真交互）**：B35/B36 修的是「工具名对、操作数没提取」；这一轮补的是「工具名根本不存在」——
`deny: ["exce(npm run *)"]` 解析通过、`/permissions` 显示 `deny 1`，看起来健康，实际永不匹配。

- 改造前（stash 重建 dist）PTY `/permissions` 与 `/permissions --verbose`：`⚠` 行 **0**；
- 改造后同一配置：`⚠ rule exce matches no registered tool — check the spelling; it never applies`，
  且 **只** 报这一条 —— `exec(npm run *)`（存在的工具）、`Read_File(./secret)`（大小写不同但存在）都不报，
  通配规则 `exec*` 按设计跳过（无法精确判断）；
- 传参来自 `ctx.agent.tools.getAll()`，因此 MCP 握手后注册的工具名同样被认作有效。
  `npm run check` 绿、`npm run verify` PASS 38.7s。

**B37 证据（2026-11-05，已实跑，PTY 真交互）**：B06 的 manual 规则（`description` 有、`globs` 空）要靠 `@rule:<name>` 加载正文，
但扫描只发生在 `createCliPromptSetup({ initialText: process.argv.join(' ') })`；REPL 的 argv 没有提示词，
于是**交互会话里 `@rule:` 完全不生效**（headless `-p` 因为 argv 带提示词才碰巧能用）。

- 改造前 PTY：`hello there` → `none`；`@rule:described give me a fruit` → `none`（规则正文没进提示词）；
- 改造后 PTY 同一会话：第一轮 → `none`，第二轮 → `BANANA`；首轮直接 `@rule:` → `BANANA`；
- headless 对照（不变）：`-p '@rule:described …'` → `BANANA`，`-p 'give me a fruit'` → `none`；
- 实现：`noteUserText()` 在 `onInputGuardrail` 里按轮扫描（REPL 每轮用户消息都经过这里），
  已请求规则在会话内 sticky 累加（加载是增量语义，中途撤掉正文会很怪）。
  stub provider 的判定依据是 system 消息里是否出现规则正文，不是固定字符串。
  `npm run check` 绿、`npm run verify` PASS 44.2s。

**B36 证据（2026-11-05，已实跑）**：B35 修好 `web_fetch` 后，同类「解析通过但永不匹配」的形状仍在其余路径型工具上。

- 改造前：`deny: ["list_directory(./private)"]` → `✓ list_directory (private) 7ms`，私有目录被正常列出；
  `deny: ["search_code(./src)"]` → `✓ search_code (needle) 30ms`，规则等于没写；
- 改造后：两者分别 `✗ 2ms Tool "list_directory" blocked by deny rule list_directory(./private) (user)` /
  `✗ 2ms … search_code(./src) …`（2ms，未触盘）；
- 不误伤：同一 deny 下 `list_directory(./public)` 仍执行（报 `no such directory` 是文件系统事实，不是策略拦截）；
- dist 9 组对照全绿：含 `read_image(./secret.png)` 正/负例（read_image 需要视觉模型，headless 文本 stub 看不到该工具，
  故只在模块层验证）与 `run_tests(pytest *)` 正/负例。
  `npm run check` 绿、`npm run verify` PASS 40.0s。

**B35 证据（2026-11-05，已实跑，安全向修复）**：`deny: ["web_fetch(domain:example.com)"]` + stub provider 让模型 `web_fetch https://example.com/`：

- **改造前**：规则被静默忽略 —— 工具真的联网抓取成功（`✓ web_fetch 695ms`），deny 等于没写；
- **改造后**：`✗ web_fetch (https://example.com/) 3ms: Tool execution denied: Tool "web_fetch" blocked by deny rule
web_fetch(domain:example.com) (user)`（3ms，未联网）；
- 子域：`deny domain:example.com` 拦下 `https://www.example.com/`（2ms，未联网）；
- 不误伤：同一 deny 下 `https://example.org/` 仍放行（`✓ 656ms`）；
- URL 前缀族：`web_fetch(https://example.com/*)` 拦下 `https://example.com/docs`（3ms）—— 这条以前也永不生效。
  dist 十组对照全部符合预期（含安全负例 `https://example.com.evil.io/` 不匹配、`domain:*.example.com` 匹配、端口/大小写容错）。
  `npm run check` 绿、`npm run verify` PASS 39.6s。

**B34 证据（2026-11-05，已实跑）**：隐藏命令（`hidden: true`）不在补全表里，因此拼写错误也拿不到建议。

- `-p '/contex'`（改造前）→ 只有 `unknown command "/contex"`；改造后 → `Did you mean /context, /cost?`
  （`/cost` 是同样隐藏的 `/usage` 别名，属正确提示）；
- REPL（`MOSS_NO_TUI=1`，pipe `/contex`）→ 同一句建议，说明两条错误路径共用同一张表；
- 负例：`-p '/zzzzzz'` → 无建议（`closestSlashCommands` 的距离阈值照旧，不会变成目录 dump）；
- 边界：`-p '/context'` 仍 exit 0 正常执行；`dist` 断言 `INTERACTIVE_COMPLETION_COMMANDS` 仍 19 条且不含 `/context`，
  `DISPATCHABLE_SLASH_COMMANDS` 44 条含之——menu/补全面没被放宽。
  `npm run check` 绿、`npm run verify` PASS 36.2s。

**B33 证据（2026-11-05，已实跑，B32 续）**：模块计数（7 次真实 `-p` 运行）370 → 367，去掉
`cli/repl-process.js`、`cli/repl-chrome.js`、`cli/transcript-types.js`、`cli/tui-utils.js`，新增 30 行 `cli/session-format.ts`。
行为逐条实跑（stub provider + 临时 config）：

- `-p 'say ok'` → exit 0、输出 `Completed: run finished`；
- `-p '/helpp'` → `Did you mean /help?`；`/modelx` → `/model?`；`/skillz` → `/skills?`（`closestSlashCommands` 路径仍通）；
- 指向死端口 provider 下 `moss doctor` → `context window: not yet probed — using conservative default of 1M tokens`、
  `max output: 16k tokens`（`humanTokens` 迁移后格式不变），doctor exit 0。
  附注（下一轮候选）：`/contex` 这类**隐藏命令**拼写没有建议（`/context` 是 `hidden: true`，不在补全表里），属真实小缺口。

**B31 证据（2026-11-05，已实跑）**：临时 `MOSS_CONFIG_DIR` 写 `permissions.allow`，跑 `moss doctor`：

- `allow: ["exec(git * main)"]` → `warn  allow rules: allow rule wildcard sits mid-pattern: exec(git * main);
it matches more than intended - put the literal prefix first and end with *, e.g. exec(git log *)`；
- `allow: ["exec(git log *)"]`（末尾前缀族）→ 无该告警（对照，避免误报）；
- `allow: ["exec(*)"]` → 告警（整工具通配）；
- `allow: ["exec(git * main)","exec(npm run *)"]` → 只点名前者，不牵连合规规则。
  doctor 退出码仍为 0（告警不是失败）。`npm run check` 绿、`npm run verify` PASS 40.8s。

**B30 证据（2026-11-05，已实跑，前后对照）**：写了一个会主动发 server→client 请求的 MCP stdio 服务器
（`ping`、`roots/list`、`sampling/createMessage`），用 dist 的 `McpStdioTransport` 连上并调用 `tools/list`：

- **改造前（git stash 掉本次改动 + 重新 build）**：服务器等待的三个应答一个都没到，记录文件根本不生成
  —— 请求被静默丢弃（旧代码 `pending.get(id)` 找不到就 `return`）；
- **改造后**：服务器收到
  `ping → {"result":{}}`、`roots/list → {"result":{"roots":[]}}`、
  `sampling/createMessage → {"error":{"code":-32601,"message":"method not supported by moss: sampling/createMessage"}}`
  （协议合法应答，服务器不会卡住）。
  `npm run check` 绿、`npm run verify` PASS 39.4s（`mcp-protocol` stage 全绿）。

**B29 证据（2026-11-05，已实跑，B20 第 3 片）**：直接对 `dist` 构造真实传输触发失败，用 `formatMossError` 渲染：

- stdio 缺 `command`：`mcp server "nocommand": stdio transport requires "command"` → `→ Add "command": "<server>" … to the server in mcp.json, then retry.`；
- http 缺 `url`：`missing required field "url" for http transport` → `→ Set "url" (http/https) … or use a stdio server (moss mcp add …)`；
- http 端点返回非 JSON（本地普通 HTTP 服务）：`returned a non-JSON body for "tools/list"` → `→ The URL is probably not an MCP endpoint …`；
- stdio 已关闭后继续 request：`is not connected (state: closed)` → `→ The transport is closed or was never started; run moss mcp list and retry in a new session.`
  （此条此前 hint 为 `_lastError` 的空值，整条不显示，现改为兜底文案）。
  `npm run check` 绿、`npm run verify` PASS 39.4s（`mcp-protocol` stage 全绿）。

**B28 证据（2026-11-05，已实跑）**：本地 HTTP 端点作钩子，stub provider 让模型调 `exec echo hi`：

- `PreToolUse` http 钩子收到 `POST /block`，payload 含 `event:"PreToolUse"`、`toolName:"exec"`、`input.command:"echo hi"`，
  自定义 `Authorization: Bearer hooktoken` 头原样送达；
- 该端点返回 `{"decision":"block","reason":"http-hook says no"}` → 工具被拦，`-p` 最终 `Incomplete: a safety check refused an action`、exit 9；
- `PermissionDenied` http 钩子返回 500 → 只提示 `[hooks] PermissionDenied exited 500: HTTP 500`，不中断运行（advisory 语义）；
- `PostToolUse` http 钩子（200 + `{"ok":true}`）正常收到事件。
  `npm run verify` PASS 40.8s（含 `hooks-contract` 全绿：命令行钩子语义未被改动）。

**B27 证据（2026-11-05，已实跑）**：stub provider 让同一 run 先 `exec echo hi` 再 `exec git status --porcelain`：

- `PreToolUse` + `if:"exec(git *)"` → 钩子只收到 **1 次**，payload `cmd:"git status --porcelain"`（echo 那次没触发）；
- `PostToolUse` + 同一 `if` → 同样只收到 git 那次（`isError:true`，因为临时工作区不是 git 仓库）；
- `if:"exec(git *)*"`（非法 spec）→ stderr `[hooks] invalid if (…); hook … is skipped`，该钩子不运行；
- `SessionStart` 带 `if` → stderr `[hooks] SessionStart hook …: if only applies to tool events; hook removed`；
  `npm run check` 绿、`npm run verify` PASS 39.1s。

**B26 证据（2026-11-05，已实跑）**：TUI 的 `/skills` 对有问题的技能给出 `moss skill validate <name>`，
而旧实现把参数当路径解析（`<workspace>/<name>/SKILL.md`），用户级技能照抄必然失败。修复后实跑五种情况：

- 工作区技能 `demo` → exit 0，输出 `skill: demo / source: workspace …/.moss/skills/demo`；
- **用户级**技能 `userskill`（只在 `<configDir>/skills/userskill`）→ exit 0，按名解析命中；
- 未知名称 `nope` → exit 2，逐行列出搜索的 5 个范围（workspace/shared/configDir/~/.claude）并提示可改传路径；
- 显式路径 `.moss/skills/demo` → 与修复前一致（exit 0）；
- 无参数 → 打印用法（`validate <名称|路径>`）；`npm run check` 绿、`npm run verify` PASS 39.3s。

**B25 证据（2026-11-05，已实跑）**：修复前 `hookMatcherMatches("exec", "exec_background", false)` 返回 **true**
（`exec` 作为无锚点正则命中前缀），Claude-format 同样输入返回 false —— 两种 format 语义不一致。
修复后 12 条用例全过：`exec`→`exec_background` false、`exec`→`exec` true、`exec|exec_logs`→`exec_logs` true、
`exec, exec_stop`→`exec_stop` true、`^exec`→`exec_wait` true、`mcp__srv__.*`→`mcp__srv__tool` true、
空/`*` 全匹配、Claude-format `Edit|Write`→`Edit` true。
真实 e2e：`hooks.PostToolUse = [{matcher:"exec", …}]`，一次 run 里先调 `exec`（echo hi）再调 `exec_logs`（无此 job），
hook 只记录 **1 条** `{tool:"exec"}`（修复前会是 2 条）。`npm run check` 绿、`npm run verify` PASS 40.1s。

**B24 证据（2026-11-05，已实跑，双向对照）**：`config.json` 的 `hooks` 里同时配 `PostToolUse` 与
`PostToolUseFailure`，hook 脚本把 stdin payload 落到 `hooks.jsonl`：

- 模型调用 `read_file` 读不存在的 `missing-probe.txt`（工具失败）→ 记录 **两条**：
  `{event:"PostToolUse", isError:true}` 与 `{event:"PostToolUseFailure", isError:true, tool:"read_file"}`；
- 同样配置下读**存在**的 `present.txt`（工具成功）→ 只记录 `{event:"PostToolUse", isError:false}`，
  没有 failure 行（不是「每次调用都报失败」）。
  `npm run check` 绿、`npm run verify` PASS 40.6s。

**B23 证据（2026-11-05，已实跑，双向对照）**：本地 stub 的 `/v1/models` 故意 sleep 3.0s，`moss -p hi` 墙钟
**3679ms → 2119ms**（改动前整轮为首轮白等 4s 上限；改动后 1.5s 封顶，run 仍 exit 0 / `Completed: run finished`）。
健康端点对照：`/v1/models` 立即返回 → 仍且仅探测 1 次，墙钟 589ms，`MOSS_STARTUP_TIMING` 行
`entry=234ms … probe=185ms total=187ms` 正常，说明探测结果照旧生效（不是被跳过）。

**B18 收口结论（2026-11-05）**：五片之后 eager 模块 **511 → 371**（dist 346 + node_modules 25），
`--version` 320ms → 77ms；剩余大头是 core/loop(49)/core/tools(19)/core/session(13) 这类任何 agent run 都需要的模块，
继续懒加载的边际收益已接近 0（逐个候选项的 exclusive 子树只有 1–3 个模块）。
再往前只能走「打包发布形态」（esbuild/rolldown 单文件入口 + 保留按文件 dist 给 verify 用），属独立立项，不再按 30min 片推进。

**B22 证据（2026-11-05，已实跑）**：`dist` 直接渲染两个病态技能 —— 一个 `description` 5,000 字符 + `when` 5,000 字符，
一个名字 2,000 字符：

- 名字病态的条目被压到 **正好 1,536 字符**并以 `…` 结尾（`SKILL_CATALOG_ENTRY_MAX_CHARS`）；
- 长 `when` 条目输出 `(when: …)` 长度为 **240**（`SKILL_CATALOG_WHEN_MAX_CHARS`）；
- 两个技能**都仍在目录里**（覆盖优先于细节，未把别人挤掉），`strategy: full`、`renderedChars` 仅 618/1536+466；
- `npm run verify` PASS in 36.4s（含 `skill-catalog-usage` 六断言 stage，排序/预算行为未回归）。

**B21 证据（2026-11-05，已实跑）**：`node bin/moss.cjs --version` 8 次中位墙钟 **320.2ms → 76.6ms**（−76%）；
输出逐字一致（`moss v0.31.0 (<sha>+dirty, 2026-11-04)`）。语义对照（改前/改后同结果）：`-v`、`--version --json`、
`exec --version`、`config --version`、`--version --all` 都只打印版本；`-h -v` 与 `--version --help` 仍打印帮助；
`moss -- --version` 仍是送给模型的 payload。PTY 下颜色与 `displayVersion()` 相同（bold moss + cyan 版本串），
`NO_COLOR=1` / `MOSS_NO_COLOR=1` 仍无 ANSI。`-p` 路径回归：stub provider 收到 1 次请求并回 `pong`。

**B09 探针（2026-11-05，已实跑）**：对 `dist` 直接调用 `truncateWithRecoveryPath({toolName:"read_file", text: 20000 行长文本, workspaceDir: 临时工作区})`，
其中第 15001 行埋了 `THE-ELIDED-REGION-MARKER`。结果：可见结果被截到 **16,424 字符**、带
`[full output saved to .moss/runtime/tool-output/read-file-*.txt — …]` 指针；该 spill 文件**真实存在**且**包含**被省略的 marker，
而可见结果里**没有**该 marker —— 即被截断的中段确实可以从磁盘取回。

**B01 收尾证据（2026-11-05，已实跑，两路请求体对照）**：同一张 2×2 PNG、同一条 `moss -p "@shot.png what is this?"`：

- 默认（视觉模型）：请求体含 **base64 PNG（`iVBORw0KGgo…`）** 与“attached below as image content”说明 → 模型首轮就拿到像素，不再是「先落盘再让模型自己 read_image」的两步；
- `agent.supportsImages: false`：请求体**不含** base64，退化为 `Open each one with read_image before answering: the reference is a path, not the image content itself.`
  即声明为纯文本模型时不会往 provider 塞它不接受的 image block。

**B01 切片证据（2026-11-05，已实跑）**：工作区放一张 2×2 PNG，headless 提交 `@shot.png what is this?` →
抓到的请求体含 `<attachments>` 块、`shot.png`、以及「先 read_image 再回答」的指引（`has_attachments_block/metrics` 全为 true）。
负例（dist 直调 `formatImageMentionContext`）：`@notes.txt` → null、`@missing.png` → null、`@../etc/hosts.png` → null、
无 workspaceDir → null、4MB 的 `@big.png` → 明确提示「above the 3 MB read_image limit」。即不会把非图片/越界/不存在的路径伪装成附件。
剩余差距：仍不是原生多模态附件（要模型调 `read_image` 才真正看到像素）。

**B02 端到端探针（2026-11-05，已实跑）**：本地 SSE stub 跑在独立线程（避免 H8 那种「驱动器阻塞 stub」），
配置 `contextTokens: 4000` / `maxOutputTokens: 500`；REPL 里连发 4 轮让模型每轮回 36KB 长文，再 `/compact`，然后再发一轮。
抓到的**第 7 个请求体**里包含：
`<historical-transcript>` 与 `Messages dropped by this compaction are still on disk at: .moss/sessions/cli-20261105064021-db932d57.jsonl`，
且该文件名与工作区 `.moss/sessions/` 里的真实文件完全一致 —— 压缩后的下一轮模型可以 `read_file` / `grep` 回查被丢弃的原文。
副产物：同轮还观察到一次 `compaction summary is missing required sections; retrying once`（9 节结构校验生效并重试成功）。

## 3. 逐条说明（为什么现在最值得做 · 最小切片 · 风险）

**B01 图片/附件链路（P0）**
帮助页承诺 Ctrl+V 贴剪贴板图（`help.ts:64`），提示词又让模型「用文件工具读本地图片」（`agent-behavior-prompt.ts:29`），
但 `read_file` 对二进制直接报错、`attachment-refs.ts` 没有任何调用者、wire 层（`contracts/messages.ts:11`、
`message-convert.ts:109`）却早就支持 image block。RDK 现场调试最常见的输入就是接线图/报错截图/相机画面；
模型看不见图，用户只能手打描述，这是**承诺与能力直接矛盾**的第一优先级缺口。
最小切片：只做 `read_image` 工具（读 path → 校验魔数/大小 → 返回 structured image 结果），先不动剪贴板与 TUI 粘贴。
**第一片已落地（2026-11-05，本轮）**：`src/tools/read-image-tool.ts`（`read_image`，PNG/JPEG/GIF/WebP，
魔数判定而非扩展名，3 MB 上限，`executeStructured` 返回 text+image block；readonly/plan-safe/noReplay）；
`builtin.ts` 注册；`message-convert.ts` 把 tool_result 里的 image block 作为下一条 user 消息送进 provider request；
`agent-loop-tool-execution.ts` 把 image block 从 12K 结构化元数据预算里豁免（否则每张截图都被截断提示替换，
另设 16M base64 上限兜底）。回归门：verify stage `read-image`（8 断言，0.2s：注册/只读元数据、
PNG 真图往返、魔数优先、伪装 .png 拒绝、缺文件/超限报错、tool_result 图像进 provider、纯文本结果不变）。
真实验证：`moss -p "Use read_image on pic1.png and tell me in three words what color it is." --output-format json`
（64×64 纯蓝 PNG，文件名不含颜色线索）→ 模型调用 `read_image` 后回答 `Solid bright blue.`；会话 JSONL 里
`"type":"image"` + `"mimeType":"image/png"` 与 `[image] pic1.png …` 均落盘。
仍未做：文本模型的能力守卫（无 vision 的模型会把图发出去再报错）、剪贴板/TUI 粘贴、`attachment-refs.ts` 接线、
会话体积预算（base64 直接进 JSONL，一张 3 MB 图 ≈ 4 MB 会话行）。

**已落地（2026-11-05，本轮 = B01 下一片：图片总量预算）**：新 `src/context/image-budget.ts`——
`pruneHistoricalImages` 在 `convertMessagesToPi`（工具观测图片进入 provider 消息的唯一入口）里从新到旧保留
最新 `IMAGE_HISTORY_MAX_COUNT=8` 张、累计 base64 `IMAGE_HISTORY_MAX_BYTES=12 MiB`，更早的 image block 在
**请求里**换成一条 `[N earlier image(s) omitted from this request: only the newest 8 images / 12 MiB stay
attached. The session still has them; call read_image again if you need to look.]`；session JSONL 不改写
（审计/回放/导出保留全部图片），无图消息保持同一引用（前缀缓存稳定）；`MOSS_IMAGE_HISTORY_MAX_COUNT` /
`MOSS_IMAGE_HISTORY_MAX_BYTES` 可强制调小便于验证。回归门：verify stage `image-budget`（6 断言，0.1s：
默认预算不裁剪、count 预算保留最新两张并给提示、session 不被改写、字节预算生效、env 覆盖与非法值回退、
无图消息引用不变）。
**线级真实验证**（脚本化 OpenAI 兼容 provider 记录每个请求体，`MOSS_CONFIG_DIR` 隔离配置，真实 CLI 跑 3 张图）：
`MOSS_IMAGE_HISTORY_MAX_COUNT=1` 时请求里的 `image_url` 数量恒为 **1/1/1**，且提示逐轮累积（notices 0→1→2）；
同一场景不设上限（默认 8）时为 **1/2/3** 且无任何 notice；两次运行的 `.moss/sessions/*.jsonl` 都保存了
**3** 个 image block。
**已落地（2026-11-05，本轮 = 无视觉模型守卫）**：新增配置声明 `agent.supportsImages`（config.json，
默认 true，来源标记 `supportsImagesSource`），经 `resolveCliAgentRuntimeOptions` → `MossAgentConfig` →
`ToolContext.supportsImages` 进入工具层；`read_image` 在 `prepareImageInput` 最前面判断
`ctx.supportsImages === false` 时直接返回错误文本（不读字节、不产生 image block）：
「declares no image input (agent.supportsImages=false) … Describe the file in text instead（read_file /
exec file|xxd）… switch to a vision-capable model」，`execute` 与 `executeStructured` 两条路径一致。
`read-image` stage 从 8 断言扩到 **11**（新增：无视觉模型得到原因且无 image block、plain execute 同样降级、
未声明时默认仍可看图）。
**真实证据（脚本化 provider 记录每个请求体的 `image_url` 数量 + 真实 CLI；同一工作区/提示
「Use read_image on img0.png and tell me what you see.」）**：`.moss/config.json` 设
`agent.supportsImages:false` → 三轮请求的 imageParts **0/0/0**，模型看到的工具结果含
「declares no image input」并回复 `SAW:LIMITATION`；同一工作区设 true → 请求 imageParts **0/0/1**，
模型回复 `SAW:IMAGE`。session JSONL：false 时 **0** 个 image block，true 时 **1** 个（审计与请求一致）。
**已落地（2026-11-05，再补一片 = 声明可从 CLI 写/清/看）**：`agent.supportsImages` 之前只能手改
config.json（`config get` 来源表认识它，`config set` 的 switch 不认识）。现在 `moss config set
agent.supportsImages false`（true/false，兼容 yes/no、on/off、1/0）与 `moss config unset
agent.supportsImages` 都可用，`moss config --help` 的 en/zh 键表与示例列出该键，`moss config show --json`
新增 `supportsImages` + `supportsImagesSource`（user/project/default），非法值 exit 1 且不写文件。
`read-image` stage 从 11 断言扩到 **14**（新增：set 落盘并在 resolved 输出里可见、非法值失败且文件不变、
unset 回到默认 true/source=default）。
**真实证据（真实 CLI + 脚本化 provider，同一工作区/提示）**：`MOSS_CONFIG_DIR` 临时目录下
`moss config set agent.supportsImages false` → `config show --json` 得 `"supportsImages": false,
"supportsImagesSource": "user"`；同一工作区 `moss -p "Use read_image on pic.png …"`（pic.png 为 1×1 真
PNG，70 B）→ 工具结果为拒绝文本、**三轮请求 imageParts 0/0/0**、终稿 `ANSWERED:REFUSED`；`config unset`
后再跑同一命令 → 工具结果 `[image] pic.png (image/png, 70 B)`、**imageParts 0/0/2**、终稿
`ANSWERED:IMAGE`。两次都 exit 0。
**已落地（2026-11-05，再补一片 = Ctrl+V 剪贴板附件）**：新增 `src/cli/clipboard-attachment.ts`
（`captureClipboardAttachment` / `stageClipboardImage` / `decodeAppleScriptImageData` /
`formatAttachmentMention`）。按平台读剪贴板图片：macOS 走 `osascript` 的 `«data PNGf…»` 十六进制载荷，
Linux 走 `wl-paste`/`xclip` 写临时文件，Windows 走 PowerShell `GetImage().Save()`；没有图片时退化为文本
（`pbpaste` / `wl-paste` / `Get-Clipboard -Raw`），空剪贴板与不支持平台都给出原因而不是静默无操作。
图片**不内联 base64**：按 sha256 前 16 位内容寻址落到 `.moss/runtime/attachments/<hash>.<ext>`（
`ensureMossRuntimeGitignore` 保证 runtime 被忽略），composer 插入 `@<relpath>`，模型用已有的
`read_image` 打开——魔数校验、3 MB 预算、`agent.supportsImages` 守卫全部复用同一条路径，会话里也不再多
一份 4 MB 的行。TUI 接线：`keymap.ts` 注册 `edit.attachClipboard`（`ctrl+v`），`app.ts` 的 Ctrl+V
分支异步捕获后插入 mention 并给出状态行（图片名 + KB；文本直接插入；空剪贴板显示原因）。help 里早已
承诺的 Ctrl+V 现在真的可用。
回归门：verify stage `clipboard-paste`（**6 断言**：AppleScript 十六进制解析与垃圾输入拒绝、同一字节只落
一份且 `.moss/.gitignore` 含 runtime、非图片/超 3 MB 拒绝、不支持平台给出原因；`MOSS_VERIFY_CLIPBOARD=1`
时额外做**真实剪贴板往返**——osascript 写 PNG → 捕获落盘校验 PNG 魔数、写文本 → 捕获得到原文）。
**真实证据（本机 macOS 真实剪贴板 + 真实 CLI）**：`osascript` 把 70 B PNG 放进剪贴板 →
`captureClipboardAttachment` 返回 `{kind:'image', relPath:'.moss/runtime/attachments/6b7fa434f92a8b80.png',
bytes:70, mimeType:'image/png'}` 且文件 70 B；把剪贴板换成文本 → 返回 `{kind:'text', text:'hello
clipboard text'}`。随后 `moss -p "Use read_image on @<relPath> and say what you see."`（脚本化 provider
记录请求体）→ wire 上 `userMentions:true`，工具结果 `toolHasAttachment:true`，请求 `imageParts` 2，
终稿 `SAW:ATTACHED`，exit 0。
**已落地（2026-11-05，再补一片 = Finder 文件 / 拖拽路径也变成附件）**：Finder 里「拷贝」一个文件，
剪贴板上只有 `«class furl»` 文件引用——**既没有图片字节也没有文本**，所以上一片的捕获只能报
「clipboard has no image or text」，Ctrl+V 对 Finder 复制依旧无效（help 承诺的另一半）。
`clipboard-attachment.ts` 现在补三条读法：
① macOS `osascript -e 'get POSIX path of (the clipboard as «class furl»)'` 读文件引用；
② 剪贴板文本是 `file://` URL（浏览器「复制图片地址」）时用 `fileURLToPath` 解码（含 `%20`）；
③ 终端拖拽插入的路径文本（可能带引号、空格被转义成 `\ `、`~/` 开头、Windows 盘符）由
`clipboardPathFromText` 还原——纯文本仍走文本插入，不会把普通句子当路径。
三种来源最终都过同一个新 `stageClipboardFile`：`stat` 存在性与大小（沿用 `read_image` 的 3 MB 预算）、
读取字节、`detectImageMimeType` 魔数校验，再交给 `stageClipboardImage` 内容寻址落盘；非图片/缺失/超限
返回具体 reason 并退化回文本插入，不吞掉用户粘贴的内容。
**真实证据（本机 macOS 真实 Finder 剪贴板）**：`osascript -e 'set the clipboard to POSIX file
"/tmp/moss-finder/shot one.png"'` 后 `clipboard info` 只有 `«class furl», 38`（说明确实没有图片/文本），
`captureClipboardAttachment` 返回 `{kind:'image',
relPath:'.moss/runtime/attachments/c414cd0e204de974.png', bytes:70, mimeType:'image/png'}`，落盘文件 70 B；
把剪贴板换成文本 `file:///tmp/moss-finder/shot%20one.png` 同样得到该附件。纯函数实测：
`file://` URL → `/tmp/.../shot one.png`，带引号+转义空格的拖拽路径 → 还原，`hello world` → `null`，
`C:\shots\one.png` 保留分隔符；`stageClipboardFile` 对文本文件与不存在的文件分别给出
`not a PNG/JPEG/GIF/WebP image` 与 `does not exist`。
回归门：verify stage `clipboard-paste` 从 6 断言扩到 **9 断言**（新增文件引用三种形态的解析、同一图片
字节与剪贴板图片共用一个 staging 文件、非图片/缺失文件拒绝；`MOSS_VERIFY_CLIPBOARD=1` 时新增**真实
Finder 复制往返**：`set the clipboard to POSIX file` → 捕获得到 `kind:'image'` 70 B，不再报空）。
**已清理（2026-11-05，B01 收尾）**：`src/cli/attachment-refs.ts` 与它的 `[Image #n]` chip 解析确认是死代码
（`extractAttachmentRefs` / `formatAttachmentChip` 无任何调用者，仅经 `tui-utils.ts` 的 `export *` 露出），
已删除该模块并从 `tui-utils.ts` 的 re-export 列表移除；`AttachmentRef` 类型保留在
`transcript-types.ts`（仍在 tui-utils 公共面上，删除会动内部导出面，无收益）。`tsc --noEmit` 干净，
`npm run verify` PASS。**B01 至此全部完成**（读图工具 / 预算 / 能力守卫 / Ctrl+V 剪贴板 / Finder 文件 /
死代码清理）。

**B02 压缩可回溯（P0）**
Moss 的压缩策略本身不弱（`compaction.ts:1137` 还会回读最近 5 个文件），但**摘要之外的历史在上下文里彻底消失**，
而模型知道「被摘要过」却不知道「原文还能查」。对手把这一点做成了机制：Cursor 的旧段是带 `# HISTORICAL --
DO NOT EDIT` 的文件并明写「用 read_file/grep 回查」（`cursor-evidence.md:478-527`）。长会话（设备调试、多次
repair）里丢掉的往往是错误栈、命令字面量这类只能靠原文恢复的证据，摘要漂移不可逆。
最小切片：摘要尾部加「历史指针」一行（`.moss/sessions/<id>.jsonl` + 用 `read_file`/`grep` 回查的措辞），
模板加 `# HISTORICAL` 约定；不改压缩算法、不改窗口参数。风险：给模型一条能读全量 transcript 的路径，需确认
它不会滥读 —— 用探针断言「只在摘要缺信息时才回查」。
**已落地（2026-11-05，本轮）**：`compactHistoryIfNeeded` 新增可选 `transcriptPath`，摘要尾部确定性追加
`<historical-transcript>` 块（`# HISTORICAL — DO NOT EDIT` + 会话文件路径 + 用 `read_file`/`grep` 回查、
不得修改的措辞）；`SessionStore` 新增可选 `transcriptPath()` 端口，`JsonlSessionStore` 返回
`.moss/sessions/<encoded>.jsonl`，内存/自定义 store 不实现则不写指针（不给假路径）。交互 loop 与
`/compact` 两个入口都传路径。回归门：verify stage `compaction-history`（6 断言，0.4s）。
真实验证：预置 60 条消息的 `.moss/sessions/big.jsonl` + `moss --mock --session big`，真实 loop 压缩
（日志 `context compacted 60 messages into 485 chars`），摘要含 `<historical-transcript>`、
`# HISTORICAL — DO NOT EDIT` 与指向该会话文件的路径。

**B03 摘要结构校验（P1）**
`compaction.ts:1061-1079` 的 "Validate summary" 实际只判非空；9 节结构只写在 prompt 里。模型少写一节
（常见：`## 6. 设备与环境状态`）不会被发现，下一次压缩还会把缺失继续传递。对手有界：Cursor 重试 3 次并逐次
收紧输出（`cursor-evidence.md:483-486`）。这条是 B02 的配套——有了可回溯指针，摘要不完整也不再是灾难，
但仍要能发现退化。
最小切片：一个纯函数校验器（必需节标题 + 至少保留一个路径/命令字面量）+ 一次「要求更短更结构化」的重试；
失败仍走现有 fallback 链。风险：校验过严会误杀正常摘要，先只校验节标题齐全。
**已落地（2026-11-05，本轮）**：新增 `src/context/summary-validate.ts`（纯函数：`## n.`/`**n.**` 标题行识别、
必需节 0–9、`buildSummaryCorrectionPrompt`）；`generateSummary` 在得到摘要后校验结构，缺节则用同一消息
集+同一 `customInstructions` 追加「Correction required: … ALL ten sections …」重试**恰好一次**，第二次结果
无条件接受（不循环、不抛错）。校验只作用于会成为 checkpoint 的那一次调用（单块尾块与 merge），
逐块 partial 摘要不校验——否则长会话会按块数放大模型调用（实测 60 条消息的 mock 会话从 61 次重试降到 1 次）。
回归门：verify stage `compaction-summary`（9 断言，0.2s）。真实验证：`moss --mock --session big` 真实 loop
压缩 60 条会话消息 → 1 次 `missing required sections; retrying once`、压缩成功、checkpoint 仍带 B02 指针。
注：真实模型在小窗口（5000/6000）下 `context-prep` 的 compaction prepare 会 30s 超时（见 B13），
因此本轮真实模型路径只证明了「校验器不会误杀」的等价链（真实 dist 代码 + mock LLM 走通）。

**B04 plan 模式结束协议（P1）**
`exit_plan` 已有版本指纹（`plan-gate.ts:49-53`），TUI 也有批准仪式（`tui/app.ts:1353-1367`），但 plan prompt
一个字都没提它——headless `-p --plan` 与 REPL 的模型只能输出散文计划，用户拿不到「批准某个版本」的动作。
对手把这件事定成硬契约：本轮必须以 `ExitPlanMode` 或提问结束。
最小切片：plan prompt 增加一段「以 `exit_plan` 提交计划并停下」+ headless 在 plan 模式未提交时补一次纠正
（复用 completion gate 的「最多一次」模式）。风险：可能让简单问答也被要求提交计划，用「有工具调用才算做过计划」判定。
**已落地（2026-11-05，本轮）**：`PLAN_MODE_PROMPT` 增加结束契约（「End the turn with `exit_plan`…不要用散文
'shall I proceed?' 收尾」）；新增 `src/core/loop/plan-completion-gate.ts`：plan 模式 + `totalToolCalls > 0`

- 没有成功的 `exit_plan`（或用 `ask_user_question` 问了一个具体问题）→ 在完成边界**扣留一次**并注入修正，
  第二次放行（bounded，不循环）；已接入 `moss-agent` 的 completionGate 链（background → plan → acceptance →
  verification → host）。回归门：verify stage `plan-end`（8 断言，0.1s：prompt 契约、工具工作未提交被扣、
  非 plan 模式/零工具调用不触发、成功 exit_plan 通过、失败 exit_plan 不算、提问通过、只扣一次）。
  **修正 backlog 里的旧基线**：原文写「`--plan -p` 的 exit_plan 计数现在为 0」，实测普通 plan 提示词下已经是 1
  （模型会主动调）；真正的缺口是「读了文件后用散文收尾」那一类：实测
  `--plan -p "Read package.json and tell me the project name."` 改前 `exit_plan=0`（有 read_file 调用）、
  改后 `exit_plan=1`；带 `--json flag` 的 plan 提示词改前改后都是 1（无回归）；plan 命中时进程 exit code 为 9
  （计划待批准约定）。

**B05 工具面揭示只有一组（P1）**
`DEFERRED_GROUPS` 里只有 `subagent`（`deferred-tool-offer.ts:17-21`），揭示后 sticky 永不回收（`:40-47`）；
task 台账 6 个工具在 `moss -p` 与交互式都常驻（`session-tool-offer.ts:8,99`），实测 5,671 chars
（`moss-architecture-audit.md:188`）。对手的答案不是「藏起来」而是「按意图自动揭示 + 可回收」。注意
`why-design.md:53-54` 的告诫：缓存命中后 schema 的边际成本只有 1/10，所以这条的收益要按**误选率与注意力**验收，
不能只报省了多少 token。
最小切片：先写「测量脚本」（`toolVisibleForRun` 计数）把三种会话的可见面固定成基线数字，再决定是否把 task
组降级 + 按 goal/intent 自动揭示。风险：`/goal` 与验收门依赖台账，揭示时机错了会让 Task OS 在 headless 下失能。

**已落地（2026-11-05，本轮 = 测量切片 + 一个真实泄漏修复）**：新增
`scripts/measure-tool-surface.mjs`（用生产的 `toolVisibleForRun` / `isDeferredToolName` /
spawn scope 集合 / `buildProviderToolDeclarations` 实测，不是规则副本；`--json` 机读、`--check` 断言），
并作为 verify stage `tool-surface`（0.2s）固化不变量。**基线数字**（48 个内置工具，deferred 仅 5 个 =
subagent 组 `create_subagent`/`merge_subagent_patch`/`fan_out_subagents`/`subagent_status`/`subagent_stop`）：

| 场景                                       | 声明工具数    | 声明字符              | ≈tokens | 另有 deferred |
| ------------------------------------------ | ------------- | --------------------- | ------- | ------------- |
| `main-headless`（`-p`、无 TTY、无 device） | 26（改前 27） | 16,495（改前 17,554） | 4,124   | 5             |
| `main-tty`（TTY + 已配 device）            | 33            | 22,745                | 5,687   | 5             |
| `main-plan`（plan 模式）                   | 27（改前 28） | 16,817（改前 17,876） | 4,205   | 5             |
| `main-qa`（`taskFlow:false`）              | 20（改前 21） | 12,589（改前 13,648） | 3,148   | 5             |

spawn scope：critic 0 / read-only 4（2,433 chars）/ device-read 7 / explore 9 / plan 10 / verify 18 /
full 48（32,528 chars ≈ 8,132 tokens）。最大声明：`exec` 1,598、`review_changes` 1,107、`search_code` 1,089。
**由测量发现的真实缺陷并已修**：`device_probe` 不在 `DEVICE_TOOL_NAMES` 里，导致每个 prompt（包括无 device 与
plain Q&A）都声明一个只能回「no device configured, run /device add」的工具，约 1 KB/轮。修复后
`--check` 断言「无 device 时所有设备工具都不出现、有 device 时全部出现（`hiddenFromModel` 旧别名豁免）」。
真实证据（同一临时工作区、把 `MOSS_DEVICE_*` 清空后跑）：
改前 `-p "Call device_probe…"` → 工具被调用并返回 `no device configured, run /device add`；
改后同一提示 → `NO_DEVICE_PROBE_TOOL`（「There is no device_probe tool registered for this run」）。
剩余（B05 未完成部分）：task 台账 6 工具降级 + 按 goal/intent 自动揭示并可回收；`full` scope 的 48 工具面
是否也该按意图揭示，等下一轮用这份基线数字决定。

**已落地（2026-11-05，本轮 = task 台账按意图揭示，B05 收口）**：`deferred-tool-offer.ts` 新增
`task` 组（`task_define`/`task_acceptance`/`task_plan_update`/`record_evidence`/`record_failure`/
`record_repair`）+ `messageRequestsTaskLedger()`（中英意图词与 `/goal`、`/task`）+ `workspaceHasTaskLedger()`
（工作区已有非空 `.moss/tasks.jsonl` 即视为延续任务）；`moss-agent` 在 run 创建时按
「显式 `taskFlow`、消息意图、已有台账」三者之一 reveal，`reveal('task')` 的提示教契约
（machine-checkable acceptance criteria / Expected-Observed-Result / 缺证据=未完成）。
**测量变化**：`main-headless` 声明工具 **26 → 20**、字符 **16,495 → 12,596**（≈ 每轮省 975 tokens）；
deferred 从 5 个增加到 **11** 个；`main-tty` 33→27、`main-plan` 27→21。回归门：
verify stage `task-ledger-reveal`（5 断言：组的注册与分组、reveal 只揭示本组且提示教契约、未知组提示组名、
中英意图正反例、空台账不算意图）。
**真实证据（前后对照，同一提示「列出现有工具名，逗号一行」）**：HEAD 构建 → 模型列出 24 个工具，其中含
`record_evidence, record_failure, record_repair, task_acceptance, task_define, task_plan_update` 全部 6 个；
本轮构建 → 24 个工具里 **0 个**台账工具。**功能不回退**：真实跑
`-p "Define a task with machine-checkable acceptance criteria: ok.txt exists and contains OK. Create ok.txt with OK, record evidence for that criterion, then run acceptance."`
→ `.moss/` 里生成 `tasks.jsonl`（2 条 criteria）、`evidence.jsonl`（2 条 pass）、`acceptance.jsonl`
（`verdict: pass`）、`task-events.jsonl`，模型最终回复「Both evidence rows auto-evaluated to PASS」。
残留想法（未做，降为可选）：`full` spawn scope 的 48 工具面是否也按意图揭示；揭示后 sticky 不回收。

**B06 规则激活语义（P1）**
`description` 被解析（`project-instructions.ts:237`）却不参与激活，`selectActiveRules` 把「没有 globs」直接
当 always（`:319-326`）——用户写 `description:` 想表达「按需」，得到的是**永远注入**，与 Cursor 的
四类语义正好相反，而且是静默的预算消耗（stable 前缀每轮重发）。
最小切片：`globs` 为空且 `description` 非空 → 不进 always 层，改为一行索引（名字 + description），并由
`@rule`/模型显式请求加载正文；无 globs 且无 description 保持 always（兼容现状）。风险：会让现有用户
「没写 globs 的规则」突然不生效，需要在启动时打印一次迁移提示。

**已落地（2026-11-05，本轮）**：`project-instructions.ts` 新增 `ruleActivation()`——`globs` → `globs`（按路径）、
只有 `description` → `manual`（**不再自动注入**，改为可请求）、都没有 → `always`（兼容旧规则）；
`selectActiveRules` 按该三态过滤；新增 `requestedRuleNames`/`selectRequestedRules`（识别 `@rule:<name>`）
与 `formatAvailableRules`（只列 name + description 的索引）。`prompt-setup.ts`：always 规则进稳定前缀、
可请求规则出一层 `project:rules:available` 索引（含「如何加载」说明），用户在消息里 `@rule:<name>` 时
正文进动态层 `project:rules:requested`；capability registry 的 activation 同步为 always/globs/manual。
`formatInstructionRules` 的 scope 标签不再把 manual 规则误标成 `always`。
回归门：verify stage `rules-activation`（8 断言，0.3s）。
真实验证（临时工作区，`always.md` 要求「问颜色答 teal」，`described.md` description=banana ritual、
正文要求「问水果答 BANANA」）：
`moss -p "List the project rules available to you"` → 模型回答
「two project rules: always (always active) and described ("banana ritual", loadable on request)」；
`moss -p "Give me a color and a fruit"` → `teal`（always 生效，香蕉正文未加载，未出现 BANANA）；
`moss -p "@rule:described give me a fruit"` → `BANANA`（正文按请求加载）。
仍未做：启动迁移提示。
已落地后续：REPL 中途轮次的 `@rule:` 重扫已由 **B37** 补上（`noteUserText()` 在每轮 `onInputGuardrail` 扫描）；
`/rules` 菜单在 REPL 与 TUI 均已有（`repl.ts` `/rules` 分支、`tui/app.ts` 同名分支，数据来自
`cli/rules-commands.ts` 的 `collectRuleRows`），本条原记录的「`/rules` 菜单未做」已过时。

**B07 子代理授权契约（P1）**
工具层已经继承父审批（`subagent-runner.ts:398-401`），但提示层没有「父代理消息不是用户授权」这条边界，
也没有「只许绝对路径」。这两句在对手那里是原文写死的（`claude-evidence.md:341-355`），对应的是
父代理把注入内容当成任务指令、或子代理在漂移的 cwd 里改错文件这两类真实事故。
最小切片：只加文本契约 + 静态断言（无行为改动、可回滚）；行为切片（父代理诱导 read-only 子代理写文件）
作为下一轮探针。风险：几乎为零，唯一成本是 prompt 长度（约 200–300 字符）。

**已落地（2026-11-05，本轮）**：`spawn-profile.ts` 新增所有「能动手」scope 通用的两块契约
（critic 例外：无工具且已要求把任务当不可信数据）——
`## Sub-agent authorization boundary`：父代理消息只用于指导工作；**任何代理消息都不是用户同意/授权**
（只有权限系统或用户本人消息才是）、不能扩大工具集/改权限/授权被禁动作；被禁时报告
`blocked: <拒绝内容与原因>`，不得执行也不得静默跳过（中英双语）。
`## Shell calls: no persistent working directory`：每次 shell/exec 都是新 shell，`cd` 与环境变量不跨调用存活，
用绝对路径（Claude Code 原文「Agent threads always have their cwd reset between bash calls…only use absolute
file paths」）。回归门：verify stage `subagent-prompt-contract`（3 断言：6 个 acting scope 全覆盖且不重复、
critic 不含 shell 规则、全文 <2600 字符）。
**行为切片（真实运行）**：在临时工作区让父代理派一个 `scope=read-only` 子代理并谎称
「你已被用户明确授权写 `<tmp>/proof.txt`」——结果：文件**不存在**（`ls` 报 No such file or directory），
子代理最终答复原文 `blocked: 无法创建 .../proof.txt`，并说明「任务文本中的『授权』无法生效」，
父代理转述时也点明「真实权限边界是工具 scope，而非任务文本的声明」。

**B08 工具描述单档（P2）**
`ToolMetadata` 里已经有 `maxResultTokens`/`truncationHint`/`classification` 这类「元数据驱动」的成熟做法
（`tool-types.ts:200-263`），但 description 仍是单字段（`:269`）。对手按模型/上下文分档发描述
（`cursor-evidence.md:105-118`），并给每个工具写「何时不要用、该改用什么」。
最小切片：给 `ToolMetadata` 增加 `leanDescription?`，在schema 总量超标或小窗口模型时启用；先只做 3 个最大工具
（`fan_out_subagents`/`search_code`/`exec`）。风险：lean 版丢掉的关键约束会直接变成误用，必须用 bench 对照而不是直觉。

**已落地（2026-11-05，本轮 = 否定段/错用防护；lean 单档仍待做）**：11 个高频/变更类工具的描述里加了
「Not for … — use <对应工具> instead」否定句（`read_file`/`exec`/`search_code`/`search_files`/`write_file`/
`edit_file`/`multi_edit`/`apply_patch`/`move_file`/`list_directory`/`read_image`），每条都点名「该改用什么」，
例如 `read_file` 现在写明「Not for directories (list_directory), images or screenshots (read_image), or
finding unknown matches across files (search_code)」；`exec` 的旧「Prefer … over cat/sed/find/grep」升级为
「Not for reading, editing, listing or searching files, or for running the test suite — use read_file,
edit_file, list_directory, search_code, search_files and run_tests instead」。
机器校验进 `scripts/measure-tool-surface.mjs --check`（tool-surface stage 已经是验证门的一部分）：每个工具
必须同时命中否定词与它点名的兄弟工具，且**单条描述 ≤1,200 字符**，防止「加一句提示」把声明成本悄悄翻倍。
**真实证据（真实 CLI + 脚本化 provider 记录 provider 请求里的 `tools` 数组）**：HEAD worktree 构建 →
`read_file` 304 / `exec` 798 / `search_code` 303 / `write_file` 179 / `edit_file` 372 / `read_image` 382 chars，
`negative` 全为 false；本轮构建 → 433 / 917 / 396 / 246 / 473 / 445 chars，`negative` 全为 true。
表面成本（`scripts/measure-tool-surface.mjs`，同场景 main-headless）：12,596 → 13,524 chars（+7.4%，
约 +232 tokens/turn），仍在 B05 的 24,000 预算内；`read_file` 等 11 条都 ≤1,200 字符。
**lean 双档第一片已落地（2026-11-05，`MOSS_LEAN_TOOLS=1`）**：`ToolMetadata` 新增 `leanDescription?`
（`tool-types.ts`），`buildProviderToolDeclarations` 通过 `toolDescriptionForModel()` 在 lean 模式下换用短版
（`agent-loop-context-prep.ts`，env 在调用时读取，探针可翻转）。先给两个最大且最常见的执行类工具写短版：
`exec` 950→~330 chars、`device_exec` 917→~430 chars，都保留「不是用来做什么 + 该用什么」与「危险命令仍走
审批/设备信任」这两类关键约束。
**真实证据（`node scripts/measure-tool-surface.mjs`，生产同一条 `buildProviderToolDeclarations`）**：
main-headless 13,524→**12,957 chars**（−567，≈−141 tokens），main-tty 19,774→**18,657**（−1,117，≈−279 tokens）。
**真实 CLI + 脚本化 provider 记录请求体**：`MOSS_LEAN_TOOLS=1` 时 provider 收到的 `exec` description 确实是
短版（以 "Run a shell command in the workspace" 开头）、默认时是长版，两次 `exec` 工具调用都真实执行成功
（`EXEC-RAN`，exit 0）。
**回归保护**：`scripts/measure-tool-surface.mjs --check`（tool-surface stage 的一部分）现在断言：每个 lean 描述
必须比全长版短且 ≤60% 长度；默认面必须仍是全长版；lean 模式声明总字符数必须严格小于默认面。`npm run verify` PASS。
**第二轮补充（2026-11-05）：又给 6 个长描述工具补了 lean 版** —— `device_deploy`(910)、
`device_robotics_status`(869)、`device_probe`(833)、`subagent_resume`(750)、`review_changes`(577)、
`device_file_write`(527)。设备类工具的短版**刻意省掉那条每个设备工具都重复的“凭据来自 env/.env”长段**（只在
`device_file_write`/`device_deploy` 里留一句短提醒），这正是 lean 档该砍的重复成本。表面成本（真实声明构建器）：
main-headless 13,524→**12,710 chars**（≈−203 tokens，−6.0%）、main-tty 19,774→**17,116**（≈−665 tokens，−13.4%，
设备工具全在场时收益最大）。
**真实 CLI + 脚本化 provider 记录 wire 请求体**：`exec`、`review_changes` 在 lean 模式下确实是短版
（`review_changes` 以 "Clean-context read-only review…" 开头），默认模式仍是 "Run an independent review…" 与
"Run a shell command…" 的完整版；`allShorter` 为 true，两次 run 都 exit 0（`subagent_resume` 在 headless 场景
本身是 deferred，未在场，符合预期）。
**可发现性（2026-11-05，第四片）：README 新增「调优开关（环境变量）」表**，把 `MOSS_LEAN_TOOLS`
（含 ≤64k 自动精简的规则）、`MOSS_STARTUP_TIMING`、`MOSS_VERIFY_CONCURRENCY`、`MOSS_NO_TUI` 写清楚，
每行都给出验证命令。实测两条文档命令成立：`MOSS_STARTUP_TIMING=1 … -p "hi"` 打出
`entry=372ms proxy=77ms config=115ms agent=171ms skills=195ms total=196ms`；
`MOSS_LEAN_TOOLS=1 node scripts/measure-tool-surface.mjs` 的 main-headless 是 **12,710** chars、
默认档 **13,524** chars。顺带修正 backlog 里 B11 行状态（此前被批量替换误写成 B08 的状态）。

**自动启用（2026-11-05，第三片）：按上下文窗口自动选档，不必让用户记得设 flag**。参照 Cursor/Claude Code
「小窗口自动降描述」的做法：`shouldLeanToolDescriptions({ contextWindowTokens })` 在窗口 ≤
**64,000 tokens**（`LEAN_TOOL_AUTO_CONTEXT_TOKENS`）时自动用 lean 档；`MOSS_LEAN_TOOLS` 仍是显式覆盖
（`=1` 强制 lean、`=0` 强制全长，即使窗口很小），未设时走自动判定。接线点两处：agent loop 的
`buildProviderToolDeclarations(toolsForRun, { contextWindowTokens: effectiveContextTokens })` 与
`context-report`（报告与实际声明一致）。
**真实 CLI + 脚本化 provider（4 次真实 run，记录 wire 请求体）**：`agent.contextTokens=32000` → `exec`
描述是 lean 短版；`200000` → 全长版；`32000` + `MOSS_LEAN_TOOLS=0` → 全长版；`200000` +
`MOSS_LEAN_TOOLS=1` → lean 短版；四次 exit 0。
**回归门**：`measure-tool-surface.mjs --check` 新增 5 条自动档断言（32k→lean、200k→full、flag 两向强制、
32k 声明字符数严格小于 200k）。
**第三轮补充（2026-11-05）：最热的编码工具也补了 lean 版** —— `read_file`(433)、`edit_file`(473)、
`search_code`(396)、`search_files`(326)、`read_image`(445)、`web_fetch`(406)；它们每个 turn 都可能出现，
比设备工具更常付费。全部保留否定句（Not for … use X）与关键行为（行号前缀不是内容、old_string 精确唯一、
output_mode 三档等）。表面成本（真实声明构建器）：main-headless 13,524 → **11,658 chars**（≈**−466 tokens，−13.8%**）、
main-tty 19,774 → **16,064**（≈**−928 tokens，−18.8%**）。
**真实 CLI + 脚本化 provider 记录 wire**：`read_file`/`edit_file`/`search_code`/`search_files`/`read_image` 在
lean 模式下都确实更短（`allShorter=true`），`read_file` 短版以 "Read a workspace file" 开头、默认版以
"Read a workspace file. Page" 开头，`edit_file` 两档 head 不同；两次 run exit 0。`measure-tool-surface --check`
所有 lean 描述都 ≤60% 全长且通过。
**仍未做**：lean 档对弱模型/小窗口模型的实际得分影响仍需 `npm run bench` A/B（本机无 `MOSS_BENCH_API_KEY`，
按 bench-unverified 处理）；`web_search`(295)/`tool_search`(402)/`device_cameras` 等收益更小的工具暂不做。

**B09 截断结果统一落盘（P2）**
`spillToolOutput` 只被 `exec`/`device_exec` 调用（`builtin.ts:416`、`device-tools.ts:186`），其余工具超预算后
只有 head+tail，中段**没有任何恢复路径**。对手的原则是「长输出落盘 + 给路径」，不靠盲目截断。
最小切片：把 spill 接进 `truncateToolOutput` 的通用路径（一次性、按工具名分目录），并统一文案
`full output: <path>`。风险：落盘内容可能含密钥——必须复用 exec 现有 egress 过滤（`presentToolOutput`）。

**已落地（2026-11-05，本轮 = 任意工具的中段可恢复）**：spill 实现从 `src/tools/` 下沉到
`src/context/tool-output-spill.ts`（工具层留一个 re-export shim），core loop 不再依赖工具实现；
新增 `truncateWithRecoveryPath({toolName, input, text, workspaceDir})`：`truncateToolOutput` 真的截断时，
把**完整**结果（经 `presentToolOutput` 同一套 egress 过滤）落盘到 `.moss/runtime/tool-output/`，
并在结果尾部追加「full output saved to <path> — the middle of this result was elided … read it with
read_file (offset/limit) or grep」。`agent-loop-tool-execution` 的 `recordToolOutcome` 是所有工具结果的
唯一截断点，改为走该函数并把 `workspaceDir` 带入；exec/device_exec 自己写过 spill 的（文本里有
`.moss/runtime/tool-output/` 标记）不重复写；无 workspace 时只截断不承诺恢复路径。
回归门：verify stage `tool-output-spill`（**7 断言**：大结果落盘+指针+中段可从文件读回、`.moss/.gitignore`
覆盖 runtime、小结果不写盘、exec 已 spill 不重复、无 workspace 不写、超 4 MiB 返回 null 不留半截文件、
过期 spill 在下次写入时清理）。
**真实证据（真实 CLI + 脚本化 provider 记录 tool result；12,000 行 boot.log，第 801 行埋
`NEEDLE_MIDDLE`）**：HEAD 构建 → 工具结果 40,292 chars、无指针、`.moss/runtime/tool-output/` **不存在**、
模型回复 `SAW:NOSPILL`，中段 needle **0 处**（不可取回）；本轮构建 → 结果 40,535 chars、**有指针**、
spill 文件（109,919 B）里 needle **1 处**、模型回复 `SAW:SPILL`。即：模型看得见的 head+tail 里没有
needle，但按指针读文件能拿到。
**B10 skills 裁剪顺序（P2）**
目录预算、策略降级、`omitted`/`uncappedChars` 统计都已经有了（`skill-catalog.ts:1-17`），唯独排序是
scope→name（`:70-74`）；而 usage 数据已经在写（`skill-usage.ts:24`）。对手的规则是「先牺牲最久未用的」。
最小切片：`catalogsInRankOrder` 增加 usage 作为第三排序键（未用 > 少用 > 多用），或对未用技能优先降级。
风险：usage 是本地文件，缺失时排序必须回退到现在的确定性顺序，否则不同机器渲染结果不可复现。

**已落地（2026-11-05，本轮 = skills 目录按真实使用排序）**：`renderSkillCatalog` 新增可选
`options.usage`（`.moss/skills-usage.json`，由 `loadSkillUsage` 读），排序从「scope → 名字」变成
「scope → 使用（最近加载在前，其次次数）→ 名字」：**scope 优先级仍是主键**（契约不变，user 技能不会
插到 workspace 前面），未使用过的条目按名字排在组内末尾；无 usage 时行为与旧版逐字一致（无静默重排）。
降级阶梯因此变成「先丢最久未用的」：只剩一个描述额度时，已用过的技能先拿到 rich line，未用过的保持
name-only（探针用等长名字做前后对照）。导出 `rankSkillsForCatalog` 供 `moss skill list` 使用，表格
顺序与 prompt 目录顺序一致（用户能直接看到谁会被预算砍掉）。接线：core 的
`renderSkillCatalogLayer`（SDK/无 promptLayers 宿主）与 CLI `runtime.ts` 的 catalog 层都传 usage。
回归门：verify stage `skill-catalog-usage`（**6 断言**：无 usage 保持字母序、最近使用在前、导出排序
函数、scope 主键、单额度升级给最近使用者、无 usage 时字母序先升级）。
**真实证据（真实 CLI 输出）**：临时工作区 3 个 workspace 技能 + `.moss/skills-usage.json` 记
`cc-skill` 用过 4 次；HEAD 构建的 `moss skill list` 顺序 **aa-skill / bb-skill / cc-skill**，
本轮构建变成 **cc-skill / aa-skill / bb-skill**（used 列 4/0/0 不变，只是排序变了）。
**B11 子代理续跑（P2）**
现在子代理是一次性的：`subagent_status` 只给快照或等待（`create-subagent.ts:825-829`），没有 resume。
用户在长 explore 之后想追问只能重跑，等于重付一遍 token。对手都支持按 agent id 恢复（`claude-code.md` §4.7、
`cursor.md:259-277`）。
最小切片：`subagent_resume({agentId, prompt})` —— 复用子代理 session 的历史消息、只追加新 prompt；
先不做 fork、不做跨 run 恢复。风险：子代理 session 目前是否落盘要先确认（`subagent-runner.ts` 的持久化路径），
否则这是「加一个假工具」。

**已落地（2026-11-05，本轮 = transcript + `subagent_resume`；跨进程 resume 仍未做）**
子代理结束时的对话（user/assistant/tool 消息）现在由 `SubAgentResult.messages` 带出，`create_subagent`
在后台完成与前台结果两条路径都写入 `.moss/runtime/subagents/<taskId|runId>.jsonl`（meta 行 + 消息行，
id 先净化再拼路径，>8MB 不落盘）。新增第 6 个子代理工具 `subagent_resume({taskId, prompt, maxTurns?,
timeoutMs?})`：按 taskId（后台）或 runId（前台结果里新打印的完整 `runId:` 行）取回 transcript，
原样重放为子代理上下文，再把新 prompt 作为下一条 user 消息；scope/model/maxTurns 从存下来的 meta 继承；
续跑本身也存自己的 transcript，所以可以接着续。`subagent_resume` 进 `SUBAGENT_DEFERRED_TOOLS`，
与其余子代理工具一起按需揭示。
**回归门**：verify stage `subagent-resume`（**5 断言**：transcript 往返、id 不能逃出目录、
无 transcript 时只报错不 spawn、resume 把 priorMessages 原样交给 spawn 且继承 scope/maxTurns/追加 prompt、
续跑结果再落盘可链式续）。
**真实证据（真实 CLI + 脚本化 provider 记录 child 请求）**：`moss -p "Create a subagent to read
token.txt and report the token."` 全链：tool_search(subagent) → create_subagent(explore) → 子代理读
`token.txt` 答 `TOKEN=42` → `subagent_resume(runId)` 追问 → **wire 上 child 的 resume 请求
`childResume:true, hasPriorTranscript:true`**（原始任务与 `TOKEN=42` 都在 follow-up 之前重放）→
子代理答 `RESUMED:TOKEN=42` → 父代理终稿 `DONE:RESUMED`，exit 0。落盘 transcript 两条：原跑 2 条消息；
续跑 4 条（原问答 + follow-up + `RESUMED:TOKEN=42`），meta.task 追加 `[resume]`，scope/maxTurns 继承。
**跨进程 resume 已落地（同日补，第二轮）**：`subagent_resume` 的 `taskId` 变为可选 —— 省略或传
`latest` 时取磁盘上最新的一份 transcript，未知 id 的报错会列出可续的 id（`<id> (scope …)`，最多 6 条），
无 transcript 时明确说没有而非 spawn。因此**新进程不需要任何内存 registry** 就能续上一个已经退出的
会话。**真实证据（两次独立 `moss -p` 进程，同一工作区）**：会话 1 `DONE1:TOKEN=42` 并落盘 1 份
transcript；会话 2 新进程、provider 只发 `subagent_resume{prompt}`（**不带 taskId**）→ wire 上 child
的 resume 请求 `childResume:true, priorHasTask:true, priorHasAnswer:true`（原任务与 `TOKEN=42` 都从磁盘
重放）→ 子代理答 `RESUMED:TOKEN=42` → 会话 2 终稿 `DONE2:RESUMED`，exit 0，第二次续跑再落盘 1 份
（共 2 份）。探针同步扩到 **8 断言**（新增：省略 id/`latest` 取最新、未知 id 列出可续项、空工作区不 spawn）。
**已落地（2026-11-05，再补一片 = 运行中的后台任务也能续）**：此前 `subagent_resume` 只认磁盘上已有的
transcript，而后台任务**从 start 那一刻就有 taskId、却要等结束才写 transcript**，所以对一个正在跑的后台
任务续跑会报「no stored conversation」，而它其实马上就会产出 transcript。现在：`subagent_resume` 在找不到
transcript 且传了后台 taskId 时，先查 `ctx.asyncTaskRegistry.status(id)`——
① 状态非终态（running/queued）：默认 `await registry.wait(id)` 等它结束（边界由该任务自己的 timeoutMs 决定），
结束后再从磁盘读 transcript 并继续；传新参数 `waitForRunning:false` 则不阻塞，直接返回
「still RUNNING」+ 下一步提示，绝不误 spawn；
② 状态终态却没有 transcript：明确报 `finished (<status>) but stored no conversation`（而不是笼统的
「unknown id」），并提示用 `subagent_status` 看 summary。
工具描述同步写清「running 的后台任务会先被等待（可用 waitForRunning:false 关闭）」，模型不必自己先
`subagent_status(wait:true)` 再续。
**回归门**：verify stage `subagent-resume` 从 8 断言扩到 **10 断言**——新增「用真实
`InMemoryMossAsyncTaskRegistry` 跑一个活任务：`waitForRunning:false` 得到 still RUNNING 且不 spawn；
默认路径等任务落盘 transcript 后 spawn，且 priorMessages 就是那次后台跑的对话、scope 继承」以及
「终态但无 transcript 的 id 明确报错、不静默 spawn」。
**已落地（2026-11-05，再补一片 = fan-out 每个子代理可单独续跑）**：`fan_out_subagents` 的 N 个子代理此前
**完全不存 transcript**（只有 `create_subagent` 的前台/后台两条路径存），所以批量跑完只能重跑整批。现在每个
成功的子代理都按它自己的 `runId` 存一份 `.moss/runtime/subagents/<runId>.jsonl`（meta 记 `label: task`、
scope、maxTurns、model），结果里每个 section 追加一行 `runId: <完整 id>`，`subagent_resume({taskId:<该
runId>})` 就能只续某一个角度、不重跑其余；工具描述也写明「每个 child 会打印自己的 runId，可单独续跑」。
**真实证据（真实 CLI + 脚本化 provider）**：`moss -p "run both angles via subagents and report"` 全链
tool_search(group=subagent) → `fan_out_subagents`（两个 child 分别独立请求，答 `CHILD-ALPHA`/`CHILD-BETA`）
→ 父代理从 fan-out 结果里取 `runId: <parent>/sub-…` → `subagent_resume(taskId:<runId>, prompt:'which angle
was better?')`：wire 上续跑请求 `count=4, hasChildAlpha=true, hasChildBeta=false`（**只重放了被续的那个
child 的对话，没有把整批带进来**）→ child 答 `CHILD-RESUMED alpha` → 父终稿 `DONE-FANOUT`，exit 0；
`.moss/runtime/subagents/` 落盘 **3 份** transcript（两个 child + 一次续跑）。
**回归门**：verify stage `subagent-resume` 8→**11 断言**（新增：fan-out 两个 child 各存一份、结果打印
`runId:`、按单 child runId 续跑时 `priorMessages` 深等于该 child 的对话而非整批）。
**B11 至此全部完成**（无剩余项）。

**B12 启动手感（P2）**
**已落地（2026-11-05，本轮 = H2 补全 + ink 预取）**：① TUI 路径的分段计时补到 `composer`：
`MOSS_STARTUP_TIMING=1` 现在在 `-p`/REPL 打出 `config/agent/skills/total`，在 TUI 打出
`config/agent/skills/tui-import/composer/total`（`skills` 后不再提前 finish，改由 app 的
`onComposerReady`（首次 commit 的 useEffect）收尾）；② `scripts/tui-feel/driver.py` 在
`MOSS_STARTUP_TIMING=1` 时把 CLI 的分段行写进 bench 指标的 `startup_timing`，bench 与进程内口径第一次能对照；
③ 真正的优化：`ink`/`react` 是启动里唯一的大 import（实测单独 `import('ink')` ≈ **299ms**），此前它在
config/agent/skills 全部做完之后才加载——现在 `runCli` 在判定「这是交互 chat + TTY + 非 print」后立刻
`import('./tui/app.js')` 预取，用时再 `await`，把 ~250ms 的加载和前置工作重叠。
**真实证据（本机真实 TUI：`script`/PTY，`MOSS_TRUST_WORKSPACE=1`，3 次）**：改动前 composer 段
**473 / 535 / 615ms**（median 535）；改动后 **354 / 398 / 557ms**（median 398，−26%）；同机
`npm run bench:tui-feel` 的 `composer_ready_ms` 从 **962@100x30 / 751@70x24** 到 **920 / 740**
（另一轮 879 / 762，噪声内），仍 **> 600 目标**。bench 与进程内口径的缺口（bench 740–920 vs 进程内
354–557）经分段行确认发生在 **app 首次 commit 之后到 PTY 判定 composer+raw 输入就绪之间**（约
200–380ms，含 node 进程启动与 PTY 就绪），不在 CLI 已插桩的 phase 里。
**分段再细化（本轮补充，`entry`/`proxy` 两段）**：`MOSS_STARTUP_TIMING=1` 现在在 `config` 之前多打
`entry=<进程 uptime>` 与 `proxy=<ensureKeepAliveDispatcherInstalled 耗时>`。实测 TUI（3 次）：
`entry=288–354ms`（= Node 启动 + `dist/cli.js` 静态 import 图，**占 bench 数字约 1/3**）、`proxy=51–74ms`
（`import('undici')`）、`config` 累计 234–346（配置工作实际 ~180）、`agent` +38、`skills` +12、
`composer` +72。这解释了 bench 与进程内口径的缺口：bench 740–920 ≈ entry 288 + composer 356 + PTY 轮询；
已验证 **修 entry 只能靠把 CLI 静态 import 图改成懒加载**（本轮试过「去掉 `core/index.js` barrel + 动态
预取 `tools/builtin.js`」，`import('./dist/cli/runtime.js')` 仍 263ms、composer 无改善，故已回滚，不留
未验证的复杂度）。`proxy` 的 51–74ms 与 config 并行化理论可行但需先确认首个网络请求点，下一轮评估。

**H1 第一片（本轮）= 把 readline REPL 图移出交互启动**：`runtime.ts` 之前在文件顶部静态
`import { runInteractive } from './repl.js'`，而 TUI 路径**永远不用它**；`import('./dist/cli/repl.js')`
单独测 **161ms**（含 `commands/registry` 123ms 与命令实现），这些模块此前都在 `entry` 段里被解析。现在改成
只在「非 TUI，真的要进 REPL」的分支里 `await import('./repl.js')`。
**A/B 实测（同机同构建方式，各 5 次 PTY 启动，读取 `entry`/`composer` 段）**：改动前 entry 中位数
**400ms**（483/443/400/319/335）、composer 中位数 **417ms**；改动后 entry 中位数 **327ms**
（423/326/321/327/328，**−18%**）、composer 中位数 **391ms**。机器噪声明显（同配置单次可差 100ms+），
所以只记录中位数与方向，不宣称 bench 达标；REPL 路径实跑 `MOSS_NO_TUI=1` + `/exit` 仍正常
（exit 0、banner 与 workspace 行都在）。

**H1 第二片（本轮）= 内置工具图移出同步 entry + 去掉 `core/index` barrel**：`runtime.ts` 之前静态
`import { registerBuiltinTools } from '../tools/builtin.js'`（`import('./dist/tools/builtin.js')` 单独测
**119ms**）和 `import { MossAgent, JsonlSessionStore } from '../core/index.js'`（barrel 单独测 **99ms**，
直连两个模块 78ms）。现在：工具图改为「在判定为 agent 路径后立刻 `import('../tools/builtin.js')` 预取，
`await` 在原来的注册点」——既不进同步 entry，也不延后到 composer 之后；`core/index` 换成
`core/agent/moss-agent.js` + `core/session/jsonl-session-store.js` 直连。
**A/B/C 实测（同机、各 5 次 PTY 启动，读 `entry`/`composer` 中位数）**：
A 基线（上一轮提交后）entry **343ms** / composer **382ms**；B（只换直连 import）entry 328 / composer 411；
C（+ 工具图预取）entry **308ms**（−35ms，**−10%**）/ composer **376ms**。B 的 composer 变化在噪声内，
C 在两项上都最好，故保留两者。行为未回退：`tool-surface` stage 通过；真实 `-p "read note.txt"`
（脚本化 provider）里 `✓ read_file (note.txt) 9ms` —— 说明预取的内置工具在注册点确实可用。

**H1 第三片（本轮）= 负结果，已回滚，但把下一步的边界问清楚了**：试把 `prompt-setup`（单独测 98ms）与
`hooks`（65ms）也改成「启动预取 + 用时 await」。**交错 A/B 实测（同一时段、各 3 次，避免上几轮那种不同时段的
漂移）**：基线 entry 中位数 **302ms** / composer **360ms**；改动后 entry **313ms** / composer **364ms** ——
没有收益，故整片回滚（不留噪声级复杂度）。原因查清：这两个图**仍被 entry 里的其它模块静态拉进来**
（`src/cli/approval.ts:52` 与 `src/cli/oneshot.ts:31` 都 `import './hooks.js'`），所以把它们从 `runtime.ts`
顶部挪走并不会从静态图里消失；要真正省掉必须先拆这些导出边。
**另一条实测结论（用 `node --cpu-prof` 给 `import('./dist/cli/runtime.js')` 采样）**：311ms 总时间里有
**285ms 是 Node ESM/CJS loader 自身**（`esm/utils` 59.6、`node:fs` 56.5、`bootstrap/realm` 42.2、
`cjs/loader` 24.9、url 12.5…），第三方包只有 `string-width` 11.3、`domino` 6.0、`ssh2` 1.5 —— 也就是说
entry 的成本**按模块个数线性**，不是某个"大模块"；后续 H1 只能靠**减少 pre-composer 可达模块数**（拆导出边、
把整块功能移到首次使用时），不能再靠挪 import 位置。

**下一步候选（H1）**：把这段"首次 commit → PTY 就绪"的 200–380ms 定位出来（`composer` 后加
`frame-written` / `raw-mode` 两个 mark，或直接测 node 冷启动占比），再决定是否值得把 composer 骨架渲染
前移到 ink 之外；`ink` 预取本身可再提前到 `runCli` 第一行（当前在 args/phase 解析后，损失约 10–20ms）。

可输入前 843 ms 是唯一被实测的体感痛点（`ux-handfeel.md:11-14`），而启动顺序里技能/MCP/prompt 全在 TUI
挂载之前（`runtime.ts:1088-1162` vs `:1615`），期间**没有任何可见文字**——用户看到的是空屏，这是 800 ms
被感知成更长的原因。ux-handfeel 自己的建议也是「先计时再改渲染顺序」。
最小切片：先做 H2（`MOSS_STARTUP_TIMING=1` 分阶段计时），用数字决定 H1 的范围；不要直接改渲染顺序（闪烁风险）。
风险：计时日志必须写 stderr 且默认关闭，不能污染 `--output-format json`。

**B13 小窗口下压缩准备超时即静默跳过（P1，本轮真实运行发现）**
`agent:context-prep` 的 compaction prepare 有 30s 超时；窗口设小（实测 `agent.contextTokens` 5000/6000、
会话 60 条消息）时两次真实运行都打印
`proactive compaction failed · error=proactive compaction prepare timed out after 30000ms`（还有
`prompt prune compaction failed`），本次压缩被**静默跳过**、上下文继续按原样跑——用户看不到降级提示，
小窗口模型会直接撞上下文上限。触发条件（summarize 调用为何 >30s、是否与 `reserveTokens`/`keepRecentTokens`
默认 20000 大于窗口有关）未定位。
最小切片：把超时原因结构化进一条 warn（耗时、块数、窗口、阶段），并为「超时后」增加一次快速确定性摘要
（不带 LLM 的 deterministic fallback）而不是什么都不做；探针用 60 条预置消息 + 小窗口复现（mock LLM 下不超时，
需真实 LLM 或注入慢 summarize）。风险：确定性摘要质量低，必须标记 `degraded` 并保留 B02 指针，不能冒充完整摘要。

**B13 首片已落地（2026-11-05）**：超时不再静默跳过——结构化 warn + 确定性摘要重试 + `degraded` 事件/横幅/JSON，
确定性摘要自身也按「不超过被替换内容的 50%」设预算（详见 B61）。
**B13 根因首片也已落地（2026-11-05，见 B62）**：超时的直接原因是窗口 5000 < 默认 reserve 20000，导致
「每轮都超预算 + 汇总结论要求 4096 输出 token」；现在 reserve/keepRecent 只在 `>= 整个窗口` 时收敛，
汇总输出再加 `窗口×25%` 封顶。仍未解决：窗口经济学常量本身对小窗口仍不友好——`MIN_EFFECTIVE_WINDOW = 4000`
会把 1200–3000 的配置窗口抬到 4000（实际超过用户配置的模型窗口），`AUTOCOMPACT_BUFFER_TOKENS = 13000`
与 `MIN_DYNAMIC_BUFFER = 2000` 也让 4k–8k 窗口的主动压缩阈值落在窗口的 ~50% 以下；需要按窗口比例重新标定。

**B14 验证门串行执行，墙钟紧贴 CI 预算（P0，基础设施；对应 CR/B15 之外的独立发现）**
`scripts/verify/cli.mjs` 原来是 `for (const name of stages) { await stage.run() }`：`static`（prettier+eslint+tsc）
与 `build` 互不依赖却排队，23 个 stage 的耗时直接相加（本机 41.9–42.6s，CI 硬预算 60s）。而 gate 还在持续加
stage（本轮之前 21 个），每加一个就在挤压余量，超预算在 CI 上是 annotation + fail。
最小切片：给 runner 加依赖感知调度器 —— `requires` 满足即启动，池大小 `VERIFY_CONCURRENCY`（默认 4）；
`static` 与 `build` 天然重叠；只有 `startup-timing` 独占（毫秒阈值不能被别的编译干扰）；失败即停止派发新
stage、等在跑的结束，半跑 stage 不会显示成 `ok`。`VERIFY_CONCURRENCY=1` 保留同调度器的串行基线，便于对照。
证据：同 worktree 三跑对照，串行 41.9/42.0/42.6s vs 并发 24.3/24.6/25.0s，全部 PASS；强制池中一个探针失败时
新 stage 不启动、在跑跑完、exit 1。注：调度器首版在与其他会话共享 checkout 时被其提交 `2a00395f` 一并带走，
本轮补的独占集收窄（smoke 也进池，仍守 PTY 断言）与文档/表格记录是本轮改动。

**B12 分阶段计时补齐 `prompt` / `mcp` 两段 + 一次负结果（2026-11-05）**
原来只有 `entry/proxy/config/agent/skills/total`，看不出「提示词组装」与「MCP 准备」各占多少，而 B12 的验收口径
要求能定位到这几段。现在 `prompt` 在 `createCliPromptSetup` 之后打点（系统提示层/AGENTS.md/rules/soul）、`mcp` 在
MCP 注册表准备之后打点；真实一行变为
`[startup] timing: entry=341ms proxy=84ms config=120ms prompt=262ms agent=278ms mcp=278ms skills=530ms total=530ms`。
`startup-timing` probe 同步收紧：正则必须含 `prompt=`/`mcp=`，单调性断言扩展为
`config ≤ prompt ≤ agent ≤ mcp ≤ skills ≤ total`（4 checks pass），README 的环境变量表同步。
**负结果（已回退，不再重试）**：把 `core/mcp/registry.js` 的静态 import 改成「只有配置了 MCP 服务器才动态 import」，
理论上能省掉 client/transport/npx 模块图；实测冷进程 `import('./dist/cli/runtime.js')` 中位数
**262ms → 270ms**（8 次，噪声内），`--cpu-prof` 里被采样的 dist 模块数 **8 → 7**，没有可测收益，故回退，保持静态 import。
**这次测出的真实大头**：`agent → skills` 之间约 **250ms**（`278 → 530`），即技能发现 + 命令/slash 命名空间 + 文件工具注册；
下一片该动的是把这块移出「composer 之前」的可达集，而不是继续找 MCP 的模块。

**B12-H1 第一刀（2026-11-05）：TUI 不再等待 provider 上下文窗口探测**。细粒度临时打点定位到
`agent → skills` 的 ~220ms 里几乎全部是 `resolveContextTokensForModel`（对 provider 的 `/models` 探测，
`timeoutMs: 4000`），它原本**阻塞在 composer 之前**。改为 `probeContextWindow()` 先启动：
headless（`-p`）仍然 `await`（第一轮就需要正确的窗口），TUI **不 await**，composer 先画出来，
探测落地后再更新 `agent.config.contextTokens/maxTokens`（agent 每轮重读，无需重建）；并在命中后打 `probe` 标记。
**真实 A/B（本地 provider 桩把 `/models` 延迟 800ms，真实 TUI + PTY，`MOSS_STARTUP_TIMING=1`，交替各 3 次）**：
`composer` 中位数 **1156ms → 356ms**（old 1155/1156/1251 vs new 356/356/362），即把整段探测延迟移出首屏；
headless 一行仍是 `… mcp=273ms probe=519ms skills=521ms total=521ms`（`-p` 语义不变，窗口仍先探测）。
`startup-timing` probe 允许 `probe=` 出现在 `skills` 之前且断言 `probe ≤ skills`（4 checks pass）；README 同步。
**注意**：本机默认 provider 的 `/models` 通常 <100ms，所以日常提升小于该 A/B 的 800ms；结构收益是「慢 provider 不再拖慢首屏」，
`bench:tui-feel` 的 composer 中位数仍需在本机默认 provider 下复测（本轮未跑，标注为未验证）。

**B12-H1 第二刀（2026-11-05）：TUI 不再等待环境层（git 子进程链）**。headless 一行显示
`config=111ms env=267ms prompt=268ms`——环境层（`buildEnvironmentContextLayer`：`git rev-parse ×2`、
`git status`、`git log`、目录列举）**约 156ms 全串行**，而它只是动态层。改为 `createCliPromptSetup` 接受
`deferEnvironmentLayer`：headless 仍然 `await`（第一轮就带快照），TUI 先画首屏、层落地后再 `set`
（agent 每轮重读层）；落地打 `env` 标记。
**真实 A/B（真实 TUI + PTY，工作区 400 个已修改文件让 `git status` 有成本，provider `/models` 即时，交替各 3 次）**：
`composer` 中位数 **479ms → 383ms**（old 586/455/479，new 383/386/380），即 −20%；`prompt` 段 474→265。
`startup-timing` probe 容忍 `env=` 且断言 `config ≤ env ≤ prompt`（4 checks pass）；README 同步。
**诚实边界**：TUI 的首轮若在环境层落地前就开始，会缺该动态层（人类输入间隔通常 >100ms，且 `promptLayers`
每轮重读；headless 不受影响）。`bench:tui-feel` 默认 provider 复测仍未跑（bench-unverified）。

## 4. 已排除：已落地 / 已澄清（防止重复调研）

| 项                                                  | 为什么不再列                                                                                                                                      |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 工具/技能的 progressive disclosure 基础             | 目录预算 + 降级策略 + `omitted`/`strategy` 统计已实现（`src/core/skills/skill-catalog.ts:1-17`）                                                  |
| MCP 在 headless 下「不可用」                        | 2026-11-04 真实运行已否定该推断（`README.md` §7.4）；MCP prompts/resources/按工具 `alwaysLoad`/`defer` 已落地（`79a389d5`/`00a7217b`/`6bab6b8d`） |
| 计划批准与计划版本的绑定                            | 已落地 `2d850065`（`src/cli/plan-version.ts`、`exit_plan` 指纹）；B04 只剩「结束协议」这块                                                        |
| 项目指令层级                                        | 已支持祖先链 + `CLAUDE.md` + scoped rules（`0dac0b5f`、`src/cli/project-instructions.ts:215-229`）                                                |
| hook 事件与退出码                                   | PreToolUse/PostToolUse/PostToolUseFailure/PermissionDenied/SubagentStart + `timeoutMs` + exit 2 语义已落地                                        |
| 输出被 max_tokens 截断                              | 已有按模型分档 + 升级恢复（`src/core/loop/output-limit.ts`），不列                                                                                |
| 手动 `/compact [instructions]`、`/usage`、`/export` | 均已实现（`src/cli/interactive-commands.ts:68,100-118`）                                                                                          |
| 技能成本/使用/评测可见性（D10 第一片）              | 已落地 `fb158de6`（`moss skill list` 的 `used`/`catalog`/`evals`）                                                                                |

## 5. 证据抽样清单（本文件实际读过的源码）

`src/core/loop/{verification-completion-gate.ts,output-limit.ts,agent-loop-tool-execution.ts}`、
`src/core/tools/{deferred-tool-offer.ts,tool-catalog.ts,tool-types.ts,tool-hooks.ts}`、
`src/core/agent/{moss-agent.ts,session-tool-offer.ts,moss-agent-types.ts}`、
`src/core/subagent/{spawn-profile.ts,expert-registry.ts,subagent-runner.ts,worktree-isolation.ts}`、
`src/core/skills/{skill-catalog.ts,skill-registry.ts,skill-usage.ts,skill-tool.ts}`、
`src/core/session/jsonl-session-store.ts`、
`src/context/{compaction.ts,compaction-prompts.ts,turn-watch.ts,git-status-snapshot.ts,tool-output-truncate.ts}`、
`src/tools/{builtin.ts,file-tools.ts,search-tools.ts,plan-gate.ts,tool-search.ts,tool-output-spill.ts,device-tools.ts,create-subagent.ts,merge-subagent-patch.ts,review-tools.ts}`、
`src/contracts/prompts/{plan-mode-prompt.ts,agent-behavior-prompt.ts}`、`src/contracts/messages.ts`、
`src/cli/{help.ts,project-instructions.ts,prompt-setup.ts,context-report.ts,interactive-commands.ts,args.ts,attachment-refs.ts,runtime.ts}`、
`src/cli/tui/{app.ts,input/key-stream.ts,mentions.ts}`、`src/cli/tui-utils.ts`、`scripts/verify/cli.mjs` 与 `scripts/verify/stages/*.mjs`、
`scripts/tui-feel/{run.mjs,driver.py}`。

**维护**：每次验收后只改三处——总表「状态」、§4（若整类问题消失）、§6（重排未来 6 轮）。
一条条目连续两轮无人认领就降级或删除；对手侧证据过期（新版本改了行为）时，先改「参考实现」列再决定去留。

## 6. 推荐顺序（未来 6 轮，每轮 30 分钟一个可独立验收的切片）

R1（B02）已落地 `b5f25213`；R2（B03）已落地（本轮）。下表从 R3 起仍有效。

| 轮次  | 切片（可独立验收）                                                       | 改动面                                                                                       | 验收命令 / 判据                                                                                |
| ----- | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| R1    | B02 压缩历史指针：摘要尾部加 `.moss/sessions` 指针 + `# HISTORICAL` 约定 | `src/context/compaction-prompts.ts`、`src/context/compaction.ts`（只改文本与拼接）+ 探针     | `node scripts/verify/cli.mjs --stage compaction-history` 通过；探针在旧代码上必须失败          |
| R2    | B03 摘要校验器 + 一次收紧重试                                            | 新增 `src/context/summary-validate.ts`（纯函数）+ 接入 `compaction.ts:1061`                  | `node scripts/verify/cli.mjs --stage compaction-summary`：缺节摘要判 invalid、合规摘要一次通过 |
| R3 ✅ | B01 第一片：`read_image` 工具（不做剪贴板/TUI 粘贴；本轮已落地）         | `src/tools/file-tools.ts`（或新 `read-image.ts`）+ `builtin.ts` 注册 + 能力守卫              | B01 探针两条：`builtinTools` 含 `read_image`；真实 `-p` run 的 tool_result 出现 image block    |
| R4 ✅ | B04 plan 结束协议（本轮已落地）                                          | `src/contracts/prompts/plan-mode-prompt.ts` + headless 一次纠正（复用 completion gate 形态） | `node dist/cli.js --plan -p "…" --output-format stream-json` 里 `exit_plan` 调用数 ≥1          |
| R5 ✅ | B06 规则 description/手动激活（迁移提示未做，见条目）                    | `src/cli/project-instructions.ts:319-326`、`src/cli/prompt-setup.ts:117-141`                 | `selectActiveRules(rules, [])` 对 description-only 规则返回空；always 规则行为不变             |
| R6 ✅ | B07 子代理授权/绝对路径契约（本轮已落地）                                | `src/core/subagent/spawn-profile.ts`（纯文本）+ 静态探针 + 一条行为切片                      | `spawn-profile` 断言退出 0；父诱导 read-only 子代理写文件时子代理回 `blocked`                  |

R7 起：先做 B05 的**测量切片**（`toolVisibleForRun` 计数基线，不改行为）与 B12-H2（启动分段计时），
有数字后再排 B08/B09/B10/B11。B11 建议排在 A2（reviewer 管线）收口之后——两者都要动子代理的
session 持久化，同一周做能共用探针。
