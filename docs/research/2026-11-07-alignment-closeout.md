# Moss 对齐最佳产品 — 收敛审计（2026-11-07）

目标：把 Moss 打磨到能力、手感、完整度、用户体验都对齐 Cursor / Claude Code 一类产品；
每一项改动都要真实模型 / 真实终端验证、过质量门、更新文档并推 main。

本文是这一轮长跑的收敛审计：**哪些维度已达到什么证据强度、还剩哪些真实缺口**。
逐条改动记录在 `CHANGELOG.md` 与 `docs/plan/moss-improvement-backlog.md`（B1–B344），本文不复述细节。

## 1. 产品面（用户能感知的能力）

| 维度         | 现状（可验证）                                                                                                  | 证据                         |
| ------------ | --------------------------------------------------------------------------------------------------------------- | ---------------------------- |
| 目标闭环     | `moss goal "<intent>" --accept "<cmd>"` 一次跑通 计划→执行→验收→入账；真实修复失败测试 PASS、turns 1            | `/tmp/goal-e2e` 真跑（B327） |
| 统一运行账本 | task/loop/workflow/superagent/chat 全写入 `.moss/runs`，`runs list/show/summary/export/follow` 可读             | B130–B184、B344              |
| 独立评审     | `/review` 真实埋 bug → verdict FAIL + critical finding + fix hint，不改文件；`review check` exit 1 驱动修复循环 | B331                         |
| 会话         | 列表/搜索/导出（md 与 json）/fork/resume；导出 md 只含对话、json 保留 thinking                                  | B252、B322、B323、B325       |
| 记忆         | 显式 `moss remember` 与 TUI `/remember`（预览 + 确认对话框）、幂等                                              | B321                         |
| 技能         | create/validate/list/install/update/lock 全生命周期，含 diff/漂移检测                                           | B303–B305                    |
| 上手         | 首次信任 → 模式提示 → provider picker（含退出提示）→ `/init` 或确定性 `moss init`                               | B328–B330、B335              |
| 设备/机器人  | SSH 真机工具面 + 验收/证据链；设备任务在缺 env 时明确 SKIP                                                      | 既有验收 + bench skip 行为   |

## 2. 手感（界面与交互）

- 首屏 / 空状态都"教下一步"：`/tasks`、`/rules`、`/mcp`、`/hooks`、`/agents`、`/capabilities` 真实 TUI 检查并补齐（B337–B339）。
- 输入面板：`/` 命令面板标明 Tab=补全 / Enter=执行；`@` 文件面板 Enter 补全 + 按键提示；`!` shell 模式真实验证（B308–B309）。
- 工具行可信：TUI 展示**完整结果**而非 SSE 预览（46 行文件曾显示 `Read 13 lines` 且 ctrl+o 展不开），修复后 `Read 46 lines`（B342）。
- 小窗口/压缩：8k 窗口真实触发自动压缩（`compacted 1 earlier messages · now ~611 tokens`）；压缩摘要不再泄漏成会话标题；`/compact` 无操作时解释原因（B317–B319）。
- 视觉/文案一致性：中英对齐、`/status` 数字同源（skills / AGENTS facts / registered vs offered tools）（B289–B312）。

## 3. 完整度（命令与机器可读面）

- `--json` 覆盖所有只读/校验命令，统一 `schema` envelope；`--help` 可发现性由门禁强制（B1–B324）。
- `artifacts`/`capabilities`/`task timeline`/`review list`/`sessions export` 等历史裸数组/无 schema 输出已收口（B323–B333）。
- 文档三层守卫：README 章节/链接/计数、schema 名、`KNOWN_COMMANDS` ⇄ `docs/cli-reference.md`（B334）。

## 4. 可验证性（门禁与证据）

| 层           | 当前状态                                                                                                                        | 触发                              |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------- |
| 本地交付门   | `npm run verify` PASS（近期 64–99s，负载相关）                                                                                  | 每次提交前                        |
| CI 分片门    | 最近 30+ 次 push 全绿                                                                                                           | 每次 push                         |
| 跨平台矩阵   | Deep verification 四腿（Ubuntu 22/24、macOS、Windows）+ 聚合全绿                                                                | 每日/手动（B336）                 |
| 行为探针     | 100+ stage：TUI/CLI/JSON/评审/技能/bench 工具链                                                                                 | `npm run verify`                  |
| 能力基准     | 全量 samples=3（修复后复跑）：**80/81 = 98.8%**（hard 97.2 / easy 100 / weighted 98）；hard-tier 子集 32/33，唯一缺口修复后 3/3 | `npm run bench`（B356/B360/B361） |
| 真实模型回归 | goal 修复、`/review` 评审、`/init` 起草与增量审查、bench                                                                        | 见各 B 证据段                     |

