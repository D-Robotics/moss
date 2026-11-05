# Moss README 批判与新版结构提案

日期：2026-11-06 · 对象：`README.md`（470 行）与 `README.en.md`（582 行）· 目标：按"最佳产品 README"的标准
重排信息，让读者在 60 秒内知道**这是什么 / 凭什么信 / 怎么开始**，30 秒内跑出第一个**被验证的结果**。

**证据边界**（先说清楚，避免把推断当事实）：

- 行号引用均为 2026-11-06 的 `main`（`ab9ad905`）里的 **README.md（470 行）/ README.en.md（582 行）**。
  文中的"实测"指本轮只读复现：`node scripts/measure-tool-surface.mjs`、`dist/tools/builtin.js` 的
  `builtinTools.length`、`dist/cli/args.js` 的 `parseCliArgs` + `dist/cli/task-run.js` 的 `parseFlags`。
- **注意**：工作区里已有一份**未提交**的并行重写稿（README.md 170 行 / README.en.md 179 行，2026-11-06 02:33，
  另含 `docs/install.md`、`docs/cli-reference.md`、`docs/safety.md`、`docs/rdk-board-deps.md`、
  `docs/assets/demo-run.svg`）。§1–§7 批判的是**已提交的旧版**（否则"10 个问题"不成立）；
  §8 单独评估并行重写稿：哪些问题已修、哪些仍在、哪些是新引入的。
- 本文件**没有**改 README、没有跑真实模型、没有新拍截图；涉及"用户会怎么想"的判断标 `[inf]`。
- 手感相关事实全部来自 `AGENTS.md` 命令表、`docs/specs/2026-11-06-moss-acceptance-longrun-brainstorm.md`
  §2/§5、`src/cli/tui/help.ts`、`src/cli/tui/keymap.ts` 与 `docs/tui-ux-audit-2026-10-01.md`。

---

## 0. 五条结论（先看这个）

1. **现在的 README 是"安装手册 + 能力清单"，不是产品页。** 第 24–198 行（共 175 行，占全文 37%）依次是
   环境、安装、升级、卸载、代理；产品定义"为什么是 Moss"在第 200 行才出现。[obs]
2. **差异化没被讲出来。** 唯一独特主张（PASS 只能来自 verdict provider + SSH 真机）藏在 200–218 与
   237–255；全文没有与 Claude Code / Cursor / codex 的对照表，对比材料在 `docs/cli-parity/`（463 行）里，
   读者看不到。→ 读完后无法回答"我为什么不用现成的 agent"。[obs]
3. **信任被自己扣分。** 唯一 headless 任务示例用了不存在的 `--goal` flag（253/271 行，实测 goal 变成
   `--goal 创建 hello.txt…`）；工具数写 45/12 而实测 51/13；公开页出现 13–14 个内部工单号（`O83`…`O170`）；
   中英两版对同一功能给出相反事实（可选 OS 沙箱）。[obs]
4. **转化路径缺失。** 首屏没有 demo（无截图/GIF/asciinema，第一段代码是 `node -v`，28–30 行），
   "快速开始"（55–130，76 行）本质是安装 FAQ；第一次出现"被验证的结果"在 239 行之后。[obs]
5. **最值钱的手感在 README 里零出现。** B92–B126 这一批（打断即暂停、`/goal resume`、resume 先验收、
   `/rewind` 连对话一起回滚、运行期输入归属、`[task-state]` 延续）全部缺席——README 停在 v0.26 的能力面，
   而 2026-11 的产品价值恰恰在这些"手感"上。[obs]

---

## 1. 现存 README 的十个问题（按影响理解 → 影响信任 → 影响转化排序）

每条格式：**证据**（行号 + 原文片段）→ **为什么是问题** → **改法一句话**。

### A. 影响理解：60 秒内读不懂"它是什么、和我有什么关系"

**A1. 首屏只有 slogan，没有"一句话定义 + 一个画面"。**
证据：3–18 行是标签句 `**One Intent → One Task → One Agent Loop → One Verified Result.**` + 3 个 bullet，
第 24 行直接进"## 环境"；slogan 的展开（`task_define → … → task_acceptance` 五步链）在 204–209 行。
问题：新读者在前 175 行拿不到"它是给谁、替代什么、凭什么不同"；"Agent Task OS"（16 行）全文无定义。
改法：首屏 = 1 句定义 + 3 个 bullet + 1 条命令 + 1 个 8 行终端片段（见 §3）。

**A2. 安装/运维信息占满前 175 行。**
证据：环境 24–53（30 行）· 快速开始 55–130（76 行）· 升级 132–150（19 行）· 卸载 152–168（17 行）·
代理 170–198（29 行）。产品定义要到 200 行；第一次出现真实任务示例在 239–241，第一次出现 `task run` 在 253。
问题：安装细节对"第一次打开"的人是噪音，对"装不上"的人是刚需——两类人却在同一段里。
改法：安装/升级/卸载/代理全部移出（见 §4），README 只留 3 条命令 + 1 行"装不上见 docs/install.md"。

