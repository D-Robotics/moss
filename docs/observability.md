# Moss 可观测性：启用监控链路

Moss 通过自写 OTLP 桥把 span 发到任意 OTLP/HTTP 后端，链路为：

```
session → agent.llm_turn → tool.execute
```

## 启用方式

设以下任一环境变量即开启（判定逻辑在 `packages/moss-agent/src/cli-main.ts`）：

| 环境变量 | 必填 | 默认 | 说明 |
|----------|------|------|------|
| `MOSS_OTEL_URL` | 二选一 | `http://localhost:4318/v1/traces` | OTLP/HTTP 接收端点（含 `/v1/traces` 路径） |
| `MOSS_OTEL_ENABLED` | 二选一 | — | 设为任意非空值即开启，用默认 url |
| `MOSS_OTEL_SERVICE_NAME` | 否 | `moss` | 在 Jaeger/面板里显示的 service.name |

示例：

```bash
# Linux / Git Bash
export MOSS_OTEL_URL=http://localhost:4318/v1/traces
export MOSS_OTEL_SERVICE_NAME=moss

# Windows PowerShell
$env:MOSS_OTEL_URL = "http://localhost:4318/v1/traces"
```

## 指向哪个后端（二选一）

Moss 支持两个 OTLP 后端，**同一时刻只能起一个**（都监听 `4318`）。两个后端的 `MOSS_OTEL_URL` 其实相同，因为都遵循 OTLP/HTTP 标准路径；差异在你起了哪个后端进程本身——这正是"二选一"的体现。

| 后端 | 启动 | 查看 | 适用 |
|------|------|------|------|
| 自写 OTLP 收器 + 面板 | `node D:\otel\otel-receiver.mjs` | `http://localhost:3000` | 零依赖、自带中文面板与会话摘要，本地调试首选 |
| Jaeger all-in-one | 在 `D:\otel` 下 `docker compose up -d` | `http://localhost:16686` | 成熟 UI 或对接既有 Jaeger 体系 |

两种情况下 `MOSS_OTEL_URL` 都设为 `http://localhost:4318/v1/traces`。

后端的详细启动与端口占用检查见 `D:\otel\README.md`。

## 本地文件导出（可选）

除 OTLP 外，可启用本地兜底——span 写入 `.moss/analytics/traces.jsonl`：

```ts
import { enableLocalTracing } from '@rdk-moss/agent/observability';
enableLocalTracing(workspaceDir);
```

对应 `packages/moss-agent/src/observability/tracing.ts` 的 `enableLocalTracing()`。

## 排查

**面板/Jaeger 看不到数据时，先查后端，再查 Moss。**

1. 确认 4318 没被另一个后端占用（`netstat -ano | findstr 4318`，或 `docker ps` 看是否已有 jaeger 容器）。两个后端互斥，同时起会端口冲突。
2. 确认 Moss 侧设了 `MOSS_OTEL_URL` 或 `MOSS_OTEL_ENABLED`。
3. 注意：otel-bridge 是 fire-and-forget，**后端没起时 Moss 不会报错**，只是 span 发出去没人收。所以"看不到数据"的第一步是查后端进程，而非查 Moss 日志。

## 链路层级

- `session`（根 span）—— `packages/moss-agent/src/core/agent/moss-agent.ts`
- `agent.llm_turn`（子）—— `packages/moss-agent/src/core/loop/agent-loop-llm-call.ts`
- `tool.execute`（孙）—— `packages/moss-agent/src/core/tools/execute-tool-call.ts`

桥实现：`packages/moss-agent/src/observability/otel-bridge.ts`（纯 fetch + 手写 OTLP JSON，不依赖官方 SDK）。
