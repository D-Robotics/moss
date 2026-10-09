# RDK 知识改由 rdk-docs MCP 供给（审计 + 落地计划）

> 审计日期：2026-10-09。只读审计，本提交不改产品代码。
> 源码行号对着 `main` @ `3c4ed448`（与 `feat/tui-parity-v3-slash-v031` 在下列 RDK 文件上无 diff；该分支仅多出与本题无关的 `agent-behavior-prompt.ts` 6 行）。
> 实测服务器：`rdk-docs-mcp@0.1.12`（`npx -y rdk-docs-mcp@latest` 解析到的版本），协议 `2025-06-18`，stdio JSON-RPC。Node `v22.16.0`。
> 工具：`list_manuals`、`search_docs`、`get_page`、`list_toc`，外加包内还有 `search_skills` / `get_skill`（本审计未把 skill 目录当手册）。

## 结论

Moss **没有**一份可删的 RDK 手册。烧录步骤、apt 源、GPIO 针脚表、hobot_dnn API、X3/X5/S100/S600 规格表都不在系统提示、行为提示、skill 或板卡目录里。模型今天若答对这些，靠的是训练记忆，不是仓库里的文本。

因此「删掉内置知识、改问 MCP」的收益是**正确性**，不是把一段长提示换掉。按本审计的保留标准（见下），能从提示里拿掉的只有约 **130 token** 的示例句；必须留下的是连接/探测/安全/验收，约 **400 token** 的工具契约加约 **30 行**探测脚本。接上 MCP 之后，系统提示还要加一段约 **150 token** 的用法指针（仅在服务器连上时注入）。净效果：提示略增，按需 `get_page` 才付 1k–16k 字符。

**离线不是保留理由。** Moss 调模型已经要有网。MCP 不可达时打一行超时/错误即可，不做磁盘缓存、不做离线手册副本。

保留只在这四条里成立：

1. 任何工具调用之前就必须知道的事（怎么连上板、怎么探测板上有什么）。
2. 安全关键（审批、plan 模式拒绝 `device_mutation`、探索/验收子代理禁止刷机）。
3. 验收与证据约定（`task_define` / `record_evidence` / bench 任务契约）。
4. 本次 MCP 实测答错或没有这条页面。

## 计数

| 裁决                                  | 处数 |      源码行（约） | 模型可见 token（约，英文按 4 字符/token） | 含义                                                                                      |
| ------------------------------------- | ---: | ----------------: | ----------------------------------------: | ----------------------------------------------------------------------------------------- |
| DELETE                                |    1 |                 1 |                                       ~10 | `web_fetch` 描述里的示例词 `BPU`，不是知识                                                |
| SHRINK                                |    3 |                 4 |                                      ~120 | 单一的 `source /opt/tros/setup.bash` 示例，以及设备命令失败时指向 `web_fetch` 的那半句    |
| KEEP（提示契约）                      |   11 |               ~25 |                                      ~400 | 「这是 RDK/Linux 设备、先探测、TROS 装在 `/opt/tros`、摄像头看 v4l2」——调用工具之前要知道 |
| KEEP（探测脚本，不进提示）            |    4 |               ~30 |                                         0 | `/proc`、`/opt/tros`、`hbm_shell`、`ip`、v4l2。`hbm_shell` 与 `sun55iw3` 在 MCP 里 0 命中 |
| KEEP（安全 / 验收 / 测试夹具 / 文档） |    8 | 不进 RDK 提示预算 |                                         0 | 见清单。测试夹具不向模型展示                                                              |
| 仓库里不存在                          |    — |                 0 |                                         0 | 板型目录、烧录、apt 源、GPIO 针脚、hobot_dnn 教程、捆绑的 `rdk-docs` skill                |

建议的替换指针（仅 MCP 已连接时进入系统提示）约 150 token。所以落地后的系统提示相对今天是**略增**，不是节省出一大段上下文。节省发生在「不要把手册贴进提示」这条已经成立的事实上，以及避免以后再把手册抄进来。

## 1. MCP 实测