**A3. 能力段像 changelog / 规格书，找不到"我能用它做什么"。**
证据：220–280 行六段粗体（`写代码。`/`子代理。`/`连真机。`/`扩展。`/`嵌入与自动化。`/`Super-agent。`），
每段把能力、内部实现、参数细节压在一个自然段；262–280 是 19 行 "SDK 工具后置 hook 与结构化结果（0.x 行为变更）"
迁移说明；243 行是一整段 rdk-docs MCP 的版本/BM25/`noGoodMatch`/`alt_queries` 细节。
问题：读者想要"三行摘要 + 一个例子"，却得到"实现说明 + 变更公告"；能力段承担了 CHANGELOG 的职责。
改法：能力拆成"四种用法"（§2 第 4 节）+ 每个发源一行链接；SDK 变更进 CHANGELOG。

**A4. 没有心智模型，也没有对比。**
证据：全文 0 处 "vs Claude Code / Cursor / codex" 对照；状态机 `draft → planning → … → accepted | failed`
只在 213–214 出现一次；唯一对照文档是文档清单里的 `docs/cli-parity/`（463 行），需要二次点击才能看到。
问题：读者无法把 Moss 归入已知类别，也无法判断"何时该用它、何时不该"。
改法：新增"与谁不同"一节（4 行对比表 + 2 行诚实边界），并把状态机放进"如何定义完成"一节当骨架。

### B. 影响信任：读完觉得可不可靠、准不准

**B5. 关键数字与示例已过期/错误（最硬的信任问题）。**
证据：① 222 行 `**45 个内置工具**开箱即用（含 **12 个 SSH 设备工具**）`；实测
`builtinTools.length = 51`、`DEVICE_TOOL_NAMES.length = 13`（`node scripts/measure-tool-surface.mjs`
的 `full` scope 同口径 51 tools / 37,198 chars）。② 253 行唯一 headless 任务示例
`moss task run --goal "创建 hello.txt 内容为 MOSS_OK 并验证内容" --accept "grep -q MOSS_OK hello.txt"`
——`--goal` 不是 flag：实测 `parseCliArgs` → `commandArgs` 含 `--goal`，`parseFlags` 把它归入位置参数，
最终 goal 是 `"--goal 创建 hello.txt 内容为 MOSS_OK 并验证内容"`。EN 271 行同样。
问题：用户复制示例就得到错误目标（模型要完成的是"以 --goal 开头的一句话"），且 45 不再是事实。
改法：写位置参数形式；数字要么删、要么由 `measure-tool-surface.mjs` 生成；示例进 CI 校验（§6）。

**B6. 中英不是同一份文档，还对同一功能给出相反事实。**
证据：① zh 381 行 `**可选**的操作系统沙箱已实现（D14）：… 或 \`MOSS_OS_SANDBOX=1\``；en 426 行
`An opt-in OS sandbox is specified in docs/design/os-sandbox.md and stays off.`（"specified … stays off"）。
② zh 有整节"调优开关（环境变量）"（427–444，18 行），en **完全没有**；该节独有的 4 个变量在 en 全文缺失：
`MOSS_LEAN_TOOLS`、`MOSS_OS_SANDBOX`、`MOSS_STARTUP_TIMING`、`MOSS_VERIFY_CONCURRENCY`。
③ zh 文档清单是 9 条带解释 bullet（455–467，含罕见条目 `docs/sdk-durable-steering.md`），en 压成一段
inline 链接（568–578）且少这条；④ zh 命令表 21 行含 flags 表，en 13 行把 flags 压成散文。
问题：双语用户得到两个不同的产品说明；"沙箱到底有没有"直接影响安全判断。
改法：以 zh 为母版定 12 节（§2），en 同序同节；每节"必须出现的内容"逐项对照；§6 给检查办法。

**B7. 内部工单号泄漏到公开页。**
证据：zh 13 个（`O83 O87 O94 O101 O135 O157 O158 O162 O164 O165 O168 O169 O170`）、en 14 个（多 `O97`），
散落在代理节（170–198，"根因修复见 backlog **O87**"）与安全节（368–401，O94/O101/O135/O157/O158/O162/O164/
O165/O168/O169/O170）。问题：用户不知道 O94 是什么，也无法据此行动；公开页像内部周报。
改法：工单号只留 docs/security-model.md 与 CHANGELOG；README 用"已知限制"的人话描述。

**B8. 安全节把"边界诚实"写成了"风险清单"。**
证据：368–401（34 行、10.4 KB）第一句就是"v0.26 起默认 full"；随后 6 条 bullet 用 O-issue 讲"哪些拦不住"
（静态扫描挡不住子进程、`workspace-write` 不是 OS 沙箱、受保护路径是尽力拦截…）。
问题：读者记住的是"它拦不住"，而真实设计是"默认少问、但边界写清楚、毁灭性操作仍确认"——顺序反了。
改法：4 句话前置（默认 full 是什么 / `--read-only` 是硬上限 / deny 优先于一切 / 毁灭性设备操作仍确认 /
无账号无遥测），细则一句链接到 docs/security-model.md。

