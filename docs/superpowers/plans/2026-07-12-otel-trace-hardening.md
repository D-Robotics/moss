# OTel 链路加固（第一轮）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让现有 trace 链路稳健、可操作、文档自洽，不改运行时行为——端口冲突二选一文档化、清理未使用的 `@opentelemetry/*` 依赖、新增 moss 侧启用文档。

**Architecture:** 纯文档 + 依赖清理 + 一处注释。不改任何运行时代码、不改端口、不动 receiver/Jaeger 配置。验证靠现有 `npm run verify` 全绿 + 可选手动冒烟。

**Tech Stack:** Node.js >=22.16.0、npm workspaces、TypeScript、Markdown。两个目录：`D:\moss-from-remote`（git 仓库，分支 `2026_07_08`）与 `D:\otel`（非 git，纯文件）。

**对应 spec:** `docs/superpowers/specs/2026-07-12-otel-trace-hardening-design.md`

## Global Constraints

- **不改运行时行为**：不改动 `otel-receiver.mjs`、`docker-compose.yml`、任何端口、任何 span 创建逻辑。
- **跨两个目录**：`D:\moss-from-remote`（git 仓库）改动需提交；`D:\otel`（非 git）只改 README，不提交。
- **依赖清理兜底**：删依赖后若 `npm install`/构建报缺失模块，停下来与用户确认，不擅自把依赖加回别处。
- **提交规范**：每个任务结束提交；提交信息末尾加 `Co-Authored-By: Claude <noreply@anthropic.com>`。
- **中文**：文档与注释用中文；代码标识符保持英文。

---

## File Structure

| 文件 | 动作 | 责任 |
|------|------|------|
| `D:\otel\README.md` | 改写 | 双后端"二选一"结构：receiver 与 Jaeger 互斥（都监听 4318），各自端口/启动/查看/占用检查 |
| `D:\moss-from-remote\package.json` | 修改 | 删除 4 个未使用的 `@opentelemetry/*` devDependency |
| `D:\moss-from-remote\package-lock.json` | 同步 | `npm install` 自动更新 |
| `D:\moss-from-remote\packages\moss-agent\src\observability\otel-bridge.ts` | 修改 | 顶部注释补"故意不依赖 SDK"说明 |
| `D:\moss-from-remote\docs\observability.md` | 新增 | moss 侧启用监控入口文档 |

任务顺序：先做依赖清理（Task 1，因为 `npm run verify` 是后续验证基准）→ 注释（Task 2，与依赖清理同主题，一起提交更清晰）→ moss 侧启用文档（Task 3）→ otel README（Task 4）→ 全量验证（Task 5）。

---

### Task 1: 删除未使用的 @opentelemetry/* 依赖

**Files:**
- Modify: `D:\moss-from-remote\package.json`（`devDependencies` 块，约 30-33 行）
- Modify: `D:\moss-from-remote\package-lock.json`（由 `npm install` 自动更新）

**Interfaces:**
- Consumes: 无
- Produces: 一个不含 `@opentelemetry/*` 的 `package.json`，供 Task 5 的 `npm run verify` 验证无隐藏引用。

- [ ] **Step 1: 确认当前依赖块内容**

读 `D:\moss-from-remote\package.json`，确认 `devDependencies` 含这 4 项：
```
"@opentelemetry/exporter-trace-otlp-http": "^0.220.0",
"@opentelemetry/resources": "^2.9.0",
"@opentelemetry/sdk-trace-node": "^2.9.0",
"@opentelemetry/semantic-conventions": "^1.43.0",
```
若行号或版本号与上面不符，以实际文件为准，只删这 4 个 key。

- [ ] **Step 2: 再次确认全仓库无 import**

Run（在 `D:\moss-from-remote` 下）:
```bash
grep -rn "from ['\"]@opentelemetry/" packages/ || echo "NO_MATCHES"
```
Expected: `NO_MATCHES`（确认删除安全）。若有匹配，**停下来与用户确认**，不继续删除。

- [ ] **Step 3: 删除 4 个依赖**

编辑 `D:\moss-from-remote\package.json`，从 `devDependencies` 删除这 4 行（连同逗号）。删除后该块开头应类似：
```json
  "devDependencies": {
    "@types/node": "^22.10.2",
    "@typescript-eslint/eslint-plugin": "^7.0.0",
```

