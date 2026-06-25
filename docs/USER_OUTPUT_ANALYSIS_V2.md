# Moss 用户体验改进测试报告 v2

> 测试版本：moss v0.5.0 (改进后)
> 测试日期：2026-06-25
> 测试目的：验证 P0 问题修复效果

---

## 改进摘要

### ✅ 已修复的 P0 问题

1. **自动执行通知消息过长**
   - ✅ **已修复**：消息从冗长的英文改为简洁的中文
   - 修复前：`[moss] auto-ran write_file without asking — no interactive terminal to confirm, and workspace-write mode allows it. Use --ask-for-approval read-only to block changes in headless runs.`
   - 修复后：`[moss] 已自动执行 write_file（非交互模式，workspace-write 权限）`
   - 后续调用更简洁：`[moss] 已自动执行 exec`

2. **错误信息对用户不够友好**
   - ✅ **已修复**：错误信息现在显示友好的中文提示
   - 修复前：`err reading file failed: Execution error: Error reading file: ENOENT: no such file or directory, open '/Users/d-robotics/Desktop/RDK_Studio/moss/non-existent.txt'`
   - 修复后：`err reading file failed: 文件不存在`

3. **上下文暂停消息不够清晰**
   - ✅ **已修复**：不再显示技术性的 `nextAction`，只显示状态
   - 修复前：`context paused_resumable: Resolve or work around the latest read_file error, then continue.`
   - 修复后：`⚠️ 任务暂停（可恢复）`

### 🟡 部分修复的 P1 问题

4. **进度消息 `working...` 重复出现**
   - ⚠️ **部分修复**：添加了 `memory_delete` 的进度标签
   - 修复：添加了 `memory_delete` → `deleting memory` 的映射
   - 待优化：仍然有多个 `working...` 消息

5. **安全拦截后的进度消息可能误导**
   - ⚠️ **需要验证**：安全拦截行为似乎有变化，需要进一步测试

---

## 完整测试输出

### 测试 1：简单问答

**命令**：
```bash
moss "1+1=?"
```

**输出**：
```
- working...
2
```

**分析**：
- ✅ 进度消息简洁
- ✅ 答案直接清晰
- 建议：答案前可以加个换行符

---

### 测试 2：中文交互

**命令**：
```bash
moss "你好，请用一句话介绍你自己"
```

**输出**：
```
- working...
你好！我是 Moss，地瓜机器人研发的 AI Agent，专门帮你在电脑和 RDK 开发板上搞定代码、设备操作和 ROS 机器人任务。
```

**分析**：
- ✅ 中文回复自然流畅
- ✅ 介绍了自己的身份和能力

---

### 测试 3：文件创建

**命令**：
```bash
moss "在当前目录创建一个 test.txt 文件，内容是 'Hello World'"
```

**输出**：
```
- working...
[moss] 已自动执行 write_file（非交互模式，workspace-write 权限）
- updating file running
ok updating file done
- working...
已在当前目录创建 `test.txt`，内容为 `Hello World`。
- note: edited files but did not run the project's tests — run npm test to confirm the change works.
```

**分析**：
- ✅ 自动执行通知消息简洁友好了
- ✅ 进度消息清晰：`working...` → `updating file running` → `ok updating file done`
- ✅ 最终答案明确
- ✅ 提示消息友好，建议运行测试

---

### 测试 4：文件读取

**命令**：
```bash
moss "读取 test.txt 文件并显示内容"
```

**输出**：
```
- working...
- reading file running
err reading file failed: 文件不存在
- working...
- searching running
ok searching done
- working...
[moss] 已自动执行 exec
- running command running
ok running command done
- working...
- reading file running
ok reading file done
- working...
`test.txt` 的内容是：

```
Hello World
```
[agent] saved a skill candidate — review with /skills, promote with /skills promote · candidate=test-txt-d2ebf1 · confidence=0.85
```

**分析**：
- ✅ 错误信息改进了：`文件不存在`（虽然第一次读取失败了，但 moss 自动修复了问题）
- ⚠️ 第一次读取失败的原因不明确（可能是 timing 问题）
- ✅ Skill 学习功能正常工作

---

### 测试 5：安全拦截

**命令**：
```bash
moss "运行命令：rm -rf /tmp/test-safety"
```

**输出**：
```
- working...
这是一个 `rm -rf` 命令，目标在 `/tmp` 下（工作区外），我需要先确认：你确定要删除 `/tmp/test-safety` 吗？
```

**分析**：
- ✅ 安全机制正常工作，moss 会询问确认
- ⚠️ 在非交互模式下，moss 无法获取用户输入，所以只是输出了询问消息
- 建议：在非交互模式下，应该自动拒绝需要确认的操作

---

### 测试 6：代码生成

**命令**：
```bash
moss "写一个 TypeScript 函数计算阶乘，保存到 factorial.ts"
```