### C. 影响转化：新用户能不能 30 秒跑出"这就是我要的"

**C9. "快速开始"是安装 FAQ，没有 30 秒的被验证结果。**
证据：55–130 行里，真正阻断型内容占了大半——EEXIST 与旧包冲突（65）、EACCES 用户级 prefix（67–73）、
npm 11 warning（88）、源码路径（75–90）、自定义网关（98–111）；第一次"成功体验"在 92–96，内容是
`看一下这个目录里有什么`（无验收、无判定、无结果面）。前 200 行没有一处展示"PASS 来自命令退出码"。
问题：新用户的第一印象是"装依赖很麻烦"，而不是"它能把完成变成可验证的"。
改法：3 条命令到第一个 PASS（§3），并把安装 FAQ 全部移出。

**C10. 手感/生命周期整体缺失，README 停在 v0.26。**
证据：全 README 关于交互只有 115–118 四个 bullet（`Shift+Tab`、`Ctrl+V`、`/help`、`/goal`）；没有任何
"打断/暂停/恢复/撤销/失败原因"的说明。而 2026-11 已落地的能力（AGENTS 命令表 + brainstorm §5.19–5.38）：
`/goal` 运行中 Ctrl+C（REPL）/ Esc（TUI）**暂停而不是丢弃**（B95）、headless 首次 SIGINT exit 130（B121）、
`/goal resume` 接续同一 task 并在启动前回显解析到的 task 与预算（B122）、`task resume` 先验收后花回合
（B116，常见 1 秒级）、`/rewind` 同时回滚文件与对话（B93）、运行期输入不泄漏（B123）、结束后下一轮聊天
自动带一次 `[task-state]`（B125）。
问题：产品最值钱的"手感"在 README 里不存在，转化靠想象。
改法：新增"一次 run 的生命周期"一节（§5），只写可验证的键与状态。

---

## 2. 新 README 逐节大纲（12 节，中文，预算 ≤180 行）

**总量约束**：正文 175 行 + 页眉 5 行（标题/徽章/语言切换/一句 slogan）= 180 行上限。每节末尾给
"**不要出现**"，用来防止旧内容回流。英文版按同序同节 1:1 映射（允许英文行数 ≤1.3×，**必须内容项**逐项对齐）。

| #   | 中文标题（行数）                 | EN heading                  | 一句话目的                         | 必须出现的内容                                                                                                                                                                                                         |
| --- | -------------------------------- | --------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | 首屏（≤18）                      | Hero                        | 60 秒内知道"它是什么、凭什么信"    | 1 句定义（可验证的完成）+ 3 bullet（可机检验收 / 真机 / 四交互面）+ 1 条安装命令 + 1 个 8 行终端片段（PASS + exit 0）+ 徽章 + 语言切换                                                                                 |
| 2   | 60 秒上手（≤16）                 | 60-second start             | 3 条命令跑出第一个被验证的结果     | `npm i -g @rdk-moss/agent@latest` · `moss setup`（或 `apiKeyEnv`）· `moss task run "<goal>" --accept "<cmd>"`；期望输出（`Task … PASS`、`exit 0`、`moss task list` 一行）；一句"装不上见 docs/install.md"              |
| 3   | 它如何定义"完成"（≤22）          | How "done" is defined       | 讲清唯一差异化：完成是裁决不是自述 | 五步链（`task_define → device/exec/tests → record_evidence → task_acceptance`）+ 状态机（8 态）+ "PASS 只能来自 verdict provider，散文不是事件" + `.moss/` 工件清单 + 诚实通道（未验证 exit 9 / blocked 不耗修复预算） |
| 4   | 四种用法（≤18）                  | Four ways to use it         | 让读者 3 秒选中自己的入口          | TUI（何时用）/ REPL（何时用）/ headless（脚本、exit code 0/1/130/9）/ SDK（`src/index.ts` semver）+ 每种 1 条命令；`moss loop --until` 作为"外部命令驱动的闭环"一行                                                    |
| 5   | 一次 run 的生命周期（手感，≤24） | The feel: a run's lifecycle | 把"打断→恢复→撤销"讲成可预期操作   | 5 段生命周期 + 键位表（真实键，见 §5）+ 失败三条路（改 oracle / 加预算 / 修环境）+ 撤销边界 + 输入归属；全部给"会发生什么"的可验证描述                                                                                 |
| 6   | 连真机（≤16）                    | Reach the hardware          | 说清机器人闭环的边界与入口         | 只读工具 1 行 + 写类工具 1 行（逐次审批）+ `moss device fleet info` 一条 + `moss task run` 一个真机目标示例 + 板卡手册由 rdk-docs MCP 供给 1 行 + 板端依赖指向 docs/rdk-inference-deps.md                              |
| 7   | 扩展（≤12）                      | Extend it                   | 让人知道不改源码也能定制           | MCP（stdio/HTTP、懒加载）· skills（SKILL.md 渐进披露）· commands · agents · hooks · soul，一行一个 + 链接；`moss plugins install` 一行                                                                                 |
| 8   | 与谁不同（≤16）                  | How it differs              | 给出选择 Moss 的理由与不选的理由   | 4 行对比表（Moss / Claude Code / Cursor / codex：验收语义、真机、交互面、开放性）+ 2 行"不适用场景"（无 web UI、无托管编排、Windows 无 PTY）                                                                           |
| 9   | 安全与隐私（≤12）                | Safety & privacy            | 4 句话说清"默认少问但边界清楚"     | 默认 full 的边界 · `--read-only` 硬上限 · deny 优先 · 毁灭性设备操作仍确认 · 无账号/无遥测 · shell 无 OS 沙箱（可选 sandbox 一句）+ docs/security-model.md                                                             |
| 10  | 已知边界（≤10）                  | Known limits                | 主动说出限制，换取信任             | 未验证=exit 9 · shell 无沙箱 · 子代理/后台编辑不进 checkpoint · 板端依赖不自动装 · 版本/tag 策略一句 + docs/release-policy.md                                                                                          |
| 11  | 文档地图（≤8）                   | Docs map                    | 把深度内容一次列全                 | 6–8 条：install / security-model / cli-reference / capability-layer / device-bench / cli-parity / CHANGELOG / AGENTS                                                                                                   |
| 12  | License（≤3）                    | License                     | 合规信息                           | MIT + LICENSE 链接                                                                                                                                                                                                     |

