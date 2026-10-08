# Moss v0.26 规划：权限模型重构（CC 对齐：默认全开 + 规则管理器 + 四态循环）

> 决策日期：2026-10-08。基于 v0.25 真实代码取证（`src/cli/approval.ts`、`src/cli/config.ts`、
> `test/cli-permission-defaults.spec.mjs`、`docs/cli-parity/`）。用户已拍板四项决策（默认全开、
> device_mutation 全类开放、Shift+Tab 四态循环对齐 CC、/permissions 升级为规则管理器），
> 本文不做二次论证，只定义落地边界与验收。

## 问题本质

**默认 safe-by-default 与真实用户的摩擦。** moss 出厂默认 balanced（`workspace-write` +
`approvalPolicy: prompt`，`src/cli/config.ts:220-249`），但 moss 的核心产品主张是机器人闭环
Task OS（Goal→Deploy→Verify→Repair→Physical Acceptance）——这条链在默认配置下每一步写操作
都被逐次审批打断；headless/CI（`moss task run`、`--print`）里更糟：无 TTY 时审批直接拒批
（`approval.ts:1070-1087`），"闭环"在第一步就死。目标用户（RDK 中文开发者）实际用脚投票：
文档教的第一件事就是 `profile=autonomous` / `MOSS_CLI_AUTO_APPROVE=1` / `--full-access`。

**"机器人安全优先"承诺与现实已经不一致。** README/AGENTS.md 承诺 "device_exec 维持逐次审批"，
但这条承诺只对默认 balanced 用户成立：full-access / autonomous / `MOSS_CLI_AUTO_APPROVE=1`
任何一条通路都已放行 device_mutation（`approval.ts:987-990` fullPower、`1061` 直接 approved）。
逐次审批是"默认档的保护"，不是"产品级铁律"——文档措辞夸大了实际防线。

**CC 对齐的战略理由。** v0.22 已把 CLI 交互面拉平到 Claude Code 基线（196 行 spec、4 轮对抗
验收 SATISFIED，`docs/cli-parity/acceptance-report.md`）；权限模型是下一个差异源：CC 出厂
bypassPermissions + deny 规则与"任何模式都不自动批"清单仍生效——"默认全开 + 硬底线"是被
验证过的哲学。本轮 moss 对齐：默认全开、四态循环（manual → acceptEdits → plan → full）、
CC 式 /permissions 规则管理器（allow/ask/deny、deny 在任何模式含 full 下都赢）。

**交互债务三件：** 模式循环只有 3 态（无 bypass 态，`tui/app-helpers.ts:135` 显式注释"没有
第四态"）；/permissions 只是只读 5 行展示（`onboarding.ts:401-443`）；幽灵 /yolo 留在
`args.ts:245` INTERACTIVE_ONLY_COMMANDS 但全仓库无实现，却让 `cli-main.ts:594-596` 的
fullPower 机制挂着为它服务——一套为不存在的命令设计的旁路。

## Done 定义（分四批，每批独立过 `npm run verify`）

### W1：默认翻转 + 四态循环 + 徽章

- **默认模式 = full**：全新会话/新配置下，moss 启动即 full-access + approvalPolicy `never` +
  device_mutation 放行（对齐 CC bypassPermissions 出厂默认）。解析链：
  `overrides > env > config > default`，default 从 `balanced` 翻为 full 等价。
- **`CliInteractionMode` 四态化**：枚举 `manual | acceptEdits | plan | full`（`'default'`
  token 保留为 `manual` 的解析别名，兼容既有 `/mode default` 输入与会话恢复推断）。
  Shift+Tab 循环 `manual → acceptEdits → plan → full → manual`（TUI `app-helpers.ts`
  INTERACTION_MODE_CYCLE 扩为 4 项；REPL 无 Shift+Tab 键，经 `/mode` 命令可达同四态）。
- **徽章对齐 CC 形态**：hint 行常显模式徽章——manual `⏸`（灰）、acceptEdits `⏵⏵`（紫）、
  plan `⏸`（青）、full `⏵⏵`（黄，对齐 CC #ffc107 色调）；非默认态追加
  `(shift+tab to cycle)`。zh/en 双语文案同步（`tui/copy.ts`、`interaction-mode.ts` 标签）。