- [ ] **Step 4: 同步 lockfile**

Run（在 `D:\moss-from-remote` 下）:
```bash
npm install
```
Expected: 安装完成，无报错；`package-lock.json` 被更新（不再含这 4 个包的条目）。若报缺失模块错误，**停下来与用户确认**。

- [ ] **Step 5: 快速验证构建未破**

Run（在 `D:\moss-from-remote` 下）:
```bash
npm run build
```
Expected: 构建成功，无 "Cannot find module '@opentelemetry/...'" 类错误。若失败，**停下来与用户确认**。

- [ ] **Step 6: 提交**

```bash
cd /d/moss-from-remote
git add package.json package-lock.json
git commit -m "$(cat <<'EOF'
chore: 删除未使用的 @opentelemetry/* 依赖

otel-bridge 是纯 fetch + 手写 OTLP JSON 实现，不依赖官方 SDK。
这 4 个 devDependency 全仓库零 import，移除以减小体积、避免误导。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```
Expected: 提交成功，仅 `package.json` 与 `package-lock.json` 入库。

---

### Task 2: otel-bridge.ts 补"故意不依赖 SDK"注释

**Files:**
- Modify: `D:\moss-from-remote\packages\moss-agent\src\observability\otel-bridge.ts:1-10`（顶部注释块）

**Interfaces:**
- Consumes: 无
- Produces: 无（纯注释，不改任何导出）

- [ ] **Step 1: 确认当前注释块**

读 `D:\moss-from-remote\packages\moss-agent\src\observability\otel-bridge.ts` 前 10 行，确认现有注释块为：
```ts
/**
 * OpenTelemetry bridge for Moss tracing.
 *
 * Sends Moss spans directly to an OTLP-compatible backend (Jaeger, Grafana)
 * via HTTP. No OTel SDK dependency — just standard fetch + JSON.
 *
 * Usage:
 *   import { enableOtelTracing } from '@rdk-moss/agent/observability';
 *   enableOtelTracing({ serviceName: 'moss' });
 */
```

- [ ] **Step 2: 在 "No OTel SDK dependency" 那行后补一句说明**

把第 5 行：
```ts
 * via HTTP. No OTel SDK dependency — just standard fetch + JSON.
```
替换为：
```ts
 * via HTTP. No OTel SDK dependency — just standard fetch + JSON.
 *
 * 这是刻意为之：bridge 用 fetch 直接发 OTLP/JSON，避免引入 @opentelemetry/* SDK 包。
 * 未经具体需求（如 metrics、跨进程 context propagation）不要在此引入 SDK 依赖，
 * 详见 docs/superpowers/specs/ 下的可观测性加固 spec。
```

- [ ] **Step 3: 验证 typecheck/lint 未破**

Run（在 `D:\moss-from-remote` 下）:
```bash
npm run typecheck && npm run lint
```
Expected: 通过（注释改动不影响类型/lint）。若 lint 报注释格式问题，按提示修正。

- [ ] **Step 4: 提交**

```bash
cd /d/moss-from-remote
git add packages/moss-agent/src/observability/otel-bridge.ts
git commit -m "$(cat <<'EOF'
docs(observability): 注明 otel-bridge 刻意不依赖 OTel SDK

避免后人误以为该接官方 SDK 而引入 @opentelemetry/* 依赖；
明确仅在 metrics / context propagation 等具体需求出现时才考虑。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```
Expected: 提交成功。

---

### Task 3: 新增 moss 侧启用监控文档

**Files:**
- Create: `D:\moss-from-remote\docs\observability.md`

**Interfaces:**
- Consumes: `cli-main.ts:614`（`MOSS_OTEL_URL`/`MOSS_OTEL_ENABLED` 判定）、`otel-bridge.ts:124`（默认 url）、`tracing.ts:193`（`enableLocalTracing`）。
- Produces: moss 侧启用入口文档，与 Task 4 的 otel README 互为呼应。

- [ ] **Step 1: 写入文档**

创建 `D:\moss-from-remote\docs\observability.md`，内容：

````markdown
# Moss 可观测性：启用监控链路

