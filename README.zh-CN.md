<div align="center">

# Moss

**一个面向机器人的终端 Agent，开箱即用 —— 同时也是可嵌入、宿主中立的 Agent 运行时。**

由 [地瓜机器人 (D-Robotics)](https://developer.d-robotics.cc) 打造

[![npm](https://img.shields.io/npm/v/@rdk-moss/agent.svg?color=cb3837&label=%40rdk-moss%2Fagent)](https://www.npmjs.com/package/@rdk-moss/agent)
[![npm](https://img.shields.io/npm/v/@rdk-moss/core.svg?color=3178c6&label=%40rdk-moss%2Fcore)](https://www.npmjs.com/package/@rdk-moss/core)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22.16-339933.svg)](https://nodejs.org)

[English](./README.md) · **简体中文**

</div>

---

运行 `moss`，提问，开干。无需 API Key、无需登录——首次启动就已接入内置的 D-Robotics 网关。想用自己的模型、计费或私有端点时，指向任意 OpenAI 兼容或 Anthropic 服务即可，Agent 本身不变。`/connect` 一块 RDK 开发板，整个会话通过 SSH 搬到板子上运行，并解锁 ROS2 与诊断工具。

<p align="center">
  <img src="packages/moss-agent/assets/moss-tui-demo.gif" alt="Moss 终端演示" width="720" />
</p>

## 特性亮点

- 🤖 **原生面向机器人** —— `/connect <ip>` 让会话通过 SSH 跑在 RDK 板上；`device_*` 诊断工具与一整套 `ros2_*` 工具成为一等公民。
- 🚀 **零配置** —— 内置网关，无需 API Key，无需登录。`npm i -g @rdk-moss/agent && moss` 就能对话。
- 🔌 **自带模型** —— DeepSeek、Qwen、OpenAI、Anthropic、任意 OpenAI 兼容网关或自托管模型。切换服务商从不改变 Agent。
- 🧠 **扛得住长程任务** —— 会话自动保存，工作上下文检查点记录当前任务，`moss resume` 接着干。goal runner 驱动多步任务直至完成。
- 🎓 **边干边学** —— teach-while-solve 层实时解说设备操作；技能管线把优质运行蒸馏成可审阅的 `SKILL.md` 候选。
- 🕸️ **多 Agent 协作** —— 内置 AgentMesh 让同局域网的 Agent 共享知识与解答。
- 🛡️ **诚实可信** —— 区分已验证事实与推断，能力不可用时如实上报，从不声称未经检查的结果。
- 🧩 **可嵌入** —— 带公开契约和 npm 包，而不仅是独立 App。用 `npx create-moss-app` 脚手架生成宿主。
- 👁️ **视觉与浏览器** —— 用 `vision_analyze` 分析截图，用 `web_browser` 自动化 Web 任务，适用于任何支持视觉或浏览器的模型。
- 📐 **结构化输出与评测** —— `generate_structured` 强制 JSON Schema 输出；`eval` 运行测试套件，支持多种指标与加权评分。

## 快速开始

**开始前：** 需要 Node.js >= 22.16 和一个终端。（可选：一块用于板端模式的 RDK 开发板。）

```bash
npm i -g @rdk-moss/agent@latest   # 需要 Node 22.16+
moss                               # 首次启动即工作 —— 无需 Key、无需登录

moss "看看这个项目的磁盘占用"          # 一次性：回答后退出
echo "列出文件" | moss                 # 也支持管道 stdin
```

在 TUI 内，按 **Shift+Tab** 切换交互模式：`plan`（只读）→ `default`（逐次审批）→ `accept-edits`（自动批准写入）。输入 `@` 可内联附加文件，输入 `/help` 查看完整命令参考。

### 连接 RDK 开发板

```text
/connect 192.168.1.10 --user root
通过 SSH 检查摄像头、ROS2 节点、磁盘空间和设备健康状况。
```

`/connect` 会先验证 SSH 可达性与凭据，再启用设备工具。连接后，默认工具（`exec`、`read_file`、`write_file` 等）通过 SSH 在板上执行，ROS2（`ros2_topic_list`、`ros2_node_list`、`ros2_launch` 等）与 `device_*` 诊断工具同时可用。`/disconnect` 恢复本地工具；`--hybrid` 保留本地工具、只追加设备工具。

### 给 Moss 装上 RDK 板端 Skill

用开源的 [**device-knowledge**](https://github.com/D-Robotics/device-knowledge) 知识包给 Moss 装上 RDK 板端知识——一组 `SKILL.md`，涵盖模型部署、TROS/ROS2、GPIO/I2C/SPI 外设、板级诊断等。

### 使用你自己的模型

```bash
moss setup            # 交互式：选服务商 + 模型，粘贴 Key
moss auth status      # 显示解析出的服务商/模型/Key 来源
```

支持的服务商：`deepseek`、`qwen`、`openai`、`anthropic`、`openai-compatible`。模型设置只存在 moss 配置里——`OPENAI_API_KEY` 等环境变量被刻意忽略，这样为别的工具导出的 Key 不会悄悄改变你的服务商。优先级：CLI 参数 / `-c key=value` > 项目 `.moss/config.json` > `moss setup` > 内置网关。

### 关键命令

| 命令 | 作用 |
| --- | --- |
| `moss` | 启动交互式会话 |
| `moss "一个任务"` | 一次性：回答后退出 |
| `moss resume --last` | 继续最近一次会话 |
| `/connect <ip>` · `/disconnect` | 进入 / 离开板端模式 |
| `/status` · `/model` | 显示状态 · 切换模型 |
| `/goal <条件>` | 持续运行直到达成目标 |
| `/sessions` · `/resume` | 列出 · 切换已保存会话 |
| `/diff` · `/review` | 查看改动 · 审查找 bug |
| `/mcp` · `/doctor` | 查看 MCP 服务 · 体检 |
| `/compact` · `/clear` | 压缩历史 · 新会话 |

## 架构概览

TypeScript、ESM、npm-workspaces 的 monorepo（Node >= 22.16.0），围绕一条狭窄的**宿主边界**拆分：宿主拥有模型 Key、UI、存储、遥测、设备访问；Moss 拥有 Agent 循环、工具流水线、上下文/记忆/技能原语，以及宿主中立的安全机制。

| 目录 | npm 包名 | 职责 |
| --- | --- | --- |
| `packages/moss` | `@rdk-moss/core` | 核心契约：`KnowledgeModule`、`PlatformExtension`、`VendorPlugin`、版本化的 **Host Adapter** 契约、`AsyncTask`，以及机器人/软件工程提示词。零宿主依赖、厂商中立。 |
| `packages/moss-agent` | `@rdk-moss/agent` | 独立 Agent 运行时 + `moss` CLI：Agent 循环、工具框架、上下文管理、服务商适配、安全机制。包内子系统（memory、skills、skill-learning、teaching、mesh、mcp、observability）经子路径导出。 |
| `packages/create-moss-app` | `create-moss-app` | 最小项目脚手架（`minimal` / `openai` 模板）。 |

### 把 Moss 嵌入你的产品

```bash
npx create-moss-app my-host
```

```ts
import {
  MOSS_HOST_ADAPTER_CONTRACT_VERSION,
  evaluateMossHostCompatibility,
  type MossHostRuntimeManifest,
} from '@rdk-moss/core/contracts/host-adapter';
```

宿主注册自己的服务商/工具/存储/审批闸门，发布 `MossHostRuntimeManifest`，并在采用新版本前于 CI 跑 `evaluateMossHostCompatibility()`。完整接口面与版本策略见 [`docs/host-adapter-contract.md`](./docs/host-adapter-contract.md)。

## 文档

- [`CONTRIBUTING.md`](./CONTRIBUTING.md) —— 开发环境、命令、边界与如何提 PR。
- [`docs/host-adapter-contract.md`](./docs/host-adapter-contract.md) —— Host Adapter 契约指南与版本策略。
- [`AGENTS.md`](./AGENTS.md) —— Agent 工作规则、架构评审纪律、缺陷修复清单。

## 贡献

```bash
git clone https://github.com/D-Robotics/moss.git
cd moss && npm install
npm run verify   # 边界 + 卫生检查 + 构建 + 类型检查 + lint + 测试
```

Moss 的北极星是一个**机器人级、宿主中立的运行时**。提议新功能前，请对照 [`AGENTS.md`](./AGENTS.md) 的 scope 规则自检——任何把机器人族或厂商工作流硬编码进核心的东西，都应放在宿主适配器、知识模块或平台扩展里。

## 许可证

[MIT © D-Robotics](./LICENSE)
