# RDK Studio 接入 Moss 0.38

这篇记一次真实升级：RDK Studio 从 Moss `9021a042`（0.37.0）升到 `7d1f7855`（0.38.0）。
起点是 `develop@9834dca66`。四个提交已经推到 `develop`：`a5a9828b3` 是接入，
`dfd20075b` 和 `f5076864c` 修了两处测试，`f1d3baa71` 给升级脚本加了一道防护。内容是走过的步骤、四个前提、
调用方要改的地方、每项检查的结果、一次真实运行，以及与 0.37 的对照。命令都在 Studio 仓库根目录执行。

## 1. 升级步骤

```bash
git fetch origin
npm ci --ignore-scripts --no-audit --no-fund
node scripts/install-pi-ai-scoped-fetch.mjs
npm run moss:update -- --ref 7d1f7855 --no-studio-smoke
node scripts/update-desktop-moss-runtime-reference.mjs
npm run moss:update -- --verify-only
```

`npm run moss:update` 把 `external/moss` 检出到指定提交，确认该提交已在官方 `main` 上，
写 `.ci/upstream-lock.json`，刷新 `package-lock.json`，构建工作区包，再跑三道门禁和集成冒烟。
任何一步失败，它会把锁文件和检出恢复原状。

新克隆和新工作树里 `external/moss` 是空目录。先把它初始化成 Moss 检出，再跑上面的命令：

```bash
git submodule update --init --checkout external/moss
```

`npm run moss:update` 在 `external/moss` 不是 git 检出时会报出上面这条命令并退出，退出码 1。
这是 `f1d3baa71` 加的。在那之前，空目录会让 git 把 `git -C external/moss …` 向上解析到外层的 Studio 仓库。
在一个替身仓库里实测，旧脚本把外层的 HEAD 当成子模块提交打印出来，把 Moss 抓进外层仓库，
然后在外层的工作树上检出 Moss 的提交。回滚没有执行，因为写 `.ci/upstream-lock.json` 时 `.ci` 目录已经不在了。
Studio 仓库里没有这种运行留下的痕迹，`refs/rdk-upstream-lock/*` 不存在。

`--ignore-scripts` 会跳过 postinstall。Studio 的 postinstall 第一步就是给 `@earendil-works/pi-ai` 装
传输覆盖层，所以装完依赖要手动补这一步。正常的开发检出用不带这个参数的 `npm install` 就行，
不需要手动补。这条路径这次没有跑过。

## 2. 四个前提

| 前提                                                                                     | 不满足时                                                                                     |
| ---------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| `external/moss`、`.ci/upstream-lock.json`、`package-lock.json` 都没有未提交改动          | 脚本启动即拒绝                                                                               |
| `npm ci` 在 `external/moss` 已经是正常包目录之后执行                                     | 第一次升级失败并回滚：构建 `@rdk-studio/moss-services` 时找不到 `moss` 和 `@opentelemetry/*` |
| 桌面运行时参考已按新的 Moss 文件集重建                                                   | 第二次升级失败并回滚：集成冒烟报 `desktop Moss runtime reference file-set digest mismatch`   |
| pi-ai 的传输覆盖层已装好：`node scripts/install-pi-ai-scoped-fetch.mjs --check` 退出码 0 | typecheck 报 2 个错误，契约套件里自动路由、网关和供应商传输相关的测试成批失败                |

第二条的原因：`npm ci` 时 `external/moss` 还是空目录，npm 没把它算作工作区，`node_modules/moss`
的链接和 54 个 `@opentelemetry/*` 包都没有装。等 `external/moss` 成为正常包目录后重跑 `npm ci` 即可。

因此分两步：先带 `--no-studio-smoke` 升级，再用 `scripts/update-desktop-moss-runtime-reference.mjs`
重建参考，最后用 `--verify-only` 把集成冒烟补跑一遍。

## 3. 升级产物

| 文件                                   | 变化                                                                |
| -------------------------------------- | ------------------------------------------------------------------- |
| `.ci/upstream-lock.json`               | `moss.commit` 从 `9021a042` 到 `7d1f7855`                           |
| `external/moss`                        | 指向 `7d1f7855`                                                     |
| `package-lock.json`                    | 一行，Moss 版本从 0.37.0 到 0.38.0                                  |
| `.ci/desktop-moss-runtime-policy.json` | 文件总数从 822 到 804，其中 Moss 自身从 734 到 716，版本记为 0.38.0 |

## 4. 调用方要改的地方

Moss 0.38 删掉了用正则替模型做决定的几个子系统，清单在
[Moss 与 Pi 的通用能力对照](pi-parity.md)第 1 节。SDK 面少了 18 个名字，没有新增。

