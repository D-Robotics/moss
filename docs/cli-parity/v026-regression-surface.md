# v0.26 回归面清单（PTY/REPL 取证交付物）

> 生成日期：2026-10-08（T05）。这是**待取证清单**，不是已执行证据——v0.26 发布的 PTY 取证
> 按 QA 排期执行，执行结果回填本文件并同步 release-policy。工具约定：`scratch/tui-drive.py`
> （stub 零 quota 模式）+ headless 断言组合；zh/en 双 locale（`LANG=zh_CN.UTF-8` / `en_US.UTF-8`）。

## v0.26 权限模型核心面（新，本轮必须取证）

| #   | 项                                    | 取证方法                                                          | 断言                                                                                                                                     | 状态   |
| --- | ------------------------------------- | ----------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| P1  | Shift+Tab 四态循环徽章                | PTY 驱动（stub provider），连按四次 shift+tab 截屏                | `⏸ manual`（灰，带后缀）→ `⏵⏵ accept-edits`（紫）→ `⏸ plan`（青）→ `⏵⏵ full`（黄，无后缀）→ 回 manual；非默认态带 `(shift+tab to cycle)` | 待执行 |
| P2  | full 模式 device_exec 放行            | PTY：默认启动（无配置）+ stub 设备工具调用                        | 无审批弹窗，工具执行；hint 显示 `full mode on`                                                                                           | 待执行 |
| P3  | full 模式 `rm -rf /` 仍硬拦           | PTY：full 模式下 exec rm -rf -- /                                 | 拒绝 + 危险命令 reason，无弹窗                                                                                                           | 待执行 |
| P4  | deny 规则在 full 下拦 read_file(.env) | PTY：`/permissions add deny "read_file(./.env)"` 后调用 read_file | 拒绝 + `deny rule` reason；**增规则后下一个调用即生效**                                                                                  | 待执行 |
| P5  | /permissions 管理面                   | PTY：默认视图 / add / remove / persist 往返                       | 视图含 defaultMode + 三级计数 + 来源；add/remove 确认文案；persist 落盘                                                                  | 待执行 |
| P6  | 默认全开一次性提示                    | PTY：全新 config 启动                                             | `Default full mode has no deny rules…` 出现且仅一次（会话级去重）                                                                        | 待执行 |
| P7  | headless 默认全流程                   | `moss --print`（stub provider）一条含工具的任务                   | 全程无审批卡点跑完                                                                                                                       | 待执行 |

## v0.23-v0.25 命令族回归面（存量，防翻转回归）

| #   | 族         | 命令                                               | 取证方法                                       | 状态   |
| --- | ---------- | -------------------------------------------------- | ---------------------------------------------- | ------ |
| R1  | MCP        | `moss mcp add/list/remove/test`、REPL `/mcp`       | headless 真跑（stdio fixture）+ PTY /mcp       | 待执行 |
| R2  | skills     | `moss skill create/list`、`/skills`                | headless + PTY /skills 浏览                    | 待执行 |
| R3  | task       | `moss task run/status/timeline`、`/task`、`/tasks` | headless（fixture 任务）+ PTY 视图             | 待执行 |
| R4  | device     | `moss device add/list/remove/test`、`/device`      | headless（in-process SSH）+ PTY                | 待执行 |
| R5  | 双语一致性 | 上族在 zh/en 两 locale                             | `LANG` 两态实跑，固定标签随 locale、token 不变 | 待执行 |

## 已有单测覆盖（不依赖 PTY，列为证据基线）

- 四态循环/徽章/后缀：`test/tui-modes.spec.mjs`（ink 组件级，含键盘路径）
- 规则引擎决策序矩阵：`test/permission-rules.spec.mjs` + `test/cli-permission-mode-engine.spec.mjs`
- /permissions 管理器：`test/permissions-command.spec.mjs`（registry 直测 + hook 即时生效）
- 默认翻转/迁移/hard blocks：`test/cli-permission-defaults.spec.mjs`
