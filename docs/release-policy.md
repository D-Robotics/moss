# Moss 发布策略：版本、tag 与证据口径

> 决策日期：2026-10-01。取代 `docs/superpowers/plans/2026-09-30-moss-v014-v020-roadmap.md`
> 中"每版独立硬验收门、缺一不发 tag、上一版未过门下一版不开工"的链式发布约定。

## 决策

1. **main 是滚动线。** 能力持续累积进 main；`package.json` 的版本号表示**当前能力级别**，
   不表示某个被单独验收并发过 tag 的版本。
2. **semver（0.x）**：新增导出、向后兼容扩展 = minor；删除/重命名/行为破坏 = 在提交说明里
   显式写"破坏性变更"。SDK 公共面仍由 `test/sdk-contract.spec.mjs` 快照锁定。
3. **tag 只在有真实证据时打。** 打 tag 前必须：`npm run verify` 全绿（check + 全部 spec + PTY smoke）、
   `npm run examples` 三例实跑通过。tag 说明里必须写清**跑了什么、没跑什么**。
4. **不为从未验收的中间版本补打 tag。** v0.14.0–v0.20.0 永久不补：它们的门（SWE-bench 三跑、
   确定性对、T-Bench 基线、v0.20 全量 bench 复跑）从未执行，补打等于伪造发布证据。
5. **退役的门可随时复活。** 9 个验收脚本移入 `.autopilot/acceptance/retired/`，命令与状态
   逐条登记在 `.autopilot/acceptance/retired/README.md`；哪天门跑完，就按本文件第 3 条主张对应版本号。

## 为什么改口径

`2026-09-30-moss-v014-v020-roadmap.md` 的 E1 已经记录过一次版本欠账（tag 止于 v0.9.0 而
package.json 已 0.13.0）。v0.14–v0.20 期间欠账扩大：代码交付到 v0.21（TUI Mission Control +
统一 Task OS），`package.json` 仍写 0.13.0，中间 8 个版本既无 tag 也无证据，9 个门脚本
停留在 `.autopilot/acceptance/pending/`，夜报正文是"待填"占位。

两种修法：

- **补证据**：需要外部榜单基础设施（Docker 宿主 + SWE-bench official harness + 100 实例三次跑 +
  Terminal-Bench 40 任务 + 数据集/镜像配额），当时未执行，现在仍不具备等量条件。
- **改口径**（本文件）：滚动 main + 单点版本，把"我们主张什么"收缩到当前真实证据能支撑的范围。

选择后者：证据不足时缩小主张，而不是补齐文字。

## 当前主张（2026-10-08，v0.26.0）

- **版本**：`0.26.0`。该版本在 v0.25（只读 fleet + TUI 双语）之上交付权限模型重构（v0.26 计划见
  `docs/superpowers/plans/2026-10-08-v026-permission-model.md`，系统设计见同目录
  `2026-10-08-v026-architecture.md`）：
  - **默认全开**：无任何权限配置时默认模式为 `full`（full-access + never + device_mutation 放行），
    对齐 Claude Code 出厂哲学；解析链 overrides > env 兼容键 > permissions 块 > 旧键迁移（读侧一张表：
    cautious→manual+read-only 上限、balanced→manual、autonomous→full、trustedTools→allow 规则、
    deniedTools→deny 规则）> 默认 full。
  - **四态模式引擎**：`manual | acceptEdits | plan | full`（`default` 保留为 manual 别名）；
    `deriveEngineQuantas` 单点派生 safetyMode/approvalPolicy/deviceMutationPolicy；Shift+Tab 四态循环，
    full 徽章黄色 ⏵⏵ 无后缀（默认态）。
  - **规则引擎**：`/permissions` 三级规则 allow/ask/deny，决策序 deny > 模式 ceiling > ask > allow >
    兜底询问，唯一实现于 `permission-rules.ts`（纯函数）；deny 在任何模式含 full 下都赢；规则
    `ToolName(pattern)` 语法（moss 原生工具名）；会话级规则（`/permissions add` 与 'a'）下一个
    工具调用即生效；`/permissions persist` 写用户配置。
  - **硬底线保留**：危险命令（rm -rf / 等）与路径逃逸在 full 模式下仍拦；deny 规则同。
  - **幽灵清理**：/yolo 与 fullPower 旁路退役；`--ask-for-approval=on-request` 显式报错；
    安全 flags 收编为模式覆盖。
  - **SDK 快照零变更**：`src/index.ts` 公共面不动，`test/sdk-contract.spec.mjs` 快照未改。
