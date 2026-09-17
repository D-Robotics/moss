# Moss

Moss 是一个精简的跨平台 coding agent harness，只做一件事并做好：提供一个 `moss` CLI，
运行 agent loop——与 LLM 对话、调用工具、管理上下文、保存会话——支持可插拔的模型
provider，并内置终端 UI。

## 快速开始

环境要求：Node.js ≥ 22.16.0（Linux / macOS / Windows）。

```bash
git clone <本仓库> moss
cd moss
npm install
npm run build
node dist/cli.js            # 交互式 TUI
node dist/cli.js "你的提示"  # 单次执行
```

可选：全局链接 `moss` 命令：

```bash
npm link        # 或: npm install -g .
moss
```

## 配置模型

首次运行会引导完成配置：

```bash
moss setup
```

或手动配置（Anthropic 或任意 OpenAI 兼容端点）：

```bash
moss config set provider anthropic
moss config set api_key $ANTHROPIC_API_KEY
moss config set model claude-sonnet-4-20250514

# 任意 OpenAI 兼容网关
moss config set provider openai-compatible
moss config set base_url https://api.deepseek.com/v1
moss config set api_key $DEEPSEEK_API_KEY
moss config set model deepseek-chat
```

配置保存在 `~/.config/moss/config.json`（可用 `MOSS_CONFIG_DIR` 覆盖）。API key 也可以
通过常规环境变量提供（`ANTHROPIC_API_KEY`、`OPENAI_API_KEY`、`DEEPSEEK_API_KEY` 等）。

## 包含什么

- **Agent loop** —— 工具调用、运行中转向（steering）、重试与上下文溢出恢复、轮次上限。
- **工具** —— 文件读/写/编辑、补丁、搜索（文件/代码）、shell `exec`（含后台执行）、
  网页抓取/搜索、todo、运行测试辅助、向用户提问、子代理（`create_subagent` /
  `fan_out_subagents`）。
- **上下文管理** —— token 统计、裁剪、压缩（compaction/microcompaction）、上下文窗口守卫。
- **会话** —— JSONL 会话存储、恢复、回退、事件日志。
- **安全** —— 密钥脱敏、危险命令拦截、工具审批钩子、受保护路径。
- **CLI** —— 交互式 TUI（ink）、`--print` 无头单次模式、REPL 兜底。

作为库嵌入使用：

```ts
import { MossAgent, InMemorySessionStore, AnthropicLLMProvider } from 'moss';

const agent = new MossAgent({
  llmProvider: new AnthropicLLMProvider({ apiKey: process.env.ANTHROPIC_API_KEY! }),
  sessionStore: new InMemorySessionStore(),
});
const result = await agent.chat('main', '解释一下这个仓库。');
```

## 开发

```bash
npm run check   # 格式 + lint + 类型检查
npm run test    # 构建 + 运行测试（test/*.spec.mjs）
npm run verify  # check + test + CLI 冒烟
```

聚焦测试：`npm run test:filter -- --filter <spec名>`。

## 许可

MIT —— 见 [LICENSE](LICENSE)。
