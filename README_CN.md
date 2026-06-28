<div align="center">

# Moss 🌱

**一个开箱即用的机器人AI智能体 · 可嵌入的主机中立运行时**

由 [地瓜机器人 (D-Robotics)](https://developer.d-robotics.cc) 精心打造

[![npm](https://img.shields.io/npm/v/@rdk-moss/agent.svg?color=cb3837&label=%40rdk-moss%2Fagent)](https://www.npmjs.com/package/@rdk-moss/agent)
[![npm](https://img.shields.io/npm/v/@rdk-moss/core.svg?color=3178c6&label=%40rdk-moss%2Fcore)](https://www.npmjs.com/package/@rdk-moss/core)
[![license](https://img.shields.io/badge/license-MIT-blue.svg)](./LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D22.16-339933.svg)](https://nodejs.org)

<h3>🤖 机器人专属 · 💬 聊天即编程 · 🚀 毫秒级反应 · 🧠 越做越聪慧</h3>

[English](./README.md) | **简体中文**

</div>

---

启动 `moss`，提出问题，立刻开始工作。无需 API 密钥、无需登录——首次启动即可接入内置的地瓜智能网关。想要自己的模型、账单或私有端点？不改一行代码，只需指向任何 OpenAI 兼容或 Anthropic 服务商。`/connect` 连接一块 RDK 开发板，整个会话移至设备本地，ROS2 和诊断工具随之解锁。

<p align="center">
  <img src="packages/moss-agent/assets/moss-tui-demo.gif" alt="Moss 终端演示" width="720" />
</p>

## 🌟 核心特性

<table align="center">
  <tr>
    <th><div align="center"> 🤖 机器人原生 </div></th>
    <th><div align="center"> 💬 聊天编程 </div></th>
  </tr>
  <tr>
    <td align="center">
      <code>/connect</code> 一块 RDK 开发板<br/>
      会话即刻移至设备，SSH 隧道透传<br/>
      ROS2 + 诊断工具成为一等公民
    </td>
    <td align="center">
      自然语言定义任务流程<br/>
      支持多轮对话与交互<br/>
      自动学习与总结技能
    </td>
  </tr>

  <tr>
    <td colspan="2"><!-- 分隔行 --></td>
  </tr>

  <tr>
    <th><div align="center"> 🎯 目标驱动 </div></th>
    <th><div align="center"> 🧠 结构化记忆 </div></th>
  </tr>
  <tr>
    <td align="center">
      <code>/goal</code> 设定终点条件<br/>
      智能体自主规划多步骤任务<br/>
      中断可恢复，自动存档
    </td>
    <td align="center">
      对话与知识有条理地沉淀<br/>
      隐私优先，数据不上云<br/>
      可导出为技能库供复用
    </td>
  </tr>

  <tr>
    <td colspan="2"><!-- 分隔行 --></td>
  </tr>

  <tr>
    <th><div align="center"> 🔌 模型不锁定 </div></th>
    <th><div align="center"> 🛡️ 安全可信 </div></th>
  </tr>
  <tr>
    <td align="center">
      DeepSeek、Qwen、OpenAI、Anthropic<br/>
      任何 OpenAI 兼容网关<br/>
      动态切换，智能体逻辑零改动
    </td>
    <td align="center">
      分离已验证事实与推理结果<br/>
      诚实报告能力不足<br/>
      每一个结果都经过检查
    </td>
  </tr>
</table>

## 🚀 快速开始

**前置条件**：Node.js >= 22.16 和一个终端。（可选：一块 RDK 开发板）

```bash
# 全局安装
npm i -g @rdk-moss/agent@latest

# 启动交互式会话（无需任何配置）
moss

# 一行命令完成任务
moss "检查这个项目的磁盘使用情况"

# 管道输入也支持
echo "列出所有文件" | moss
```

在 TUI 中按 **Shift+Tab** 切换交互模式：`plan`（只读）→ `default`（逐步确认）→ `accept-edits`（自动执行）。按 `@` 快速附加文件，或输入 `/help` 查看完整命令。

### 连接 RDK 开发板

```bash
/connect root@192.168.1.10
```

Moss 验证 SSH 连通性后即进入**设备模式**：所有工具都在开发板上运行，ROS2 和诊断命令随之解锁。

```bash
/connect root@192.168.1.10 --password <密码>     # 密码认证
/connect root@192.168.1.10 --key ~/.ssh/id_rsa   # 密钥认证
/disconnect                                       # 断开连接，回到本地模式
```

### 内置技能库

Moss 预装 [**device-knowledge**](https://github.com/D-Robotics/device-knowledge) 开源知识库——20 个 `SKILL.md` 文件覆盖模型部署、TROS、GPIO/I2C/SPI 外设、板卡诊断等，自动加载无需配置。

在 `~/.claude/skills` 或 `~/.agents/skills` 中添加自己的 `SKILL.md`，Moss 即刻学到你的最佳实践。

### 切换模型与服务商

```bash
moss setup            # 交互式：选择服务商、粘贴 API Key
moss auth status      # 显示当前配置源与模型
```

支持的服务商：`deepseek`、`qwen`、`openai`、`anthropic`、`openai-compatible`

配置优先级：CLI 参数 > 项目 `.moss/config.json` > `moss setup` 保存配置 > 内置网关

### 长任务与恢复

Moss 自动存档每一个对话。中断的任务可以恢复——接着之前的地方继续：

```bash
moss resume --last        # 恢复最近一个会话
moss --continue           # 在原地继续
moss resume <会话id>      # 恢复指定会话
```

即使触发轮数上限，任务也只是暂停而非失败——智能体会提醒你继续。长期目标跨越重启而不丢失。

## 🎮 核心命令

| 命令 | 用途 |
| --- | --- |
| `moss` | 启动交互式会话 |
| `moss "任务描述"` | 一行任务：回答后直接退出 |
| `moss resume --last` | 恢复最近的对话 |
| `/connect <ip>` · `/disconnect` | 进入/离开设备模式 |
| `/status` · `/model` | 查看状态 · 切换模型 |
| `/goal <条件>` | 指定目标，自动运行到完成 |
| `/sessions` · `/resume` | 列出/切换已保存的对话 |
| `/diff` · `/review` | 查看改动 · 代码审查 |
| `/mcp` · `/doctor` | 检查 MCP 服务 · 健康诊断 |
| `/compact` · `/clear` | 压缩历史 · 开始新对话 |

## 🏗️ 架构

TypeScript、ESM、npm workspaces 单仓库（Node >= 22.16.0）。围绕一条清晰的**主机边界**设计：主机掌管模型密钥、UI、存储、遥测、设备访问；Moss 掌管智能体循环、工具框架、上下文/记忆/技能原语和主机中立安全。

| 包 | npm 名 | 角色 |
| --- | --- | --- |
| `packages/moss` | `@rdk-moss/core` | 核心契约：`KnowledgeModule`、`PlatformExtension`、`VendorPlugin`、主机适配器契约、`AsyncTask`、机器人与工程提示。零主机依赖，供应商中立。 |
| `packages/moss-agent` | `@rdk-moss/agent` | 独立智能体运行时 + `moss` CLI：智能体循环、工具框架、上下文管理、服务商、安全性。内部子系统（记忆、技能、教学、Mesh、MCP）通过子路径导出。 |
| `packages/create-moss-app` | `create-moss-app` | 最小项目脚手架（`minimal` / `openai` 模板）。 |

### 在你的产品中嵌入 Moss

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

一个主机注册其服务商/工具/存储/审批门，发布 `MossHostRuntimeManifest`，在 CI 中运行 `evaluateMossHostCompatibility()` 验证兼容性后再采用新版本。详见 [`docs/host-adapter-contract.md`](./docs/host-adapter-contract.md)。

## 📖 文档

- [`CONTRIBUTING.md`](./CONTRIBUTING.md) — 开发环境、常用命令、代码边界、PR 提交指南
- [`docs/host-adapter-contract.md`](./docs/host-adapter-contract.md) — 主机适配器契约与版本策略
- [`AGENTS.md`](./AGENTS.md) — 智能体工作规范、架构评审规范、Bug 修复清单

## 🛠️ 参与贡献

```bash
git clone https://github.com/D-Robotics/moss.git
cd moss && npm install
npm run verify   # 检查边界 + 卫生 + 编译 + 类型检查 + lint + 测试
```

Moss 的目标是打造**机器人级、主机中立的运行时**。在提议功能前，请阅读 [`AGENTS.md`](./AGENTS.md) 中的作用域规则——任何硬编码机器人品牌或厂商工作流的改动都应该属于主机适配器、知识模块或平台扩展，而非核心。

## 📄 许可证

[MIT © 地瓜机器人](./LICENSE)