- **硬底线保留，一个不撤**：危险命令硬拦截（`isCommandDangerous`，rm -rf / 等）、
  路径逃逸拦截（`assertSandboxPath`）、deniedTools/deny 规则拦截。full 模式跳过的是
  _询问_，不是*检查*——对齐 CC "bypassPermissions 下 deny 与 never-auto-approve 清单仍生效"。
- **告警重校**：`auditResolvedCliConfig`（`config.ts:709-744`）现有 "auto-approval 警告"
  在新默认下会对每个出厂用户触发，改为只在 deny 清单为空 **且** 用户显式配置了
  device_mutation 放行规则时提示（或降为 info 级 doctor 展示）。

### W2：/permissions 升级为 CC 式规则管理器

- **三级规则**：`allow` / `ask` / `deny`，优先级 **deny > ask > allow**；deny 在任何模式
  （含 full）下都赢；ask 见"不确定性与决策"第 3 条。
- **Tool(pattern) 语法**：规则形如 `exec(npm run *)`、`read_file(./.env)`、`device_exec(*)`、
  `edit_file`（裸工具名 = 整工具）。工具名用 moss 原生名（exec/edit_file/device_exec/…），
  语义对齐 CC 的 `Bash(npm run *)`；匹配复用现有 micromatch 引擎
  （`approval.ts:835-850` findConfiguredToolPattern 的参数化扩展：pattern 匹配工具名，
  括号内 pattern 匹配主操作数——command / path / device command）。
- **规则来源显示**：每条规则标注来源文件——用户级 `~/.config/moss/config.json` vs 工作区级
  `.moss/config.json`（对应 CC 的 user/project settings）。deny 规则跨层级取并集；
  allow 不能解除另一层级的 deny（安全向合并，与现 `userConfig ?? projectConfig` 的
  user 优先语义一致）。
- **运行中可改、下个工具调用即生效**：/permissions 会话内增删规则，不需要重启
  （approvalHook 已闭包 liveRuntime 取值，规则表同样走 live getter）。
- **审批卡片升级**：选项 2 "Yes, and don't ask again" 从会话级信任升级为写一条 allow 规则
  （含 device_exec——现 `isSessionTrustEligible` 对 device 的排除被规则系统取代，
  `approval.ts:467-478`）；/permissions 界面可查看与删除这些运行中产生的规则。
- **/permissions 交互面**：默认视图列出 defaultMode + 三级规则计数 + 来源；进入管理子视图
  可增删（TUI 列表选择 + REPL 行式命令两种面，共用一个注册表命令实现，参照 /mode 双面模式）。

### W3：文案与 spec/文档改写（安全叙事正式反转）

- **README.md**（中英双语两份"安全与隐私"节）：删除 "device_exec 维持逐次审批——机器人
  安全优先"；新口径：默认 full 模式全放行，防线 = deny 规则 + 危险命令/路径逃逸硬拦截；
  "写类工具与 device_mutation 走审批"改为 "manual/acceptEdits 模式下走审批"。
- **AGENTS.md 设备子系统节**（110-116 行）："`device_exec/device_file_write` 走审批" 改写
  为按模式描述；保留 "工具名被 subagent scope、截断预算、loop-guard 按保留名引用" 契约段。
- **交互文案**：`onboarding.ts` PERMISSIONS_HELP_TEXT / renderCliPermissions、
  `approval.ts:1080-1087` headless 拒批指引（现指向 `--accept-edits`/`profile=autonomous`/
  `MOSS_CLI_AUTO_APPROVE` 三个旧 knob，改为新模式口径 `/mode full`、`--full-access`）、
  `help.ts:105-110` flag 帮助、`commands/registry.ts` /mode 帮助块（zh/en 双分支）、
  `tui/copy.ts` 模式标签。
- **docs/cli-parity/target-spec.md §F**：F9-F11 行的循环描述更新为四态；§Z8 补注
  `--full-access` 现为默认的等价物而非"解锁"。
- **release-policy.md**：起草 v0.26 主张段（跑什么/没跑什么口径），发布收口在 W4 完成。

### W4：parity 回归面扩展 + 幽灵清理 + 发布收口

- **幽灵 /yolo 清理**：`args.ts:245` INTERACTIVE_ONLY_COMMANDS 删除 `'yolo'` 条目；
  `cli-main.ts:594-596` fullPower 通路与 `onboarding.ts` CliRuntimeStatus.fullPower 字段
  退役，`safetyModeOverride`/`autoApprove` 改由模式引擎派生（mode=full 即全开，不再是
  独立布尔）。