客户端是一次性的 stdio JSON-RPC 脚本（未入库）。握手 `initialize` → `notifications/initialized` → `tools/list` → `tools/call`。

服务器自报 `serverInfo.name=rdk-docs`、`version=0.1.12`。`list_manuals` 返回 16 本官方手册，**没有** forum。与本题相关的 id：`rdk-x`（X3/X5，别名 `x3`/`x5`）、`rdk-s`（S100/S600）、`tros`、`rdk-studio`、`xburn`、`model-zoo`，以及 OE / S600 案例等。

### 时延

同一进程里第一次 `initialize` **3365 ms**（含拉起 `npx`），第二次进程 **1305 ms**（包已在本地）。本机没有单独测「清空 npm 缓存后的冷启动」。`list_manuals` 在握手之后 **1 ms**。`list_toc({manual:"x5"})` **84 ms**，解析到 `rdk-x`。

| 调用                                                                   |        ms | 结果概要                                                                                         |
| ---------------------------------------------------------------------- | --------: | ------------------------------------------------------------------------------------------------ |
| `search_docs` X5 SD 烧录，`manual=x5`                                  |      2484 | `role=official-start`，分数 1000，SD 卡烧录页。同进程里第一次检索，含索引加载                    |
| `search_docs` S100 烧录，`manual=rdk-s`                                |      2951 | `official-start` 指向 **RDK Studio / XBurn**，不是 S 系列手册里的音频页                          |
| `search_docs` hobot_dnn BPU，`manual=x5`                               |        72 | 索引已热。X3 与 X5 的 BPU API 页同分 42，**X3 排在前面**                                         |
| `search_docs` 仅 `hobot_dnn`                                           |        93 | 唯一命中是 Conda FAQ，分数 8                                                                     |
| `search_docs` MIPI 摄像头                                              |        80 | X5 示例页与 X3 用法页同分 61                                                                     |
| `search_docs` TROS `source setup.bash`，`manual=tros`                  |      1889 | 无 `official-start`。含正确路径的 Hello World 排第 3                                             |
| `search_docs` apt 软件源                                               |        89 | 无 `official-start`。FAQ「软件源域名变更或 GPG」排第 3，分数 30                                  |
| `search_docs` 网络 / Wi-Fi                                             |        89 | `official-start` = 远程登录；下一条是有线/无线配置页                                             |
| `search_docs` 40PIN GPIO                                               |        82 | `official-start` = GPIO 应用；下一条是管脚定义                                                   |
| `search_docs` 「X3 与 X5 区别」（不指定手册）                          |      7238 | 最高分 51，首条是网络配置。对比问法失败                                                          |
| `search_docs` S600 硬件规格                                            |       145 | 首条是 boardid/ADC bringup，不是规格首页                                                         |
| `search_docs` S100 / S600「硬件简介」                                  | 145 / 130 | S600 命中套件页（`official-start`）。S100 的 `official-start` 是**系列手册首页**，不是 S100 专页 |
| `search_docs` `/opt/tros hbm_shell`                                    |        26 | 无 `hbm_shell`。Hello World 仍在列表里，因为查询里有 `/opt/tros`                                 |
| `search_docs` `hbm_shell`、`sun55iw3`                                  | 259 / 233 | **0 命中**                                                                                       |
| `search_docs` `v4l2 video4linux`，`manual=x5`                          |        68 | 返回的是 X3 USB 摄像头页，不是 sysfs 枚举                                                        |
| `search_docs` X5 相机不出图，`source=forum`                            |      2926 | 有帖。首条是 GMSL 套件推广（59 分），第二条才是「右路无画面」排障（53 分）                       |
| `get_page` 烧录 / S100 xburn / 网络 / Hello World / 管脚 / X5 硬件简介 |  933–1486 | 正文可用，见下节                                                                                 |
| `get_page` X5 MIPI 示例、TROS 图像加速（误命中页）                     | ~1.0–1.1s | 单页 markdown 约 16k 字符                                                                        |