- **已跑、可主张**（本版证据，2026-10-08 工程会话实测）：
  - `npm run build` / `npm run typecheck` 全仓绿；`npm run format:check` 全绿（本会话提交文件均过
    prettier）；改动 src 文件 eslint 0 warning（全仓 `npm run lint` 在本机因 WorkBuddy node-fs-shim
    的 IPC EPIPE 崩溃，homebrew node 直跑改动文件 0 warning——CI 兜底）。
  - 全量 spec：**200 个文件逐一实跑，197 绿**；3 个红为本机环境预存 flake（`cli-config` 并发加密
    EEXIST、`jsonl-session-store`/`session-write-lock` 沙箱 BROKER_DENY——在干净 stash（改动前代码）
    复现同样失败，非本版引入；`npm run verify` 因此在本机 exit 1，CI 待跑）。
  - `npm run examples`：三例实跑通过（含 custom-tool-approval 的 ALLOW/DENY 审计轨迹）。
  - `npm run smoke`：--version / --help / PTY 启动全绿。
  - PTY 取证（`scratch/tui-drive.py` + `--mock` stub provider，pyte 屏幕重建）：四连 shift+tab 实测
    manual（带后缀）→ accept-edits（带后缀）→ plan（带后缀）→ full（黄色 ⏵⏵ 无后缀）→ 回 manual
    （`scratch/tui-pts/cycle2/`，截图不入库）。
  - headless 行为取证（stub 驱动，`scratch/t05-headless-evidence.mjs`，不主张真实模型行为）：
    默认解析 full ✓；full 模式普通 exec 无审批卡点 approved=true ✓；`rm -rf -- /` 硬拦
    （"禁止递归删除根目录"）✓；`deny read_file(./.env)` 规则增后下一调用即拦 ✓；remove 后恢复
    放行 ✓。
  - TUI 徽章/循环、规则引擎矩阵、/permissions 管理面在 spec 层全绿（tui-modes、permission-rules、
    cli-permission-mode-engine、cli-permission-defaults、permissions-command）。
- **未执行、因此不主张**：
  - PTY 全套回归面（`docs/cli-parity/v026-regression-surface.md` 的 P2-P7 与 R1-R5 清单——
    device_exec 在 full 下放行的真机/PTY 级验证、/permissions TUI 交互级往返、双 locale 一致性、
    v0.23-v0.25 命令族回归）——清单已交付，执行归 QA。
  - 真实模型驱动的 headless 全链（本环境无 provider 凭据，stub 驱动不主张模型行为）。
  - `npm run verify` 的 CI 级全绿（本机 3 个环境 flake 阻断，见上；CI 矩阵待跑）。
  - 真机（非 in-process SSH）设备闭环（同 v0.25 口径）。
  - SWE-bench/Terminal-Bench/全量 bench 复跑（同 v0.23 口径）。

## 上一版主张（2026-10-02，v0.25.0）

- **版本**：`0.25.0`；tag `v0.25.0`。该版本在 v0.24（诚实度 + 子命令双语）之上交付只读多设备
  fleet、TUI 自有 chrome 双语与任务摘要 locale 一致性（v0.25 计划见
  `docs/superpowers/plans/2026-10-02-v025-fleet-tui-locale.md`）：
  - **Fleet MVP（只读）**：`moss device fleet <probe> --devices id1,id2` 按注册表 `deviceId` 选设备，
    有限并发（默认 4）、结果镜像输入顺序、聚合为 all-pass/partial/all-fail 三态；每条结果带
    `deviceId`/endpoint/status/error-or-result；单台失败不抹掉同伴，取消只会把未完成设备标 fail、
    绝不报 pass；复用现有连接注册表/退避/SSH 信号量，写操作不 fan-out（无 fleet 写、无隐式全表扇出）。
  - **TUI 自有 chrome zh/en**：`cli-main` 显式把 locale 传入 TUI，zh 下翻译 Moss 自己的固定文案
    （帮助、键位提示、`/` 面板含命令目录描述、resume 选择器、审批/提问页脚、启动状态、任务裁决提示、
    composer/模型选择器、transcript 固定状态词、底部提示）；英文态字节级不变；命令名/键位/路径/
    模型名/skill-MCP-工具名/用户输入/模型与 shell-git-MCP 原始输出一律不翻译；不引入 i18n 框架。
  - **任务摘要 locale**：`summarizeTaskRun(result, locale?)` 支持 zh/en，默认英文（不破坏 SDK 调用者）；
    `moss task run/resume` 传 CLI locale；`PASS/FAIL/BLOCKED` token、task id、命令、路径、裁决文本不翻译。