- **PTY 验收回归面扩展**：v0.23-v0.25 新增命令族（`/mcp` `/skills` `/task` `/tasks`
  `/device` 相关斜杠命令与 `moss device|mcp|skill|task` 子命令的 PTY/REPL 行为）补进
  parity 取证清单（沿用 `scratch/tui-drive.py` + stub 零 quota 模式）。
- **发布收口**：`npm run verify` 全绿 + `npm run examples` 三例实跑 + PTY/headless 双语
  取证齐 → package.json 0.26.0 + release-policy.md 定稿 + commit/push main + 视证据
  打 `v0.26.0` tag。0.x 破坏性行为变更（默认模式翻转）在提交说明里显式声明
  （release-policy 第 2 条）。

## 数据与接口边界

### 新 permissions 配置块（单一来源）

```jsonc
// ~/.config/moss/config.json（用户级） 与 .moss/config.json（工作区级）
{
  "permissions": {
    "defaultMode": "full", // manual | acceptEdits | plan | full
    "allow": ["exec(npm run *)", "edit_file", "device_exec(*)"],
    "ask": ["exec(rm *)"],
    "deny": ["read_file(./.env)", "device_file_write(/etc/**)"],
  },
}
```

- `defaultMode` 单键取代 safetyMode × approvalPolicy 双轴的组合语义（双轴仍作为引擎内部
  派生量保留，见下）。
- 模式→引擎映射：manual = `workspace-write` + `prompt`；acceptEdits = `workspace-write` +
  `prompt` + acceptEdits 交互；plan = 只读规划（现 plan 语义全保留，含
  `isAllowedDuringPlanMode` 对 device_mutation 的类级拒绝）；full = `full-access` + `never`
  - device_mutation 放行。
- **旧键迁移兼容（读侧）**，一张映射表，读到即翻译，翻译时 doctor/config show 提示
  deprecated：

  | 旧键                            | 新映射                                                                    |
  | ------------------------------- | ------------------------------------------------------------------------- |
  | `profile: cautious`             | `defaultMode: manual` + 保留 read-only ceiling 提示                       |
  | `profile: balanced`             | `defaultMode: manual`                                                     |
  | `profile: autonomous`           | `defaultMode: full`                                                       |
  | `safetyMode` + `approvalPolicy` | 组合映射（full-access+never→full；read-only→manual+ceiling；其余→manual） |
  | `trustedTools: [...]`           | `permissions.allow: [...]`（整工具名规则）                                |
  | `deniedTools: [...]`            | `permissions.deny: [...]`                                                 |

  写侧：`moss config set permissions.*` 新键直接写；旧键 `moss config set profile/trustedTools/
deniedTools` 保留写入并同步翻译（一版宽限），`safetyMode/approvalPolicy` 单独 set 时提示
  用 `permissions.defaultMode`。CLI flag `--read-only/--workspace-write/--full-access/
--plan/--accept-edits/--ask-for-approval` 全部保留（§Z8），按映射表作用到 mode 引擎。

- **env 键去向**：`MOSS_SAFETY_MODE` / `MOSS_APPROVAL_POLICY` / `MOSS_CLI_AUTO_APPROVE`
  保留为兼容覆盖（等价于覆盖 defaultMode），`moss config env` 权威清单同步更新
  （v0.22 的 src 扫描双向 CI 锁一起改）。
- **`CLI_PROFILE_DEFAULTS`** 重构：balanced 档默认值翻为 full 等价；`cli-permission-defaults
.spec.mjs` 中锁定的 balanced=workspace-write+prompt 断言重写为迁移语义断言
  （旧 profile 键读入→映射正确）+ 新默认断言。
- **SDK 公共面不动**：`src/index.ts` 不导出 approval/interaction 层（已核实），
  `test/sdk-contract.spec.mjs` 快照零变更；`examples/custom-tool-approval.mjs` 用的是
  core 层 hooks，不受 CLI 模式引擎影响。
- 错误与规范：规则解析失败抛 `MossError`（config-errors.ts 现有模式扩展），禁 `any`，
  新文件 kebab-case（`src/cli/permission-rules.ts`）。

## 修改范围

预计修改（路径均已核实存在）：

