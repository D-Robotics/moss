# 安装与运行环境

本页收纳 Moss 的安装、Node 版本前提、升级/卸载、代理与自定义网关。README 只给一行安装；
遇到环境问题从这里查。

## 环境

先看 Node 版本（**硬性前提：Node ≥ 22.16.0**）：

```bash
node -v
```

没有合格 Node 时，先装再继续（可复制）：

- **macOS：** `brew install node@22`，或 `nvm install 22 && nvm use 22` / `fnm install 22 && fnm use 22`
- **Ubuntu / Debian：** NodeSource（[nodesource/distributions](https://github.com/nodesource/distributions)）或同上 nvm / fnm
- **Windows（PowerShell）：** `winget install OpenJS.NodeJS.LTS`
- **国内网络：** `npm config set registry https://registry.npmmirror.com`；nvm 下载 Node 可设 `NVM_NODEJS_ORG_MIRROR=https://npmmirror.com/mirrors/node`

Node 低于 22.16 时，`npm install -g @rdk-moss/agent@latest`（以及源码路径的 `preinstall` / `prepare`）会**立刻非零退出**，打印当前 Node 版本和可复制的升级命令（含成功后再跑的 `npm install -g @rdk-moss/agent@latest`），**不会**留下坏掉的全局 `moss`。Node 22.16 自带 npm 10，不要按 npm 的提示升级到 npm 12：这个 Node 不支持 npm 12。

### macOS

Git 需要 Xcode Command Line Tools。没有 `git` 时运行 `xcode-select --install`。Moss 自己不需要 C 编译器，`cpu-features` 的可选原生构建失败也不影响运行。全局目录没有写权限时，用下面的用户级 prefix。

### Windows

先装 Git for Windows。PowerShell 的执行策略可能拦截 `moss.ps1`。只给当前用户放开脚本：

```powershell
Set-ExecutionPolicy -Scope CurrentUser RemoteSigned
```

把 `%APPDATA%\npm` 加进 PATH。这是 npm 在 Windows 上的默认全局命令目录。

## 快速开始

**推荐（一行）：** 已装 Node ≥ 22.16 时：

```bash
npm install -g @rdk-moss/agent@latest
moss --version
moss
```

如果以前装过旧的未加 scope 的 `moss` 包，先执行 `npm uninstall -g moss`，否则两个包抢同一个 `moss` 命令，npm 会报 EEXIST。不要加 `--force`：它会同时留下旧包和 `@rdk-moss/agent`，之后再 `npm uninstall -g moss` 会把 `moss` 命令一起删掉。

全局目录没有写权限（EACCES）时，把 prefix 放到用户目录，或改用 nvm（Node 装在家目录里）：

```bash
npm config set prefix ~/.npm-global
```

把 `~/.npm-global/bin` 加进 PATH，然后重新打开终端。

<details>
<summary>从源码开发（可选）</summary>

贡献 / 改代码时用克隆。`npm ci` 会跑 `prepare`（先检查 Node，再 `npm run build`），所以不用再单独构建：

```bash
git clone https://github.com/D-Robotics/moss.git
cd moss
npm ci
npm install -g --install-links .
moss
```

npm 11 可能打印 `npm warn install-scripts`。`npm ci` 可能会点名 `ssh2` 和 `cpu-features`。接下来的 `npm install -g --install-links .` 还可能点名 `@rdk-moss/agent`（它的 `preinstall` 和 `prepare`）。这是提示，安装仍然成功：ssh2 没有可选的原生模块也能用，全局副本里已经有 `dist/`。不要运行 `npm audit fix --force`，它会改依赖版本，装完不能用。

</details>

没有可用配置时，`moss` 就在这个界面里设置（按数字选服务商，或按 Enter 使用环境里已有的 key，内容不会显示）。D-Robotics 地瓜网关是第一项，已经预选（地址 `https://ai-api.d-robotics.cc/v1`，默认模型 `deepseek-flash`，只问 key）。不想把 key 写进文件时，先指定服务商再写变量名：`moss config set provider d-robotics`，然后 `moss config set apiKeyEnv <变量名>`。只写 `apiKeyEnv`、不写服务商或地址时，会先问选哪一家，不会把 key 发给默认的 DeepSeek。设好后在同一会话里说：

```text
看一下这个目录里有什么
```

### 自定义 OpenAI 兼容网关

内置预设之外的网关用 `openai-compatible`。四条命令分别写入服务商、模型、地址和密钥变量名（`apiKeyEnv` 的值是变量名，不是密钥本身）：

```bash
moss config set provider openai-compatible
moss config set model your-model-name
moss config set baseUrl https://gw.example
moss config set apiKeyEnv MY_GATEWAY_API_KEY
export MY_GATEWAY_API_KEY=your-key
moss doctor
```

`baseUrl` 末尾的 `/v1` 可写可不写。`https://gw.example` 和 `https://gw.example/v1` 都可以。Moss 自己拼接 `/v1/chat/completions`，不会变成 `/v1/v1`。不必写 `/chat/completions`，写了也会被去掉。`moss doctor` 核对服务商、模型、地址，以及密钥变量是否已设置。

进到交互界面后：

- `moss "整理这个项目的 README"` 直接派活；`@` 引用文件，`!` 执行 shell
- `Shift+Tab` 在模式间切换（`plan` = 只读规划）；`/plan` 进入 plan 模式。`/mode` 仍可用一版
- `Ctrl+V` 粘贴剪贴板图片 / Finder 文件 / 本地路径作为附件（macOS；Linux 用 wl-paste/xclip，Windows 用 PowerShell）
- `/help` 看键位与命令，`/goal <条件>` 做到为止，`/model` 换模型

<details>
<summary>不装到 PATH 也能跑 · 一次性模式 · 会话恢复</summary>

```bash
node dist/cli.js --help                       # 直接跑构建产物
moss "check disk usage"                       # 一次性模式（也支持管道：echo "list files" | moss）
moss resume --last                            # 继续最近一次会话
moss --no-tty                                 # 强制使用 readline REPL
```

</details>

## 升级

如果 `moss` 命令还来自旧的未加 scope 的包（包括 `npm link`），先执行 `npm uninstall -g moss`。否则新的全局安装会报 EEXIST，而这时 `moss --version` 看起来可能已经是新的。

**npm 全局安装**（推荐路径）直接：

```bash
npm install -g @rdk-moss/agent@latest
```

**已有源码克隆**时，在它的上一级目录运行：

```bash
cd moss && git pull && npm ci && npm install -g --install-links .
```

`npm ci` 会重新构建。`--install-links` 把新的副本装进全局 prefix，而不只是重新编译克隆目录。`moss --version` 带短 commit 和构建日期，例如 `moss v0.26.0 (e8dc2e3, 2026-10-10)`。构建时工作区有未提交改动会写成 `e8dc2e3+dirty`。升级前后可以对上。

`moss update` 按安装方式打印对应命令：npm 全局打印上面的 `@latest` 一行；找得到克隆就打印克隆升级行；都没有才打印 `git clone`。全局安装只在当前目录和 `./moss` 里找克隆。别的位置用 `moss update --dir <克隆>` 或 `MOSS_SOURCE_DIR`。它只打印命令，不执行。

## 卸载

```bash
npm uninstall -g @rdk-moss/agent
```

这条只卸掉命令。下面的东西会留下：

- 配置：Linux / macOS 是 `~/.config/moss`（设了 `XDG_CONFIG_HOME` 时在那里的 `moss`），Windows 是 `%APPDATA%\moss`。也检查 `~/.moss`
- npx 缓存：`~/.moss/cache/npx`
- 每个项目里的 `.moss/`（任务、会话、项目配置）
- 源码克隆目录
- npm 缓存，一般是 `~/.npm`
- 原生模块缓存：`~/.cache/node-gyp`
- prefix 里可能留下空的 `@rdk-moss` 目录：Linux / macOS 是 `$(npm prefix -g)/lib/node_modules/@rdk-moss`，Windows 是 `%APPDATA%\npm\node_modules\@rdk-moss`

可以删：`~/.moss/cache/npx`、`~/.cache/node-gyp`、npm 缓存（`npm cache clean --force`）、空的 `@rdk-moss` 目录，以及你不再需要的克隆目录。删掉 `~/.config/moss`、`~/.moss` 或项目里的 `.moss/` 会同时去掉 key、设置和任务记录；只有确定不要这些数据时再删。

## 板子无法访问外网 / 需要代理

实验室 / 教室里的 RDK 板子常常**直连不了** GitHub、npm、Node 镜像和模型网关（TCP 超时）。第一步 `git clone` 就会卡住。

**必设环境变量（正式推荐，仅此）：**

```bash
export HTTPS_PROXY=http://127.0.0.1:1080
export HTTP_PROXY=http://127.0.0.1:1080
export NO_PROXY=localhost,127.0.0.1,::1
# 当前 Moss main（含 O83 / #81 起）会自动让 Node fetch 走上述代理，
# 不必再设 NODE_USE_ENV_PROXY（那是旧 tip 的临时绕过，当前不需要）
```

端口与是否需要 `ssh -R` 隧道按现场配置。

**板上首装注意：**

1. **git clone：** 用 `git clone --depth 1 https://github.com/D-Robotics/moss.git`；完整 clone 在慢网 / 代理下容易 GnuTLS / early EOF。
2. **npm：** 国内可 `npm config set registry https://registry.npmmirror.com`；镜像**不能代替** `HTTPS_PROXY`——仍需代理才能出网时两者都要。
3. **Node：** 许多 RDK 镜像已带 Node ≥ 22.16；若需 nvm，安装脚本依赖 `raw.githubusercontent.com`，不出网会超时——优先用系统 Node，或经代理装。
4. **用户级 prefix：** root 下 `npm i -g` 会写 `/usr`；推荐 `npm config set prefix "$HOME/.npm-global"` 并把 `bin` 加进 PATH。

**如何确认代理生效（必须两条都过）：**

1. 代理日志里有目标模型 / 网关主机的 `CONNECT`；
2. 端到端拿到**有效回答**（`moss -p "…"` 退出码 0，不是「网络连接失败」）。

**仅有 CONNECT、仍报网络失败 = 未过关。** 排查时可临时 `MOSS_NO_RDK_DOCS=1` 做对照；根因修复见 backlog **O87**（CONNECT 有、回答无），本 README 不替代该项。连接类错误请检查代理 / 防火墙，**不要**按「换更快的模型」处理。