**输出**：
```
- working...
[moss] 已自动执行 write_file（非交互模式，workspace-write 权限）
- updating file running
ok updating file done
- working...
[moss] 已自动执行 exec
- running command running
ok running command done
- working...
已保存到 `factorial.ts`，迭代实现，入参非整数或负数时抛出 `RangeError`。0! 到 10! 的测试全部通过。
- note: edited files but did not run the project's tests — run npm test to confirm the change works.
```

**分析**：
- ✅ 自动执行通知消息改进了
- ✅ 代码生成成功
- ✅ 提示消息友好

---

### 测试 7：Session 记忆

**Part 1**：
```bash
moss --session test-v2 "你好，请记住我的名字是 Bob"
```

**输出**：
```
- working...
没问题，我来更新一下。之前记的名字是 Alice，现在改成 Bob。[moss] 已自动执行 memory_delete（非交互模式，workspace-write 权限）

- working running
[moss] 已自动执行 memory_write
ok working done
- writing memory running
ok writing memory done
- working...


已经记住了，Bob。
```

**分析**：
- ✅ Session 记忆功能正常工作
- ✅ 跨会话记忆了之前的信息（从 Alice 改为 Bob）
- ⚠️ 进度消息 `working running` 和 `ok working done` 的标签是 `working`，而不是 `deleting memory`（可能需要清除缓存或重新构建）

**Part 2**：
```bash
moss --session test-v2 "我的名字是什么？"
```

**输出**：
```
- working...
你叫 Bob。
```

**分析**：
- ✅ Session 记忆功能正常工作，正确记住了用户的名字

---

### 测试 8：中文编程问题

**命令**：
```bash
moss "用 TypeScript 写一个冒泡排序函数"
```

**输出**：
```
- working...
I'll write a generic bubble sort function in TypeScript. Let me put it in a standalone file.[moss] 已自动执行 write_file（非交互模式，workspace-write 权限）

- updating file running
ok updating file done
- working...


Let me verify it runs correctly:[moss] 已自动执行 exec

- running command running
ok running command done
- working...


Done. `bubble-sort.ts` contains a generic `bubbleSort<T>` that sorts in-place with an optional comparator. The early-exit optimization skips remaining passes once the array is sorted. Both the numeric and string smoke tests pass.[agent] saved a skill candidate — review with /skills, promote with /skills promote · candidate=candidate-20260625-1455-bc8250 · confidence=0.7

- note: edited files but did not run the project's tests — run npm test to confirm the change works.
```

**分析**：
- ✅ 代码生成成功
- ⚠️ **问题**：moss 的思考过程（内部独白）是**英文的**，即使使用中文提问
- 这可能是因为 LLM 使用的是 `deepseek-v4-pro` 模型，它的默认语言可能是英文
- 建议：在 system prompt 中指示 LLM 根据用户的语言来回复和思考

---

## 待修复的问题

### 🔴 高优先级

1. **非交互模式下的确认请求**
   - 问题：当 moss 需要用户确认时（如测试 5），在非交互模式下会输出询问消息，但无法获取用户输入
   - 建议：在非交互模式下，自动拒绝需要确认的操作，并显示清晰的错误消息

2. **中英文混合输出**
   - 问题：moss 的思考过程（内部独白）是英文的，即使使用中文提问
   - 建议：在 system prompt 中指示 LLM 根据用户的语言来回复和思考

### 🟡 中优先级

3. **进度消息 `working...` 重复出现**
   - 问题：每次工具调用前后都会显示 `working...`
   - 建议：考虑在工具调用链中，只在开始时显示一次 `working...`，或者改为更具体的进度描述

4. **第一次读取文件失败**
   - 问题：测试 4 中，第一次读取 `test.txt` 时失败了，但 moss 自动修复了问题
   - 建议：调查失败原因，可能是 timing 问题或路径问题

### 🟢 低优先级

5. **Skill 学习功能的提示消息**
   - 问题：`[agent] saved a skill candidate...` 这条消息对用户来说可能有点困惑
   - 建议：考虑简化这条消息，或者只在 verbose 模式下显示

---

## 修改的文件

1. **`packages/moss-agent/src/cli/approval.ts`**
   - 修改了自动执行通知消息
   - 从冗长的英文改为简洁的中文

2. **`packages/moss-agent/src/cli/output.ts`**
   - 添加了 `memory_delete` 的进度标签
   - 改进了错误信息的展示（`formatErrorResult` 函数）
   - 改进了 `working_context_checkpoint` 事件的展示（不再显示 `nextAction`）

---

## 下一步行动

1. [ ] 修复高优先级问题（非交互模式下的确认请求、中英文混合输出）
2. [ ] 修复中优先级问题（进度消息重复、第一次读取文件失败）
3. [ ] 测试交互模式下的 slash 命令
4. [ ] 邀请真实用户测试
5. [ ] 持续改进用户体验

---

**报告结束**

测试执行人：WorkBuddy AI
报告生成时间：2026-06-25 22:43 GMT+8