热检索 <150 ms，`get_page` 约 1–1.5 s，冷检索或论坛约 2.5–7 s。相对一次模型往返，这个量级可接受。请求超时取 **20 s** 有余量；连接超时要盖住冷的 `npx`，取 **45 s**。现在全局默认是连接 20 s、请求 120 s（`src/core/mcp/client.ts` 的 `connectTimeoutMs` / `requestTimeoutMs`）。20 s 连接对冷 `npx` 偏紧，120 s 请求会把一次卡死的检索拖成一轮对话。只对内置的 `rdk-docs` 收紧，不动其他服务器的默认值。

### 答对了的（这些主题 Moss 本来就没写进仓库，MCP 可以当事实来源）

- **X5 烧录。** `get_page` `https://developer.d-robotics.cc/rdk_x_doc/Quick_start/system-burn/burn-sd-card`：Ubuntu 镜像写入 Micro SD（Module 还可选 eMMC），禁止带电拔插，Type-C 只供电，适配器 5V/5A，卡至少 16GB。`truncated=false`。
- **S100 烧录。** 即使 `manual=rdk-s`，`official-start` 仍是 `https://developer.d-robotics.cc/rdk_studio_doc/user-guide/system-flashing/s100-xburn`。正文写明：S100 用 xburn，不能照 X3/X5 直接烧 TF 卡。这是模型最容易从 X5 习惯里推错的一点。
- **有线网络。** `https://developer.d-robotics.cc/rdk_x_doc/System_configuration/network_blueteeth`：X5 ≥ 3.3.0 / X3 ≥ 3.0.2 默认静态 IP `192.168.127.10`，文件 `/etc/NetworkManager/system-connections/netplan-eth0.nmconnection`。Moss 的 `device_network` 只跑 `ip`，不写这个地址，应当继续不写。
- **X5 接口表。** `https://developer.d-robotics.cc/rdk_x_doc/Quick_start/hardware_introduction/rdk_x5` 的 markdown 里有接口序号表（2 路 MIPI、4 路 USB 3.0、40PIN、TF 卡等），并指向可下载的规格书。布局图仍是图片。
- **TROS 环境。** `https://developer.d-robotics.cc/tros_doc/quick_start/hello_world` 同时写了 Foxy 的 `source /opt/tros/setup.bash` 和 Humble 的 `source /opt/tros/humble/setup.bash`。

### 缺口（保留或「不要照抄首条」的依据）

1. **`hbm_shell`、`sun55iw3` 零命中。** Moss 用 `hbm_shell` 是否存在来判断 HBM，用 `/proc/cpuinfo` 的 `Hardware` 行读出 `sun55iw3`（只出现在测试夹具里）。这两条不能改成「问 MCP」。探测脚本留下；不要把 `sun55iw3` 写进提示去教模型「这就是 X5」。
2. **单一 `setup.bash` 路径是不完整的。** 工具描述和探测结果格式化只举例 `/opt/tros/setup.bash`。手册对 Humble 写的是 `/opt/tros/humble/setup.bash`。这不是「MCP 错了所以保留示例」，而是示例该缩成「source 探测到的安装目录下的 setup」，路径以手册页为准。
3. **`hobot_dnn` 这个包名几乎检不到。** 查询 `hobot_dnn` 只有一条分数 8 的 Conda FAQ。查询「BPU 推理」时 X3 与 X5 的 API 页同分，X3 在前。问 X5 时必须再按 URL 里的 `RDK_X5` 过滤，不能把首条当答案。
4. **跨型号对比问法失败。** 「X3 与 X5 区别」首条是网络页（51 分）。X5 硬件简介要直接问「RDK X5 硬件简介」才是 `official-start`。S100「硬件简介」的 `official-start` 是系列首页，不是 S100 专页。
5. **apt 源找得到但不好打开。** FAQ 条目在，`get_page` 该 FAQ 的前 2500 字符仍是 Q1/Q2，还没到软件源那一节。长 FAQ 必须加 `maxChars` 或改查询词。仓库里本来就没有 apt 源列表，无需为了「防 MCP 漏掉」再写一份。
6. **GPIO 针脚表在图片里。** 管脚页正文有电平与电流（3.3V 逻辑，3.3V/800mA，5V/500mA），完整针脚表是图片。捆绑 skill 还警告硬件简介页的电流数字与这一页不一致；本审计没有把硬件简介读到那一行，所以只把「两页冲突时两页都引用」当作 skill 的使用规则，不把 800mA 写进 Moss。
7. **论坛排序把推广帖放在排障帖前面。** `source=forum` 可用，但是补充证据。手册与论坛冲突时用手册。
8. **`v4l2` 检索回到 X3 USB 示例。** `device_cameras` 读的是 `/sys/class/video4linux` 与 `/dev/video*`。这句工具说明留着，因为 MCP 没把它讲清楚。