- **已跑、可主张**：
  - `npm run verify`：format/lint/typecheck + 200 个 spec 文件 + PTY 冒烟全绿。
  - `npm run examples`：三例实跑通过。
  - 真实 headless 取证：同一 task fixture 在 `LANG=en_US.UTF-8` 与 `LANG=zh_CN.UTF-8` 下跑
    run/status/resume；`PASS/FAIL` token、task id、计数两态一致，固定标签按 locale 变化。
  - 真实 PTY 取证（zh locale，24×120）：TUI 壳启动（`⏸ 默认已开启 · ? 查看快捷键 · N 个任务`）、
    `/help` 全中文（含命令描述）、`/` 面板描述中文化、`/task status` 中文化但 task id 原样、
    未知命令提示中文；命令 token 与原始输入未翻译。
  - fleet 取证：两个 in-process SSH 设备 + 一个拒绝凭据的真实设备，实跑观察到
    all-pass / partial / all-fail 三态，每条结果带 deviceId，非全通退出 1，取消不报 PASS
    （`test/device-fleet-readonly.spec.mjs`，8/8）。
- **未执行、因此不主张**：SWE-bench/Terminal-Bench/全量 bench 复跑（同 v0.23 口径）；
  真实多设备硬件闭环（in-process SSH 与受控 fixture 只证明协议/调度行为，不主张硬件集群能力）；
  设备自动发现、健康自动摘除、fleet 写操作、跨设备 acceptance 聚合（v0.25 non-goals）。

## 上一版主张（2026-10-02，v0.24.0）

- **版本**：`0.24.0`；tag `v0.24.0`。该版本在 v0.23（能力层可用性）之上交付诚实度+信任传递
  与子命令层双语（v0.24 计划见 `docs/superpowers/plans/2026-10-02-v024-honesty-i18n.md`）：
  - 信任修复合并自 prod/ux-hardening 线：F23 非交互审批拒绝文案继承到子代理（委托
    create_subagent / fan_out 重试同一调用同样被拒，堵住"换条路绕过审批"的口子）；
    F24 `exists` 比较语义修复（证据模型按真实内容判 PASS/FAIL，拒绝字符串拼凑误判）。
  - `moss device|mcp|skill|task` 四命令族 zh/en 双语：usage 块、错误路径、成功输出、
    空态按终端 locale 渲染（isZhLocale 三元分支，无 i18n 框架）；实体名、命令、机器 token
    不翻译。task status 视图列标签双语且保持 10 列对齐（任务/目标/阶段/…）。
- **已跑、可主张**：
  - `npm run verify`：format/lint/typecheck + 198 个 spec 文件 + PTY 冒烟全绿（每批独立过门：
    批次 1 合并提交 331a26c2、批次 2 提交 396f94e1、批次 3 提交 8d7e8ea7）。
  - `npm run examples`：三例实跑通过。
  - 双语真实运行取证：四命令族在 LANG=zh_CN.UTF-8 与 en 两态 headless 实跑（空态/错误/
    成功路径）；`moss task status` zh 视图对真实快照渲染（任务/目标/阶段/尝试/裁决 列对齐）。
  - PTY dogfood（zh locale）：TUI 壳正常启动；`/task status` 在会话内输出中文空态
    （探针：python3 PTY 24×120、离线 provider 配置、无真实凭据）。
  - 合并线新增 spec 实跑：subagent-approval-inheritance（F23）、evidence-model（F24）。
- **未执行、因此不主张**：SWE-bench/Terminal-Bench/全量 bench 复跑（同 v0.23 口径）；
  TUI 全壳 zh（本版 non-goal，TUI 面板文案仍为英文）；多设备 fleet 编排（推迟到 v0.25）；
  真机设备全链（需凭据时人工执行）。

## 上一版主张（2026-10-02，v0.23.0）

- **版本**：`0.23.0`；tag `v0.23.0`。该版本在 v0.22（精简发布）之上交付能力层可用性
  （v0.23 计划见 `docs/superpowers/plans/2026-10-02-v023-capability.md`）：
  - `moss mcp add|list|remove|test`：MCP 生命周期命令（写用户/项目两级 mcp.json，写前校验，
    test 走真 initialize+tools/list）；掉线服务器在下次调用懒重连一次（显式 closeAll 不复活）。
  - `moss device add|list|remove|test`：`.moss/devices.json` 注册表（凭据只存 env 引用名，
    写入即拒绝明文密钥）；解析级联 host > env > registry；test 走真 SSH + 身份探测。
  - `moss skill create|list`：SKILL.md 脚手架（含 $ARGUMENTS 提示）；skill 工具接受 {args}
    注入占位符；会话级 body 缓存（mtime 失效）；/skills 浏览命令（REPL+TUI 同源）。
  - Ghost 清理：/learn 预留名、skill-learning 注释、.moss/skills/learned 计数。
