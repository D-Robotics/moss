# Moss 与 Pi 的通用能力对照

对照对象是 Moss `0.38.0`（官方 `main@7d1f7855`）和 Pi `main@e24c9d5`（本地副本，只读）。

口径。标“实测”的数字来自构建产物或基准输出，标“报告”的来自 2026-11-25 的架构对比，
标“未核对”的没有读过对应源码。状态分四种：已对齐、部分、未做、不做。

对齐的是用户在终端里看得见、用得上的交互和能力。规则式的分类器、nudge 和守卫不在对齐范围，
判定交给模型与 harness。

## 1. 这一轮删除的内容

| 删除项                           | 理由                                                                                | 提交       |
| -------------------------------- | ----------------------------------------------------------------------------------- | ---------- |
| nudge 注册表与 15 个规则模块     | harness 用正则替模型追加回合                                                        | `83e1e80d` |
| `SteeringEngine` 与 5 条内置规则 | 命中关键词就改写请求或拒绝工具调用                                                  | `83e1e80d` |
| follow-up guard                  | 回答里出现“我来／让我”就强制再调一次工具                                            | `83e1e80d` |
| 从计划文本合成工具调用           | harness 替模型发 tool_use                                                           | `83e1e80d` |
| 6 个默认工具循环上限             | 默认关闭，宿主需要时用 `MOSS_TOOL_LOOP_*` 或 `MOSS_WEB_SEARCH_VARIATION_LIMIT` 打开 | `f40d70a3` |
| 工具调用后的下一轮压低推理档     | 请求只带调用方设置的推理档                                                          | `f40d70a3` |
| `adaptive` 在失败后升到 `high`   | 传了 `options.reasoning` 就每次请求都用这一档                                       | `f40d70a3` |

留下来的恢复路径都以 provider 返回的事实为依据：输出上限续写、只有推理没有正文、空回复、
工具 JSON 被截断、后台完成通知。`MOSS_DISABLE_NUDGES` 可以逐条关掉它们。

核对后没有删的三处：

- `src/cli/context-report.ts` 没有静态导入，但 `scripts/context-report.mjs` 用拼出的路径加载它。
- 1198 个导出在别的文件里没有引用，在自己文件内部都在使用。
- `MOSS_DISABLE_NUDGES` 是在用的开关。

对 SDK 调用方的影响（实测，`9021a042` 对 `7d1f7855`，用 TypeScript 编译器数入口声明里的名字）：
`MossAgentConfig` 自有字段从 44 个减到 39 个，入口导出从 700 个名字减到 682 个，没有新增。
去掉的是 `enableSteering`、`replaceDefaultSteeringRules`、
`steeringRules`、`enableFollowUpGuard`、`followUpGuardConfig`，以及 `SteeringEngine`、
`detectUnexecutedToolIntents` 等 11 个值和 7 个类型。接入步骤见 [RDK Studio 接入](rdk-studio-adoption.md)。

等 owner 决定、这一轮没有动的：

- Jev 判官默认开启，`input` 与 `completion` 两个判定点各发一次外部请求。无工具单回合实测，
  默认开启时中位 1317 毫秒，显式关闭 558 毫秒，各 6 次交替运行，测量时机器同时在跑基准。
  `src/cli/jev-intent.ts` 第 27 到 28 行把服务地址和一把 API key 写成了字面量，
  与仓库规范“凭据只从 `.env` 或环境变量读”冲突。删掉、改成默认关闭还是换成环境变量，需要拍板。
- guard 上限的休眠代码。
- `oneshot.ts` 的即时新闻策略。

## 2. 命令对照

Pi 的内置命令是 28 个。Moss 现有 45 条命令行，其中 28 条在菜单里，17 条隐藏但可以输入。

| Pi                               | Moss                                                               | 状态                   |
| -------------------------------- | ------------------------------------------------------------------ | ---------------------- |
| `/settings`                      | `/model` `/mode` `/theme` `/style` `/language` `/permissions` 分开 | 部分                   |
| `/model`                         | `/model`                                                           | 已对齐                 |
| `/thinking`                      | `/thinking`，`Alt+T` 循环                                          | 已对齐                 |
| `/new`                           | `/new`，是 `/clear` 的别名                                         | 已对齐                 |
| `/resume`                        | `/resume`                                                          | 已对齐                 |
| `/session`                       | `/session`                                                         | 已对齐                 |
| `/compact`                       | `/compact`                                                         | 已对齐                 |
| `/copy`                          | `/copy`                                                            | 已对齐                 |
| `/trust`                         | `/trust` `/untrust`                                                | 已对齐                 |
| `/mcp`                           | `/mcp`                                                             | 已对齐                 |
| `/hotkeys`                       | `/hotkeys`                                                         | 已对齐                 |
| `/changelog`                     | `/changelog`                                                       | 已对齐                 |
| `/quit`                          | `/quit`                                                            | 已对齐                 |
| `/export`                        | `/export`，只有 markdown                                           | 部分，缺 html 与 jsonl |
| `/name`                          | 无                                                                 | 未做                   |
| `/tree`                          | 无，现有入口是 `/rewind` `/resume` `/checkpoint`                   | 未做                   |
| `/fork`                          | 会话外有 `moss fork --fork-from <key>`，会话内没有                 | 部分                   |
| `/clone` `/import`               | 无                                                                 | 未做                   |
| `/reload`                        | 无                                                                 | 未做                   |
| `/login` `/logout`               | 无                                                                 | 未做                   |
| `/share`                         | 无                                                                 | 不做，需要托管的查看器 |
| `/scoped-models` `/llama` `/bug` | 无                                                                 | 不做，Pi 特有          |

