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

子系统不是独立包，住在 `packages/moss-agent` 内，通过其 `package.json` subpath exports 对外暴露。包级细节见 [`packages/moss-agent/AGENTS.md`](packages/moss-agent/AGENTS.md)，扩展面见 [`packages/moss-agent/EXTENDING.md`](packages/moss-agent/EXTENDING.md)。

## 环境准备与命令面（根 manifest）

| 命令                        | 前置条件 / 输入范围                                                                  | 成功契约                                                         | 产物 / 副作用                                        | 失败恢复                                                  |
| --------------------------- | ------------------------------------------------------------------------------------ | ---------------------------------------------------------------- | ---------------------------------------------------- | --------------------------------------------------------- |
| `npm ci`                    | Node ≥ 22.16.0；输入为根 `package-lock.json`                                         | exit code 0；锁文件不发生意外变更                                | 重建 `node_modules/`、安装本地 hook；不改源码        | 修复 Node/网络后重跑；不得改锁文件绕过安装失败            |
| `npm run build`             | 已安装依赖；输入为三个 workspace 源码                                                | exit code 0；三个 workspace 应构建项完成                         | clean 后重建各包 `dist/`                             | 从首个 workspace 编译错误修复；不要提交 `dist/`           |
| `npm run typecheck`         | 已安装依赖；全工作区 TypeScript                                                      | exit code 0；无 TypeScript 错误                                  | 只读检查，无持久报告                                 | 在所属 package 跑最窄 typecheck，修复后回到全仓           |
| `npm run test`              | 已 build 或由包脚本 build-first；core → agent → create-app                           | exit code 0；每包至少发现一个 spec 且全部通过                    | stdout 为证据，可能重建 `dist/`；硬件项只显式 opt-in | 用 `test:filter` 复现首个失败；0 tests/无匹配不能作为成功 |
| `npm run lint` / `lint:fix` | 已安装依赖；tracked TS/MJS/测试/配置                                                 | `lint` exit code 0；0 warning                                    | `lint` 只读；`lint:fix` 会修改源码                   | 先用 `lint` 定位；只在准备审阅修改时运行 `lint:fix`       |
| `npm run check`             | 已安装依赖；format、lint、typecheck、boundaries、hygiene、maintainability、standards | exit code 0；所有子检查真实执行，任一失败非零                    | 只读快速门禁，可能生成工具缓存                       | 单跑失败子检查；不得降低 baseline 或删除负例换绿          |
| `npm run api:check`         | 已安装依赖；公开 exports 与 API reports                                              | exit code 0；公开 API 无未审批漂移                               | 构建声明并比较 reports                               | 有意 API 变更走 review 后运行 `api:update`，否则修复漂移  |
| `npm run docs`              | 已安装依赖；当前公开源码                                                             | exit code 0；TypeDoc 可从源码生成                                | 生成 `docs-api/`，不改源契约                         | 先修 TSDoc/公开类型；生成物不替代 `api:check`             |
| `npm run smoke:moss-cli`    | 已安装依赖并可打包 CLI                                                               | exit code 0；打包后 CLI 与 PTY 入口可启动                        | 创建临时包/进程并自动清理                            | 检查打包清单与入口；不可用固定输出冒充启动成功            |
| `npm run verify`            | clean checkout + `npm ci`；输入为全仓 tracked 内容                                   | exit code 0；required 检查全部通过；opt-in 硬件不可用时显式 SKIP | 完整构建、API reports、测试与缓存；不改 tracked 源码 | 从失败的 focused gate 修复；required 层不得 skip          |

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
- 子进程只能走 `utils/run-process.ts`（spawn + AbortSignal + timeout + maxBuffer），工具执行路径禁用 `execFileSync`/`execSync`。
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

## 声称完成前

1. `npm run verify` 已跑过且绿。
2. 做过与改动性质匹配的真实运行验证。
3. 影响用户可见行为 / 公开 API / 项目结构的改动，已更新 `CHANGELOG.md`（顶部 `## [Unreleased]`，Added / Changed / Fixed / Removed / Internal 分类，用户视角书写）。

## 凭据纪律

凭据只从 `.env` 读（`.env` 不进 git），不硬编码进任何源文件、测试、注释、日志，不传给任何外部服务，不日志输出（`check:boundaries` 会扫描真实 key）。测试里需要 key 时用 `process.env.<KEY>`，无环境变量时 skip 而非 fail。