**每节"不要出现"清单（防止回流）**：

1. 首屏：多行安装分支、badge 之外的图、内部单号。
2. 上手：EEXIST/EACCES/npm warning/源码编译——全部在 docs/install.md。
3. 完成：SDK 0.x 迁移说明、工具清单逐条罗列。
4. 用法：完整命令表（进 docs/cli-reference.md）。
5. 生命周期：不可达的键、隐藏别名逐个解释、"丝滑/优雅"这类形容词、绝对秒数承诺。
6. 真机：whl 直链、`hbm_runtime` 版本矩阵（进 docs/rdk-inference-deps.md）。
7. 扩展：MCP 的 BM25/`noGoodMatch`/`alt_queries` 参数细节（进 docs/capability-layer.md）。
8. 对比：竞品未经验证的功能断言，只写可核对的事实。
9. 安全：O-issue 单号、hook 逐事件行为（进 docs/security-model.md）。
10. 边界：重复的第 9 节内容。
11. 文档：超过 8 条链接（深度内容散落，读者不点）。
12. License：任何商标/归属长文。

**中英映射规则**（解决 B6）：

- 以中文为母版；英文不是翻译而是"同结构改写"：12 节、顺序、每节的**必须内容项**逐项一致；
  行数上限英文 = 中文 × 1.3。
- 建议加一个轻量检查（不阻塞交付）：`scripts/verify/readme-parity.mjs` 读取两份 README 的 `##` 标题序列
  做 diff，再断言两份都包含相同的必备命令串（`moss task run`、`--accept`、`moss device`、`--read-only`）。
  当前两份的 `##` 数不同（zh 有"调优开关"、en 无），这类漂移会立刻被抓到。

---

## 3. 首屏 hero 三个候选 + 30 秒 quickstart

### 3.1 Hero 候选（各含中英）

**候选 A（推荐：主打的差异化 = "完成是可验证的"；受众：所有会在 CI/脚本里用 agent 的人）**

> **中文**：Moss 是一个会"自证完成"的 coding agent：一句话目标被编译成带验收命令的任务状态机，
> 只有命令退出码说通过，它才说 PASS。
> **English**: Moss is a coding agent that proves its work: a sentence of intent becomes a stateful
> task with a machine-checkable acceptance command, and Moss only says PASS when that command exits 0.
>
> 副标题：无账号、无遥测；provider 就是一个 HTTP 端点；TUI / REPL / headless / SDK 同一套语义。

**候选 B（受众：机器人 / RDK 开发者）**

> **中文**：会连真机的 coding agent：SSH 直连 RDK / Linux 板卡，部署、执行、记录 Expected/Observed
> 证据、按验收标准裁决——"完成"指板子真的做到了。
> **English**: A coding agent that reaches the hardware: SSH into RDK / Linux boards, deploy, run,
> record Expected/Observed evidence, and accept only when the board actually did it.
>
> 风险：把 80% 的纯软件读者挡在门外，建议只作为 B 线场景页开头，或 hero 的第二 bullet。

**候选 C（受众：SDK / 平台集成方）**

> **中文**：一套可嵌入的 agent harness：TUI、REPL、headless、SDK 共用同一个 loop、同一套安全审批和
> 同一种"完成"定义；`src/index.ts` 是受 semver 保护的导出面。
> **English**: One embeddable agent harness: TUI, REPL, headless and SDK share one loop, one approval
> model and one definition of done — with a semver-protected export surface.
>
> 风险：像基础设施库，不像"能马上用的工具"，转化率低。

