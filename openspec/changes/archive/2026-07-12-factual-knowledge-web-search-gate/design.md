## Context

Moss Agent 循环 (`core/loop/`) 的 pre-llm 阶段 (`agent-loop-context-prep.ts`) 负责准备上下文（system prompt、skill 注入、compaction 等）后交给 LLM。但目前没有"根据问题类型动态调整上下文"的机制——所有问题一视同仁。

用户的时效性事实问题（"S600的rdk_model_zoo是哪个分支"）交给 LLM 后，LLM 可能从内置 Skill 或训练数据中直接提取答案，不触发联网搜索。事后在 post-llm 阶段拦截有 confirmation bias 风险（LLM 会倾向于证明自己第一次是对的）。

**本方案在 pre-llm 阶段介入：把搜索结果提前注入上下文，让 LLM 在"看到"问题之前就已经有了最新数据。**

## Goals / Non-Goals

**Goals:**
- 在 pre-llm 阶段，对用户问题做预检分类
- 涉及时效性事实时，自动调用 `knowledge_search`，将结果注入上下文
- LLM 回答前就已拿到最新数据，无需事后纠正
- 用户无感知——不需要额外的交互或警告

**Non-Goals:**
- 不做答案正确性验证（那是 LLM 的事）
- 不修改 SteerEngine 或 Compaction 逻辑
- 不引入额外的 LLM 调用做分类（分类器是纯规则匹配）
- 不影响非事实性问题的响应速度

## Decisions

### Decision 1: 在 pre-llm 阶段做路由，不在 post-llm 拦截

**选择**: 在 CLI 层（`tui.ts` / `oneshot.ts`）构建上下文时、调用 LLM 之前，通过 `tui-utils.ts` 的 `buildPreSearchContext` 插入 `PreFlightRouter`。

**实现范围调整**: 原方案计划在 agent 循环的 `agent-loop-context-prep.ts` 内集成。实际实现把集成点放在 **CLI 层**——CLI 层已持有构建好的 `SkillRegistry` 与 `sessionKey`，且不侵入 agent 循环内核，改动面更小。`buildPreSearchContext` 在 `buildMatchedSkillContext` 之后调用，结果 append 到 `extraContext`。

**理由**:
- 事前预防 > 事后纠正：LLM 在回答前就已拿到最新数据
- 无 confirmation bias：LLM 没有被自己"第一次回答"束缚
- 不增加 round-trip：搜索结果作为上下文注入，不产生额外的 LLM 调用
- CLI 层集成不侵入 agent 循环，改动局部、易回退

**替代方案**: post-llm Gate 拦截 → LLM 已经说出了可能错误的答案，有 bias 且多一轮 LLM 调用；或在 `agent-loop-context-prep.ts` 内集成 → 改动更深，对本次需求收益不大。

### Decision 2: 单路触发机制（实现简化版）

**选择**: 仅实现 Skill 标记触发单路条件：

- **Skill 标记触发**（已实现，唯一路径）：
  - 问题命中某个 Skill → 检查该 Skill 的 `timeSensitive` 字段
  - `timeSensitive: true` → 触发预搜索（用 Skill 的 `searchQueryTemplate` 或回退到用户问题）

**未实现（相对原方案的简化）**: 原方案设计了第 2 条"关键词模式兜底"路径（未命中 Skill 但问题匹配事实性模式时触发）。实际未实现 `FactualQuestionClassifier`。理由：Skill 标记路径已覆盖已知的时效领域（rdk-model-zoo / rdk-source-map），关键词兜底需基于真实误判数据调参，留待后续按需补充。

**理由**:
- Skill 标记路径覆盖已知领域，精准可控
- 单路实现降低误触发风险，规则简单
- 纯规则匹配，零延迟，零 token 消耗

### Decision 3: 搜索结果为追加的上下文消息，不修改 system prompt

**选择**: 搜索结果作为一条 `user` 角色消息追加到 messages 列表中，位置在用户问题之前。

```
[system prompt]
[user: 搜索结果: "knowledge_search: rdk_model_zoo S600 分支\n\n1. ..."]
[user: "S600的rdk_model_zoo是哪个分支"]
```

**理由**:
- 不修改 system prompt，避免 hash/Prompt Cache 失效
- LLM 会把搜索结果当作"已知信息"来处理，自然融入回答
- 如果搜索结果为空或无帮助，LLM 仍可自行判断是否需要再搜

### Decision 4: 搜索关键词生成与后端工具

**选择**:
- 如果命中 `timeSensitive` Skill，优先使用 Skill 中定义的 `searchQueryTemplate`（如 `"rdk_model_zoo github {{query}} branch"`，`{{query}}` 替换为用户消息）
- 如果没有模板，直接将用户消息作为搜索 query
- 后端调用 `web_search` + `web_fetch`（底层原子工具）而非 `knowledge_search`：`runPreSearch` 先 `web_search` 取结果，正则提取 URL，再并发 `web_fetch` top 结果，截断聚合

**理由**:
- Skill 作者最清楚怎么搜最有效
- 用户问题作为 fallback，确保总能搜到
- 直接用底层 `web_search`/`web_fetch` 比 `knowledge_search` 工具更可控（可调 max_results / 超时 / 截断长度），且 `knowledge_search` 工具仍保留供 LLM 主动调用

## Risks / Trade-offs

- **[延迟] 预搜索增加响应时间** → `knowledge_search` 通常 2-5 秒完成，只在命中时触发；对非事实性问题无影响
- **[误触发] 关键词兜底可能对不需要搜索的问题触发** → 使用保守的关键词列表，宁可漏判不可误判；后续可基于数据优化
- **[上下文膨胀] 搜索结果可能很长** → 限制搜索结果总长度为 6000 字符，避免挤占有效上下文
- **[嵌套问题] 用户可能在一次对话中问多个事实性问题** → 每次 user turn 都重新评估，确保每轮都有最新数据