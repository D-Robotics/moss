# Moss v0.25 规划：fleet MVP + TUI 自有文案双语

> 决策日期：2026-10-02。基于 v0.24 实际代码取证，不把 fleet、TUI 全量中文化和动态输出翻译混成不可验收的大专项。

## 问题本质

v0.24 已让四个子命令族在 zh/en 下可用，但交互 TUI 仍有大量 Moss 自有英文 chrome；设备注册表虽支持多条设备记录，工具和 Task Runtime 仍把默认设备作为隐式单路由。v0.25 需要把用户能直接观察和控制的边界补齐：显式设备集合、可追踪的只读 fan-out、明确的部分失败语义，以及 TUI 自有固定文案的 locale 一致性。

## Done 定义

### A. Fleet MVP

- 新增显式设备选择能力：从 workspace registry 按 `deviceId` 解析一组已配置设备；未指定选择器时继续保持现有单设备默认行为。
- 新增一个只读 fleet 执行边界，至少支持现有设备观察类工具（`device_info`、`device_processes`、`device_resources`、`device_temperature`、`device_robotics_status`、`device_network`、`device_cameras`、`device_file_read`、`device_file_list`）按设备执行。
- 每个设备结果必须带 `deviceId`、endpoint、status 和 error/result；整体结果必须可区分 `all-pass`、`partial`、`all-fail`。
- 复用现有 `getDeviceConnection`、连接复用、退避和 SSH channel semaphore；不得重写 SSH transport。
- 设备执行遵守 `AbortSignal`；一个设备失败不得抹掉其他设备结果。
- 写操作（`device_exec`、`device_file_write`、`device_deploy`）本版本不做隐式 fan-out；仍走既有单设备审批和单设备路径。
- 旧 `targetDeviceId`、旧 task/deployment JSONL 能继续读取；不要求为历史数据伪造 fleet assignment。

### B. TUI 自有 chrome zh/en

- `cli-main` 显式把 locale 传入 TUI；TUI 不在组件内部重复读取环境变量作为唯一来源。
- zh locale 下翻译 Moss 自有固定文案：帮助、快捷键说明、resume picker、question/approval footer、启动状态、task outcome 提示、composer/paste/model picker、固定 transcript 状态词和底部 hint/status chrome。
- en locale 保持当前英文文案。
- 命令名、快捷键、路径、模型名、skill/MCP 名称、工具名、用户输入、模型输出、shell/git/MCP 原始输出不翻译。
- 不引入通用 i18n 框架；沿用 `cliLocale` / `isZhLocale`，TUI 文案使用纯函数映射，便于直接测试。

### C. Task 摘要 locale 一致性

- `summarizeTaskRun(result, locale?)` 支持 zh/en；未传 locale 时保持英文兼容。
- `moss task run/resume` 将当前 CLI locale 传入摘要，stdout 中 task/goal/phase/attempts/verdict/timeline 固定标签与 `task status` 口径一致。
- outcome token `PASS`、`FAIL`、`BLOCKED`、task id、命令、路径和 verdict 原文保持原样。
- 同一真实结果在 headless summary、`formatTaskStatus`、TUI task transcript 中的 outcome 和计数一致。

## 数据与接口边界

### Fleet 结果

新增内部共享类型，形状固定为：

```ts
interface FleetDeviceResult<T> {
  deviceId: string;
  endpoint: string;
  status: 'pass' | 'fail';
  result?: T;
  error?: string;
}

interface FleetResult<T> {
  selector: string[];
  outcome: 'all-pass' | 'partial' | 'all-fail';
  results: FleetDeviceResult<T>[];
}
```

selector 只接受已解析 registry 中的 device id；重复 id 去重并保留用户顺序；空集合是输入错误；未知 id 在执行前整体报错并列出缺失 id，不连接任何设备。单设备默认路径不得改为隐式全 registry fan-out。

### 取消、并发与失败

- fleet MVP 默认并发上限为 4，且不超过单连接已有 semaphore 能力；实现不得创建无限 Promise。
- `AbortSignal` 触发后停止尚未开始的设备，并让已开始的连接调用收到 signal；取消结果不能伪装成 pass。
- 设备级异常转换成该设备的 `error`，不得中断同批其他设备。
- 不做跨设备重试、健康摘除、rolling update、公平调度、跨进程队列或跨任务配额。

