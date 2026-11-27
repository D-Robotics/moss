# 单回合容量恢复交接（2026-11-27）

修复基于远端 main `4f863819183a2f24bbe5036c9f62919215d6b57d`，分支 `codex/single-turn-context-recovery`。
该 main 已包含 `c8f04bda` 的 tool_choice 修复，并额外包含主动工具回执 S2 收缩与每次成功生成后的恢复计数重置，不回退这些修改。

## 行为和 API

- `shouldAppendShellContinueHint(result, status?)` / `appendShellContinueHint(toolName, result, status?)` 新增可选 `{ outcome?: ToolResultOutcome; exitCode?: number | null }`。非 error outcome 优先，不把 denied/blocked/suppressed/replayed/ok 改成恢复提示；exitCode 优先于文本。旧调用兼容，仅识别末尾退出码，不再扫描 stdout/stderr 的错误词。提示只报告非零退出，不强制继续。宿主应传真实结构化结果；文本 footer 是兼容入口，不能提供防伪保证。
- VersionedContextPipeline 在 force 或 S2 不足的压力下，可以摘要当前用户回合中已闭合的旧模型/工具轮次。最新 assistant/tool 交换连同 thinking 保留；不单独剥除签名或 reasoning 字段。原始用户输入、runtime 状态和修订语义保留，旧轮次整体替换为带来源的非授权摘要。
- checkpoint 可向前推进；闭合边界不切断 pending tool。压缩只修改模型投影，不改原始事件，不重放工具。现有 correction/hash/revision/session-key 检查继续生效。
- 不新增错误码。固定预算无法容纳仍为 `PROVIDER_CONTEXT_OVERFLOW`；模型明确拒绝由原有 agent-loop 每次生成最多一次恢复。连续拒绝失败，不伪造 final。摘要服务异常沿用来源摘录回退。
- 没有加入网关字节计量、固定窗口或新的网络重试循环。普通短路径不新增摘要。

## 可复验

```sh
npm run build
node scripts/verify/single-turn-recovery.mjs
node scripts/verify/cli.mjs --stage versioned-context,reasoning-follow-up
npm run typecheck
npm run verify
```

新增探测只用合成数据。修复前分别观察到可选目录触发提示、单轮 force 不产生 S5 的失败断言。探测包含真实 HTTP transport/serializer + MossAgent：三个已完成工具后首次拒绝，摘要后请求变小并输出 final；再次拒绝明确失败，业务请求共五次，工具执行三次。摘要请求单独处理，不算业务请求。

现有 versioned-context 探测覆盖修订、checkpoint 重建、source 校验、审批迟到、claim 失效、未知副作用和会话隔离。thinking 保留策略沿用 provider reasoning-policy；reasoning-follow-up 是本地模拟协议检查，不是生产模型证明。

## Studio 接入和限制

代码提交并推送后使用 `npm run moss:update -- --ref <完整 SHA>`，不复制私有 runtime，不重写宿主重试循环。SDK 已验证，Studio 集成待验。

未执行真实 MiniMax/Anthropic 生产联调、桌面四文件项目行为 A/B 或网关历史拒绝取证。HTTP 夹具证明容量恢复机制和终止，不证明去掉提示就足以让真实模型收敛。待 Studio 使用隔离项目验证损坏文本的有限总结、无宿主历史取证、无记忆写入及错误卡显示。未修改原始项目、会话数据库或 external/moss；未部署。

## 本机验证结果

- build、typecheck、check 通过（退出 0）。
- single-turn-recovery、versioned-context、reasoning-follow-up 通过（退出 0）。
- 完整 verify 未全绿：最后完整运行 56.8s，startup-timing 的无代理启动/已配置 provider 启动两项断言发现 undici 提前加载。隔离的未修改 main `4f863819` 重新 build 后执行 `node scripts/verify/startup-timing.mjs` 同样 2/6 失败。此基线问题未扩展修复。
- 初次完整验证 capabilities/task-fail-reasons 失败，单独复验分别 15/15、9 项通过；后续完整运行这两项通过。一次验证与构建误并发导致 dist 缺失，该结果作废，已串行重跑。

## 补充：容量错误身份保留

Studio 隔离桌面反馈：容量失败被本地化后失去可分类 code。补充修复将容量错误规范为 `PROVIDER_CONTEXT_OVERFLOW`，`classifyProviderError` 可直接识别该 code；恢复判断也可识别经过重试包装的类型化错误，不依赖展示文案。

`MossErrorDetails` / `MossError` / `MossErrorOutcome` 增加可选 `source`（仅 gateway/upstream/provider/runtime）和 `providerCode`（最多96字符的字母数字下划线标识）。HTTP JSON error、注入 streamFn 抛错和容量 error event 的安全身份经 provider 包装和 JSON outcome 重建保留。原始 code 放 providerCode，Moss code 仍是 SDK 枚举。cause/context/stack/任意响应内容不进入 outcome。安全 source 仅作错误来源诊断，不授予权限。

`scripts/verify/provider-error-identity.mjs` 在未修改 main 产物上红于容量 code；修复后验证 complete/stream、JSON outcome 重建和错误事件。single-turn-recovery 的持续拒绝路径同时断言最终抛出的 code/source/providerCode。此补充仍不声称 Studio 已 bump 或桌面联调通过。
