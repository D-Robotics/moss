# Moss 全软件精简 v2 · 执行计划（2026-10-02 拍板）

决策 A–G 全部按推荐执行。主线 D1–D6 + 弹性 D7–D10；每批：实现与测试同 commit、真实运行取证、`npm run verify` 绿后合 main 并过 CI。

## 总目标

新用户从敲下 `moss` 到完成第一个任务，默认路径零重复信息、零参考手册噪音；专家诊断按需可达；代码层同一事实只有一个来源。参照系：Grok Build（xai-org/grok-build，Apache-2.0）——抄其"两步首启/只写覆盖值/单一模糊菜单/工具行折叠/终端原生色"，拒绝其"58 命令/396 配置键/8 层优先级/6 权限模式/8 扩展机制"。

## 量化验收

| 指标                           | 基线               | 目标                      |
| ------------------------------ | ------------------ | ------------------------- |
| 配置快照块代码份数             | 3                  | 1（renderConfigSnapshot） |
| --help --all                   | ~110 行            | ≤60                       |
| moss config 用法（错误路径）   | 37 行              | ≤14                       |
| setup 成功输出                 | ~11 行             | ≤5                        |
| 首启引导链                     | ~19 行、setup×3    | ≤8 行、setup×1            |
| REPL 编辑 diff 上限            | 24 行              | 14（与 TUI 共享常量）     |
| 权限概念默认入口               | 三轴 5 入口        | 1 轴 3 态（/mode）+deny   |
| TUI/REPL 命令数                | 32/22              | ≤24/≤18                   |
| system prompt 层 token         | D9 审计基线        | −20%                      |
| 帮助文本中 config set 示例份数 | 4                  | 1（moss config --help）   |
| 环境变量文档                   | 帮助 9 个/实际 ~80 | moss config env 权威清单  |

## 批次清单（可逐项 grep/运行验证）

- **D1 状态快照单源化**：src/cli/config-snapshot.ts 新建 renderConfigSnapshot；收编 onboarding.ts（/status --verbose、/permissions --verbose）与 setup-wizard.ts（auth status）三份快照；renderCliSessionDoctor 委托 doctor.ts 行格式（ok/warn/fail 前缀不动）；setup 双成功打印器合一；guardrails 计数合一；修 cli-main.ts:516 MOSS_API_KEY 误导（该 env 被 config.ts 忽略）。测试：三视图逐字同源断言。
- **D2 帮助与 config 面收敛**：PERMISSIONS_HELP_TEXT→安全语义 4 行+指针；renderConfigUsage 错误路径 ≤14 行；--help --all ≤60 行；EXPECTED_USAGE 快照同 commit；行数上限断言防回弹。
- **D3 引导链+死代码**：首启 ≤8 行一条路径；删 renderProgressiveOnboardingTips、TUI_HELP_TEXT/buildTuiHelpText、repl-chrome 死导出；tui-utils 拆直连；零调用者 grep 证据入 commit；PTY 取证。
- **D4 TUI/REPL 呈现+折叠**：空 ok 双行→1；删 resumed replayed 行；banner 3→2；REPL diff 上限 24→14 共享常量；连续只读工具折叠一行+编辑 diffstat；zh-only 错误串修复（chrome 统一英文，模型回复随 locale）；PTY 对比 Claude Code 取证。
- **D5 概念面收敛**：/task view [tasks|history|evidence|deployments|failures] 合并（旧 token 隐藏别名、Ctrl+T/V/G/F 映射合并视图）；/bg+/subs→/jobs；无 reader knobs（agent.budget.\*、bestOfN、reasoningBudget、modelTiers）从帮助除名；新增 moss config env；命令数 ≤24 断言。
- **D6 全链验收**：dogfood（停滞可见/不重复/行具名/日志可追溯）+ verify + examples 实跑 + 15 面改前/改后对比表。
- **D7 loop/goal 归一**：/loop /goal→/task run 别名；LoopScheduler journal/resume 与 MOSS_LOOP_MAX/MOSS_GOAL_AUTO_MAX_RUNS 帽保留生效；oneshot spec 迁移。
- **D8 权限单轴化**：默认只露 /mode 三态+deny；profile 退场至 --verbose；--ask-for-approval 双枚举仅帮助写清（不拆 flag）。
- **D9 模型面 token**：prompt 各层行数基线→−20%；工具描述"一句职责+一句边界"模板；渐进披露结构保留。
- **D10 输入/错误/设备**：unknown command 与 provider 错误统一 ≤3 行+一条下一步；MOSS*DEVICE*\* 首启一行化；极简回退终端原生色评估；headless JSON 输出核对。

## Non-goals（全程不动）

安全语义与 ceiling（balanced 默认、device_mutation 审批、fail-closed、路径逃逸/毁灭命令拦截）、SDK 公共面（src/index.ts 快照）、设备/工具保留名、Task OS 证据链与 verdict 语义、密钥与 shell 历史警告、doctor ok/fail 前缀、skills+MCP 之外的扩展机制（维持冻结）。

## 已落地产物（计入基线）

- ab2e8279：/permissions 默认 9 行 + --verbose；空 skills 提示层。
- 6d1797a0：REPL/TUI 命令目录合一（interactive-commands.ts 单目录 + surfaces 投影 + 防漂移不变量）。