**推荐组合**：A 作 hero 主体（第 1 节），B 作第 6 节"连真机"的开头句，C 作第 4 节"SDK"那一行。
不要把三条并列——并列等于没有定位。

### 3.2 30 秒 quickstart 草案（3 条命令）

```bash
# 1) 安装（Node ≥ 22.16；其它平台/代理见 docs/install.md）
npm i -g @rdk-moss/agent@latest && moss --version

# 2) 配一次 provider（交互向导；或 export DEEPSEEK_API_KEY=… + moss config set apiKeyEnv DEEPSEEK_API_KEY）
moss setup

# 3) 第一个被验证的结果：PASS 只可能来自最后那条 grep 的退出码
moss task run "创建 hello.txt，内容为 MOSS_OK" --accept "grep -q MOSS_OK hello.txt"
```

期望输出（节选，真实形态来自 `AGENTS.md` 的 task run/status 契约）：

```text
Task task_xxxx — PASS
phase: accepted · attempts: 1 · repairs: 0 · turns: 1
acceptance: grep -q MOSS_OK hello.txt
$ echo $?    # 0，脚本可判
$ moss task list   # 一行：pass · att:1 rep:0 · <goal> · <命令>
```

**时间诚实**：本仓库真实 deepseek-flash 实测（B114/B116/B117/本轮）单次 `task run` 约 **17–75 秒**，
resume（先验收后花回合）约 **1–17 秒**；"30 秒"是目标不是承诺。README 应写"一条命令，看 PASS 与
exit code"，**不要**写死"30 秒完成"——写死秒数就是下一处 B5。

**可选第二幕（更能说明差异，共 4 条命令）**：把验收故意设成必败再修：

```bash
moss task run "创建 note.txt，内容为 hi" --accept "false"      # FAIL，exit 1，summary 给原因 + next
moss task resume <id> --accept "test -f note.txt"              # 先按新 oracle 验收，通过即 PASS（turns: 0）
```

第二幕演示的是"失败→改判定→1 秒级恢复"，比单纯 PASS 更能建立"它诚实"的印象；建议放在第 5 节
"失败恢复"里，而不是首屏（首屏只放 3 条命令）。

---

## 4. 应移出 README 到 `docs/` 的清单

原则：README 只保留"第一次成功"所需的路径；其余内容进 docs，并在 README 用一句话 + 链接指路。
目标文件名是新建建议，可按现有 docs 结构合并。

| 移出内容（现行号）                                                          | 目标文件                                 | README 保留                                        |
| --------------------------------------------------------------------------- | ---------------------------------------- | -------------------------------------------------- |
| Node 版本与三平台安装分支（24–53）                                          | `docs/install.md`                        | 1 行：`Node ≥ 22.16`，装法见链接                   |
| npm 全局安装、EEXIST/旧包、EACCES prefix、源码路径、npm 11 warning（57–90） | `docs/install.md`                        | 2 行命令（第 3 节 quickstart）                     |
| 升级 / `moss update` / 克隆升级（132–150）                                  | `docs/install.md#upgrade`                | 0 行（`moss update` 在第 11 节文档地图提一次）     |
| 卸载与残留数据位置（152–168）                                               | `docs/install.md#uninstall`              | 0 行                                               |
| 板子无外网 / 代理 / `ssh -R` / 代理验证（170–198）                          | `docs/board-networking.md`               | 1 行：板子不能出网？见链接                         |
| RDK 板端推理依赖：`hbm_runtime`/`hobot_dnn`/legacy whl/libhbucp（282–314）  | `docs/rdk-inference-deps.md`             | 1 行（第 6 节）                                    |
| 命令参考全表 + flags + env 清单（316–351）                                  | `docs/cli-reference.md`                  | 6 行最常用命令                                     |
| 调优开关（427–444：LEAN_TOOLS/STARTUP_TIMING/VERIFY_CONCURRENCY/NO_TUI）    | `docs/tuning.md`（并补进 en）            | 0 行（`MOSS_NO_TUI` 只在第 4 节提一句）            |
| 质量门与基准（403–425）                                                     | `docs/verification.md`                   | 1 行：`npm run verify` 是交付门，基准见链接        |
| SDK 0.x 行为变更（262–280，19 行）                                          | `CHANGELOG.md` + `docs/sdk-migration.md` | 0 行                                               |
| 安全细则：O94/O101/O135/O157–O170、hook 逐事件、受保护路径三层（368–401）   | `docs/security-model.md`                 | 4 句摘要 + 1 链接（第 9 节）                       |
| 界面语言优先级细则（353–366）                                               | `docs/i18n.md`                           | 1 行：`--lang zh` 或 `moss config set language zh` |
| rdk-docs MCP 版本/参数细节（243）                                           | `docs/capability-layer.md#rdk-docs`      | 1 行：板卡手册由内置 MCP 提供                      |
| 支持矩阵（446–453）                                                         | `docs/support-matrix.md`                 | 1 行徽章/链接（第 10 节）                          |
| Super-agent 细节（260）                                                     | 已有 `docs/superagent.md`                | 1 行                                               |