Moss 通过自写 OTLP 桥把 span 发到任意 OTLP/HTTP 后端，链路为：

```
session → agent.llm_turn → tool.execute
```

## 启用方式

设以下任一环境变量即开启（对应 `packages/moss-agent/src/cli-main.ts`）：

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
````

- [ ] **Step 2: 检查文档内引用的代码位置是否准确**

Run（在 `D:\moss-from-remote` 下）:
```bash
grep -n "MOSS_OTEL_URL || process.env.MOSS_OTEL_ENABLED" packages/moss-agent/src/cli-main.ts
grep -n "options.url ?? 'http://localhost:4318/v1/traces'" packages/moss-agent/src/observability/otel-bridge.ts
grep -n "export function enableLocalTracing" packages/moss-agent/src/observability/tracing.ts
```
Expected: 三条都有匹配（确认文档引用的判定逻辑、默认 url、函数名都真实存在）。若某条无匹配，修正文档里的引用。

- [ ] **Step 3: 提交**

```bash
cd /d/moss-from-remote
git add docs/observability.md
git commit -m "$(cat <<'EOF'
docs(observability): 新增 moss 侧监控启用文档

覆盖启用环境变量、两个后端二选一、本地文件导出、排查提示、
链路层级与代码位置引用。与 D:\otel\README.md 互为呼应。

Co-Authored-By: Claude <noreply@anthropic.com>
EOF
)"
```
Expected: 提交成功。

---

### Task 4: 改写 otel README 为"二选一"结构

**Files:**
- Modify: `D:\otel\README.md`（整体改写；非 git 目录，不提交）

**Interfaces:**
- Consumes: Task 3 的文档作为对端呼应（端口/路径需一致）。
- Produces: 与 moss 侧文档端口一致的后端操作文档。

- [ ] **Step 1: 确认当前 README 内容**

读 `D:\otel\README.md`，确认现有结构（标题"Jaeger 监控环境"、方案 A Docker、方案 B 二进制、使用、查看）。

- [ ] **Step 2: 整体改写为双后端二选一结构**

把 `D:\otel\README.md` 全文替换为：

````markdown
# Moss OTLP 后端（二选一）

Moss 的 trace 通过 OTLP/HTTP 发到 `http://localhost:4318/v1/traces`。本目录提供**两个互斥后端**——同一时刻只能起一个，因为它们都监听 `4318`。

| 后端 | 启动 | 查看 | 适用 |
|------|------|------|------|
| A. 自写 OTLP 收器 + 面板 | `node otel-receiver.mjs` | `http://localhost:3000` | 零依赖、自带中文面板与会话摘要，本地调试首选 |
| B. Jaeger all-in-one | `docker compose up -d` | `http://localhost:16686` | 成熟 UI 或对接既有 Jaeger 体系 |

> **关键：起任一后端前，先确认 4318 没被另一个占用。** 检查：`netstat -ano | findstr 4318`（Windows）或 `docker ps`（看是否已有 jaeger 容器）。两者同时起会端口冲突。

---

## 后端 A：自写 OTLP 收器 + 面板

```bash
cd D:\otel
node otel-receiver.mjs
```

- OTLP 接收：`http://localhost:4318/v1/traces`
- 查看面板：`http://localhost:3000`（2 秒自动刷新，按 trace 分组的树形链路 + 会话摘要）

零依赖，仅需 Node.js。内存存储，最多保留 1000 条 span / 200 条会话摘要，重启即清。

---

## 后端 B：Jaeger all-in-one

### 方案 B1: Docker（推荐）

```bash
cd D:\otel
docker compose up -d
```

### 方案 B2: 直接下载 Jaeger 二进制

```powershell
# 1. 下载
Invoke-WebRequest -Uri "https://github.com/jaegertracing/jaeger/releases/download/v1.62.0/jaeger-1.62.0-windows-amd64.zip" -OutFile "D:\otel\jaeger.zip"

# 2. 解压
Expand-Archive "D:\otel\jaeger.zip" -DestinationPath "D:\otel\jaeger"

# 3. 启动
D:\otel\jaeger\jaeger-all-in-one.exe --collector.otlp.enabled
```

- OTLP 接收：`http://localhost:4318`
- 查看 UI：`http://localhost:16686`（Service 选 "moss" → Find Traces）

