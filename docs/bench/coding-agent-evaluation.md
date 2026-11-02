# Coding agent 评测与体验方向

> 研究快照：2026-11-03。目的：确定 Moss 的下一轮工程优先级，不把模拟调度或单次测试当成产品排名。

## 目标与比较方法

Moss 的目标是让用户更快拿到**独立验证过、可继续修改的结果**，同时保持交互顺畅、任务可中断恢复、权限与证据可追溯。要判断是否追上或超过 Claude Code / Codex，需要两条分开的比较轨道：

1. **Harness 轨道：**同一模型及可核对的版本、相同任务和验收、尽可能对齐工具、权限、环境、预算与采样设置，比较 harness 自身的影响。提示和协议无法完全一致时要如实记录。
2. **产品体验轨道：**使用各产品支持的默认或推荐模型、设置和权限，比较实际用户从提交任务到验收完成的体验；订阅配额与按 API 估算的成本分开报告。

记录 CLI / 模型版本、操作系统、硬件、终端与尺寸、网络和缓存状态、推理预算、权限 / 沙箱、并发、工具及任务数据版本。Moss 的 `workspace-write` 不是 shell 的操作系统沙箱；比较审批次数时必须同时说明这一差异。每个任务保留失败、超时、跳过与基础设施异常的分母；独立验收通过率、人工复核及代码可合并性分开报告。配对重复实验并提供样本量和不确定区间，样本不足时不宣称 p95 或胜负具有统计意义。

## 应当记录的时间与结果

- `submit → acknowledged`：用户提交到屏幕出现可靠的接收状态。
- `submit → first meaningful content`、`submit → first tool`、`model request → first byte`：分别衡量可用反馈和模型响应，不能把 spinner 当作实质内容。
- 按键 → 屏幕回显，区分空闲、流式输出、工具运行、窄屏与中英文输入。
- steer 提交 → 可见排队 → 实际生效；取消 → 工具和副作用停止；审批弹窗 → 用户决定 → 继续运行。人工等待与机器耗时分开。
- 请求 → 独立验收结果；记录成功率、失败原因、复测次数、子代理冲突、后台进程和恢复结果。
- 压缩耗时、压缩前后任务目标 / 约束 / 权限 / 失败及待办的保留情况、额外 token；成本分别统计缓存读写、未缓存输入、输出、子代理、重试及失败。

本轮在 macOS、Node 22 与本地 stub 下运行 `python3 scripts/tui-feel/assert-layout.py`，观察到 **82/82** 项通过，覆盖 fullscreen / inline、四种尺寸、流式输出、滚动、审批与运行中 steer。它不是延迟基准，也不能证明超过其他产品。

## DeepSeek Super-agent 的参考价值

[DeepSeek Harness 团队的研究原型](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/README.md)于 2026-10-31 公开。官方说明它仅供研究参考、不是正式产品，公开实现也不等于内部版本或文章中的全部设计。可核对的设计包括：隔离 worker session、任务授权与订阅、持久队列 / 恢复、限制并发，以及优先展示需要人处理的工作。默认 `observe` 不自动执行从事件推断出的主动请求；明确允许的用户请求仍可执行。参见 [领域模型](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/docs/001-domain.md)、[授权](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/docs/002-authorization.md)和[执行](https://github.com/deepseek-ai/dsh-superagent-prototype/blob/6337fc823ce20251c8de8085948165c81aaa701e/docs/003-execution.md)。

[文章的英文译本](https://offloop.org/learn/exploring-deepseek-super-agent-design)描述约 300 条合成消息、约 20 个工作请求，每种方案运行 5 次；编码工作由耗时工具模拟，消息间隔和模拟工作时间缩为原来的四分之一。图中 Super-agent 的请求到结果消息时间 p50 / p95 为 12.4 / 15.7 分钟，中性提示单会话对照为 20.4 / 29.5 分钟；分别报告约 2,323 万与 605 万 token。完整 token 构成、价格、实验轨迹与独立复现材料未获核实，不能将它们折算成美元成本，或当作真实编码速度、正确率和可复现收益的证明。微信原文在本环境触发验证，上述文章数据来自译本及其图表。

对 Moss 的近期借鉴是：先测长工具执行时的 steer 排队和生效延迟；在任务视图突出待人处理、运行中与已验收；只对适合拆分的任务使用现有隔离 worktree 与子代理，最终回到同一验收流程。不要直接照搬 5 秒自动后台化阈值：它可能改变有副作用命令的完成语义。DSH 文档说明其 worker 目录与命令 shim 不是安全隔离，应保留 Moss 已有宿主侧权限约束。

## 当前评测缺口与推进顺序

- **P0：评测可信度。** 默认 `scripts/tui-feel/driver.py` 的历史版本只观察启动画面，没有执行 JSON 场景步骤或测回显延迟；缺 pyte 时默认 runner 会 skip 并退出 0。`assert-layout.py` 是独立且更完整的屏幕断言，二者不可混为一谈。先使场景、失败、skip 和耗时可观察。
- **P0：基准计分。** `scripts/bench-tbench.mjs` 曾被只读检查发现任务对象处理、通过管道获取退出码以及多样本口径的潜在问题；修复并以故意失败的 oracle 验证前，不发布比较分数。仓库的旧版 40 题锁定子集不是官方 Terminal-Bench 2.0 的 89 题榜单。DeepSWE 默认 1 样本 / 80 turns 也不能直接对照供应商的 8 样本 / 500 steps。
- **P1：交互与连续性。** 在本地 stub 和 PTY 下增加输入、粘贴、中文光标、长流、工具等待、审批、steer、Esc 和后台操作的可重复测量；再验证多次压缩、失败修复及中断重启时任务和权限是否保留。
- **P2：任务身份。** 在放开超过 50 个历史任务的内部恢复限制前，贯通当前任务 ID 到 agent turn、自动测试证据、隐式验收及相关子代理路径；不能让任务 A 的结果归到 B。
- **P3：真实任务比较。** 用官方评测器和私有真实任务集进行同模型配对重复，再分别评估默认产品体验；报告成本、独立验收和人工复核。

## 参考资料与限制

- [Claude Code 交互](https://code.claude.com/docs/en/interactive-mode)、[上下文](https://code.claude.com/docs/en/context-window)、[会话恢复](https://code.claude.com/docs/en/sessions)：官方功能说明，不能替代本机性能实测。
- [METR 同模型 scaffold 比较](https://metr.org/notes/2026-02-13-measuring-time-horizon-using-claude-code-and-codex/)：该研究中所比较 scaffold 的差异未达统计显著，结论受任务、预算和适配条件限制。
- [METR 维护者审阅研究](https://metr.org/notes/2026-03-10-many-swe-bench-passing-prs-would-not-be-merged-into-main/)：自动评分与维护者接受判断存在差距；研究中 agent 没有根据维护者反馈再次迭代。
- [METR time-horizon 限制](https://metr.org/notes/2026-01-22-time-horizon-limitations/)：time horizon 指给定成功率下可替代的人类串行劳动时间，不是 agent 实际连续运行时长。
- Codex 官方页面在本环境直接访问返回 403；相关功能描述只能暂用官方搜索索引，后续比较前需重新核对或实测。
