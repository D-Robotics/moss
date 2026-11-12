# SDK tool suspension and continuation

宿主工具声明 `metadata.canSuspend: true` 后，可调用
`suspendToolCall({ continuationId, payload })` 释放执行回合。`chat()` 返回
`stopReason: 'suspended'` 和 `suspendedTool`，工具调用保留在原会话中，尚不生成结果。
宿主负责持久化等待条件、账号授权、执行租约和唤醒调度；消息到达时调用
`agent.resumePendingTool(sessionKey, { continuationId, toolCallId, result })`，在原调用位置
追加一次工具结果并继续，无需伪造新用户消息。`getPendingTool(sessionKey)` 可在新进程读取待续状态。

此能力要求支持 `appendMessageOnce` 的会话存储；JSONL 存储可持久恢复。挂起工具串行执行，
同批后续调用明确标记未执行，已完成工具不会重放。宿主应按单成员租约防止跨进程重复执行；
暂停、取消或权限变化时不得自动唤醒。挂起期间不能直接开始新用户回合或压缩历史。

调用关联不匹配会被拒绝。若工具结果已落盘但下一回合尚未开始，重试恢复会复用该结果；
若会话已经继续推进，重复恢复会拒绝，宿主应重新加载当前状态而非重复调度。

## English

A host tool declaring `metadata.canSuspend: true` may call
`suspendToolCall({ continuationId, payload })` to yield the execution turn. `chat()` returns
`stopReason: 'suspended'` and `suspendedTool`; the original session retains the unresolved call.
The host persists the wait condition, authorization, execution lease and wakeup schedule. When ready,
`agent.resumePendingTool(sessionKey, { continuationId, toolCallId, result })` appends the original
tool result once and continues without adding a new user instruction. `getPendingTool(sessionKey)`
also works after recreating the agent.

The session store must support `appendMessageOnce`; the JSONL store provides durable recovery.
Suspendable tools run serially; later calls in that batch are explicitly marked unexecuted and
completed tools are not replayed. Hosts enforce a single execution lease across processes and must
not wake paused, cancelled or unauthorized work. New user turns and compaction are rejected while
a tool is suspended.

Mismatched continuations are rejected. A retry after the result was persisted but before the next
assistant turn reuses the persisted result; a continuation that already advanced is rejected.
The host reloads the session instead of scheduling the same work twice.

## Executable example

Run `node examples/tool-continuation.mjs` after building. It verifies suspension, restart,
mismatched-continuation rejection, compaction protection, and absence of completed-tool replay.