---

## Moss 侧启用

Moss 端设环境变量把 span 发到上述后端：

```bash
# Linux / Git Bash
export MOSS_OTEL_URL=http://localhost:4318/v1/traces
export MOSS_OTEL_SERVICE_NAME=moss

# Windows PowerShell
$env:MOSS_OTEL_URL = "http://localhost:4318/v1/traces"
```

详见 `D:\moss-from-remote\docs\observability.md`。

## 查看

浏览器打开对应后端的查看地址，应能看到完整调用链：

```
session → agent.llm_turn → tool.execute
```
````

- [ ] **Step 3: 检查端口/路径与 moss 侧文档一致**

对照 Task 3 的 `docs/observability.md`，确认两份文档里的端口（`4318`、`3000`、`16686`）、路径（`/v1/traces`）、环境变量名（`MOSS_OTEL_URL`、`MOSS_OTEL_SERVICE_NAME`）完全一致。若不一致，修正。

- [ ] **Step 4: 不提交（D:\otel 非 git 目录）**

确认 `D:\otel` 不是 git 仓库：
```bash
cd /d/otel && git rev-parse --is-inside-work-tree 2>&1
```
Expected: 输出 `fatal: not a git repository`（或类似），说明无需也无法提交。文件已直接落盘。

---

### Task 5: 全量验证

**Files:**
- 无文件改动，仅运行验证命令。

**Interfaces:**
- Consumes: Task 1-4 的全部改动。
- Produces: 验收清单全部打勾，确认本轮加固完成且未破坏构建。

- [ ] **Step 1: 跑完整 verify**

Run（在 `D:\moss-from-remote` 下）:
```bash
npm run verify
```
Expected: `check:boundaries && check:hygiene && build && typecheck && lint && test` 全部通过，无 `Cannot find module '@opentelemetry/...'` 类错误。这是删依赖后最关键的一道闸。

- [ ] **Step 2: 确认验收清单**

逐项核对：
- [ ] `package.json` 不再含 4 个 `@opentelemetry/*` 包，`package-lock.json` 已同步
- [ ] `otel-bridge.ts` 顶部注释说明"故意不依赖 SDK"
- [ ] `D:\otel\README.md` 改成"二选一"结构，两个后端端口/启动/查看方式写清
- [ ] `docs/observability.md` 新增，覆盖启用方式、后端选择、本地导出、排查
- [ ] `npm run verify` 全绿

Run（在 `D:\moss-from-remote` 下）确认依赖已删：
```bash
grep -c "@opentelemetry/" package.json
```
Expected: `0`。

- [ ] **Step 3: （可选）手动冒烟链路**

若条件允许：
1. 起一个后端（`node D:\otel\otel-receiver.mjs` 或 `cd D:\otel && docker compose up -d`）。
2. 设 `MOSS_OTEL_URL=http://localhost:4318/v1/traces`，跑一次 `moss` 对话。
3. 打开 `http://localhost:3000`（receiver）或 `http://localhost:16686`（Jaeger，Service 选 moss）。
4. 确认能看到 `session → agent.llm_turn → tool.execute` 三级 span。

若无法手动冒烟，跳过此步并在交付说明里注明"未做手动冒烟"。

- [ ] **Step 4: 汇总交付**

向用户报告：
- 5 个任务完成情况
- 验收清单打勾状态
- `npm run verify` 结果
- 是否做了手动冒烟
- git 提交记录（`git log --oneline -4` 在 `D:\moss-from-remote` 下查看）

无需额外提交（验证任务无文件改动）。

---

## Self-Review 已完成

对照 spec 逐条核对：
- **4.1 otel README 二选一** → Task 4 ✅
- **4.2 删 4 个依赖** → Task 1 ✅
- **4.3 otel-bridge 注释** → Task 2 ✅
- **4.4 docs/observability.md** → Task 3 ✅
- **七、测试与验证（npm run verify + 冒烟）** → Task 5 ✅
- **错误处理（fire-and-forget 提醒、删依赖兜底）** → Task 1 Step 2/4、Task 3 排查节、Task 5 ✅

无占位符；类型/命名一致（环境变量名、端口、路径全文统一）；scope 聚焦单一目标。