| 调用方                                                                                                                                                                                                      | 改动                                                                                                                                                                                                        |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `server/agent/studio-moss-agent.ts`、`server/moss/moss-agent-bridge.ts`、`server/moss/run/run-agent-context.ts`、`server/moss/run/contextual-task-routing.ts`、`server/evolution/evolution-agent-runner.ts` | 去掉 `enableSteering`、`steeringRules`、`studioSteeringRules`、`enableFollowUpGuard`、`followUpGuardConfig`、`studioFollowUpGuardConfig`，并删掉 `run-agent-context.ts` 里只为旧条件存在的常量 `compactRun` |
| `server/moss/run/studio-follow-up-patterns.ts`                                                                                                                                                              | 删除                                                                                                                                                                                                        |
| `scripts/publish/moss-consumer-smoke.mjs`、`scripts/packaged-moss-public-probe.mjs`                                                                                                                         | 构造 `MossAgent` 时去掉 `enableSteering` 和 `enableFollowUpGuard`                                                                                                                                           |
| `scripts/moss-restructure.mjs`                                                                                                                                                                              | 文件清单里去掉已删除的文件                                                                                                                                                                                  |
| `test/studio-follow-up-guard-wiring.test.ts`                                                                                                                                                                | 改写为 `test/studio-narrated-tool-intent.test.ts`，并在 `package.json` 的 `contractTestFiles` 里换名                                                                                                        |
| `test/tool-loop-recovery.test.ts`                                                                                                                                                                           | 恢复路径的三个用例各加一个“上限关闭”变体，一共六个                                                                                                                                                          |

`studio-follow-up-patterns.ts` 定义的设备 follow-up pattern 在桌面主路径上没有生效过。
原代码的注释写明：`contextualRouting=true` 且 `compactRun=true` 时旧条件恒为假。

宿主要知道的三条行为变化：

- **工具循环上限默认关闭。** 需要的宿主用 `MOSS_TOOL_LOOP_*` 逐条打开，上限在每次工具调用时从进程环境变量读取。
  Studio 的无缝恢复路径仍然可用，前提是打开 `MOSS_TOOL_LOOP_EDIT_PATH_FAILURE_LIMIT`。
  测试里的脚本序列是三次失败之后第四次编辑正确。上限开着时守卫拦下第四次，模型要多读一遍整文件再编辑。
  上限关着时第四次直接生效。
- **推理档位。** `adaptive` 不再在失败后升到 `high`。传了 `options.reasoning`，每次请求都用这一档。
- **叙述性的工具意图不再触发工具调用。** 模型写出“我来看一下设备”却没有发 tool_use 时，
  0.37 会追加一条提示去调用 `device_list_all`。0.38 把这段话原样送达用户。

## 5. 检查结果

下表的检查都在接入提交 `a5a9828b3` 上跑过，退出码都是 0。后两个提交只改了测试脚本。
其中 `moss:verify`、`verify:quick`、契约套件、`test:extra`、`build` 和 `smoke:wiring`
又在 `f5076864c` 上重跑了一遍。

`f1d3baa71` 叠在别人的 9 个提交之上，基础是 `92556ffee`。在这个提交上又跑了一遍。
`verify:quick`、`moss:verify`、`smoke:wiring` 和 `moss:update -- --verify-only` 退出码都是 0。
契约套件 1735 条通过 1734 条。没过的一条是 `test/workspace-zsh-prompt.test.ts`，由 `d16adc74f` 新增，与 Moss 无关。
它等 zsh 输出第一个提示符标记，等了约 3 秒，全量并发时输出还是空的。单独跑两次都通过。

防护本身在一个 `9834dca66` 的检出上验过。`external/moss` 不存在和是空目录，两种情况都退出 1，
没有执行任何一步 git 操作，HEAD、引用和远端地址不变。

| 检查                                                           | 结果                                          |
| -------------------------------------------------------------- | --------------------------------------------- |
| `npm run moss:update -- --no-studio-smoke`，再 `--verify-only` | 通过                                          |
| `npm run moss:verify`                                          | 发布 lint、消费方冒烟、集成冒烟、三道门禁全过 |
| `npm run verify:quick`                                         | 23 项全部通过                                 |
| `npm run typecheck`                                            | 通过                                          |
| `node scripts/test-contracts.mjs`                              | 1729 条全部通过                               |
| `npm run test:extra`、`npm run build`、`npm run smoke:wiring`  | 通过                                          |
| `npm run test:capability-acceptance`                           | 100 项全部通过                                |

