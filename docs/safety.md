# 安全与隐私

Moss 的权限模型、审批语义、受保护路径、hook 与设备安全策略。默认 full 模式对齐
Claude Code 的「默认少问」而不是「关闭检查」：deny 规则与本机硬拦截永远生效。

## 安全与隐私

- **v0.26 起默认 full**：本地写操作与**可逆**设备变更跳过逐次询问。毁灭性设备操作（重启、刷机、写入 `/boot` 或 `/etc`、改网络、卸系统包、停掉 ssh）仍要确认——full 对齐的是 Claude Code 的「默认少问」，不是对真机的 `--dangerously-skip-permissions`。
- **四态交互模式**（Shift+Tab 循环，或 `/plan` 进入 plan；`/mode` 仍可用一版）：

  | 模式           | 行为                                                                                              |
  | -------------- | ------------------------------------------------------------------------------------------------- |
  | `manual`       | 写操作与设备变更逐次询问                                                                          |
  | `acceptEdits`  | 工作区内文件工具编辑自动通过，shell 与设备变更仍询问                                              |
  | `plan`         | 只读规划，写操作与设备变更被拦                                                                    |
  | `full`（默认） | 本地写与可逆设备操作跳过询问；毁灭性设备操作 TTY 确认、headless 拒绝。deny 规则与本机硬拦截仍生效 |

- **`workspace-write` 不是操作系统沙箱。** `workspace-write` 只约束 Moss 自己的文件工具。终端命令照常运行，没有操作系统沙箱。`write_file`、`edit_file`、`multi_edit`、`move_file`、`apply_patch` 写在工作区内；`exec` 默认没有 Landlock、bubblewrap 或 seatbelt。静态扫描会拦下它能看见的一部分出区写（重定向、`cp`、`mv`），挡不住子进程里的 `node` / `python`（例如写入 `/tmp`）。shell 的安全来自输出脱敏和写回防护。
  **可选**的操作系统沙箱已实现（D14）：`permissions.osSandbox: true` 或 `MOSS_OS_SANDBOX=1` 时，`exec`/后台 exec 在 macOS 走 seatbelt、Linux 走 bubblewrap（仅工作区可写、`/tmp` 只读、无网络、`.git/hooks` 写拒绝）；缺后端会拒绝执行而不是退回普通 shell；`full-access` 模式按设计不进入。默认仍关闭，见 [`docs/design/os-sandbox.md`](docs/design/os-sandbox.md)。
- **权限规则**（`/permissions`，任何模式生效，deny 优先于一切含 full）：
  - 三级 `allow` / `ask` / `deny`，优先级 deny > ask > allow；
  - 语法 `ToolName(pattern)`，用 moss 原生工具名：`/permissions add deny "read_file(./.env)"`、`/permissions add allow "exec(npm run *)"`；
  - 会话级规则下一个工具调用即生效；`/permissions persist` 写用户配置重启仍生效；
  - `--read-only` / `MOSS_SAFETY_MODE=read-only` 是压过任何模式（含 full）的只读上限。