移出后 README 的信息结构是：**首屏 → 3 条命令 → 凭什么是完成 → 四种用法 → 手感 → 真机 → 扩展 →
对比 → 安全 → 边界 → 文档 → License**。安装/板端/排查这三类"出问题才需要"的内容全部后置到 docs。

---

## 5. "手感 / UX" 一节该讲什么（可验证）

### 5.1 三条写作原则

1. **只广告可达的键。** 键位表必须来自单一绑定表：TUI 用 `src/cli/tui/help.ts` 的 `HELP_KEYS` +
   `src/cli/tui/keymap.ts` 的 `DEFAULT_KEYBINDINGS`（`?` 帮助块由同一张表生成）；REPL 单独写。
   历史教训：`Ctrl+H` 不可达却到处广告（`docs/tui-ux-audit-2026-10-01.md` §3.2、§5 原则 2）。
2. **讲状态，不讲形容词。** 不写"丝滑/优雅/沉浸"，写"按 X 会发生 Y，可用 Z 验证"。
3. **写清边界。** 哪些不在 checkpoint 里（shell 命令、子代理/后台编辑）、哪些键不能改绑
   （interrupt / quit 锁定）、headless 与交互面的差异（exit 130 vs 1）。

### 5.2 该讲的 5 件事（每件配可验证断言）

| 该讲什么                   | 具体内容（摘录真实键与行为）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | 可验证依据                                                                                                      |
| -------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| 键位表（TUI 15 + REPL 行） | `Enter` 发送 · `Shift+Enter`/`Ctrl+J` 换行 · `Shift+Tab` 循环模式（manual→accept-edits→plan→full）· `!` shell · `Esc` 打断/取消 shell/再按清空草稿 · `↑↓` 滚动与历史 · `PgUp/PgDn/End` · `?` 帮助；`Ctrl+R` 历史搜索 · `Ctrl+O` 详细 · `Ctrl+S` 草稿 · `Ctrl+V` 附件 · `Ctrl+A/E/U/K/W/Y` 编辑器键 · `Ctrl+C` 中断（再按退出）· `Ctrl+D` 空 composer 退出                                                                                                                                                                  | `src/cli/tui/help.ts`、`src/cli/tui/keymap.ts`（`~/.config/moss/keybindings.json` 可改绑，interrupt/quit 锁定） |
| run 生命周期（5 段）       | ① `/goal <条件>`：从工作区探测验收命令（package.json test / Makefile / pytest / go.mod，最多 3 个候选，找不到就明说）→ ② 计划→执行→验收（timeline）→ ③ 打断：TUI `Esc` / REPL `Ctrl+C` **暂停**（写 `task_failed{detail:"aborted"}`，task 保持可恢复）→ ④ 恢复：`/goal resume [id] [--accept] [--max-repairs] [--max-turns]`（启动前回显解析到的 task 与预算）或 `moss task resume <id>`（先按当前工作区验收，通过即 `turns: 0`）→ ⑤ 结束：PASS 只能来自 verdict；fail/blocked 给 `failed:`/`blocked:` 原因与 `next:` 建议 | AGENTS `/goal` 行、`task run`/`task resume` 行；brainstorm §5.19–5.38（B95/B116/B117/B119/B122）                |
| 失败恢复三条路             | ① 判定错了 → `--accept "<新命令>"`（append-only，timeline `Acceptance command updated`）；② 预算不够 → `--max-repairs`/`--max-turns`（只作用于本次重试）；③ 环境/基础设施坏了 → `blocked_on_user`（不耗修复预算，修完再 resume）                                                                                                                                                                                                                                                                                           | AGENTS `task resume` 行；brainstorm S7/B97、B114、B116                                                          |
| 可撤销                     | 每轮一个 checkpoint；`/rewind [seq]` 恢复**文件 + 对话**；checkpoint 跨 resume 存活、保留最近 100 个；边界：shell 命令与子代理/后台编辑不在其中（与 Claude Code 一致）；`/diff` 先看改动再决定                                                                                                                                                                                                                                                                                                                             | brainstorm §2 表、S1/S2/S10（B92/B93）；`src/cli/file-checkpoint.ts`                                            |
| 输入归属与结束             | 运行中键入不会变成下一条 chat（B123）；agent 提问走 run-scoped asker 直接读 stdin（非 TTY 自动 decline）；运行结束释放渲染器、心跳消失（B124）；结束后下一轮普通聊天自动带一次 `[task-state]`；headless 首次 `Ctrl+C` → exit 130（可续跑），真失败 exit 1                                                                                                                                                                                                                                                                  | AGENTS `/goal` 行、`task run` 行；brainstorm 5.34–5.37（B122–B125）                                             |

### 5.3 建议形态（≤24 行）