能力面验收在集成线上过不了，实测退出码 1，95 项通过、1 项失败。第 7 步要找一个处于停用状态的插件，
新环境里只有一个内置插件 `rdk-studio-moss-copilot`，而且它是启用的。这一步失败之后，
`plugin.toggle` 的四条断言从不执行。修法是找不到停用插件时取任意一个插件，按它当前的状态翻转，
断言不变。修好后 100 项通过。

集成线上另有一处与本次无关：`.github/workflows/quality.yml` 第 66 行仍在调用 `npm run test:rsi`，
这个脚本已被 `350cb61b0` 删除。仓库远端在 codeup 上，这个工作流是否执行没有核实。

## 6. 真实运行

用独立的端口和数据目录起了一套 Studio，接口在 18987，页面在 15173，不碰默认端口和日常数据。
服务日志写着 `Moss host adapter compatible: moss v0.38.0, contract v1, 13 capabilities OK`。用的是真实账号。

- **登录。** 错误密码返回 409，界面提示“用户名或密码不正确”。正确密码返回 200，登录卡片关闭。
- **质量探针。** `qa-results/task-quality/run-quality-probes.mjs` 六个探针共九轮，全部通过。
- **纯问答。** 零次工具调用，回答正确。
- **运行中停止。** 模型在跑 `sleep 45` 时点“停止当前任务”。运行状态是 `cancelled`，
  界面右上角有“停止请求已发送”，回复下面标着“工具调用 本机 · 1 项 · 已停止”。
- **停止后追问。** 模型引用真实的工具回执 `aborted_by_user`，说明上一步没有跑完。
- **能力面验收。** `npm run test:capability-acceptance` 100 项通过。

探针脚本原先写死了默认端口和默认数据目录，现在可以用 `RDK_QA_API` 和 `RDK_QA_SSO_SESSION`
指向别的实例。登录前首屏的输入框区域有一处标签显示“3D 展示 · 加载失败”，登录后恢复。
与 Moss 无关，没有处理。

## 7. 与 0.37 的对照

基线是 `develop@9834dca66` 加 Moss `9021a042`（0.37.0），另起一套隔离环境，用同一份探针脚本跑。
每个探针只跑一次，耗时以模型延迟为主。

| 探针                       | 0.37 基线           | 0.38                |
| -------------------------- | ------------------- | ------------------- |
| `q1-multiturn-correction`  | 5 次工具，30.1 秒   | 5 次工具，38.0 秒   |
| `q2-clarification`         | 0 次工具，15.5 秒   | 0 次工具，7.7 秒    |
| `q3-new-app`               | 3 次工具，15.4 秒   | 3 次工具，14.6 秒   |
| `q4-readonly`              | 4 次工具，17.1 秒   | 4 次工具，15.5 秒   |
| `q5-tool-failure-recovery` | 2 次工具，16.0 秒   | 3 次工具，17.3 秒   |
| `q6-passk-1`               | 2 次工具，20.4 秒   | 3 次工具，14.3 秒   |
| `q6-passk-2`               | 2 次工具，20.2 秒   | 3 次工具，9.8 秒    |
| `q6-passk-3`               | 4 次工具，7.9 秒    | 2 次工具，16.4 秒   |
| 合计                       | 22 次工具，142.7 秒 | 23 次工具，133.7 秒 |

两边都是八个探针全部通过。Studio 层分不出差异。运行记录里没有 token 字段，模型一栏只记为 `Moss`。
效率上的证据以 Moss 层 27 道题的对比为准，见 [0.38 前后对比](bench/0.38-before-after.md)第 3 节。

`q3-new-app` 原来的检查叫 `entered_task_engine`，看回复里有没有“验收”一类的字样。两个版本都过不了。
Studio 的聊天主链在上下文路由下不进任务引擎，运行结论一律是 `not_required`。
`openspec/changes/moss-contextual-task-routing` 写明不从措辞推断验收路径，模型叙述也不能替代执行回执。
检查已改为 `executed_by_tool_receipts`，要求有写入类工具调用和一次 `exec`。表里是改后两边的结果。

## 8. 留给 owner

- Studio 依赖 Jev 判官，见 `openspec/changes/default-moss-jev`。Moss 里它默认开启，
  实测开销与去留见 [Moss 与 Pi 的通用能力对照](pi-parity.md)第 1 节。
- `q3` 的检查从“进没进任务引擎”改成“按工具回执判断”，这是接入时的单方面判断。
  如果目标是让长任务真的进任务引擎，那属于规范迁移的范围，需要单独决定。
- 第 5 节末尾那条失效的 CI 步骤要不要修。