- **本机硬拦截永不撤**：本机 `exec` 的毁灭性命令（`rm -rf /` 等）与路径逃逸在 full 模式下同样被拦——full 跳过的是询问，不是检查。设备侧的同一类命令不硬拦死：TTY 确认、allow 规则，或显式信任之后会真的执行。
- **PreToolUse 钩子返回 `ask`（O157）**：钩子 exit 0 且输出 `hookSpecificOutput.permissionDecision: "ask"`（claude 格式）或 `decision: "ask"`（moss 格式，等价字段）时，交互模式下弹出 Moss 的确认（y/a/n），写明是哪个钩子要求确认和它给的理由；任何模式都会问，full 也一样。`y` / `a` 只放行这一次（`a` 不记住，下次该钩子仍会问），`n` 按拦截处理。`-p` 和没有交互终端的运行无法确认，按拒绝处理，末行「被拦」、exit 9。多个钩子合并时 deny > ask > allow；deny 规则和本机硬拦截仍优先。`blocking: false` 的钩子不能限制调用，它的 `ask` 和 `deny` 一样被忽略。与 Claude Code 一致的是 ask 会弹确认；Moss 另外规定：`-p` 下按拒绝处理，`a` 只放行这一次、不加入信任，exit 非 0 的钩子即使输出 ask 也按拒绝处理（O135）。
- **受保护路径（O94）只是尽力拦截，不是沙箱**：文件工具与 shell 命令直接写入、删除或移动受保护路径（如 `~/.ssh`、`.git/` 内的文件）时，即使在 full 模式下也要确认一次；`git commit`、`git checkout` 等 git 自身对 `.git/` 的写入不弹确认。shell 这一层靠解析命令行识别写入目标，属于尽力拦截，不是操作系统沙箱。通过脚本间接写入（如 `python x.py`、`node -e`、`bash -c`）由 O101 三层处理：内联代码与工作区脚本在执行前走同一套确认（`-p` 下拒绝）；绕过前两层的改动在命令结束后用元数据快照检出，标成「已被修改」并让 run outcome 未完成（退出非 0），不自动还原。shell 层仍是尽力拦截，不是沙箱；`exec_background` 在进程完全退出时同样做第三层对比。单条前台命令里的 `&` / `nohup` 延后写入，以及 Moss 进程退出后的写入，仍是已知局限。
- **显式信任设备**（任一即可；deny 仍赢）：`--trust-device`（仅本进程）、`MOSS_DEVICE_TRUST=full`、`permissions.deviceTrust=full`、`permissions.trustedDevices` 或 `MOSS_DEVICE_TRUST_DEVICES`（逗号分隔的 host / device id）。确认框里选 `a` 只信任提示里写明的范围（例如同一 unit 的 `systemctl restart` 或 `stop`，或同一命令前缀），不是整台设备的全部毁灭性操作。读取 `/etc/shadow`、私钥、`sshd_config`、`authorized_keys` 归入 `sensitive`：同样要确认，但文案和证据不把它叫成毁灭性修改。确认与拒绝文案跟随界面语言（`--lang`、`MOSS_LANG` 或用户配置 `language`；否则系统区域以 `zh` 开头时为简体中文）。每次决定写入 `.moss/evidence.jsonl`（`metric: device_policy`），有进行中的任务时同时写入时间线 `note`。策略说明见 [`docs/superpowers/plans/2026-10-09-device-safety-policy.md`](docs/superpowers/plans/2026-10-09-device-safety-policy.md)。
- **旧键兼容**（一版宽限）：`profile` / `trustedTools` / `deniedTools` / `safetyMode` / `approvalPolicy` 读入即按映射表翻译（cautious→manual+只读上限、balanced→manual、autonomous→full、trustedTools→allow 规则、deniedTools→deny 规则），写侧提示 deprecated，新配置请用 `permissions.*` 块。
- **Moss 启动的程序不从工作区取（O158）**：启动探测、shell 解析、git 探测、hook 的启动命令、MCP 服务器等 Moss 自己启动的程序，一律解析成绝对路径，只查 PATH 里的绝对目录，跳过空项、`.`、相对路径和工作区内的目录；Windows 子进程设 `NoDefaultCurrentDirectoryInExePath=1`。**已知限制**：在 PATH 含工作区目录的环境里启动 moss（例如 `npx` / `npm run` 带来的 `node_modules/.bin`）时，模型 exec 的命令和 hook 脚本内部调用的程序沿用这个 PATH，会使用项目里的同名工具。
- **hook 启动命令的安全解析范围（O164）**：Moss 只对 hook 命令开头的那个程序名做上面的安全解析。用了环境变量前缀（`FOO=1 git`）、`exec` / `env` / `command`、引号、子 shell、分号或重定向时，按普通 shell 查找；若以 `npx` / `npm run` 启动，PATH 里的 `node_modules/.bin` 会被用到。用户级 hook 建议写成 `程序名 参数` 或绝对路径。项目 hook（`.moss/config.json`）只在你信任该文件夹后才运行；信任文件夹等于信任项目代码，包括项目 hook 和 `node_modules/.bin` 里的程序。
- **`.env` 不能改系统位置（O164）**：`SystemRoot`、`windir`、`SystemDrive`、`ProgramFiles`（含 `(x86)`、`ProgramW6432`）、`PSModulePath`、`NoDefaultCurrentDirectoryInExePath` 与 `PATH`、`PATHEXT`、`ComSpec`、`TEMP`/`TMP` 一样不能由 `.env` 设置；Moss 拼系统程序路径（如后台任务用的 `powershell.exe`）时只用加载 `.env` 之前的环境。子进程的 PATH 被清空（只剩 `.`、空项）时换成一个不存在的绝对目录，不会留空串。
- **hook 输出超过捕获上限即拦截（O162）**：每个 hook 的 stdout / stderr 各有 10 MiB 捕获上限；一旦有输出被截断，判定（最后一行 JSON）就不可信，所有阻塞类事件（`PreToolUse`、`UserPromptSubmit`、`PermissionRequest`、`Stop`）一律按拦截失败关闭——退出码与可读部分说了什么都不算数。`blocking: false` 的 hook 不能收紧任何调用，其输出超限同样不拦截。
- **脚本的参数不是删除（O168）**：解释器脚本形式的参数（`python3 x.py $HOME`、`node x.js "$PWD"`）、`sh x.sh` 的参数、`.`/`source` 的操作数与裸 `.` 不再触发「删除受保护祖先」规则——正常命令不再被误拦，非 git 目录也不再被说成 git 仓库内部文件。豁免与 cd 一样仅限该路径未在命令其他位置出现；直接点名受保护路径（`$HOME/.ssh`、`.git/config`）、内联形式与真实删除行为不变，实际写入仍由脚本扫描与运行后快照兜底。
- **git 的 pack 旗标按可执行拦截（O169）**：`git clone --upload-pack=<cmd>`、`git fetch/push --upload-pack/--receive-pack=<cmd>`（含空格分开与 clone 的 `-u` 短旗标）会让 git 执行该命令，与 `git -c`、`--ext-diff` 等一样在执行前拦截；`git push -u origin main`（设上游）不受影响。
- **hook 抛异常一律拦截（O165）**：处理 hook 时抛出的任何异常都按拦截失败关闭并给出可见提示（PreToolUse 拦下调用、PermissionRequest 拒绝、UserPromptSubmit 拒绝提示词）；抛异常的 Stop hook 是终局否决——不强制续跑、不再调用模型，headless 以未完成（exit 9）结束。`-p` 下 UserPromptSubmit 被拦时末行「被拦」、exit 9（原为 exit 8）。
- **shell 执行类环境变量与 tmux/screen 拦截（O170）**：`BASH_ENV`、`ENV`、`PROMPT_COMMAND`、`ZDOTDIR`、`BASH_FUNC_*` 的赋值让 shell 执行代码，`tmux new-session/run-shell/send-keys`、`screen` 携带命令时在 Moss 进程树外执行——均按可执行形式在执行前拦截。环境变量仅在同行有 POSIX shell 头时报（`ENV=production npm start` 不误拦）；`tmux ls`/`attach` 等无命令形态不受影响。
- 凭据只从 `.env` 或环境变量读，绝不硬编码、不进日志、不传子进程、不写设备清单。
- 无账号、无云服务、无遥测；provider 是普通 HTTP 端点。