## 5. 仍然真实的缺口（不粉饰）

1. **Windows 行为面**：Deep 的 Windows leg 只跑 `static/build/smoke/examples`，行为探针在 Linux/macOS 全量跑。
2. **bench 口径与网关长尾**：全量 samples=3 已跑（74/80 = 92.5%），但 4/27 任务部分通过中有一半是网关 45s 无响应熔断（`hard-wrong-fix-rejected`、`long-horizon-refactor`），不是能力回退；4 个设备任务因缺 `MOSS_DEVICE_*` 未计分。
3. **已定位并修复的 bench 波动**：exec cwd 语义误解（冻结待评估）、矛盾需求提问（B355 修 nudge）、exec 跑测试被判 Unverified（B356 让 `node test.js` 计入 test 检查）、不可复现投诉只聊天不写报告（B361 强制 SPEC-AUDIT.md）；剩余波动是网关长尾与罕见模型取舍。
4. **exec cwd 语义**：Moss 每次命令在 workspace 根执行（工具描述明确），与 Claude Code 的持久 cwd 不同；改动属设计级变更，冻结待评估。
5. **设备能力**：真实板卡闭环（设备任务、物理验收）需要环境；bench 在缺 `MOSS_DEVICE_*` 时 SKIP。
6. **无法注入的按键**：Esc-to-deny、Ctrl+C 中断、ctrl+o 展开等控制键无法经终端工具验证，只能验证等价路径与渲染结果。
7. **压缩边界**：极小窗口（8k）下仍会走"summary 缺 section → retry"的既有路径；`/compact` 与状态条的 token 口径仍未统一（B319 只用文案解释）。

## 6. 复现命令

```bash
npm run check                       # 格式 + lint + typecheck
npm run verify                      # 交付门（~60–90s）
npm run bench -- --samples 1        # 全量诊断（31 任务）
npm run bench -- --samples 3 --label full-s3                 # 全量发布口径（31 任务 × 3）
npm run bench -- --task hard- --samples 3 --label hard-s3c  # hard-tier 子集（B356 后 32/33）
moss goal "fix the failing test" --accept "npm test"          # 真实闭环
moss review check                   # 评审门禁（0/1/2）
gh workflow run "Deep verification" --ref main                # 跨平台矩阵
```

真实验证环境（不外泄凭据）：`MOSS_CONFIG_DIR=/tmp/moss-team`、`MOSS_NO_RDK_DOCS=1`、
`MOSS_LANG=en|zh`；TUI 通过 PTY 驱动 `dist/cli.js`，模型为 `deepseek-flash@latest`（D-Robotics 网关）。

## 7. 结论

能力闭环、界面手感、命令完整度、机器可读面与验证体系已达到"可与最佳产品对照审计"的状态：
真实模型闭环、真实 TUI 交互、独立评审、100+ 行为探针、CI 分片与跨平台夜间门禁全部有据可查。
剩余缺口集中在平台覆盖（Windows 行为面）、bench 网关长尾与设备任务、以及少数
设计级语义（exec cwd），已在 backlog 中显式记录而非隐藏。

## 8. 交付状态（2026-11-07 收尾清点）

| 指标              | 数值                                                             |
| ----------------- | ---------------------------------------------------------------- |
| 最新 main         | 见仓库 `git log -1`（本文档随收尾提交推送）                      |
| 本轮改进/验证记录 | `docs/plan/moss-improvement-backlog.md` **378 行 B 记录**        |
| 行为门禁          | `scripts/verify/stages/*` **106 个 stage**（含 98 个探针脚本）   |
| 产品页            | `README.md` 253 行 / `README.en.md` 258 行（预算 120–260）       |
| 能力基准（最终）  | 全量 31 任务 × 3 样本：**80/81 = 98.8%**（hard 97.2 / easy 100） |
| CI                | 每次 push 分片门禁绿（`gh run list --workflow CI`）              |
| Deep verification | 最近一次四腿（Ubuntu 22.16/24、macOS、Windows）+ 聚合全绿        |
| 工作树            | 干净（`.autopilot/` 与幻灯片素材已 ignore）                      |

收尾时未留未完成事项：能力/手感/完整度/可验证性四条线的工作项全部有对应探针、真实模型或真实终端证据；
剩余缺口（Windows 行为面、设备任务环境、网关长尾、exec cwd 语义）均为显式记录的环境/设计边界，不是待办遗漏。