- 一张 6–8 行键位表（TUI 一列、REPL 一列；REPL 没有的写"—"）。
- 一段 5 步生命周期（ASCII 竖线或编号列表），每步一行"按键/命令 → 会发生什么"。
- 三条失败恢复 bullet + 一句撤销边界。
- 一行"终端兼容"：TUI 需 TTY；`--no-tty` / Windows 回退 readline REPL；CJK/emoji 按单元格宽度排版
  （`docs/tui-ux-audit-2026-10-01.md` §3.1 的教训）。

### 5.4 不要写进这一节

- 隐藏别名（`/mode`/`/steer`/`/queue`/`/loop`）逐个解释——那是 CHANGELOG 和 `--help --all` 的事。
- 内部工单号与实现层机制（O101 三层扫描、hook 逐事件语义）。
- 绝对时间承诺（"30 秒""1 秒级"要标为实测区间，或者只出现在 docs）。
- 无法用按键/命令/状态验证的体验形容词。

---

## 6. 落地顺序与防回归（执行建议）

1. **先删后补**：第一刀只做"移出 + 压缩"——把 24–198 行压到 ≤20 行，删掉 262–280 的 SDK 变更段与
   13–14 个 O-issue，README 先降到 ~200 行。这一刀不改事实，最安全。
2. **补首屏**：按 §2 第 1–3 节重写前 60 行（hero + 3 条命令 + 完成定义），用候选 A 的文案；
   终端片段用**真实运行输出**（不是手写），避免再次出现"示例不对"。
3. **补手感**：把 §5 的表落进第 5 节（≤24 行），键位表直接从 `help.ts`/`keymap.ts` 抄，不凭记忆。
4. **补对比**：第 8 节 4 行表格，只写可核对事实（验收语义 / 真机 / 交互面 / 开放性），不写竞品未验证功能。
5. **en 同步**：以 zh 为母版重写 en，补齐"调优开关"内容；修正 en 426 的沙箱句子（与 zh 381 对齐，
   要么都写"已实现、默认关、`MOSS_OS_SANDBOX=1` 开启"，要么都写"specified, off"——目前是两套事实）。
6. **防回归**：
   - 示例可执行性：把 README 里的 `moss task run`/`moss device`/`config set` 行抽到
     `scripts/verify/readme-examples.mjs`，只做"参数解析级"校验（`parseCliArgs` + `parseFlags`），
     能立刻抓到 `--goal` 这类错。
   - 数字不写死：工具数/命令数不写进句子，或由 `scripts/measure-tool-surface.mjs` 生成后校验。
   - 双语结构：`readme-parity.mjs` 比 `##` 标题序列 + 必备命令串（见 §2 末尾）。

---

## 7. 未验证与风险（不要把本文当定论）

1. hero 文案没有做用户测试（`[inf]`）：A/B/C 的取舍基于"差异化在哪"的判断，不是转化数据。
2. "30 秒"目标未在冷启动 + 首次 setup + 真实 provider 条件下端到端计时；现有实测为单次 run 17–75 秒、
   resume 1–17 秒，冷启动另计（首次 `npm i -g` 的耗时未测）。
3. 对比表（第 8 节）需要先核对竞品当前版本的事实，本文只给"该放哪四行"，没有替竞品下结论。
4. 移出清单里的目标文件名是建议，最终应与现有 `docs/` 结构合并（例如 `docs/install.md` 可并入
   `docs/getting-started.md`），不新增一套平级目录。
5. 本文没有复核 README 中全部事实（例如 45 工具之外的其他数字、命令示例里的每个 flag）——已核过的
   两处（工具数、`--goal`）说明"需要一次全量示例回归"，不代表只有这两处错。

---

## 8. 并行重写稿评估（工作区未提交稿：README 170/179 行，2026-11-06 02:33）

写这份批判期间，工作区里已经出现了一份并行重写稿（未提交）：`README.md` 170 行、`README.en.md` 179 行，
新增 `docs/install.md`、`docs/cli-reference.md`、`docs/safety.md`、`docs/rdk-board-deps.md`、
`docs/assets/demo-run.svg`，并在工作区新增了 `moss run` 子命令（`src/cli/command-dispatcher.ts:307`，
`dispatchVerifiedRun(ctx, ['run', ...])`，即 `moss task run` 的短形式）。它和本文提案方向一致
（9 节：`为什么是 Moss / 上手 / 手感 / 能力 / 连真机 / 与最佳产品的关系 / 质量 / 文档 / License`），
所以下面按"10 个问题是否已修 / 还差什么"给出可执行的收尾清单。

### 8.1 十个问题的修复状态