Moss 有而 Pi 没有的命令：`/goal` `/task` `/plan` `/review` `/runs` `/capabilities` `/doctor` `/diff`
`/paste` `/rules` `/remember` `/skills` `/agents` `/todos` `/debug` `/queue` `/context` `/usage`
`/rewind` `/hooks` `/stop` `/init` `/steer`。

## 3. TUI 键位与交互

| 行为                   | Pi                                                                                      | Moss                                                                                   | 状态      |
| ---------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | --------- |
| 全文搜索               | `Ctrl+Shift+F`                                                                          | `Ctrl+F`                                                                               | 已对齐    |
| 运行中排队的消息       | Enter 追加，`Alt+Enter` 排到本轮之后，`Alt+Up` 取回                                     | 相同                                                                                   | 已对齐    |
| 外部编辑器             | `Ctrl+G`                                                                                | `Ctrl+G`                                                                               | 已对齐    |
| 粘贴剪贴板图片         | `Ctrl+V`                                                                                | `Ctrl+V`                                                                               | 已对齐    |
| 推理档                 | `/thinking`                                                                             | `/thinking`，`Alt+T`                                                                   | 已对齐    |
| 复制上一条回答         | `Ctrl+X`                                                                                | `/copy`，没有默认键                                                                    | 部分      |
| 行内编辑               | 行首行尾、删到行首行尾、删前一个词、粘回之外，还有删后一个词、yank 轮换、撤销、跳到字符 | 行首行尾、删到行首行尾、删前一个词、粘回                                               | 部分      |
| 键位重绑               | JSON schema 校验，旧名迁移表，`/reload` 生效                                            | `~/.config/moss/keybindings.json`，10 个动作，`/hotkeys` 查看                          | 部分      |
| 启动头                 | 按来源分组列出已加载资源                                                                | 一行 `context:` 加每个 MCP 服务器一行状态                                              | 部分      |
| `!` 执行命令           | `!` 的结果进会话，`!!` 不进                                                             | `!` 的结果不进会话，等于 Pi 的 `!!`                                                    | 部分      |
| 中断、清空编辑框与退出 | `Esc` 中断；`Ctrl+C` 先清空编辑框，再按一次退出；`Ctrl+D` 退出                          | `Ctrl+C` 中断，再按一次退出；`Ctrl+L` 清空编辑框；`Ctrl+D` 退出；任务运行中 `Esc` 暂停 | 口径不同  |
| 模型切换               | `Ctrl+L` 选择器，`Ctrl+P` 循环                                                          | `/model`                                                                               | 部分      |
| 鼠标                   | 组件命中，拖选，OSC 8 链接                                                              | 行号路由，矩形拖选                                                                     | 部分      |
| 提示历史搜索           | 没有默认键                                                                              | `Ctrl+R`                                                                               | Moss 多出 |
| 挂起到后台             | `Ctrl+Z`                                                                                | 无                                                                                     | 未做      |
| 跳到上／下一条提问     | `Ctrl+Up` `Ctrl+Down`                                                                   | 无                                                                                     | 未做      |
| 主题                   | 语义 token，真彩色，用户主题目录                                                        | 三个主题，16 色                                                                        | 未做      |
| 布局与覆盖层           | 定位、焦点、可见性的 overlay 栈                                                         | `chromeTop` 与 `chromeBottom` 两个数组                                                 | 未做      |
| IME 光标定位           | 零宽标记                                                                                | 手工算行号                                                                             | 未做      |

Moss 的内容层保持不动：审批面板、todo、任务视图、diff 沟槽、用量块、中英双语。
这些在 Pi 里要靠扩展拼出来。

## 4. 内核与工程

| 项                            | 状态          | 说明                                                                                                                        |
| ----------------------------- | ------------- | --------------------------------------------------------------------------------------------------------------------------- |
| 提示分段与 patch              | 未核对        | `src/core/prompt/` 只有 `assembler.ts`、`report.ts`、`index.ts`，缓存标记在 provider 适配层。提示是否已拆成可回放的段没有读 |
| `length` 停止时整批工具不执行 | 未核对        | 源码里只找到 `pushTurnEnd('length')` 一处。Pi 在这个分支上整批不执行，因为截断的参数可能解析成功但不完整                    |
| 模型目录与 OAuth 登录         | 未做          | 现有 5 个协议。缺一份不改代码就能加模型的目录                                                                               |
| 供应链门槛                    | 未做          | 可以加发布年龄门槛和 lockfile 校验，不改运行代码                                                                            |
| RPC 模式                      | 未做          | Pi 有 `pi --mode rpc`                                                                                                       |
| 扩展接口                      | 等 owner 决定 | 现有 shell 钩子、skills、命令、agents、plugins                                                                              |
| `/goal` 状态 overlay          | 未做          | 数据已经在 `.moss/` 账本里                                                                                                  |
| 子代理与后台任务面板          | 未做          | 有命令，没有可展开的树                                                                                                      |
| 设备与验收 overlay            | 未做          | Pi 没有这一层                                                                                                               |

## 5. 相关文档

- 前后性能对比：[0.38 前后对比](bench/0.38-before-after.md)
- RDK Studio 接入这一版：[RDK Studio 接入](rdk-studio-adoption.md)

## 6. 建议顺序

1. 会话命令：`/name`、`/fork`、`/clone`、`/import`、`/export` 的 html 与 jsonl、`/tree`。
2. TUI 底座：主题系统，光标零宽标记，`/copy` 绑键。
3. 两项待核对的内核不变量：`length` 整批守卫，提示分段。
4. `/goal`、子代理、设备与验收三个 overlay。
