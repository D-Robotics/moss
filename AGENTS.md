# AGENTS.md

本文件是 Moss 仓库对所有 coding agent 的项目指令（被 git 跟踪、可审查）。
共享代码规范以 [`docs/code-standards.md`](docs/code-standards.md) 为唯一事实来源；本文件只补充 coding agent 所需的架构导航与执行硬规则。

## 仓库身份

Moss 是 D-Robotics 出品的跨平台 agent harness：TypeScript / ESM / npm-workspaces monorepo，Node ≥ 22.16.0（以根 `package.json` 的 `engines.node` 为准），运行于 Linux / Windows / macOS。

三个包，依赖方向**严格单向、不可逆转**：

```
create-moss-app → @rdk-moss/agent → @rdk-moss/core
```

| 包                         | npm 名            | 职责                                                                                                                                                                                   |
| -------------------------- | ----------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/moss`            | `@rdk-moss/core`  | 核心契约：KnowledgeModule、PlatformExtension、VendorPlugin、Host Adapter、DeviceFamily。无运行时依赖。                                                                                 |
| `packages/moss-agent`      | `@rdk-moss/agent` | 独立 agent 运行时 + `moss` CLI：agent loop、工具框架、上下文管理、providers、safety，以及 in-tree 子系统（memory / skills / skill-learning / teaching / mesh / mcp / observability）。 |
| `packages/create-moss-app` | `create-moss-app` | 项目脚手架 CLI。                                                                                                                                                                       |

子系统不是独立包，住在 `packages/moss-agent` 内，通过其 `package.json` subpath exports 对外暴露。
包级差异分别见 [`packages/moss/AGENTS.md`](packages/moss/AGENTS.md)、
[`packages/moss-agent/AGENTS.md`](packages/moss-agent/AGENTS.md) 和
[`packages/create-moss-app/AGENTS.md`](packages/create-moss-app/AGENTS.md)；扩展面见
[`packages/moss-agent/EXTENDING.md`](packages/moss-agent/EXTENDING.md)。

## 文档所有权与阅读顺序

本文件是所有 coding agent 的仓库入口，但不是所有知识的副本。不要在 AGENTS 中手工维护
测试数量、文件行数、版本路线图或“当前 DONE”；这些事实会漂移。

| 问题                              | 权威入口                                                                                         |
| --------------------------------- | ------------------------------------------------------------------------------------------------ |
| 用户如何安装和使用                | [`README.md`](README.md)、[`README_CN.md`](README_CN.md)、[`docs/user-guide/`](docs/user-guide/) |
| 文档按受众/任务怎么找             | [`docs/README.md`](docs/README.md)                                                               |
| 系统所有权、执行与状态边界        | [`ARCHITECTURE.md`](ARCHITECTURE.md)                                                             |
| 共享代码标准和 required gates     | [`docs/code-standards.md`](docs/code-standards.md)                                               |
| 人类贡献、PR、commit 与 changelog | [`CONTRIBUTING.md`](CONTRIBUTING.md)                                                             |
| agent runtime 包内 owner/热区     | [`packages/moss-agent/AGENTS.md`](packages/moss-agent/AGENTS.md)                                 |
| host 应怎样扩展 Moss              | [`packages/moss-agent/EXTENDING.md`](packages/moss-agent/EXTENDING.md)                           |
| 稳定公开 API                      | [`packages/moss-agent/API.md`](packages/moss-agent/API.md)                                       |
| Host Adapter 契约                 | [`docs/host-adapter-contract.md`](docs/host-adapter-contract.md)                                 |
| 当前变更的方案和任务              | `openspec/changes/<change-id>/`、issue、PR                                                       |

冲突处理：源码/测试/manifest 决定实现事实，code standards 决定共享规则，已接受 contract/ADR
决定设计边界。design/plan 只描述候选或历史理由；除非带有已实现证据，不代表当前 runtime。

## 第一次进入仓库

```bash
npm ci
npm run check
```

先用 `git status --short` 识别已有用户改动，再按下面的变更地图找 owner 和 focused test。
准备交付时才升级到 `npm run verify`；成功语义和恢复方式见下一节，不能用“命令启动过”代替通过。

## 想做 X → 去哪改

| 改动类型                  | Owner / 首个入口                                 | Focused 路由                                                                                               | 必须同步                           |
| ------------------------- | ------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- | ---------------------------------- |
| Core contract / prompt    | `packages/moss/src/`                             | `npm run test:filter -w @rdk-moss/core -- --filter <name>` + `npm run api:check`                           | TSDoc、API report、changelog       |
| Agent loop / context      | `packages/moss-agent/src/core/`、`context/`      | `npm run test:filter -w @rdk-moss/agent -- --filter <loop-or-context>`                                     | 可观察行为、取消/恢复负例          |
| Tool lifecycle / safety   | `packages/moss-agent/src/core/tools/`、`safety/` | `npm run test:filter -w @rdk-moss/agent -- --filter <tool-or-approval>`                                    | side-effect metadata、审批负例     |
| Provider                  | `packages/moss-agent/src/provider/`              | `npm run test:filter -w @rdk-moss/agent -- --filter <provider>`                                            | capability、错误边界、配置文档     |
| CLI / TUI / slash command | `packages/moss-agent/src/cli/`、`cli-main.ts`    | `npm run test:filter -w @rdk-moss/agent -- --filter <cli-command>` + `npm run smoke:moss-cli`              | help、user guide、退出码           |
| Public subpath / export   | package exports + `src/index.ts`                 | `npm run api:check`                                                                                        | API、README、release tag/changelog |
| Host Adapter              | `packages/moss/src/contracts/host-adapter.ts`    | `npm run test:filter -w @rdk-moss/core -- --filter host-adapter` + `npm run api:check`                     | contract doc、迁移、版本评审       |
| Skill / MCP / knowledge   | `skills/`、`mcp/`、knowledge modules             | `npm run test:filter -w @rdk-moss/agent -- --filter <subsystem>` + `npm run check:agent-harness-benchmark` | trigger/禁用/失败路径              |
| Scaffold                  | `packages/create-moss-app/`                      | `npm run test -w create-moss-app`                                                                          | 模板、默认版本范围、生成物契约     |

路径和命令的细节可以演进；如果本表入口不存在，先用 `rg --files`/符号搜索确认当前 owner，并在
同一变更修正文档，而不是按旧文档新建平行实现。

## 环境准备与命令面（根 manifest）

| 命令                        | 前置条件 / 输入范围                                                                  | 成功契约                                                                                 | 产物 / 副作用                                        | 失败恢复                                                  |
| --------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------- |
| `npm ci`                    | Node ≥ 22.16.0；输入为根 `package-lock.json`                                         | exit code 0；锁文件不发生意外变更                                                        | 重建 `node_modules/`、安装本地 hook；不改源码        | 修复 Node/网络后重跑；不得改锁文件绕过安装失败            |
| `npm run build`             | 已安装依赖；输入为三个 workspace 源码                                                | exit code 0；三个 workspace 应构建项完成                                                 | clean 后重建各包 `dist/`                             | 从首个 workspace 编译错误修复；不要提交 `dist/`           |
| `npm run typecheck`         | 已安装依赖；全工作区 TypeScript                                                      | exit code 0；无 TypeScript 错误                                                          | 只读检查，无持久报告                                 | 在所属 package 跑最窄 typecheck，修复后回到全仓           |
| `npm run test`              | 已 build 或由包脚本 build-first；core → agent → create-app                           | exit code 0；每包至少发现一个 spec 且全部通过                                            | stdout 为证据，可能重建 `dist/`；硬件项只显式 opt-in | 用 `test:filter` 复现首个失败；0 tests/无匹配不能作为成功 |
| `npm run lint` / `lint:fix` | 已安装依赖；tracked TS/MJS/测试/配置                                                 | `lint` exit code 0；0 warning                                                            | `lint` 只读；`lint:fix` 会修改源码                   | 先用 `lint` 定位；只在准备审阅修改时运行 `lint:fix`       |
| `npm run check`             | 已安装依赖；format、lint、typecheck、boundaries、hygiene、maintainability、standards | exit code 0；所有子检查真实执行，任一失败非零                                            | 只读快速门禁，可能生成工具缓存                       | 单跑失败子检查；不得降低 baseline 或删除负例换绿          |
| `npm run api:check`         | 已安装依赖；公开 exports 与 API reports                                              | exit code 0；公开 API 无未审批漂移                                                       | 构建声明并比较 reports                               | 有意 API 变更走 review 后运行 `api:update`，否则修复漂移  |
| `npm run docs`              | 已安装依赖；当前公开源码                                                             | exit code 0；TypeDoc 可从源码生成                                                        | 生成 `docs-api/`，不改源契约                         | 先修 TSDoc/公开类型；生成物不替代 `api:check`             |
| `npm run smoke:moss-cli`    | 已安装依赖并可打包 CLI                                                               | exit code 0；打包后 CLI 与 PTY 入口可启动                                                | 创建临时包/进程并自动清理                            | 检查打包清单与入口；不可用固定输出冒充启动成功            |
| `npm run verify`            | clean checkout + `npm ci`；输入为全仓 tracked 内容                                   | exit code 0；required 检查全部通过（含零新增警告 TypeDoc）；opt-in 硬件不可用时显式 SKIP | 完整构建、API reports、测试与缓存；不改 tracked 源码 | 从失败的 focused gate 修复；required 层不得 skip          |

单包测试：`npm run test -w @rdk-moss/core`。
日常快速反馈跑 `npm run check`；交付前完整验证跑 `npm run verify`。

## 测试约定

- 测试是各包 `test/` 下的 `*.spec.mjs`，**面向构建产物**（import `dist/`），由 `scripts/run-package-tests.mjs` 顺序执行；两包 `test` 脚本均 build-first。
- 聚焦迭代：先构建一次，再用过滤路由只跑相关子集，不必每次全量：

```bash
npm run build -w @rdk-moss/agent
npm run test:filter -w @rdk-moss/agent -- --filter coding-completion-gate
```

- `--filter` 支持多次传入，子串或 glob 匹配 spec 路径。成功契约：至少匹配 1 个 spec，且所有匹配 spec 均 exit code 0；无匹配时报错退出（不静默通过）。
- 新增 spec 时文件名包含被测模块名，保证过滤路由可持续命中。
- 动态 ESM import 一律 `pathToFileURL(...).href`（Windows 兼容）。

## 边界与不变量（check/verify 强制，失败就改内容、绝不弱化检查）

- 公开包不得 import host 路径（`server/`、`electron/`、`config/`）；不得含真实凭据 / API key / 内网 IP / 个人标识（注释、测试、文档里也不行）；不得提交 `dist/`。
- 每个包的 `engines.node` 必须等于 root；每个包必须有 `test` script。
- bump `@rdk-moss/core` 版本必须同步 `packages/create-moss-app/index.mjs` 里的 `DEFAULT_MOSS_VERSION_RANGE`。
- markdown 链接（含锚点）必须可达。

## 已付学费的硬规则（每条都至少引发过一次 P0）

- 库包内禁止新增 module-level 可变状态——状态住实例上；进程级单例需设计意图注释 + 2+ 实例隔离测试。
- `@rdk-moss/agent` 运行时的子进程只能从 `utils/run-process.ts` 进入：有界命令使用 `runProcess`（AbortSignal + timeout + maxBuffer）；交互式/常驻进程使用 `spawnProcess` 并由调用方管理生命周期；同步探测或退出清理使用 `runProcessSync` 且必须有有限超时。工具执行路径禁用 `execFileSync`/`execSync`。
- 新工具声明 side-effect 元数据（readonly vs mutating 驱动审批/审计/replay）。
- 非流式 LLM provider 必须声明 `capabilities: { streaming: false }`。
- 跨工具 / provider / CLI / 公开 runtime 边界的错误走 `MossError` / `wrapAsMoss`；内部原生错误按[错误边界规范](docs/error-boundary-policy.md)在所属边界转换，禁 `catch (err: any)`。
- **没有验证过的结果不报成功**：面向用户的成功消息必须来自操作的真实结果（probe / exit code / post-condition），绝不能是固定字符串。

## 工作纪律

- **改代码前**：先做结构导航（符号/调用关系），再读真实源码确认确切文本。
- **Surgical 改动**：只改必须改的，匹配现有风格，每行改动可追溯到具体需求。
- **修一个 = 修一类**：修完 bug 先 grep sibling，确认同类形状没有漏网的。
- **Bug 修复三步**：Declare（改结构）→ Enforce（runtime 真读并照做）→ Test（修复前 fail、修复后 pass 的测试）。旧测试全绿只证明没弄坏，不证明修好了。
- **行为验证优先于静态检查**：每改完一个逻辑块，实际运行 moss 验证一次（`npm run build && node packages/moss-agent/dist/cli-main.js "<验证 prompt>"`），验证内容匹配改动性质。
- **API 稳定性**：三包均公开发布，公开面即契约；新导出用 TSDoc `@public` / `@beta` / `@internal`。Host Adapter 契约变更走 contract-version review（`docs/host-adapter-contract.md`）。

## 从需求到交付

1. 定义用户结果、非目标、失败/取消/恢复状态，以及是否影响公开 API、权限或 host contract。
2. 用变更地图确认 owner；阅读相邻实现、测试和 active OpenSpec，不从文件名猜行为。
3. Bug/安全修复先建立修复前失败的回归或完整绕过负例；新功能先打通真实最小工作流。
4. 每个逻辑块先跑 focused filter；随后跑 `npm run check`，交付前从 clean checkout 跑 `npm run verify`。
5. 用户行为、公开 API、项目结构变化同步 README/API/EXTENDING/CHANGELOG；临时进度只进 spec/issue/PR。
6. 报告真实命令、结果、未运行项和残余风险；没有观察到 post-condition 就不报成功。

## 当前事实从哪里读

- 包、engine、scripts、exports：各级 `package.json` 与根 lockfile。
- 当前测试集合：`scripts/run-package-tests.mjs` 与实际命令输出，不在文档复制数量。
- API surface：`scripts/config/api-entrypoints.json` + API Extractor reports。
- 维护性阈值：`scripts/config/maintainability-baseline.json`。
- 当前迭代状态：active OpenSpec、issue、PR、CI；历史 design/notes 不承担 status 看板。

## 声称完成前

1. `npm run verify` 已跑过且绿。
2. 做过与改动性质匹配的真实运行验证。
3. 影响用户可见行为 / 公开 API / 项目结构的改动，已更新 `CHANGELOG.md`（顶部 `## [Unreleased]`，Added / Changed / Fixed / Removed / Internal 分类，用户视角书写）。

## 凭据纪律

凭据只从 `.env` 读（`.env` 不进 git），不硬编码进任何源文件、测试、注释、日志，不传给任何外部服务，不日志输出（`check:boundaries` 会扫描真实 key）。测试里需要 key 时用 `process.env.<KEY>`，无环境变量时 skip 而非 fail。