- **W1**：`src/cli/interaction-mode.ts`（四态枚举/解析/标签 zh-en）、
  `src/cli/tui/app-helpers.ts`（INTERACTION_MODE_CYCLE 4 项）、
  `src/cli/tui/transcript.ts`（INTERACTION_MODE_TONES、interactionModeHint 徽章形态）、
  `src/cli/tui/copy.ts`（zh 文案）、`src/cli/tui/app.ts`（shift+tab 分支复用）、
  `src/cli/config.ts`（CLI_PROFILE_DEFAULTS 翻转 + permissions 解析链 + audit 重校）、
  `src/cli-main.ts`（默认 wiring）、`src/cli/approval.ts`（resolveCliSafetyMode 兜底翻为
  full-access）、`test/cli-permission-defaults.spec.mjs`（重写）、`test/tui-modes.spec.mjs`
  （四态断言）。
- **W2**：`src/cli/permission-rules.ts`（新增：规则解析/匹配/优先级/来源合并引擎）、
  `src/cli/approval.ts`（规则引擎接入 describeCliToolApproval 与 hook 决策序：
  hardBlock > deny 规则 > 模式 > ask > allow > 询问）、
  `src/cli/commands/registry.ts`（/permissions 管理命令）、
  `src/cli/onboarding.ts`（renderCliPermissions 重写为规则视图）、
  `src/cli/config-commands.ts`（permissions.\* 键 set/unset/validate）、
  `src/cli/tui/app.ts` + `src/cli/repl.ts`（/permissions 交互面接线）、
  `test/permission-rules.spec.mjs`（新增）、`test/tui-registry.spec.mjs`（更新）。
- **W3**：`README.md`、`AGENTS.md`、`docs/cli-parity/target-spec.md`、`src/cli/help.ts`、
  `src/cli/onboarding.ts`（PERMISSIONS_HELP_TEXT）、`src/cli/doctor.ts`、
  `docs/release-policy.md`（起草）、`src/cli/config-snapshot.ts`（展示键更新）。
- **W4**：`src/cli/args.ts`（删 'yolo'）、`src/cli-main.ts`（fullPower 退役）、
  `src/cli/onboarding.ts`（fullPower 字段删除）、`test/cli-args.spec.mjs`（幽灵清理回归）、
  `docs/cli-parity/`（回归面清单）、`package.json`（0.26.0）、`docs/release-policy.md`（定稿）。

## Non-goals

- **不做 OS 级沙箱**（无 bubblewrap/seatbelt/Docker 包裹层；CC 的 sandbox 也不是本轮对象）。
- **不做 auto 模式的第二模型分类器**（CC 的 auto 权限审查器/permission classifier 不对齐，
  full 模式即"模型自决 + 硬拦截"）。
- **不做 MCP OAuth / MCP 服务器级权限配置**；MCP 工具经既有工具注册面进规则引擎即可。
- **不做 web_fetch 询问化**（cli-parity F6 是显式遗留的安全策略决策，另行立项）。
- **不做 fleet 写 fan-out**（v0.25 明确"写操作不隐式扇出"，本轮权限翻转不改变该边界：
  full 模式放行的是单设备路径的逐次询问，不是多设备扩散）。
- **不引入 i18n 框架、不重写审批 UI 骨架**（F1-F4 对话框结构已 parity 达标）。
- **不动 SDK 公共面**（semver 快照零变更）。
- **不主张真实多设备硬件闭环**（同 v0.25 口径）。

## 验收门

1. **先红后绿**：W1/W2 每个行为改动先写失败 spec（四态循环、新默认、规则优先级、
   来源合并、运行中生效），实现后转绿；被翻转的旧断言（balanced=safe-by-default、
   device 逐次审批）在同 commit 内改写并注明行为决策来源。
2. `npm run check` 全绿（prettier + eslint 0 warning + typecheck）。
3. `npm test` 全部 spec 全绿（≥203 个文件），**SDK contract 快照零变更**。
4. `npm run smoke` 全绿（TTY/REPL 回退不回归）。
5. `npm run verify` 全绿——每批（W1-W4）独立过门后再合并。
6. `npm run examples` 三例实跑通过。
7. **PTY 取证**（zh/en 双 locale，`scratch/tui-drive.py` + stub）：
   a) Shift+Tab 四次循环徽章四态（⏸ manual / ⏵⏵ accept-edits / ⏸ plan / ⏵⏵ full 黄色）；
   b) full 模式下 device_exec 放行、`rm -rf /` 仍被硬拦截、deny 规则下 read_file(.env) 仍拦；
   c) /permissions 管理面增删规则后，下一个工具调用即生效；
   d) v0.23-v0.25 命令族（/mcp /skills /task /tasks 等）在 PTY 下无回归。