## 2. 清单

路径均相对仓库根。token 是模型会看到的英文/中文说明的粗算，探测脚本计 0。

| 位置                                                                                                            | 行                    | 大约 token | 编码的内容                                                                                 | 裁决   | 依据                                                                                                                                              |
| --------------------------------------------------------------------------------------------------------------- | --------------------- | ---------: | ------------------------------------------------------------------------------------------ | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/agent/identity.ts`                                                                                    | 全文                  |          0 | 身份与模型诚实，无板卡事实                                                                 | 空     | 已读                                                                                                                                              |
| `src/contracts/prompts/agent-behavior-prompt.ts`                                                                | 全文                  |          0 | 行为契约，无 RDK 步骤                                                                      | 空     | 已读                                                                                                                                              |
| `src/contracts/prompts/software-engineering-prompt.ts`                                                          | 全文                  |          0 | 通用工程方法                                                                               | 空     | 已读                                                                                                                                              |
| `.moss/skills/*/SKILL.md`                                                                                       | 3 个 skill            |          0 | bench / patch / worktree，无 RDK 手册                                                      | 空     | 已读。产品未捆绑 `rdk-docs` skill                                                                                                                 |
| `src/tools/device-tools.ts`                                                                                     | 82–83                 |        ~70 | `device_info`：RDK 或 Linux，先连，环境变量从哪来                                          | KEEP   | 第一次工具调用之前就要知道该调谁、目标从 `MOSS_DEVICE_*` 来                                                                                       |
| `src/tools/device-tools.ts`                                                                                     | 107–109               |        ~80 | `device_exec`：SSH 执行，ROS 命令走这里                                                    | KEEP   | 工具契约，不是教程                                                                                                                                |
| `src/tools/device-tools.ts`                                                                                     | 491                   |        ~80 | `device_robotics_status`：TROS 在 `/opt/tros`，ROS2 在 `/opt/ros/<distro>`，报 ros2 与 hbm | KEEP   | 探测工具的语义。路径与脚本一致，MCP 的 Hello World 也确认 `/opt/tros`                                                                             |
| `src/tools/device-tools.ts`                                                                                     | 492                   |        ~40 | 举例只写 `source /opt/tros/setup.bash`                                                     | SHRINK | Hello World 页还有 `/opt/tros/humble/setup.bash`。改成「source 本工具报告的安装目录里的 setup；发行版布局以 rdk-docs 的 tros 手册为准并引用 URL」 |
| `src/tools/device-tools.ts`                                                                                     | 517                   |        ~40 | `device_network`：接口、地址、默认路由                                                     | KEEP   | 读活板的 `ip` 输出。静态 IP 配方在 MCP，不进描述                                                                                                  |
| `src/tools/device-tools.ts`                                                                                     | 542                   |        ~45 | `device_cameras`：v4l2 名字在 sysfs，RDK 上传感器名会出现在这里                            | KEEP   | `v4l2` 检索返回的是 X3 USB 示例页，没有这条 sysfs 约定                                                                                            |
| `src/tools/web-fetch.ts`                                                                                        | 440                   |        ~10 | 示例 focus 词「architecture overview BPU」                                                 | DELETE | 换成与板卡无关的例子。删掉不损失任何可执行知识                                                                                                    |
| `src/safety/shell-soft-failure-hint.ts`                                                                         | 28                    |        ~40 | 设备命令失败后：`ros2 pkg prefix`、`dpkg -L`、`device_file_list`，或 `web_fetch` 官方文档  | SHRINK | 前半是板上排障，留。`web_fetch` 改成：设备/RDK 事实走 `rdk-docs`（`mcp__rdk_docs__search`），服务器不可达就说明超时，不要改用网页搜索编步骤       |
| `src/device/observation.ts`                                                                                     | 19–28                 |          0 | `INFO_PROBE_SCRIPT`，含 `/proc/cpuinfo` 的 `Hardware` 行                                   | KEEP   | 连接后的身份探测，发生在模型查阅文档之前。通用 POSIX，不是规格表                                                                                  |
| `src/device/observation.ts`                                                                                     | 46–51                 |          0 | `/opt/tros`、`/opt/ros/*`、版本文件、`hbm_shell`                                           | KEEP   | 探测脚本。`hbm_shell` 在 MCP 0 命中，脚本不能改成先问文档                                                                                         |
| `src/device/observation.ts`                                                                                     | 118–119               |        ~40 | 格式化输出里同一句 `source /opt/tros/setup.bash`                                           | SHRINK | 与工具描述同一条不完整示例。Humble 路径以手册为准                                                                                                 |
| `src/device/observation.ts`                                                                                     | 375–379               |          0 | `ip addr` / `ip route` / `ip link`                                                         | KEEP   | 活板观测。不包含 `192.168.127.10`                                                                                                                 |
| `src/device/observation.ts`                                                                                     | 439–442               |          0 | `/sys/class/video4linux` 与 `/dev/video*`                                                  | KEEP   | 同上，MCP 未覆盖这条探测                                                                                                                          |
| `src/contracts/device.ts`                                                                                       | 12–13, 68–69          |          0 | `DeviceKind = 'rdk' \| 'linux'`；`hardware` 来自 cpuinfo                                   | KEEP   | 只有两族，没有 X3/X5/S100 目录。注释写明 rdk 与 linux 今天都走 SSH                                                                                |
| `src/device/device-target.ts`                                                                                   | 19, 61–62             |          0 | `MOSS_DEVICE_KIND` 只接受 `rdk` 或 `linux`                                                 | KEEP   | 连接参数，不是板型识别正则                                                                                                                        |
| `src/device/device-registry-file.ts`                                                                            | 33                    |          0 | 持久化 kind 同样只收 `rdk`                                                                 | KEEP   | 同上                                                                                                                                              |
| `src/cli/device-commands.ts`                                                                                    | 21, 271, 295          |          0 | CLI `--kind rdk\|linux`                                                                    | KEEP   | 连接面                                                                                                                                            |
| `src/core/task/capability.ts`                                                                                   | 114–136, 246, 472–474 |        ~50 | 目标里出现 `rdk` / 机器人 / 摄像头 时把任务标成设备任务，并提示用 device\_\* 与证据        | KEEP   | 选工具之前的路由。没有烧录或引脚事实                                                                                                              |
| `src/core/task-runtime/runtime.ts`                                                                              | 127–135               |          0 | 任务种类正则含 `tros`、`bpu`、`humble`                                                     | KEEP   | TUI 分类，不产生答案                                                                                                                              |
| `src/cli/approval.ts`                                                                                           | 380–393, 403          |          0 | board 模式放行设备写；plan 模式拒绝 `device_mutation`                                      | KEEP   | 安全。与手册内容无关                                                                                                                              |
| `src/core/subagent/spawn-profile.ts`                                                                            | 169, 229              |          0 | explore/verify 禁止刷机、安装、卸载类工具                                                  | KEEP   | 安全禁令，不是烧录教程                                                                                                                            |
| `src/tools/task-tools.ts`、`src/tools/evidence-tools.ts`                                                        | 任务/证据描述         |          0 | 指标 + expected/observed/result                                                            | KEEP   | 验收约定。成功是裁决加证据，不是散文                                                                                                              |
| `bench/tasks/device-observe-evidence/task.json`、`device-deploy-verify/task.json`、`task-os-b-device/task.json` | 提示正文              |          0 | 探测 → `task_define` → `record_evidence` → `task_acceptance`                               | KEEP   | 闭环契约。三份提示都没有烧录、apt、GPIO、BPU 配方                                                                                                 |
| `test/device-observation.spec.mjs`                                                                              | 27–36                 |          0 | 夹具：`rdkx5`、`sun55iw3`、Ubuntu 22.04、内核 5.10.198、Cortex-A55                         | KEEP   | 解析器往返测试。`sun55iw3` 在 MCP 0 命中。夹具不进提示，不要升格成板型表                                                                          |
| 其余 `test/*` 里的 `rdk-x3` / `rdk-x5`                                                                          | 多处                  |          0 | 设备 id 或 CJK 排版句子                                                                    | KEEP   | 夹具名字，不是知识                                                                                                                                |
| `README.md`、`AGENTS.md` 设备节                                                                                 | 连接说明              |          0 | SSH、`MOSS_DEVICE_*`、工具名单、证据文件                                                   | KEEP   | 给人看的操作约定，不进模型的 RDK 手册层                                                                                                           |
| `docs/superpowers/plans/*` 等历史计划                                                                           | —                     |          0 | 把用户称作 RDK 开发者                                                                      | KEEP   | 历史，不是运行时知识。本计划不删它们                                                                                                              |

全仓库检索过 `src/`、`bench/tasks/*/task.json`、`.moss/skills`、`docs/`：没有板型目录、没有烧录步骤、没有 apt source 列表、没有 GPIO 针脚表、没有 hobot_dnn 调用说明、没有把 `Hardware` 字符串映射到型号的正则。

## 3. 最小集成

今天的 MCP 是零配置即零开销（`src/cli-main.ts` 约 728–731 行）。`rdk-docs` 是唯一的内置例外，仍然失败开放：连不上就少一个服务器，CLI 照常起来。

### 注册

- 名字固定 `rdk-docs`。stdio：`command=npx`，`args=["-y","rdk-docs-mcp@0.1.12"]`。**钉住本次审计的版本**，不默认 `@latest`。升级版本是一次单独的改动，带一次 `list_manuals` 复测。用户自己的配置可以改成 `@latest`。
- 注入点在 `loadMcpConfigs` 的合并结果之后：用户或项目的 `mcp.json` 里若已有同名 `rdk-docs`，那份定义整个替换内置项（命令、参数、超时都听用户的）。
- **退出不是「删掉条目」。** 缺省才注入，所以 `moss mcp remove rdk-docs` 之后下一次启动又会注入。退出开关用正信号：
  - 环境变量 `MOSS_NO_RDK_DOCS=1`，或
  - 用户配置里的布尔 `rdkDocs: false`（具体键跟现有 config 风格对齐，实现时再定名）。
- 不写用户的 `mcp.json`。不在首次启动时落盘。不把 `forum-post`、`article-writer` 装进 Moss。那两个 skill 是发帖和写文章，超出 harness 范围。
- 内置服务器单独的超时：连接 45 s，单次请求 20 s。其他 MCP 服务器保持今天的默认。

### 失败

沿用 `McpToolRegistry.connectAll` 的单服务器失败不抛出。文案收成一行，例如：

`[mcp] rdk-docs unreachable (<reason>) — RDK manual lookup is off this session.`

系统提示在该服务器失败时只加一句：RDK 手册服务器这次不可用；板卡操作步骤不要凭记忆编，直接说查不了。不重试循环，不写缓存，不退回一份内置手册。

### 系统提示（仅当 `rdk-docs` 已连接）

加在现有 `buildMcpPromptLayer` 对该服务器的那一行旁边，大约这些意思，不要扩成手册：

- 板型、烧录、BPU / hobot_dnn、相机、TROS、apt、网络、GPIO 的**事实**：先 `mcp__rdk_docs__search`，命中 `role=official-start` 就 `get_page`。查询用用户的原词，点名型号时分型号查，不要用另一型号的页回答。
- 手册是规范。`source=forum` 只在用户要社区经验、或手册没有这一页时使用，并且注明非正式。
- 引用：回复里给页面 URL；若这个事实支撑了某次 `record_evidence`，把 URL 写进 observed。手册引文不是验收通过。
- 针脚、电流、接口数量：正文里没有的表不要补全；页里是图片就说明要看官方图。两页数字冲突就两页都列出来。
- 连板、`device_info`、探测脚本、审批，不先查文档。文档查的是「板上该怎么做」，不是「Moss 怎么连」。

捆绑一份短 skill `rdk-docs`（渐进披露：提示里只有一行索引，正文走现有 `skill` 工具）。正文是上面的用法，加上「空壳页改开 `related`」「`truncated=true` 时加大 `maxChars`（上限 40000）」。不要把 npm 包里那份长 skill 原样拷进仓库——它还教论坛 JSON 兜底和发 skill 安装命令，Moss 不需要。索引行只在服务器连上时出现。

`device_robotics_status` 的描述和 `formatRoboticsSnapshot` 的那句示例，改成指向「探测到的路径 + 必要时查 tros 手册」，这是第 2 阶段，并且要等第 3 阶段的对照没有把真机闭环打退步。

### token

| 项                                                      |                  token（约） |
| ------------------------------------------------------- | ---------------------------: |
| 今天提示里可删的 RDK 示例                               |                          130 |
| 删完后必须留下的工具契约                                |                          400 |
| 连上之后新增的用法指针 + skill 索引行                   |                          150 |
| 净变化（连上时）                                        |                    大约 +100 |
| 一次 `get_page`（烧录页 ~6k 字符，MIPI 示例 ~16k 字符） | 约 1.5k–4k，只在该轮任务发生 |

不要为了「节省 token」把手册预取进系统提示。懒加载已经是 `src/core/mcp/registry.ts` 里 `buildMcpPromptLayer` 的设计。

## 4. 阶段与验收

### 阶段 0 — 本文件

验收：本文件在 `docs/superpowers/plans/`，且上文时延与 URL 能在 `rdk-docs-mcp@0.1.12` 上复现。复现方式是自写的 stdio 客户端调用 `tools/call`，不是改 Moss。

### 阶段 1 — 默认接上，先不删句子

产品改动只限：默认服务器、退出开关、该服务器的超时、失败一行、连接成功时的短提示与短 skill。

验收：

```bash
npm run test:filter -- --filter mcp-rdk-docs
npm run test:filter -- --filter mcp-lifecycle
npm run test:filter -- --filter mcp-client
```

新 spec 文件名含 `mcp-rdk-docs`，离线、用假传输或直接测配置合并：

- 无用户配置时，合并结果含 `rdk-docs`，参数为 `npx -y rdk-docs-mcp@0.1.12`。
- `MOSS_NO_RDK_DOCS=1` 或配置关闭时，结果里没有它。
- 用户 `mcp.json` 的同名条目替换内置项，而不是并列出两个。
- 连接失败不抛出进程；状态是 `failed`，提示层是「这次不可用」，不是用法说明。
- 连接成功时提示层含 `mcp__rdk_docs__search`，且 skill 索引出现；退出时两者都不出现。

有网时人工跑一次（CI 默认不跑，用环境变量打开）：

```bash
RDK_DOCS_LIVE=1 npm run test:filter -- --filter mcp-rdk-docs-live
```

该 spec 断言 `list_manuals` 的 id 含 `rdk-x` 与 `rdk-s`。无网络或未设变量则跳过，跳过不算失败。

### 阶段 2 — 缩掉三处示例

只动清单里标了 SHRINK / DELETE 的四处文本（`device-tools.ts:492`、`observation.ts:118-119`、`shell-soft-failure-hint.ts:28`、`web-fetch.ts:440`）。探测脚本不动。

验收：

```bash
npm run test:filter -- --filter device-observation
npm run test:filter -- --filter device-tools
npm run test:filter -- --filter shell-soft-failure
```

断言描述与 `formatRoboticsSnapshot` 不再出现唯一的 `/opt/tros/setup.bash` 示例；Humble 路径也不要硬编码进去。断言 `web_fetch` 的 schema 示例不再拿 BPU 当例子。

**本阶段在阶段 3 的门通过之后才合。** 先把对照跑在开关后面（例如 `MOSS_RDK_KNOWLEDGE=shrunk`），默认仍是今天的句子，直到数字允许把默认拨过去。

### 阶段 3 — `npm run bench:device` 的 2×2

仓库里还没有 `bench:device`（今天只有 `bench` 与 `bench:ab`）。新增 `scripts/bench-device.mjs` 与 `package.json` 脚本。它不是再训练一个裁判模型，而是对转录做确定性检查。

四个臂，同一 SHA，`--samples 5` 起：

| 臂  | 内置示例句                              | MCP                     |
| --- | --------------------------------------- | ----------------------- |
| A   | 今天的原文 `MOSS_RDK_KNOWLEDGE=builtin` | 关 `MOSS_NO_RDK_DOCS=1` |
| B   | 缩掉 `shrunk`                           | 关                      |
| C   | 原文                                    | 开                      |
| D   | 缩掉                                    | 开                      |

```bash
npm run bench:device -- --arm builtin,mcp-off --samples 5 --label A
npm run bench:device -- --arm shrunk,mcp-off --samples 5 --label B
npm run bench:device -- --arm builtin,mcp-on --samples 5 --label C
npm run bench:device -- --arm shrunk,mcp-on --samples 5 --label D
```

两组题目：

1. **知识题（不需要真机）。** 七条，每条 0 或 1，看转录里的 URL 和禁止出现的写法：
   - X5 烧录引用 `burn-sd-card`。
   - S100 烧录引用 `s100-xburn`，并且没有把 X5 的 SD 卡步骤写成 S100 的步骤。
   - Humble 的 source 引用 Hello World 页，且出现 `/opt/tros/humble/setup.bash`。
   - GPIO 引用 `40pin_define`，回复里不出现一份转录中 `get_page` 正文里没有的完整针脚表。
   - 问到 `hbm_shell` 时，不编造手册页（允许说检索无命中，或改用板上的探测结果）。
   - 有线默认 IP 引用 `network_blueteeth` 且给出 `192.168.127.10`。
   - 问 X5 的 BPU API 时，引用的 URL 含 `RDK_X5`，不含 `RDK_X3` 那一页。
2. **真机闭环（要 `MOSS_DEVICE_HOST`）。** 现有 `device-observe-evidence`、`device-deploy-verify`、`task-os-b-device`。成功 = `task_acceptance` PASS。无环境变量则跳过，跳过不计负分，与今天的 `requiresEnv` 一致。

门（写在脚本输出里，不要口头判）：

- 知识题：D 的均分 ≥ A 的均分 + 0.30（满分 1），samples ≥ 5。不到就不把阶段 2 的缩句改成默认。
- 真机闭环：D 的通过率落在 A 的噪声带里。MCP 或缩句若让模型去翻文档而不去 `device_info`，这项会失败，指针就写重了，要改提示而不是加回手册。
- B（缩句且无 MCP）是阴性对照。它不应当成为出厂默认。若 B 并不比 A 差，说明那三句示例本来就没在起作用，缩句可以合，但仍然不要指望它提升知识题。
- C 对 A 量的是「只加 MCP、不动原文」的收益，用来确认收益来自服务器而不是来自删句子。

结果落在 `bench/results/`，不入库。同 SHA 重复跑用现有 `npm run bench:noise` 的纪律看噪声带；带内的差不下结论。

## 5. 不在本计划里

- 不引入离线缓存或手册镜像。
- 不把 `sun55iw3` 或 `hbm_shell` 写进提示。
- 不增加 X3/X5/S100/S600 枚举类型。`DeviceKind` 维持 `rdk | linux`，型号以板上的 `device_info` 和手册页为准。
- 不安装 `forum-post` / `article-writer`。
- 不把论坛检索改成默认。默认 `search_docs` 只查手册，与服务器自己的描述一致。