- **已跑、可主张**：
  - `npm run verify`：format/lint/typecheck + 全部 spec 文件 + PTY 冒烟全绿。
  - `npm run examples`：三例实跑通过。
  - 四命令族全部真实运行取证（mcp：add→list→test 50 工具→remove；device：add→registry 落盘→
    list→test；skill：create→list→调用注入）。
  - in-process ssh2 真协议握手（device test 正/反路径）；stdio MCP fixture 真连与懒重连；
    /skills PTY 交互取证。
  - 新增 bench 任务 `domain:skills`（skills-usage：create→discover→inject）。
- **未执行、因此不主张**：SWE-bench/Terminal-Bench/全量 bench 复跑（同 v0.21 口径）；
  真机（非 in-process SSH）设备全链——需设备凭据时另行人工执行（AGENTS.md 纪律）；
  MOSS_LOOP 系 bench 复跑。

## 上一版主张（2026-10-02，v0.22.0）

- **版本**：`0.22.0`；tag `v0.22.0`。该版本在 v0.21（Mission Control TUI + 统一 Task Runtime）之上
  交付全软件精简专项（16 个提交，`ab2e8279…9edd9889`，对账见
  `docs/superpowers/plans/2026-10-02-simplification-v2.md`）：
  - 单一来源：命令目录（REPL/TUI 同表投影）、配置快照（config-snapshot.ts 三视图）、
    环境变量权威清单（`moss config env`，src 扫描双向 CI 锁）、自主循环引擎（/loop /goal
    翻译到 /task run，PASS 只来自 verdict provider）。
  - 人眼版默认视图：/status 6 行、/permissions 5 行、brief help 12 行、TUI 命令面 32→24、
    只读工具结果折叠、运行尾行去 token 遥测。
  - 审批免询问：'a' 持久化（exec 入信任、编辑族一次覆盖、重启生效）；术语与遥测全进 --verbose。
- **已跑、可主张**：
  - `npm run verify`：format/lint/typecheck + 194 个 spec 文件 + PTY 冒烟全绿（精简专项每批独立过门）。
  - `npm run examples`：三个嵌入示例实跑通过（含审批 ALLOW/DENY 审计轨迹）。
  - PTY 交互级 dogfood 两份：通用壳（banner/permissions/task view/jobs/对话轮/退出）与
    引擎合一（/goal --accept → 命令裁决 PASS → accepted → /task status → /loop resume），
    证据 `scratch/dogfood-tui.log`、`scratch/loop-unify.log`（scratch/ 不入库）。
  - CI：v0.22.0 tag 时点 main 上全部 run 绿。
- **未执行、因此不主张**：SWE-bench Verified 三跑、确定性对、Terminal-Bench 基线、全量 bench 复跑
  （同 v0.21 口径，退役门登记于 `.autopilot/acceptance/retired/`）；behavior 层 prompt 压缩
  （待 bench 背书）；safety 解析双链合并（显式遗留）。

## 上一版主张（2026-10-01，v0.21.0）

- **版本**：`0.21.0`；tag `v0.21.0`。该版本覆盖两条已合并的线：
  v0.21 Mission Control TUI + 统一 Task Runtime（Task OS）。
- **已跑、可主张**：
  - `npm run verify`：format/lint/typecheck + 171 个 spec 文件 + PTY 冒烟全绿。
  - `npm run examples`：`examples/` 三个嵌入示例实跑通过。
  - Task OS 三类任务基准 3/3（A 编码 / B 真机设备 / C 故障修复），记录在
    `docs/superpowers/plans/2026-09-30-moss-task-os.md` 与 `bench/results/`（不入库）。
  - v0.13.0 全量基准（easy 100 / hard 93.9）为上一版历史证据，见 `.autopilot/PROGRESS.md`。
- **未执行、因此不主张**：SWE-bench Verified 100 实例的 base2 / v015goal / v016 三跑、
  确定性对、Terminal-Bench 基线、v0.20 全量 bench 复跑、v0.12 三臂 A/B 的第三臂。
  这些项在文档里一律标注"未执行"，不得转述为"已通过"。

## 撤销 / 回到严格链式发布

```bash
git tag -d v0.21.0                    # 撤销本口径的 tag
git revert <本策略的提交>              # 回到候选状态
node .autopilot/acceptance/retired/<gate>.sh   # 逐门执行，跑完再主张版本号
```