8. **headless 取证**：`moss --print` 一条含 device_exec 的任务在默认（full）下全程无审批
   卡点跑完；`LANG=zh_CN.UTF-8` / `en_US.UTF-8` 双语一致。
9. **文档口径同步**：README（双语）、AGENTS.md、release-policy、`moss config env` 清单
   与实际行为一致——不允许任何文档仍声称"默认逐次审批"。
10. **收口纪律**：`git status --short` 只含本会话改动；release-policy v0.26 主张 +
    package.json 0.26.0 更新后才 commit/push main；tag 仅在全部证据齐后打，tag 说明写清
    跑了/没跑什么。

## 量化验收表（基线 → 目标）

| 指标                              | 基线（v0.25）                        | 目标（v0.26）                                         |
| --------------------------------- | ------------------------------------ | ----------------------------------------------------- |
| 出厂默认档                        | balanced（workspace-write + prompt） | full（full-access + never + device 放行）             |
| Shift+Tab 循环长度                | 3 态                                 | 4 态（manual/acceptEdits/plan/full）                  |
| 模式徽章                          | 3 态、full 缺失                      | 4 态常显，full 黄色 ⏵⏵                                |
| /permissions 能力                 | 只读 5 行 + --verbose                | 规则管理器：3 级 × 2 层级增删 + 来源显示 + 运行中生效 |
| 规则语法                          | 裸工具名（trustedTools/deniedTools） | Tool(pattern) 参数化模式                              |
| deny 在 full 模式下               | deniedTools 已生效                   | 保持生效（回归锁定）                                  |
| device_mutation 默认（full 模式） | 逐次审批（仅 balanced 默认）         | 放行；manual 模式仍逐次 + allow 规则可豁免            |
| 硬拦截项数                        | 3（危险命令/路径逃逸/deniedTools）   | 3（全部保留，spec 锁定）                              |
| 幽灵 /yolo                        | 1 条目 + fullPower 旁路              | 0（删除 + 机制退役）                                  |
| headless 拒批指引 knob 命名       | 旧三 knob                            | 新模式口径                                            |
| PTY 回归面命令族                  | v0.22 面                             | + device/mcp/skill/task/fleet 族                      |
| 文档"逐次审批"承诺                | README/AGENTS.md 双处                | 0 处（新口径替换）                                    |
| spec 文件数                       | 200                                  | ≥203                                                  |

## 决策记录（2026-10-08，用户/主理人已拍板，全部生效）

1. **规则工具名词汇 → moss 原生名**：`exec`/`read_file`/`edit_file`/`device_exec` 等原生
   工具名；文档并列 CC 别名对照表（`Bash`↔`exec`、`Read`↔`read_file`、`Edit`↔`edit_file`），
   不做解析层透明别名。
2. **read-only ceiling → 保留为 mode 引擎外的 ceiling 覆盖\*\***：`--read-only`/`MOSS_SAFETY_MODE=
read-only` 仍是独立 ceiling（比 plan 更严：拦一切副作用含 runtime_state 之外全部）；
   plan 语义不变。W1 spec 钉死两者差异。
3. **ask × full → full 跳过 ask**：决策序 **deny > 模式 > ask > allow**——full 模式下 ask
   被跳过（只有 deny 能拦），manual 模式下 ask 赢过 allow。对齐 CC bypassPermissions 语义。
4. **徽章后缀 → 对齐 CC 初始态规则**：默认态（现为 full）无后缀；非默认态
   （manual/acceptEdits/plan）追加 `(shift+tab to cycle)`。
5. **旧 profile 键 → 一版宽限**：读侧映射立即生效；写侧 `config set profile/trustedTools/
deniedTools` 保留一版并同步翻译 + deprecated 提示，下版再收口。
6. **`--ask-for-approval` → W1 一并收编**：收编为 mode 覆盖，顺带清理 `on-request` 等幽灵
   取值（现仅 `never|prompt` 实际生效）。
7. **audit 提示 → 一次性会话级提示**：deny 清单为空的默认 full 用户收到一次
   "你处于全开模式，可用 /permissions 添加 deny 规则"（会话级去重，不落盘计数）。