| #   | 旧问题                 | 新稿状态 | 证据（新 README 行号 / 文件）                                                                                                                                   |
| --- | ---------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| A1  | 首屏无 demo            | **已修** | 17–35 行：3 条命令 + `docs/assets/demo-run.svg` + 一次真实运行片段（`Task … PASS`）                                                                             |
| A2  | 前 175 行是安装        | **已修** | 安装压到 56–64 行，其余进 `docs/install.md`；产品定义提到 37 行                                                                                                 |
| A3  | 能力像 changelog       | **已修** | 100–118 行分 4 段（写代码 / 长任务 / 扩展 / 嵌入），SDK 0.x 迁移说明已移出                                                                                      |
| A4  | 无对比与心智模型       | **已修** | 37–54 行五步链 + 状态机；134–146 行对比表（Moss / Claude Code / Cursor）                                                                                        |
| B5  | 旧数字与 `--goal` 示例 | **已修** | 102 行 `51 个内置工具`、104 行 `13 个设备工具`；示例改为 `moss run "<意图>" --accept`（位置参数，`moss run` 已在工作区实现）                                    |
| B6  | 中英两套事实           | **部分** | 两版都重写了，但 zh 9 节 / en 10 节（en 多 `## Support matrix`，161 行）；zh 徽章 `#支持矩阵`（11 行）**指向已不存在的标题**（en 的 `#support-matrix` 有效）    |
| B7  | O-issue 泄漏           | **已修** | 两版 grep `O[0-9]{2,3}` 均为 0；细则进 `docs/safety.md`                                                                                                         |
| B8  | 安全节写成风险清单     | **部分** | 旧节已移除、细则进 docs；但新稿**没有任何安全摘要**（默认 full 的边界 / `--read-only` 上限 / 毁灭性设备确认 / 无遥测），只在对比表 142 行出现"无账号无遥测"     |
| C9  | 没有 30 秒被验证结果   | **已修** | 76–81 行"第一个被验证的完成" + `moss task status --json`                                                                                                        |
| C10 | 手感缺失               | **部分** | 83–98 行有 7 行手感表（含 Ctrl+C 暂停、`/goal resume`、`[task-state]` 延续）；缺 run 生命周期分段、失败三条路（改 oracle / 加预算 / 修环境）、headless exit 130 |

### 8.2 新稿里需要修的 5 处（建议按此顺序）

1. **`/rewind` 语义写反了（信任问题，最高优先）。** 新稿 92 行 `回到检查点，对话与结论保留`，en 91 行
   `Back to a checkpoint with the conversation and conclusions kept`。但 B93 的语义是 `/rewind` 在恢复文件后
   调 `agent.rewindConversation` **回滚对话**并报告丢弃的消息数（brainstorm §3 S1/§5.2："退出后新进程同 session
   复验仍答 BANANA" 证明对话确实回到检查点）。应改为"文件与对话一起回到该检查点（之后的消息被丢弃）"，
   否则用户会以为对话不会被改，撤销后对上下文感到意外。
2. **zh 徽章死链。** 11 行 `[![Platforms]…](#支持矩阵)`，而新 zh 已无"支持矩阵"标题 → 点击无效；
   en 有 `## Support matrix`（161 行）所以 en 正常。二选一：zh 补一节（3 行表）或改徽章指向
   `docs/release-policy.md#support-matrix`（若存在锚点）。同时把 zh/en 节数对齐（9 vs 10）。
3. **缺 2–3 行安全摘要。** 机器人用户的前置信任条件是"默认 full 到底问不问、`--read-only` 是不是硬上限、
   毁灭性设备操作是否仍确认"。建议在"连真机"（或"为什么是 Moss"）后加 3 行 + `docs/safety.md` 链接，
   不要只把安全放在文档地图里。
4. **缺"已知边界"（3–5 行）。** 至少写：`workspace-write` 不是 OS 沙箱（shell 无隔离，可选 sandbox 见 docs）、
   未验证/未完成都是 exit 9（末行区分）、子代理与后台编辑不进 checkpoint、Windows 无 PTY smoke。
   新稿把这些全删了，等于把"诚实"这一优点也删了。
5. **两处绝对化措辞要收回或给证。** ① 25 行 `一次真实运行（deepseek-flash，本机，约 11 秒）`——11 秒是
   单次实测，建议括注日期/命令或写成"约 10–20 秒（视 provider）"；② 156 行 `每个用户可见行为都有可复跑的
探针`——"每个"无法证，改成"关键行为有可复跑探针（`scripts/verify/stages/*`，含 PTY 与离线任务引擎）"。

### 8.3 与本文提案的取舍

- 新稿 9 节是本文 12 节预算内的合理合并（把"完成定义"并进"为什么是 Moss"，把"安全/边界"外移到 docs）。
  若要保留本文的 12 节结构，则 zh/en 都要多 3 节；从 170 行现状看，**建议接受 9 节**，把安全摘要与已知
  边界各压成 3–5 行插入现有节，而不是恢复成独立大节。
- 若采用新稿的 `moss run`：必须确认它是**同一提交**落地（工作区已有 `command-dispatcher.ts` 的 `run` 分支），
  并把 README 示例纳入 §6 的"示例可执行性校验"，否则下次 `moss run` 若被改名/回退，README 就是新的 B5。
- 新稿的对比表（134–146 行）把竞品"完成判定"简化为"模型判断/hook"，属于产品叙事；建议加一行脚注
  "对比基于 2026-11 公开文档，逐项可核对"，避免变成又一处无法验证的断言。