## 修改范围

预计修改：

- `src/device/device-target.ts`：增加显式 registry 多目标解析，保持默认解析兼容。
- `src/device/device-registry.ts`：复用现有连接边界，必要时提供批量解析辅助，不改变连接 identity 语义。
- `src/device/fleet-readonly.ts`（新增）：提供有限只读 fan-out 和聚合结果。
- `src/contracts/device.ts`（如类型需要）：补充 fleet result 类型。
- `src/cli/tui/app.ts`、`src/cli-main.ts`、`src/cli/tui/help.ts`、`src/cli/tui/transcript.ts`、`src/cli/tui/render-bridge.ts`：locale 显式传递与自有 chrome 文案。
- `src/core/task/task-engine.ts`、`src/cli/task-run.ts`：摘要 locale 参数和调用链。
- `test/device-fleet-readonly.spec.mjs`（新增）：选择、去重、未知 id、并发、部分失败、取消。
- `test/tui-locale.spec.mjs`（新增）：纯文案映射与中英文边界。
- `test/tui-command-surface.spec.mjs`、`test/tui-resize.spec.mjs`：locale-aware 稳定断言。
- `test/task-engine.spec.mjs`、`test/cli-task-run.spec.mjs`：摘要 locale 和 outcome 一致性。
- `docs/release-policy.md`、`package.json`：仅在所有证据完成后更新 v0.25 主张和版本。

## Non-goals

- 不做多设备写操作 fan-out，不绕过审批，不把一个用户确认扩展成多个远端副作用。
- 不做完整 fleet task engine、跨设备 acceptance 聚合、部署 rolling update 或真实设备集群管理。
- 不做设备自动发现、健康自动摘除、跨任务公平调度、leader election、跨进程 durable queue。
- 不翻译模型生成内容、工具原始输出、shell/git/MCP 输出、路径、命令、标识符和开发者日志。
- 不引入通用 i18n 依赖，不重写现有 SSH/连接层。
- 不主张真实多设备硬件闭环；in-process SSH 或受控 fixture 只能证明协议/调度行为。

## 验收门

1. 先红后绿：新增 fleet、TUI locale、summary locale 测试必须在实现前证明缺失行为。
2. `npm run check` 全绿。
3. `npm test` 全部 spec 全绿，包含现有 SDK contract。
4. `npm run smoke` 全绿，至少覆盖 TTY/REPL 回退不回归。
5. `npm run verify` 全绿。
6. `npm run examples` 三例实跑通过。
7. 真实 headless 取证：同一 task fixture 在 `LANG=en_US.UTF-8` 与 `LANG=zh_CN.UTF-8` 下 run/status/resume 输出；PASS/FAIL/BLOCKED 的 token、task id、计数一致，固定标签按 locale 变化。
8. 真实 PTY 取证：zh locale 下启动 TUI，执行 `/help`、`/task status`、未知命令和退出；记录可观察的中文 chrome，确认命令 token 与原始输入未翻译。
9. fleet 取证：使用两个 in-process SSH 设备和一个失败设备，观察到 all-pass、partial、all-fail 三态，确认每条结果带 deviceId，取消不会报告 PASS。
10. 发布前检查 `git status --short` 只包含本次变更；更新版本和 release-policy 后 commit、push main。只有证据齐全才考虑 `v0.25.0` tag。

## 不确定性与决策

- 当前 device tools 统一通过 default target，且写工具带 `device_mutation` 审批；因此 fleet MVP 采用独立只读 runner，而不是给全部工具增加 `device_ids` 参数，降低公共工具契约和审批风险。
- TUI 文案分布在 app/help/transcript/render-bridge，多数是纯投影函数；先抽取固定文案入口再批量替换，避免直接依赖英文字符串的测试继续伪装成行为契约。
- `summarizeTaskRun` 是 core 导出但当前默认英文；locale 参数设为可选，避免破坏 SDK 调用者。是否将其纳入最终 v0.25 版本号，以全量验证结果为准。
